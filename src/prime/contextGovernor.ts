import fs from "node:fs";
import type {
  ContextGovernorFeatureSummary,
  ContextGovernorModelPrediction,
  ContextResponse,
  ContextRankedFile,
  ContextValueAction,
  ContextValueDecision,
  EvidenceRequest,
  FileRecord,
  FileRoleV2,
  PrimeQuality,
  TaskFrame
} from "../types.js";
import type { ResolvedPrimeProfile } from "./quality.js";

export type CandidateFeatures = {
  path: string;
  language: string;
  role: FileRoleV2;
  score: number;
  lexicalScore: number;
  graphScore: number;
  sessionScore: number;
  languageAlignment: number;
  exactMatch: boolean;
  generatedPenalty: number;
  testDocPenalty: number;
  companionEvidence: number;
};

export type DecisionFeatures = {
  taskFrame: TaskFrame;
  repoLanguageMix: Record<string, number>;
  candidates: CandidateFeatures[];
  confidenceGap: number;
  candidateEntropy: number;
  ambiguity: number;
  activeSourceState: boolean;
  staleIndexState: boolean;
  failureState: boolean;
  verificationState: boolean;
  expectedContextCost: number;
  estimatedSearchCost: number;
};

export type GovernorInput = {
  task: string;
  profile: ResolvedPrimeProfile;
  context: ContextResponse;
  quality: PrimeQuality;
  baseDecision: ContextValueDecision;
  knownFiles: FileRecord[];
  repoFileCount: number;
  estimatedContextCost: number;
  companionCount?: number | undefined;
  companionTopScore?: number | undefined;
  companionSpecific?: boolean | undefined;
  staleIndexState?: boolean | undefined;
  activeSourceState?: boolean | undefined;
};

export type LinearGovernorModel = {
  bias?: number;
  weights?: Partial<Record<LinearFeatureName, number>>;
  harmBias?: number;
  harmWeights?: Partial<Record<LinearFeatureName, number>>;
  evidenceBias?: number;
  evidenceWeights?: Partial<Record<LinearFeatureName, number>>;
  thresholds?: {
    useful?: number;
    harm?: number;
    evidence?: number;
  };
};

type LinearFeatureName =
  | "candidateCount"
  | "topScore"
  | "confidenceGap"
  | "ambiguity"
  | "candidateEntropy"
  | "expectedContextCost"
  | "estimatedSearchCost"
  | "failureState"
  | "verificationState"
  | "staleIndexState"
  | "generatedOrVendorTop"
  | "testDocTop"
  | "companionEvidence";

type GovernorRankedCandidate = {
  path: string;
  kind?: FileRecord["kind"];
  score: number;
  reasons: string[];
  scores?: ContextRankedFile["scores"];
};

let cachedModelPath: string | undefined;
let cachedModel: LinearGovernorModel | undefined;

export function applyContextGovernor(input: GovernorInput): ContextValueDecision {
  const features = buildDecisionFeatures(input);
  const deterministic = deterministicPrediction(input.baseDecision, features);
  const configuredModel = loadConfiguredGovernorModel();
  const modelPrediction = configuredModel
    ? linearModelPrediction(features, configuredModel)
    : deterministic;
  const governed = chooseGovernedAction({
    baseDecision: input.baseDecision,
    features,
    deterministic,
    modelPrediction
  });
  const featureSummary = summarizeDecisionFeatures(features);

  if (governed.action === input.baseDecision.action && governed.action !== "request_evidence") {
    return {
      ...input.baseDecision,
      taskFrame: features.taskFrame,
      modelPrediction,
      featureSummary
    };
  }

  const reasons = new Set(input.baseDecision.reasons);
  for (const reason of governed.reasons) reasons.add(reason);
  return {
    ...input.baseDecision,
    score: governed.score,
    action: governed.action,
    expectedSavingsRisk: governed.action === "emit" ? "low" : governed.action === "shrink" ? "medium" : "high",
    recommendedDelivery: governed.action === "request_evidence"
      ? "evidence_request"
      : governed.action === "emit"
        ? input.baseDecision.recommendedDelivery ?? "full_prime"
        : governed.action === "shrink"
          ? input.baseDecision.recommendedDelivery === "multi_file_directive" ? "multi_file_directive" : "one_file_directive"
          : "none",
    reasons: [...reasons],
    taskFrame: features.taskFrame,
    ...(governed.evidenceRequest ? { evidenceRequest: governed.evidenceRequest } : {}),
    modelPrediction,
    featureSummary
  };
}

