// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { BenchmarkCase, BenchmarkContextBehavior, BenchmarkRepoMatrix, BenchmarkRepoTarget, BenchmarkSuite } from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";
import { classifySweAtlasQnaTask } from "./officialClassification.js";

const DATASET_ROWS_URL = "https://datasets-server.huggingface.co/rows?dataset=ScaleAI%2FSWE-Atlas-QnA&config=default&split=test";

export type SweAtlasQnaRow = {
  task_id: string;
  prompt: string;
  reference_answer: string;
  repository_url: string;
  repository_base_commit: string;
  language: string;
  category: string;
  rubric: string;
  docker_image?: string | null;
};

export type SweAtlasQnaPilot = {
  generatedAt: string;
  source: string;
  rows: number;
  rawRows: SweAtlasQnaRow[];
  suite: BenchmarkSuite;
  matrix: BenchmarkRepoMatrix;
  summary: {
    languages: Record<string, number>;
    repos: Record<string, number>;
    categories: Record<string, number>;
    taskClasses: Record<string, number>;
    evaluators: Record<string, number>;
    applicability: Record<string, number>;
    skippedRows: number;
    warnings: string[];
  };
};

export async function fetchSweAtlasQnaRows(input: {
  offset?: number | undefined;
  length?: number | undefined;
}): Promise<SweAtlasQnaRow[]> {
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const length = Math.max(1, Math.min(100, Math.floor(input.length ?? 30)));
  const response = await fetch(`${DATASET_ROWS_URL}&offset=${offset}&length=${length}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch SWE-Atlas/QnA rows: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.rows)) {
    throw new Error("Unexpected SWE-Atlas/QnA rows response.");
  }
  return payload.rows.map((entry) => normalizeDatasetRow(entry)).filter((row): row is SweAtlasQnaRow => Boolean(row));
}

export function loadSweAtlasQnaRows(inputPath: string): SweAtlasQnaRow[] {
  const absolute = path.resolve(inputPath);
  const text = fs.readFileSync(absolute, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = trimmed.startsWith("[") || (trimmed.startsWith("{") && !trimmed.includes("\n"))
    ? JSON.parse(trimmed) as unknown
    : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const candidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.rows)
      ? parsed.rows
      : isRecord(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : [];
  return candidates.map((entry) => normalizeDatasetRow(entry)).filter((row): row is SweAtlasQnaRow => Boolean(row));
}

export function buildSweAtlasQnaPilot(input: {
  rows: SweAtlasQnaRow[];
  limit?: number | undefined;
  languages?: string[] | undefined;
  repos?: string[] | undefined;
  categories?: string[] | undefined;
}): SweAtlasQnaPilot {
  const languages = normalizedFilter(input.languages);
  const repos = normalizedFilter(input.repos);
  const categories = normalizedFilter(input.categories);
  const limit = Math.max(1, Math.floor(input.limit ?? input.rows.length));
  const selected: SweAtlasQnaRow[] = [];
  let skippedRows = 0;

  for (const row of input.rows) {
    const repo = repoSlug(row.repository_url).toLowerCase();
    if (languages.size > 0 && !languages.has(row.language.toLowerCase())) {
      skippedRows += 1;
      continue;
    }
    if (repos.size > 0 && !repos.has(repo)) {
      skippedRows += 1;
      continue;
    }
    if (categories.size > 0 && !categories.has(row.category.toLowerCase())) {
      skippedRows += 1;
      continue;
    }
    selected.push(row);
    if (selected.length >= limit) break;
  }

  const cases = selected.map((row) => qnaRowToCase(row));
  const targets = qnaRowsToRepoTargets(selected, cases);
  const languageSummary: Record<string, number> = {};
  const repoSummary: Record<string, number> = {};
  const categorySummary: Record<string, number> = {};
  const taskClassSummary: Record<string, number> = {};
  const evaluatorSummary: Record<string, number> = {};
  const applicabilitySummary: Record<string, number> = {};
  for (const row of selected) {
    languageSummary[row.language] = (languageSummary[row.language] ?? 0) + 1;
    repoSummary[repoSlug(row.repository_url)] = (repoSummary[repoSlug(row.repository_url)] ?? 0) + 1;
    categorySummary[row.category] = (categorySummary[row.category] ?? 0) + 1;
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
    warnings.push("No SWE-Atlas/QnA rows matched the requested filters.");
  }
  if (cases.some((item) => item.expectedFiles.length === 0)) {
    warnings.push("Some selected QnA rows have no source paths in the reference answer; they are omitted from repo-matrix preflight and retained only in the live suite.");
  }
  warnings.push("Reference answers are used only for offline expected-file scoring. They are never included in generated agent prompts.");
  warnings.push("SWE-Atlas/QnA checks retrieval and answer-grounding quality, not patch correctness.");

  return {
    generatedAt: new Date().toISOString(),
    source: "ScaleAI/SWE-Atlas-QnA",
    rows: selected.length,
    rawRows: selected,
    suite: {
      id: "swe-atlas-qna-pilot-live",
      name: "SWE-Atlas QnA Pilot Live Suite",
      cases
    },
    matrix: {
      id: "swe-atlas-qna-pilot-matrix",
      name: "SWE-Atlas QnA Pilot Repo Matrix",
      gates: {
        maxStateMb: 250,
        maxPrimeLatencyMs: 5000,
        maxRepoPreflightMs: 120000,
        expectedTopK: 5
      },
      repos: targets
    },
    summary: {
      languages: languageSummary,
      repos: repoSummary,
      categories: categorySummary,
      taskClasses: taskClassSummary,
      evaluators: evaluatorSummary,
      applicability: applicabilitySummary,
      skippedRows,
      warnings
    }
  };
}

export function writeSweAtlasQnaPilot(input: {
  pilot: SweAtlasQnaPilot;
  outDir: string;
}): { suitePath: string; matrixPath: string; summaryPath: string; rowsPath: string; rawRowsPath: string } {
  const outDir = path.resolve(input.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const suitePath = path.join(outDir, "swe-atlas-qna-pilot-suite.json");
  const matrixPath = path.join(outDir, "swe-atlas-qna-pilot-matrix.json");
  const summaryPath = path.join(outDir, "swe-atlas-qna-pilot-summary.json");
  const rowsPath = path.join(outDir, "swe-atlas-qna-pilot-rows.json");
  const rawRowsPath = path.join(outDir, "swe-atlas-qna-pilot-raw.jsonl");
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

function qnaRowToCase(row: SweAtlasQnaRow): BenchmarkCase {
  const expectedFiles = rankExpectedSourceFiles(expectedSourceFiles(row), row.prompt).slice(0, 6);
  const contextBehavior = inferQnaContextBehavior(row, expectedFiles);
  const officialEvaluation = classifySweAtlasQnaTask({
    prompt: row.prompt,
    category: row.category,
    expectedFiles,
    contextBehavior
  });
  return {
    id: normalizeId(row.task_id),
    mode: "agent",
    task: firstMeaningfulLine(row.prompt) ?? row.task_id,
    contextBehavior,
    agentPrompt: buildAgentPrompt(row),
    expectedFiles,
    minExpectedHits: expectedFiles.length > 0 ? 1 : 0,
    qnaEvaluation: {
      minSourceMentions: expectedFiles.length > 0 ? 1 : 0,
      requireNoRepoChanges: true
    },
    requiredTouchedFiles: [],
    excludedFiles: commonNoisePrefixes(row.language),
    officialEvaluation,
    budget: 1400,
    seed: {
      repoUrl: repoCloneUrl(row.repository_url),
      ref: row.repository_base_commit,
      cloneDepth: 1
    },
    successCriteria: [
      "Answer the repository question without modifying source files.",
      "Use the source files implied by the reference answer when applicable.",
      "Avoid docs/examples/generated files unless the prompt explicitly asks about docs.",
      "This is a QnA retrieval/grounding pilot, not a patch-verification benchmark."
    ]
  };
}

function qnaRowsToRepoTargets(rows: SweAtlasQnaRow[], cases: BenchmarkCase[]): BenchmarkRepoTarget[] {
  const targets = new Map<string, BenchmarkRepoTarget>();
  rows.forEach((row, index) => {
    const benchmarkCase = cases[index];
    if (!benchmarkCase) return;
    const matrixExpectedFiles = qnaMatrixExpectedFiles(benchmarkCase);
    if (matrixExpectedFiles.length === 0) return;
    const repoUrl = repoCloneUrl(row.repository_url);
    const key = `${repoUrl}#${row.repository_base_commit}`;
    const target = targets.get(key) ?? {
      id: normalizeId(`${repoSlug(row.repository_url)}-${row.repository_base_commit.slice(0, 12)}`),
      name: `${repoSlug(row.repository_url)} ${row.repository_base_commit.slice(0, 12)}`,
      repoUrl,
      ref: row.repository_base_commit,
      cloneDepth: 1,
      language: row.language,
      sizeClass: "large",
      cases: []
    };
    const { seed: _seed, agentPrompt: _agentPrompt, ...caseWithoutSeed } = benchmarkCase;
    target.cases.push({
      ...caseWithoutSeed,
      expectedFiles: matrixExpectedFiles,
      minExpectedHits: matrixExpectedFiles.length > 0 ? 1 : 0,
      mode: "context",
      query: distillQnaQuery(row)
    });
    targets.set(key, target);
  });
  return [...targets.values()];
}

