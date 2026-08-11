// SPDX-License-Identifier: Apache-2.0

import type { MetricsBucket, MetricsEventKind, MetricsSummary } from "../types.js";
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

export function summarizeContextDecisions(
  events: Array<{ metadata: Record<string, unknown> }>
): MetricsSummary["decisions"] {
  const decisions: MetricsSummary["decisions"] = { emit: 0, shrink: 0, suppress: 0, requestEvidence: 0 };
  for (const event of events) {
    const nested = nestedObject(event.metadata.contextDecision);
    const decision = event.metadata.decision ?? nested?.action;
    if (decision === "emit") decisions.emit += 1;
    else if (decision === "shrink") decisions.shrink += 1;
    else if (decision === "suppress" || event.metadata.primeSuppressed === true) decisions.suppress += 1;
    else if (decision === "request_evidence") decisions.requestEvidence += 1;
  }
  return decisions;
}

export function summarizeAssistanceClassifications(
  events: Array<{ metadata: Record<string, unknown> }>
): MetricsSummary["assistance"] {
  const assistance: MetricsSummary["assistance"] = { valid: 0, overAssist: 0, missedOpportunity: 0, harmful: 0 };
  for (const event of events) {
    const classification = event.metadata.assistClassification;
    if (classification === "valid_assist" || classification === "quality_rescue") assistance.valid += 1;
    if (classification === "over_assist") assistance.overAssist += 1;
    if (classification === "missed_savings_opportunity" || classification === "missed_quality_opportunity") {
      assistance.missedOpportunity += 1;
    }
    if (classification === "harmful_invalid_assist") assistance.harmful += 1;
  }
  return assistance;
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