export function buildDecisionFeatures(input: GovernorInput): DecisionFeatures {
  const ranked = rankedCandidates(input);
  const repoLanguageMix = languageMix(input.knownFiles);
  const expectedLanguage = expectedTaskLanguage(input.task, input.context, repoLanguageMix);
  const candidates = ranked.map((candidate) =>
    candidateFeatures({
      candidate,
      task: input.task,
      expectedLanguage,
      record: input.knownFiles.find((file) => file.path === candidate.path)
    })
  );
  const taskFrame = classifyTaskFrame({
    task: input.task,
    profile: input.profile,
    decision: input.baseDecision,
    context: input.context,
    candidates,
    companionCount: input.companionCount ?? 0,
    companionTopScore: input.companionTopScore ?? 0
  });
  return {
    taskFrame,
    repoLanguageMix,
    candidates,
    confidenceGap: Math.max(0, input.baseDecision.topGap),
    candidateEntropy: candidateEntropy(candidates),
    ambiguity: candidateAmbiguity(candidates, input.baseDecision.topGap),
    activeSourceState: Boolean(input.activeSourceState),
    staleIndexState: Boolean(input.staleIndexState),
    failureState: taskFrame === "failure_first" || input.profile === "failure_debug" || /\b(fail|failure|traceback|stack trace|exception|error)\b/i.test(input.task),
    verificationState: taskFrame === "verification_cleanup" || /\b(verify|verification|test|typecheck|lint|build|cleanup|review diff)\b/i.test(input.task),
    expectedContextCost: input.estimatedContextCost,
    estimatedSearchCost: estimateSearchCost(input.repoFileCount, taskFrame, candidates)
  };
}

export function classifyFileRoleV2(filePath: string, kind?: FileRecord["kind"] | undefined): FileRoleV2 {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/(^|\/)(vendor|node_modules|third_party|deps?|external)(\/|$)/.test(normalized)) return "vendor_dep";
  if (/(^|\/)(generated|gen|dist|build|coverage)(\/|$)/.test(normalized) || /\.(gen|generated)\.[^.]+$/.test(basename)) return "generated";
  if (/(^|\/)(docs?|documentation|website|site)(\/|$)/.test(normalized) || kind === "doc") return "docs";
  if (/(^|\/)(examples?|demo|demos|samples?)(\/|$)/.test(normalized)) return "example";
  if (/(^|\/)(tests?|testing|__tests__|spec|specs|fixtures?|testdata)(\/|$)/.test(normalized) || /\.(test|spec)\./.test(basename) || /(_test|_spec)\.[^.]+$/.test(basename)) return "test";
  if (/(^|\/)(config|configs?)(\/|$)/.test(normalized) || /\.(json|ya?ml|toml|ini|env|config\.[cm]?[jt]s)$/.test(basename)) return "config";
  if (kind === "schema" || /\b(schema|migration|prisma|graphql)\b/.test(normalized)) return "schema";
  if (kind === "route" || /\b(route|router|routing|routes)\b/.test(normalized)) return "route";
  if (kind === "component" || /\.(tsx|jsx|vue|svelte)$/.test(basename)) return "ui_surface";
  if (/\b(index|main|cli|server|app)\.[cm]?[jt]s$/.test(basename) || /\b(main|cmd)\.go$/.test(basename)) return "entrypoint";
  if (/\b(public|api|types?|interface|exports?)\b/.test(normalized) || /\.(d\.ts|pyi)$/.test(basename)) return "public_api";
  if (/\b(win32|windows|darwin|linux|posix|browser|node|native)\b/.test(normalized)) return "platform_variant";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|php|cs)$/.test(basename)) return "production_source";
  return "unknown";
}

