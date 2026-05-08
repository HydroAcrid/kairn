import type {
  ContextResponseMode,
  MetricsEventKind,
  MetricsSummary,
  WatchEventSource
} from "../../types.js";
import {
  filesFromMcpValue,
  responseModeFromMcpValue,
  sessionIdFromMcpValue,
  tokenEstimateFromMcpValue
} from "../../mcp/resultExtractors.js";
import { loadIndexingConfig } from "../../config/indexing.js";
import { groupMetrics, summarizeCoordinationMetrics, summarizeMetrics } from "../../metrics/summary.js";
import { codexUsageFromObservation } from "../../eval/usageObservation.js";
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
    const totals = summarizeMetrics(events);
    const coordination = summarizeCoordinationMetrics(events);
    const files = this.deps.store.listFiles(session.rootPath);
    const indexStats = this.deps.store.getIndexStateStats(session.rootPath, loadIndexingConfig(session.rootPath));

    return {
      sessionId,
      rootPath: session.rootPath,
      totals: {
        ...totals,
        savingsRate: totals.baselineTokens > 0 ? totals.savedTokens / totals.baselineTokens : 0
      },
      byKind: groupMetrics(events, (event) => event.eventKind),
      bySource: groupMetrics(events, (event) => event.source),
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
      index: {
        files: files.length,
        tiers: indexStats.tiers,
        dbSizeBytes: indexStats.dbSizeBytes,
        walSizeBytes: indexStats.walSizeBytes,
        totalSizeBytes: indexStats.totalSizeBytes,
        graphEdges: indexStats.graphEdgeCount,
        semanticChunks: indexStats.semanticChunkCount
      },
      recentEvents: events.slice(-10)
    };
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

    const files = uniquePaths([
      ...filesFromMcpValue(input.result),
      ...filesFromMcpValue(input.input)
    ]);
    const coordination = this.getCoordinationState(sessionId);
    const overlapFiles = files.filter((file) => coordination.hookFiles.includes(file));

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
        resultMode: responseModeFromMcpValue(input.result),
        hookFiles: coordination.hookFiles,
        mcpFiles: files,
        overlapFiles,
        duplicateContextAvoided: Math.max(0, coordination.hookFiles.length - overlapFiles.length)
      }
    });
  }

  recordMetricsEvent(input: {
    sessionId: string;
    eventKind: MetricsEventKind;
    eventName: string;
    source: WatchEventSource | "runtime" | "cli" | "mcp";
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
