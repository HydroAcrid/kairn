import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRankerDiagnosticCheckpoint } from "../scripts/build-ranker-diagnostic-checkpoint.js";

describe("ranker diagnostic checkpoints", () => {
  it("binds a complete unreviewed draft and discloses regressions separately", () => {
    const fixture = checkpointFixture();
    const checkpoint = buildRankerDiagnosticCheckpoint(fixture.options);

    expect(checkpoint).toMatchObject({
      status: "draft_diagnostic_not_promotion_evidence",
      promotionEligible: false,
      baseline: { positiveSourceAnyHitRateAt64: 0, officialPatchMeanRecallAt64: 0 },
      current: { positiveSourceAnyHitRateAt64: 1, officialPatchMeanRecallAt64: 1 },
      delta: {
        regressionCount: 0,
        changedCases: [expect.objectContaining({ id: "case-1", outcome: "improved", delta: 1 })]
      },
      curation: { requiredSourceReviewCases: 1, explicitNoiseReviewCases: 1, readyForSealCases: 0 }
    });
  });

  it("rejects a queue that has already acquired a reviewer decision", () => {
    const fixture = checkpointFixture();
    const queue = JSON.parse(fs.readFileSync(fixture.options.reviewQueuePath, "utf8"));
    queue.cases[0].decision.reviewer = "reviewer";
    queue.cases[0].decision.reviewedAt = "2026-07-22T12:00:00.000Z";
    fs.writeFileSync(fixture.options.reviewQueuePath, JSON.stringify(queue), "utf8");

    expect(() => buildRankerDiagnosticCheckpoint(fixture.options)).toThrow(
      "diagnostic checkpoint cannot contain completed review decisions"
    );
  });
});

function checkpointFixture(): { options: Parameters<typeof buildRankerDiagnosticCheckpoint>[0] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-checkpoint-"));
  const paths = {
    intake: path.join(root, "intake.json"),
    registry: path.join(root, "lineages.json"),
    baseline: path.join(root, "baseline-report.json"),
    manifest: path.join(root, "manifest.json"),
    report: path.join(root, "report.json"),
    review: path.join(root, "review.json")
  };
  const corpusId = "checkpoint-fixture";
  const caseRow = {
    id: "case-1",
    split: "holdout",
    language: "go",
    scenario: "failure_first",
    repositoryLineageId: "https://github.com/example/repo"
  };
  writeJson(paths.registry, {
    schemaVersion: "lineage-registry.v1",
    lineages: [{ id: caseRow.repositoryLineageId, role: caseRow.split }]
  });
  writeJson(paths.intake, {
    schemaVersion: "ranker-corpus-intake.v1",
    corpusId,
    sealed: false,
    lineageRegistry: path.basename(paths.registry),
    cases: [caseRow]
  });
  const intakeSha256 = sha256(paths.intake);
  const reportCase = (recall: number) => ({
    id: caseRow.id,
    officialPatchSourceRecallAt64: recall,
    officialPatchSourceRecallAt128: recall,
    positiveSourceHitAt64: recall > 0
  });
  writeJson(paths.baseline, {
    schemaVersion: "ranker-corpus-materialization-report.v1",
    corpusId,
    kairnCommit: "a".repeat(40),
    intakeSha256,
    caseProcessIsolation: true,
    caseCount: 1,
    candidateRecallEligibleCases: 0,
    candidateRecallAt64: null,
    positiveSourceAnyHitRateAt64: 0,
    officialPatchMeanRecallAt64: 0,
    cases: [reportCase(0)]
  });
  writeJson(paths.manifest, {
    schemaVersion: "ranker-corpus.v1",
    corpusId,
    sealed: false,
    materializer: {
      kairnCommit: "b".repeat(40),
      intakeSha256,
      caseProcessIsolation: true
    },
    cases: [{ id: caseRow.id }]
  });
  writeJson(paths.report, {
    schemaVersion: "ranker-corpus-materialization-report.v1",
    corpusId,
    kairnCommit: "b".repeat(40),
    intakeSha256,
    caseProcessIsolation: true,
    caseCount: 1,
    candidateRecallEligibleCases: 0,
    candidateRecallAt64: null,
    positiveSourceAnyHitRateAt64: 1,
    officialPatchMeanRecallAt64: 1,
    officialPatchMeanRecallAt128: 1,
    cases: [reportCase(1)]
  });
  writeJson(paths.review, {
    schemaVersion: "ranker-corpus-review-queue.v1",
    corpusId,
    intakeSha256,
    materializerCommit: "b".repeat(40),
    manifestSha256: sha256(paths.manifest),
    reportSha256: sha256(paths.report),
    caseCount: 1,
    requiredSourceReviewCases: 1,
    explicitNoiseReviewCases: 1,
    readyForSealCases: 0,
    cases: [{ id: caseRow.id, decision: { reviewer: null, reviewedAt: null } }]
  });
  return {
    options: {
      intakePath: paths.intake,
      registryPath: paths.registry,
      baselineReportPath: paths.baseline,
      manifestPath: paths.manifest,
      reportPath: paths.report,
      reviewQueuePath: paths.review,
      snapshotDir: path.join(root, "snapshot"),
      outPath: path.join(root, "checkpoint.json")
    }
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
