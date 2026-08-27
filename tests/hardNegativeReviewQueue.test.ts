// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHardNegativeReviewQueue } from "../scripts/build-hard-negative-review-queue.js";

const BASE = ["exactPath", "failureReference", "semantic"];
const ADDED = ["semanticFile", "semanticSymbol", "missingSemanticFile", "missingSemanticSymbol"];

describe("hard-negative review queue", () => {
  it("selects a deterministic balanced training-only queue with immutable source bindings", () => {
    const fixture = createFixture();
    try {
      const first = build(fixture);
      const second = build(fixture);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        schemaVersion: "hard-negative-review-queue.v1",
        promotionEligible: false,
        trainingOnly: true,
        detachedHoldoutOpened: false,
        decisionsComplete: false,
        policy: {
          automaticLabels: false,
          calibrationRowsExcluded: true,
          holdoutRowsExcluded: true,
          perCell: 1,
          maxPerCase: 1
        },
        population: { trainingCases: 2, cells: 2, selectedCandidates: 2 }
      });
      const items = first.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items.map((item) => item.caseId)).toEqual(["train-go", "train-typescript"]);
      expect(items.every((item) => (item.decision as Record<string, unknown>).verdict === null)).toBe(true);
      expect(items.every((item) => /^[a-f0-9]{64}$/.test(
        String((item.source as Record<string, unknown>).contentSha256)
      ))).toBe(true);
      expect(JSON.stringify(first)).not.toContain("calibration-case");
      const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
      expect(digest(first)).toBe(digest(second));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed on stale model provenance and holdout contamination", () => {
    const fixture = createFixture();
    try {
      const evaluation = JSON.parse(fs.readFileSync(fixture.evaluationPath, "utf8"));
      evaluation.inputs.candidateManifestSha256 = "0".repeat(64);
      fs.writeFileSync(fixture.evaluationPath, JSON.stringify(evaluation));
      expect(() => build(fixture)).toThrow("candidateManifestSha256");

      writeEvaluation(fixture);
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
      manifest.cases.push({ ...manifest.cases[0], id: "holdout-case", split: "holdout" });
      fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest));
      writeEvaluation(fixture);
      expect(() => build(fixture)).toThrow("holdout cases");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("selects only unlabeled candidates that rank above a positive", () => {
    const fixture = createFixture();
    try {
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
      manifest.cases[0].trainingCandidates.push(candidate("already-negative.go", 0.99, 0));
      manifest.cases[0].trainingCandidates.push(candidate("below-positive.go", 0.01, null));
      fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest));
      writeEvaluation(fixture);
      const queue = build(fixture);
      const paths = (queue.items as Array<Record<string, unknown>>).map((item) => item.candidatePath);
      expect(paths).toContain("hard.go");
      expect(paths).not.toContain("already-negative.go");
      expect(paths).not.toContain("below-positive.go");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fills a cell from one case only after exhausting the preferred per-case limit", () => {
    const fixture = createFixture();
    try {
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
      manifest.cases[0].trainingCandidates.push(candidate("already-negative.go", 0.85, null));
      fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest));
      const report = JSON.parse(fs.readFileSync(fixture.reportPath, "utf8"));
      report.cases[0].candidateDiagnostics.semanticInteractions.push({
        path: "already-negative.go",
        similarity: 0.85,
        fileSimilarity: 0.85,
        symbolSimilarity: 0.75
      });
      fs.writeFileSync(fixture.reportPath, JSON.stringify(report));
      writeEvaluation(fixture);
      const queue = buildHardNegativeReviewQueue({
        trainingRowsPath: fixture.trainingRowsPath,
        manifestPath: fixture.manifestPath,
        reportPath: fixture.reportPath,
        evaluationPath: fixture.evaluationPath,
        repositoryCacheRoot: fixture.cacheRoot,
        outPath: path.join(fixture.root, "queue.json"),
        perCell: 2,
        maxPerCase: 1
      });
      const goItems = (queue.items as Array<Record<string, unknown>>).filter(
        (item) => item.cell === "go/source_localization"
      );
      expect(goItems).toHaveLength(2);
      expect(new Set(goItems.map((item) => item.caseId))).toEqual(new Set(["train-go"]));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

type Fixture = ReturnType<typeof createFixture>;

function build(fixture: Fixture): Record<string, unknown> {
  return buildHardNegativeReviewQueue({
    trainingRowsPath: fixture.trainingRowsPath,
    manifestPath: fixture.manifestPath,
    reportPath: fixture.reportPath,
    evaluationPath: fixture.evaluationPath,
    repositoryCacheRoot: fixture.cacheRoot,
    outPath: path.join(fixture.root, "queue.json"),
    perCell: 1,
    maxPerCase: 1
  });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-hard-negative-review-"));
  const working = path.join(root, "working");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(working, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: working });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: working });
  execFileSync("git", ["config", "user.name", "Kairn Test"], { cwd: working });
  for (const file of [
    "required.go", "hard.go", "required.ts", "hard.ts", "calibration.ts",
    "already-negative.go", "below-positive.go"
  ]) {
    fs.writeFileSync(path.join(working, file), `source for ${file}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: working });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: working });
  const repositoryRef = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: working,
    encoding: "utf8"
  }).trim();
  const repositoryUrl = working;
  const repositoryKey = crypto.createHash("sha256").update(repositoryUrl).digest("hex").slice(0, 24);
  const bare = path.join(cacheRoot, "repositories", `${repositoryKey}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync("git", ["clone", "--quiet", "--bare", working, bare]);

  const trainingRowsPath = path.join(root, "rows.jsonl");
  const manifestPath = path.join(root, "manifest.json");
  const reportPath = path.join(root, "report.json");
  const evaluationPath = path.join(root, "evaluation.json");
  const rows = [
    trainingRow("train-go", "go", "source_localization", "required.go", 1),
    trainingRow("train-typescript", "typescript", "failure_first", "required.ts", 1),
    trainingRow("calibration-case", "typescript", "source_localization", "calibration.ts", 1, "calibration")
  ];
  fs.writeFileSync(trainingRowsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const common = {
    repositoryLineageId: repositoryUrl,
    repositoryUrl,
    repositoryRef,
    publicSourceUrl: "https://example.test/data",
    dataOrigin: "public_benchmark"
  };
  const makeCase = (
    id: string,
    split: "train" | "calibration",
    language: string,
    scenario: string,
    candidates: unknown[]
  ) => ({
    id,
    split,
    language,
    scenario,
    ...common,
    prompt: `Task for ${id}`,
    querySha256: crypto.createHash("sha256").update(`Task for ${id}`).digest("hex"),
    trainingCandidates: candidates
  });
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: "ranker-corpus.v1",
    materializer: { kairnCommit: "a".repeat(40), intakeSha256: "b".repeat(64) },
    cases: [
      makeCase("train-go", "train", "go", "source_localization", [
        candidate("hard.go", 0.9, null), candidate("required.go", 0.3, 1)
      ]),
      makeCase("train-typescript", "train", "typescript", "failure_first", [
        candidate("hard.ts", 0.8, null), candidate("required.ts", 0.2, 1)
      ]),
      makeCase("calibration-case", "calibration", "typescript", "source_localization", [
        candidate("calibration.ts", 0.4, 1)
      ])
    ]
  }));
  fs.writeFileSync(reportPath, JSON.stringify({
    schemaVersion: "ranker-corpus-materialization-report.v1",
    kairnCommit: "a".repeat(40),
    intakeSha256: "b".repeat(64),
    cases: [
      reportCase("train-go", ["hard.go", "required.go"]),
      reportCase("train-typescript", ["hard.ts", "required.ts"]),
      reportCase("calibration-case", ["calibration.ts"])
    ]
  }));
  const fixture = { root, cacheRoot, trainingRowsPath, manifestPath, reportPath, evaluationPath };
  writeEvaluation(fixture);
  return fixture;
}