function qnaMatrixExpectedFiles(benchmarkCase: BenchmarkCase): string[] {
  const limit = benchmarkCase.contextBehavior === "multi_file_debug" || benchmarkCase.contextBehavior === "failure_first" ? 2 : 1;
  return benchmarkCase.expectedFiles.slice(0, limit);
}

function buildAgentPrompt(row: SweAtlasQnaRow): string {
  return [
    row.prompt.trim(),
    "",
    "Answer using the checked-out repository as ground truth. Do not modify repository files. If temporary scripts are needed, remove them before finishing."
  ].join("\n");
}

function distillQnaQuery(row: SweAtlasQnaRow): string {
  const identifiers = extractPromptIdentifiers(row.prompt);
  return [
    `Answer SWE-Atlas/QnA repository question: ${firstMeaningfulLine(row.prompt) ?? row.task_id}`,
    `Dataset language label: ${row.language}. Prefer production source over tests/docs/examples unless the prompt explicitly asks for them.`,
    `Question category: ${row.category}.`,
    `Question excerpt: ${compactText(row.prompt, 900)}`,
    identifiers.length > 0 ? `Code identifiers and domain terms: ${identifiers.slice(0, 36).join(" ")}` : "",
    "Find the smallest source surfaces needed to answer. Do not use the reference answer or golden files in the prompt."
  ].filter(Boolean).join("\n");
}

