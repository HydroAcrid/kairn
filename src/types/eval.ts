// SPDX-License-Identifier: Apache-2.0

import type { MetricsBucket, MetricsSummary } from "./metrics.js";

export type EvalRunMode = "baseline" | "kairn" | "manual";

export type EvalRunStatus = "active" | "completed" | "abandoned";

export type EvalObservationKind =
  | "codex_usage"
  | "hook_summary"
  | "command_summary"
  | "artifact"
  | "manual_outcome"
  | "hook_signal_stats"
  | "agent_file_usage"
  | "retrieval_feedback";

export type EvalRunRecord = {
  id: string;
  sessionId?: string;
  rootPath: string;
  task: string;
  label: string;
  mode: EvalRunMode;
  status: EvalRunStatus;
  startedAt: string;
  endedAt?: string;
  metadata: Record<string, unknown>;
};

export type EvalObservationRecord = {
  id?: number;
  runId: string;
  sessionId?: string;
  kind: EvalObservationKind;
  summary: string;
  metrics: Record<string, unknown>;
  files: string[];
  contentHash: string;
  createdAt: string;
};

export type CodexUsageRecord = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  model?: string;
  hostSessionId?: string;
  turnId?: string;
  transcriptPath?: string;
  transcriptHash?: string;
  source: "footer" | "transcript" | "footer+transcript";
};

export type EvalRunReport = {
  run: EvalRunRecord;
  observations: EvalObservationRecord[];
  codexUsage?: CodexUsageRecord;
  estimatedMetrics?: MetricsSummary;
  watch: {
    events: number;
    failures: number;
    fileChanges: number;
    hooks: number;
  };
};

export type EvalComparison = {
  baseline: EvalRunReport;
  kairn: EvalRunReport;
  observedTokenDelta?: {
    baselineTokens: number;
    kairnTokens: number;
    savedTokens: number;
    savingsRate: number;
  };
  estimatedKairnSavings: MetricsBucket & {
    savingsRate: number;
  };
  outcomeNotes: EvalObservationRecord[];
};
