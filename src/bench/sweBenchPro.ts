import fs from "node:fs";
import path from "node:path";
import type { BenchmarkCase, BenchmarkContextBehavior, BenchmarkRepoMatrix, BenchmarkRepoTarget, BenchmarkSuite } from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";
import { classifySweBenchProTask } from "./officialClassification.js";

const DATASET_ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=ScaleAI%2FSWE-bench_Pro&config=default&split=test";

export type SweBenchProRow = {
  repo: string;
  instance_id: string;
  base_commit: string;
  patch: string;
  test_patch: string;
  problem_statement: string;
  requirements?: string | null;
  interface?: string | null;
  repo_language: string;
  fail_to_pass?: string | null;
  pass_to_pass?: string | null;
  issue_specificity?: string | null;
  issue_categories?: string | null;
  before_repo_set_cmd?: string | null;
  selected_test_files_to_run?: string | null;
  dockerhub_tag?: string | null;
};

export type SweBenchProPilot = {
  generatedAt: string;
  source: string;
  rows: number;
  rawRows: SweBenchProRow[];
  suite: BenchmarkSuite;
  matrix: BenchmarkRepoMatrix;
  summary: {
    languages: Record<string, number>;
    repos: Record<string, number>;
    taskClasses: Record<string, number>;
    evaluators: Record<string, number>;
    applicability: Record<string, number>;
    skippedRows: number;
    warnings: string[];
  };
};

