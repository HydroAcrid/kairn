// SPDX-License-Identifier: Apache-2.0

import type {
  ContextShownRecord,
  EvidenceCandidate,
  EvidenceDelivery,
  EvidenceRankerArtifact,
  EvidenceRankerStatus,
  FileRecord,
  GraphEdgeRecord,
  HybridScoredResult,
  RankerConfig,
  SemanticChunkRecord,
  SymbolRecord
} from "../types.js";
import {
  BUNDLED_EVIDENCE_ARTIFACT,
  EVIDENCE_FEATURE_SCHEMA_VERSION,
  loadEvidenceRankerArtifact,
  predictEvidenceRelevance
} from "./evidenceModel.js";
import { buildEvidenceCandidates } from "./evidenceSignals.js";

export type EvidenceRankingInput = {
  files: FileRecord[];
  query: string;
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  edges: GraphEdgeRecord[];
  legacyResults: HybridScoredResult[];
  /** Broader legacy candidates used only to build features in shadow/calibrated modes. */
  candidateResults?: HybridScoredResult[];
  shown?: ContextShownRecord[];
  changedFiles?: Set<string>;
};

export type EvidenceRankingResult = {
  files: HybridScoredResult[];
  status: EvidenceRankerStatus;
};

export function resolveRankerConfig(config?: RankerConfig): RankerConfig {
  if (config) return validateRankerConfig(config);
  const mode = process.env.KAIRN_RANKER_MODE?.trim() || "legacy";
  const modelPath = process.env.KAIRN_RANKER_MODEL?.trim();
  return validateRankerConfig({
    mode: mode as RankerConfig["mode"],
    ...(modelPath ? { modelPath } : {})
  });
}

export function rankEvidenceResults(
  input: EvidenceRankingInput,
  requestedConfig?: RankerConfig
): EvidenceRankingResult {
  const config = resolveRankerConfig(requestedConfig);
  if (config.mode === "legacy") {
    return {
      files: input.legacyResults,
      status: {
        requestedMode: "legacy",
        servedMode: "legacy",
        modelId: "legacy-hybrid",
        featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION
      }
    };
  }

  const candidateSet = buildEvidenceCandidates({
    files: input.files,
    query: input.query,
    symbols: input.symbols,
    edges: input.edges,
    legacyResults: input.candidateResults ?? input.legacyResults,
    ...(input.shown ? { shown: input.shown } : {}),
    ...(input.changedFiles ? { changedFiles: input.changedFiles } : {})
  });
  const artifactResult = resolveArtifact(config);
  if (!artifactResult.artifact) {
    return rankWithFallback(input, candidateSet.candidates, config, artifactResult.error);
  }

  const ranked = candidateSet.candidates
    .map((candidate) => ({
      candidate,
      probability: predictEvidenceRelevance(artifactResult.artifact!, candidate.features).relevanceProbability
    }))
    .sort((left, right) => right.probability - left.probability || left.candidate.path.localeCompare(right.candidate.path));
  const annotated = annotateRanked(input, ranked, artifactResult.artifact, config.mode);

  if (config.mode === "shadow") {
    const annotations = new Map(annotated.map((file) => [file.path, file]));
    return {
      files: input.legacyResults.map((file) => {
        const annotation = annotations.get(file.path);
        return annotation
          ? copyEvidenceAnnotation(file, annotation, "shadow")
          : file;
      }),
      status: {
        requestedMode: "shadow",
        servedMode: "shadow",
        modelId: artifactResult.artifact.modelId,
        featureSchemaVersion: artifactResult.artifact.featureSchemaVersion
      }
    };
  }

  const topProbability = ranked[0]?.probability ?? 0;
  const hardEvidencePresent = annotated.some((file) => hasHardEvidence(file));
  const files = topProbability < artifactResult.artifact.decisionThresholds.abstain && !hardEvidencePresent
    ? []
    : [...annotated]
        .filter((file) =>
          (file.relevanceProbability ?? 0) >= artifactResult.artifact!.decisionThresholds.pathHint || hasHardEvidence(file)
        )
        .sort((left, right) =>
          hardEvidencePriority(right) - hardEvidencePriority(left) ||
          (right.relevanceProbability ?? 0) - (left.relevanceProbability ?? 0) ||
          left.path.localeCompare(right.path)
        );
  return {
    files,
    status: {
      requestedMode: "calibrated",
      servedMode: "calibrated",
      modelId: artifactResult.artifact.modelId,
      featureSchemaVersion: artifactResult.artifact.featureSchemaVersion
    }
  };
}

