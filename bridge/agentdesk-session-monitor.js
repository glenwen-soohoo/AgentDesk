const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { URL } = require("node:url");

const sessionAdapter = require("../wireframes/agentdesk-session-adapter.js");

const DEFAULTS = {
  pollMs: 1500,
  maxAgeMinutes: 240,
  activeOnly: true,
  activeFileMinutes: 15,
  // Keep a briefly-missing session for this many seconds before removing it, so a
  // single transient process-detection miss does not permanently drop a live session.
  removeGraceSeconds: 30,
  // Hide a parked session (waiting / idle / done) whose last activity is older than this
  // many minutes, even while its process is still alive, so long-abandoned windows do not
  // clutter the view. working / blocked are always shown. 0 disables the filter. The state
  // stays tracked internally and reappears as soon as it becomes active again.
  hideParkedMinutes: 30,
  maxReadBytes: 512 * 1024,
  port: 4317
};

const COLORS = [
  ["#6a4b3e", "#536b61"],
  ["#57413a", "#5d536a"],
  ["#805b45", "#4d6658"],
  ["#3f3836", "#576b80"],
  ["#70463b", "#6a5b4b"]
];

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asIso(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    const milliseconds = number < 100000000000 ? number * 1000 : number;
    return new Date(milliseconds).toISOString();
  }
  const timestamp = Date.parse(String(value));
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function timestampOf(record, fallback = null) {
  return asIso(firstValue(
    record && record.timestamp,
    record && record.updatedAt,
    record && record.updated_at,
    record && record.completed_at,
    record && record.completedAt,
    record && record.completed_at_ms,
    fallback
  ));
}

function textFrom(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  return textFrom(firstValue(value.text, value.value, value.content, value.message, value.result, value.last_agent_message));
}

function compact(text, fallback) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return fallback;
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function hash(value) {
  let result = 0;
  for (const character of String(value)) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return result;
}

function sourceLabel(source) {
  return source === "claude-code" ? "Claude" : "Codex";
}

function looksLikeStewardName(value) {
  return /clerivan|克雷利文|總管/i.test(String(value || ""));
}

