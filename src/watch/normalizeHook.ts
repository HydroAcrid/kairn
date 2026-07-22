// SPDX-License-Identifier: Apache-2.0

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
  const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
  const command =
    stringValue(payload.command) ??
    commandFromToolInput(toolInput) ??
    commandFromToolResponse(toolResponse) ??
    commandFromToolCalls(toolCalls);
  const output =
    joinOutputValues([
      payload.output,
      payload.stdout,
      payload.stderr,
      payload.error
    ]) ??
    outputFromToolResponse(toolResponse) ??
    outputFromToolCalls(toolCalls) ??
    stringValue(payload.prompt) ??
    stringValue(payload.last_assistant_message);
  const exitCode =
    numberValue(payload.exitCode) ??
    numberValue(payload.exit_code) ??
    exitCodeFromToolResponse(toolResponse) ??
    exitCodeFromToolCalls(toolCalls);
  const files = normalizeFiles([
    ...arrayValue(payload.files),
    payload.file_path,
    fileFromToolInput(toolInput),
    fileFromToolResponse(toolResponse),
    ...filesFromToolCalls(toolCalls)
  ]);
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

  if (input.source === "codex" && input.eventName === "Stop") {
    return JSON.stringify({ systemMessage: input.content }, null, 2);
  }

  if (!supportsAdditionalContext(input.source, input.eventName)) {
    return "";
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

function supportsAdditionalContext(source: WatchEventSource, eventName: string): boolean {
  const supportedByCodex = new Set(["SessionStart", "PostToolUse", "UserPromptSubmit"]);
  const supportedByClaude = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "PermissionDenied",
    "Stop",
    "SubagentStop",
    "ConfigChange",
    "PreCompact"
  ]);

  if (source === "codex") return supportedByCodex.has(eventName);
  if (source === "claude") return supportedByClaude.has(eventName);
  return false;
}

function kindFor(input: {
  eventName: string;
  toolName?: string | undefined;
  command?: string | undefined;
  exitCode?: number | undefined;
  output?: string | undefined;
}): WatchEventKind {
  const event = input.eventName.toLowerCase();
  if (event === "filechanged") return "file_change";
  if (event.includes("failure")) return "failure";
  if (event.includes("session") || event === "stop") return "session";
  if (input.command) return input.exitCode && input.exitCode !== 0 ? "failure" : "command";
  if (input.output && input.exitCode && input.exitCode !== 0) return "failure";
  if (input.toolName) return "tool";
  return "hook";
}

function commandFromToolInput(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (!isRecord(value)) return undefined;
  return stringValue(value.command) ?? stringValue(value.cmd) ?? stringValue(value.shell_command);
}

function commandFromToolResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringValue(value.command);
}

function outputFromToolResponse(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return joinOutputValues([
    value.output,
    value.stdout,
    value.stderr,
    value.text,
    value.content,
    outputFromContentBlocks(value.content)
  ]);
}

function exitCodeFromToolResponse(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return numberValue(value.exitCode) ?? numberValue(value.exit_code) ?? numberValue(value.status);
}

function commandFromToolCalls(value: unknown[]): string | undefined {
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const command = commandFromToolInput(entry.tool_input ?? entry.toolInput);
    if (command) return command;
  }
  return undefined;
}

function outputFromToolCalls(value: unknown[]): string | undefined {
  const output = value
    .map((entry) => {
      if (!isRecord(entry)) return undefined;
      return outputFromToolResponse(entry.tool_response ?? entry.toolResponse);
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return output || undefined;
}

function exitCodeFromToolCalls(value: unknown[]): number | undefined {
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const exitCode = exitCodeFromToolResponse(entry.tool_response ?? entry.toolResponse);
    if (exitCode !== undefined) return exitCode;
  }
  return undefined;
}

function fileFromToolInput(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringValue(value.file_path) ?? stringValue(value.filePath) ?? stringValue(value.path);
}

function fileFromToolResponse(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringValue(value.file_path) ?? stringValue(value.filePath) ?? stringValue(value.path);
}

function filesFromToolCalls(value: unknown[]): string[] {
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return [fileFromToolInput(entry.tool_input ?? entry.toolInput), fileFromToolResponse(entry.tool_response ?? entry.toolResponse)].filter(
      (file): file is string => Boolean(file)
    );
  });
}

function outputFromContentBlocks(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!isRecord(entry)) return undefined;
      return stringValue(entry.text) ?? stringValue(entry.content);
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return text || undefined;
}

function normalizeFiles(value: unknown[]): string[] {
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => normalizeRelativePath(entry).replace(/^\.\//, ""))
        .filter(Boolean)
    )
  ].sort();
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sanitizeMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (isOutputBearingScalar(key, value)) {
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
    if (isOutputBearingScalar(key, entry)) {
      sanitized[`${key}Hash`] = stableStringHash(String(entry ?? ""));
    } else {
      sanitized[key] = sanitizeValue(entry);
    }
  }
  return sanitized;
}

function joinOutputValues(values: unknown[]): string | undefined {
  const text = values
    .map((value) => {
      if (Array.isArray(value)) return outputFromContentBlocks(value);
      return stringValue(value);
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
  return text || undefined;
}

function isOutputBearingScalar(key: string, value: unknown): boolean {
  if (isRecord(value) || Array.isArray(value)) return false;
  return [
    "output",
    "stdout",
    "stderr",
    "content",
    "text",
    "error",
    "last_assistant_message",
    "tool_response",
    "toolResponse"
  ].includes(key);
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
