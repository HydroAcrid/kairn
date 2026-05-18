import fs from "node:fs";
import path from "node:path";
import type { BenchmarkAssistanceMode, BenchmarkCase, BenchmarkSuite, FileRecord } from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";
import { normalizeDiffScopes, normalizeSourceInvariants } from "./enduranceSuite.js";

export function loadBenchmarkSuite(input: {
  suitePath?: string | undefined;
  files: FileRecord[];
}): BenchmarkSuite {
  if (input.suitePath && input.suitePath !== "default") {
    return normalizeSuite(JSON.parse(fs.readFileSync(input.suitePath, "utf8")) as unknown, path.dirname(path.resolve(input.suitePath)));
  }
  return createDefaultBenchmarkSuite(input.files);
}

export function createDefaultBenchmarkSuite(files: FileRecord[]): BenchmarkSuite {
  const paths = files.map((file) => file.path);
  const uiFiles = select(paths, [
    /jobsapplicationstable\.tsx$/i,
    /jobsdashboardtabs\.tsx$/i,
    /mobile/i,
    /dashboard.*tabs/i,
    /components?\//i,
    /app\/.*page\.tsx$/i
  ], 2);
  const parserFiles = select(paths, [/parser\.(ts|tsx|js|jsx)$/i, /ingest\.(ts|js)$/i, /repository\.(ts|js)$/i], 2);
  const authFiles = select(paths, [/access\.(ts|js)$/i, /auth/i, /api\/.*route\.(ts|js)$/i, /repository\.(ts|js)$/i], 2);
  const testFiles = select(paths, [/\.test\.(ts|tsx|js|jsx)$/i, /\.spec\.(ts|tsx|js|jsx)$/i], 2);
  const sourceTarget = paths.find((file) => file === "src/app.ts") ?? paths.find((file) => /\.(ts|tsx|js|jsx)$/.test(file) && !file.includes(".test.")) ?? paths[0];
  const hookFailureFile = testFiles.find((file) => file.includes("app.test")) ?? testFiles[0] ?? sourceTarget;

  const cases: BenchmarkCase[] = [
      {
        id: "ui-layout-context",
        mode: "context",
        task: "Find the primary mobile layout UI implementation.",
        query: "mobile layout drawer tabs cards filters responsive component",
        expectedFiles: uiFiles,
        excludedFiles: parserFiles,
        budget: 1400,
        successCriteria: ["UI files should rank above parser/repository files."]
      },
      {
        id: "parser-backend-context",
        mode: "context",
        task: "Find backend parsing and ingestion logic.",
        query: "parser ingest repository backend data sync",
        expectedFiles: parserFiles,
        excludedFiles: uiFiles,
        budget: 1400,
        successCriteria: ["Backend files should rank above UI files."]
      },
      {
        id: "owner-auth-context",
        mode: "context",
        task: "Find owner scoping auth and API access code.",
        query: "owner scoping auth access api route permissions",
        expectedFiles: authFiles,
        excludedFiles: [],
        budget: 1200,
        successCriteria: ["Auth/access/API files should be discoverable."]
      },
      {
        id: "related-tests",
        mode: "tests",
        task: "Find tests related to the primary changed source file.",
        ...(sourceTarget ? { target: sourceTarget } : {}),
        expectedFiles: testFiles,
        excludedFiles: [],
        budget: 1000,
        successCriteria: ["Related tests should be suggested when present."]
      },
      {
        id: "diff-review",
        mode: "diff",
        task: "Review the current diff and identify touched files.",
        expectedFiles: [],
        excludedFiles: [],
        budget: 1200,
        successCriteria: ["Changed files should be surfaced in the diff review.", "Default diff replay is informational unless a custom suite supplies expected files."]
      },
      {
        id: "hook-failure-linking",
        mode: "hook",
        task: "Link failing command output back to source or test files.",
        expectedFiles: hookFailureFile ? [hookFailureFile] : [],
        excludedFiles: [],
        budget: 1000,
        successCriteria: ["Failure output should resolve to the referenced file."]
      },
      {
        id: "agent-smoke",
        mode: "agent",
        task: "Optional live-agent smoke run in a disposable clone.",
        agentPrompt: "Run pwd and inspect package scripts. Do not edit files.",
        expectedFiles: [],
        excludedFiles: [],
        allowedCommands: ["pwd", "npm pkg get scripts", "pnpm pkg get scripts"],
        budget: 1000,
        successCriteria: ["Agent runs are skipped unless an explicit agent command is configured."]
      }
    ];

  return {
    id: "default",
    name: "Default Kairn Lightweight Benchmark",
    cases: cases.filter((item) => item.expectedFiles.length > 0 || item.mode === "agent" || item.mode === "diff")
  };
}

