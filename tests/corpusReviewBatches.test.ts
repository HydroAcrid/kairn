import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportCorpusReviewBatches,
  mergeCorpusReviewBatches,
  type MergeCorpusReviewBatchesOptions
} from "../scripts/corpus-review-batches.js";

describe("corpus review batches", () => {
  it("exports bounded batches and round-trips blank partial progress", () => {
    const fixture = reviewFixture();
    const preservedIndexPath = path.join(path.dirname(fixture.batchDir), "preserved-index.json");
    const index = exportCorpusReviewBatches({
      queuePath: fixture.queuePath,
      outDir: fixture.batchDir,
      batchSize: 2,
      indexOutPath: preservedIndexPath
    });

    expect(index).toMatchObject({
      status: "review_pending",
      promotionEligible: false,
      caseCount: 5,
      batchSize: 2,
      batchCount: 3,
      initialReviewProgress: { completedCases: 0, pendingCases: 5 }
    });
    expect(readJson(preservedIndexPath)).toEqual(readJson(path.join(fixture.batchDir, "index.json")));
    const summary = mergeCorpusReviewBatches(fixture.mergeOptions());
    expect(summary).toMatchObject({
      caseCount: 5,
      completedCases: 0,
      pendingCases: 5,
      readyForReviewApplication: false
    });
    expect(readJson(fixture.mergedPath)).toEqual(readJson(fixture.queuePath));
  });

  it("merges complete independently attributed decisions", () => {
    const fixture = reviewFixture();
    exportCorpusReviewBatches({ queuePath: fixture.queuePath, outDir: fixture.batchDir, batchSize: 2 });
    completeAllDecisions(fixture.batchDir);

    const summary = mergeCorpusReviewBatches(fixture.mergeOptions({ requireComplete: true }));
    expect(summary).toMatchObject({
      completedCases: 5,
      pendingCases: 0,
      reviewers: ["independent-reviewer"],
      readyForReviewApplication: true
    });
  });

  it("rejects immutable context tampering", () => {
    const fixture = reviewFixture();
    const index = exportCorpusReviewBatches({ queuePath: fixture.queuePath, outDir: fixture.batchDir, batchSize: 2 });
    const first = (index.batches as Array<{ fileName: string }>)[0]!;
    const batchPath = path.join(fixture.batchDir, first.fileName);
    const batch = readJson(batchPath);
    batch.cases[0].context.prompt = "tampered prompt";
    writeJson(batchPath, batch);

    expect(() => mergeCorpusReviewBatches(fixture.mergeOptions())).toThrow("context hash mismatch");
  });

  it("rejects missing batch files and half-completed reviewer identities", () => {
    const missing = reviewFixture();
    const missingIndex = exportCorpusReviewBatches({ queuePath: missing.queuePath, outDir: missing.batchDir, batchSize: 2 });
    fs.rmSync(path.join(missing.batchDir, (missingIndex.batches as Array<{ fileName: string }>)[0]!.fileName));
    expect(() => mergeCorpusReviewBatches(missing.mergeOptions())).toThrow("review batch file set mismatch");

    const partial = reviewFixture();
    const partialIndex = exportCorpusReviewBatches({ queuePath: partial.queuePath, outDir: partial.batchDir, batchSize: 2 });
    const first = (partialIndex.batches as Array<{ fileName: string }>)[0]!;
    const batchPath = path.join(partial.batchDir, first.fileName);
    const batch = readJson(batchPath);
    batch.cases[0].decision.reviewer = "reviewer-without-timestamp";
    writeJson(batchPath, batch);
    expect(() => mergeCorpusReviewBatches(partial.mergeOptions())).toThrow("reviewer and reviewedAt must be set together");
  });

  it("requires complete coverage before producing a sealing input", () => {
    const fixture = reviewFixture();
    exportCorpusReviewBatches({ queuePath: fixture.queuePath, outDir: fixture.batchDir, batchSize: 2 });

    expect(() => mergeCorpusReviewBatches(fixture.mergeOptions({ requireComplete: true }))).toThrow(
      "review batches are incomplete: 5 case decision(s) pending"
    );
  });
});

function reviewFixture(): {
  queuePath: string;
  batchDir: string;
  mergedPath: string;
  mergeOptions: (overrides?: Partial<MergeCorpusReviewBatchesOptions>) => MergeCorpusReviewBatchesOptions;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-review-batches-"));
  const queuePath = path.join(root, "review-queue.json");
  const batchDir = path.join(root, "batches");
  const mergedPath = path.join(root, "merged.json");
  const summaryPath = path.join(root, "merge-summary.json");
  const cases = Array.from({ length: 5 }, (_, index) => {
    const id = `case-${index + 1}`;
    const required = `src/required-${index + 1}.ts`;
    const noise = Array.from({ length: 7 }, (_, noiseIndex) => `noise/${index + 1}-${noiseIndex + 1}.md`);
    const needsRequiredSourceReview = index % 2 === 0;
    return {
      id,
      split: needsRequiredSourceReview ? "holdout" : "train",
      language: "typescript",
      scenario: "source_localization",
      prompt: `Repair behavior for ${id}`,
      candidatePathsSha256: `${index}`.repeat(64).slice(0, 64),
      requiredSourceFiles: [],
      officialPatchSourceFiles: [required],
      explicitNoiseFiles: [],
      needsRequiredSourceReview,
      needsNoiseReview: true,
      candidates: [required, ...noise].map((filePath) => ({ path: filePath, reasons: ["lexical"] })),
      materializedCaseSha256: `${index + 1}`.repeat(64).slice(0, 64),
      decision: {
        requiredSourceFiles: [],
        explicitNoiseFiles: [],
        reviewer: null,
        reviewedAt: null,
        notes: null
      }
    };
  });
  writeJson(queuePath, {
    schemaVersion: "ranker-corpus-review-queue.v1",
    corpusId: "review-batch-fixture",
    intakeSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    reportSha256: "c".repeat(64),
    materializerCommit: "d".repeat(40),
    caseCount: cases.length,
    requiredSourceReviewCases: 3,
    explicitNoiseReviewCases: 5,
    readyForSealCases: 0,
    cases
  });
  return {
    queuePath,
    batchDir,
    mergedPath,
    mergeOptions: (overrides = {}) => ({
      queuePath,
      batchDir,
      outPath: mergedPath,
      summaryOutPath: summaryPath,
      ...overrides
    })
  };
}

function completeAllDecisions(batchDir: string): void {
  const index = readJson(path.join(batchDir, "index.json"));
  for (const entry of index.batches as Array<{ fileName: string }>) {
    const batchPath = path.join(batchDir, entry.fileName);
    const batch = readJson(batchPath);
    for (const item of batch.cases) {
      const candidates = item.context.candidates.map((candidate: { path: string }) => candidate.path);
      item.decision = {
        requiredSourceFiles: item.context.needsRequiredSourceReview ? [candidates[0]] : [],
        explicitNoiseFiles: candidates.slice(1, 7),
        reviewer: "independent-reviewer",
        reviewedAt: "2026-07-23T12:00:00.000Z",
        notes: "Required source and six irrelevant candidates checked against the task."
      };
    }
    writeJson(batchPath, batch);
  }
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
