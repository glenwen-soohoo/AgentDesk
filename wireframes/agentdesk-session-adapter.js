(function (root) {
  const stateMap = {
    working: "working",
    running: "working",
    asking: "asking",
    waiting_user: "waiting",
    waiting_input: "waiting",
    blocked: "blocked",
    permission_required: "blocked",
    error: "blocked",
    done: "done",
    completed: "done",
    idle: "idle"
  };

  const priorityMap = {
    blocked: 100,
    asking: 90,
    waiting: 80,
    done: 60,
    working: 40,
    idle: 10
  };

  function parseTime(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value < 100000000000 ? value * 1000 : value;
    if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
      const numericValue = Number(value);
      return numericValue < 100000000000 ? numericValue * 1000 : numericValue;
    }
    const time = Date.parse(value || "");
    return Number.isNaN(time) ? null : time;
  }

  function formatDuration(startedAt, now) {
    const started = parseTime(startedAt);
    if (!started) return "--";
    const elapsedMinutes = Math.max(0, Math.floor((now - started) / 60000));
    if (elapsedMinutes < 1) return "<1m";
    if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
    const hours = Math.floor(elapsedMinutes / 60);
    const minutes = elapsedMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  function normalize(event, now = Date.now()) {
    const status = stateMap[event.state] || "idle";
    return {
      sessionId: event.sessionId,
      source: event.source || "unknown",
      agentId: event.agentId,
      reportTo: event.reportTo ?? null,
      status,
      priority: priorityMap[status],
      duration: formatDuration(event.startedAt, now),
      message: event.summary || event.lastMessage || "沒有最新回報",
      updatedAt: event.updatedAt || null
    };
  }

  function normalizeAll(events, now = Date.now()) {
    return (Array.isArray(events) ? events : []).map((event) => normalize(event, now));
  }

  function mergeAgentStates(agentProfiles, events, now = Date.now()) {
    const sessions = normalizeAll(events, now);
    const sessionsByAgent = new Map(sessions.map((session) => [session.agentId, session]));
    const agents = (Array.isArray(agentProfiles) ? agentProfiles : []).map((agent) => {
      const session = sessionsByAgent.get(agent.id);
      if (!session) return agent;
      return {
        ...agent,
        status: session.status,
        duration: session.duration,
        message: session.message,
        sessionId: session.sessionId,
        source: session.source,
        reportTo: session.reportTo,
        priority: session.priority,
        updatedAt: session.updatedAt
      };
    });
    return { agents, sessions };
  }

  root.AgentDeskSessionAdapter = { normalize, normalizeAll, mergeAgentStates, stateMap, priorityMap };
  if (typeof module !== "undefined" && module.exports) module.exports = root.AgentDeskSessionAdapter;
})(typeof window === "undefined" ? globalThis : window);