function normalizeSuite(input: unknown, suiteDir?: string): BenchmarkSuite {
  if (!isRecord(input)) throw new Error("Benchmark suite must be a JSON object.");
  const id = stringValue(input.id) ?? "custom";
  const name = stringValue(input.name) ?? id;
  const rawCases = Array.isArray(input.cases) ? input.cases : [];
  const cases = rawCases.map((item) => normalizeCase(item, suiteDir));
  if (cases.length === 0) throw new Error("Benchmark suite must include at least one case.");
  return { id, name, cases };
}

function normalizeCase(input: unknown, suiteDir?: string): BenchmarkCase {
  if (!isRecord(input)) throw new Error("Benchmark case must be a JSON object.");
  const id = requireString(input.id, "case.id");
  const mode = requireString(input.mode, `case ${id}.mode`);
  if (!["context", "related", "tests", "diff", "hook", "agent"].includes(mode)) {
    throw new Error(`Unsupported benchmark case mode: ${mode}`);
  }
  const query = stringValue(input.query);
  const target = stringValue(input.target);
  const budget = numberValue(input.budget);
  const agentPrompt = stringValue(input.agentPrompt);
  const allowedCommands = stringList(input.allowedCommands);
  const contextBehavior = normalizeContextBehavior(stringValue(input.contextBehavior));
  const seed = normalizeSeed(input.seed, suiteDir);
  const minExpectedHits = nonNegativeIntegerValue(input.minExpectedHits);
  const qnaEvaluation = normalizeQnaEvaluation(input.qnaEvaluation);
  const officialEvaluation = normalizeOfficialEvaluation(input.officialEvaluation);
  const sourceInvariants = normalizeSourceInvariants(input.sourceInvariants);
  const allowedDiffScopes = normalizeDiffScopes(input.allowedDiffScopes);
  return {
    id,
    mode: mode as BenchmarkCase["mode"],
    task: stringValue(input.task) ?? stringValue(input.query) ?? id,
    ...(query ? { query } : {}),
    ...(target ? { target: normalizeRelativePath(target) } : {}),
    ...(contextBehavior ? { contextBehavior } : {}),
    expectedFiles: normalizeFiles(input.expectedFiles),
    requiredTouchedFiles: normalizeFiles(input.requiredTouchedFiles),
    excludedFiles: normalizeFiles(input.excludedFiles),
    ...(minExpectedHits !== undefined ? { minExpectedHits } : {}),
    ...(budget ? { budget } : {}),
    successCriteria: stringList(input.successCriteria),
    ...(agentPrompt ? { agentPrompt } : {}),
    ...(allowedCommands.length > 0 ? { allowedCommands } : {}),
    ...(seed ? { seed } : {}),
    ...(qnaEvaluation ? { qnaEvaluation } : {}),
    ...(officialEvaluation ? { officialEvaluation } : {}),
    ...(sourceInvariants.length > 0 ? { sourceInvariants } : {}),
    ...(allowedDiffScopes.length > 0 ? { allowedDiffScopes } : {})
  };
}

function normalizeQnaEvaluation(value: unknown): BenchmarkCase["qnaEvaluation"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Benchmark case qnaEvaluation must be a JSON object.");
  const minSourceMentions = nonNegativeIntegerValue(value.minSourceMentions);
  const requireNoRepoChanges = booleanValue(value.requireNoRepoChanges);
  const expectedAnswerTerms = stringList(value.expectedAnswerTerms);
  return {
    ...(minSourceMentions !== undefined ? { minSourceMentions } : {}),
    ...(requireNoRepoChanges !== undefined ? { requireNoRepoChanges } : {}),
    ...(expectedAnswerTerms.length > 0 ? { expectedAnswerTerms } : {})
  };
}

