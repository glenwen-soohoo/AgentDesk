(function (root) {
  const defaultCapacity = 4;

  function isDirectOffice(office) {
    return office && (office.officeType === "direct" || office.type === "direct" || office.typeLabel === "direct office" || office.typeLabel === "overflow office");
  }

  function isManagedOffice(office) {
    return office && (office.officeType === "managed" || office.type === "managed" || office.typeLabel === "managed office");
  }

  function officeCapacity(office) {
    return Number.isInteger(office && office.capacity) ? office.capacity : defaultCapacity;
  }

  function officeNumber(office) {
    const match = String(office && office.id || "").match(/(\d+)$/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  function normalizeGroupKey(value) {
    return String(value || "")
      .trim()
      .toLocaleLowerCase()
      .replace(/\s*(?:[-_－—]\s*|的\s*)克雷利文\s*$/i, "")
      .replace(/\s+([a-z]|\d+)\s*$/i, "")
      .replace(/\s*[-_－—]\s*(文件|ui|ux|api|後端|前端)\s*$/i, "")
      .trim();
  }

  function groupKeyOf(agent) {
    return normalizeGroupKey(agent && (agent.groupKey || agent.name || agent.sessionName));
  }

  function resolveManagedOffices(agentProfiles, offices) {
    const managedBySteward = new Map();
    const managedByGroup = new Map();
    const profilesById = new Map((Array.isArray(agentProfiles) ? agentProfiles : []).map((agent) => [agent.id, agent]));
    const managedOffices = (Array.isArray(offices) ? offices : []).filter(isManagedOffice).sort((a, b) => officeNumber(a) - officeNumber(b));
    const claimedOfficeIds = new Set();
    managedOffices.forEach((office) => {
      if (office.stewardAgentId) {
        managedBySteward.set(office.stewardAgentId, office.id);
        claimedOfficeIds.add(office.id);
      }
    });

    const stewards = (Array.isArray(agentProfiles) ? agentProfiles : []).filter((agent) => agent.kind === "steward");
    stewards.forEach((steward) => {
      if (!managedBySteward.has(steward.id)) {
        const preferred = managedOffices.find((office) => office.id === steward.officeId && !claimedOfficeIds.has(office.id));
        const available = preferred || managedOffices.find((office) => !claimedOfficeIds.has(office.id));
        const office = available || managedOffices.find((candidate) => candidate.id === steward.officeId) || managedOffices[0];
        if (office) {
          managedBySteward.set(steward.id, office.id);
          claimedOfficeIds.add(office.id);
        }
      }
      const groupKey = groupKeyOf(steward);
      const officeId = managedBySteward.get(steward.id);
      if (groupKey && officeId && !managedByGroup.has(groupKey)) managedByGroup.set(groupKey, officeId);
    });
    return { managedBySteward, managedByGroup, profilesById };
  }

  function route(agentProfiles, sessions, offices) {
    const profiles = Array.isArray(agentProfiles) ? agentProfiles : [];
    const normalizedSessions = Array.isArray(sessions) ? sessions : [];
    const officeList = Array.isArray(offices) ? offices : [];
    const directOffices = officeList.filter(isDirectOffice).sort((a, b) => officeNumber(a) - officeNumber(b));
    const { managedBySteward, managedByGroup, profilesById } = resolveManagedOffices(profiles, officeList);
    const sessionByAgent = new Map(normalizedSessions.map((session) => [session.agentId, session]));
    const assignments = new Map(profiles.map((agent) => [agent.id, agent.officeId]));
    const directOccupancy = new Map(directOffices.map((office) => [office.id, 0]));
    const routes = [];
    const unplaced = [];

    profiles.forEach((agent) => {
      const managedOfficeId = managedBySteward.get(agent.id);
      if (managedOfficeId) assignments.set(agent.id, managedOfficeId);
    });

    profiles.forEach((agent) => {
      if (sessionByAgent.has(agent.id)) return;
      if (directOccupancy.has(agent.officeId)) directOccupancy.set(agent.officeId, directOccupancy.get(agent.officeId) + 1);
    });

    normalizedSessions.forEach((session) => {
      const agent = profilesById.get(session.agentId);
      if (!agent) {
        unplaced.push({ session, reason: "agent_profile_missing" });
        return;
      }

      if (!session.reportTo && agent.kind === "steward" && officeList.some((office) => office.id === agent.officeId)) {
        const managedOfficeId = managedBySteward.get(agent.id) || agent.officeId;
        assignments.set(agent.id, managedOfficeId);
        routes.push({ agentId: agent.id, officeId: managedOfficeId, reason: "steward_self" });
        return;
      }

      if (session.reportTo) {
        const managedOfficeId = managedBySteward.get(session.reportTo) || profilesById.get(session.reportTo)?.officeId;
        if (managedOfficeId) {
          assignments.set(agent.id, managedOfficeId);
          routes.push({ agentId: agent.id, officeId: managedOfficeId, reason: "report_to_steward" });
          return;
        }
        unplaced.push({ session, reason: "steward_office_missing" });
        return;
      }

      const inferredManagedOfficeId = managedByGroup.get(groupKeyOf(agent));
      if (inferredManagedOfficeId) {
        assignments.set(agent.id, inferredManagedOfficeId);
        routes.push({ agentId: agent.id, officeId: inferredManagedOfficeId, reason: "inferred_group" });
        return;
      }

      const directOffice = directOffices.find((office) => directOccupancy.get(office.id) < officeCapacity(office));
      if (!directOffice) {
        unplaced.push({ session, reason: "direct_offices_full" });
        return;
      }
      directOccupancy.set(directOffice.id, directOccupancy.get(directOffice.id) + 1);
      assignments.set(agent.id, directOffice.id);
      routes.push({ agentId: agent.id, officeId: directOffice.id, reason: "direct_report" });
    });

    return {
      agents: profiles.map((agent) => ({ ...agent, officeId: assignments.get(agent.id) || agent.officeId, groupKey: agent.groupKey || groupKeyOf(agent) })),
      routes,
      unplaced,
      directOccupancy: Object.fromEntries(directOccupancy)
    };
  }

  root.AgentDeskOfficeRouter = { route, isDirectOffice, isManagedOffice, normalizeGroupKey };
  if (typeof module !== "undefined" && module.exports) module.exports = root.AgentDeskOfficeRouter;
})(typeof window === "undefined" ? globalThis : window);
