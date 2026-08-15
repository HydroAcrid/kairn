import type {
  ContextResponseMode,
  ImpactStats,
  MetricsEventKind,
  MetricsSummary,
  WatchEventSource
} from "../../types.js";
import {
  attributedFilesFromMcpValue,
  filesFromMcpValue,
  responseModeFromMcpValue,
  sessionIdFromMcpValue,
  tokenEstimateFromMcpValue
} from "../../mcp/resultExtractors.js";
import { loadIndexingConfig } from "../../config/indexing.js";
import { buildImpactStats } from "../../metrics/impact.js";
import {
  groupMetrics,
  summarizeAssistanceClassifications,
  summarizeCompressionMetrics,
  summarizeContextDecisions,
  summarizeCoordinationMetrics,
  summarizeEvidenceRoutingShadow,
  summarizeMetrics
} from "../../metrics/summary.js";
import { codexUsageFromObservation } from "../../eval/usageObservation.js";
import { summarizeSessionLedger } from "../../ledger/summary.js";
import { uniquePaths } from "../../utils/collections.js";
import type { RuntimeDeps } from "../deps.js";

export class MetricsService {
  constructor(private readonly deps: RuntimeDeps) {}

  getMetrics(sessionId: string): MetricsSummary {
    const session = this.deps.store.getSession(sessionId);
    const events = this.deps.store.listMetricsEvents(sessionId);
    const watchEvents = this.deps.store.listWatchEvents(sessionId);
    const evalRuns = this.deps.store.listEvalRuns({ sessionId });
    const observations = this.deps.store.listEvalObservations({ sessionId });
    const latestCodexUsage = [...observations].reverse().find((event) => event.kind === "codex_usage");
    const latestCodexUsageRecord = codexUsageFromObservation(latestCodexUsage);
    const realizedEvents = events.filter((event) => event.eventKind !== "evidence_routing_shadow");
    const totals = summarizeMetrics(realizedEvents);
    const coordination = summarizeCoordinationMetrics(realizedEvents);
    const decisions = summarizeContextDecisions(realizedEvents);
    const assistance = summarizeAssistanceClassifications(realizedEvents);
    const hookEvents = realizedEvents.filter((event) => event.eventKind === "hook_signal");
    const mcpEvents = realizedEvents.filter((event) => event.eventKind === "mcp_tool_call");
    const files = this.deps.store.listFiles(session.rootPath);
    const indexStats = this.deps.store.getIndexStateStats(session.rootPath, loadIndexingConfig(session.rootPath));
    const ledger = summarizeSessionLedger(sessionId, this.deps.store.listSessionLedgerEvents(sessionId));

    return {
      sessionId,
      rootPath: session.rootPath,
      totals: {
        ...totals,
        savingsRate: totals.baselineTokens > 0 ? totals.savedTokens / totals.baselineTokens : 0
      },
      byKind: groupMetrics(events, (event) => event.eventKind),
      bySource: groupMetrics(realizedEvents, (event) => event.source),
      compression: summarizeCompressionMetrics(realizedEvents),
      evidenceRoutingShadow: summarizeEvidenceRoutingShadow(events),
      watch: {
        events: watchEvents.length,
        failures: watchEvents.filter((event) => event.kind === "failure").length,
        fileChanges: watchEvents.filter((event) => event.kind === "file_change" || event.kind === "diff_change").length,
        hooks: watchEvents.filter((event) => event.source === "claude" || event.source === "codex" || event.source === "generic").length
      },
      observed: {
        evalRuns: evalRuns.length,
        observations: observations.length,
        ...(latestCodexUsageRecord ? { latestCodexUsage: latestCodexUsageRecord } : {})
      },
      coordination,
      decisions,
      assistance,
      quality: {
        verificationPasses: ledger.verificationPasses,
        verificationFailures: ledger.verificationFailures,
        latestVerification: ledger.latestVerification
      },
      recommendations: {
        made: ledger.recommendedFiles.length,
        laterUsed: ledger.recommendedFilesLaterUsed.length,
        laterTouched: ledger.recommendedFilesLaterTouched.length
      },
      delivery: {
        hooks: {
          invocations: hookEvents.length,
          failures: hookEvents.filter((event) => event.eventName.toLowerCase().includes("fail")).length,
          suppressed: hookEvents.filter((event) => event.metadata.primeSuppressed === true).length
        },
        mcp: {
          calls: mcpEvents.length,
          returnedSourceFiles: sumEventMetadata(mcpEvents, "resultSourceFileCount"),
          returnedTestFiles: sumEventMetadata(mcpEvents, "resultTestFileCount"),
          returnedNoiseFiles: sumEventMetadata(mcpEvents, "resultNoiseFileCount")
        }
      },
      index: {
        files: files.length,
        tiers: indexStats.tiers,
        dbSizeBytes: indexStats.dbSizeBytes,
        walSizeBytes: indexStats.walSizeBytes,
        totalSizeBytes: indexStats.totalSizeBytes,
        symbols: indexStats.symbolCount,
        graphEdges: indexStats.graphEdgeCount,
        semanticChunks: indexStats.semanticChunkCount
      },
      ledger: {
        events: ledger.events,
        repeatedFilesAvoided: ledger.repeatedFilesAvoided,
        repeatedSnippetsAvoided: ledger.repeatedSnippetsAvoided,
        recommendedFilesUsed: ledger.recommendedFilesUsed,
        repeatedlyTouchedFiles: ledger.repeatedlyTouchedFiles,
        unresolvedFailures: ledger.unresolvedFailures,
        currentPhase: ledger.currentPhase,
        workingSet: {
          activeFiles: ledger.workingSet.activeFiles,
          ignoredRecommendedFiles: ledger.workingSet.ignoredRecommendedFiles,
          staleFiles: ledger.workingSet.staleFiles,
          ...(ledger.workingSet.nextSmallestUsefulRead ? { nextSmallestUsefulRead: ledger.workingSet.nextSmallestUsefulRead.filePath } : {}),
          openRisks: ledger.workingSet.openRisks
        }
      },
      recentEvents: realizedEvents.slice(-10)
    };
  }