function annotateRanked(
  input: EvidenceRankingInput,
  ranked: Array<{ candidate: EvidenceCandidate; probability: number }>,
  artifact: EvidenceRankerArtifact,
  mode: "shadow" | "calibrated"
): HybridScoredResult[] {
  const legacyByPath = new Map(input.legacyResults.map((file) => [file.path, file]));
  for (const file of input.candidateResults ?? []) {
    if (!legacyByPath.has(file.path)) legacyByPath.set(file.path, file);
  }
  const filesByPath = new Map(input.files.map((file) => [file.path, file]));
  const chunksByPath = groupChunks(input.chunks);

  return ranked.map((item, index) => {
    const nextProbability = ranked[index + 1]?.probability ?? 0;
    const legacy = legacyByPath.get(item.candidate.path);
    const base = legacy ?? synthesizeResult(
      filesByPath.get(item.candidate.path)!,
      item.candidate,
      chunksByPath.get(item.candidate.path) ?? [],
      item.probability
    );
    return {
      ...base,
      relevanceProbability: roundProbability(item.probability),
      probabilityGap: roundProbability(Math.max(0, item.probability - nextProbability)),
      rankerModelId: artifact.modelId,
      featureSchemaVersion: artifact.featureSchemaVersion,
      evidenceReasons: item.candidate.reasons,
      delivery: deliveryFor(item.probability, artifact),
      rankerMode: mode
    };
  });
}

function rankWithFallback(
  input: EvidenceRankingInput,
  candidates: EvidenceCandidate[],
  config: RankerConfig,
  error: string
): EvidenceRankingResult {
  const ranked = candidates
    .map((candidate) => ({ candidate, priority: fallbackPriority(candidate) }))
    .sort((left, right) => right.priority - left.priority || left.candidate.path.localeCompare(right.candidate.path));
  const filesByPath = new Map(input.files.map((file) => [file.path, file]));
  const legacyByPath = new Map(input.legacyResults.map((file) => [file.path, file]));
  for (const file of input.candidateResults ?? []) {
    if (!legacyByPath.has(file.path)) legacyByPath.set(file.path, file);
  }
  const chunksByPath = groupChunks(input.chunks);
  const annotated = ranked.map((item, index) => {
    const probability = fallbackProbability(item.priority);
    const nextProbability = fallbackProbability(ranked[index + 1]?.priority ?? 0);
    const legacy = legacyByPath.get(item.candidate.path);
    const base = legacy ?? synthesizeResult(
      filesByPath.get(item.candidate.path)!,
      item.candidate,
      chunksByPath.get(item.candidate.path) ?? [],
      probability
    );
    return {
      ...base,
      relevanceProbability: roundProbability(probability),
      probabilityGap: roundProbability(Math.max(0, probability - nextProbability)),
      rankerModelId: "deterministic-evidence-fallback-v1",
      featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
      evidenceReasons: item.candidate.reasons,
      delivery: probability >= 0.72 ? "content" as const : "path_hint" as const,
      rankerMode: "fallback" as const,
      rankerFallbackReason: error
    };
  });

  const servedFiles = config.mode === "shadow"
    ? input.legacyResults.map((file) => {
        const annotation = annotated.find((candidate) => candidate.path === file.path);
        return annotation ? copyEvidenceAnnotation(file, annotation, "fallback") : file;
      })
    : annotated
        .filter((file) => (file.relevanceProbability ?? 0) >= 0.42 || hasHardEvidence(file))
        .sort((left, right) =>
          hardEvidencePriority(right) - hardEvidencePriority(left) ||
          (right.relevanceProbability ?? 0) - (left.relevanceProbability ?? 0) ||
          left.path.localeCompare(right.path)
        );
  return {
    files: servedFiles,
    status: {
      requestedMode: config.mode,
      servedMode: "fallback",
      modelId: "deterministic-evidence-fallback-v1",
      featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
      fallbackReason: error
    }
  };
}

function validateRankerConfig(config: RankerConfig): RankerConfig {
  if (!(["legacy", "shadow", "calibrated"] as const).includes(config.mode)) {
    throw new Error(`Invalid Kairn ranker mode: ${String(config.mode)}.`);
  }
  if (config.modelPath && /^[a-z][a-z0-9+.-]*:\/\//i.test(config.modelPath)) {
    throw new Error("Kairn ranker modelPath must be a local filesystem path.");
  }
  return { ...config };
}

