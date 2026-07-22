// SPDX-License-Identifier: Apache-2.0

import type {
  ContextRankedFile,
  ContextValueDecision,
  EvidenceDelivery,
  EvidenceRankerStatus,
  EvidenceReason,
  EvidenceTaskIntent,
  FileRecord,
  PrimeQuality
} from "../types.js";
import { extractEvidenceTaskSignals } from "../retrieval/evidenceSignals.js";

export const CALIBRATED_EVIDENCE_POLICY_SOURCE = "calibrated_evidence_policy_v1" as const;
export const CALIBRATED_EVIDENCE_FILE_LIMIT = 3;

export type CalibratedEvidencePolicyReason =
  | "ranker_abstained"
  | "missing_index"
  | "stale_index"
  | "invalid_ranker_fallback"
  | "hard_evidence_override"
  | "generated_vendor_blocked"
  | "intent_role_filtered"
  | "unchanged_evidence_suppressed"
  | "failed_evidence_reconsidered"
  | "changed_evidence_refreshed"
  | "content_threshold_met"
  | "path_hint_threshold_met"
  | "content_downgraded_for_budget"
  | "bounded_companions";

export type CalibratedEvidenceSelection = {
  path: string;
  delivery: EvidenceDelivery;
  relevanceProbability: number;
  evidenceReasons: EvidenceReason[];
  primary: boolean;
};

export type CalibratedEvidencePolicyDecision = {
  source: typeof CALIBRATED_EVIDENCE_POLICY_SOURCE;
  action: PrimeQuality["action"];
  delivery: EvidenceDelivery | "none";
  intent: EvidenceTaskIntent;
  selections: CalibratedEvidenceSelection[];
  primaryFile?: string;
  companionFiles: string[];
  reasonCodes: CalibratedEvidencePolicyReason[];
  reasons: string[];
  quality: PrimeQuality;
  contextDecision: ContextValueDecision;
};

export type CalibratedEvidencePolicyInput = {
  task: string;
  rankedFiles: ContextRankedFile[];
  knownFiles: FileRecord[];
  ranker: EvidenceRankerStatus;
  budget: number;
  indexMissing: boolean;
  indexStale: boolean;
  changedFiles?: Iterable<string>;
  shownFiles?: Iterable<string>;
  sessionState?: {
    unresolvedFailure: boolean;
    reconsiderShownFiles: readonly string[];
  };
};

type PolicyCandidate = {
  ranked: ContextRankedFile;
  record: FileRecord | undefined;
  probability: number;
  reasons: Set<EvidenceReason>;
  hard: boolean;
  changed: boolean;
  shown: boolean;
  reconsidered: boolean;
};

const MIN_CONTENT_BUDGET = 320;
const LARGE_CONTENT_BUDGET = 700;

/**
 * Deterministic safety policy for calibrated serving. The ranker estimates
 * which files are required; this policy only decides whether and how bounded
 * evidence may be delivered. It deliberately does not inspect legacy scores
 * or human explanation strings.
 */
