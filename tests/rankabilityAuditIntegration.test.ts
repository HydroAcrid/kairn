// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildRankabilityAudit } from "../src/bench/rankabilityAudit.js";

describe("frozen v0.2C-R audit input", () => {
  it("reconstructs the required-source and calibration cohorts on one candidate pool", () => {
    const audit = buildRankabilityAudit({
      inputPath: "artifacts/rankability-input.v2.json",
      modelPaths: [
        "artifacts/kairn-evidence-v02c-semantic-v166-candidate.json",
        "artifacts/kairn-evidence-v02c-semantic-v170-reviewed-probe512-candidate.json"
      ],
      infrastructureValid: true,
      campaignFingerprint: "a".repeat(64),
      infrastructureReportSha256: "b".repeat(64)
    });
    expect(audit.cohorts.requiredSource).toMatchObject({ cases: 10, requiredFiles: 17 });
    expect(audit.cohorts.weakPatchCalibration.cases).toBe(45);
    expect(audit.candidateComparison.expectedCases).toBe(38);
    expect(audit.candidateComparison.missingSemanticCases).toHaveLength(0);
    expect(audit.candidateComparison.deterministic.strictFullRecallAt64).toMatchObject({ numerator: 26, denominator: 38 });
    expect(audit.candidateComparison.semantic?.strictFullRecallAt64).toMatchObject({ numerator: 28, denominator: 38 });
    expect(audit.candidateComparison.deltas?.strictFullRecallAt64.percentagePointDelta).toBeCloseTo(5.2631579, 6);
    expect(Object.keys(audit.candidateComparison.perLanguage)).toHaveLength(5);
    expect(Object.keys(audit.candidateComparison.perScenario)).toHaveLength(3);
    expect(audit.modelMetrics).toHaveLength(2);
    expect(audit.recordedBaselines).toHaveLength(4);
    expect(audit.calibrationModelMetrics[0]?.requiredFileRecallAt5).toMatchObject({ numerator: 55, denominator: 72 });
    expect(audit.calibrationModelMetrics[1]?.requiredFileRecallAt5).toMatchObject({ numerator: 50, denominator: 72 });
    expect(audit.calibrationModelComparison?.recallAt5.percentagePointDelta).toBeCloseTo(-6.9444445, 6);
    expect(Object.keys(audit.calibrationModelComparison?.perLanguage ?? {})).toHaveLength(5);
    expect(Object.keys(audit.calibrationModelComparison?.perScenario ?? {})).toHaveLength(3);
    expect(audit.modelMetrics.every((metric) => metric.expectedCalibrationError.denominator > 0)).toBe(true);
    expect(audit.data.valid).toBe(true);
    expect(audit.classification).toBe("completed_negative");
    expect(audit.nextExperiment.kind).toBe("candidate_generation");
  });
});
