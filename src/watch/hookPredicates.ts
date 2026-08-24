// SPDX-License-Identifier: Apache-2.0

import type { NormalizedHookEvent, WatchEventKind } from "../types.js";
import { estimateTokens } from "../utils/tokens.js";

export function isPromptEvent(eventName: string): boolean {
  return eventName.toLowerCase() === "userpromptsubmit";
}

export function hostSessionIdForEvent(event: NormalizedHookEvent): string | undefined {
  return event.hostSessionId
    ?? stringMetadata(event.metadata, "session_id")
    ?? stringMetadata(event.metadata, "hostSessionId")
    ?? stringMetadata(event.metadata, "turn_id");
}

export function hostSessionMetadata(event: NormalizedHookEvent): Record<string, unknown> {
  return {
    eventName: event.eventName,
    ...(event.hostSessionId ? { hostSessionId: event.hostSessionId } : {}),
    ...(stringMetadata(event.metadata, "turn_id") ? { turnId: stringMetadata(event.metadata, "turn_id") } : {}),
    ...(stringMetadata(event.metadata, "model") ? { model: stringMetadata(event.metadata, "model") } : {})
  };
}

export function taskFromHookEvent(event: NormalizedHookEvent): string {
  if (isPromptEvent(event.eventName) && event.output?.trim()) {
    return truncateText(event.output.trim(), 240);
  }
  if (event.command) {
    return `Observed ${event.source} command: ${truncateText(event.command, 180)}`;
  }
  return `Observed ${event.source} ${event.eventName} hook session`;
}

export function isHighConfidencePrompt(eventName: string, prompt: string | undefined): boolean {
  if (!isPromptEvent(eventName) || !prompt) return false;
  const normalized = prompt.toLowerCase();
  if (normalized.startsWith("run ")) return false;
  return /\b(fix|identify|find|implement|update|refactor|debug|diagnose|investigate|audit|trace|error|failing|component|api|layout|parser|mobile|review|queue|sync|gmail|test|hook|metrics|eval)\b/.test(normalized);
}

export function isTrivialSuccessfulHook(input: {
  eventKind: WatchEventKind;
  command?: string | undefined;
  output?: string | undefined;
  linkedFiles: string[];
  exitCode?: number | undefined;
}): boolean {
  if (!input.output || input.eventKind === "failure" || input.linkedFiles.length > 0) return false;
  if (input.exitCode !== undefined && input.exitCode !== 0) return false;
  const lineCount = input.output.split(/\r?\n/).filter((line) => line.trim()).length;
  const outputTokens = estimateTokens(input.output);
  const command = input.command?.trim().toLowerCase() ?? "";
  if (["pwd", "git status", "git branch", "npm pkg get scripts", "pnpm pkg get scripts"].includes(command)) return true;
  return lineCount <= 12 && outputTokens <= 80 && !/\b(error|fail|failed|exception|traceback|ts\d{4})\b/i.test(input.output);
}

export function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}
