// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeBenchmarkRun, registerRunArtifact, updateRunStatus, verifyRegisteredArtifacts } from "../src/bench/artifactLedger.js";
import { runBenchmarkDoctor } from "../src/bench/benchmarkDoctor.js";
import { loadBenchmarkCampaign, type BenchmarkStage } from "../src/bench/campaign.js";
import { buildRankabilityAudit, formatRankabilityAuditMarkdown } from "../src/bench/rankabilityAudit.js";
import { compareRankerEvaluations } from "../src/bench/rankerComparison.js";

const options = parseArgs(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolved = loadBenchmarkCampaign(options.manifest);
if (options.stage === "holdout" || options.stage === "live") {
  throw new Error("benchmark:reproduce never opens holdout or invokes paid providers; use the separately gated live runner");
}
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const run = initializeBenchmarkRun({
  manifestPath: options.manifest,
  stage: options.stage,
  ...(options.outRoot ? { artifactsRoot: options.outRoot } : {}),
  ...(options.runId ? { runId: options.runId } : {}),
  sourceCommit
});

try {
  updateRunStatus(run.runDirectory, "running");
  const infrastructurePath = path.join(run.runDirectory, "infrastructure-report.json");
  const doctor = runBenchmarkDoctor({ manifestPath: options.manifest, profile: "ranker", repositoryRoot: root });
  fs.writeFileSync(infrastructurePath, `${JSON.stringify(doctor, null, 2)}\n`, "utf8");
  registerRunArtifact({
    runDirectory: run.runDirectory, runManifest: run.manifest, id: "infrastructure-report",
    filePath: infrastructurePath, schema: doctor.schemaVersion,
    producer: ["pnpm", "benchmark:doctor", "--profile", "ranker"],
    inputs: [{ id: "campaign", sha256: resolved.manifestSha256 }], startedAt: doctor.generatedAt
  });
  if (!doctor.valid) throw new Error("benchmark infrastructure is invalid; effectiveness stages were not started");

  if (options.stage === "tier_a") reproduceTierA(run.runDirectory, run.manifest);
  else if (options.stage === "calibration") reproduceCalibration(run.runDirectory, run.manifest, resolved);
  else if (options.stage === "rankability") reproduceRankability(run.runDirectory, run.manifest, resolved);
  else throw new Error(`reproduction does not implement stage ${options.stage}`);
  verifyRegisteredArtifacts(run.runDirectory);
  updateRunStatus(run.runDirectory, "complete");
  process.stdout.write(`${JSON.stringify({ runDirectory: run.runDirectory, status: "complete", stage: options.stage }, null, 2)}\n`);
} catch (error) {
  updateRunStatus(run.runDirectory, "invalid");
  throw error;
}

function reproduceRankability(runDirectory: string, manifest: typeof run.manifest, campaign: ReturnType<typeof loadBenchmarkCampaign>): void {
  if (existingArtifact(runDirectory, "rankability-audit-json") && existingArtifact(runDirectory, "rankability-audit-markdown")) return;
  const input = campaign.artifacts.find((artifact) => artifact.id === "rankability-input" && artifact.kind === "candidate_pool");
  const models = ["model-v166", "model-v170"].map((id) => campaign.artifacts.find((artifact) => artifact.id === id && artifact.kind === "model"));
  if (!input || models.some((model) => !model)) throw new Error("rankability campaign artifacts are incomplete");
  const infrastructurePath = path.join(runDirectory, "infrastructure-report.json");
  const infrastructure = JSON.parse(fs.readFileSync(infrastructurePath, "utf8")) as { valid: boolean };
  const startedAt = new Date().toISOString();
  const audit = buildRankabilityAudit({
    inputPath: input.absolutePath,
    modelPaths: models.map((model) => model!.absolutePath),
    infrastructureValid: infrastructure.valid,
    campaignFingerprint: campaign.fingerprint,
    infrastructureReportSha256: fileHash(infrastructurePath)
  });
  const jsonPath = path.join(runDirectory, "evaluation", "rankability-audit.v2.json");
  const markdownPath = path.join(runDirectory, "evaluation", "rankability-audit.v2.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, formatRankabilityAuditMarkdown(audit), "utf8");
  const inputs = [input, ...models.map((model) => model!)].map((artifact) => ({ id: artifact.id, sha256: artifact.sha256 }));
  registerRunArtifact({ runDirectory, runManifest: manifest, id: "rankability-audit-json", filePath: jsonPath, schema: audit.schemaVersion, producer: ["pnpm", "benchmark:reproduce", "--stage", "rankability"], inputs, startedAt });
  registerRunArtifact({ runDirectory, runManifest: manifest, id: "rankability-audit-markdown", filePath: markdownPath, schema: "rankability-audit-markdown.v1", producer: ["pnpm", "benchmark:reproduce", "--stage", "rankability"], inputs: [{ id: "rankability-audit-json", sha256: fileHash(jsonPath) }], startedAt });
}

function reproduceTierA(runDirectory: string, manifest: typeof run.manifest): void {
  const logPath = path.join(runDirectory, "logs", "tier-a.json");
  const existing = existingArtifact(runDirectory, "tier-a");
  if (existing) return;
  const startedAt = new Date().toISOString();
  const result = spawnSync("pnpm", ["benchmark:tier-a"], {
    cwd: root, encoding: "utf8", timeout: 120_000, shell: process.platform === "win32"
  });
  if (result.status !== 0) throw new Error(`Tier A failed: ${result.stderr || result.stdout}`);
  fs.writeFileSync(logPath, result.stdout, "utf8");
  registerRunArtifact({
    runDirectory, runManifest: manifest, id: "tier-a", filePath: logPath,
    schema: "benchmark-tier-a.v1", producer: ["pnpm", "benchmark:tier-a"],
    inputs: [{ id: "campaign", sha256: resolved.manifestSha256 }], startedAt
  });
}

function reproduceCalibration(runDirectory: string, manifest: typeof run.manifest, campaign: ReturnType<typeof loadBenchmarkCampaign>): void {
  const models = [
    { model: "model-v166", rows: "training-v166" },
    { model: "model-v170", rows: "training-v170" }
  ];
  for (const item of models) {
    if (existingArtifact(runDirectory, item.model)) continue;
    const expectedModel = campaign.artifacts.find((artifact) => artifact.id === item.model)!;
    const rows = campaign.artifacts.find((artifact) => artifact.id === item.rows)!;
    const parsed = JSON.parse(fs.readFileSync(expectedModel.absolutePath, "utf8")) as { modelId: string };
    const target = path.join(runDirectory, "models", `${item.model}.json`);
    const startedAt = new Date().toISOString();
    runCommand("python3", [
      path.join(root, "scripts/train-evidence-ranker.py"), "--input", rows.absolutePath,
      "--out", target, "--model-id", parsed.modelId, "--node", process.execPath,
      "--public-data-only", "--detached-holdout"
    ]);
    const actualHash = fileHash(target);
    if (actualHash !== expectedModel.sha256) throw new Error(`${item.model} reproducibility mismatch: ${actualHash} != ${expectedModel.sha256}`);
    registerRunArtifact({
      runDirectory, runManifest: manifest, id: item.model, filePath: target, schema: "evidence-ranker-artifact.v1",
      producer: ["python3", "scripts/train-evidence-ranker.py"],
      inputs: [{ id: rows.id, sha256: rows.sha256 }], startedAt
    });
  }
  const comparisonPath = path.join(runDirectory, "evaluation", "v166-v170-comparison.json");
  if (!existingArtifact(runDirectory, "ranker-comparison")) {
    const baseline = campaign.artifacts.find((artifact) => artifact.id === "evaluation-v166")!;
    const candidate = campaign.artifacts.find((artifact) => artifact.id === "evaluation-v170")!;
    const infrastructure = JSON.parse(fs.readFileSync(path.join(runDirectory, "infrastructure-report.json"), "utf8")) as { valid: boolean };
    const comparison = compareRankerEvaluations({
      baselinePath: baseline.absolutePath, candidatePath: candidate.absolutePath,
      infrastructureValid: infrastructure.valid, campaignFingerprint: campaign.fingerprint
    });
    fs.writeFileSync(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    registerRunArtifact({
      runDirectory, runManifest: manifest, id: "ranker-comparison", filePath: comparisonPath,
      schema: comparison.schemaVersion, producer: ["pnpm", "benchmark:compare"],
      inputs: [{ id: baseline.id, sha256: baseline.sha256 }, { id: candidate.id, sha256: candidate.sha256 }],
      startedAt: new Date().toISOString()
    });
  }
}

function existingArtifact(runDirectory: string, id: string): boolean {
  const indexPath = path.join(runDirectory, "artifact-index.json");
  const ledger = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
    artifacts?: Array<{ id: string; path: string; sha256: string }>;
  };
  const entry = ledger.artifacts?.find((artifact) => artifact.id === id);
  if (!entry) return false;
  const target = path.resolve(runDirectory, entry.path);
  if (fs.existsSync(target) && fileHash(target) === entry.sha256) return true;
  if (fs.existsSync(target)) {
    const quarantine = path.join(runDirectory, "logs", "quarantine");
    fs.mkdirSync(quarantine, { recursive: true });
    fs.renameSync(target, path.join(quarantine, `${Date.now()}-${path.basename(target)}`));
  }
  return false;
}
function runCommand(command: string, args: string[]): void { const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 120_000 }); if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`); }
function fileHash(filePath: string): string { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }

function parseArgs(argv: string[]): { manifest: string; stage: BenchmarkStage; outRoot?: string; runId?: string } {
  argv = argv.filter((token) => token !== "--");
  let manifest = "benchmarks/campaigns/v02c-infrastructure.json"; let stage: BenchmarkStage = "tier_a";
  let outRoot: string | undefined; let runId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--manifest") manifest = value(argv, ++index, token);
    else if (token === "--stage") stage = value(argv, ++index, token) as BenchmarkStage;
    else if (token === "--out-root") outRoot = value(argv, ++index, token);
    else if (token === "--run-id") runId = value(argv, ++index, token);
    else throw new Error(`unknown argument '${token}'`);
  }
  return { manifest, stage, ...(outRoot ? { outRoot } : {}), ...(runId ? { runId } : {}) };
}
function value(argv: string[], index: number, flag: string): string { const found = argv[index]; if (!found || found.startsWith("--")) throw new Error(`${flag} requires a value`); return found; }