export function decideCalibratedEvidencePolicy(
  input: CalibratedEvidencePolicyInput
): CalibratedEvidencePolicyDecision {
  if (input.ranker.requestedMode !== "calibrated") {
    throw new Error("The calibrated evidence policy may only govern calibrated ranker requests.");
  }

  const intent = extractEvidenceTaskSignals(input.task).intent;
  const knownByPath = new Map(input.knownFiles.map((file) => [normalizePath(file.path), file]));
  const changed = normalizedSet(input.changedFiles);
  const shown = normalizedSet(input.shownFiles);
  const reconsider = input.sessionState?.unresolvedFailure
    ? normalizedSet(input.sessionState.reconsiderShownFiles)
    : new Set<string>();
  const reasonCodes = new Set<CalibratedEvidencePolicyReason>();

  if (input.indexMissing || input.knownFiles.length === 0) {
    reasonCodes.add("missing_index");
    return emptyDecision(input, intent, reasonCodes, "request_evidence");
  }

  if (input.indexStale) reasonCodes.add("stale_index");
  const fallback = input.ranker.servedMode !== "calibrated";
  if (fallback) reasonCodes.add("invalid_ranker_fallback");

  const candidates: PolicyCandidate[] = [];
  for (const ranked of input.rankedFiles) {
    const probability = ranked.relevanceProbability;
    if (!Number.isFinite(probability) || probability === undefined || probability < 0 || probability > 1) continue;
    const reasons = new Set(ranked.evidenceReasons ?? []);
    const hard = reasons.has("failure_reference") || reasons.has("exact_path");
    const normalized = normalizePath(ranked.path);
    const candidate: PolicyCandidate = {
      ranked,
      record: knownByPath.get(normalized),
      probability,
      reasons,
      hard,
      changed: changed.has(normalized) || reasons.has("git_diff"),
      shown: shown.has(normalized) || reasons.has("already_delivered"),
      reconsidered: reconsider.has(normalized)
    };

    if (fallback && !hard) continue;
    if (reasons.has("generated_vendor") && !hard) {
      reasonCodes.add("generated_vendor_blocked");
      continue;
    }
    if (!roleIsSafe(candidate, intent)) {
      reasonCodes.add("intent_role_filtered");
      continue;
    }
    if (candidate.shown && !candidate.changed && !candidate.reconsidered && !hard) {
      reasonCodes.add("unchanged_evidence_suppressed");
      continue;
    }
    if (candidate.shown && candidate.reconsidered) reasonCodes.add("failed_evidence_reconsidered");
    if (candidate.changed && candidate.shown) reasonCodes.add("changed_evidence_refreshed");
    if (hard) reasonCodes.add("hard_evidence_override");
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    if (input.indexStale) return emptyDecision(input, intent, reasonCodes, "request_evidence");
    reasonCodes.add("ranker_abstained");
    return emptyDecision(input, intent, reasonCodes, "suppress");
  }

  const primary = choosePrimary(candidates, intent);
  const companions = candidates
    .filter((candidate) => candidate !== primary)
    .sort(compareCandidates)
    .slice(0, CALIBRATED_EVIDENCE_FILE_LIMIT - 1);
  if (companions.length > 0) reasonCodes.add("bounded_companions");

  const selected = [primary, ...companions];
  const selections = selected.map((candidate, index): CalibratedEvidenceSelection => {
    const delivery = safeDelivery(candidate, input, fallback, reasonCodes);
    reasonCodes.add(delivery === "content" ? "content_threshold_met" : "path_hint_threshold_met");
    return {
      path: candidate.ranked.path,
      delivery,
      relevanceProbability: candidate.probability,
      evidenceReasons: [...candidate.reasons],
      primary: index === 0
    };
  });
  const delivery = selections.some((selection) => selection.delivery === "content") ? "content" : "path_hint";
  const action: PrimeQuality["action"] = delivery === "content" ? "emit" : "shrink";
  const codes = [...reasonCodes];
  const reasons = codes.map(reasonText);
  const topProbability = primary.probability;
  const secondProbability = companions[0]?.probability ?? 0;
  const topScore = round(topProbability * 100);
  const topGap = round(Math.max(0, topProbability - secondProbability) * 100);
  const exactPathMentioned = primary.reasons.has("exact_path");
  const expectedSavingsRisk = fallback || input.indexStale
    ? "high" as const
    : delivery === "content"
      ? "low" as const
      : "medium" as const;
  const quality: PrimeQuality = {
    score: topScore,
    action,
    reasons,
    topScore,
    topGap,
    exactPathMentioned,
    expectedSavingsRisk
  };
  const companionFiles = selections.slice(1).map((selection) => selection.path);
  const hardFailure = primary.reasons.has("failure_reference");
  const productionSource = primary.reasons.has("production_source");
  const contextDecision: ContextValueDecision = {
    score: topScore,
    action,
    reasons,
    topScore,
    topGap,
    primaryFile: primary.ranked.path,
    language: inferLanguage(primary.record),
    exactPathMentioned,
    exactSourceHit: exactPathMentioned || hardFailure,
    sourceRescue: productionSource && hasSourceIdentityEvidence(primary.reasons),
    canonicalSourceHit: productionSource,
    companionSpecific: companions.some((candidate) =>
      candidate.reasons.has("source_test_pair") || candidate.reasons.has("failure_reference") || candidate.reasons.has("exact_path")
    ),
    multiSurfaceSignal: companionFiles.length > 0,
    companionCount: companionFiles.length,
    companionTopScore: round((companions[0]?.probability ?? 0) * 100),
    recommendedDelivery: companionFiles.length > 0 ? "multi_file_directive" : "one_file_directive",
    estimatedContextCost: Math.max(0, input.budget),
    expectedSavingsRisk,
    debugSignal: hardFailure,
    easyTaskSignal: false,
    taskFrame: hardFailure ? "failure_first" : productionSource ? "source_rescue" : "weak_signal",
    policySource: CALIBRATED_EVIDENCE_POLICY_SOURCE
  };

  return {
    source: CALIBRATED_EVIDENCE_POLICY_SOURCE,
    action,
    delivery,
    intent,
    selections,
    primaryFile: primary.ranked.path,
    companionFiles,
    reasonCodes: codes,
    reasons,
    quality,
    contextDecision
  };
}