export async function fetchSweBenchProRows(input: {
  offset?: number | undefined;
  length?: number | undefined;
}): Promise<SweBenchProRow[]> {
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const length = Math.max(1, Math.min(100, Math.floor(input.length ?? 20)));
  const response = await fetch(`${DATASET_ROWS_URL}&offset=${offset}&length=${length}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch SWE-Bench Pro rows: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.rows)) {
    throw new Error("Unexpected SWE-Bench Pro rows response.");
  }
  return payload.rows.map((entry) => normalizeDatasetRow(entry)).filter((row): row is SweBenchProRow => Boolean(row));
}

export function loadSweBenchProRows(inputPath: string): SweBenchProRow[] {
  const absolute = path.resolve(inputPath);
  const text = fs.readFileSync(absolute, "utf8");
  const trimmed = text.trim();
  const parsed = trimmed.startsWith("[") || (trimmed.startsWith("{") && !trimmed.includes("\n"))
    ? JSON.parse(text) as unknown
    : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);

  const candidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && typeof parsed.instance_id === "string"
      ? [parsed]
    : isRecord(parsed) && Array.isArray(parsed.rows)
      ? parsed.rows
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : [];
  return candidates.map((entry) => normalizeDatasetRow(entry)).filter((row): row is SweBenchProRow => Boolean(row));
}

export function buildSweBenchProPilot(input: {
  rows: SweBenchProRow[];
  limit?: number | undefined;
  languages?: string[] | undefined;
  repos?: string[] | undefined;
}): SweBenchProPilot {
  const languages = new Set((input.languages ?? []).map((item) => item.toLowerCase()).filter(Boolean));
  const repos = new Set((input.repos ?? []).map((item) => item.toLowerCase()).filter(Boolean));
  const limit = Math.max(1, Math.floor(input.limit ?? input.rows.length));
  const selected: SweBenchProRow[] = [];
  let skippedRows = 0;

  for (const row of input.rows) {
    if (languages.size > 0 && !languages.has(row.repo_language.toLowerCase())) {
      skippedRows += 1;
      continue;
    }
    if (repos.size > 0 && !repos.has(row.repo.toLowerCase())) {
      skippedRows += 1;
      continue;
    }
    selected.push(row);
    if (selected.length >= limit) break;
  }

  const cases = selected.map((row) => sweBenchRowToCase(row));
  const targets = selected.map((row, index) => sweBenchRowToRepoTarget(row, cases[index]!));
  const languageSummary: Record<string, number> = {};
  const repoSummary: Record<string, number> = {};
  const taskClassSummary: Record<string, number> = {};
  const evaluatorSummary: Record<string, number> = {};
  const applicabilitySummary: Record<string, number> = {};
  for (const row of selected) {
    languageSummary[row.repo_language] = (languageSummary[row.repo_language] ?? 0) + 1;
    repoSummary[row.repo] = (repoSummary[row.repo] ?? 0) + 1;
  }
  for (const benchmarkCase of cases) {
    const official = benchmarkCase.officialEvaluation;
    if (!official) continue;
    taskClassSummary[official.taskClass] = (taskClassSummary[official.taskClass] ?? 0) + 1;
    evaluatorSummary[official.evaluator] = (evaluatorSummary[official.evaluator] ?? 0) + 1;
    applicabilitySummary[official.kairnApplicability] = (applicabilitySummary[official.kairnApplicability] ?? 0) + 1;
  }

  const warnings: string[] = [];
  if (selected.length === 0) {
    warnings.push("No SWE-Bench Pro rows matched the requested filters.");
  }
  if (cases.some((item) => item.expectedFiles.length === 0)) {
    warnings.push("Some selected rows have no production patch files; they are weak live-proof candidates.");
  }
  warnings.push("Generated live suites are pilot scaffolds. Full SWE-Bench Pro verification should use Docker evaluator metadata before making leaderboard-style claims.");

  return {
    generatedAt: new Date().toISOString(),
    source: "ScaleAI/SWE-bench_Pro",
    rows: selected.length,
    rawRows: selected,
    suite: {
      id: "swe-bench-pro-pilot-live",
      name: "SWE-Bench Pro Pilot Live Suite",
      cases
    },
    matrix: {
      id: "swe-bench-pro-pilot-matrix",
      name: "SWE-Bench Pro Pilot Repo Matrix",
      gates: {
        maxStateMb: 250,
        maxPrimeLatencyMs: 5000,
        expectedTopK: 5
      },
      repos: targets
    },
    summary: {
      languages: languageSummary,
      repos: repoSummary,
      taskClasses: taskClassSummary,
      evaluators: evaluatorSummary,
      applicability: applicabilitySummary,
      skippedRows,
      warnings
    }
  };
}

export function writeSweBenchProPilot(input: {
  pilot: SweBenchProPilot;
  outDir: string;
}): { suitePath: string; matrixPath: string; summaryPath: string; rowsPath: string; rawRowsPath: string } {
  const outDir = path.resolve(input.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const suitePath = path.join(outDir, "swe-pro-pilot-suite.json");
  const matrixPath = path.join(outDir, "swe-pro-pilot-matrix.json");
  const summaryPath = path.join(outDir, "swe-pro-pilot-summary.json");
  const rowsPath = path.join(outDir, "swe-pro-pilot-rows.json");
  const rawRowsPath = path.join(outDir, "swe-pro-pilot-raw.jsonl");
  fs.writeFileSync(suitePath, `${JSON.stringify(input.pilot.suite, null, 2)}\n`);
  fs.writeFileSync(matrixPath, `${JSON.stringify(input.pilot.matrix, null, 2)}\n`);
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    generatedAt: input.pilot.generatedAt,
    source: input.pilot.source,
    rows: input.pilot.rows,
    summary: input.pilot.summary,
    outputs: {
      suitePath,
      matrixPath,
      summaryPath,
      rowsPath,
      rawRowsPath
    }
  }, null, 2)}\n`);
  fs.writeFileSync(rowsPath, `${JSON.stringify(input.pilot.matrix.repos.map((repo) => ({
    id: repo.id,
    repoUrl: repo.repoUrl,
    ref: repo.ref,
    language: repo.language,
    expectedFiles: repo.cases.flatMap((benchmarkCase) => benchmarkCase.expectedFiles)
  })), null, 2)}\n`);
  fs.writeFileSync(rawRowsPath, `${input.pilot.rawRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { suitePath, matrixPath, summaryPath, rowsPath, rawRowsPath };
}

function sweBenchRowToCase(row: SweBenchProRow): BenchmarkCase {
  const patchFiles = officialPatchScopeFiles(row, 8);
  const testFiles = diffFiles(row.test_patch).filter(isLikelyTestPath);
  const selectedTests = parseStringList(row.selected_test_files_to_run);
  const setupCommands = sweBenchSetupCommands(row, selectedTests);
  const testCommand = setupCommands.length > 0 ? undefined : inferTestCommand(row, selectedTests);
  const contextBehavior = inferSweBenchContextBehavior(row, patchFiles, selectedTests);
  const officialEvaluation = classifySweBenchProTask({
    problemStatement: row.problem_statement,
    requirements: row.requirements,
    interfaceText: row.interface,
    patchFiles,
    selectedTests,
    contextBehavior,
    hasOfficialSetup: Boolean(row.before_repo_set_cmd?.trim())
  });
  const seed = {
    repoUrl: `https://github.com/${row.repo}.git`,
    ref: row.base_commit,
    cloneDepth: 1,
    ...(setupCommands.length > 0 ? { setupCommands } : row.test_patch ? { setupPatch: row.test_patch } : {}),
    ...(testCommand ? { testCommand } : {})
  };
  return {
    id: normalizeId(row.instance_id),
    mode: "agent",
    task: firstMeaningfulLine(row.problem_statement) ?? row.instance_id,
    contextBehavior,
    agentPrompt: buildAgentPrompt(row, patchFiles, selectedTests),
    expectedFiles: patchFiles,
    minExpectedHits: patchFiles.length > 0 ? 1 : 0,
    requiredTouchedFiles: patchFiles.slice(0, 5),
    allowedDiffScopes: patchFiles.slice(0, 5).map((file) => ({ file, allowWholeFile: true })),
    excludedFiles: commonNoisePrefixes(row.repo_language),
    officialEvaluation,
    budget: 1200,
    seed,
    successCriteria: [
      "Verification passes when a test command is available.",
      "Agent uses the production files changed by the golden patch.",
      "Docs/examples/generated files are avoided.",
      "This is a Kairn pilot scaffold, not an official SWE-Bench Pro leaderboard run."
    ],
    allowedCommands: selectedTests.length > 0 ? selectedTests : testFiles
  };
}

