#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.join(repositoryRoot, "benchmarks", "evidence-training.sample.jsonl");
const trainerPath = path.join(repositoryRoot, "scripts", "train-evidence-ranker.py");
const checksumHelper = path.join(repositoryRoot, "scripts", "evidence-artifact-checksum.mjs");
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const sandbox = mkdtempSync(path.join(os.tmpdir(), "kairn-model-repro-"));

try {
  const first = train(path.join(sandbox, "first"));
  const second = train(path.join(sandbox, "second"));
  const firstFiles = readOutputs(path.dirname(first));
  const secondFiles = readOutputs(path.dirname(second));
  if (JSON.stringify(firstFiles) !== JSON.stringify(secondFiles)) {
    throw new Error("sample model export is not byte-for-byte reproducible");
  }

  const artifact = JSON.parse(readFileSync(first, "utf8"));
  const checksum = spawnSync(process.execPath, [checksumHelper], {
    input: JSON.stringify(artifact),
    encoding: "utf8",
  });
  if (checksum.status !== 0 || checksum.stdout.trim() !== artifact.checksum) {
    throw new Error(`sample model artifact checksum mismatch: ${checksum.stderr || checksum.stdout}`);
  }
  const expectedDataHash = createHash("sha256").update(readFileSync(inputPath)).digest("hex");
  if (artifact.trainingDataHash !== expectedDataHash) {
    throw new Error("sample model training-data hash does not match the checked-in JSONL source");
  }
  process.stdout.write(`Sample model export is reproducible; artifact checksum ${artifact.checksum}.\n`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

function train(directory) {
  const output = path.join(directory, "sample-evidence-model.json");
  const result = spawnSync(python, [
    trainerPath,
    "--input",
    inputPath,
    "--out",
    output,
    "--model-id",
    "sample-evidence-v1",
    "--node",
    process.execPath,
    "--public-data-only",
  ], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`sample model training failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return output;
}

function readOutputs(directory) {
  return readdirSync(directory)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => [name, readFileSync(path.join(directory, name), "utf8")]);
}
