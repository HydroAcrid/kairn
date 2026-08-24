#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFlag = process.argv.indexOf("--manifest");
const manifestPath = path.resolve(
  repositoryRoot,
  manifestFlag >= 0 ? process.argv[manifestFlag + 1] ?? "benchmarks/ranker-corpus.v1.json" : "benchmarks/ranker-corpus.v1.json",
);
const artifactsDir = path.join(repositoryRoot, "artifacts");
const modelId = "kairn-evidence-v02c-20260722";
const modelPath = path.join(artifactsDir, `${modelId}.json`);
const corpusPath = path.join(artifactsDir, "ranker-corpus.jsonl");
const corpusSummaryPath = path.join(artifactsDir, "ranker-corpus.summary.json");
const promotionPath = path.join(artifactsDir, "ranker-holdout.json");
const promotionReportPath = path.join(artifactsDir, "ranker-promotion-report.json");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-reproduce-"));

try {
  fs.mkdirSync(artifactsDir, { recursive: true });
  run("python3", [
    path.join(repositoryRoot, "scripts/build-evidence-corpus.py"),
    "--manifest", manifestPath,
    "--out", corpusPath,
    "--summary-out", corpusSummaryPath,
  ]);
  train(modelPath);

  const reproducedModel = path.join(temporary, `${modelId}.json`);
  train(reproducedModel);
  const generated = [
    path.basename(modelPath),
    `${modelId}.training-manifest.json`,
    `${modelId}.MODEL_CARD.md`,
  ];
  const checks = generated.map((name) => {
    const canonical = path.join(artifactsDir, name);
    const reproduced = path.join(temporary, name);
    const canonicalHash = sha256(fs.readFileSync(canonical));
    const reproducedHash = sha256(fs.readFileSync(reproduced));
    if (canonicalHash !== reproducedHash) {
      throw new Error(`reproducibility mismatch for ${name}: ${canonicalHash} != ${reproducedHash}`);
    }
    return { file: name, sha256: canonicalHash };
  });

  if (!fs.existsSync(promotionPath)) {
    throw new Error(
      `sealed holdout trace is missing at ${path.relative(repositoryRoot, promotionPath)}; ` +
      "ranker reproduction is incomplete until the single-use promotion evaluation exists",
    );
  }
  run("python3", [
    path.join(repositoryRoot, "scripts/evaluate-ranker-promotion.py"),
    "--manifest", promotionPath,
    "--out", promotionReportPath,
  ]);
  const report = JSON.parse(fs.readFileSync(promotionReportPath, "utf8"));
  if (report.promotionEligible !== true) {
    throw new Error("sealed holdout report is not promotion eligible");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "ranker-reproduction.v1",
    modelId,
    corpusSha256: sha256(fs.readFileSync(corpusPath)),
    reproducible: true,
    promotionEligible: true,
    files: checks,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function train(outputPath) {
  run("python3", [
    path.join(repositoryRoot, "scripts/train-evidence-ranker.py"),
    "--input", corpusPath,
    "--out", outputPath,
    "--model-id", modelId,
    "--node", process.execPath,
    "--public-data-only",
  ]);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}${detail ? `:\n${detail}` : ""}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
