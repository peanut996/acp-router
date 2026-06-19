#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "acp-coding-agent-dispatcher";
const SERVER_VERSION = "0.1.0";
const DATA_DIR = path.join(os.homedir(), ".codex", "agent-dispatcher");
const REGISTRY_PATH = path.join(DATA_DIR, "registry.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

const TOOL_DEFINITIONS = [
  {
    name: "discover_coding_agents",
    description: "Discover local coding agents from safe PATH inspection and dispatcher configuration.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", default: false },
        includeNotInstalled: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_coding_agent_dispatcher_config",
    description: "Read dispatcher default agent, per-mode defaults, disabled agents, and safety policy.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "configure_coding_agent_dispatcher",
    description: "Update dispatcher configuration in the local Codex agent-dispatcher config file.",
    inputSchema: {
      type: "object",
      properties: {
        defaultAgent: { type: ["string", "null"] },
        modeDefaults: { type: "object", additionalProperties: { type: "string" } },
        disabledAgents: { type: "array", items: { type: "string" } },
        allowCurrentDirectory: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_coding_agent",
    description: "Create a tracked coding-agent job. V1 scaffold records the job but does not launch an external process.",
    inputSchema: {
      type: "object",
      required: ["prompt", "worktree"],
      properties: {
        agent: { type: ["string", "null"] },
        worktree: { type: "string" },
        prompt: { type: "string" },
        mode: { type: "string", default: "implementation" },
        async: { type: "boolean", default: true },
        sessionId: { type: ["string", "null"] },
        timeoutSec: { type: "integer", minimum: 1, default: 3600 },
        permissionProfile: {
          type: "string",
          enum: ["plan", "workspace_write", "accept_edits", "bypass_permissions"],
          default: "workspace_write"
        },
        collectDiff: { type: "boolean", default: true },
        metadata: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_coding_agent_jobs",
    description: "List dispatcher jobs from the local registry.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: ["string", "null"] },
        agent: { type: ["string", "null"] },
        worktree: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_coding_agent_job",
    description: "Get a dispatcher job by id.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "cancel_coding_agent_job",
    description: "Mark a local dispatcher job as cancelled. Future adapters will terminate the backing agent process.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_coding_agent_sessions",
    description: "List dispatcher sessions from the local registry.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: ["string", "null"] },
        worktree: { type: ["string", "null"] },
        includeArchived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: "continue_coding_agent_session",
    description: "Create a new tracked job attached to an existing dispatcher session.",
    inputSchema: {
      type: "object",
      required: ["agent", "sessionId", "prompt", "worktree"],
      properties: {
        agent: { type: "string" },
        sessionId: { type: "string" },
        prompt: { type: "string" },
        worktree: { type: "string" },
        async: { type: "boolean", default: true },
        timeoutSec: { type: "integer", minimum: 1, default: 3600 }
      },
      additionalProperties: false
    }
  },
  {
    name: "archive_coding_agent_session",
    description: "Mark a dispatcher session as archived in the local registry.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  }
];

const BUILT_IN_AGENTS = [
  {
    id: "opencode",
    displayName: "OpenCode",
    transport: "acp_stdio",
    command: "opencode acp --cwd <worktree>",
    capabilities: ["session_list", "session_continue", "file_edit", "shell", "diff_collection"],
    source: ["path", "registry"],
    notes: ["Native ACP adapter target for V1."]
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    transport: "cli",
    command: "agent --print --output-format stream-json --workspace <worktree>",
    capabilities: ["file_edit", "shell", "diff_collection"],
    source: ["path"],
    notes: ["CLI fallback target; sessions are dispatcher-managed until an ACP adapter is available."]
  },
  {
    id: "claude",
    displayName: "Claude Code",
    transport: "cli",
    command: "claude -p --output-format stream-json",
    capabilities: ["file_edit", "shell", "permission_modes", "diff_collection"],
    source: ["path"],
    notes: ["CLI fallback target."]
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    transport: "cli",
    command: "codex exec",
    capabilities: ["file_edit", "shell", "diff_collection"],
    source: ["path"],
    notes: ["Use cautiously to avoid recursive control loops; require an isolated worktree."]
  }
];

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  drainBuffer().catch((error) => {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: error.message }
    });
  });
});

async function drainBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd);
    const match = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!match) {
      buffer = "";
      throw new Error("Missing Content-Length header");
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const raw = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(bodyEnd);
    await handleMessage(JSON.parse(raw));
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;

  if (id === undefined) return;

  try {
    if (method === "initialize") {
      return writeResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
    }
    if (method === "ping") return writeResult(id, {});
    if (method === "tools/list") return writeResult(id, { tools: TOOL_DEFINITIONS });
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments ?? {});
      return writeResult(id, asToolResult(result));
    }
    writeError(id, -32601, `Unsupported method: ${method}`);
  } catch (error) {
    writeResult(id, asToolResult({ error: error.message }, true));
  }
}

