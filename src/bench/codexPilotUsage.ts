// SPDX-License-Identifier: Apache-2.0

import type { CodexPilotUsage } from "../types.js";

export type TimedCodexEvent = {
  turn: number;
  receivedMs: number;
  raw: string;
  value?: unknown;
};

export function parseCodexJsonl(input: string, turn: number, startedMs = 0): TimedCodexEvent[] {
  return input.split(/\r?\n/).flatMap((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return [{ turn, receivedMs: startedMs + index, raw: trimmed, value: JSON.parse(trimmed) as unknown }];
    } catch {
      return [{ turn, receivedMs: startedMs + index, raw: trimmed }];
    }
  });
}

export function observedCodexUsage(events: TimedCodexEvent[]): CodexPilotUsage {
  const byTurn = new Map<number, CodexPilotUsage>();
  for (const event of events) {
    const usage = completedTurnUsage(event.value);
    if (usage) byTurn.set(event.turn, usage);
  }
  return [...byTurn.values()].reduce(addUsage, emptyUsage());
}

export function observedCodexUsageByTurn(events: TimedCodexEvent[]): Map<number, CodexPilotUsage> {
  const output = new Map<number, CodexPilotUsage>();
  for (const event of events) {
    const usage = completedTurnUsage(event.value);
    if (usage) output.set(event.turn, usage);
  }
  return output;
}

export function codexThreadId(events: TimedCodexEvent[]): string | undefined {
  for (const event of events) {
    if (!isRecord(event.value)) continue;
    if (event.value.type !== "thread.started" && event.value.type !== "thread.created") continue;
    const id = stringValue(event.value.thread_id) ?? stringValue(event.value.threadId) ?? stringValue(event.value.id);
    if (id) return id;
  }
  return undefined;
}

export function transcriptFirstMention(input: {
  events: TimedCodexEvent[];
  paths: string[];
}): TimedCodexEvent | undefined {
  const normalized = input.paths.map(normalizePath);
  return input.events.find((event) => normalized.some((candidate) => normalizePath(event.raw).includes(candidate)));
}

function completedTurnUsage(value: unknown): CodexPilotUsage | undefined {
  if (!isRecord(value) || value.type !== "turn.completed") return undefined;
  const usage = isRecord(value.usage) ? value.usage : undefined;
  if (!usage) return undefined;
  const inputTokens = tokenNumber(usage.input_tokens, usage.inputTokens);
  const cachedInputTokens = tokenNumber(usage.cached_input_tokens, usage.cachedInputTokens);
  const outputTokens = tokenNumber(usage.output_tokens, usage.outputTokens);
  const reasoningTokens = tokenNumber(
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.reasoning_output_tokens,
    usage.reasoningOutputTokens
  );
  const totalTokens = tokenNumber(usage.total_tokens, usage.totalTokens) || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

function addUsage(left: CodexPilotUsage, right: CodexPilotUsage): CodexPilotUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
}

export function emptyUsage(): CodexPilotUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function tokenNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
