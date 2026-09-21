const readline = require("node:readline");
const sourceAdapters = require("../wireframes/agentdesk-source-adapters.js");

function adaptRecord(record) {
  const provider = record.provider || record.source;
  const rawEvent = record.event || record.payload || record;
  const identity = {
    agentId: process.env.AGENTDESK_AGENT_ID || null,
    reportTo: process.env.AGENTDESK_REPORT_TO || null,
    ...(record.identity || {})
  };

  if (record.method) {
    return sourceAdapters.fromCodexAppServerEvent(record, identity);
  }

  if (provider === "claude" || provider === "claude-code") {
    return sourceAdapters.fromClaudeEvent(rawEvent, identity);
  }
  if (provider === "codex" || provider === "codex-app-server") {
    return sourceAdapters.fromCodexEvent(rawEvent, identity);
  }
  throw new Error(`Unsupported provider: ${provider || "missing"}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const record = JSON.parse(line);
    process.stdout.write(`${JSON.stringify(adaptRecord(record))}\n`);
  } catch (error) {
    process.stderr.write(`[AgentDesk bridge] ${error.message}\n`);
  }
});
