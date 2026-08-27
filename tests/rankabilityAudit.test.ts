// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRankabilityAudit } from "../src/bench/rankabilityAudit.js";
import type { RankabilityInput } from "../src/bench/rankabilityInput.js";
import { EVIDENCE_FEATURE_NAMES } from "../src/types.js";

const modelPaths = [
  "artifacts/kairn-evidence-v02c-semantic-v166-candidate.json",
  "artifacts/kairn-evidence-v02c-semantic-v170-reviewed-probe512-candidate.json"
];

describe("rankability audit v2", () => {
  it("classifies every mechanism without turning unreviewed candidates into false positives", () => {
    const input = fixtureInput();
    const audit = build(input);
    const causes = Object.fromEntries(audit.cases[0]!.requiredFiles.map((file) => [file.path, file.primaryCause]));
    expect(causes).toEqual({
      "coverage.ts": "candidate_coverage",
      "label.ts": "label_quality",
      "collision.ts": "feature_representation",
      "capacity.ts": "unresolved",
      "ranked.ts": "ranked",
      "unresolved.ts": "unresolved"
    });
    expect(audit.cases[0]!.requiredFiles.find((file) => file.path === "capacity.ts")?.contributingCauses).toContain("model_capacity");
    expect(audit.data.valid).toBe(false);
    expect(audit.classification).toBe("data_invalid");
  });

  it("uses model_capacity only when the higher-ranked contrast is reviewed", () => {
    const input = fixtureInput();
    const item = input.cases[0]!;
    item.candidates = item.candidates.filter((candidate) => candidate.path !== "a-unreviewed.ts");
    item.stages.bounded128 = item.stages.bounded128.filter((candidate) => candidate !== "a-unreviewed.ts");
    const capacity = build(input).cases[0]!.requiredFiles.find((file) => file.path === "capacity.ts");
    expect(capacity?.primaryCause).toBe("model_capacity");
  });

  it("makes score contributions add back to the raw logit", () => {
    const audit = build(fixtureInput());
    for (const file of audit.cases[0]!.requiredFiles) {
      for (const model of file.models) {
        if (model.rawScore === null) continue;
        const reconstructed = model.intercept + model.contributions.reduce((sum, value) => sum + value.contribution, 0);
        expect(reconstructed).toBeCloseTo(model.rawScore, 7);
      }
    }
  });

  it("produces deterministic paired intervals and diagnostics", () => {
    const input = fixtureInput();
    expect(build(input).modelComparison).toEqual(build(input).modelComparison);
    expect(build(input).diagnosticCeilings).toEqual(build(input).diagnosticCeilings);
  });

  it("rejects any input claiming the detached holdout was opened", () => {
    const input = fixtureInput();
    (input as unknown as { detachedHoldoutOpened: boolean }).detachedHoldoutOpened = true;
    expect(() => build(input as RankabilityInput)).toThrow("invalid rankability-input.v2");
  });

  it("rejects a model not pinned by the input", () => {
    const input = fixtureInput();
    input.models[0]!.checksum = "0".repeat(64);
    expect(() => build(input)).toThrow("does not match the frozen audit input");
  });
});

function build(input: RankabilityInput) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-rankability-"));
  const inputPath = path.join(root, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(input));
  return buildRankabilityAudit({
    inputPath,
    modelPaths,
    infrastructureValid: true,
    campaignFingerprint: "a".repeat(64),
    infrastructureReportSha256: "b".repeat(64)
  });
}

function fixtureInput(): RankabilityInput {
  const models = modelPaths.map((modelPath) => {
    const value = JSON.parse(fs.readFileSync(modelPath, "utf8")) as { modelId: string; checksum: string };
    return { id: value.modelId, checksum: value.checksum, path: modelPath };
  });
  const zero = () => EVIDENCE_FEATURE_NAMES.map(() => 0);
  const withFeature = (feature: (typeof EVIDENCE_FEATURE_NAMES)[number], value: number) => {
    const features = zero(); features[EVIDENCE_FEATURE_NAMES.indexOf(feature)] = value; return features;
  };
  const collision = withFeature("semantic", 0.4);
  const candidates = [
    candidate("label.ts", withFeature("semantic", 0.1), 0, "explicit_noise_or_excluded"),
    candidate("a-collision-negative.ts", collision, 0, "explicit_noise_or_excluded"),
    candidate("collision.ts", collision, 1, "required_source_oracle"),
    candidate("capacity.ts", withFeature("semantic", 0), 1, "required_source_oracle"),
    candidate("a-capacity-negative.ts", withFeature("semantic", 1), 0, "explicit_noise_or_excluded"),
    ...Array.from({ length: 5 }, (_, index) => candidate(`a-dummy-${index}.ts`, withFeature("exactPath", 1), 0, "explicit_noise_or_excluded")),
    candidate("ranked.ts", withFeature("failureReference", 1), 1, "required_source_oracle"),
    candidate("unresolved.ts", withFeature("semantic", 0.02), 1, "required_source_oracle"),
    candidate("a-unreviewed.ts", withFeature("semantic", 0.9), null, null)
  ];
  const bounded = candidates.map((candidate) => candidate.path);
  return {
    schemaVersion: "rankability-input.v2",
    promotionEligible: false,
    detachedHoldoutOpened: false,
    featureSchemaVersion: "evidence-features-v4",
    provenance: {
      sourceManifest: artifact("manifest"), sourceReport: artifact("report"), oracleCaseSet: artifact("oracle"),
      deterministicOracleReport: artifact("legacy"), semanticOracleProgress: artifact("semantic"),
      rankerCandidateGeneratorCommit: "c".repeat(40),
      semanticOracleGeneratorCommit: "d".repeat(40),
      semanticOracleComplete: true,
      semanticOracleSelectedCases: 38,
      sourceReconstructionExact: true
    },
    models,
    cohortCounts: { candidateOracleExpected: 38, candidateOracleMaterialized: 0, requiredSourceCases: 1, requiredSourceFiles: 6, weakPatchCalibrationCases: 1 },
    candidateOracle: [],
    cases: [{
      id: "case-a", cohorts: ["required_source", "weak_patch_calibration"], split: "calibration", language: "typescript", scenario: "source_localization",
      repositoryLineageId: "lineage-a", repositoryUrl: "https://example.com/repo", repositoryRef: "d".repeat(40), querySha256: "e".repeat(64),
      requiredFiles: ["coverage.ts", "label.ts", "collision.ts", "capacity.ts", "ranked.ts", "unresolved.ts"].map((file) => ({ path: file, provenance: "required_source_oracle" as const, contentSha256: "f".repeat(64), contentHashStatus: "verified" as const })),
      officialPatchFiles: ["ranked.ts"],
      stages: { inventoryAvailable: bounded, probe: bounded, initial64: bounded, bounded128: bounded },
      lanes: { semanticRaw: bounded, semantic: bounded, semanticEvidence: bounded, bm25: bounded, graph: [], graphImporter: [], graphConsensus: [] },
      candidates
    }]
  };
}

function candidate(pathname: string, features: number[], label: 0 | 1 | null, provenance: string | null) {
  return { path: pathname, gitBlobOid: "a".repeat(40), features, label, labelState: label === 1 ? "positive" as const : label === 0 ? "negative" as const : "unreviewed" as const, labelProvenance: provenance, labelWeight: label === null ? null : 1 };
}

function artifact(name: string) { return { path: name, sha256: "1".repeat(64), bytes: 1 }; }
