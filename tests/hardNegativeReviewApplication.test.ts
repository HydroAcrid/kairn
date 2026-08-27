// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyHardNegativeReviews } from "../scripts/apply-hard-negative-reviews.js";

describe("hard-negative review application", () => {
  it("adds only explicitly irrelevant training rows and preserves the original rows", () => {
    const fixture = createFixture();
    try {
      const summary = apply(fixture);
      expect(summary).toMatchObject({
        schemaVersion: "hard-negative-review-application.v1",
        trainingOnly: true,
        detachedHoldoutOpened: false,
        reviewedItems: 3,
        verdictCounts: { irrelevant: 1, relevant: 1, uncertain: 1 },
        addedNegativeRows: 1,
        unchangedUnlabeledRows: 2
      });
      const output = fs.readFileSync(fixture.outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(output).toHaveLength(2);
      expect(output[0]).toEqual(fixture.originalRow);
      expect(output[1]).toMatchObject({
        caseGroupId: "train-case",
        candidatePath: "src/noise.ts",
        split: "train",
        label: 0,
        labelWeight: 1,
        labelProvenance: "explicit_noise_or_excluded",
        features: [0, 0.7]
      });
      expect(output.some((row) => row.candidatePath === "src/relevant.ts")).toBe(false);
      expect(output.some((row) => row.candidatePath === "src/uncertain.ts")).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects stale, incomplete, and holdout-contaminated review inputs", () => {
    const fixture = createFixture();
    try {
      const decisions = JSON.parse(fs.readFileSync(fixture.decisionsPath, "utf8"));
      decisions.reviewQueueSha256 = "0".repeat(64);
      fs.writeFileSync(fixture.decisionsPath, JSON.stringify(decisions));
      expect(() => apply(fixture)).toThrow("stale for this queue");

      writeDecisions(fixture);
      const incomplete = JSON.parse(fs.readFileSync(fixture.decisionsPath, "utf8"));
      incomplete.decisions.pop();
      fs.writeFileSync(fixture.decisionsPath, JSON.stringify(incomplete));
      expect(() => apply(fixture)).toThrow("every queued review item");

      writeDecisions(fixture);
      const rows = `${fs.readFileSync(fixture.trainingRowsPath, "utf8")}${JSON.stringify({
        ...fixture.originalRow,
        caseGroupId: "holdout-case",
        candidatePath: "src/holdout.ts",
        split: "holdout"
      })}\n`;
      fs.writeFileSync(fixture.trainingRowsPath, rows);
      const queue = JSON.parse(fs.readFileSync(fixture.queuePath, "utf8"));
      queue.inputs.trainingRows.sha256 = sha256(Buffer.from(rows));
      fs.writeFileSync(fixture.queuePath, JSON.stringify(queue));
      writeDecisions(fixture);
      expect(() => apply(fixture)).toThrow("holdout data");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a changed source hash and duplicate training candidate", () => {
    const fixture = createFixture();
    try {
      const decisions = JSON.parse(fs.readFileSync(fixture.decisionsPath, "utf8"));
      decisions.decisions[0].sourceContentSha256 = "f".repeat(64);
      fs.writeFileSync(fixture.decisionsPath, JSON.stringify(decisions));
      expect(() => apply(fixture)).toThrow("source hash is stale");

      const duplicate = {
        ...fixture.originalRow,
        candidatePath: "src/noise.ts",
        label: 0,
        labelWeight: 1,
        labelProvenance: "explicit_noise_or_excluded"
      };
      const rows = `${JSON.stringify(fixture.originalRow)}\n${JSON.stringify(duplicate)}\n`;
      fs.writeFileSync(fixture.trainingRowsPath, rows);
      const queue = JSON.parse(fs.readFileSync(fixture.queuePath, "utf8"));
      queue.inputs.trainingRows.sha256 = sha256(Buffer.from(rows));
      fs.writeFileSync(fixture.queuePath, JSON.stringify(queue));
      writeDecisions(fixture);
      expect(() => apply(fixture)).toThrow("already exists in training rows");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

type Fixture = ReturnType<typeof createFixture>;

function apply(fixture: Fixture): Record<string, unknown> {
  return applyHardNegativeReviews({
    trainingRowsPath: fixture.trainingRowsPath,
    reviewQueuePath: fixture.queuePath,
    decisionsPath: fixture.decisionsPath,
    outPath: fixture.outPath,
    summaryOutPath: fixture.summaryPath
  });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-hard-negative-application-"));
  const trainingRowsPath = path.join(root, "rows.jsonl");
  const queuePath = path.join(root, "queue.json");
  const decisionsPath = path.join(root, "decisions.json");
  const outPath = path.join(root, "augmented.jsonl");
  const summaryPath = path.join(root, "summary.json");
  const originalRow = {
    featureSchemaVersion: "evidence-features-v4",
    repositoryLineageId: "public/repository",
    caseGroupId: "train-case",
    split: "train",
    language: "typescript",
    scenario: "source_localization",
    candidatePath: "src/positive.ts",
    label: 1,
    labelWeight: 1,
    labelProvenance: "required_source_oracle",
    features: [0, 0.2]
  };
  const training = Buffer.from(`${JSON.stringify(originalRow)}\n`);
  fs.writeFileSync(trainingRowsPath, training);
  const item = (id: string, candidatePath: string) => ({
    id,
    caseId: "train-case",
    cell: "typescript/source_localization",
    language: "typescript",
    scenario: "source_localization",
    repositoryLineageId: "public/repository",
    publicSourceUrl: "https://example.test/data",
    dataOrigin: "public_benchmark",
    candidatePath,
    source: { contentSha256: sha256(Buffer.from(candidatePath)) },
    evidence: { baseFeatures: { exactPath: 0, semantic: 0.7 } }
  });
  const queue = {
    schemaVersion: "hard-negative-review-queue.v1",
    trainingOnly: true,
    detachedHoldoutOpened: false,
    inputs: { trainingRows: { sha256: sha256(training) } },
    featureSchema: { base: ["exactPath", "semantic"], added: [] },
    items: [item("noise", "src/noise.ts"), item("relevant", "src/relevant.ts"), item("uncertain", "src/uncertain.ts")]
  };
  fs.writeFileSync(queuePath, JSON.stringify(queue));
  const fixture = { root, trainingRowsPath, queuePath, decisionsPath, outPath, summaryPath, originalRow };
  writeDecisions(fixture);
  return fixture;
}

function writeDecisions(fixture: Pick<Fixture, "queuePath" | "decisionsPath">): void {
  const queueBytes = fs.readFileSync(fixture.queuePath);
  const queue = JSON.parse(queueBytes.toString("utf8"));
  const verdicts = ["irrelevant", "relevant", "uncertain"];
  fs.writeFileSync(fixture.decisionsPath, JSON.stringify({
    schemaVersion: "hard-negative-review-decisions.v1",
    reviewQueueSha256: sha256(queueBytes),
    reviewer: "test-reviewer",
    reviewedAt: "2026-08-27T18:00:00Z",
    decisions: queue.items.map((item: Record<string, unknown>, index: number) => ({
      id: item.id,
      verdict: verdicts[index],
      sourceContentSha256: (item.source as Record<string, unknown>).contentSha256,
      notes: `review ${index}`
    }))
  }));
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
