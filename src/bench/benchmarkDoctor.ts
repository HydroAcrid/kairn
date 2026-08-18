// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertStageDoesNotOpenHoldout, loadBenchmarkCampaign, type ResolvedCampaign } from "./campaign.js";
import { getSemanticModelManifest } from "../semantic/modelRegistry.js";
import { verifySemanticModel } from "../semantic/modelManager.js";

export type BenchmarkDoctorProfile = "ranker" | "live";
export type BenchmarkDoctorCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};
export type BenchmarkInfrastructureReport = {
  schemaVersion: "benchmark-infrastructure-report.v1";
  profile: BenchmarkDoctorProfile;
  campaignId: string;
  campaignFingerprint: string;
  generatedAt: string;
  platform: { platform: NodeJS.Platform; architecture: string; release: string };
  nonEvidence: boolean;
  valid: boolean;
  checks: BenchmarkDoctorCheck[];
  caseIds: Record<"train" | "calibration" | "holdout", string[]>;
};

export type BenchmarkDoctorOptions = {
  manifestPath: string;
  profile: BenchmarkDoctorProfile;
  repositoryRoot?: string;
  allowDirtyFixture?: boolean;
  skipModelFiles?: boolean;
  environment?: NodeJS.ProcessEnv;
  execute?: (command: string, args: string[], cwd: string) => string;
};

export function runBenchmarkDoctor(options: BenchmarkDoctorOptions): BenchmarkInfrastructureReport {
  const root = path.resolve(options.repositoryRoot ?? findRepositoryRoot(path.dirname(path.resolve(options.manifestPath))));
  const execute = options.execute ?? executeCommand;
  const environment = options.environment ?? process.env;
  const checks: BenchmarkDoctorCheck[] = [];
  let resolved: ResolvedCampaign;
  try {
    resolved = loadBenchmarkCampaign(options.manifestPath);
    pass(checks, "campaign", `Validated ${resolved.campaign.campaignId} and ${resolved.artifacts.length} artifact hashes.`);
  } catch (error) {
    fail(checks, "campaign", errorMessage(error));
    return invalidReport(options.profile, checks);
  }

  checkRuntime(checks, resolved, execute, root);
  checkGit(checks, resolved, execute, root, Boolean(options.allowDirtyFixture));
  checkDependencies(checks, root);
  checkDisk(checks, root);
  checkCampaignData(checks, resolved);
  checkSemanticModel(checks, resolved, Boolean(options.skipModelFiles));
  if (options.profile === "live") checkLiveRuntime(checks, execute, root, environment);

  return {
    schemaVersion: "benchmark-infrastructure-report.v1",
    profile: options.profile,
    campaignId: resolved.campaign.campaignId,
    campaignFingerprint: resolved.fingerprint,
    generatedAt: new Date().toISOString(),
    platform: { platform: process.platform, architecture: process.arch, release: os.release() },
    nonEvidence: resolved.campaign.nonEvidence,
    valid: checks.every((check) => check.status !== "fail"),
    checks,
    caseIds: resolved.caseIds
  };
}

function checkRuntime(checks: BenchmarkDoctorCheck[], resolved: ResolvedCampaign, execute: BenchmarkDoctorOptions["execute"] & {}, root: string): void {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  nodeMajor === resolved.campaign.runtime.nodeMajor
    ? pass(checks, "node", `Node ${process.versions.node}.`)
    : fail(checks, "node", `Expected Node ${resolved.campaign.runtime.nodeMajor}, found ${process.versions.node}.`);
  commandVersion(checks, execute, root, "pnpm", ["--version"], resolved.campaign.runtime.pnpm, true);
  commandVersion(checks, execute, root, "python3", ["--version"], resolved.campaign.runtime.python, false, "python");
}

function commandVersion(
  checks: BenchmarkDoctorCheck[], execute: BenchmarkDoctorOptions["execute"] & {}, root: string,
  command: string, args: string[], expected: string, exactMatch: boolean, checkId = command
): void {
  try {
    const actual = execute(command, args, root).trim().replace(/^Python\s+/i, "");
    const matched = exactMatch ? actual === expected : actual.startsWith(`${expected}.`) || actual === expected;
    matched ? pass(checks, checkId, `${command} ${actual}.`) : fail(checks, checkId, `Expected ${expected}${exactMatch ? "" : ".x"}, found ${actual}.`);
  } catch (error) {
    fail(checks, checkId, `${command} is unavailable: ${errorMessage(error)}`);
  }
}

