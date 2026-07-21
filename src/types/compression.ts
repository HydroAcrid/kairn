import type { OutputKind } from "./context.js";

export type CompressionStatus = "compressed" | "skipped" | "failed_open";

export type CompressionReasonCode =
  | "compressed"
  | "empty_input"
  | "within_budget"
  | "source_like_input"
  | "candidate_not_smaller"
  | "insufficient_savings"
  | "anchor_budget_exceeded"
  | "candidate_budget_exceeded"
  | "anchor_validation_failed"
  | "internal_error";

export type EvidenceClass = "test" | "ci" | "lint" | "typecheck" | "stack_trace" | "generic";

export type CompressionAnchorCategory =
  | "path_location"
  | "test_identifier"
  | "error_code"
  | "exception_type"
  | "stack_frame"
  | "command_status";

export type CompressionMetadata = {
  schemaVersion: 1;
  status: CompressionStatus;
  reason: CompressionReasonCode;
  evidenceClass: EvidenceClass;
  budget: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsRate: number;
  inputHash: string;
  outputHash: string;
  anchors: {
    total: number;
    byCategory: Record<CompressionAnchorCategory, number>;
  };
  collapsedRepetitionCount: number;
  elapsedMs: number;
};

export type CompressionMetricsSummary = {
  attempts: number;
  compressed: number;
  skipped: number;
  failedOpen: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
};

export type EvidenceRoutingMode = "off" | "shadow";

export type EvidenceRoutingConfig = {
  mode: EvidenceRoutingMode;
};

export type EvidenceRoutingAction = "exact" | "compress" | "suppress" | "request_more";

export type EvidenceRoutingReasonCode =
  | "input_limit_exceeded"
  | "source_like_input"
  | "unsafe_compression"
  | "missing_repository_attribution"
  | "trivial_success"
  | "low_signal_output"
  | "safe_compression_candidate"
  | "existing_delivery_preferred";

export type EvidenceRoutingShadowReceipt = {
  schemaVersion: 1;
  mode: "shadow";
  action: EvidenceRoutingAction;
  reason: EvidenceRoutingReasonCode;
  outputKind: OutputKind;
  evidenceClass: EvidenceClass;
  budget: number;
  inputBytes: number;
  inputTokens: number;
  currentDeliveryTokens: number;
  candidateTokens: number;
  candidateVsInputSavedTokens: number;
  candidateVsInputSavingsRate: number;
  candidateVsCurrentTokenDelta: number;
  inputHash: string;
  candidateHash: string;
  attributedFileCount: number;
  compression: {
    status: CompressionStatus | "not_run";
    reason: CompressionReasonCode | "input_limit_exceeded";
  };
  elapsedMs: number;
};

export type EvidenceRoutingShadowSummary = {
  observations: number;
  byAction: Record<EvidenceRoutingAction, number>;
  byReason: Record<string, number>;
  byEvidenceClass: Record<string, number>;
  withAttribution: number;
  missingAttribution: number;
  failedOpen: number;
  projectedCompressibleInputTokens: number;
  projectedCompressedTokens: number;
  projectedSavedTokens: number;
  projectedSavingsRate: number;
  candidateVsCurrentTokenDelta: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
};
