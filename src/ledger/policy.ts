// SPDX-License-Identifier: Apache-2.0

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
  if (/\b(cleanup|clean up|refactor|polish|final review|diff review|review (?:the )?final diff|final diff|summarize)\b/.test(task)) return "cleanup";
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
  const hasUnresolvedFailure = workingSet.unresolvedFailure;
  const shownFiles = new Set(workingSet.shownFiles);
  const repeatedFiles = candidateFiles.filter((file) => shownFiles.has(file));
  const changedFiles = candidateFiles.filter((file) => workingSet.staleFiles.includes(file));
  const failureFiles = candidateFiles.filter((file) => (input.failureFiles ?? []).includes(file));
  const ignoredRecommendedFiles = workingSet.ignoredRecommendedFiles;
  const contentHash = input.contentHash ?? sha256(candidateFiles.join("\n"));
  const duplicateSnippet = input.recentEvents.some(
    (event) => event.kind === "context_shown" && event.contentHash === contentHash
  );
  const phaseShift = phase !== input.ledger.currentPhase;
  const verifiedFocus = lastPassingVerification?.filePath ?? workingSet.currentInvariant?.filePath ?? workingSet.activeFiles[0];
  const latestEditScopeFiles = latestInitialEditScopeFiles(input.recentEvents);
  const scopeDriftFiles = selectScopeDriftRepairFiles({
    task: input.task,
    phase,
    workingSet,
    latestEditScopeFiles,
    verifiedFocus,
    hasUnresolvedFailure
  });
  const postDiagnosisFocus = selectPostDiagnosisFocus({
    task: input.task,
    phase,
    candidateFiles,
    changedFiles: input.changedFiles ?? [],
    activeFiles: workingSet.activeFiles,
    shownFiles: workingSet.shownFiles,
    recentlyTouchedFiles: workingSet.recentlyTouchedFiles,
    currentInvariantFile: workingSet.currentInvariant?.filePath,
    lastPassingVerificationFile: lastPassingVerification?.filePath,
    hasUnresolvedFailure
  });

  if (scopeDriftFiles.length > 0) {
    const expectedScopeFiles = uniqueStrings([
      ...latestEditScopeFiles,
      ...(verifiedFocus ? [verifiedFocus] : [])
    ]).filter(isLikelyProductionSourcePath);
    return decision("shrink", phase, "scope_drift_repair", scopeDriftFiles, repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
      scopeDriftFiles,
      expectedScopeFiles,
      lastPassingVerification,
      nextSmallestUsefulRead: workingSet.nextSmallestUsefulRead
    });
  }

  if ((phase === "verification" || phase === "cleanup") && hasPassingVerification && !hasUnresolvedFailure) {
    const activeFiles = uniqueStrings([
      ...(verifiedFocus ? [verifiedFocus] : []),
      ...candidateFiles.filter((file) => workingSet.activeFiles.includes(file))
    ]);
    if (shouldSuppressVerifiedContext({
      task: input.task,
      phase,
      source: input.source,
      activeFiles,
      repeatedFiles
    })) {
      return decision("suppress", phase, "verified_context_suppressed", [], repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
        lastPassingVerification,
        verifiedFocus,
        repeatedFilesAvoided: Math.max(repeatedFiles.length, activeFiles.length)
      });
    }
    return decision("shrink", phase, "verified_context_shrunk", activeFiles.slice(0, 1), repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
      lastPassingVerification,
      repeatedFilesAvoided: repeatedFiles.length
    });
  }
  if (changedFiles.length > 0) {
    return decision("emit", phase, "changed_file_reemitted", candidateFiles, repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
  }
  if (failureFiles.length > 0 || hasUnresolvedFailure) {
    return decision("emit", phase, "failure_reemitted", candidateFiles.slice(0, 2), repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
  }
  if (postDiagnosisFocus && isFixTurnSignal(input.task, phase)) {
    return decision("shrink", phase, "active_source_context_shrunk", [postDiagnosisFocus], repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
      activeSourceFile: postDiagnosisFocus,
      repeatedFilesAvoided: repeatedFiles.length
    });
  }
  if (duplicateSnippet || repeatedFiles.length === candidateFiles.length) {
    return decision("suppress", phase, "repeated_context_suppressed", [], repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
      repeatedFilesAvoided: repeatedFiles.length,
      repeatedSnippetsAvoided: duplicateSnippet ? 1 : 0
    });
  }
  if (postDiagnosisFocus) {
    return decision("shrink", phase, "active_source_context_shrunk", [postDiagnosisFocus], repeatedFiles, changedFiles, ignoredRecommendedFiles, input, {
      activeSourceFile: postDiagnosisFocus,
      repeatedFilesAvoided: repeatedFiles.length
    });
  }
  if (phase === "debugging") {
    return decision("emit", phase, "failure_reemitted", candidateFiles.slice(0, 2), repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
  }
  if (phaseShift && repeatedFiles.length < candidateFiles.length) {
    return decision("emit", phase, "phase_shift_reemitted", candidateFiles.filter((file) => !shownFiles.has(file)), repeatedFiles, changedFiles, ignoredRecommendedFiles, input);
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

function selectPostDiagnosisFocus(input: {
  task: string;
  phase: TaskPhase;
  candidateFiles: string[];
  changedFiles: string[];
  activeFiles: string[];
  shownFiles: string[];
  recentlyTouchedFiles: string[];
  currentInvariantFile?: string | undefined;
  lastPassingVerificationFile?: string | undefined;
  hasUnresolvedFailure: boolean;
}): string | undefined {
  if (input.hasUnresolvedFailure) return undefined;
  if (!["debugging", "implementation", "verification", "cleanup"].includes(input.phase)) return undefined;
  if (hasExplicitMultiFileSignal(input.task)) return undefined;
  const hasPriorSessionEvidence =
    input.shownFiles.length > 0 ||
    input.recentlyTouchedFiles.length > 0 ||
    Boolean(input.currentInvariantFile || input.lastPassingVerificationFile);
  if (!hasPriorSessionEvidence) return undefined;

  const directFocus = uniqueStrings([
    ...input.changedFiles,
    ...(input.lastPassingVerificationFile ? [input.lastPassingVerificationFile] : []),
    ...(input.currentInvariantFile ? [input.currentInvariantFile] : []),
    ...input.recentlyTouchedFiles
  ]).filter(isLikelyProductionSourcePath);
  const matchedDirect = directFocus.filter((file) => input.candidateFiles.includes(file));
  if (matchedDirect.length === 1) return matchedDirect[0];
  if (directFocus.length === 1) return directFocus[0];

  const activeFocus = uniqueStrings(input.activeFiles).filter(isLikelyProductionSourcePath);
  if (activeFocus.length === 1) return activeFocus[0];
  const matchedActive = activeFocus.filter((file) => input.candidateFiles.includes(file));
  return matchedActive.length === 1 ? matchedActive[0] : undefined;
}

function hasExplicitMultiFileSignal(task: string): boolean {
  return /\b(multi[-\s]?file|multiple files|across files|across modules|between .+ and .+|wire .+ and .+|integrat(?:e|ion)|companion|controller.+repository|repository.+controller|router.+dependency|dependency.+router|scheduler.+renderer|renderer.+scheduler|interceptor.+dispatch|dispatch.+interceptor)\b/i.test(task);
}

function isFixTurnSignal(task: string, phase: TaskPhase): boolean {
  if (phase !== "debugging" && phase !== "implementation") return false;
  return /\b(fix|repair|patch|regression|bug|seeded|failing|failure|broken)\b/i.test(task);
}

function latestInitialEditScopeFiles(events: SessionLedgerEvent[]): string[] {
  for (const event of [...events].reverse()) {
    if (event.kind !== "edit_scope_changed") continue;
    const editScope = isRecord(event.metadata.editScope) ? event.metadata.editScope : undefined;
    const initialEditFiles = Array.isArray(editScope?.initialEditFiles)
      ? editScope.initialEditFiles.filter((file): file is string => typeof file === "string" && file.length > 0)
      : [];
    if (initialEditFiles.length > 0) return uniqueStrings(initialEditFiles);
  }
  return [];
}

function selectScopeDriftRepairFiles(input: {
  task: string;
  phase: TaskPhase;
  workingSet: SessionLedgerSummary["workingSet"];
  latestEditScopeFiles: string[];
  verifiedFocus?: string | undefined;
  hasUnresolvedFailure: boolean;
}): string[] {
  if (input.phase !== "verification" && input.phase !== "cleanup") return [];
  if (input.hasUnresolvedFailure) return [];
  if (hasExplicitMultiFileSignal(input.task) && input.latestEditScopeFiles.length === 0) return [];
  const allowedFiles = uniqueStrings([
    ...input.latestEditScopeFiles,
    ...(input.verifiedFocus ? [input.verifiedFocus] : []),
    ...(input.workingSet.currentInvariant?.filePath ? [input.workingSet.currentInvariant.filePath] : [])
  ]).filter(isLikelyProductionSourcePath);
  if (allowedFiles.length === 0) return [];
  const allowed = new Set(allowedFiles);
  const driftFiles = uniqueStrings([
    ...input.workingSet.recentlyTouchedFiles,
    ...input.workingSet.activeFiles
  ])
    .filter(isLikelyProductionSourcePath)
    .filter((file) => !allowed.has(file));
  if (driftFiles.length === 0) return [];
  return uniqueStrings([...driftFiles.slice(0, 2), ...allowedFiles.slice(0, 1)]);
}

function shouldSuppressVerifiedContext(input: {
  task: string;
  phase: TaskPhase;
  source?: string | undefined;
  activeFiles: string[];
  repeatedFiles: string[];
}): boolean {
  if (input.phase === "cleanup") return true;
  if (!isAutomaticContextSource(input.source)) return false;
  if (input.repeatedFiles.length > 0) return true;
  if (isVerificationOnlyTask(input.task)) return true;
  return false;
}

function isAutomaticContextSource(source: string | undefined): boolean {
  return !source || /^(?:codex|claude|mcp|watch|bench|generic)$/.test(source);
}

function isVerificationOnlyTask(task: string): boolean {
  return /\b(verify|verification|check|test|typecheck|lint|build|cleanup|review diff|final review)\b/i.test(task) &&
    !/\b(repair|patch|implement|change|update|debug|failing|failure|regression)\b/i.test(task);
}

function isLikelyProductionSourcePath(filePath: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?|py|java|go|rs|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(filePath)) return false;
  if (/(^|\/)(?:test|tests|testing|__tests__|spec|specs|docs|examples|fixtures|generated|gen|codemods|devtools)(?:\/|$)/i.test(filePath)) {
    return false;
  }
  if (/(?:^|\/)[^/]*(?:test|spec)\.[^/]+$/i.test(filePath)) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
