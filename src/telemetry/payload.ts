// SPDX-License-Identifier: Apache-2.0

import type { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { MetricsSummary, TelemetryPayload } from "../types.js";
import {
  assertSafeTelemetryPayload,
  repoFileCountBucket,
  stateSizeBucket,
  summarizeFileSignals,
  summarizeLanguageMix
} from "./sanitize.js";
import { KAIRN_VERSION } from "../version.js";

export function buildTelemetryPayload(input: {
  runtime: KairnRuntime;
  installationId: string;
  repoSalt: string;
  sessionId?: string | undefined;
}): TelemetryPayload {
  const sessions = input.sessionId
    ? [input.runtime.getSession(input.sessionId)]
    : input.runtime.listSessions({ allRoots: false, limit: 25 });
  const metrics = sessions.map((session) => input.runtime.getMetrics(session.id));
  const impact = input.runtime.getImpactStats(input.sessionId);
  const index = input.runtime.getIndexStatus();
  const fileSignals = summarizeFileSignals({ repoSalt: input.repoSalt, sessions, metrics });
  const payload: TelemetryPayload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    installationId: input.installationId,
    kairnVersion: KAIRN_VERSION,
    repo: {
      fileCountBucket: repoFileCountBucket(index.fileCount),
      stateSizeBucket: stateSizeBucket(index.totalSizeBytes),
      languageMix: mergeRecords(metrics.map(summarizeLanguageMix)),
      extensionCounts: fileSignals.extensionCounts,
      roleCounts: fileSignals.roleCounts
    },
    sessions: {
      count: input.runtime.listSessions({ allRoots: false }).length,
      sampled: sessions.length
    },
    decisions: countDecisions(metrics),
    governor: summarizeGovernor(metrics),
    assistance: countAssistance(metrics),
    tokens: summarizeTokens(metrics),
    impact,
    hooks: summarizeHooks(metrics),
    mcp: summarizeMcp(metrics),
    ledger: summarizeLedger(metrics),
    quality: summarizeQuality(metrics),
    scope: summarizeScope(metrics),
    fileSignals: {
      hashedFileIds: fileSignals.hashedFileIds
    }
  };
  assertSafeTelemetryPayload(payload);
  return payload;
}

function countDecisions(metrics: MetricsSummary[]): TelemetryPayload["decisions"] {
  return metrics.reduce<TelemetryPayload["decisions"]>((totals, item) => ({
    emit: totals.emit + item.decisions.emit,
    shrink: totals.shrink + item.decisions.shrink,
    suppress: totals.suppress + item.decisions.suppress,
    requestEvidence: totals.requestEvidence + item.decisions.requestEvidence
  }), { emit: 0, shrink: 0, suppress: 0, requestEvidence: 0 });
}

function summarizeGovernor(metrics: MetricsSummary[]): TelemetryPayload["governor"] {
  const taskFrames = new Map<string, number>();
  const fileRoles = new Map<string, number>();
  const pUseful: number[] = [];
  const pHarm: number[] = [];
  const pNeedMoreEvidence: number[] = [];
  let requestEvidence = 0;
  for (const item of metrics) {
    for (const event of item.recentEvents) {
      const decision = event.metadata.contextDecision;
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) continue;
      const record = decision as Record<string, unknown>;
      if (record.action === "request_evidence") requestEvidence += 1;
      if (typeof record.taskFrame === "string") {
        taskFrames.set(record.taskFrame, (taskFrames.get(record.taskFrame) ?? 0) + 1);
      }
      const featureSummary = record.featureSummary;
      if (featureSummary && typeof featureSummary === "object" && !Array.isArray(featureSummary)) {
        const roleCounts = (featureSummary as Record<string, unknown>).fileRoleCounts;
        if (roleCounts && typeof roleCounts === "object" && !Array.isArray(roleCounts)) {
          for (const [role, value] of Object.entries(roleCounts)) {
            if (typeof value === "number") fileRoles.set(role, (fileRoles.get(role) ?? 0) + value);
          }
        }
      }
      const prediction = record.modelPrediction;
      if (prediction && typeof prediction === "object" && !Array.isArray(prediction)) {
        const p = prediction as Record<string, unknown>;
        if (typeof p.pUseful === "number") pUseful.push(p.pUseful);
        if (typeof p.pHarm === "number") pHarm.push(p.pHarm);
        if (typeof p.pNeedMoreEvidence === "number") pNeedMoreEvidence.push(p.pNeedMoreEvidence);
      }
    }
  }
  return {
    requestEvidence,
    taskFrames: Object.fromEntries([...taskFrames.entries()].sort()),
    fileRoles: Object.fromEntries([...fileRoles.entries()].sort()),
    ...(pUseful.length > 0 ? { averagePUseful: averageProbability(pUseful) } : {}),
    ...(pHarm.length > 0 ? { averagePHarm: averageProbability(pHarm) } : {}),
    ...(pNeedMoreEvidence.length > 0 ? { averagePNeedMoreEvidence: averageProbability(pNeedMoreEvidence) } : {})
  };
}

