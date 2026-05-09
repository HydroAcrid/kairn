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
  | "phase_change";

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
  recentEvents: SessionLedgerEvent[];
};

export type SessionContextPolicyAction = "emit" | "shrink" | "suppress";

export type SessionContextPolicyReason =
  | "fresh_context"
  | "repeated_context_suppressed"
  | "changed_file_reemitted"
  | "failure_reemitted"
  | "phase_shift_reemitted"
  | "ignored_recommendation_shrunk"
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