function candidate(candidatePath: string, semantic: number, label: 0 | 1 | null) {
  return {
    path: candidatePath,
    features: { exactPath: 0, failureReference: 0, semantic },
    label,
    ...(label === 1 ? { labelWeight: 1, labelProvenance: "required_source_oracle" } : {}),
    ...(label === 0 ? { labelWeight: 1, labelProvenance: "explicit_noise_or_excluded" } : {})
  };
}

function trainingRow(
  caseGroupId: string,
  language: string,
  scenario: string,
  candidatePath: string,
  label: 1,
  split = "train"
) {
  return { caseGroupId, language, scenario, candidatePath, split, label, features: [0, 0, 0.3] };
}

function reportCase(id: string, paths: string[]) {
  return {
    id,
    candidateDiagnostics: {
      semanticInteractions: paths.map((candidatePath, index) => ({
        path: candidatePath,
        similarity: 0.9 - index * 0.2,
        fileSimilarity: 0.9 - index * 0.2,
        symbolSimilarity: 0.8 - index * 0.2
      }))
    }
  };
}

function writeEvaluation(fixture: Omit<Fixture, "evaluationPath"> & { evaluationPath: string }): void {
  const hash = (target: string) => crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  fs.writeFileSync(fixture.evaluationPath, JSON.stringify({
    schemaVersion: "semantic-document-feature-diagnostic.v1",
    promotionEligible: false,
    samePoolVerified: true,
    inputs: {
      trainingRowsSha256: hash(fixture.trainingRowsPath),
      candidateManifestSha256: hash(fixture.manifestPath),
      candidateReportSha256: hash(fixture.reportPath)
    },
    featureSchema: { base: BASE, added: ADDED },
    model: {
      kind: "pairwise_logistic",
      selectedL2: 0.01,
      coefficients: {
        exactPath: 1,
        failureReference: 1,
        semantic: 1,
        semanticFile: 1,
        semanticSymbol: 1,
        missingSemanticFile: 0,
        missingSemanticSymbol: 0
      }
    }
  }));
}