function countAssistance(metrics: MetricsSummary[]): TelemetryPayload["assistance"] {
  const output = {
    active: 0,
    passiveSuppressed: 0,
    none: 0,
    validAssist: 0,
    overAssist: 0,
    missedOpportunity: 0,
    harmfulAssist: 0
  };
  for (const item of metrics) {
    const hookEvents = item.byKind.hook_signal?.events ?? 0;
    const mcpEvents = item.byKind.mcp_tool_call?.events ?? 0;
    const failureEvents = item.byKind.failure_context?.events ?? 0;
    if (hookEvents > 0 || mcpEvents > 0 || failureEvents > 0) output.active += 1;
    else output.none += 1;
    output.validAssist += item.assistance.valid;
    output.overAssist += item.assistance.overAssist;
    output.missedOpportunity += item.assistance.missedOpportunity;
    output.harmfulAssist += item.assistance.harmful;
  }
  return output;
}

function summarizeTokens(metrics: MetricsSummary[]): TelemetryPayload["tokens"] {
  const estimatedBaseline = metrics.reduce((total, item) => total + item.totals.baselineTokens, 0);
  const estimatedOutput = metrics.reduce((total, item) => total + item.totals.outputTokens, 0);
  const estimatedSaved = metrics.reduce((total, item) => total + item.totals.savedTokens, 0);
  const activeEstimatedSaved = metrics.reduce((total, item) => {
    const active = hasActiveAssistance(item);
    return total + (active && item.totals.savedTokens > 0 ? item.totals.savedTokens : 0);
  }, 0);
  const passiveEstimatedSaved = metrics.reduce((total, item) => {
    const active = hasActiveAssistance(item);
    return total + (!active && item.totals.savedTokens > 0 ? item.totals.savedTokens : 0);
  }, 0);
  const observed = metrics
    .map((item) => item.observed.latestCodexUsage?.totalTokens)
    .filter((value): value is number => typeof value === "number");
  return {
    estimatedBaseline,
    estimatedOutput,
    estimatedSaved,
    activeEstimatedSaved,
    passiveEstimatedSaved,
    ...(observed.length > 0 ? { observedTotal: observed.reduce((sum, value) => sum + value, 0) } : {})
  };
}

function hasActiveAssistance(item: MetricsSummary): boolean {
  return (item.byKind.hook_signal?.events ?? 0) > 0 ||
    (item.byKind.mcp_tool_call?.events ?? 0) > 0 ||
    (item.byKind.failure_context?.events ?? 0) > 0;
}

function summarizeHooks(metrics: MetricsSummary[]): TelemetryPayload["hooks"] {
  const hookEvents = metrics.flatMap((item) => item.recentEvents.filter((event) => event.eventKind === "hook_signal"));
  const latencies = hookEvents
    .map((event) => event.metadata.hookLatencyMs)
    .filter((value): value is number => typeof value === "number");
  return {
    invocations: metrics.reduce((total, item) => total + item.delivery.hooks.invocations, 0),
    failures: metrics.reduce((total, item) => total + item.delivery.hooks.failures, 0),
    daemonHits: hookEvents.filter((event) => event.metadata.daemonHit === true).length,
    daemonMisses: hookEvents.filter((event) => event.metadata.daemonMiss === true).length,
    ...(latencies.length > 0 ? { averageLatencyMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) } : {})
  };
}

function summarizeMcp(metrics: MetricsSummary[]): TelemetryPayload["mcp"] {
  return {
    calls: metrics.reduce((total, item) => total + item.delivery.mcp.calls, 0),
    returnedSourceFiles: metrics.reduce((total, item) => total + item.delivery.mcp.returnedSourceFiles, 0),
    returnedTestFiles: metrics.reduce((total, item) => total + item.delivery.mcp.returnedTestFiles, 0),
    returnedNoiseFiles: metrics.reduce((total, item) => total + item.delivery.mcp.returnedNoiseFiles, 0)
  };
}

function summarizeLedger(metrics: MetricsSummary[]): TelemetryPayload["ledger"] {
  return {
    events: metrics.reduce((total, item) => total + item.ledger.events, 0),
    repeatedFilesAvoided: metrics.reduce((total, item) => total + item.ledger.repeatedFilesAvoided, 0),
    repeatedSnippetsAvoided: metrics.reduce((total, item) => total + item.ledger.repeatedSnippetsAvoided, 0),
    unresolvedFailures: metrics.reduce((total, item) => total + item.ledger.unresolvedFailures, 0)
  };
}

function summarizeQuality(metrics: MetricsSummary[]): TelemetryPayload["quality"] {
  const events = metrics.flatMap((item) => item.recentEvents);
  return {
    benchmarkPasses: events.filter((event) => event.metadata.qualityGatePassed === true).length,
    benchmarkFailures: events.filter((event) => event.metadata.qualityGatePassed === false).length
  };
}

function summarizeScope(metrics: MetricsSummary[]): TelemetryPayload["scope"] {
  const events = metrics.flatMap((item) => item.recentEvents);
  return {
    decisions: events.filter((event) => typeof event.metadata.editScope === "object" && event.metadata.editScope !== null).length,
    violations: events.reduce((total, event) => total + arrayMetadata(event.metadata.scopeViolations).length, 0),
    failedDiscipline: events.filter((event) => event.metadata.sourceScopeDiscipline === "failed").length,
    testEdits: events.reduce((total, event) => total + arrayMetadata(event.metadata.testsEdited).length, 0),
    expansions: events.filter((event) => event.metadata.scopeExpanded === true).length
  };
}

function mergeRecords(records: Array<Record<string, number>>): Record<string, number> {
  const merged = new Map<string, number>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      merged.set(key, (merged.get(key) ?? 0) + value);
    }
  }
  return Object.fromEntries([...merged.entries()].sort());
}


function arrayMetadata(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function averageProbability(values: number[]): number {
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}
