import type { ImpactStats, MetricsEventRecord, MetricsSummary } from "../types.js";

export function buildImpactStats(input: {
  metrics: MetricsSummary[];
  events: MetricsEventRecord[];
}): ImpactStats {
  const activeSessionIds = new Set(
    input.metrics
      .filter(hasActiveAssistance)
      .map((item) => item.sessionId)
  );
  const latencies = input.events
    .filter((event) => event.eventKind === "hook_signal")
    .map((event) => numberMetadata(event.metadata.hookLatencyMs))
    .filter((value): value is number => typeof value === "number");

  const estimatedActiveSavedTokens = input.events.reduce((total, event) => {
    return total + (activeSessionIds.has(event.sessionId) && event.savedTokens > 0 ? event.savedTokens : 0);
  }, 0);
  const estimatedPassiveSavedTokens = input.events.reduce((total, event) => {
    return total + (!activeSessionIds.has(event.sessionId) && event.savedTokens > 0 ? event.savedTokens : 0);
  }, 0);

  return {
    countersVersion: 1,
    estimatedBaselineTokens: input.events.reduce((total, event) => total + event.baselineTokens, 0),
    estimatedOutputTokens: input.events.reduce((total, event) => total + event.outputTokens, 0),
    estimatedActiveSavedTokens,
    estimatedPassiveSavedTokens,
    estimatedTotalSavedTokens: input.events.reduce((total, event) => total + event.savedTokens, 0),
    repeatedFilesAvoided: input.metrics.reduce((total, item) => total + item.ledger.repeatedFilesAvoided, 0),
    repeatedSnippetsAvoided: input.metrics.reduce((total, item) => total + item.ledger.repeatedSnippetsAvoided, 0),
    quietDecisions: input.events.filter(isQuietDecision).length,
    evidenceRequests: input.events.filter(isEvidenceRequest).length,
    usefulMcpCalls: input.events.filter(isUsefulMcpCall).length,
    hookInvocations: input.events.filter((event) => event.eventKind === "hook_signal").length,
    hookFailures: input.events.filter((event) => event.eventKind === "hook_signal" && event.eventName.toLowerCase().includes("fail")).length,
    scopeViolations: input.events.reduce((total, event) => total + arrayMetadata(event.metadata.scopeViolations).length, 0),
    overAssistEvents: input.events.filter((event) => event.metadata.assistClassification === "over_assist").length,
    missedOpportunityEvents: input.events.filter((event) =>
      event.metadata.assistClassification === "missed_savings_opportunity" ||
      event.metadata.assistClassification === "missed_quality_opportunity"
    ).length,
    harmfulAssistEvents: input.events.filter((event) => event.metadata.assistClassification === "harmful_invalid_assist").length,
    sessions: input.metrics.length,
    events: input.events.length,
    ...(latencies.length > 0 ? { averageHookLatencyMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) } : {})
  };
}

export function formatImpactStats(stats: ImpactStats): string {
  return [
    "Kairn impact stats.",
    `Sessions: ${stats.sessions}`,
    `Events measured: ${stats.events}`,
    `Estimated baseline context tokens: ${stats.estimatedBaselineTokens}`,
    `Estimated Kairn context tokens emitted: ${stats.estimatedOutputTokens}`,
    `Estimated context tokens avoided: ${stats.estimatedTotalSavedTokens}`,
    `- active: ${stats.estimatedActiveSavedTokens}`,
    `- passive/suppressed: ${stats.estimatedPassiveSavedTokens}`,
    "",
    "Context control",
    `- repeated files avoided: ${stats.repeatedFilesAvoided}`,
    `- repeated snippets avoided: ${stats.repeatedSnippetsAvoided}`,
    `- quiet decisions: ${stats.quietDecisions}`,
    `- evidence requests: ${stats.evidenceRequests}`,
    `- useful MCP calls: ${stats.usefulMcpCalls}`,
    "",
    "Reliability",
    `- hook invocations: ${stats.hookInvocations}`,
    `- hook failures: ${stats.hookFailures}`,
    `- average hook latency: ${typeof stats.averageHookLatencyMs === "number" ? `${stats.averageHookLatencyMs}ms` : "n/a"}`,
    `- scope violations: ${stats.scopeViolations}`,
    `- over-assist events: ${stats.overAssistEvents}`,
    `- missed-opportunity events: ${stats.missedOpportunityEvents}`,
    `- harmful-assist events: ${stats.harmfulAssistEvents}`,
    ""
  ].join("\n");
}

export function formatImpactReportMarkdown(stats: ImpactStats): string {
  return [
    "# Kairn Impact Stats",
    "",
    "This local report contains aggregate counters only. It excludes prompts, source, diffs, file paths, filenames, repo names, branch names, and raw command output.",
    "",
    "## Summary",
    "",
    `- Sessions: ${stats.sessions}`,
    `- Events measured: ${stats.events}`,
    `- Estimated context tokens avoided: ${stats.estimatedTotalSavedTokens}`,
    `- Estimated active tokens avoided: ${stats.estimatedActiveSavedTokens}`,
    `- Estimated passive/suppressed token delta: ${stats.estimatedPassiveSavedTokens}`,
    "",
    "## Context Control",
    "",
    `- Repeated files avoided: ${stats.repeatedFilesAvoided}`,
    `- Repeated snippets avoided: ${stats.repeatedSnippetsAvoided}`,
    `- Quiet decisions: ${stats.quietDecisions}`,
    `- Evidence requests: ${stats.evidenceRequests}`,
    `- Useful MCP calls: ${stats.usefulMcpCalls}`,
    "",
    "## Reliability",
    "",
    `- Hook invocations: ${stats.hookInvocations}`,
    `- Hook failures: ${stats.hookFailures}`,
    `- Average hook latency: ${typeof stats.averageHookLatencyMs === "number" ? `${stats.averageHookLatencyMs}ms` : "n/a"}`,
    `- Scope violations: ${stats.scopeViolations}`,
    `- Over-assist events: ${stats.overAssistEvents}`,
    `- Missed-opportunity events: ${stats.missedOpportunityEvents}`,
    `- Harmful-assist events: ${stats.harmfulAssistEvents}`,
    ""
  ].join("\n");
}

function hasActiveAssistance(item: MetricsSummary): boolean {
  return (item.byKind.hook_signal?.events ?? 0) > 0 ||
    (item.byKind.mcp_tool_call?.events ?? 0) > 0 ||
    (item.byKind.failure_context?.events ?? 0) > 0;
}

function isQuietDecision(event: MetricsEventRecord): boolean {
  return event.metadata.primeSuppressed === true ||
    event.metadata.decision === "suppress" ||
    contextAction(event.metadata.contextDecision) === "suppress";
}

function isEvidenceRequest(event: MetricsEventRecord): boolean {
  return event.metadata.decision === "request_evidence" ||
    contextAction(event.metadata.contextDecision) === "request_evidence";
}

function isUsefulMcpCall(event: MetricsEventRecord): boolean {
  return event.eventKind === "mcp_tool_call" && (
    (numberMetadata(event.metadata.resultSourceFileCount) ?? 0) > 0 ||
    event.metadata.resultMode === "shrink" ||
    event.metadata.resultMode === "emit"
  );
}

function contextAction(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = (value as Record<string, unknown>).action;
  return typeof action === "string" ? action : undefined;
}

function numberMetadata(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayMetadata(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
