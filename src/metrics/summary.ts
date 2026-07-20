import type { CompressionMetricsSummary, MetricsBucket, MetricsEventKind, MetricsSummary } from "../types.js";
import { uniquePaths } from "../utils/collections.js";

export function summarizeMetrics(events: { baselineTokens: number; outputTokens: number; savedTokens: number }[]): MetricsBucket {
  return events.reduce<MetricsBucket>(
    (totals, event) => ({
      events: totals.events + 1,
      baselineTokens: totals.baselineTokens + event.baselineTokens,
      outputTokens: totals.outputTokens + event.outputTokens,
      savedTokens: totals.savedTokens + event.savedTokens
    }),
    emptyMetricsBucket()
  );
}

export function groupMetrics<T extends { baselineTokens: number; outputTokens: number; savedTokens: number }>(
  events: T[],
  keyFor: (event: T) => string
): Record<string, MetricsBucket> {
  const grouped: Record<string, MetricsBucket> = {};
  for (const event of events) {
    const key = keyFor(event);
    const current = grouped[key] ?? emptyMetricsBucket();
    grouped[key] = {
      events: current.events + 1,
      baselineTokens: current.baselineTokens + event.baselineTokens,
      outputTokens: current.outputTokens + event.outputTokens,
      savedTokens: current.savedTokens + event.savedTokens
    };
  }
  return grouped;
}

export function summarizeCompressionMetrics(
  events: Array<{
    eventKind: MetricsEventKind;
    baselineTokens: number;
    outputTokens: number;
    savedTokens: number;
    metadata: Record<string, unknown>;
  }>
): CompressionMetricsSummary {
  const summary: CompressionMetricsSummary = {
    attempts: 0,
    compressed: 0,
    skipped: 0,
    failedOpen: 0,
    beforeTokens: 0,
    afterTokens: 0,
    savedTokens: 0
  };

  for (const event of events) {
    if (event.eventKind !== "compression") continue;
    summary.attempts += 1;
    summary.beforeTokens += event.baselineTokens;
    summary.afterTokens += event.outputTokens;
    summary.savedTokens += event.savedTokens;
    const status = nestedObject(event.metadata.compression)?.status;
    if (status === "compressed") summary.compressed += 1;
    if (status === "skipped") summary.skipped += 1;
    if (status === "failed_open") summary.failedOpen += 1;
  }

  return summary;
}

export function summarizeCoordinationMetrics(
  events: Array<{ eventKind: MetricsEventKind; files: string[]; metadata: Record<string, unknown> }>
): MetricsSummary["coordination"] {
  const hookFiles = uniquePaths(
    events
      .filter((event) => event.metadata.coordinationMode === "mcp_hybrid" || event.metadata.hookOutput === "mcp-brief")
      .flatMap((event) => event.files)
  );
  const mcpFiles = uniquePaths(
    events
      .filter((event) => event.eventKind === "mcp_tool_call")
      .flatMap((event) => event.files)
  );
  const exactSourceFiles = uniquePaths(events.flatMap((event) => exactSourceFilesFromMetadata(event.metadata, event.files)));
  const overlapFiles = hookFiles.filter((file) => mcpFiles.includes(file));
  const recordedAvoided = events.reduce((total, event) => total + (numberField(event.metadata.duplicateContextAvoided) ?? 0), 0);

  return {
    duplicateContextAvoided: recordedAvoided + Math.max(0, hookFiles.length + mcpFiles.length - uniquePaths([...hookFiles, ...mcpFiles]).length),
    hookFiles,
    mcpFiles,
    overlapFiles,
    exactSourceFiles
  };
}

export function emptyMetricsBucket(): MetricsBucket {
  return {
    events: 0,
    baselineTokens: 0,
    outputTokens: 0,
    savedTokens: 0
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function exactSourceFilesFromMetadata(metadata: Record<string, unknown>, eventFiles: string[]): string[] {
  const direct = contextDecisionFile(metadata);
  const nested = contextDecisionFile(metadata.contextDecision);
  const qualityNested = contextDecisionFile(nestedObject(metadata.primeQuality)?.contextDecision);
  const primary = direct ?? nested ?? qualityNested;
  if (primary) return [primary];
  return booleanField(metadata.exactSourceHit) ? eventFiles.slice(0, 1) : [];
}

function contextDecisionFile(value: unknown): string | undefined {
  const record = nestedObject(value);
  if (!record || !booleanField(record.exactSourceHit)) return undefined;
  return typeof record.primaryFile === "string" ? record.primaryFile : undefined;
}

function nestedObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function booleanField(value: unknown): boolean {
  return value === true;
}