export function classifyTaskFrameFromTask(task: string, profile: ResolvedPrimeProfile): TaskFrame {
  const text = task.toLowerCase();
  if (/\bswe[- ]?bench|official evaluator|patch task\b/.test(text)) return "official_patch";
  if (isRuntimeProceduralTask(text)) return "runtime_procedural";
  if (/\b(cleanup|clean up|review diff|final diff|summarize changes|verify|verification|typecheck|lint|build)\b/.test(text)) return "verification_cleanup";
  if (/\b(qna|question|answer|inspect|explain|read|open|show|which file|where is|what symbol|repository language|dataset language|source-grounded|source grounded)\b/.test(text)) return "qna_source_grounded";
  if ((profile === "failure_debug" || /\b(debug|failure|failing|regression|stack trace|traceback|exception)\b/.test(text)) &&
    /\b(across|multiple files|multi[-\s]?file|companion|controller|repository|router|adapter|dispatch)\b/.test(text)) {
    return "multi_file_debug";
  }
  if (profile === "failure_debug" || /\b(debug|failure|failing|regression|stack trace|traceback|exception|error)\b/.test(text)) return "failure_first";
  if (/\b(improve|better|stuff|things|general cleanup)\b/.test(text)) return "weak_signal";
  return "source_rescue";
}

export function deterministicPrediction(baseDecision: ContextValueDecision, features: DecisionFeatures): ContextGovernorModelPrediction {
  const top = features.candidates[0];
  const topRisk = top ? top.generatedPenalty + top.testDocPenalty : 0;
  const pUseful = clamp01(
    baseDecision.action === "emit" ? 0.78 :
    baseDecision.action === "shrink" ? 0.62 :
    baseDecision.action === "request_evidence" ? 0.36 :
    0.18
  );
  const pHarm = clamp01(
    (baseDecision.wrongContextRisk ? 0.32 : 0.05) +
    topRisk * 0.35 +
    features.ambiguity * 0.22 +
    (features.staleIndexState ? 0.45 : 0)
  );
  const pNeedMoreEvidence = clamp01(
    (features.taskFrame === "runtime_procedural" ? 0.45 : 0) +
    (features.taskFrame === "weak_signal" ? 0.4 : 0) +
    (features.candidates.length === 0 ? 0.58 : 0) +
    (features.ambiguity > 0.55 ? 0.22 : 0) +
    (features.confidenceGap < 15 && baseDecision.action !== "suppress" ? 0.18 : 0)
  );
  return {
    pUseful,
    pHarm,
    pNeedMoreEvidence,
    suggestedAction: suggestedActionFromProbabilities(baseDecision.action, pUseful, pHarm, pNeedMoreEvidence),
    confidence: clamp01(Math.max(pUseful, pHarm, pNeedMoreEvidence)),
    source: "deterministic"
  };
}

export function linearModelPrediction(features: DecisionFeatures, model: LinearGovernorModel): ContextGovernorModelPrediction {
  const vector = linearVector(features);
  const pUseful = sigmoid(linearScore(vector, model.weights, model.bias ?? 0));
  const pHarm = sigmoid(linearScore(vector, model.harmWeights, model.harmBias ?? -2));
  const pNeedMoreEvidence = sigmoid(linearScore(vector, model.evidenceWeights, model.evidenceBias ?? -2));
  const suggestedAction = suggestedActionFromProbabilities(
    "shrink",
    pUseful - (model.thresholds?.useful ?? 0),
    pHarm - (model.thresholds?.harm ?? 0),
    pNeedMoreEvidence - (model.thresholds?.evidence ?? 0)
  );
  return {
    pUseful,
    pHarm,
    pNeedMoreEvidence,
    suggestedAction,
    confidence: clamp01(Math.max(pUseful, pHarm, pNeedMoreEvidence)),
    source: "linear_model"
  };
}