function normalizeCwd(value) {
  return value ? path.normalize(String(value)).replace(/\//g, "\\").toLowerCase() : "";
}

function matchesRule(rule, context) {
  if (rule.source && rule.source !== context.source) return false;
  if (rule.sessionId && rule.sessionId !== context.sessionId) return false;
  if (rule.sessionIdPrefix && !context.sessionId.startsWith(rule.sessionIdPrefix)) return false;
  if (rule.cwd && normalizeCwd(rule.cwd) !== normalizeCwd(context.cwd)) return false;
  if (rule.cwdPrefix && !normalizeCwd(context.cwd).startsWith(normalizeCwd(rule.cwdPrefix))) return false;
  if (rule.filePrefix && !context.filePath.toLowerCase().startsWith(String(rule.filePrefix).toLowerCase())) return false;
  return true;
}

function resolveIdentity(registry, context) {
  const sourceDefaults = (registry.defaults && registry.defaults[context.source]) || {};
  const rule = (Array.isArray(registry.rules) ? registry.rules : []).find((candidate) => matchesRule(candidate, context)) || {};
  const merged = { ...sourceDefaults, ...rule };
  const fallbackId = `${context.source.replace(/[^a-z0-9]+/gi, "-")}-${context.sessionId.slice(0, 8)}`;
  const agentId = merged.agentId || fallbackId;
  const name = merged.agentName || merged.name || context.sessionName || `${merged.namePrefix || sourceLabel(context.source)} ${context.sessionId.slice(0, 8)}`;
  const explicitKind = Object.prototype.hasOwnProperty.call(rule, "kind")
    ? rule.kind
    : (sourceDefaults.kind === "steward" ? sourceDefaults.kind : null);
  const kind = explicitKind || (looksLikeStewardName(name) ? "steward" : "worker");
  const color = COLORS[hash(agentId) % COLORS.length];
  // Identity only: agentId / name / kind / officeId / reportTo / colours. Seat, bubble and
  // any x/y geometry are owned by the render layer (office router + assignSeats), so the
  // monitor deliberately does not emit positions.
  return {
    agentId,
    agentName: name,
    isNameExplicit: Boolean(merged.agentName || merged.name),
    isKindExplicit: Boolean(explicitKind),
    kind,
    reportTo: merged.reportTo ?? null,
    officeId: merged.officeId || (kind === "steward" ? "managed-01" : "direct-01"),
    hair: merged.hair || color[0],
    coat: merged.coat || color[1]
  };
}

// Tool calls whose whole purpose is to block on the user (they present a prompt and wait for
// an answer), so a session paused on one of these is "等你", not "工作中". Names are matched
// case-insensitively against the tool_use `name`.
const USER_BLOCKING_TOOLS = new Set(["askuserquestion", "exitplanmode"]);

function classifyClaude(record) {
  const type = String(firstValue(record.type, record.event_type, record.eventType, "")).toLowerCase();
  const subtype = String(firstValue(record.subtype, record.status, "")).toLowerCase();
  const message = record.message || {};
  const stopReason = String(firstValue(message.stop_reason, record.stop_reason, "")).toLowerCase();
  const timestamp = timestampOf(record);

  if (type === "result") {
    return {
      state: record.is_error || subtype === "error" ? "error" : "done",
      summary: compact(textFrom(firstValue(record.result, record.error, record.message)), record.is_error ? "Claude 回報錯誤" : "工作完成"),
      timestamp
    };
  }
  if (type === "system" && subtype === "stop_hook_summary") {
    return { state: "waiting_user", summary: "等待你的下一個指示", timestamp };
  }
  if (/permission|approval|request.?input/.test(type) || /permission|approval/.test(subtype)) {
    return { state: "permission_required", summary: "等待核准", timestamp };
  }
  if (type === "error" || subtype === "error") {
    return { state: "error", summary: compact(textFrom(firstValue(record.error, record.message)), "Claude 回報錯誤"), timestamp };
  }
  if (type === "user") {
    return { state: "working", summary: "收到新指令，開始工作", timestamp };
  }
  if (type === "assistant") {
    const content = message.content;
    const toolUses = Array.isArray(content)
      ? content.filter((item) => item && (item.type === "tool_use" || item.type === "server_tool_use"))
      : [];
    const hasToolUse = toolUses.length > 0;
    if (stopReason === "end_turn") {
      return { state: "waiting_user", summary: compact(textFrom(content), "等待你的下一個指示"), timestamp };
    }
    // Waiting on Glen, not working, when the turn stopped to call a user-facing tool:
    //  - a named blocking tool in the logged tool_use (matches when a transcript records it), or
    //  - stop_reason "tool_use" with NO executable tool block — which is exactly how the
    //    desktop app records a client/UI tool that blocks on the user (AskUserQuestion /
    //    ExitPlanMode / a permission prompt): the tool itself is stripped from the log, so
    //    the model "stopped to use a tool" yet none is present. A real working tool call
    //    (Bash/Read/…) always carries its tool block, so this does not catch genuine work.
    const asksUser = toolUses.some((item) => USER_BLOCKING_TOOLS.has(String(item.name || "").toLowerCase()));
    if (asksUser || (stopReason === "tool_use" && !hasToolUse)) {
      // 「問你」：Claude 跳出選項/問題在等你回答，跟「等你」（回合結束、待下一個指示）分開，
      // 讓畫面能一眼區分「需要我做決定」和「單純做完在等我」。
      return { state: "asking", summary: compact(textFrom(content), "正在問你問題，等你回答"), timestamp };
    }
    return { state: "working", summary: compact(textFrom(content), hasToolUse ? "執行工具中" : "正在整理回覆"), timestamp };
  }
  if (type === "queue-operation") return { state: "working", summary: "等待工作佇列處理", timestamp };
  return null;
}

function classifyCodex(record) {
  const payload = record.payload || record;
  const type = String(firstValue(payload.type, record.event_type, record.type, "")).toLowerCase();
  const timestamp = timestampOf({ ...record, ...payload });
  if (type === "session_meta") return { state: "idle", summary: "Session 已建立", timestamp };
  if (/approval|permission|request.?user|elicitation/.test(type)) return { state: "waiting_user", summary: "等待你的回覆或核准", timestamp };
  if (/error|failed/.test(type)) return { state: "error", summary: compact(textFrom(firstValue(payload.error, payload.message, record.error)), "Codex 回報錯誤"), timestamp };
  if (/task_started|turn_started|item_started|agent_message_delta|response_created/.test(type)) return { state: "working", summary: compact(textFrom(firstValue(payload.message, payload.item, payload.delta)), "正在工作"), timestamp };
  if (/task_complete|turn_completed|session_completed|session_closed|thread_closed/.test(type)) return { state: "done", summary: compact(textFrom(firstValue(payload.last_agent_message, payload.message, payload.item)), "工作完成"), timestamp };
  if (/turn_aborted|cancelled|canceled/.test(type)) return { state: "blocked", summary: "工作被中止", timestamp };
  if (type === "item_completed") {
    const itemType = String(payload.item && payload.item.type || "").toLowerCase();
    if (itemType.includes("error")) return { state: "error", summary: "工作項目回報錯誤", timestamp };
    return { state: "working", summary: "整理工作項目，繼續處理", timestamp };
  }
  if (type === "user_message") return { state: "working", summary: "收到新指令，開始工作", timestamp };
  return null;
}

function sessionNameFromRecord(source, record) {
  const payload = record && record.payload || {};
  if (source === "claude-code") {
    const type = String(record && record.type || "").toLowerCase();
    if (type === "custom-title") return firstValue(record.customTitle, record.title, null);
    if (type === "ai-title") return firstValue(record.aiTitle, record.title, null);
  }
  const type = String(firstValue(payload.type, record && record.type, "")).toLowerCase();
  if (source === "codex" && (type === "thread_name_updated" || type === "thread-name-updated" || type === "session_name")) {
    return firstValue(payload.thread_name, payload.threadName, payload.name, payload.title, record.thread_name, record.threadName, record.name, record.title, null);
  }
  return null;
}

function sessionNamePriority(source, record) {
  const payload = record && record.payload || {};
  const type = String(firstValue(payload.type, record && record.type, "")).toLowerCase();
  if (source === "claude-code") {
    if (type === "custom-title") return 3;
    if (type === "ai-title") return 2;
  }
  if (source === "codex" && (type === "thread_name_updated" || type === "thread-name-updated" || type === "session_name")) return 3;
  return 0;
}

function createState(source, filePath, context, identity) {
  return {
    source,
    filePath,
    sessionId: context.sessionId,
    cwd: context.cwd || null,
    identity,
    sessionName: context.sessionName || null,
    sessionNamePriority: context.sessionName ? (context.sessionNamePriority || 1) : 0,
    firstPrompt: null,
    firstTimestamp: null,
    updatedAt: null,
    stateStartedAt: null,
    state: "idle",
    summary: "沒有最新回報",
    lineCount: 0
  };
}

function applyClassification(state, classification) {
  if (!classification || !classification.timestamp) return;
  if (!state.firstTimestamp || Date.parse(classification.timestamp) < Date.parse(state.firstTimestamp)) state.firstTimestamp = classification.timestamp;
  if (state.updatedAt && Date.parse(classification.timestamp) < Date.parse(state.updatedAt)) return;
  if (state.state !== classification.state) state.stateStartedAt = classification.timestamp;
  if (!state.stateStartedAt) state.stateStartedAt = classification.timestamp;
  state.state = classification.state;
  state.summary = classification.summary || state.summary;
  state.updatedAt = classification.timestamp;
}

// A short, human-readable name pulled from the first real user prompt, used only as a
// last-resort display name for sessions that never got a custom-title / ai-title (e.g. a
// No-folder throwaway session). System reminders and tool-result / task-notification
// payloads are skipped so the name reflects what Glen actually typed.
function firstPromptName(source, record) {
  const message = record && record.message;
  const content = message && message.content;
  let text = null;
  if (typeof content === "string") text = content;
  else if (source === "codex") text = textFrom(firstValue((record.payload || {}).message, (record.payload || {}).text));
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  if (/system-reminder|task-notification|<task-|tool_result|"tool_use_id"/.test(trimmed)) return null;
  const oneLine = trimmed.replace(/\s+/g, " ");
  return oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine;
}

// Name used for steward detection and as the primary display name — deliberately EXCLUDES
// the first-prompt fallback so a prompt that merely mentions 克雷利文/總管 cannot flip a
// worker into a steward.
function canonicalNameOf(state) {
  return state.identity.isNameExplicit ? state.identity.agentName : (state.sessionName || state.identity.agentName);
}

function displayNameOf(state) {
  if (state.identity.isNameExplicit) return state.identity.agentName;
  return state.sessionName || state.firstPrompt || state.identity.agentName;
}

function refreshInferredRole(state) {
  const displayName = canonicalNameOf(state);
  if (state.identity.kind === "steward" || (!state.identity.isKindExplicit && looksLikeStewardName(displayName))) {
    state.identity.kind = "steward";
    if (!state.identity.officeId || state.identity.officeId === "direct-01") state.identity.officeId = "managed-01";
  }
}

function recordContext(source, record, filePath, fallbackId) {
  const payload = record.payload || {};
  const sessionId = String(firstValue(
    record.sessionId,
    record.session_id,
    payload.session_id,
    payload.thread_id,
    payload.threadId,
    record.thread_id,
    fallbackId
  ));
  const cwd = firstValue(record.cwd, payload.cwd, payload.thread?.cwd, null);
  return {
    source,
    sessionId,
    cwd,
    sessionName: sessionNameFromRecord(source, record),
    sessionNamePriority: sessionNamePriority(source, record),
    filePath
  };
}

function parseArgs(argv) {
  const args = {
    mode: "help",
    port: DEFAULTS.port,
    pollMs: DEFAULTS.pollMs,
    maxAgeMinutes: DEFAULTS.maxAgeMinutes,
    activeOnly: process.env.AGENTDESK_ACTIVE_ONLY !== "false",
    activeFileMinutes: Number(process.env.AGENTDESK_ACTIVE_FILE_MINUTES || DEFAULTS.activeFileMinutes),
    removeGraceSeconds: Number(process.env.AGENTDESK_REMOVE_GRACE_SECONDS || DEFAULTS.removeGraceSeconds),
    hideParkedMinutes: Number(process.env.AGENTDESK_HIDE_PARKED_MINUTES ?? DEFAULTS.hideParkedMinutes)
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--once") args.mode = "once";
    else if (value === "--watch") args.mode = "watch";
    else if (value === "--serve") args.mode = "serve";
    else if (value === "--port") args.port = Number(argv[++index]);
    else if (value === "--poll-ms") args.pollMs = Number(argv[++index]);
    else if (value === "--max-age-minutes") args.maxAgeMinutes = Number(argv[++index]);
    else if (value === "--active-file-minutes") args.activeFileMinutes = Number(argv[++index]);
    else if (value === "--remove-grace-seconds") args.removeGraceSeconds = Number(argv[++index]);
    else if (value === "--hide-parked-minutes") args.hideParkedMinutes = Number(argv[++index]);
    else if (value === "--all" || value === "--include-recent") args.activeOnly = false;
    else if (value === "--active-only") args.activeOnly = true;
    else if (value === "--registry") args.registryPath = argv[++index];
    else if (value === "--claude-projects") args.claudeProjects = argv[++index];
    else if (value === "--codex-home") args.codexHome = argv[++index];
  }
  return args;
}

function expandHome(value) {
  if (!value) return value;
  return value.replace(/^~(?=$|[\\/])/, os.homedir());
}

function readJson(pathname, fallback) {
  try { return JSON.parse(fs.readFileSync(pathname, "utf8")); } catch { return fallback; }
}

function readRange(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (!length) return "";
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function listJsonl(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(pathname);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(pathname);
    }
  }
  walk(root);
  return files;
}

