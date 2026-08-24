// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { loadEvidenceRankerArtifact, predictEvidenceRelevance } from "../retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES, type EvidenceFeatureVector } from "../types.js";

type ProbeRow = {
  caseGroupId: string;
  split: string;
  language: string;
  scenario: string;
  candidatePath: string;
  label: 0 | 1;
  labelProvenance: string;
  features: number[];
};

export type RankabilityAudit = {
  schemaVersion: "rankability-audit.v1";
  promotionEligible: false;
  split: "calibration";
  rowSource: string;
  models: string[];
  caseCount: number;
  reviewedOracleCaseCount: number;
  failureCounts: Record<string, number>;
  cases: Array<{
    id: string;
    language: string;
    scenario: string;
    oracleKind: "reviewed_required_source" | "weak_patch_only" | "none";
    models: Array<{
      modelId: string;
      positiveRanks: Array<{ path: string; rank: number; provenance: string }>;
      missesAt5: string[];
      missesAt64: string[];
      higherRankedNegatives: Array<{ path: string; rank: number; outranksPositive: string; differingFeatures: string[] }>;
      diagnosis: "candidate_coverage" | "label_quality" | "feature_collision" | "linear_ordering" | "ranked";
    }>;
  }>;
};

export function buildRankabilityAudit(input: { rowsPath: string; modelPaths: string[] }): RankabilityAudit {
  const rows = fs.readFileSync(input.rowsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((line, index) => parseRow(JSON.parse(line) as unknown, index))
    .filter((row) => row.split === "calibration");
  const artifacts = input.modelPaths.map((modelPath) => loadEvidenceRankerArtifact(modelPath));
  const groups = new Map<string, ProbeRow[]>();
  for (const row of rows) groups.set(row.caseGroupId, [...(groups.get(row.caseGroupId) ?? []), row]);
  const failureCounts: Record<string, number> = {};
  const cases = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, caseRows]) => {
    const positives = caseRows.filter((row) => row.label === 1);
    const reviewed = positives.filter((row) => row.labelProvenance === "required_source_oracle");
    const oracleKind = reviewed.length > 0 ? "reviewed_required_source" as const : positives.length > 0 ? "weak_patch_only" as const : "none" as const;
    const models = artifacts.map((artifact) => {
      const ranked = caseRows.map((row) => ({
        row,
        probability: predictEvidenceRelevance(artifact, featureVector(row.features)).relevanceProbability
      })).sort((left, right) => right.probability - left.probability || left.row.candidatePath.localeCompare(right.row.candidatePath));
      const positiveRanks = positives.map((positive) => ({
        path: positive.candidatePath,
        rank: ranked.findIndex((item) => item.row.candidatePath === positive.candidatePath) + 1,
        provenance: positive.labelProvenance
      })).sort((left, right) => left.rank - right.rank);
      const missesAt5 = positiveRanks.filter((item) => item.rank < 1 || item.rank > 5).map((item) => item.path);
      const missesAt64 = positiveRanks.filter((item) => item.rank < 1 || item.rank > 64).map((item) => item.path);
      const highestPositive = positiveRanks[0];
      const positiveRow = highestPositive ? caseRows.find((row) => row.candidatePath === highestPositive.path) : undefined;
      const higherRankedNegatives = highestPositive && positiveRow
        ? ranked.slice(0, Math.max(0, highestPositive.rank - 1)).filter((item) => item.row.label === 0).slice(0, 10).map((item, index) => ({
            path: item.row.candidatePath, rank: index + 1, outranksPositive: highestPositive.path,
            differingFeatures: differingFeatures(positiveRow.features, item.row.features)
          }))
        : [];
      const diagnosis = positives.length === 0 ? "candidate_coverage" as const
        : oracleKind === "weak_patch_only" ? "label_quality" as const
          : positiveRanks.every((item) => item.rank <= 5) ? "ranked" as const
            : higherRankedNegatives.some((item) => item.differingFeatures.length === 0) ? "feature_collision" as const
              : "linear_ordering" as const;
      failureCounts[diagnosis] = (failureCounts[diagnosis] ?? 0) + 1;
      return { modelId: artifact.modelId, positiveRanks, missesAt5, missesAt64, higherRankedNegatives, diagnosis };
    });
    return { id, language: caseRows[0]!.language, scenario: caseRows[0]!.scenario, oracleKind, models };
  });
  return {
    schemaVersion: "rankability-audit.v1", promotionEligible: false, split: "calibration",
    rowSource: input.rowsPath, models: artifacts.map((artifact) => artifact.modelId),
    caseCount: cases.length, reviewedOracleCaseCount: cases.filter((item) => item.oracleKind === "reviewed_required_source").length,
    failureCounts, cases
  };
}

function featureVector(values: number[]): EvidenceFeatureVector {
  if (values.length !== EVIDENCE_FEATURE_NAMES.length || values.some((value) => !Number.isFinite(value))) throw new Error("probe feature vector does not match the runtime schema");
  return Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name, index) => [name, values[index]!])) as EvidenceFeatureVector;
}
function differingFeatures(left: number[], right: number[]): string[] { return EVIDENCE_FEATURE_NAMES.filter((_, index) => Math.abs((left[index] ?? 0) - (right[index] ?? 0)) > 1e-9); }
function parseRow(value: unknown, index: number): ProbeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`probe row ${index + 1} must be an object`);
  const row = value as Partial<ProbeRow>;
  if (typeof row.caseGroupId !== "string" || typeof row.candidatePath !== "string" || typeof row.language !== "string" || typeof row.scenario !== "string" || typeof row.split !== "string" || typeof row.labelProvenance !== "string" || !Array.isArray(row.features) || (row.label !== 0 && row.label !== 1)) {
    throw new Error(`probe row ${index + 1} is invalid`);
  }
  return row as ProbeRow;
}