function inferSweBenchContextBehavior(
  row: SweBenchProRow,
  patchFiles: string[],
  selectedTests: string[]
): BenchmarkContextBehavior {
  if (patchFiles.length >= 2) return "multi_file_debug";
  const primary = patchFiles[0];
  if (!primary) return "weak_signal";
  if (selectedTests.length > 0 && failureText(row).length > 0 && mentionsPatchSurface(row, primary)) return "failure_first";
  if (mentionsPatchSurface(row, primary)) return "cheap_single_source";
  return "source_rescue";
}

function sweBenchRowToRepoTarget(row: SweBenchProRow, benchmarkCase: BenchmarkCase): BenchmarkRepoTarget {
  const { seed: _seed, ...caseWithoutSeed } = benchmarkCase;
  const query = distillSweBenchQuery(row);
  return {
    id: normalizeId(row.instance_id),
    name: `${row.repo} ${row.instance_id}`,
    repoUrl: `https://github.com/${row.repo}.git`,
    ref: row.base_commit,
    cloneDepth: 1,
    language: row.repo_language,
    sizeClass: "large",
    cases: [
      {
        ...caseWithoutSeed,
        mode: "context",
        minExpectedHits: benchmarkCase.expectedFiles.length > 0 ? 1 : 0,
        query
      }
    ]
  };
}

function distillSweBenchQuery(row: SweBenchProRow): string {
  const selectedTests = parseStringList(row.selected_test_files_to_run);
  const text = [
    row.problem_statement,
    row.requirements ?? "",
    row.interface ?? "",
    row.fail_to_pass ?? ""
  ].join("\n");
  const identifiers = extractIssueIdentifiers(text);
  const testTerms = selectedTests
    .flatMap((item) => item.split(/[:/.\[\]#|\s-]+/))
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && /[A-Za-z_]/.test(item))
    .slice(0, 16);
  const sourceNameHints = selectedTests.flatMap(sourceNameHintsFromSelectedTest).slice(0, 18);
  return [
    `Debug/fix SWE-Bench Pro issue: ${firstMeaningfulLine(row.problem_statement) ?? row.instance_id}`,
    `Repository language: ${row.repo_language}. Prefer ${row.repo_language} production source unless the issue explicitly names frontend/UI files.`,
    row.requirements ? `Requirements/invariant terms: ${compactSweText(row.requirements, 900)}` : "",
    row.interface ? `Interface notes, not necessarily edit targets: ${compactSweText(stripInterfacePathHints(row.interface), 240)}` : "",
    identifiers.length > 0 ? `Code identifiers and domain terms: ${identifiers.slice(0, 28).join(" ")}` : "",
    sourceNameHints.length > 0 ? `Likely production basename hints from selected tests: ${unique(sourceNameHints).slice(0, 12).join(" ")}` : "",
    testTerms.length > 0 ? `Related failing tests/files: ${unique(testTerms).slice(0, 16).join(" ")}` : "",
    "Find the smallest production source surface before broad scans."
  ].filter(Boolean).join("\n");
}

function sourceNameHintsFromSelectedTest(testRef: string): string[] {
  const fileRef = testRef.split("::")[0]?.split("#")[0]?.split("|")[0] ?? testRef;
  const basename = path.basename(fileRef).replace(/\.[^.]+$/, "");
  const parent = path.basename(path.dirname(fileRef));
  const candidates = [
    basename
      .replace(/^test[_-]/i, "")
      .replace(/[_-]test$/i, "")
      .replace(/[_-]?spec$/i, "")
      .replace(/Test$/i, ""),
    parent
  ];
  const hints: string[] = [];
  for (const candidate of candidates) {
    for (const term of candidate
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^A-Za-z0-9_]+/)) {
      const normalized = term.trim();
      if (normalized.length < 3) continue;
      if (/^(test|tests|unit|integration|spec|specs|utils?|helpers?|database)$/i.test(normalized)) continue;
      hints.push(normalized);
      if (/s$/i.test(normalized) && normalized.length > 4) {
        hints.push(normalized.slice(0, -1));
      }
    }
  }
  return unique(hints);
}

