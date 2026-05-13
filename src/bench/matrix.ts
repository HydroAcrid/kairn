import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BenchmarkCase,
  BenchmarkMatrixCaseResult,
  BenchmarkMatrixGates,
  BenchmarkMatrixRepoResult,
  BenchmarkMatrixReport,
  BenchmarkRepoMatrix,
  BenchmarkRepoTarget
} from "../types.js";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import { estimateTokens } from "../utils/tokens.js";
import { nowIso } from "../utils/time.js";

const DEFAULT_GATES: Required<BenchmarkMatrixGates> = {
  maxStateMb: 250,
  maxPrimeLatencyMs: 5000,
  maxRepoPreflightMs: 120000,
  expectedTopK: 5,
  requireSuppressionForWeakCases: true
};

export function loadBenchmarkRepoMatrix(input: { matrixPath: string }): BenchmarkRepoMatrix {
  const absolute = path.resolve(input.matrixPath);
  const raw = JSON.parse(fs.readFileSync(absolute, "utf8")) as Partial<BenchmarkRepoMatrix>;
  if (!raw.id || !raw.name || !Array.isArray(raw.repos)) {
    throw new Error(`Invalid benchmark repo matrix: ${absolute}`);
  }

  return {
    id: raw.id,
    name: raw.name,
    gates: raw.gates ?? {},
    repos: raw.repos.map((repo) => normalizeRepoTarget(repo, absolute))
  };
}

export async function runBenchmarkRepoMatrix(input: {
  matrixPath: string;
  workdir?: string | undefined;
}): Promise<BenchmarkMatrixReport> {
  const startedAt = nowIso();
  const matrix = loadBenchmarkRepoMatrix({ matrixPath: input.matrixPath });
  const workdir = input.workdir ? path.resolve(input.workdir) : fs.mkdtempSync(path.join(os.tmpdir(), "kairn-repo-matrix-"));
  fs.mkdirSync(workdir, { recursive: true });

  const repos: BenchmarkMatrixRepoResult[] = [];
  for (const repo of matrix.repos) {
    const gates = resolveGates(matrix.gates, repo.gates);
    repos.push(await runRepoPreflight({ matrixPath: input.matrixPath, repo, workdir, gates }));
  }

  const endedAt = nowIso();
  const totals = {
    repos: repos.length,
    passedRepos: repos.filter((repo) => repo.status === "passed").length,
    failedRepos: repos.filter((repo) => repo.status === "failed").length,
    skippedRepos: repos.filter((repo) => repo.status === "skipped").length,
    cases: repos.reduce((sum, repo) => sum + repo.cases.length, 0),
    qualityPassingCases: repos.reduce((sum, repo) => sum + repo.cases.filter((item) => item.qualityGatePassed).length, 0),
    statePassingRepos: repos.filter((repo) => repo.stateWithinLimit).length
  };

  return {
    id: matrix.id,
    name: matrix.name,
    startedAt,
    endedAt,
    repos,
    totals,
    recommendations: matrixRecommendations(repos)
  };
}

