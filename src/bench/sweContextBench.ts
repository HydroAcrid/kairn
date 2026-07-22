// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { BenchmarkCase, BenchmarkRepoMatrix, BenchmarkRepoTarget, BenchmarkSuite } from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";

export type SweContextBenchRow = {
  task_id: string;
  prompt: string;
  repository_url: string;
  repository_base_commit?: string | undefined;
  language?: string | undefined;
  group_id?: string | undefined;
  base_task_id?: string | undefined;
  expected_files: string[];
  task_type?: string | undefined;
};

export type SweContextBenchPair = {
  groupId: string;
  baseTaskId?: string | undefined;
  relatedTaskIds: string[];
};

export type SweContextBenchPilot = {
  generatedAt: string;
  source: string;
  rows: number;
  rawRows: SweContextBenchRow[];
  pairs: SweContextBenchPair[];
  suite: BenchmarkSuite;
  matrix: BenchmarkRepoMatrix;
  summary: {
    repos: Record<string, number>;
    languages: Record<string, number>;
    taskTypes: Record<string, number>;
    pairs: number;
    relatedRows: number;
    skippedRows: number;
    warnings: string[];
  };
};

export function loadSweContextBenchRows(inputPath: string): SweContextBenchRow[] {
  const absolute = path.resolve(inputPath);
  const text = fs.readFileSync(absolute, "utf8").trim();
  if (!text) return [];
  const parsed = text.startsWith("[") || (text.startsWith("{") && !text.includes("\n"))
    ? JSON.parse(text) as unknown
    : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const candidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.rows)
      ? parsed.rows
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : [];
  return candidates.map(normalizeRow).filter((row): row is SweContextBenchRow => Boolean(row));
}

export function buildSweContextBenchPilot(input: {
  rows: SweContextBenchRow[];
  limit?: number | undefined;
  languages?: string[] | undefined;
  repos?: string[] | undefined;
}): SweContextBenchPilot {
  const languageFilter = normalizedFilter(input.languages);
  const repoFilter = normalizedFilter(input.repos);
  const limit = Math.max(1, Math.floor(input.limit ?? (input.rows.length || 1)));
  const selected: SweContextBenchRow[] = [];
  let skippedRows = 0;

  for (const row of input.rows) {
    const repo = repoSlug(row.repository_url);
    if (languageFilter.size > 0 && !languageFilter.has((row.language ?? "unknown").toLowerCase())) {
      skippedRows += 1;
      continue;
    }
    if (repoFilter.size > 0 && !repoFilter.has(repo.toLowerCase())) {
      skippedRows += 1;
      continue;
    }
    selected.push(row);
    if (selected.length >= limit) break;
  }

  const cases = selected.map(rowToCase);
  const targets = rowsToRepoTargets(selected, cases);
  const pairs = buildPairs(selected);
  const repos: Record<string, number> = {};
  const languages: Record<string, number> = {};
  const taskTypes: Record<string, number> = {};
  for (const row of selected) {
    repos[repoSlug(row.repository_url)] = (repos[repoSlug(row.repository_url)] ?? 0) + 1;
    languages[row.language ?? "unknown"] = (languages[row.language ?? "unknown"] ?? 0) + 1;
    taskTypes[row.task_type ?? "unknown"] = (taskTypes[row.task_type ?? "unknown"] ?? 0) + 1;
  }
  const warnings: string[] = [];
  if (selected.length === 0) warnings.push("No SWE-ContextBench rows matched the requested filters.");
  if (selected.some((row) => row.expected_files.length === 0)) {
    warnings.push("Some SWE-ContextBench rows have no expected source files; deterministic source-reuse scoring will be weak.");
  }
  if (pairs.length === 0) {
    warnings.push("No related-task pairs were detected; this pilot can only validate single-task source grounding.");
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "SWE-ContextBench metadata",
    rows: selected.length,
    rawRows: selected,
    pairs,
    suite: {
      id: "swe-contextbench-pilot-live",
      name: "SWE-ContextBench Pilot Live Suite",
      cases
    },
    matrix: {
      id: "swe-contextbench-pilot-matrix",
      name: "SWE-ContextBench Pilot Repo Matrix",
      gates: {
        maxStateMb: 300,
        maxPrimeLatencyMs: 8000,
        expectedTopK: 5,
        requireSuppressionForWeakCases: true
      },
      repos: targets
    },
    summary: {
      repos,
      languages,
      taskTypes,
      pairs: pairs.length,
      relatedRows: pairs.reduce((total, pair) => total + pair.relatedTaskIds.length, 0),
      skippedRows,
      warnings
    }
  };
}