function chooseGovernedAction(input: {
  baseDecision: ContextValueDecision;
  features: DecisionFeatures;
  deterministic: ContextGovernorModelPrediction;
  modelPrediction: ContextGovernorModelPrediction;
}): {
  action: ContextValueAction;
  score: number;
  reasons: string[];
  evidenceRequest?: EvidenceRequest;
} {
  const { baseDecision, features, deterministic, modelPrediction } = input;
  const hard = hardSafetyDecision(baseDecision, features, deterministic);
  if (hard) return hard;

  if (modelPrediction.source === "linear_model") {
    const downgraded = downgradeOnlyModelDecision(baseDecision.action, modelPrediction.suggestedAction);
    if (downgraded !== baseDecision.action) {
      return {
        action: downgraded,
        score: scoreForAction(baseDecision.score, downgraded),
        reasons: [`calibrated governor downgraded action to ${downgraded}`],
        ...(downgraded === "request_evidence" ? { evidenceRequest: evidenceRequestFor(features) } : {})
      };
    }
  }

  if (modelPrediction.pNeedMoreEvidence >= 0.72 && baseDecision.action !== "suppress" && baseDecision.action !== "request_evidence") {
    return {
      action: "request_evidence",
      score: Math.min(baseDecision.score, 42),
      reasons: ["governor needs one more concrete signal before emitting context"],
      evidenceRequest: evidenceRequestFor(features)
    };
  }

  return {
    action: baseDecision.action,
    score: baseDecision.score,
    reasons: []
  };
}

function hardSafetyDecision(
  baseDecision: ContextValueDecision,
  features: DecisionFeatures,
  prediction: ContextGovernorModelPrediction
): ReturnType<typeof chooseGovernedAction> | undefined {
  const top = features.candidates[0];
  if (features.staleIndexState && baseDecision.action === "emit") {
    return {
      action: "request_evidence",
      score: Math.min(baseDecision.score, 44),
      reasons: ["stale index prevents broad proactive context"],
      evidenceRequest: evidenceRequestFor(features, "changed_file")
    };
  }
  if (features.candidates.length === 0) {
    return {
      action: features.estimatedSearchCost >= 60 ? "request_evidence" : "suppress",
      score: 0,
      reasons: ["governor found no usable source candidates"],
      ...(features.estimatedSearchCost >= 60 ? { evidenceRequest: evidenceRequestFor(features) } : {})
    };
  }
  if (top && (top.role === "generated" || top.role === "vendor_dep") && baseDecision.action !== "suppress") {
    return {
      action: "request_evidence",
      score: Math.min(baseDecision.score, 40),
      reasons: [`top candidate is ${top.role}; refusing to treat it as an edit target`],
      evidenceRequest: evidenceRequestFor(features, "exact_source")
    };
  }
  if (
    (features.taskFrame === "runtime_procedural" || features.taskFrame === "weak_signal") &&
    prediction.pNeedMoreEvidence >= 0.55
  ) {
    return {
      action: "request_evidence",
      score: Math.min(baseDecision.score, 46),
      reasons: [`${features.taskFrame} task needs evidence before source context`],
      evidenceRequest: evidenceRequestFor(features)
    };
  }
  if (
    features.taskFrame === "runtime_procedural" &&
    !baseDecision.exactSourceHit &&
    !baseDecision.sourceRescue &&
    !baseDecision.canonicalSourceHit
  ) {
    return {
      action: "request_evidence",
      score: Math.min(baseDecision.score, 46),
      reasons: ["runtime-procedural task should collect runtime evidence before static source context"],
      evidenceRequest: evidenceRequestFor(features, "runtime_scope")
    };
  }
  if (top && (top.role === "test" || top.role === "docs" || top.role === "example") && !taskExplicitlyAllowsRole(features.taskFrame, top.role)) {
    return {
      action: "request_evidence",
      score: Math.min(baseDecision.score, 44),
      reasons: [`top candidate is ${top.role}; asking for production source evidence first`],
      evidenceRequest: evidenceRequestFor(features, "exact_source")
    };
  }
  if (
    features.ambiguity >= 0.72 &&
    features.estimatedSearchCost >= 55 &&
    baseDecision.action === "emit" &&
    !baseDecision.exactSourceHit &&
    !baseDecision.companionSpecific
  ) {
    return {
      action: "request_evidence",
      score: Math.min(baseDecision.score, 48),
      reasons: ["high ambiguity makes full proactive context risky"],
      evidenceRequest: evidenceRequestFor(features)
    };
  }
  return undefined;
}