function inferQnaContextBehavior(row: SweAtlasQnaRow, expectedFiles: string[]): BenchmarkContextBehavior {
  const prompt = row.prompt.toLowerCase();
  if (/\b(traceback|failing|failed|error|exception|regression|test failure)\b/.test(prompt)) return "failure_first";
  if (expectedFiles.length >= 2 || /\b(end-to-end|connect|flow|trace through|how .* pieces connect|where .* routed)\b/i.test(row.prompt)) {
    return "multi_file_debug";
  }
  if (expectedFiles[0] && promptMentionsFileSurface(row.prompt, expectedFiles[0])) return "cheap_single_source";
  if (/\b(vague|not sure|where|find|locate|lost|confusing|understand)\b/.test(prompt)) return "source_rescue";
  return "source_rescue";
}

function expectedSourceFiles(row: SweAtlasQnaRow): string[] {
  const files: string[] = [];
  const pathPattern = /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|py|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)\b/g;
  for (const match of row.reference_answer.matchAll(pathPattern)) {
    const file = canonicalQnaReferencePath(normalizeRelativePath(match[0]), row);
    if (!file || !isProductionPath(file) || files.includes(file)) continue;
    files.push(file);
  }
  return files;
}

function canonicalQnaReferencePath(filePath: string, row: SweAtlasQnaRow): string {
  const normalized = filePath.replace(/^\/+/, "").replaceAll("\\", "/");
  const repoName = repoSlug(row.repository_url).split("/").at(-1)?.toLowerCase();
  if (!repoName) return normalized;
  if (["app", "repo", "source", "project"].includes(repoName)) return normalized;
  for (const prefix of ["app", "repo", "workspace", "workdir", "srcdir", "project"]) {
    const containerRepoPrefix = `${prefix}/${repoName}/`;
    const doubledRepoPrefix = `${containerRepoPrefix}${repoName}/`;
    const lower = normalized.toLowerCase();
    if (lower.startsWith(doubledRepoPrefix)) {
      return normalized.slice(containerRepoPrefix.length);
    }
    if (lower.startsWith(containerRepoPrefix)) {
      return normalized.slice(`${prefix}/`.length);
    }
  }
  return normalized;
}