function checkGit(
  checks: BenchmarkDoctorCheck[], resolved: ResolvedCampaign, execute: BenchmarkDoctorOptions["execute"] & {},
  root: string, allowDirtyFixture: boolean
): void {
  try {
    const branch = execute("git", ["branch", "--show-current"], root).trim();
    branch === resolved.campaign.source.branch
      ? pass(checks, "git_branch", `Branch ${branch}.`)
      : fail(checks, "git_branch", `Expected ${resolved.campaign.source.branch}, found ${branch || "detached HEAD"}.`);
    execute("git", ["merge-base", "--is-ancestor", resolved.campaign.source.baseCommit, "HEAD"], root);
    pass(checks, "git_base", `HEAD descends from ${resolved.campaign.source.baseCommit.slice(0, 12)}.`);
    const dirty = execute("git", ["status", "--porcelain", "--untracked-files=normal"], root).trim();
    if (!dirty) pass(checks, "git_clean", "Worktree is clean.");
    else if (resolved.campaign.nonEvidence && allowDirtyFixture) warn(checks, "git_clean", "Dirty fixture run; result is permanently non-evidence.");
    else fail(checks, "git_clean", "Effectiveness runs require a clean worktree.");
    const upstream = execute("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root).trim();
    const [aheadRaw, behindRaw] = execute("git", ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], root).trim().split(/\s+/);
    const ahead = Number(aheadRaw); const behind = Number(behindRaw);
    ahead === 0 && behind === 0
      ? pass(checks, "git_pushed", `HEAD matches ${upstream}.`)
      : fail(checks, "git_pushed", `HEAD differs from ${upstream}: ahead ${ahead}, behind ${behind}.`);
  } catch (error) {
    fail(checks, "git", `Git provenance failed: ${errorMessage(error)}`);
  }
}

function checkDependencies(checks: BenchmarkDoctorCheck[], root: string): void {
  const required = ["node_modules/tsx", "node_modules/vitest", "node_modules/onnxruntime-web"];
  const missing = required.filter((relative) => !fs.existsSync(path.join(root, relative)));
  missing.length === 0 ? pass(checks, "dependencies", "Required local dependencies are installed.")
    : fail(checks, "dependencies", `Missing dependencies: ${missing.join(", ")}. Run pnpm install --frozen-lockfile.`);
}

function checkDisk(checks: BenchmarkDoctorCheck[], root: string): void {
  try {
    const available = Number(fs.statfsSync(root).bavail) * Number(fs.statfsSync(root).bsize);
    const required = 5 * 1024 ** 3;
    available >= required ? pass(checks, "disk", `${formatBytes(available)} available.`)
      : fail(checks, "disk", `At least 5 GiB is required; ${formatBytes(available)} is available.`);
  } catch (error) {
    fail(checks, "disk", `Could not inspect free space: ${errorMessage(error)}`);
  }
}

function checkCampaignData(checks: BenchmarkDoctorCheck[], resolved: ResolvedCampaign): void {
  try {
    assertStageDoesNotOpenHoldout(resolved, "calibration");
    const lineages = new Map<string, string>();
    for (const artifact of resolved.artifacts.filter((item) => item.id === resolved.campaign.cases.artifactId)) {
      const source = fs.readFileSync(artifact.absolutePath, "utf8");
      const rows = resolved.campaign.cases.format === "jsonl_rows"
        ? source.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        : ((JSON.parse(source) as { cases?: Array<Record<string, unknown>> }).cases ?? []);
      for (const row of rows) {
        const lineage = typeof row.repositoryLineageId === "string" ? row.repositoryLineageId : undefined;
        const split = typeof row.split === "string" ? row.split : undefined;
        if (!lineage || !split) continue;
        const previous = lineages.get(lineage);
        if (previous && previous !== split) throw new Error(`lineage '${lineage}' crosses ${previous} and ${split}`);
        lineages.set(lineage, split);
      }
    }
    pass(checks, "data_isolation", `Validated ${lineages.size} lineage assignments; calibration cannot load the detached holdout artifact.`);
  } catch (error) {
    fail(checks, "data_isolation", errorMessage(error));
  }
}

