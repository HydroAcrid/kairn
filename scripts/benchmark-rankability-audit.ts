// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeBenchmarkRun, registerRunArtifact, updateRunStatus, verifyRegisteredArtifacts } from "../src/bench/artifactLedger.js";
import { benchmarkInfrastructureEvidenceHash, runBenchmarkDoctor } from "../src/bench/benchmarkDoctor.js";
import { loadBenchmarkCampaign } from "../src/bench/campaign.js";
import { buildRankabilityAudit, formatRankabilityAuditMarkdown } from "../src/bench/rankabilityAudit.js";

const options = parseArgs(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const campaign = loadBenchmarkCampaign(options.manifest);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const run = initializeBenchmarkRun({
  manifestPath: options.manifest,
  stage: "rankability",
  ...(options.runId ? { runId: options.runId } : {}),
  ...(options.outRoot ? { artifactsRoot: options.outRoot } : {}),
  sourceCommit
});

try {
  if (options.resume && run.manifest.status === "complete") {
    verifyRegisteredArtifacts(run.runDirectory);
    process.stdout.write(`${JSON.stringify({ runDirectory: run.runDirectory, status: "complete", resumed: true }, null, 2)}\n`);
    process.exit(0);
  }
  updateRunStatus(run.runDirectory, "running");
  const infrastructureStartedAt = new Date().toISOString();
  const infrastructure = runBenchmarkDoctor({ manifestPath: options.manifest, profile: "ranker", repositoryRoot: root });
  const infrastructurePath = path.join(run.runDirectory, "infrastructure-report.json");
  fs.writeFileSync(infrastructurePath, `${JSON.stringify(infrastructure, null, 2)}\n`, "utf8");
  registerRunArtifact({
    runDirectory: run.runDirectory,
    runManifest: run.manifest,
    id: "infrastructure-report",
    filePath: infrastructurePath,
    schema: infrastructure.schemaVersion,
    producer: ["pnpm", "benchmark:doctor", "--profile", "ranker"],
    inputs: [{ id: "campaign", sha256: campaign.manifestSha256 }],
    startedAt: infrastructureStartedAt
  });
  if (!infrastructure.valid) throw new Error("benchmark infrastructure is invalid; rankability effectiveness was not evaluated");

  const inputArtifact = requiredArtifact("rankability-input", "candidate_pool");
  const modelArtifacts = [requiredArtifact("model-v166", "model"), requiredArtifact("model-v170", "model")];
  const auditStartedAt = new Date().toISOString();
  const audit = buildRankabilityAudit({
    inputPath: inputArtifact.absolutePath,
    modelPaths: modelArtifacts.map((artifact) => artifact.absolutePath),
    infrastructureValid: infrastructure.valid,
    campaignFingerprint: campaign.fingerprint,
    infrastructureEvidenceSha256: benchmarkInfrastructureEvidenceHash(infrastructure)
  });
  const jsonPath = path.join(run.runDirectory, "evaluation", "rankability-audit.v2.json");
  const markdownPath = path.join(run.runDirectory, "evaluation", "rankability-audit.v2.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, formatRankabilityAuditMarkdown(audit), "utf8");
  const inputs = [inputArtifact, ...modelArtifacts].map((artifact) => ({ id: artifact.id, sha256: artifact.sha256 }));
  registerRunArtifact({
    runDirectory: run.runDirectory,
    runManifest: run.manifest,
    id: "rankability-audit-json",
    filePath: jsonPath,
    schema: audit.schemaVersion,
    producer: ["pnpm", "benchmark:rankability-audit"],
    inputs,
    startedAt: auditStartedAt
  });
  registerRunArtifact({
    runDirectory: run.runDirectory,
    runManifest: run.manifest,
    id: "rankability-audit-markdown",
    filePath: markdownPath,
    schema: "rankability-audit-markdown.v1",
    producer: ["pnpm", "benchmark:rankability-audit"],
    inputs: [{ id: "rankability-audit-json", sha256: sha256(jsonPath) }],
    startedAt: auditStartedAt
  });
  verifyRegisteredArtifacts(run.runDirectory);
  updateRunStatus(run.runDirectory, "complete");
  process.stdout.write(`${JSON.stringify({
    runDirectory: run.runDirectory,
    status: "complete",
    classification: audit.classification,
    dataValid: audit.data.valid,
    nextExperiment: audit.nextExperiment
  }, null, 2)}\n`);

  function requiredArtifact(id: string, kind: "candidate_pool" | "model") {
    const artifact = campaign.artifacts.find((item) => item.id === id && item.kind === kind);
    if (!artifact || !artifact.allowedStages.includes("rankability")) throw new Error(`campaign is missing rankability artifact '${id}'`);
    return artifact;
  }
} catch (error) {
  updateRunStatus(run.runDirectory, "invalid");
  throw error;
}

function parseArgs(argv: string[]): { manifest: string; runId?: string; outRoot?: string; resume: boolean } {
  const args = argv.filter((token) => token !== "--");
  let manifest = "benchmarks/campaigns/v02c-rankability-audit.json";
  let runId: string | undefined;
  let outRoot: string | undefined;
  let resume = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--manifest") manifest = requiredValue(args, ++index, token);
    else if (token === "--run-id") runId = requiredValue(args, ++index, token);
    else if (token === "--out-root") outRoot = requiredValue(args, ++index, token);
    else if (token === "--resume") resume = true;
    else throw new Error(`unknown argument '${token}'`);
  }
  return {
    manifest: path.resolve(manifest),
    resume,
    ...(runId ? { runId } : {}),
    ...(outRoot ? { outRoot: path.resolve(outRoot) } : {})
  };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