export function writeSweContextBenchPilot(input: {
  pilot: SweContextBenchPilot;
  outDir: string;
}): { suitePath: string; matrixPath: string; summaryPath: string; rowsPath: string; rawRowsPath: string } {
  const outDir = path.resolve(input.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const suitePath = path.join(outDir, "swe-contextbench-pilot-suite.json");
  const matrixPath = path.join(outDir, "swe-contextbench-pilot-matrix.json");
  const summaryPath = path.join(outDir, "swe-contextbench-pilot-summary.json");
  const rowsPath = path.join(outDir, "swe-contextbench-pilot-rows.json");
  const rawRowsPath = path.join(outDir, "swe-contextbench-pilot-raw.jsonl");
  fs.writeFileSync(suitePath, `${JSON.stringify(input.pilot.suite, null, 2)}\n`);
  fs.writeFileSync(matrixPath, `${JSON.stringify(input.pilot.matrix, null, 2)}\n`);
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    generatedAt: input.pilot.generatedAt,
    source: input.pilot.source,
    rows: input.pilot.rows,
    summary: input.pilot.summary,
    outputs: { suitePath, matrixPath, summaryPath, rowsPath, rawRowsPath }
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

function normalizeRow(entry: unknown): SweContextBenchRow | undefined {
  const row = isRecord(entry) && isRecord(entry.row) ? entry.row : entry;
  if (!isRecord(row)) return undefined;
  const taskId = stringValue(row.task_id) ?? stringValue(row.id) ?? stringValue(row.instance_id);
  const prompt = stringValue(row.prompt) ?? stringValue(row.task) ?? stringValue(row.question) ?? stringValue(row.problem_statement);
  const repositoryUrl = stringValue(row.repository_url) ?? stringValue(row.repo_url) ?? stringValue(row.repo);
  if (!taskId || !prompt || !repositoryUrl) return undefined;
  return {
    task_id: taskId,
    prompt,
    repository_url: normalizeRepoUrl(repositoryUrl),
    repository_base_commit: stringValue(row.repository_base_commit) ?? stringValue(row.base_commit) ?? stringValue(row.commit),
    language: stringValue(row.language) ?? stringValue(row.repo_language),
    group_id: stringValue(row.group_id) ?? stringValue(row.related_group_id) ?? stringValue(row.case_group),
    base_task_id: stringValue(row.base_task_id) ?? stringValue(row.parent_task_id) ?? stringValue(row.source_task_id),
    expected_files: expectedFiles(row),
    task_type: stringValue(row.task_type) ?? stringValue(row.category)
  };
}

function rowToCase(row: SweContextBenchRow): BenchmarkCase {
  const expectedFiles = row.expected_files.slice(0, 6);
  return {
    id: normalizeId(row.task_id),
    mode: "agent",
    task: row.prompt,
    agentPrompt: row.prompt,
    contextBehavior: expectedFiles.length > 1 ? "multi_file_debug" : expectedFiles.length === 1 ? "source_rescue" : "weak_signal",
    expectedFiles,
    minExpectedHits: expectedFiles.length > 0 ? 1 : 0,
    excludedFiles: ["docs/", "examples/", "test/", "tests/", "__tests__/", "vendor/", "node_modules/"],
    budget: 1000,
    successCriteria: [
      "Kairn retrieves relevant source files from the current or related task.",
      "Unrelated prior context is suppressed.",
      "This pilot measures source grounding and context reuse, not leaderboard patch correctness."
    ]
  };
}

function rowsToRepoTargets(rows: SweContextBenchRow[], cases: BenchmarkCase[]): BenchmarkRepoTarget[] {
  const grouped = new Map<string, { rows: SweContextBenchRow[]; cases: BenchmarkCase[] }>();
  rows.forEach((row, index) => {
    const slug = repoSlug(row.repository_url);
    const existing = grouped.get(slug) ?? { rows: [], cases: [] };
    existing.rows.push(row);
    existing.cases.push(cases[index]!);
    grouped.set(slug, existing);
  });
  return [...grouped.entries()].map(([slug, group]) => {
    const first = group.rows[0]!;
    return {
      id: normalizeId(slug),
      name: slug,
      repoUrl: first.repository_url,
      ...(first.repository_base_commit ? { ref: first.repository_base_commit } : {}),
      cloneDepth: 1,
      ...(first.language ? { language: first.language } : {}),
      sizeClass: "medium",
      cases: group.cases
    };
  });
}

function buildPairs(rows: SweContextBenchRow[]): SweContextBenchPair[] {
  const grouped = new Map<string, SweContextBenchRow[]>();
  for (const row of rows) {
    const groupId = row.group_id ?? row.base_task_id;
    if (!groupId) continue;
    const existing = grouped.get(groupId) ?? [];
    existing.push(row);
    grouped.set(groupId, existing);
  }
  return [...grouped.entries()]
    .map(([groupId, group]) => {
      const base = group.find((row) => !row.base_task_id || row.task_id === row.base_task_id);
      return {
        groupId,
        baseTaskId: base?.task_id ?? group[0]?.base_task_id,
        relatedTaskIds: group.map((row) => row.task_id).filter((id) => id !== (base?.task_id ?? group[0]?.base_task_id))
      };
    })
    .filter((pair) => pair.relatedTaskIds.length > 0);
}

function expectedFiles(row: Record<string, unknown>): string[] {
  const candidates = [
    row.expected_files,
    row.expectedFiles,
    row.reference_files,
    row.referenceFiles,
    row.files,
    row.source_files
  ];
  const files = candidates.flatMap((value) => Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : []);
  return [...new Set(files
    .map((item) => typeof item === "string" ? normalizeRelativePath(item.trim()) : "")
    .filter((item) => item && !looksLikeNoisePath(item)))];
}

function looksLikeNoisePath(filePath: string): boolean {
  return /(^|\/)(docs?|examples?|tests?|__tests__|vendor|node_modules)\//i.test(filePath);
}

function normalizedFilter(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function normalizeRepoUrl(value: string): string {
  if (/^https?:\/\//.test(value) || value.startsWith("git@")) return value;
  return `https://github.com/${value.replace(/\.git$/, "")}.git`;
}

function repoSlug(repositoryUrl: string): string {
  return repositoryUrl
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
