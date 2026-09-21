(function (root) {
  const claudeStateMap = {
    system: "working",
    assistant: "working",
    tool_use: "working",
    tool_result: "working",
    user: "working",
    permission_request: "permission_required",
    permission_required: "permission_required",
    error: "error",
    result: "done"
  };

  const codexStateMap = {
    "agent.session.created": "working",
    "agent.session.in_progress": "working",
    "agent.session.turn.in_progress": "working",
    "agent.session.requires_action": "waiting_user",
    "agent.session.turn.completed": "done",
    "agent.session.turn.cancelled": "done",
    "agent.session.turn.failed": "error",
    "agent.session.failed": "error",
    "agent.session.idle": "idle"
  };

  const codexAppServerStateMap = {
    "thread/started": "working",
    "thread/closed": "done",
    "turn/started": "working",
    "turn/completed": "done",
    "item/started": "working",
    "item/completed": "working",
    "item/commandExecution/requestApproval": "permission_required",
    "item/fileChange/requestApproval": "permission_required",
    "item/permissions/requestApproval": "permission_required",
    "mcpServer/elicitation/request": "waiting_user",
    error: "error"
  };

  function firstValue(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function asIso(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
      const numericValue = Number(value);
      const milliseconds = numericValue < 100000000000 ? numericValue * 1000 : numericValue;
      return new Date(milliseconds).toISOString();
    }
    const timestamp = Date.parse(String(value));
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
  }

  function textFrom(value) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value.map(textFrom).filter(Boolean).join(" ");
    }
    if (!value || typeof value !== "object") return "";
    return firstValue(value.text, value.content, value.result, value.message) ? textFrom(firstValue(value.text, value.content, value.result, value.message)) : "";
  }

  function baseEvent(provider, raw, identity, state, summary) {
    const session = raw.session || {};
    const turn = raw.turn || {};
    const agent = raw.agent || session.agent || {};
    return {
      sessionId: firstValue(raw.session_id, raw.sessionId, session.id, raw.id),
      source: provider,
      agentId: firstValue(identity.agentId, raw.agent_id, raw.agentId, agent.id),
      reportTo: firstValue(identity.reportTo, raw.report_to, raw.reportTo) ?? null,
      state,
      startedAt: asIso(firstValue(raw.started_at, raw.startedAt, raw.created_at, raw.createdAt, turn.started_at, turn.startedAt, session.created_at, session.createdAt)),
      updatedAt: asIso(firstValue(raw.updated_at, raw.updatedAt, raw.created_at, raw.createdAt, session.updated_at, session.updatedAt)) || new Date().toISOString(),
      summary: summary || "沒有最新回報"
    };
  }

  function fromClaudeEvent(raw, identity = {}) {
    const type = firstValue(raw.type, raw.event_type, raw.eventType, "");
    const subtype = firstValue(raw.subtype, raw.status, "");
    let state = claudeStateMap[type] || claudeStateMap[subtype] || "working";
    if (type === "result" && (raw.is_error || subtype === "error")) state = "error";
    const summary = textFrom(firstValue(raw.result, raw.message, raw.content, raw.error, raw.tool_name));
    return baseEvent("claude-code", raw, identity, state, summary);
  }

  function fromCodexAppServerEvent(raw, identity = {}) {
    const method = firstValue(raw.method, raw.event_type, raw.eventType, "");
    const params = raw.params || {};
    const threadStatus = params.status || {};
    const activeFlags = Array.isArray(threadStatus.activeFlags) ? threadStatus.activeFlags : [];
    let state = codexAppServerStateMap[method] || "working";
    if (method === "thread/status/changed") {
      if (threadStatus.type === "systemError") state = "error";
      else if (activeFlags.includes("waitingOnApproval")) state = "permission_required";
      else if (activeFlags.includes("waitingOnUserInput")) state = "waiting_user";
      else if (threadStatus.type === "idle") state = "idle";
      else state = "working";
    }
    if (method === "turn/completed" && params.turn?.status === "failed") state = "error";
    const rawSummary = textFrom(firstValue(params.error, params.reason, params.item, params.turn?.error, params.thread?.preview, params.thread?.name));
    const summary = rawSummary || (state === "permission_required" ? "等待核准" : state === "waiting_user" ? "等待你的回覆" : "");
    const mappedEvent = {
      ...raw,
      session_id: firstValue(params.threadId, params.thread?.sessionId, params.thread?.id),
      startedAt: firstValue(params.startedAtMs, params.turn?.startedAt, params.thread?.createdAt),
      updatedAt: firstValue(params.completedAtMs, params.turn?.completedAt, params.thread?.updatedAt),
      message: summary
    };
    return baseEvent("codex-app-server", mappedEvent, identity, state, summary);
  }

  function fromCodexEvent(raw, identity = {}) {
    if (raw.method || raw.params) return fromCodexAppServerEvent(raw, identity);
    const type = firstValue(raw.type, raw.event_type, raw.eventType, "");
    const state = codexStateMap[type] || "working";
    const summary = textFrom(firstValue(raw.error, raw.message, raw.delta, raw.item, raw.turn));
    return baseEvent("codex", raw, identity, state, summary);
  }

  root.AgentDeskSourceAdapters = {
    claudeStateMap,
    codexStateMap,
    codexAppServerStateMap,
    fromClaudeEvent,
    fromCodexAppServerEvent,
    fromCodexEvent
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.AgentDeskSourceAdapters;
})(typeof window === "undefined" ? globalThis : window);
