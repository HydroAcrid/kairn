// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_FEATURE_NAMES } from "../src/types.js";

describe("probe ranker diagnostic dataset", () => {
  it("uses bounded training candidates when no expanded probe was requested", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-bounded-ranker-dataset-"));
    const manifestPath = path.join(temporary, "manifest.json");
    const reportPath = path.join(temporary, "report.json");
    const outputPath = path.join(temporary, "rows.jsonl");
    const summaryPath = path.join(temporary, "summary.json");
    const materializer = { kairnCommit: "a".repeat(40), intakeSha256: "b".repeat(64) };
    const zeroFeatures = Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name) => [name, 0]));
    const trainingCandidates = [{
      path: "src/required.ts",
      features: { ...zeroFeatures, semantic: 0.8, productionSource: 1 },
      label: 1,
      labelWeight: 1,
      labelProvenance: "required_source_oracle"
    }, {
      path: "docs/noise.md",
      features: { ...zeroFeatures, docsFile: 1 },
      label: 0,
      labelWeight: 1,
      labelProvenance: "explicit_noise_or_excluded"
    }];
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "ranker-corpus.v1",
      featureSchemaVersion: "evidence-features-v4",
      sealed: false,
      status: "draft_for_label_review",
      materializer,
      cases: [{
        id: "bounded-case",
        repositoryLineageId: "bounded-lineage",
        split: "train",
        language: "typescript",
        scenario: "source_localization",
        publicSourceUrl: "https://example.test/repository",
        dataOrigin: "public_benchmark",
        trainingCandidates
      }]
    }));
    fs.writeFileSync(reportPath, JSON.stringify({
      schemaVersion: "ranker-corpus-materialization-report.v1",
      ...materializer,
      cases: [{ id: "bounded-case" }]
    }));

    const result = spawnSync(process.execPath, [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/build-probe-ranker-diagnostic.ts"),
      "--manifest", manifestPath,
      "--report", reportPath,
      "--out", outputPath,
      "--summary-out", summaryPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(outputPath, "utf8").trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(summaryPath, "utf8"))).toMatchObject({
      caseCount: 1,
      labeledRowCount: 2,
      candidateSourceCounts: { training_candidates: 1 },
      probeCandidateCounts: { minimum: 2, maximum: 2, expandedCases: 0 }
    });
  });

  it("combines lineage-safe base rows and excludes zero-positive synthetic cases", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-probe-dataset-"));
    const manifestPath = path.join(temporary, "manifest.json");
    const reportPath = path.join(temporary, "report.json");
    const baseRowsPath = path.join(temporary, "base.jsonl");
    const outputPath = path.join(temporary, "rows.jsonl");
    const summaryPath = path.join(temporary, "summary.json");
    const materializer = { kairnCommit: "a".repeat(40), intakeSha256: "b".repeat(64) };
    const makeCase = (id: string) => ({
      id,
      repositoryLineageId: `lineage-${id}`,
      split: "train",
      language: "typescript",
      scenario: "source_localization",
      publicSourceUrl: "https://example.test/repository",
      dataOrigin: "synthetic"
    });
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "ranker-corpus.v1",
      featureSchemaVersion: "evidence-features-v4",
      sealed: false,
      status: "draft_for_label_review",
      materializer,
      cases: [makeCase("retained"), makeCase("excluded")]
    }));

    const zeroFeatures = Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name) => [name, 0]));
    const makeCandidates = (positive: boolean) => Array.from({ length: 129 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      features: zeroFeatures,
      label: positive && index === 128 ? 1 : 0,
      labelWeight: 1,
      labelProvenance: positive && index === 128
        ? "verified_official_patch_source"
        : "explicit_noise_or_excluded"
    }));
    fs.writeFileSync(reportPath, JSON.stringify({
      schemaVersion: "ranker-corpus-materialization-report.v1",
      ...materializer,
      cases: [
        { id: "retained", probeLimit: 512, probeCandidates: makeCandidates(true) },
        { id: "excluded", probeLimit: 512, probeCandidates: makeCandidates(false) }
      ]
    }));

    const baseRow = {
      featureSchemaVersion: "evidence-features-v4",
      repositoryLineageId: "base-lineage",
      caseGroupId: "base-case",
      split: "calibration",
      language: "go",
      scenario: "failure_first",
      candidatePath: "src/base.go",
      isPublic: true,
      publicSourceUrl: "https://example.test/base",
      dataOrigin: "public_benchmark",
      label: 1,
      labelWeight: 0.75,
      labelProvenance: "verified_official_patch_source",
      features: EVIDENCE_FEATURE_NAMES.map(() => 0)
    };
    fs.writeFileSync(baseRowsPath, `${JSON.stringify(baseRow)}\n`);

    const result = spawnSync(process.execPath, [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/build-probe-ranker-diagnostic.ts"),
      "--manifest", manifestPath,
      "--report", reportPath,
      "--base-rows", baseRowsPath,
      "--drop-zero-positive-synthetic", "true",
      "--out", outputPath,
      "--summary-out", summaryPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const rows = fs.readFileSync(outputPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(130);
    expect(rows[0].caseGroupId).toBe("base-case");
    expect(rows.some((row) => row.caseGroupId === "excluded")).toBe(false);
    expect(JSON.parse(fs.readFileSync(summaryPath, "utf8"))).toMatchObject({
      inputCaseCount: 2,
      caseCount: 1,
      excludedSyntheticCases: ["excluded"],
      labeledRowCount: 130,
      baseRows: { rowCount: 1, caseCount: 1 },
      labelProvenanceCounts: {
        explicit_noise_or_excluded: 128,
        verified_official_patch_source: 2
      }
    });
  });
});