async function callTool(name, args) {
  switch (name) {
    case "discover_coding_agents":
      return discoverAgents(args);
    case "get_coding_agent_dispatcher_config":
      return { config: await readConfig() };
    case "configure_coding_agent_dispatcher":
      return configureDispatcher(args);
    case "run_coding_agent":
      return createJob(args);
    case "list_coding_agent_jobs":
      return listJobs(args);
    case "get_coding_agent_job":
      return getJob(args);
    case "cancel_coding_agent_job":
      return cancelJob(args);
    case "list_coding_agent_sessions":
      return listSessions(args);
    case "continue_coding_agent_session":
      return continueSession(args);
    case "archive_coding_agent_session":
      return archiveSession(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function discoverAgents(args) {
  const config = await readConfig();
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const agents = await Promise.all(BUILT_IN_AGENTS.map(async (agent) => {
    const executable = agent.id === "cursor-agent" ? "agent" : agent.id;
    const installedPath = await findExecutable(executable, pathEntries);
    const disabled = config.disabledAgents.includes(agent.id);
    const status = disabled ? "disabled" : installedPath ? "available" : "not_installed";
    return {
      id: agent.id,
      displayName: agent.displayName,
      status,
      version: null,
      transport: agent.transport,
      command: agent.command,
      source: agent.source,
      capabilities: agent.capabilities,
      icon: null,
      notes: installedPath ? [`Found at ${installedPath}`] : agent.notes
    };
  }));
  const filteredAgents = args.includeNotInstalled === false
    ? agents.filter((agent) => agent.status !== "not_installed")
    : agents;
  const recommended = chooseAgent(agents, config, null);
  return {
    agents: filteredAgents,
    recommendedDefaultAgent: recommended.agentId
      ? { agentId: recommended.agentId, reason: recommended.reason }
      : null,
    refreshedAt: new Date().toISOString()
  };
}

async function configureDispatcher(args) {
  const existing = await readConfig();
  const next = {
    ...existing,
    defaultAgent: Object.prototype.hasOwnProperty.call(args, "defaultAgent")
      ? args.defaultAgent
      : existing.defaultAgent,
    modeDefaults: {
      ...existing.modeDefaults,
      ...(isPlainObject(args.modeDefaults) ? args.modeDefaults : {})
    },
    disabledAgents: Array.isArray(args.disabledAgents)
      ? Array.from(new Set(args.disabledAgents.filter((value) => typeof value === "string" && value.trim())))
      : existing.disabledAgents,
    allowCurrentDirectory: typeof args.allowCurrentDirectory === "boolean"
      ? args.allowCurrentDirectory
      : existing.allowCurrentDirectory,
    updatedAt: new Date().toISOString()
  };
  await writeJson(CONFIG_PATH, next);
  return { config: next };
}

async function createJob(args) {
  const worktreeCheck = await validateWorktree(args.worktree);
  if (!worktreeCheck.ok) {
    return {
      status: "failed",
      error: worktreeCheck.reason,
      message: "V1 requires an existing absolute worktree path before dispatching an external agent."
    };
  }

  const config = await readConfig();
  const registry = await readRegistry();
  const mode = args.mode ?? "implementation";
  const selected = args.agent
    ? { agentId: args.agent, reason: "agent explicitly requested" }
    : chooseAgent(await discoverAgents({ includeNotInstalled: false }).then((value) => value.agents), config, mode);
  if (!selected.agentId) {
    return {
      status: "failed",
      error: "no_available_agent",
      message: "No available agent was configured or discovered. Use discover_coding_agents first."
    };
  }

  const now = new Date().toISOString();
  const jobId = createId("job");
  const sessionId = args.sessionId || createId(`sess_${selected.agentId}`);
  const session = registry.sessions[sessionId] ?? {
    sessionId,
    providerSessionId: null,
    agentId: selected.agentId,
    title: preview(args.prompt, 60),
    status: "idle",
    worktree: args.worktree,
    createdAt: now,
    updatedAt: now,
    lastJobId: null,
    source: "dispatcher_registry",
    canContinue: true
  };

  const job = {
    jobId,
    sessionId,
    agentId: selected.agentId,
    status: args.async === false ? "completed" : "queued",
    worktree: args.worktree,
    mode,
    permissionProfile: args.permissionProfile ?? "workspace_write",
    collectDiff: args.collectDiff !== false,
    promptPreview: preview(args.prompt, 160),
    promptHash: await hashText(args.prompt),
    startedAt: now,
    endedAt: args.async === false ? now : null,
    timeoutSec: args.timeoutSec ?? 3600,
    metadata: isPlainObject(args.metadata) ? args.metadata : {},
    resultSummary: args.async === false
      ? "Stub dispatcher completed without launching an external agent."
      : null,
    changedFiles: [],
    validation: [],
    risks: ["External agent adapters are not implemented in this V1 scaffold."],
    logPath: path.join(DATA_DIR, "logs", `${jobId}.jsonl`),
    recentEvents: [
      {
        type: "dispatcher_stub",
        timestamp: now,
        message: "Job recorded in local registry; no external process was launched."
      }
    ]
  };

  session.updatedAt = now;
  session.lastJobId = jobId;
  registry.sessions[sessionId] = session;
  registry.jobs[jobId] = job;
  await writeRegistry(registry);

  return {
    jobId,
    sessionId,
    agentId: selected.agentId,
    status: job.status,
    worktree: args.worktree,
    startedAt: now,
    message: `${selected.agentId} job recorded by dispatcher stub. Use get_coding_agent_job to inspect it.`,
    adapterStatus: "stub",
    selectionReason: selected.reason
  };
}

async function listJobs(args) {
  const registry = await readRegistry();
  const limit = args.limit ?? 50;
  const jobs = Object.values(registry.jobs)
    .filter((job) => !args.status || job.status === args.status)
    .filter((job) => !args.agent || job.agentId === args.agent)
    .filter((job) => !args.worktree || job.worktree === args.worktree)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
  return { jobs };
}

async function getJob(args) {
  const registry = await readRegistry();
  const job = registry.jobs[args.jobId];
  if (!job) return { jobId: args.jobId, status: "not_found" };
  return { job };
}

async function cancelJob(args) {
  const registry = await readRegistry();
  const job = registry.jobs[args.jobId];
  if (!job) return { jobId: args.jobId, status: "not_found" };
  if (!["completed", "failed", "cancelled", "timed_out"].includes(job.status)) {
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    job.recentEvents = [
      ...(job.recentEvents ?? []),
      {
        type: "cancelled",
        timestamp: job.endedAt,
        message: args.reason || "Cancelled by dispatcher caller."
      }
    ];
    await writeRegistry(registry);
  }
  return { jobId: job.jobId, status: job.status };
}

async function listSessions(args) {
  const registry = await readRegistry();
  const limit = args.limit ?? 50;
  const sessions = Object.values(registry.sessions)
    .filter((session) => args.includeArchived || session.status !== "archived")
    .filter((session) => !args.agent || session.agentId === args.agent)
    .filter((session) => !args.worktree || session.worktree === args.worktree)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
  return { sessions };
}

async function continueSession(args) {
  const registry = await readRegistry();
  const session = registry.sessions[args.sessionId];
  if (!session) {
    return {
      sessionId: args.sessionId,
      status: "not_found",
      message: "The V1 scaffold can only continue sessions already recorded in the dispatcher registry."
    };
  }
  return createJob({
    agent: args.agent,
    sessionId: args.sessionId,
    prompt: args.prompt,
    worktree: args.worktree,
    async: args.async,
    timeoutSec: args.timeoutSec,
    mode: "implementation",
    permissionProfile: "workspace_write",
    collectDiff: true
  });
}

async function archiveSession(args) {
  const registry = await readRegistry();
  const session = registry.sessions[args.sessionId];
  if (!session) return { sessionId: args.sessionId, status: "not_found" };
  session.status = "archived";
  session.updatedAt = new Date().toISOString();
  await writeRegistry(registry);
  return { sessionId: session.sessionId, status: session.status };
}

async function readConfig() {
  return readJson(CONFIG_PATH, {
    defaultAgent: null,
    modeDefaults: {},
    disabledAgents: [],
    allowCurrentDirectory: false,
    safety: {
      requireAbsoluteWorktree: true,
      launchExternalAgents: false,
      defaultPermissionProfile: "workspace_write",
      bypassPermissionsDefault: false
    },
    updatedAt: null
  });
}

async function readRegistry() {
  return readJson(REGISTRY_PATH, { jobs: {}, sessions: {} });
}

async function writeRegistry(registry) {
  await writeJson(REGISTRY_PATH, registry);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function validateWorktree(worktree) {
  if (typeof worktree !== "string" || !worktree.trim()) {
    return { ok: false, reason: "worktree_required" };
  }
  if (!path.isAbsolute(worktree)) {
    return { ok: false, reason: "worktree_must_be_absolute" };
  }
  try {
    const stat = await fs.stat(worktree);
    if (!stat.isDirectory()) return { ok: false, reason: "worktree_must_be_directory" };
    await fs.access(worktree);
    return { ok: true };
  } catch {
    return { ok: false, reason: "worktree_not_accessible" };
  }
}

async function findExecutable(binary, pathEntries) {
  for (const entry of pathEntries) {
    const candidate = path.join(entry, binary);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function chooseAgent(agents, config, mode) {
  const disabled = new Set(config.disabledAgents ?? []);
  const available = agents.filter((agent) => agent.status === "available" && !disabled.has(agent.id));
  const explicit = config.defaultAgent && available.find((agent) => agent.id === config.defaultAgent);
  if (explicit) return { agentId: explicit.id, reason: "configured default agent" };
  const modeDefault = mode && config.modeDefaults?.[mode];
  const modeAgent = modeDefault && available.find((agent) => agent.id === modeDefault);
  if (modeAgent) return { agentId: modeAgent.id, reason: `configured default for ${mode}` };
  const acp = available.find((agent) => agent.transport === "acp_stdio");
  if (acp) return { agentId: acp.id, reason: "native ACP available" };
  const cli = available.find((agent) => agent.transport === "cli");
  if (cli) return { agentId: cli.id, reason: "CLI fallback available" };
  return { agentId: null, reason: "no available agent found" };
}

function createId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${random}`;
}

function preview(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

async function hashText(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(String(text)).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asToolResult(payload, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function writeResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
