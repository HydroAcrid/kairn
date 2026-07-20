import type { WatchEventSource } from "./watch.js";

export type TaskPhase = "discovery" | "implementation" | "debugging" | "verification" | "cleanup";

export type SessionLedgerEventKind =
  | "context_recommended"
  | "context_shown"
  | "agent_file_mentioned"
  | "agent_file_touched"
  | "command_run"
  | "test_run"
  | "failure_seen"
  | "diff_seen"
  | "verification_passed"
  | "verification_failed"
  | "phase_change"
  | "edit_scope_changed";

export type SessionLedgerEvent = {
  id?: number;
  sessionId: string;
  kind: SessionLedgerEventKind;
  turnId?: string;
  filePath?: string;
  symbol?: string;
  contentHash: string;
  tokenEstimate: number;
  source: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | "agent";
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SessionLedgerSummary = {
  sessionId: string;
  events: number;
  currentPhase: TaskPhase;
  recommendedFiles: string[];
  shownFiles: string[];
  agentMentionedFiles: string[];
  agentTouchedFiles: string[];
  repeatedFilesAvoided: number;
  repeatedSnippetsAvoided: number;
  recommendedFilesUsed: string[];
  repeatedlyTouchedFiles: string[];
  unresolvedFailures: number;
  workingSet: SessionWorkingSet;
  recentEvents: SessionLedgerEvent[];
};

export type SessionWorkingSet = {
  sessionId: string;
  currentPhase: TaskPhase;
  activeFiles: string[];
  recentlyTouchedFiles: string[];
  shownFiles: string[];
  ignoredRecommendedFiles: string[];
  ruledOutFiles: string[];
  staleFiles: string[];
  currentInvariant?: SessionWorkingSetInvariant;
  lastFailure?: SessionWorkingSetSignal;
  lastPassingVerification?: SessionWorkingSetSignal;
  nextSmallestUsefulRead?: SessionWorkingSetNextRead;
  openRisks: string[];
};

export type SessionWorkingSetInvariant = {
  statement: string;
  filePath?: string;
  confidence?: number;
  sourceEventId?: number;
};

export type SessionWorkingSetSignal = {
  turnId?: string;
  filePath?: string;
  summary: string;
  createdAt: string;
};

export type SessionWorkingSetNextRead = {
  filePath: string;
  reason: string;
  source: "failure" | "changed_file" | "ignored_recommendation" | "active_file" | "fresh_candidate";
};

export type SessionContextPolicyAction = "emit" | "shrink" | "suppress";

export type SessionContextPolicyReason =
  | "fresh_context"
  | "repeated_context_suppressed"
  | "changed_file_reemitted"
  | "failure_reemitted"
  | "phase_shift_reemitted"
  | "ignored_recommendation_shrunk"
  | "scope_drift_repair"
  | "verified_context_shrunk"
  | "verified_context_suppressed"
  | "active_source_context_shrunk"
  | "no_candidate_files";

export type SessionContextPolicyDecision = {
  action: SessionContextPolicyAction;
  phase: TaskPhase;
  reason: SessionContextPolicyReason;
  files: string[];
  repeatedFiles: string[];
  changedFiles: string[];
  ignoredRecommendedFiles: string[];
  tokenEstimate: number;
  metadata: Record<string, unknown>;
};