function rankedCandidates(input: GovernorInput): GovernorRankedCandidate[] {
  if (input.context.rankedFiles && input.context.rankedFiles.length > 0) {
    return input.context.rankedFiles.map((file) => ({
      path: file.path,
      kind: file.kind,
      score: file.score,
      reasons: file.reasons,
      ...(file.scores ? { scores: file.scores } : {})
    }));
  }
  const ordered = [...input.context.suggestedNextContext, ...input.context.files];
  const seen = new Set<string>();
  return ordered
    .filter((file) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    })
    .map((file, index) => {
      const kind = input.knownFiles.find((record) => record.path === file)?.kind;
      return {
        path: file,
        ...(kind ? { kind } : {}),
        score: index === 0 ? input.quality.topScore : Math.max(0, input.quality.topScore - input.quality.topGap - index),
        reasons: reasonsForFile(input.context, file)
      };
    });
}

function candidateFeatures(input: {
  candidate: ReturnType<typeof rankedCandidates>[number];
  task: string;
  expectedLanguage?: string | undefined;
  record?: FileRecord | undefined;
}): CandidateFeatures {
  const language = input.record?.language ?? languageFromPath(input.candidate.path);
  const role = classifyFileRoleV2(input.candidate.path, input.candidate.kind ?? input.record?.kind);
  const reasonText = input.candidate.reasons.join("; ").toLowerCase();
  return {
    path: input.candidate.path,
    language,
    role,
    score: input.candidate.score,
    lexicalScore: (input.candidate.scores?.keyword ?? 0) + (input.candidate.scores?.bm25 ?? 0),
    graphScore: input.candidate.scores?.graph ?? 0,
    sessionScore: input.candidate.scores?.session ?? 0,
    languageAlignment: !input.expectedLanguage ? 0.5 : language === input.expectedLanguage ? 1 : 0,
    exactMatch: /\b(exact|precise|symbol match|filename match|source rescue|canonical)\b/.test(reasonText) || pathTermsMatchTask(input.candidate.path, input.task),
    generatedPenalty: role === "generated" || role === "vendor_dep" ? 1 : 0,
    testDocPenalty: role === "test" || role === "docs" || role === "example" ? 1 : 0,
    companionEvidence: /\b(companion|neighbor|same package|same module|import|route|controller|repository|dispatch|adapter)\b/.test(reasonText)
      ? 1
      : 0
  };
}

