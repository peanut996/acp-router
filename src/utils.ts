import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AGENT_ENV_ALLOWLIST } from "./constants.js";

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEnv({ inheritEnvironment = true }: { inheritEnvironment?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = inheritEnvironment ? { ...process.env } : {};
  return {
    ...env,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...allowlistedAgentEnv()
  };
}

function allowlistedAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key] as string;
  }
  return env;
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function preview(value: unknown, maxLength: number): string {
  const text = stripAnsi(String(value ?? "")).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function hashText(text: unknown): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(String(text)).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface McpTextContent {
  type: "text";
  text: string;
}

interface McpToolResult {
  content: McpTextContent[];
}

function toToolResult(obj: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function createId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${random}`;
}

function resolveBooleanOverride(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback === true;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

interface AcpProcessClosedEvent {
  type: "acp_process_closed";
  timestamp: string;
  message: string;
}

function buildAcpProcessClosedEvent(startedAt: number): AcpProcessClosedEvent {
  return {
    type: "acp_process_closed",
    timestamp: new Date().toISOString(),
    message: `OpenCode ACP adapter finished after ${Date.now() - startedAt}ms.`
  };
}

export {
  execFileAsync,
  sleep,
  safeEnv,
  allowlistedAgentEnv,
  clampInteger,
  preview,
  stripAnsi,
  hashText,
  isPlainObject,
  toToolResult,
  createId,
  resolveBooleanOverride,
  uniqueStrings,
  buildAcpProcessClosedEvent
};
