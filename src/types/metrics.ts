import type { ContextResponseMode } from "./context.js";
import type { CodexUsageRecord } from "./eval.js";
import type { WatchEventSource } from "./watch.js";

export type MetricsEventKind =
  | "find_context"
  | "read_file"
  | "read_symbol"
  | "related"
  | "tests"
  | "diff"
  | "failure_context"
  | "compression"
  | "hook_signal"
  | "prime_context"
  | "prime_quality"
  | "context_value_decision"
  | "mcp_tool_call";

export type MetricsEventRecord = {
  id?: number;
  sessionId: string;
  rootPath: string;
  eventKind: MetricsEventKind;
  eventName: string;
  source: WatchEventSource | "runtime" | "cli" | "mcp";
  responseMode?: ContextResponseMode;
  baselineTokens: number;
  outputTokens: number;
  savedTokens: number;
  files: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type MetricsBucket = {
  events: number;
  baselineTokens: number;
  outputTokens: number;
  savedTokens: number;
};

export type MetricsSummary = {
  sessionId: string;
  rootPath: string;
  totals: MetricsBucket & {
    savingsRate: number;
  };
  byKind: Record<string, MetricsBucket>;
  bySource: Record<string, MetricsBucket>;
  watch: {
    events: number;
    failures: number;
    fileChanges: number;
    hooks: number;
  };
  observed: {
    evalRuns: number;
    observations: number;
    latestCodexUsage?: CodexUsageRecord;
  };
  coordination: {
    duplicateContextAvoided: number;
    hookFiles: string[];
    mcpFiles: string[];
    overlapFiles: string[];
  };
  recentEvents: MetricsEventRecord[];
};