function classifyTaskFrame(input: {
  task: string;
  profile: ResolvedPrimeProfile;
  decision: ContextValueDecision;
  context: ContextResponse;
  candidates: CandidateFeatures[];
  companionCount: number;
  companionTopScore: number;
}): TaskFrame {
  const text = input.task.toLowerCase();
  if (input.context.metadata?.officialEvaluation || /\bswe[- ]?bench|official evaluator|patch task\b/.test(text)) return "official_patch";
  if (isRuntimeProceduralTask(text)) return "runtime_procedural";
  if (/\b(cleanup|clean up|review diff|final diff|summarize changes|verify|verification|typecheck|lint|build)\b/.test(text)) return "verification_cleanup";
  if (/\b(qna|question|answer|inspect|explain|read|open|show|which file|where is|what symbol|repository language|dataset language|source-grounded|source grounded)\b/.test(text)) return "qna_source_grounded";
  if (input.decision.cheapSingleSource || input.decision.cheapExactSource) return "cheap_single_source";
  if (input.decision.exactSourceHit || input.decision.sourceRescue || input.decision.canonicalSourceHit) return "source_rescue";
  if ((input.profile === "failure_debug" || /\b(debug|failure|failing|regression|stack trace|traceback|exception)\b/.test(text)) &&
    (input.decision.multiSurfaceSignal || input.companionCount > 0 || input.companionTopScore >= 420 || /\b(across|multiple files|multi[-\s]?file|companion|controller|repository|router|adapter|dispatch)\b/.test(text))) {
    return "multi_file_debug";
  }
  if (input.profile === "failure_debug" || /\b(debug|failure|failing|regression|stack trace|traceback|exception|error)\b/.test(text)) return "failure_first";
  if (input.decision.easyTaskSignal && input.candidates.length <= 1) return "cheap_single_source";
  if (input.candidates.length === 0 || input.decision.score < 38 || /\b(improve|better|stuff|things|general cleanup)\b/.test(text)) return "weak_signal";
  return "source_rescue";
}

function evidenceRequestFor(features: DecisionFeatures, preferredKind?: EvidenceRequest["kind"]): EvidenceRequest {
  const kind = preferredKind ??
    (features.failureState ? "failure_output" :
      features.taskFrame === "runtime_procedural" ? "runtime_scope" :
      features.verificationState ? "verification_result" :
      features.staleIndexState ? "changed_file" :
      "exact_source");
  const promptByKind: Record<EvidenceRequest["kind"], string> = {
    failure_output: "Provide the smallest failing command output or stack frame that names the production source.",
    exact_source: "Name the exact source file, symbol, or behavior anchor before Kairn sends code context.",
    verification_result: "Run or provide the narrow verification result so Kairn can route from concrete evidence.",
    runtime_scope: "Provide the runtime command/output or clarify whether this needs runtime exploration instead of source context.",
    changed_file: "Refresh or name the changed source file before Kairn emits context from a stale index.",
    clarify_task: "Clarify the target behavior or file before Kairn chooses source context."
  };
  return {
    kind,
    prompt: promptByKind[kind],
    reason: `${features.taskFrame} has ${features.candidates.length} candidate(s), ambiguity ${features.ambiguity.toFixed(2)}, and search cost ${Math.round(features.estimatedSearchCost)}.`
  };
}

function summarizeDecisionFeatures(features: DecisionFeatures): ContextGovernorFeatureSummary {
  const fileRoleCounts: Partial<Record<FileRoleV2, number>> = {};
  for (const candidate of features.candidates) {
    fileRoleCounts[candidate.role] = (fileRoleCounts[candidate.role] ?? 0) + 1;
  }
  const top = features.candidates[0];
  return {
    taskFrame: features.taskFrame,
    candidateCount: features.candidates.length,
    fileRoleCounts,
    repoLanguageMix: features.repoLanguageMix,
    ...(top ? { topRole: top.role, topLanguage: top.language } : {}),
    confidenceGap: Math.round(features.confidenceGap),
    candidateEntropy: round3(features.candidateEntropy),
    ambiguity: round3(features.ambiguity),
    expectedContextCost: Math.round(features.expectedContextCost),
    estimatedSearchCost: Math.round(features.estimatedSearchCost)
  };
}

