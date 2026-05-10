import type {
  SessionContextPolicyDecision,
  SessionLedgerEvent,
  SessionLedgerSummary,
  TaskPhase
} from "../types.js";
import { sha256 } from "../utils/hash.js";
import { estimateTokens } from "../utils/tokens.js";
import { inferCurrentPhase } from "./summary.js";

export function inferTaskPhase(input: {
  task: string;
  recentEvents: SessionLedgerEvent[];
  changedFiles?: string[] | undefined;
  failureFiles?: string[] | undefined;
}): TaskPhase {
  const task = input.task.toLowerCase();
  if (/\b(cleanup|clean up|refactor|polish|final review|diff review|summarize)\b/.test(task)) return "cleanup";
  if (/\b(test|verify|verification|typecheck|lint|build|run checks|failing command)\b/.test(task)) return "verification";
  if (/\b(debug|failure|failing|regression|stack trace|error|exception|fix bug)\b/.test(task) || (input.failureFiles?.length ?? 0) > 0) return "debugging";
  if (/\b(implement|edit|change|update|fix|wire|add|remove)\b/.test(task) || (input.changedFiles?.length ?? 0) > 0) return "implementation";
  return inferCurrentPhase(input.recentEvents);
}

export function decideSessionContextPolicy(input: {
  task: string;
  candidateFiles: string[];
  contentHash?: string | undefined;
  tokenEstimate?: number | undefined;
  ledger: SessionLedgerSummary;
  recentEvents: SessionLedgerEvent[];
  changedFiles?: string[] | undefined;
  failureFiles?: string[] | undefined;
  source?: string | undefined;
}): SessionContextPolicyDecision {
  const candidateFiles = [...new Set(input.candidateFiles.filter(Boolean))];
  const phase = inferTaskPhase({
    task: input.task,
    recentEvents: input.recentEvents,
    changedFiles: input.changedFiles,
    failureFiles: input.failureFiles
  });
  if (candidateFiles.length === 0) {
    return {
      action: "suppress",
      phase,
      reason: "no_candidate_files",
      files: [],
      repeatedFiles: [],
      changedFiles: [],
      ignoredRecommendedFiles: [],
      tokenEstimate: input.tokenEstimate ?? 0,
      metadata: {}
    };
  }

  const workingSet = input.ledger.workingSet;
  const lastFailure = workingSet.lastFailure;
  const lastPassingVerification = workingSet.lastPassingVerification;
  const hasPassingVerification = Boolean(lastPassingVerification);
  const hasUnresolvedFailure = Boolean(lastFailure) &&
    (!lastPassingVerification || Date.parse(lastFailure!.createdAt) > Date.parse(lastPassingVerification.createdAt));
  const shownFiles = new Set(workingSet.shownFiles);
  const repeatedFiles = candidateFiles.filter((file) => shownFiles.has(file));
  const changedFiles = candidateFiles.filter((file) => (input.changedFiles ?? []).includes(file) || workingSet.staleFiles.includes(file));
  const failureFiles = candidateFiles.filter((file) => (input.failureFiles ?? []).includes(file));
  const ignoredRecommendedFiles = workingSet.ignoredRecommendedFiles;
  const contentHash = input.contentHash ?? sha256(candidateFiles.join("\n"));
  const duplicateSnippet = input.recentEvents.some(
    (event) => event.kind === "context_shown" && event.contentHash === contentHash
  );
  const phaseShift = phase !== input.ledger.currentPhase;

  if ((phase === "verification" || phase === "cleanup") && hasPassingVerification && !hasUnresolvedFailure) {
    const verifiedFocus = lastPassingVerification?.filePath ?? workingSet.currentInvariant?.filePath ?? workingSet.activeFiles[0];
    const activeFiles = uniqueStrings([
      ...(verifiedFocus ? [verifiedFocus] : []),
      ...candidateFiles.filter((file) => workingSet.activeFiles.includes(file))
    ]);
    return decision("shrink", phase, "verified_context_shrunk", activeFiles.slice(0, 1), repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
      lastPassingVerification,
      repeatedFilesAvoided: repeatedFiles.length
    });
  }
  if (changedFiles.length > 0) {
    return decision("emit", phase, "changed_file_reemitted", candidateFiles, repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
  }
  if (failureFiles.length > 0 || phase === "debugging") {
    return decision("emit", phase, "failure_reemitted", candidateFiles.slice(0, 2), repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
  }
  if (phaseShift && repeatedFiles.length < candidateFiles.length) {
    return decision("emit", phase, "phase_shift_reemitted", candidateFiles.filter((file) => !shownFiles.has(file)), repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
  }
  if (duplicateSnippet || repeatedFiles.length === candidateFiles.length) {
    return decision("suppress", phase, "repeated_context_suppressed", [], repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
      repeatedFilesAvoided: repeatedFiles.length,
      repeatedSnippetsAvoided: duplicateSnippet ? 1 : 0
    });
  }
  if (ignoredRecommendedFiles.length >= 2) {
    return decision("shrink", phase, "ignored_recommendation_shrunk", candidateFiles.filter((file) => !shownFiles.has(file)).slice(0, 1), repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
  }
  return decision("emit", phase, "fresh_context", candidateFiles.filter((file) => !shownFiles.has(file)), repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
    workingSetActiveFiles: workingSet.activeFiles.slice(0, 5),
    nextSmallestUsefulRead: workingSet.nextSmallestUsefulRead
  });
}

function decision(
  action: SessionContextPolicyDecision["action"],
  phase: TaskPhase,
  reason: SessionContextPolicyDecision["reason"],
  files: string[],
  repeatedFiles: string[],
  changedFiles: string[],
  ignoredRecommendedFiles: string[],
  input: { tokenEstimate?: number | undefined; source?: string | undefined },
  metadata: Record<string, unknown> = {}
): SessionContextPolicyDecision {
  return {
    action,
    phase,
    reason,
    files,
    repeatedFiles,
    changedFiles,
    ignoredRecommendedFiles,
    tokenEstimate: input.tokenEstimate ?? estimateTokens(files.join("\n")),
    metadata: {
      ...metadata,
      ...(input.source ? { source: input.source } : {})
    }
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