function resolveArtifact(config: RankerConfig): { artifact?: EvidenceRankerArtifact; error: string } {
  if (!config.modelPath) {
    if (config.mode === "calibrated") {
      return {
        error: "Calibrated serving requires an explicit promoted local model artifact; the bundled bootstrap is shadow-only."
      };
    }
    return { artifact: BUNDLED_EVIDENCE_ARTIFACT, error: "" };
  }
  try {
    return { artifact: loadEvidenceRankerArtifact(config.modelPath), error: "" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function synthesizeResult(
  file: FileRecord,
  candidate: EvidenceCandidate,
  chunks: SemanticChunkRecord[],
  probability: number
): HybridScoredResult {
  return {
    ...file,
    // Compatibility only for a candidate the legacy scorer omitted. Existing
    // results retain their old score and component meanings.
    score: Math.round(probability * 1000),
    reasons: candidate.reasons.map((reason) => `evidence: ${reason.replaceAll("_", " ")}`),
    semanticScore: 0,
    keywordScore: 0,
    bm25Score: 0,
    behaviorScore: 0,
    graphScore: 0,
    intentScore: 0,
    sessionScore: 0,
    importanceScore: file.importance,
    gitScore: 0,
    chunks
  };
}

function copyEvidenceAnnotation(
  legacy: HybridScoredResult,
  annotation: HybridScoredResult,
  mode: "shadow" | "fallback"
): HybridScoredResult {
  return {
    ...legacy,
    ...(annotation.relevanceProbability !== undefined ? { relevanceProbability: annotation.relevanceProbability } : {}),
    ...(annotation.probabilityGap !== undefined ? { probabilityGap: annotation.probabilityGap } : {}),
    ...(annotation.rankerModelId ? { rankerModelId: annotation.rankerModelId } : {}),
    ...(annotation.featureSchemaVersion ? { featureSchemaVersion: annotation.featureSchemaVersion } : {}),
    ...(annotation.evidenceReasons ? { evidenceReasons: annotation.evidenceReasons } : {}),
    ...(annotation.delivery ? { delivery: annotation.delivery } : {}),
    rankerMode: mode,
    ...(annotation.rankerFallbackReason ? { rankerFallbackReason: annotation.rankerFallbackReason } : {})
  };
}

function fallbackPriority(candidate: EvidenceCandidate): number {
  const reasons = new Set(candidate.reasons);
  let priority = 0;
  if (reasons.has("failure_reference")) priority += 120;
  if (reasons.has("exact_path")) priority += 110;
  if (reasons.has("basename")) priority += 70;
  if (reasons.has("exact_symbol")) priority += 95;
  if (reasons.has("symbol_prefix")) priority += 55;
  if (reasons.has("lexical")) priority += 40;
  if (reasons.has("git_diff")) priority += 30;
  if (reasons.has("source_test_pair")) priority += 25;
  else if (reasons.has("graph_neighbor")) priority += 15;
  if (reasons.has("role_match")) priority += 12;
  if (reasons.has("already_delivered")) priority -= 15;
  if (reasons.has("generated_vendor")) priority -= 150;
  return priority;
}

function hasHardEvidence(file: HybridScoredResult): boolean {
  return hardEvidencePriority(file) > 0;
}

function hardEvidencePriority(file: HybridScoredResult): number {
  if (file.evidenceReasons?.includes("failure_reference")) return 2;
  if (file.evidenceReasons?.includes("exact_path")) return 1;
  return 0;
}

function fallbackProbability(priority: number): number {
  return Math.max(0.02, Math.min(0.98, 0.12 + priority / 180));
}

function deliveryFor(probability: number, artifact: EvidenceRankerArtifact): EvidenceDelivery {
  return probability >= artifact.decisionThresholds.content ? "content" : "path_hint";
}

function groupChunks(chunks: SemanticChunkRecord[]): Map<string, SemanticChunkRecord[]> {
  const grouped = new Map<string, SemanticChunkRecord[]>();
  for (const chunk of chunks) {
    grouped.set(chunk.filePath, [...(grouped.get(chunk.filePath) ?? []), chunk]);
  }
  return grouped;
}

function roundProbability(value: number): number {
  return Number(value.toFixed(6));
}
