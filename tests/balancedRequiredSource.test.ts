// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateBalancedRequiredSource, formatBalancedRequiredSourceMarkdown } from "../src/bench/balancedRequiredSource.js";

const cohortPath = "benchmarks/cohorts/v02c-balanced-required-source.v1.json";
const frozenEvaluation = evaluateBalancedRequiredSource({ cohortPath });

describe("balanced required-source stopping discipline", () => {
  it("evaluates exactly one frozen calibration case per language/scenario cell", () => {
    const value = frozenEvaluation;
    expect(value.validation).toMatchObject({
      valid: true,
      exactCellCoverage: true,
      deterministicSelectionVerified: true,
      calibrationOnly: true,
      holdoutAccessed: false,
      allRequiredFilesInBoundedPool: true
    });
    expect(value.metrics).toMatchObject({ cases: 15, requiredFiles: 22 });
    expect(Object.keys(value.metrics.perLanguage)).toHaveLength(5);
    expect(Object.keys(value.metrics.perScenario)).toHaveLength(3);
  });

  it("reproduces the frozen v185 ranks and stops when Recall@64 is at the ceiling", () => {
    const value = frozenEvaluation;
    expect(value.metrics.requiredFileRecallAt5).toMatchObject({ numerator: 15, denominator: 22 });
    expect(value.metrics.requiredFileRecallAt64).toMatchObject({ numerator: 22, denominator: 22, value: 1 });
    expect(value.metrics.strictFullRecallAt64).toMatchObject({ numerator: 15, denominator: 15, value: 1 });
    expect(value.metrics.calibrationEce).toBeLessThanOrEqual(0.05);
    expect(value.metrics.generatedVendorTopOneViolations).toEqual([]);
    expect(value.diagnosis.dominantFailureMechanism).toBe("none_at_recall64");
    expect(value.stoppingDecision).toMatchObject({ rankingExperimentAuthorized: false, experimentsRemaining: 0, decision: "freeze_ranking" });
  });

  it("is byte-stable and labels its evidence boundary in Markdown", () => {
    const first = frozenEvaluation;
    const second = evaluateBalancedRequiredSource({ cohortPath });
    expect(second).toEqual(first);
    expect(formatBalancedRequiredSourceMarkdown(first)).toContain("retrospective development evidence");
    expect(formatBalancedRequiredSourceMarkdown(first)).toContain("contaminated detached holdout was not accessed");
  });

  it("fails closed if the cohort attempts to select a different case", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-balanced-cohort-"));
    const source = JSON.parse(fs.readFileSync(cohortPath, "utf8")) as { cases: Array<{ id: string }> };
    source.cases[0]!.id = "v02c-calibration-python-source_localization-092";
    const target = path.join(root, "cohort.json");
    fs.writeFileSync(target, JSON.stringify(source));
    expect(() => evaluateBalancedRequiredSource({ cohortPath: target, repositoryRoot: process.cwd() }))
      .toThrow("violates deterministic first-case selection rule");
  });
});
