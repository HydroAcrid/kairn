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
    expect(audit.candidateComparison.missingSemanticCases).toHaveLength(11);
    expect(audit.data.failures).toContain("Semantic candidate reconstruction is not marked complete.");
    expect(audit.modelMetrics).toHaveLength(2);
    expect(audit.modelMetrics.every((metric) => metric.expectedCalibrationError.denominator > 0)).toBe(true);
    expect(audit.data.valid).toBe(false);
    expect(audit.classification).toBe("data_invalid");
  });
});