function loadConfiguredGovernorModel(): LinearGovernorModel | undefined {
  const modelPath = process.env.KAIRN_GOVERNOR_MODEL;
  if (!modelPath) return undefined;
  if (cachedModelPath === modelPath) return cachedModel;
  cachedModelPath = modelPath;
  try {
    cachedModel = JSON.parse(fs.readFileSync(modelPath, "utf8")) as LinearGovernorModel;
  } catch {
    cachedModel = undefined;
  }
  return cachedModel;
}

function downgradeOnlyModelDecision(base: ContextValueAction, suggested: ContextValueAction): ContextValueAction {
  const rank: Record<ContextValueAction, number> = {
    suppress: 0,
    request_evidence: 1,
    shrink: 2,
    emit: 3
  };
  return rank[suggested] < rank[base] ? suggested : base;
}

function suggestedActionFromProbabilities(base: ContextValueAction, pUseful: number, pHarm: number, pNeedMoreEvidence: number): ContextValueAction {
  if (pHarm >= 0.62) return "suppress";
  if (pNeedMoreEvidence >= 0.58) return "request_evidence";
  if (pUseful >= 0.72) return base === "emit" ? "emit" : "shrink";
  if (pUseful >= 0.42) return "shrink";
  return "suppress";
}

function scoreForAction(score: number, action: ContextValueAction): number {
  if (action === "suppress") return Math.min(score, 30);
  if (action === "request_evidence") return Math.min(score, 48);
  if (action === "shrink") return Math.min(score, 67);
  return score;
}

function taskExplicitlyAllowsRole(taskFrame: TaskFrame, role: FileRoleV2): boolean {
  if (role === "test") return taskFrame === "verification_cleanup" || taskFrame === "failure_first" || taskFrame === "qna_source_grounded";
  if (role === "docs" || role === "example") return taskFrame === "qna_source_grounded";
  return false;
}