async function runRepoPreflight(input: {
  matrixPath: string;
  repo: BenchmarkRepoTarget;
  workdir: string;
  gates: Required<BenchmarkMatrixGates>;
}): Promise<BenchmarkMatrixRepoResult> {
  let rootPath: string | undefined;
  const repoStartedAt = Date.now();
  try {
    rootPath = prepareRepo(input.repo, input.workdir);
    if (input.repo.setupCommands?.length) {
      for (const command of input.repo.setupCommands) {
        execSync(command, { cwd: rootPath, stdio: "pipe", shell: process.env.SHELL ?? "/bin/sh" });
      }
    }
    if (repoTimedOut(repoStartedAt, input.gates)) {
      return {
        repo: input.repo,
        rootPath,
        status: "failed",
        index: emptyIndex(input.gates),
        gates: input.gates,
        stateWithinLimit: false,
        elapsedMs: Date.now() - repoStartedAt,
        timedOut: true,
        cases: [],
        weakestCases: [],
        recommendations: [`Repo preflight exceeded ${input.gates.maxRepoPreflightMs}ms before indexing completed.`]
      };
    }

    const runtime = new KairnRuntime(rootPath);
    try {
      await runtime.init();
      const index = runtime.getIndexStatus();
      const cases: BenchmarkMatrixCaseResult[] = [];
      let timedOut = repoTimedOut(repoStartedAt, input.gates);
      for (const benchmarkCase of input.repo.cases) {
        if (timedOut) break;
        cases.push(await runCasePreflight({ runtime, rootPath, repoId: input.repo.id, benchmarkCase, gates: input.gates }));
        timedOut = repoTimedOut(repoStartedAt, input.gates);
      }
      const stateWithinLimit = bytesToMb(index.totalSizeBytes) <= input.gates.maxStateMb;
      const status = !timedOut && stateWithinLimit && cases.every((item) => item.qualityGatePassed) ? "passed" : "failed";
      const recommendations = repoRecommendations({ stateWithinLimit, cases, gates: input.gates });
      if (timedOut) {
        recommendations.unshift(`Repo preflight exceeded ${input.gates.maxRepoPreflightMs}ms; use a smaller sample or improve query-local latency before live runs.`);
      }
      return {
        repo: input.repo,
        rootPath,
        status,
        index: {
          files: index.fileCount,
          totalSizeBytes: index.totalSizeBytes,
          totalSizeMb: round(bytesToMb(index.totalSizeBytes), 2),
          softMaxSizeMb: round(bytesToMb(index.maxStateBytes), 2),
          hardMaxSizeMb: round(bytesToMb(index.hardMaxStateBytes), 2),
          graphEdges: index.graphEdgeCount,
          semanticChunks: index.semanticChunkCount,
          lexicalTerms: index.lexicalTermCount,
          tiers: index.tiers
        },
        gates: input.gates,
        stateWithinLimit,
        elapsedMs: Date.now() - repoStartedAt,
        ...(timedOut ? { timedOut } : {}),
        cases,
        weakestCases: cases.filter((item) => !item.qualityGatePassed).slice(0, 5),
        recommendations
      };
    } finally {
      runtime.close();
    }
  } catch (error) {
    return {
      repo: input.repo,
      ...(rootPath ? { rootPath } : {}),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      index: emptyIndex(input.gates),
      gates: input.gates,
      stateWithinLimit: false,
      elapsedMs: Date.now() - repoStartedAt,
      cases: [],
      weakestCases: [],
      recommendations: ["Repo preflight failed before case scoring; inspect clone/setup/index errors."]
    };
  }
}