function normalizeOfficialEvaluation(value: unknown): BenchmarkCase["officialEvaluation"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Benchmark case officialEvaluation must be a JSON object.");
  const source = stringValue(value.source);
  const taskClass = stringValue(value.taskClass);
  const evaluator = stringValue(value.evaluator);
  const kairnApplicability = stringValue(value.kairnApplicability);
  const kairnMetricEligible = booleanValue(value.kairnMetricEligible);
  const liveRisk = stringValue(value.liveRisk);
  if (!source || !taskClass || !evaluator || !kairnApplicability || !liveRisk || kairnMetricEligible === undefined) {
    throw new Error("Benchmark case officialEvaluation is missing required fields.");
  }
  if (!["swe_atlas_qna", "swe_bench_pro", "kairn_native"].includes(source)) {
    throw new Error(`Unsupported officialEvaluation source: ${source}`);
  }
  if (
    ![
      "source_grounded_explanation",
      "patch_verification",
      "multi_file_debug",
      "failure_first_debug",
      "cheap_single_source",
      "source_rescue",
      "runtime_procedural",
      "weak_signal"
    ].includes(taskClass)
  ) {
    throw new Error(`Unsupported officialEvaluation taskClass: ${taskClass}`);
  }
  if (!["source_grounded_answer", "patch_verification", "runtime_procedural_answer", "retrieval_preflight"].includes(evaluator)) {
    throw new Error(`Unsupported officialEvaluation evaluator: ${evaluator}`);
  }
  if (!["strong", "partial", "weak", "not_applicable"].includes(kairnApplicability)) {
    throw new Error(`Unsupported officialEvaluation kairnApplicability: ${kairnApplicability}`);
  }
  if (!["low", "medium", "high"].includes(liveRisk)) {
    throw new Error(`Unsupported officialEvaluation liveRisk: ${liveRisk}`);
  }
  const reasons = stringList(value.reasons);
  const recommendedModes: BenchmarkAssistanceMode[] = stringList(value.recommendedModes)
    .filter((mode) =>
      [
        "baseline",
        "prompt_only",
        "prompt_plus_hooks",
        "manual_prime",
        "hook_full_prime",
        "hook_tiny_directive",
        "hook_tiny_with_failures",
        "kairn_codex_session",
        "kairn_codex_session_no_governor",
        "mcp_first",
        "real_mcp_first",
        "mcp_first_plus_hook_full_prime",
        "hybrid_mcp_brief",
        "passive_hooks",
        "proactive"
      ].includes(mode)
    ) as BenchmarkAssistanceMode[];
  const normalized = {
    source: source as NonNullable<BenchmarkCase["officialEvaluation"]>["source"],
    taskClass: taskClass as NonNullable<BenchmarkCase["officialEvaluation"]>["taskClass"],
    evaluator: evaluator as NonNullable<BenchmarkCase["officialEvaluation"]>["evaluator"],
    kairnApplicability: kairnApplicability as NonNullable<BenchmarkCase["officialEvaluation"]>["kairnApplicability"],
    kairnMetricEligible,
    liveRisk: liveRisk as NonNullable<BenchmarkCase["officialEvaluation"]>["liveRisk"],
    reasons,
    ...(recommendedModes.length > 0 ? { recommendedModes } : {})
  };
  return normalized;
}

function normalizeSeed(value: unknown, suiteDir?: string) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Benchmark case seed must be a JSON object.");
  const repoUrl = requireString(value.repoUrl, "case.seed.repoUrl");
  const ref = stringValue(value.ref);
  const cloneDepth = numberValue(value.cloneDepth);
  const setupPatch = stringValue(value.setupPatch);
  const setupPatchFile = resolveSuitePath(stringValue(value.setupPatchFile), suiteDir);
  const expectedFailureCommand = stringValue(value.expectedFailureCommand);
  const testCommand = stringValue(value.testCommand);
  const setupCommands = stringList(value.setupCommands);
  return {
    repoUrl,
    ...(ref ? { ref } : {}),
    ...(cloneDepth ? { cloneDepth } : {}),
    ...(setupCommands.length > 0 ? { setupCommands } : {}),
    ...(setupPatch ? { setupPatch } : {}),
    ...(setupPatchFile ? { setupPatchFile } : {}),
    ...(expectedFailureCommand ? { expectedFailureCommand } : {}),
    ...(testCommand ? { testCommand } : {})
  };
}

function resolveSuitePath(value: string | undefined, suiteDir?: string): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  return suiteDir ? path.resolve(suiteDir, value) : value;
}

function select(paths: string[], patterns: RegExp[], limit: number): string[] {
  const selected: string[] = [];
  for (const pattern of patterns) {
    for (const filePath of paths) {
      if (selected.includes(filePath)) continue;
      if (pattern.test(filePath)) selected.push(filePath);
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

function normalizeFiles(value: unknown): string[] {
  return stringList(value).map((entry) => normalizeRelativePath(entry));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim())
    : [];
}

function requireString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`Missing required ${label}.`);
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeContextBehavior(value: string | undefined): BenchmarkCase["contextBehavior"] | undefined {
  if (!value) return undefined;
  if (
    value === "cheap_single_source" ||
    value === "source_rescue" ||
    value === "multi_file_debug" ||
    value === "failure_first" ||
    value === "session_repeat" ||
    value === "weak_signal"
  ) {
    return value;
  }
  throw new Error(`Unsupported benchmark contextBehavior: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