function languageMix(files: FileRecord[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = file.language || languageFromPath(file.path);
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
}

function expectedTaskLanguage(task: string, context: ContextResponse, repoLanguageMix: Record<string, number>): string | undefined {
  const metadataLanguage = context.metadata?.expectedLanguage ?? context.metadata?.language;
  if (typeof metadataLanguage === "string" && metadataLanguage.length > 0) return normalizeLanguage(metadataLanguage);
  if (/\b(dataset|repository|repo)\s+language\b|\blanguage\s+label\b/i.test(task)) {
    return Object.entries(repoLanguageMix).sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  return undefined;
}

function candidateEntropy(candidates: CandidateFeatures[]): number {
  const total = candidates.reduce((sum, candidate) => sum + Math.max(0, candidate.score), 0);
  if (total <= 0 || candidates.length <= 1) return 0;
  const entropy = candidates.reduce((sum, candidate) => {
    const p = Math.max(0, candidate.score) / total;
    return p > 0 ? sum - p * Math.log2(p) : sum;
  }, 0);
  return entropy / Math.log2(candidates.length);
}

function candidateAmbiguity(candidates: CandidateFeatures[], topGap: number): number {
  if (candidates.length <= 1) return 0;
  const rolePenalty = candidates.slice(0, 3).some((candidate) => candidate.role === "generated" || candidate.role === "vendor_dep" || candidate.role === "test" || candidate.role === "docs")
    ? 0.18
    : 0;
  const gapFactor = topGap >= 120 ? 0 : topGap <= 0 ? 0.45 : (120 - topGap) / 120 * 0.45;
  return clamp01(gapFactor + candidateEntropy(candidates.slice(0, 4)) * 0.45 + rolePenalty);
}

function estimateSearchCost(repoFileCount: number, taskFrame: TaskFrame, candidates: CandidateFeatures[]): number {
  const base = Math.min(100, Math.log10(Math.max(10, repoFileCount)) * 18);
  const frameBoost = taskFrame === "multi_file_debug" || taskFrame === "failure_first" || taskFrame === "runtime_procedural" ? 22 : taskFrame === "weak_signal" ? 14 : 0;
  const candidateDiscount = candidates.some((candidate) => candidate.exactMatch && candidate.role === "production_source") ? 18 : 0;
  return clamp(base + frameBoost - candidateDiscount, 0, 100);
}

function linearVector(features: DecisionFeatures): Record<LinearFeatureName, number> {
  const top = features.candidates[0];
  return {
    candidateCount: features.candidates.length,
    topScore: (top?.score ?? 0) / 1000,
    confidenceGap: features.confidenceGap / 1000,
    ambiguity: features.ambiguity,
    candidateEntropy: features.candidateEntropy,
    expectedContextCost: features.expectedContextCost / 1000,
    estimatedSearchCost: features.estimatedSearchCost / 100,
    failureState: features.failureState ? 1 : 0,
    verificationState: features.verificationState ? 1 : 0,
    staleIndexState: features.staleIndexState ? 1 : 0,
    generatedOrVendorTop: top && (top.role === "generated" || top.role === "vendor_dep") ? 1 : 0,
    testDocTop: top && (top.role === "test" || top.role === "docs" || top.role === "example") ? 1 : 0,
    companionEvidence: top?.companionEvidence ?? 0
  };
}

function linearScore(vector: Record<LinearFeatureName, number>, weights: LinearGovernorModel["weights"], bias: number): number {
  let score = bias;
  for (const [key, value] of Object.entries(vector) as Array<[LinearFeatureName, number]>) {
    score += value * (weights?.[key] ?? 0);
  }
  return score;
}

function reasonsForFile(context: ContextResponse, filePath: string): string[] {
  const ranked = context.rankedFiles?.find((file) => file.path === filePath);
  if (ranked) return ranked.reasons;
  const line = context.content.split(/\r?\n/).find((entry) => entry.includes(filePath) && entry.includes("):"));
  if (!line) return [];
  return line
    .split("):")
    .slice(1)
    .join("):")
    .split(";")
    .map((reason) => reason.trim())
    .filter(Boolean);
}

function pathTermsMatchTask(filePath: string, task: string): boolean {
  const basename = filePath.split("/").at(-1) ?? filePath;
  const pathTerms = terms(basename).filter((term) => term.length > 2);
  const taskTerms = new Set(terms(task));
  return pathTerms.filter((term) => taskTerms.has(term)).length >= 2;
}

function terms(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function languageFromPath(filePath: string): string {
  const normalized = filePath.toLowerCase();
  if (/\.(ts|tsx)$/.test(normalized)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(normalized)) return "javascript";
  if (/\.pyi?$/.test(normalized)) return "python";
  if (/\.java$/.test(normalized)) return "java";
  if (/\.(cc|cpp|cxx|hpp|hh|hxx)$/.test(normalized)) return "cpp";
  if (/\.(c|h)$/.test(normalized)) return "c";
  if (/\.go$/.test(normalized)) return "go";
  if (/\.rb$/.test(normalized)) return "ruby";
  return "unknown";
}

function normalizeLanguage(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "ts" || normalized === "tsx") return "typescript";
  if (normalized === "js" || normalized === "jsx") return "javascript";
  if (normalized === "py") return "python";
  if (normalized === "cc" || normalized === "cxx") return "cpp";
  return normalized;
}

function isRuntimeProceduralTask(text: string): boolean {
  const asksForRuntimeObservation =
    /\b(how many|what happens (?:when|during)|runtime|execute|environment|config value|database state|server response|api response|latency|performance)\b/.test(text) ||
    /\b(run|build|start|launch|execute|measure|observe|create|instantiate)\b.{0,80}\b(command|test|tests|scan|server|application|packets?|script|fixture|wall-clock|time|output|logs?|dashboard|messages?|startup)\b/.test(text) ||
    /\b(what should i see|what do i see|what initialization messages|startup messages|logs? or dashboard|computed destination|temporary scripts?|in memory)\b/.test(text);
  return asksForRuntimeObservation && !/\b(fix|patch|edit|change production|source file)\b/.test(text);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}