async function runCasePreflight(input: {
  runtime: KairnRuntime;
  rootPath: string;
  repoId: string;
  benchmarkCase: BenchmarkCase;
  gates: Required<BenchmarkMatrixGates>;
}): Promise<BenchmarkMatrixCaseResult> {
  const task = input.benchmarkCase.query ?? input.benchmarkCase.task;
  const started = Date.now();
  const prime = await input.runtime.primeContext({
    task,
    budget: input.benchmarkCase.budget,
    refreshIndex: false
  });
  const primeLatencyMs = Date.now() - started;
  const returnedFiles = prime.files;
  const topFiles = returnedFiles.slice(0, input.gates.expectedTopK);
  const absentExpectedFiles = input.benchmarkCase.expectedFiles.filter((file) => !fs.existsSync(path.join(input.rootPath, file)));
  const scorableExpectedFiles = input.benchmarkCase.expectedFiles.filter((file) => !absentExpectedFiles.includes(file));
  const missingExpectedFiles = scorableExpectedFiles.filter((file) => !topFiles.includes(file));
  const expectedHits = scorableExpectedFiles.filter((file) => topFiles.includes(file));
  const excludedHits = returnedFiles.filter((file) =>
    input.benchmarkCase.excludedFiles.some((excluded) => benchmarkPathMatches(file, excluded))
  );
  const noisePrefixHits = returnedFiles.filter((file) => isNoisyMatrixPath(file));
  const companionReasons = extractCompanionReasons(prime.metadata?.companionCandidates);
  const companionFilesReturned = Object.keys(companionReasons).filter((file) => returnedFiles.includes(file));
  const expectedCompanions = scorableExpectedFiles.slice(1);
  const missingCompanionFiles = expectedCompanions.filter((file) => !topFiles.includes(file));
  const sourceVsTestDecision = decideSourceVsTest(returnedFiles);
  const requiresSuppression = shouldRequireSuppression(input.benchmarkCase, input.gates);
  const contextDecision = prime.contextDecision?.action ?? prime.quality?.action;
  const suppressionPassed = !requiresSuppression || contextDecision === "suppress";
  const minExpectedHits = Math.max(0, Math.min(scorableExpectedFiles.length, input.benchmarkCase.minExpectedHits ?? scorableExpectedFiles.length));
  const expectedTopKPassed = scorableExpectedFiles.length === 0 || expectedHits.length >= minExpectedHits;
  const excludedFilesAvoided = excludedHits.length === 0 && noisePrefixHits.length === 0;
  const latencyPassed = primeLatencyMs <= input.gates.maxPrimeLatencyMs;
  const qualityGatePassed = expectedTopKPassed && excludedFilesAvoided && suppressionPassed && latencyPassed;
  const recommendations: string[] = [];

  if (!expectedTopKPassed) {
    recommendations.push(
      minExpectedHits < scorableExpectedFiles.length
        ? `Expected file hits below minimum ${minExpectedHits}/${scorableExpectedFiles.length}; missing from top ${input.gates.expectedTopK}: ${missingExpectedFiles.join(", ")}`
        : `Expected files missing from top ${input.gates.expectedTopK}: ${missingExpectedFiles.join(", ")}`
    );
  }
  if (absentExpectedFiles.length > 0) {
    recommendations.push(`Expected files absent from base checkout and not scored for retrieval: ${absentExpectedFiles.join(", ")}`);
  }
  if (!excludedFilesAvoided) {
    recommendations.push(`Excluded/noisy files returned: ${uniqueStrings([...excludedHits, ...noisePrefixHits]).join(", ")}`);
  }
  if (missingCompanionFiles.length > 0 && scorableExpectedFiles.length > 1) {
    recommendations.push(`Companion files missing from top ${input.gates.expectedTopK}: ${missingCompanionFiles.join(", ")}`);
  }
  if (!suppressionPassed) {
    recommendations.push("Weak-signal case emitted context instead of suppressing.");
  }
  if (!latencyPassed) {
    recommendations.push(`Prime latency ${primeLatencyMs}ms exceeded ${input.gates.maxPrimeLatencyMs}ms gate.`);
  }

  return {
    repoId: input.repoId,
    caseId: input.benchmarkCase.id,
    task,
    profile: prime.profile,
    expectedFiles: input.benchmarkCase.expectedFiles,
    ...(absentExpectedFiles.length > 0 ? { absentExpectedFiles } : {}),
    returnedFiles,
    missingExpectedFiles,
    companionFilesReturned,
    missingCompanionFiles,
    excludedFiles: input.benchmarkCase.excludedFiles,
    excludedHits,
    noisePrefixHits,
    sourceVsTestDecision,
    companionReasons,
    ...(input.benchmarkCase.officialEvaluation ? { officialEvaluation: input.benchmarkCase.officialEvaluation } : {}),
    primeTokens: prime.tokenEstimate || estimateTokens(prime.content),
    primeLatencyMs,
    ...(prime.timings ? { timings: prime.timings } : {}),
    ...(contextDecision ? { contextDecision } : {}),
    ...(prime.quality?.score !== undefined ? { qualityScore: prime.quality.score } : {}),
    expectedTopKPassed,
    excludedFilesAvoided,
    suppressionPassed,
    qualityGatePassed,
    summary: qualityGatePassed ? "Preflight quality gate passed." : "Preflight quality gate failed.",
    recommendations
  };
}

