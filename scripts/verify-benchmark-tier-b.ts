// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";

const queries = [
  { id: "python", query: "Keep temporary access alive by extending its expiration before it lapses." },
  { id: "typescript", query: "Stop accepting work when the in-memory backlog reaches its capacity." },
  { id: "go", query: "Open the failure circuit once consecutive errors reach the configured limit." },
  { id: "java", query: "Convert a decimal bill amount into correctly rounded integer cents." },
  { id: "cpp", query: "Accumulate packet bytes to validate the transport checksum." }
];
const scriptPath = fileURLToPath(import.meta.url);
const workerIndex = process.argv.indexOf("--worker");
if (workerIndex >= 0) {
  const root = process.argv[workerIndex + 1];
  if (!root) throw new Error("--worker requires a fixture root");
  await runWorker(path.resolve(root));
} else {
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-tier-b-"));
  try {
    writeFixture(root);
    const first = isolatedRun(root);
    const second = isolatedRun(root);
    if (second.createdEmbeddings !== 0 || second.reusedEmbeddings < first.documentCount) {
      throw new Error(`second run did not reuse the complete embedding snapshot (${second.reusedEmbeddings}/${first.documentCount})`);
    }
    compareRankings(first.rankings, second.rankings);
    fs.appendFileSync(path.join(root, "src", "typescript", "queue.ts"), "\nexport const recoveryWindow = 32;\n", "utf8");
    const changed = isolatedRun(root);
    if (changed.createdEmbeddings < 1 || changed.reusedEmbeddings < 1) {
      throw new Error("changed-file run did not combine incremental embedding with unchanged snapshot reuse");
    }
    const durationMs = Date.now() - started;
    if (durationMs > 15 * 60_000) throw new Error(`Tier B exceeded its 15 minute budget (${durationMs} ms).`);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "benchmark-tier-b.v1", fixtureNotEvidence: true, valid: true, offline: true,
      languages: ["python", "typescript", "go", "java", "cpp"], durationMs,
      first: summary(first), second: summary(second), changed: summary(changed)
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runWorker(root: string): Promise<void> {
  const runtime = new KairnRuntime(root, { semantic: { mode: "semantic", modelId: "jina-code-v2-q8" } });
  try {
    const initialized = await runtime.init();
    if (initialized.semantic.status !== "ready") throw new Error(`semantic index is ${initialized.semantic.status}`);
    const rankings: Array<{ queryId: string; paths: string[]; similarities: number[] }> = [];
    for (const item of queries) {
      const result = await runtime.inspectEvidenceCandidates({ query: item.query, limit: 64 });
      const semantic = result.enrichedCandidates.filter((candidate) => candidate.features.semantic > 0);
      if (semantic.length === 0) throw new Error(`${item.id} produced no model-backed semantic candidate`);
      rankings.push({
        queryId: item.id,
        paths: semantic.slice(0, 10).map((candidate) => candidate.path),
        similarities: semantic.slice(0, 10).map((candidate) => candidate.features.semantic)
      });
    }
    process.stdout.write(`${JSON.stringify({
      documentCount: initialized.semantic.documents,
      createdEmbeddings: initialized.semantic.createdEmbeddings,
      reusedEmbeddings: initialized.semantic.reusedEmbeddings,
      rankings
    })}\n`);
  } finally { runtime.close(); }
}

function isolatedRun(root: string): WorkerResult {
  const result = spawnSync(process.execPath, [
    path.resolve("node_modules/tsx/dist/cli.mjs"), scriptPath, "--worker", root
  ], {
    cwd: path.resolve(path.dirname(scriptPath), ".."), encoding: "utf8", timeout: 5 * 60_000,
    env: { ...process.env, KAIRN_CANDIDATE_MODE: "semantic", KAIRN_SEMANTIC_MODEL: "jina-code-v2-q8" }
  });
  if (result.status !== 0) throw new Error(`Tier B isolated worker failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim()) as WorkerResult;
}

function compareRankings(left: WorkerResult["rankings"], right: WorkerResult["rankings"]): void {
  if (left.length !== right.length) throw new Error("semantic query count changed between isolated runs");
  for (let index = 0; index < left.length; index += 1) {
    const first = left[index]!; const second = right[index]!;
    if (first.queryId !== second.queryId || JSON.stringify(first.paths) !== JSON.stringify(second.paths)) {
      throw new Error(`${first.queryId} ranking paths changed across unchanged isolated runs`);
    }
    first.similarities.forEach((value, similarityIndex) => {
      if (Math.abs(value - (second.similarities[similarityIndex] ?? Number.NaN)) > 1e-5) {
        throw new Error(`${first.queryId} similarity exceeded numeric tolerance`);
      }
    });
  }
}

function writeFixture(root: string): void {
  const files: Record<string, string> = {
    "src/python/lease.py": "def extend_lease(record, now):\n    record.expires_at = now + record.ttl\n    return record\n",
    "src/typescript/queue.ts": "export function applyBackpressure(pending: number, capacity: number) { return pending >= capacity; }\n",
    "src/go/breaker.go": "package breaker\nfunc ShouldTrip(failures int, threshold int) bool { return failures >= threshold }\n",
    "src/java/Invoice.java": "package billing; public final class Invoice { public long roundCents(double value) { return Math.round(value * 100); } }\n",
    "src/cpp/checksum.cpp": "#include <cstdint>\nuint32_t verify_packet(const unsigned char* bytes, int size) { uint32_t sum=0; for(int i=0;i<size;i++) sum+=bytes[i]; return sum; }\n"
  };
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source, "utf8");
  }
  fs.writeFileSync(path.join(root, ".gitignore"), ".kairn/\n", "utf8");
}

type WorkerResult = { documentCount: number; createdEmbeddings: number; reusedEmbeddings: number; rankings: Array<{ queryId: string; paths: string[]; similarities: number[] }> };
function summary(result: WorkerResult) { return { documentCount: result.documentCount, createdEmbeddings: result.createdEmbeddings, reusedEmbeddings: result.reusedEmbeddings }; }
