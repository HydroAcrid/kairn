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