function normalizeRepoTarget(repo: BenchmarkRepoTarget, matrixPath: string): BenchmarkRepoTarget {
  if (!repo.id || !Array.isArray(repo.cases)) {
    throw new Error(`Invalid repo target in matrix ${matrixPath}`);
  }
  if (!repo.localPath && !repo.repoUrl) {
    throw new Error(`Repo target ${repo.id} must specify localPath or repoUrl`);
  }
  return {
    ...repo,
    ...(repo.localPath ? { localPath: resolveMaybeRelative(repo.localPath, path.dirname(matrixPath)) } : {}),
    cases: repo.cases.map((item) => ({
      ...item,
      mode: item.mode ?? "context",
      expectedFiles: item.expectedFiles ?? [],
      excludedFiles: item.excludedFiles ?? []
    }))
  };
}

function prepareRepo(repo: BenchmarkRepoTarget, workdir: string): string {
  if (repo.localPath) {
    const localPath = path.resolve(repo.localPath);
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local repo path does not exist: ${localPath}`);
    }
    return repo.subdir ? path.join(localPath, repo.subdir) : localPath;
  }

  if (!repo.repoUrl) {
    throw new Error(`Repo target ${repo.id} has no localPath or repoUrl`);
  }

  const cloneRoot = path.join(workdir, repo.id);
  if (!fs.existsSync(cloneRoot)) {
    const args = ["clone"];
    if (repo.cloneDepth && repo.cloneDepth > 0) {
      args.push("--depth", String(repo.cloneDepth));
    }
    args.push(repo.repoUrl, cloneRoot);
    execFileSync("git", args, { cwd: workdir, stdio: "pipe" });
  }
  if (repo.ref) {
    checkoutRef(cloneRoot, repo.ref, repo.cloneDepth);
  }
  return repo.subdir ? path.join(cloneRoot, repo.subdir) : cloneRoot;
}

function checkoutRef(rootPath: string, ref: string, depth?: number): void {
  try {
    execFileSync("git", ["checkout", ref], { cwd: rootPath, stdio: "pipe" });
  } catch (error) {
    if (depth && depth > 0) {
      execFileSync("git", ["fetch", "--depth", String(depth), "origin", ref], { cwd: rootPath, stdio: "pipe" });
      execFileSync("git", ["checkout", "FETCH_HEAD"], { cwd: rootPath, stdio: "pipe" });
      return;
    }
    throw error;
  }
}

function resolveMaybeRelative(value: string, base: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function resolveGates(...items: Array<BenchmarkMatrixGates | undefined>): Required<BenchmarkMatrixGates> {
  return {
    ...DEFAULT_GATES,
    ...items.reduce((merged, item) => ({ ...merged, ...(item ?? {}) }), {})
  };
}

function repoTimedOut(startedAt: number, gates: Required<BenchmarkMatrixGates>): boolean {
  return Date.now() - startedAt > gates.maxRepoPreflightMs;
}

function emptyIndex(gates: Required<BenchmarkMatrixGates>): BenchmarkMatrixRepoResult["index"] {
  return {
    files: 0,
    totalSizeBytes: 0,
    totalSizeMb: 0,
    softMaxSizeMb: gates.maxStateMb,
    hardMaxSizeMb: gates.maxStateMb,
    graphEdges: 0,
    semanticChunks: 0,
    lexicalTerms: 0,
    tiers: {}
  };
}

function shouldRequireSuppression(benchmarkCase: BenchmarkCase, gates: Required<BenchmarkMatrixGates>): boolean {
  if (benchmarkCase.successCriteria?.some((entry) => entry.toLowerCase().includes("suppress"))) return true;
  return gates.requireSuppressionForWeakCases && benchmarkCase.expectedFiles.length === 0;
}

function benchmarkPathMatches(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern
      .split("**")
      .map((part) => part.split("*").map(escapeRegex).join("[^/]*"))
      .join(".*");
    return new RegExp(`^${escaped}`).test(normalizedFile);
  }
  if (normalizedPattern.endsWith("/")) {
    return normalizedFile.startsWith(normalizedPattern) || normalizedFile.includes(`/${normalizedPattern}`);
  }
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function isNoisyMatrixPath(filePath: string): boolean {
  return /(^|\/)(docs?|docs_src|documentation|_?examples|demo|demos|devtools|codemods|fixtures|fixture|generated|gen|dist|build|coverage|website|site|playground|storybook|testing|testdata|integration)\//.test(
    normalizePath(filePath)
  );
}

function decideSourceVsTest(returnedFiles: string[]): string {
  const first = returnedFiles[0];
  if (!first) return "no_files";
  if (isTestPath(first)) return "test_first";
  if (isNoisyMatrixPath(first)) return "noise_first";
  if (returnedFiles.slice(1, 5).some(isTestPath)) return "source_with_test_fanout";
  return "source_first";
}

function isTestPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename) ||
    /(^|\/)(test|tests|testing|spec)\//.test(normalized) ||
    /^test_/.test(basename) ||
    /^test.*\.go$/.test(basename) ||
    /(_test|_spec)\.(py|rb|go|cc|cpp|cxx|c|h|hpp|hh|hxx)$/.test(basename)
  );
}

function extractCompanionReasons(value: unknown): Record<string, string[]> {
  if (!Array.isArray(value)) return {};
  const reasons: Record<string, string[]> = {};
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { file?: unknown; reasons?: unknown };
    if (typeof record.file !== "string" || !Array.isArray(record.reasons)) continue;
    reasons[record.file] = record.reasons.filter((reason): reason is string => typeof reason === "string");
  }
  return reasons;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "").toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function repoRecommendations(input: {
  stateWithinLimit: boolean;
  cases: BenchmarkMatrixCaseResult[];
  gates: Required<BenchmarkMatrixGates>;
}): string[] {
  const recommendations: string[] = [];
  if (!input.stateWithinLimit) {
    recommendations.push(`Index state exceeded ${input.gates.maxStateMb}MB gate; inspect tiering, graph edges, and chunk counts.`);
  }
  for (const item of input.cases.filter((result) => !result.qualityGatePassed)) {
    recommendations.push(`${item.caseId}: ${item.recommendations.join("; ") || "quality gate failed"}`);
  }
  return recommendations;
}

function matrixRecommendations(repos: BenchmarkMatrixRepoResult[]): string[] {
  const recommendations: string[] = [];
  const failedState = repos.filter((repo) => !repo.stateWithinLimit);
  const failedCases = repos.flatMap((repo) => repo.cases.filter((item) => !item.qualityGatePassed));
  if (failedState.length > 0) {
    recommendations.push(`${failedState.length} repo(s) exceeded state gates; prioritize query-local indexing and graph/chunk compaction.`);
  }
  if (failedCases.some((item) => item.missingExpectedFiles.length > 0)) {
    recommendations.push("Some cases missed expected source files in the top results; improve general exact-source rescue before live testing.");
  }
  if (failedCases.some((item) => (item.missingCompanionFiles ?? []).length > 0)) {
    recommendations.push("Some multi-surface cases missed companion files; improve query-local companion routing before live testing.");
  }
  if (failedCases.some((item) => !item.suppressionPassed)) {
    recommendations.push("Weak-signal prompts emitted context; tighten adaptive suppression before hook-heavy tests.");
  }
  if (failedCases.some((item) => item.excludedHits.length > 0 || (item.noisePrefixHits ?? []).length > 0)) {
    recommendations.push("Noisy docs/examples/generated files appeared; strengthen source-vs-noise ranking generally.");
  }
  if (failedCases.some((item) => item.recommendations.length > 0)) {
    recommendations.push("Some cases failed non-retrieval gates such as latency or suppression; inspect weakest case recommendations before live-agent tests.");
  }
  return recommendations.length > 0 ? recommendations : ["Matrix preflight passed current quality and state gates."];
}

function bytesToMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