export function isCalibratedEvidencePolicyDecision(
  value: unknown
): value is CalibratedEvidencePolicyDecision {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.source === CALIBRATED_EVIDENCE_POLICY_SOURCE &&
    Array.isArray(record.selections) &&
    Array.isArray(record.reasonCodes) &&
    Boolean(record.quality && typeof record.quality === "object") &&
    Boolean(record.contextDecision && typeof record.contextDecision === "object");
}

function emptyDecision(
  input: CalibratedEvidencePolicyInput,
  intent: EvidenceTaskIntent,
  reasonCodes: Set<CalibratedEvidencePolicyReason>,
  action: "suppress" | "request_evidence"
): CalibratedEvidencePolicyDecision {
  const codes = [...reasonCodes];
  const reasons = codes.map(reasonText);
  const quality: PrimeQuality = {
    score: 0,
    action,
    reasons,
    topScore: 0,
    topGap: 0,
    exactPathMentioned: false,
    expectedSavingsRisk: "high"
  };
  const contextDecision: ContextValueDecision = {
    score: 0,
    action,
    reasons,
    topScore: 0,
    topGap: 0,
    language: "unknown",
    exactPathMentioned: false,
    recommendedDelivery: action === "request_evidence" ? "evidence_request" : "none",
    estimatedContextCost: Math.max(0, input.budget),
    expectedSavingsRisk: "high",
    debugSignal: false,
    easyTaskSignal: false,
    taskFrame: "weak_signal",
    policySource: CALIBRATED_EVIDENCE_POLICY_SOURCE,
    ...(action === "request_evidence"
      ? {
          evidenceRequest: {
            kind: "clarify_task" as const,
            prompt: input.indexMissing
              ? "Build or refresh Kairn's local repository index before requesting source content."
              : "Refresh Kairn's local repository index or provide an exact current path/failure reference.",
            reason: input.indexMissing
              ? "The local repository inventory is missing."
              : "The local repository index is stale and no precise current evidence is safe to emit."
          }
        }
      : {})
  };
  return {
    source: CALIBRATED_EVIDENCE_POLICY_SOURCE,
    action,
    delivery: "none",
    intent,
    selections: [],
    companionFiles: [],
    reasonCodes: codes,
    reasons,
    quality,
    contextDecision
  };
}

function choosePrimary(candidates: PolicyCandidate[], intent: EvidenceTaskIntent): PolicyCandidate {
  return [...candidates].sort((left, right) =>
    primaryRolePriority(right, intent) - primaryRolePriority(left, intent) || compareCandidates(left, right)
  )[0]!;
}

function compareCandidates(left: PolicyCandidate, right: PolicyCandidate): number {
  return hardPriority(right) - hardPriority(left) ||
    right.probability - left.probability ||
    left.ranked.path.localeCompare(right.ranked.path);
}

function hardPriority(candidate: PolicyCandidate): number {
  if (candidate.reasons.has("failure_reference")) return 2;
  if (candidate.reasons.has("exact_path")) return 1;
  return 0;
}

