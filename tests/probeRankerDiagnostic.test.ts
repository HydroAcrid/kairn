// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_EVIDENCE_ARTIFACT,
  checksumEvidenceArtifact
} from "../src/retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES } from "../src/types.js";

describe("probe ranker diagnostic evaluation", () => {
  it("scores the complete holdout probe pool and remains non-promotional", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-probe-ranker-"));
    const trainingRowsPath = path.join(temporary, "rows.jsonl");
    const modelPath = path.join(temporary, "model.json");
    const manifestPath = path.join(temporary, "manifest.json");
    const reportPath = path.join(temporary, "report.json");
    const outputPath = path.join(temporary, "evaluation.json");
    const trainingRows = Buffer.from('{"diagnostic":true}\n');
    fs.writeFileSync(trainingRowsPath, trainingRows);

    const { checksum: _checksum, ...bundledPayload } = BUNDLED_EVIDENCE_ARTIFACT;
    const payload = {
      ...bundledPayload,
      modelId: "probe-diagnostic-test",
      trainingDataHash: crypto.createHash("sha256").update(trainingRows).digest("hex"),
      trainingManifest: "probe-diagnostic-test.training-manifest.json"
    };
    fs.writeFileSync(modelPath, JSON.stringify({
      ...payload,
      checksum: checksumEvidenceArtifact(payload)
    }));

    const zeroFeatures = Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name) => [name, 0]));
    const candidates = Array.from({ length: 130 }, (_, index) => ({
      path: index === 129 ? "src/required.ts" : `noise/${String(index).padStart(3, "0")}.ts`,
      features: index === 129
        ? { ...zeroFeatures, exactPath: 1, productionSource: 1 }
        : zeroFeatures,
      label: index === 129 ? 1 : null,
      labelWeight: index === 129 ? 1 : null,
      labelProvenance: index === 129 ? "required_source_oracle" : null
    }));
    const materializer = { kairnCommit: "a".repeat(40), intakeSha256: "b".repeat(64) };
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "ranker-corpus.v1",
      featureSchemaVersion: "evidence-features-v4",
      sealed: false,
      status: "draft_for_label_review",
      materializer,
      cases: [{
        id: "holdout-case",
        split: "holdout",
        language: "typescript",
        scenario: "source_localization"
      }]
    }));
    fs.writeFileSync(reportPath, JSON.stringify({
      schemaVersion: "ranker-corpus-materialization-report.v1",
      ...materializer,
      cases: [{
        id: "holdout-case",
        requiredSourceExistingFiles: ["src/required.ts"],
        initialCandidatePaths: candidates.slice(0, 64).map((item) => item.path),
        enrichedCandidatePaths: candidates.slice(0, 128).map((item) => item.path),
        probeCandidates: candidates
      }]
    }));

    const result = spawnSync(process.execPath, [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/evaluate-probe-ranker-diagnostic.ts"),
      "--model", modelPath,
      "--training-rows", trainingRowsPath,
      "--manifest", manifestPath,
      "--report", reportPath,
      "--out", outputPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toMatchObject({
      promotionEligible: false,
      holdoutCaseCount: 1,
      metrics: {
        probeAvailabilityFullRecall: 1,
        currentStrictFullRecallAt64: 0,
        currentStrictFullRecallAt128: 0,
        rankedStrictFullRecallAt64: 1,
        rankedStrictFullRecallAt128: 1
      },
      missesAt64: [],
      missesAt128: []
    });
  });

  it("scores calibration patch references without accepting a holdout-bearing manifest", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-probe-calibration-"));
    const trainingRowsPath = path.join(temporary, "rows.jsonl");
    const modelPath = path.join(temporary, "model.json");
    const manifestPath = path.join(temporary, "manifest.json");
    const reportPath = path.join(temporary, "report.json");
    const outputPath = path.join(temporary, "evaluation.json");
    const trainingRows = Buffer.from('{"diagnostic":true}\n');
    fs.writeFileSync(trainingRowsPath, trainingRows);

    const { checksum: _checksum, ...bundledPayload } = BUNDLED_EVIDENCE_ARTIFACT;
    const payload = {
      ...bundledPayload,
      modelId: "probe-calibration-test",
      trainingDataHash: crypto.createHash("sha256").update(trainingRows).digest("hex"),
      trainingManifest: "probe-calibration-test.training-manifest.json"
    };
    fs.writeFileSync(modelPath, JSON.stringify({
      ...payload,
      checksum: checksumEvidenceArtifact(payload)
    }));
    const zeroFeatures = Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name) => [name, 0]));
    const candidates = [{
      path: "src/required.ts",
      features: { ...zeroFeatures, exactPath: 1, productionSource: 1 },
      label: 1,
      labelWeight: 0.75,
      labelProvenance: "verified_official_patch_source"
    }, {
      path: "docs/noise.md",
      features: { ...zeroFeatures, docsFile: 1 },
      label: 0,
      labelWeight: 1,
      labelProvenance: "explicit_noise_or_excluded"
    }];
    const materializer = { kairnCommit: "a".repeat(40), intakeSha256: "b".repeat(64) };
    const manifest = {
      schemaVersion: "ranker-corpus.v1",
      featureSchemaVersion: "evidence-features-v4",
      sealed: false,
      status: "draft_for_label_review",
      materializer,
      cases: [{
        id: "calibration-case",
        split: "calibration",
        language: "typescript",
        scenario: "source_localization",
        trainingCandidates: candidates
      }]
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(reportPath, JSON.stringify({
      schemaVersion: "ranker-corpus-materialization-report.v1",
      ...materializer,
      cases: [{
        id: "calibration-case",
        officialPatchSourceExistingFiles: ["src/required.ts"],
        initialCandidatePaths: candidates.map((item) => item.path),
        enrichedCandidatePaths: candidates.map((item) => item.path),
        probeCandidates: candidates
      }]
    }));

    const run = () => spawnSync(process.execPath, [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/evaluate-probe-ranker-diagnostic.ts"),
      "--model", modelPath,
      "--training-rows", trainingRowsPath,
      "--manifest", manifestPath,
      "--report", reportPath,
      "--out", outputPath,
      "--split", "calibration"
    ], { cwd: process.cwd(), encoding: "utf8" });
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toMatchObject({
      promotionEligible: false,
      evaluationSplit: "calibration",
      referenceKind: "verified_official_patch_source",
      targetCaseCount: 1,
      holdoutCaseCount: 0,
      calibrationCaseCount: 1,
      metrics: {
        rankedStrictFullRecallAt64: 1,
        rankedStrictFullRecallAt128: 1
      }
    });

    const boundedReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    delete boundedReport.cases[0].probeCandidates;
    fs.writeFileSync(reportPath, JSON.stringify(boundedReport));
    const boundedResult = run();
    expect(boundedResult.status, boundedResult.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toMatchObject({
      targetCaseCount: 1,
      metrics: {
        rankedStrictFullRecallAt64: 1,
        rankedStrictFullRecallAt128: 1
      }
    });

    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      cases: [
        ...manifest.cases,
        {
          id: "unopened-holdout",
          split: "holdout",
          language: "go",
          scenario: "failure_first"
        }
      ]
    }));
    const reportWithHoldout = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    reportWithHoldout.cases.push({
      id: "unopened-holdout",
      requiredSourceExistingFiles: ["src/required.go"],
      initialCandidatePaths: ["src/required.go"],
      enrichedCandidatePaths: ["src/required.go"],
      probeCandidates: candidates
    });
    fs.writeFileSync(reportPath, JSON.stringify(reportWithHoldout));
    const rejected = run();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("refuse manifests containing holdout cases");
  });
});
