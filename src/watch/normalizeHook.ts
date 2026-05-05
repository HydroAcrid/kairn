import type { NormalizedHookEvent, WatchEventKind, WatchEventSource } from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";

export function normalizeHookPayload(input: {
  source: WatchEventSource;
  payload: unknown;
  eventName?: string | undefined;
}): NormalizedHookEvent {
  const payload = isRecord(input.payload) ? input.payload : {};
  const eventName = stringValue(input.eventName) ?? stringValue(payload.eventName) ?? stringValue(payload.hook_event_name) ?? "HookEvent";
  const toolName = stringValue(payload.toolName) ?? stringValue(payload.tool_name);
  const toolInput = payload.toolInput ?? payload.tool_input;
  const toolResponse = payload.toolResponse ?? payload.tool_response;
  const command =
    stringValue(payload.command) ??
    commandFromToolInput(toolInput) ??
    commandFromToolResponse(toolResponse);
  const output =
    stringValue(payload.output) ??
    stringValue(payload.stdout) ??
    stringValue(payload.stderr) ??
    outputFromToolResponse(toolResponse);
  const exitCode = numberValue(payload.exitCode) ?? numberValue(payload.exit_code) ?? exitCodeFromToolResponse(toolResponse);
  const files = normalizeFiles(payload.files);
  const cwd = stringValue(payload.cwd);
  const timestamp = stringValue(payload.timestamp);
  const hostSessionId = stringValue(payload.hostSessionId) ?? stringValue(payload.session_id);

  return {
    source: input.source,
    eventName,
    kind: kindFor({ eventName, toolName, command, exitCode, output }),
    ...(toolName ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolResponse !== undefined ? { toolResponse } : {}),
    ...(command ? { command } : {}),
    ...(output ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    files,
    ...(cwd ? { cwd } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(hostSessionId ? { hostSessionId } : {}),
    metadata: sanitizeMetadata(payload)
  };
}

export function hostHookOutput(input: {
  source: WatchEventSource;
  eventName: string;
  content?: string | undefined;
  json?: boolean | undefined;
}): string {
  if (!input.content?.trim()) return "";
  if (input.json || input.source === "generic" || input.source === "watch") {
    return input.content;
  }

  return JSON.stringify(
    {
      hookSpecificOutput: {
        hookEventName: input.eventName,
        additionalContext: input.content
      }
    },
    null,
    2
  );
}

function kindFor(input: {
  eventName: string;
  toolName?: string | undefined;
  command?: string | undefined;
  exitCode?: number | undefined;
  output?: string | undefined;
}): WatchEventKind {
  const event = input.eventName.toLowerCase();
  if (event.includes("session") || event === "stop") return "session";
  if (input.command) return input.exitCode && input.exitCode !== 0 ? "failure" : "command";
  if (input.output && input.exitCode && input.exitCode !== 0) return "failure";
  if (input.toolName) return "tool";
  return "hook";
}

function commandFromToolInput(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringValue(value.command) ?? stringValue(value.cmd);
}

function commandFromToolResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringValue(value.command);
}

function outputFromToolResponse(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return (
    stringValue(value.output) ??
    stringValue(value.stdout) ??
    stringValue(value.stderr) ??
    stringValue(value.text) ??
    stringValue(value.content)
  );
}

function exitCodeFromToolResponse(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return numberValue(value.exitCode) ?? numberValue(value.exit_code) ?? numberValue(value.status);
}

function normalizeFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeRelativePath(entry).replace(/^\.\//, ""))
    .filter(Boolean)
    .sort();
}

function sanitizeMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (["output", "stdout", "stderr", "tool_response", "toolResponse"].includes(key)) {
      metadata[`${key}Hash`] = stableStringHash(String(value ?? ""));
      continue;
    }
    metadata[key] = sanitizeValue(value);
  }
  return metadata;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isRecord(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (["output", "stdout", "stderr", "content", "text"].includes(key)) {
      sanitized[`${key}Hash`] = stableStringHash(String(entry ?? ""));
    } else {
      sanitized[key] = sanitizeValue(entry);
    }
  }
  return sanitized;
}

function stableStringHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