function primaryRolePriority(candidate: PolicyCandidate, intent: EvidenceTaskIntent): number {
  if (candidate.hard) return 4;
  if (intent === "test" && (candidate.record?.kind === "test" || candidate.reasons.has("test_requested"))) return 3;
  if (intent === "docs" && candidate.record?.kind === "doc") return 3;
  if ((intent === "source" || intent === "unknown") && candidate.reasons.has("production_source")) return 3;
  if (candidate.reasons.has("role_match")) return 2;
  return 1;
}

function roleIsSafe(candidate: PolicyCandidate, intent: EvidenceTaskIntent): boolean {
  if (candidate.hard) return true;
  const kind = candidate.record?.kind ?? candidate.ranked.kind;
  if (kind === "doc" && intent !== "docs") return false;
  if (intent === "docs") return kind === "doc" || candidate.reasons.has("role_match");
  if (kind === "test" && intent !== "test") {
    return candidate.reasons.has("source_test_pair") || candidate.reasons.has("graph_neighbor");
  }
  return true;
}

function safeDelivery(
  candidate: PolicyCandidate,
  input: CalibratedEvidencePolicyInput,
  fallback: boolean,
  reasonCodes: Set<CalibratedEvidencePolicyReason>
): EvidenceDelivery {
  if (fallback || input.indexStale) return "path_hint";
  if (candidate.shown && !candidate.changed && !candidate.reconsidered && !candidate.reasons.has("failure_reference")) return "path_hint";
  const requested = candidate.ranked.delivery === "content" ? "content" : "path_hint";
  if (requested === "path_hint") return requested;
  const insufficientBudget = input.budget < MIN_CONTENT_BUDGET ||
    (candidate.reasons.has("content_cost") && input.budget < LARGE_CONTENT_BUDGET);
  if (insufficientBudget) {
    reasonCodes.add("content_downgraded_for_budget");
    return "path_hint";
  }
  return "content";
}

function hasSourceIdentityEvidence(reasons: Set<EvidenceReason>): boolean {
  return reasons.has("failure_reference") ||
    reasons.has("exact_path") ||
    reasons.has("basename") ||
    reasons.has("exact_symbol");
}

function normalizedSet(values?: Iterable<string>): Set<string> {
  return new Set([...(values ?? [])].map(normalizePath));
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function inferLanguage(file: FileRecord | undefined): ContextValueDecision["language"] {
  const language = file?.language.toLowerCase();
  if (language === "typescript" || language === "ts" || language === "tsx") return "typescript";
  if (language === "javascript" || language === "js" || language === "jsx") return "javascript";
  if (language === "python" || language === "py") return "python";
  if (language === "java") return "java";
  if (["cpp", "c++", "cc", "cxx", "hpp", "hxx"].includes(language ?? "")) return "cpp";
  if (language === "c" || language === "h") return "c";
  if (language === "go") return "go";
  if (language === "ruby" || language === "rb") return "ruby";
  return "unknown";
}

function reasonText(reason: CalibratedEvidencePolicyReason): string {
  switch (reason) {
    case "ranker_abstained": return "calibrated ranker found no deliverable repository evidence";
    case "missing_index": return "local repository inventory is missing";
    case "stale_index": return "local repository index is stale";
    case "invalid_ranker_fallback": return "invalid ranker artifact restricted delivery to conservative hard-evidence path hints";
    case "hard_evidence_override": return "explicit path or precise failure evidence is preserved by a hard rule";
    case "generated_vendor_blocked": return "generated or vendor evidence was blocked without an explicit path or failure reference";
    case "intent_role_filtered": return "repository roles incompatible with the task intent were filtered";
    case "unchanged_evidence_suppressed": return "previously delivered unchanged evidence was suppressed";
    case "failed_evidence_reconsidered": return "previously delivered evidence was reconsidered after an unresolved failure";
    case "changed_evidence_refreshed": return "previously delivered evidence changed and may be refreshed";
    case "content_threshold_met": return "calibrated content-delivery threshold was met";
    case "path_hint_threshold_met": return "evidence is limited to a path hint";
    case "content_downgraded_for_budget": return "content was downgraded to a path hint to respect the context budget";
    case "bounded_companions": return "delivery is bounded to one primary file and at most two companions";
  }
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