  getImpactStats(sessionId?: string | undefined): ImpactStats {
    const sessions = sessionId
      ? [this.deps.store.getSession(sessionId)]
      : this.deps.store.listSessions({ rootPath: this.deps.rootPath });
    const metrics = sessions.map((session) => this.getMetrics(session.id));
    const events = sessionId
      ? this.deps.store.listMetricsEvents(sessionId)
      : this.deps.store.listMetricsEventsForRoot(this.deps.rootPath);
    return buildImpactStats({
      metrics,
      events: events.filter((event) => event.eventKind !== "evidence_routing_shadow")
    });
  }

  getCoordinationState(sessionId: string): MetricsSummary["coordination"] {
    this.deps.store.getSession(sessionId);
    return summarizeCoordinationMetrics(this.deps.store.listMetricsEvents(sessionId));
  }

  recordMcpToolCall(input: {
    toolName: string;
    input?: unknown;
    result?: unknown;
    sessionId?: string | undefined;
  }): void {
    const sessionId = input.sessionId ?? sessionIdFromMcpValue(input.result) ?? sessionIdFromMcpValue(input.input);
    if (!sessionId) {
      return;
    }

    try {
      this.deps.store.getSession(sessionId);
    } catch {
      return;
    }

    const resultFiles = uniquePaths(filesFromMcpValue(input.result));
    const inputFiles = uniquePaths(filesFromMcpValue(input.input));
    const files = resultFiles;
    const attributedFiles = attributedFilesFromMcpValue(input.result);
    const returnedSourceFiles = files.filter(isLikelySourceFileForMetrics);
    const returnedNoiseFiles = files.filter(isLikelyNoiseFileForMetrics);
    const returnedTestFiles = files.filter(isLikelyTestFileForMetrics);
    const coordination = this.getCoordinationState(sessionId);
    const overlapFiles = files.filter((file) => coordination.hookFiles.includes(file));
    const contextDecision = contextDecisionFromMcpValue(input.result);

    this.recordMetricsEvent({
      sessionId,
      eventKind: "mcp_tool_call",
      eventName: input.toolName,
      source: "mcp",
      responseMode: responseModeFromMcpValue(input.result),
      baselineTokens: 0,
      outputTokens: tokenEstimateFromMcpValue(input.result),
      savedTokens: 0,
      files,
      metadata: {
        toolName: input.toolName,
        resultFileCount: files.length,
        attributedFileCount: attributedFiles.length,
        inputFileCount: inputFiles.length,
        resultSourceFileCount: returnedSourceFiles.length,
        resultNoiseFileCount: returnedNoiseFiles.length,
        resultTestFileCount: returnedTestFiles.length,
        tokenEstimate: tokenEstimateFromMcpValue(input.result),
        resultMode: responseModeFromMcpValue(input.result),
        hookFiles: coordination.hookFiles,
        mcpFiles: files,
        inputFiles,
        overlapFiles,
        duplicateContextAvoided: Math.max(0, coordination.hookFiles.length - overlapFiles.length),
        ...(contextDecision ? { contextDecision } : {})
      }
    });
  }

  recordMetricsEvent(input: {
    sessionId: string;
    eventKind: MetricsEventKind;
    eventName: string;
    source: WatchEventSource | "runtime" | "cli" | "mcp" | "bench";
    responseMode?: ContextResponseMode | undefined;
    baselineTokens: number;
    outputTokens: number;
    savedTokens: number;
    files: string[];
    metadata?: Record<string, unknown> | undefined;
  }): void {
    const record = {
      rootPath: this.deps.rootPath,
      sessionId: input.sessionId,
      eventKind: input.eventKind,
      eventName: input.eventName,
      source: input.source,
      baselineTokens: input.baselineTokens,
      outputTokens: input.outputTokens,
      savedTokens: input.savedTokens,
      files: uniquePaths(input.files),
      metadata: input.metadata ?? {},
      ...(input.responseMode ? { responseMode: input.responseMode } : {})
    };

    this.deps.store.recordMetricsEvent({
      ...record
    });
  }
}

function sumEventMetadata(events: Array<{ metadata: Record<string, unknown> }>, key: string): number {
  return events.reduce((total, event) => {
    const value = event.metadata[key];
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function contextDecisionFromMcpValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).contextDecision;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function isLikelySourceFileForMetrics(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    !isLikelyNoiseFileForMetrics(normalized) &&
    !isLikelyTestFileForMetrics(normalized) &&
    /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(normalized)
  );
}

function isLikelyNoiseFileForMetrics(filePath: string): boolean {
  return /(^|\/)(docs?|examples?|devtools|codemods|generated|gen|dist|build|coverage|website|site|playground|testdata)\//i.test(filePath);
}

function isLikelyTestFileForMetrics(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename) ||
    /(^|\/)(tests?|testing)\//.test(normalized) ||
    /^test_.*\.pyi?$/.test(basename) ||
    /_test\.pyi?$/.test(basename) ||
    /_test\.go$/.test(basename) ||
    /(test|tests)\.java$/.test(basename) ||
    /(_test|_tests|_unittest)\.(cc|cpp|cxx|c|hh|hpp|hxx)$/.test(basename)
  );
}