function rankExpectedSourceFiles(files: string[], prompt: string): string[] {
  const promptTerms = new Set(extractPromptIdentifiers(prompt).map((term) => term.toLowerCase()));
  for (const term of tokenizeLoose(prompt)) promptTerms.add(term);
  return files
    .map((file, index) => ({ file, score: scoreExpectedFileForPrompt(file, promptTerms, index) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.file);
}

function scoreExpectedFileForPrompt(filePath: string, promptTerms: Set<string>, index: number): number {
  const normalized = filePath.toLowerCase();
  const basename = path.basename(normalized).replace(/\.[^.]+$/, "");
  const fileTerms = tokenizeLoose(filePath);
  let score = 1000 - index;
  for (const term of fileTerms) {
    if (term.length < 2) continue;
    if (promptTerms.has(term)) score += basename.includes(term) ? 260 : 120;
    if (term.endsWith("s") && promptTerms.has(term.slice(0, -1))) score += 80;
  }
  if (basename === "main" && (promptTerms.has("start") || promptTerms.has("startup") || promptTerms.has("launch"))) score += 180;
  if (basename === "boss" && (promptTerms.has("route") || promptTerms.has("routed") || promptTerms.has("focus"))) score += 180;
  return score;
}

function promptMentionsFileSurface(prompt: string, filePath: string): boolean {
  const lower = prompt.toLowerCase();
  const basename = path.basename(filePath).replace(/\.[^.]+$/, "").toLowerCase();
  const parent = path.basename(path.dirname(filePath)).toLowerCase();
  if (basename.length >= 4 && lower.includes(basename)) return true;
  return parent.length >= 4 && lower.includes(parent);
}

function extractPromptIdentifiers(text: string): string[] {
  const identifiers: string[] = [];
  const add = (value: string) => {
    const cleaned = value.replace(/^[:.$]+|[:.$]+$/g, "");
    if (cleaned.length < 3) return;
    if (/^(the|and|for|with|without|should|currently|expected|actual|question|answer|code|file|files|repository)$/i.test(cleaned)) return;
    if (!identifiers.includes(cleaned)) identifiers.push(cleaned);
  };
  for (const match of text.matchAll(/`([^`]{3,120})`/g)) {
    for (const part of match[1]!.split(/[^A-Za-z0-9_:.\/@-]+/)) add(part);
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g)) {
    const value = match[0];
    if (/[A-Z_@]/.test(value) || /(socket|remote|control|protocol|router|handler|dispatch|command|window|request|response|config|shell|integration|logging|parse|encode|decode|client|server|adapter|context|manager|registry|resolver)/i.test(value)) {
      add(value);
    }
  }
  return identifiers;
}

function tokenizeLoose(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2 && !/^(src|lib|app|cmd|pkg|test|tests|index|main)$/.test(term));
}

function normalizeDatasetRow(input: unknown): SweAtlasQnaRow | undefined {
  const row = isRecord(input) && isRecord(input.row) ? input.row : input;
  if (!isRecord(row)) return undefined;
  const required = [
    "task_id",
    "prompt",
    "reference_answer",
    "repository_url",
    "repository_base_commit",
    "language",
    "category",
    "rubric"
  ];
  if (!required.every((key) => typeof row[key] === "string")) return undefined;
  return {
    task_id: row.task_id as string,
    prompt: row.prompt as string,
    reference_answer: row.reference_answer as string,
    repository_url: row.repository_url as string,
    repository_base_commit: row.repository_base_commit as string,
    language: row.language as string,
    category: row.category as string,
    rubric: row.rubric as string,
    ...(typeof row.docker_image === "string" ? { docker_image: row.docker_image } : {})
  };
}

function repoSlug(repositoryUrl: string): string {
  try {
    const parsed = new URL(repositoryUrl);
    return parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "") || repositoryUrl;
  } catch {
    return repositoryUrl.replace(/^git@github\.com:/, "").replace(/\.git$/i, "");
  }
}

function repoCloneUrl(repositoryUrl: string): string {
  if (/^(?:https?:\/\/|git@)/i.test(repositoryUrl)) return repositoryUrl;
  return `https://github.com/${repoSlug(repositoryUrl)}.git`;
}

function isProductionPath(filePath: string): boolean {
  return isSourceCodePath(filePath) && !/(^|\/)(docs?|examples?|fixtures?|generated|gen|vendor|third_party|node_modules|dist|build|tests?|testing|__tests__|specs?|[^/]*tests?[^/]*)(\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|_test\.go$|Test\.java$/i.test(filePath);
}

function isSourceCodePath(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/i.test(filePath);
}

function commonNoisePrefixes(language: string): string[] {
  const common = ["docs/", "doc/", "examples/", "example/", "fixtures/", "generated/", "gen/", "node_modules/", "dist/", "build/", "tests/", "test/"];
  if (language.toLowerCase() === "typescript" || language.toLowerCase() === "javascript") return [...common, "public/language/"];
  return common;
}

function firstMeaningfulLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && !/^(title|description|question):?$/i.test(line));
}

function compactText(text: string, maxLength: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function normalizedFilter(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((item) => item.toLowerCase()).filter(Boolean));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