function checkSemanticModel(checks: BenchmarkDoctorCheck[], resolved: ResolvedCampaign, skipModelFiles: boolean): void {
  try {
    const pinned = getSemanticModelManifest(resolved.campaign.semantic.modelId);
    if (pinned.upstreamRevision !== resolved.campaign.semantic.upstreamRevision ||
        pinned.documentSchemaVersion !== resolved.campaign.semantic.documentSchemaVersion) {
      throw new Error("campaign semantic model identity does not match the runtime registry");
    }
    if (skipModelFiles) {
      if (!resolved.campaign.nonEvidence) {
        fail(checks, "semantic_model", "Effectiveness campaigns cannot skip local semantic model verification.");
        return;
      }
      warn(checks, "semantic_model", "Pinned semantic manifest validated; local model files were skipped for a non-evidence fixture.");
      return;
    }
    const state = verifySemanticModel({ modelId: pinned.modelId });
    state.status === "ready" ? pass(checks, "semantic_model", `${state.modelId} is installed and checksummed (${formatBytes(state.totalBytes)}).`)
      : fail(checks, "semantic_model", `${state.modelId} is ${state.status}: ${state.error ?? "unknown error"}`);
  } catch (error) {
    fail(checks, "semantic_model", errorMessage(error));
  }
}

function checkLiveRuntime(
  checks: BenchmarkDoctorCheck[], execute: BenchmarkDoctorOptions["execute"] & {}, root: string, environment: NodeJS.ProcessEnv
): void {
  try {
    const docker = JSON.parse(execute("docker", ["version", "--format", "{{json .}}"], root)) as { Server?: { Version?: string } };
    docker.Server?.Version ? pass(checks, "docker", `Docker server ${docker.Server.Version}.`) : fail(checks, "docker", "Docker server is unavailable.");
  } catch (error) { fail(checks, "docker", `Docker is unavailable: ${errorMessage(error)}`); }
  const imagePins = (environment.KAIRN_BENCHMARK_IMAGES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (imagePins.length === 0) fail(checks, "docker_images", "KAIRN_BENCHMARK_IMAGES must list locally installed sha256-pinned images.");
  else {
    try {
      for (const image of imagePins) {
        if (!/@sha256:[a-f0-9]{64}$/i.test(image)) throw new Error(`${image} is not digest pinned`);
        execute("docker", ["image", "inspect", image], root);
      }
      pass(checks, "docker_images", `Validated ${imagePins.length} local image pin(s).`);
    } catch (error) { fail(checks, "docker_images", errorMessage(error)); }
  }
  environment.ANTHROPIC_API_KEY?.trim() ? pass(checks, "anthropic", "Anthropic credential is configured (value not inspected).")
    : fail(checks, "anthropic", "ANTHROPIC_API_KEY is required for the controlled live host.");
  environment.REASONBLOCKS_API_KEY?.trim() ? pass(checks, "reasonblocks", "ReasonBlocks credential is configured (value not inspected).")
    : fail(checks, "reasonblocks", "REASONBLOCKS_API_KEY is required for the comparison arms.");
  environment.KAIRN_ALLOW_EXTERNAL_TRAJECTORY === "1" ? pass(checks, "trajectory_consent", "External trajectory consent is explicit.")
    : fail(checks, "trajectory_consent", "Set KAIRN_ALLOW_EXTERNAL_TRAJECTORY=1 before live ReasonBlocks runs.");
}

function invalidReport(profile: BenchmarkDoctorProfile, checks: BenchmarkDoctorCheck[]): BenchmarkInfrastructureReport {
  return {
    schemaVersion: "benchmark-infrastructure-report.v1", profile, campaignId: "unresolved",
    campaignFingerprint: "0".repeat(64), generatedAt: new Date().toISOString(),
    platform: { platform: process.platform, architecture: process.arch, release: os.release() },
    nonEvidence: true, valid: false, checks, caseIds: { train: [], calibration: [], holdout: [] }
  };
}

function executeCommand(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function findRepositoryRoot(start: string): string { let current = path.resolve(start); while (true) { if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, ".git"))) return current; const parent = path.dirname(current); if (parent === current) throw new Error("benchmark manifest is outside a repository"); current = parent; } }
function pass(checks: BenchmarkDoctorCheck[], id: string, detail: string): void { checks.push({ id, status: "pass", detail }); }
function warn(checks: BenchmarkDoctorCheck[], id: string, detail: string): void { checks.push({ id, status: "warn", detail }); }
function fail(checks: BenchmarkDoctorCheck[], id: string, detail: string): void { checks.push({ id, status: "fail", detail }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function formatBytes(bytes: number): string { return `${(bytes / 1024 ** 3).toFixed(2)} GiB`; }
