// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareSemanticDocumentEvaluations } from "../scripts/compare-semantic-document-evaluations.js";

describe("semantic document evaluation comparison", () => {
  it("produces deterministic case-paired intervals and classifies a gated improvement", () => {
    const fixture = createFixture();
    try {
      const first = compare(fixture);
      const second = compare(fixture);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        schemaVersion: "semantic-document-evaluation-comparison.v1",
        samePoolVerified: true,
        classification: "completed_positive",
        gates: { hardGatesPass: true, noninferior: true },
        requiredSourceDiagnostic: {
          cases: 1,
          requiredFiles: 1,
          metrics: {
            recallAt5: { baseline: 0, candidate: 1, delta: 1, paired95Ci: [1, 1] }
          }
        }
      });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects different candidate pools and paired case populations", () => {
    const fixture = createFixture();
    try {
      const candidate = JSON.parse(fs.readFileSync(fixture.candidatePath, "utf8"));
      candidate.inputs.candidateReportSha256 = "f".repeat(64);
      fs.writeFileSync(fixture.candidatePath, JSON.stringify(candidate));
      expect(() => compare(fixture)).toThrow("candidateReportSha256 differs");

      writeEvaluation(fixture.candidatePath, 5, "different-case");
      expect(() => compare(fixture)).toThrow("case populations differ");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("allows only an explicitly hash-bound controlled feature extension", () => {
    const fixture = createFixture();
    try {
      const baseline = JSON.parse(fs.readFileSync(fixture.baselinePath, "utf8"));
      const candidate = JSON.parse(fs.readFileSync(fixture.candidatePath, "utf8"));
      candidate.featureSchema = { base: ["semantic"], added: ["learnedRelevance"] };
      candidate.controlledFeatureExperiment = {
        baselineFeatureSchemaSha256: crypto
          .createHash("sha256")
          .update('{"added":[],"base":["semantic"]}')
          .digest("hex"),
        unchangedFrozenInputs: true,
        addedFeatures: ["learnedRelevance"]
      };
      fs.writeFileSync(fixture.candidatePath, JSON.stringify(candidate));
      expect(compare(fixture)).toMatchObject({ samePoolVerified: true });

      delete candidate.controlledFeatureExperiment;
      fs.writeFileSync(fixture.candidatePath, JSON.stringify(candidate));
      expect(() => compare(fixture)).toThrow("candidate.controlledFeatureExperiment");

      candidate.controlledFeatureExperiment = {
        baselineFeatureSchemaSha256: "f".repeat(64),
        unchangedFrozenInputs: true,
        addedFeatures: ["learnedRelevance"]
      };
      fs.writeFileSync(fixture.candidatePath, JSON.stringify(candidate));
      expect(() => compare(fixture)).toThrow("baseline schema hash differs");
      expect(baseline.featureSchema).toEqual({ base: ["semantic"], added: [] });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function compare(fixture: ReturnType<typeof createFixture>): Record<string, unknown> {
  return compareSemanticDocumentEvaluations({
    baselinePath: fixture.baselinePath,
    candidatePath: fixture.candidatePath,
    outPath: path.join(fixture.root, "comparison.json"),
    bootstrapSamples: 100,
    bootstrapSeed: 42
  });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-comparison-"));
  const baselinePath = path.join(root, "baseline.json");
  const candidatePath = path.join(root, "candidate.json");
  writeEvaluation(baselinePath, 10, "case-a");
  writeEvaluation(candidatePath, 5, "case-a");
  return { root, baselinePath, candidatePath };
}

function writeEvaluation(target: string, rank: number, id: string): void {
  const cohort = {
    recallAt64: rank <= 64 ? 1 : 0,
    generatedVendorTopOneViolations: [],
    caseRows: [{ id, language: "go", scenario: "source_localization", ranks: { "src/required.go": rank } }]
  };
  fs.writeFileSync(target, JSON.stringify({
    schemaVersion: "semantic-document-feature-diagnostic.v1",
    promotionEligible: false,
    samePoolVerified: true,
    inputs: {
      baselineManifestSha256: "a".repeat(64),
      candidateManifestSha256: "b".repeat(64),
      candidateReportSha256: "c".repeat(64)
    },
    featureSchema: { base: ["semantic"], added: [] },
    calibrationEce: 0.02,
    weakPatchCalibration: cohort,
    requiredSourceDiagnostic: cohort
  }));
}