function parseLines(buffer) {
  const lines = buffer.split(/\r?\n/);
  if (!lines[lines.length - 1]?.trim()) lines.pop();
  return lines.map((line) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

class SessionMonitor {
  constructor(options = {}) {
    const claudeProjects = expandHome(options.claudeProjects || process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects"));
    const codexHome = expandHome(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    const registryPath = options.registryPath || process.env.AGENTDESK_AGENT_REGISTRY || path.join(__dirname, "agentdesk-agent-registry.json");
    this.options = { ...DEFAULTS, ...options, claudeProjects, codexHome, registryPath };
    this.registry = readJson(registryPath, { defaults: {}, rules: [] });
    this.cursors = new Map();
    this.states = new Map();
    this.fileStates = new Map();
    this.codexNameIndex = new Map();
    this.codexIndexMtime = 0;
    this.activityCache = {
      checkedAt: 0,
      claudeProcessIds: new Set(),
      claudeProcessDiscoveryAvailable: false
    };
    this.lastSnapshot = null;
  }

  discoverClaudeProcessIds(now = Date.now()) {
    if (now - this.activityCache.checkedAt < 5000) return this.activityCache;

    const result = {
      checkedAt: now,
      claudeProcessIds: new Set(),
      claudeProcessDiscoveryAvailable: false
    };
    if (process.platform !== "win32") {
      this.activityCache = result;
      return result;
    }

    const command = "$pattern='--resume(?:=|\\s+)([0-9a-f-]{36})'; Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.CommandLine -match 'claude-code' -and $_.CommandLine -match $pattern } | ForEach-Object { [regex]::Match($_.CommandLine, $pattern).Groups[1].Value } | ConvertTo-Json -Compress";

    try {
      const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000
      }).trim();
      if (output) {
        const values = JSON.parse(output);
        for (const value of (Array.isArray(values) ? values : [values])) {
          if (value) result.claudeProcessIds.add(String(value));
        }
      }
      result.claudeProcessDiscoveryAvailable = true;
    } catch {
      // If process inspection is unavailable, refresh() falls back to the recent-file window.
    }

    this.activityCache = result;
    return result;
  }

  activityForFile(source, filePath, stat, now, activity) {
    if (!this.options.activeOnly) {
      return { active: now - stat.mtimeMs <= this.options.maxAgeMinutes * 60000, reason: "recent-file" };
    }

    if (source === "claude-code" && activity.claudeProcessDiscoveryAvailable) {
      const sessionId = path.basename(filePath, ".jsonl");
      return {
        active: activity.claudeProcessIds.has(sessionId),
        reason: "claude-process"
      };
    }

    if (source === "codex") {
      return {
        active: now - stat.mtimeMs <= this.options.activeFileMinutes * 60000,
        reason: "codex-recent-rollout"
      };
    }

    return {
      active: now - stat.mtimeMs <= this.options.maxAgeMinutes * 60000,
      reason: "recent-file-fallback"
    };
  }

  refreshCodexNameIndex() {
    const indexPath = path.join(this.options.codexHome, "session_index.jsonl");
    let stat;
    try { stat = fs.statSync(indexPath); } catch { return; }
    if (stat.mtimeMs <= this.codexIndexMtime) return;
    this.codexNameIndex.clear();
    for (const record of parseLines(fs.readFileSync(indexPath, "utf8"))) {
      const id = firstValue(record.id, record.session_id, record.thread_id, null);
      const name = firstValue(record.thread_name, record.threadName, record.name, record.title, null);
      if (id && name) this.codexNameIndex.set(String(id), String(name));
    }
    this.codexIndexMtime = stat.mtimeMs;
  }

  sourceFiles() {
    return [
      ...listJsonl(this.options.claudeProjects).map((filePath) => ({ source: "claude-code", filePath })),
      ...listJsonl(path.join(this.options.codexHome, "sessions")).map((filePath) => ({ source: "codex", filePath }))
    ];
  }

  readFileRecords(source, filePath, stat) {
    const key = `${source}:${filePath}`;
    const previous = this.cursors.get(key);
    if (!previous || stat.size < previous.offset) {
      const prefixBytes = Math.min(stat.size, 64 * 1024);
      const prefix = prefixBytes ? readRange(filePath, 0, prefixBytes) : "";
      const tailBytes = Math.min(stat.size, this.options.maxReadBytes);
      const tailStart = Math.max(0, stat.size - tailBytes);
      const tail = tailBytes ? readRange(filePath, tailStart, stat.size) : "";
      const previousByte = tailStart > 0 ? readRange(filePath, tailStart - 1, tailStart) : "";
      const tailStartsAtLine = tailStart === 0 || previousByte === "\n" || previousByte === "\r";
      const firstLineEnd = tail.search(/\r?\n/);
      const completeTail = tailStartsAtLine || firstLineEnd < 0 ? tail : tail.slice(firstLineEnd + 1);
      const records = stat.size <= 600 * 1024
        ? parseLines(fs.readFileSync(filePath, "utf8"))
        : [...parseLines(prefix), ...parseLines(completeTail)];
      this.cursors.set(key, { offset: stat.size, remainder: "" });
      return records;
    }
    if (stat.size === previous.offset) return [];
    const chunk = readRange(filePath, previous.offset, stat.size);
    const text = previous.remainder + chunk;
    const lines = text.split(/\r?\n/);
    previous.remainder = lines.pop() || "";
    previous.offset = stat.size;
    return lines.map((line) => {
      try { return line.trim() ? JSON.parse(line) : null; } catch { return null; }
    }).filter(Boolean);
  }

  processFile(source, filePath, stat) {
    const fileKey = `${source}:${filePath}`;
    let knownKey = this.fileStates.get(fileKey);
    // If a previous refresh pruned this session's state but left its file mapping and
    // read cursor behind, drop those stale pointers so the incremental read starts over
    // from the beginning and the state is fully rebuilt, instead of being skipped forever
    // by the empty-read short-circuit below.
    if (knownKey && !this.states.has(knownKey)) {
      this.cursors.delete(fileKey);
      this.fileStates.delete(fileKey);
      knownKey = null;
    }
    const fallbackId = path.basename(filePath, ".jsonl").replace(/^rollout-.*?-/, "");
    const records = this.readFileRecords(source, filePath, stat);
    if (!records.length && knownKey) return;
    const firstRecord = records.find((record) => record && (record.sessionId || record.session_id || record.payload?.session_id || record.payload?.thread_id));
    const context = recordContext(source, firstRecord || {}, filePath, fallbackId);
    const knownState = knownKey ? this.states.get(knownKey) : null;
    if (knownState) context.sessionId = knownState.sessionId;
    if (source === "codex" && this.codexNameIndex.has(context.sessionId)) {
      context.sessionName = this.codexNameIndex.get(context.sessionId);
      context.sessionNamePriority = 3;
    }
    if (knownState && !context.sessionName) {
      context.sessionName = knownState.sessionName;
      context.sessionNamePriority = knownState.sessionNamePriority || 0;
    }
    const identity = knownState?.identity || resolveIdentity(this.registry, context);
    const key = knownKey || `${source}:${context.sessionId}`;
    const state = knownState || createState(source, filePath, context, identity);
    state.identity = identity;
    state.cwd = context.cwd || state.cwd;
    if (context.sessionName && (context.sessionNamePriority || 0) >= (state.sessionNamePriority || 0)) {
      state.sessionName = context.sessionName;
      state.sessionNamePriority = context.sessionNamePriority || 1;
    }
    refreshInferredRole(state);
    for (const record of records) {
      state.lineCount += 1;
      const sessionName = sessionNameFromRecord(source, record);
      const priority = sessionNamePriority(source, record);
      if (sessionName && priority >= (state.sessionNamePriority || 0)) {
        state.sessionName = String(sessionName);
        state.sessionNamePriority = priority;
        if (!state.identity.isNameExplicit) state.identity.agentName = state.sessionName;
        refreshInferredRole(state);
      }
      if (!state.firstPrompt) {
        const prompt = firstPromptName(source, record);
        if (prompt) state.firstPrompt = prompt;
      }
      const classification = source === "claude-code" ? classifyClaude(record) : classifyCodex(record);
      applyClassification(state, classification);
    }
    state.fileMtime = stat.mtimeMs;
    state.fileSize = stat.size;
    this.states.set(key, state);
    this.fileStates.set(`${source}:${filePath}`, key);
  }

  refresh() {
    const now = Date.now();
    this.refreshCodexNameIndex();
    const activity = this.discoverClaudeProcessIds(now);
    const files = this.sourceFiles();
    const visibleKeys = new Set();
    for (const { source, filePath } of files) {
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      const fileActivity = this.activityForFile(source, filePath, stat, now, activity);
      if (!fileActivity.active) continue;
      this.processFile(source, filePath, stat);
      const fileKey = `${source}:${filePath}`;
      const stateKey = this.fileStates.get(fileKey);
      if (stateKey) visibleKeys.add(stateKey);
    }
    const removeGraceMs = Math.max(0, this.options.removeGraceSeconds) * 1000;
    for (const [key, state] of this.states) {
      if (visibleKeys.has(key)) {
        state.lastSeenAt = now;
        continue;
      }
      // Not visible this round. Keep it within a short grace window so a single transient
      // process-detection miss does not permanently drop a live session; only remove once
      // it has been continuously absent past the grace window.
      const lastSeen = state.lastSeenAt || Date.parse(state.updatedAt) || now;
      if (now - lastSeen > removeGraceMs) {
        this.states.delete(key);
        const staleFileKey = `${state.source}:${state.filePath}`;
        this.cursors.delete(staleFileKey);
        this.fileStates.delete(staleFileKey);
      }
    }
    this.lastSnapshot = this.snapshot(now, activity);
    return this.lastSnapshot;
  }

  snapshot(now = Date.now(), activity = this.activityCache) {
    const hideParkedMs = Math.max(0, this.options.hideParkedMinutes) * 60000;
    const states = [...this.states.values()].map((state) => {
      refreshInferredRole(state);
      return state;
    }).filter((state) => {
      if (!hideParkedMs) return true;
      const status = sessionAdapter.stateMap[state.state] || "idle";
      // working / blocked always show; a parked session (waiting / done / idle) is hidden
      // once its last activity is older than the threshold. The state stays tracked in
      // this.states, so it reappears as soon as the source becomes active again.
      if (status === "working" || status === "blocked" || status === "asking") return true;
      const updated = Date.parse(state.updatedAt || "") || state.lastSeenAt || 0;
      return now - updated <= hideParkedMs;
    }).sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const agents = states.map((state) => ({
      name: displayNameOf(state),
      sessionName: displayNameOf(state),
      sourceSessionName: state.sessionName || null,
      id: state.identity.agentId,
      kind: state.identity.kind,
      officeId: state.identity.officeId,
      status: sessionAdapter.stateMap[state.state] || "idle",
      duration: sessionAdapter.normalize({ startedAt: state.stateStartedAt, state: state.state }, now).duration,
      message: state.summary,
      hair: state.identity.hair,
      coat: state.identity.coat,
      sessionId: state.sessionId,
      source: state.source,
      reportTo: state.identity.reportTo,
      updatedAt: state.updatedAt
    }));
    const events = states.map((state) => ({
      sessionName: displayNameOf(state),
      sourceSessionName: state.sessionName || null,
      sessionId: state.sessionId,
      source: state.source,
      agentId: state.identity.agentId,
      reportTo: state.identity.reportTo,
      state: state.state,
      startedAt: state.stateStartedAt || state.firstTimestamp || state.updatedAt,
      updatedAt: state.updatedAt,
      summary: state.summary
    }));
    return {
      generatedAt: new Date(now).toISOString(),
      events,
      agents,
      sessions: states.map((state) => ({ sessionId: state.sessionId, source: state.source, cwd: state.cwd, updatedAt: state.updatedAt, state: state.state })),
      meta: {
        claudeProjects: this.options.claudeProjects,
        codexHome: this.options.codexHome,
        maxAgeMinutes: this.options.maxAgeMinutes,
        activeOnly: this.options.activeOnly,
        activeFileMinutes: this.options.activeFileMinutes,
        removeGraceSeconds: this.options.removeGraceSeconds,
        hideParkedMinutes: this.options.hideParkedMinutes,
        activityDetection: this.options.activeOnly ? "claude-process + codex-recent-rollout" : "recent-files",
        activeClaudeProcessCount: activity.claudeProcessIds.size,
        claudeProcessDiscoveryAvailable: activity.claudeProcessDiscoveryAvailable,
        sessionCount: states.length
      }
    };
  }

  watch(onSnapshot) {
    const tick = () => {
      try { onSnapshot(this.refresh()); } catch (error) { process.stderr.write(`[AgentDesk monitor] ${error.message}\n`); }
    };
    tick();
    return setInterval(tick, this.options.pollMs);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(JSON.stringify(payload));
}

function startServer(monitor, port) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "OPTIONS") return sendJson(response, 204, {});
    if (request.method !== "GET") return sendJson(response, 405, { error: "GET only" });
    if (url.pathname === "/api/health") return sendJson(response, 200, { ok: true, generatedAt: new Date().toISOString() });
    if (url.pathname === "/api/sessions") return sendJson(response, 200, monitor.refresh());
    return sendJson(response, 404, { error: "Not found" });
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`AgentDesk session monitor listening on http://127.0.0.1:${port}\n`);
  });
  return server;
}

function printHelp() {
  process.stdout.write("Usage: node agentdesk-session-monitor.js --once | --watch | --serve [--port 4317] [--active-file-minutes 15] [--remove-grace-seconds 30] [--hide-parked-minutes 30] [--max-age-minutes 240] [--all]\n");
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const monitor = new SessionMonitor(args);
  if (args.mode === "once") process.stdout.write(`${JSON.stringify(monitor.refresh(), null, 2)}\n`);
  else if (args.mode === "watch") monitor.watch((snapshot) => process.stdout.write(`${JSON.stringify(snapshot)}\n`));
  else if (args.mode === "serve") monitor.watch(() => {}), startServer(monitor, args.port);
  else printHelp();
}

module.exports = { SessionMonitor, classifyClaude, classifyCodex, resolveIdentity, parseArgs, startServer };