function compactSweText(text: string, maxLength: number): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function stripInterfacePathHints(text: string): string {
  return text
    .replace(/\bPath:\s*[^\n]+/gi, "Path: [interface path omitted]")
    .replace(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|c|cc|cpp|h|hpp)\b/g, "[source path omitted]");
}

function extractIssueIdentifiers(text: string): string[] {
  const identifiers: string[] = [];
  const add = (value: string) => {
    const cleaned = value.replace(/^[:.$]+|[:.$]+$/g, "");
    if (cleaned.length < 3) return;
    if (/^(the|and|for|with|without|should|currently|expected|actual|description|behavior|requirements)$/i.test(cleaned)) return;
    if (!identifiers.includes(cleaned)) identifiers.push(cleaned);
  };
  for (const match of text.matchAll(/`([^`]{3,80})`/g)) {
    for (const part of match[1]!.split(/[^A-Za-z0-9_:.\/-]+/)) add(part);
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g)) {
    const value = match[0];
    if (/[A-Z_]/.test(value) || /(warning|filter|host|block|duration|config|collection|authorization|router|controller|email|confirm|validation|package|parse|cache|proxy|client|agent|request|response|dispatch|module|iterator|state)/i.test(value)) {
      add(value);
    }
  }
  return identifiers;
}

function inferTestCommand(row: SweBenchProRow, selectedTests: string[]): string | undefined {
  const language = row.repo_language.toLowerCase();
  if (language === "python") {
    const files = selectedTests.filter((item) => item.endsWith(".py"));
    if (files.length > 0) return `python3 -m pytest ${files.map(shellQuote).join(" ")}`;
  }
  if (language === "go") {
    const tests = selectedTests
      .filter((item) => /^Test[A-Za-z0-9_\/-]+/.test(item))
      .map((item) => item.split("/")[0])
      .filter((item): item is string => Boolean(item));
    if (tests.length > 0) return `go test ./... -run ${shellQuote(unique(tests).join("|"))}`;
  }
  return undefined;
}

function sweBenchSetupCommands(row: SweBenchProRow, selectedTests: string[]): string[] {
  const beforeCommand = row.before_repo_set_cmd?.trim();
  if (!beforeCommand) return [];
  const setupCommit = referencedSetupCommit(beforeCommand, row.base_commit);
  const testFiles = unique([
    ...selectedTests.filter(looksLikeTestFilePath),
    ...testFilesFromSetupCommand(beforeCommand)
  ]);
  return [
    ...(setupCommit ? [`git fetch origin ${setupCommit} --depth 1`] : []),
    beforeCommand,
    ...(testFiles.length > 0
      ? [`git add ${testFiles.map(shellQuote).join(" ")} && git -c user.email=kairn@example.com -c user.name=Kairn commit -m kairn-seed-tests --no-verify`]
      : [])
  ];
}

function referencedSetupCommit(command: string, baseCommit: string): string | undefined {
  for (const match of command.matchAll(/\bgit\s+checkout\s+([0-9a-f]{32,40})\b/g)) {
    const commit = match[1]!;
    if (commit !== baseCommit) return commit;
  }
  return undefined;
}

function testFilesFromSetupCommand(command: string): string[] {
  const files: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    const checkoutFiles = /\bgit\s+checkout\s+[0-9a-f]{32,40}\s+--\s+(.+)$/.exec(line.trim())?.[1];
    if (!checkoutFiles) continue;
    for (const token of checkoutFiles.match(/"[^"]+"|'[^']+'|\S+/g) ?? []) {
      const file = token.replace(/^['"]|['"]$/g, "");
      if (looksLikeTestFilePath(file)) files.push(file);
    }
  }
  return files;
}

function looksLikeTestFilePath(value: string): boolean {
  return /(^|\/)(test|tests|testing|__tests__|spec|specs)(\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|_test\.go$|Test\.java$/i.test(value);
}

function buildAgentPrompt(row: SweBenchProRow, patchFiles: string[], selectedTests: string[]): string {
  const sections = [
    row.problem_statement.trim(),
    row.requirements ? `Requirements:\n${row.requirements.trim()}` : "",
    row.interface ? `Interface notes, not necessarily edit targets:\n${stripInterfacePathHints(row.interface).trim()}` : "",
    selectedTests.length > 0 ? `Selected tests from SWE-Bench Pro metadata: ${selectedTests.slice(0, 12).join(", ")}` : "",
    "Fix the issue in production source. Do not edit unrelated files. Avoid broad scans once the relevant source surface is known."
  ].filter(Boolean);
  return sections.join("\n\n");
}

function mentionsPatchSurface(row: SweBenchProRow, filePath: string): boolean {
  const haystack = [
    row.problem_statement,
    row.requirements ?? "",
    row.interface ?? "",
    row.fail_to_pass ?? ""
  ].join("\n").toLowerCase();
  const basename = path.basename(filePath).replace(/\.[^.]+$/, "").toLowerCase();
  const parent = path.basename(path.dirname(filePath)).toLowerCase();
  const parts = basename
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9_]+/i)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 4 && !/^(test|spec|util|utils?|helper|helpers?|index|main)$/.test(item));
  if (basename.length >= 4 && haystack.includes(basename)) return true;
  if (parent.length >= 4 && haystack.includes(parent)) return true;
  return parts.some((part) => haystack.includes(part));
}

function failureText(row: SweBenchProRow): string {
  return [
    row.fail_to_pass ?? "",
    row.problem_statement.match(/\b(fail(?:ing|ed)?|traceback|assert|exception|error|regression)\b/i)?.[0] ?? ""
  ].filter(Boolean).join("\n");
}

function normalizeDatasetRow(input: unknown): SweBenchProRow | undefined {
  const row = isRecord(input) && isRecord(input.row) ? input.row : input;
  if (!isRecord(row)) return undefined;
  const required = ["repo", "instance_id", "base_commit", "patch", "test_patch", "problem_statement"];
  if (!required.every((key) => typeof row[key] === "string")) return undefined;
  const repo = row.repo as string;
  const patch = row.patch as string;
  const testPatch = row.test_patch as string;
  return {
    repo,
    instance_id: row.instance_id as string,
    base_commit: row.base_commit as string,
    patch,
    test_patch: testPatch,
    problem_statement: row.problem_statement as string,
    repo_language: typeof row.repo_language === "string" && row.repo_language.trim()
      ? row.repo_language
      : inferRepoLanguage(repo, patch),
    ...(typeof row.requirements === "string" ? { requirements: row.requirements } : {}),
    ...(typeof row.interface === "string" ? { interface: row.interface } : {}),
    ...optionalListString("fail_to_pass", row.fail_to_pass ?? row.FAIL_TO_PASS),
    ...optionalListString("pass_to_pass", row.pass_to_pass ?? row.PASS_TO_PASS),
    ...(typeof row.issue_specificity === "string" ? { issue_specificity: row.issue_specificity } : {}),
    ...(typeof row.issue_categories === "string" ? { issue_categories: row.issue_categories } : {}),
    ...(typeof row.before_repo_set_cmd === "string" ? { before_repo_set_cmd: row.before_repo_set_cmd } : {}),
    ...optionalListString("selected_test_files_to_run", row.selected_test_files_to_run),
    ...(typeof row.dockerhub_tag === "string" ? { dockerhub_tag: row.dockerhub_tag } : {}),
    ...(typeof row.image_name === "string" && typeof row.dockerhub_tag !== "string" ? { dockerhub_tag: row.image_name } : {})
  };
}

function optionalListString<T extends "fail_to_pass" | "pass_to_pass" | "selected_test_files_to_run">(
  key: T,
  value: unknown
): Pick<SweBenchProRow, T> | Record<string, never> {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    return { [key]: trimmed } as Pick<SweBenchProRow, T>;
  }
  if (Array.isArray(value)) {
    return { [key]: JSON.stringify(value.filter((item): item is string => typeof item === "string")) } as Pick<SweBenchProRow, T>;
  }
  return {};
}

function inferRepoLanguage(repo: string, patch: string): string {
  const files = diffFiles(patch);
  const extensionCounts = new Map<string, number>();
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (!extension) continue;
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
  }
  const extension = [...extensionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (extension && [".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "js";
  if (extension && [".ts", ".tsx"].includes(extension)) return "ts";
  if (extension === ".py") return "python";
  if (extension === ".go") return "go";
  if (extension === ".java" || extension === ".kt" || extension === ".kts") return "java";
  if (extension && [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh"].includes(extension)) return "cpp";

  const normalizedRepo = repo.toLowerCase();
  if (normalizedRepo.includes("nodebb") || normalizedRepo.includes("element-web") || normalizedRepo.includes("webclients")) return "js";
  if (normalizedRepo.includes("ansible") || normalizedRepo.includes("openlibrary")) return "python";
  if (normalizedRepo.includes("teleport") || normalizedRepo.includes("flipt") || normalizedRepo.includes("vuls") || normalizedRepo.includes("navidrome")) return "go";
  return "mixed";
}

function productionPatchFiles(patch: string): string[] {
  return diffFiles(patch).filter((file) => isProductionPath(file)).slice(0, 12);
}

function officialPatchScopeFiles(row: SweBenchProRow, limit: number): string[] {
  const productionFiles = productionPatchFiles(row.patch);
  const sourceFiles = productionFiles.filter(isSourceCodePath);
  const candidates = sourceFiles.length > 0 ? sourceFiles : productionFiles;
  return candidates.slice(0, Math.max(1, limit));
}

function primaryPatchFiles(row: SweBenchProRow, limit: number): string[] {
  const sourceFiles = productionPatchFiles(row.patch).filter(isSourceCodePath);
  const candidates = sourceFiles.length > 0 ? sourceFiles : productionPatchFiles(row.patch);
  const terms = new Set(extractIssueIdentifiers([
    row.problem_statement,
    row.requirements ?? "",
    row.interface ?? "",
    row.fail_to_pass ?? ""
  ].join("\n")).map((item) => item.toLowerCase()));
  return candidates
    .map((file, index) => ({ file, score: scorePatchFileForIssue(file, terms, index) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.file)
    .slice(0, Math.max(1, limit));
}

function diffFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match) continue;
    const file = normalizeRelativePath(match[2]!);
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

function isProductionPath(filePath: string): boolean {
  return !isLikelyTestPath(filePath) && !/(^|\/)(docs?|examples?|fixtures?|generated|vendor|third_party|node_modules|dist|build|public\/language)(\/|$)/i.test(filePath);
}

function isSourceCodePath(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|go|java|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/i.test(filePath);
}

function scorePatchFileForIssue(filePath: string, terms: Set<string>, index: number): number {
  const normalized = filePath.toLowerCase();
  const basename = path.basename(normalized);
  let score = 1000 - index;
  if (/(^|\/)(src|lib|app|packages|core|qutebrowser|openlibrary)(\/|$)/.test(normalized)) score += 200;
  if (/(^|\/)(docs?|examples?|test|tests|testing|public|templates|i18n|changelogs)(\/|$)/.test(normalized)) score -= 250;
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.length < 3) continue;
    if (basename.includes(lower)) score += 180;
    else if (normalized.includes(lower)) score += 80;
  }
  return score;
}

function isLikelyTestPath(filePath: string): boolean {
  return /(^|\/)(test|tests|testing|__tests__|spec|specs)(\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|_test\.go$|Test\.java$/i.test(filePath);
}

function commonNoisePrefixes(language: string): string[] {
  const common = ["docs/", "doc/", "examples/", "example/", "fixtures/", "generated/", "node_modules/", "dist/", "build/"];
  if (language.toLowerCase() === "js") return [...common, "public/language/"];
  return common;
}

function parseStringList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    }
  } catch {
    // Fall back to a permissive quoted-string parser below.
  }
  return Array.from(value.matchAll(/['"]([^'"]+)['"]/g)).map((match) => match[1]!).filter(Boolean);
}

function firstMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && !/^(title|description):?$/i.test(line));
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
