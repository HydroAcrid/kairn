// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-tier-a-"));
const steps: Array<{ id: string; command: string; args: string[]; durationMs?: number }> = [
  { id: "typecheck", command: "pnpm", args: ["typecheck"] },
  { id: "contracts", command: "pnpm", args: ["exec", "vitest", "run", "tests/benchmarkInfrastructure.test.ts", "tests/experiment.test.ts", "tests/evidenceTraining.test.ts", "tests/rankabilityAudit.test.ts", "tests/rankabilityAuditIntegration.test.ts"] },
  { id: "architecture", command: "pnpm", args: ["check:semantic-architecture"] },
  { id: "fake_agent", command: "pnpm", args: ["verify:experiment-smoke"] }
];

try {
  for (const step of steps) {
    const stepStarted = Date.now();
    const result = spawnSync(step.command, step.args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 90_000,
      shell: process.platform === "win32"
    });
    step.durationMs = Date.now() - stepStarted;
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`${step.id} failed${detail ? `:\n${detail}` : ""}`);
    }
  }
  const first = path.join(temporary, "one", "sample.json");
  const second = path.join(temporary, "two", "sample.json");
  train(first); train(second);
  for (const name of ["sample.json", "tier-a-determinism-sample.training-manifest.json", "sample.MODEL_CARD.md"]) {
    const firstPath = path.join(path.dirname(first), name);
    const secondPath = path.join(path.dirname(second), name);
    if (sha256(firstPath) !== sha256(secondPath)) throw new Error(`sample ranker output is nondeterministic: ${name}`);
  }
  const durationMs = Date.now() - started;
  if (durationMs > 120_000) throw new Error(`Tier A exceeded its 120 second budget (${durationMs} ms).`);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "benchmark-tier-a.v1",
    fixtureNotEvidence: true,
    valid: true,
    durationMs,
    steps: [...steps, { id: "deterministic_training", durationMs: 0 }].map(({ id, durationMs }) => ({ id, durationMs }))
  }, null, 2)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function train(output: string): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync("python3", [
    path.join(root, "scripts/train-evidence-ranker.py"),
    "--input", path.join(root, "benchmarks/evidence-training.sample.jsonl"),
    "--out", output,
    "--model-id", "tier-a-determinism-sample",
    "--node", process.execPath,
    "--public-data-only"
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(`deterministic sample training failed: ${result.stderr || result.stdout}`);
}
function sha256(filePath: string): string { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
