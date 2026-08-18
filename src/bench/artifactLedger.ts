// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertStageDoesNotOpenHoldout, BENCHMARK_RUN_SCHEMA, loadBenchmarkCampaign, type BenchmarkStage } from "./campaign.js";

export type BenchmarkRunManifest = {
  schemaVersion: typeof BENCHMARK_RUN_SCHEMA;
  runId: string;
  campaignId: string;
  campaignFingerprint: string;
  stage: BenchmarkStage;
  createdAt: string;
  sourceCommit: string;
  status: "initialized" | "running" | "complete" | "invalid";
  nonEvidence: boolean;
};

export type ArtifactLedgerEntry = {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  schema: string;
  producer: string[];
  inputs: Array<{ id: string; sha256: string }>;
  startedAt: string;
  completedAt: string;
  status: "complete" | "invalid";
};

export type ArtifactLedger = {
  schemaVersion: "benchmark-artifact-index.v1";
  runId: string;
  campaignFingerprint: string;
  artifacts: ArtifactLedgerEntry[];
};

export function initializeBenchmarkRun(input: {
  manifestPath: string;
  stage: BenchmarkStage;
  artifactsRoot?: string;
  runId?: string;
  sourceCommit: string;
}): { runDirectory: string; manifest: BenchmarkRunManifest; ledger: ArtifactLedger } {
  const resolved = loadBenchmarkCampaign(input.manifestPath);
  assertStageDoesNotOpenHoldout(resolved, input.stage);
  const runId = input.runId ?? `${input.stage}-${resolved.fingerprint.slice(0, 16)}`;
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(runId)) throw new Error("runId contains unsupported characters");
  const root = path.resolve(input.artifactsRoot ?? "artifacts/runs");
  const runDirectory = path.resolve(root, resolved.campaign.campaignId, runId);
  assertWithin(root, runDirectory);
  fs.mkdirSync(runDirectory, { recursive: true });
  for (const directory of ["logs", "candidates", "training", "models", "evaluation"]) {
    fs.mkdirSync(path.join(runDirectory, directory), { recursive: true });
  }
  const manifest: BenchmarkRunManifest = {
    schemaVersion: BENCHMARK_RUN_SCHEMA,
    runId,
    campaignId: resolved.campaign.campaignId,
    campaignFingerprint: resolved.fingerprint,
    stage: input.stage,
    createdAt: new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    status: "initialized",
    nonEvidence: resolved.campaign.nonEvidence
  };
  const manifestPath = path.join(runDirectory, "run-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BenchmarkRunManifest;
    for (const key of ["runId", "campaignId", "campaignFingerprint", "stage", "sourceCommit"] as const) {
      if (previous[key] !== manifest[key]) throw new Error(`run resume mismatch for ${key}; use a new run id`);
    }
    manifest.createdAt = previous.createdAt;
    manifest.status = previous.status;
    manifest.nonEvidence = previous.nonEvidence;
  } else writeAtomicJson(manifestPath, manifest);
  const ledgerPath = path.join(runDirectory, "artifact-index.json");
  const ledger: ArtifactLedger = fs.existsSync(ledgerPath)
    ? validateArtifactLedger(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), manifest)
    : { schemaVersion: "benchmark-artifact-index.v1", runId, campaignFingerprint: resolved.fingerprint, artifacts: [] };
  if (!fs.existsSync(ledgerPath)) writeAtomicJson(ledgerPath, ledger);
  return { runDirectory, manifest, ledger };
}

export function registerRunArtifact(input: {
  runDirectory: string;
  runManifest: BenchmarkRunManifest;
  id: string;
  filePath: string;
  schema: string;
  producer: string[];
  inputs: Array<{ id: string; sha256: string }>;
  startedAt: string;
}): ArtifactLedgerEntry {
  const runDirectory = path.resolve(input.runDirectory);
  const filePath = path.resolve(input.filePath);
  assertWithin(runDirectory, filePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`run artifact is missing: ${filePath}`);
  const entry: ArtifactLedgerEntry = {
    id: input.id,
    path: path.relative(runDirectory, filePath).replace(/\\/g, "/"),
    sha256: fileSha256(filePath),
    bytes: fs.statSync(filePath).size,
    schema: input.schema,
    producer: [...input.producer],
    inputs: [...input.inputs].sort((left, right) => left.id.localeCompare(right.id)),
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    status: "complete"
  };
  const ledgerPath = path.join(runDirectory, "artifact-index.json");
  const ledger = validateArtifactLedger(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), input.runManifest);
  const existing = ledger.artifacts.find((artifact) => artifact.id === input.id);
  if (existing && existing.sha256 !== entry.sha256) throw new Error(`artifact '${input.id}' changed within an existing run`);
  if (!existing) ledger.artifacts.push(entry);
  ledger.artifacts.sort((left, right) => left.id.localeCompare(right.id));
  writeAtomicJson(ledgerPath, ledger);
  return existing ?? entry;
}

export function updateRunStatus(runDirectory: string, status: BenchmarkRunManifest["status"]): BenchmarkRunManifest {
  const manifestPath = path.join(path.resolve(runDirectory), "run-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BenchmarkRunManifest;
  manifest.status = status;
  writeAtomicJson(manifestPath, manifest);
  return manifest;
}

export function verifyRegisteredArtifacts(runDirectory: string): ArtifactLedger {
  const root = path.resolve(runDirectory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "run-manifest.json"), "utf8")) as BenchmarkRunManifest;
  const ledger = validateArtifactLedger(JSON.parse(fs.readFileSync(path.join(root, "artifact-index.json"), "utf8")), manifest);
  for (const artifact of ledger.artifacts) {
    const target = path.resolve(root, artifact.path);
    assertWithin(root, target);
    if (!fs.existsSync(target) || fileSha256(target) !== artifact.sha256) throw new Error(`registered artifact '${artifact.id}' is missing or corrupt`);
  }
  return ledger;
}

function validateArtifactLedger(value: unknown, manifest: BenchmarkRunManifest): ArtifactLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact ledger must be an object");
  const ledger = value as ArtifactLedger;
  if (ledger.schemaVersion !== "benchmark-artifact-index.v1" || ledger.runId !== manifest.runId || ledger.campaignFingerprint !== manifest.campaignFingerprint || !Array.isArray(ledger.artifacts)) {
    throw new Error("artifact ledger does not match the run manifest");
  }
  return ledger;
}
function assertWithin(root: string, target: string): void { const normalizedRoot = path.resolve(root); const normalizedTarget = path.resolve(target); if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) throw new Error(`path escapes benchmark root: ${target}`); }
function writeAtomicJson(filePath: string, value: unknown): void { const staged = `${filePath}.partial-${process.pid}-${crypto.randomUUID()}`; fs.writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); fs.renameSync(staged, filePath); }
function fileSha256(filePath: string): string { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
