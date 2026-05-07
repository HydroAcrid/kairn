import fs from "node:fs";
import path from "node:path";
import type { BenchmarkCase, BenchmarkSuite, FileRecord } from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";

export function loadBenchmarkSuite(input: {
  suitePath?: string | undefined;
  files: FileRecord[];
}): BenchmarkSuite {
  if (input.suitePath && input.suitePath !== "default") {
    return normalizeSuite(JSON.parse(fs.readFileSync(input.suitePath, "utf8")) as unknown);
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

function normalizeSuite(input: unknown): BenchmarkSuite {
  if (!isRecord(input)) throw new Error("Benchmark suite must be a JSON object.");
  const id = stringValue(input.id) ?? "custom";
  const name = stringValue(input.name) ?? id;
  const rawCases = Array.isArray(input.cases) ? input.cases : [];
  const cases = rawCases.map(normalizeCase);
  if (cases.length === 0) throw new Error("Benchmark suite must include at least one case.");
  return { id, name, cases };
}

function normalizeCase(input: unknown): BenchmarkCase {
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
  return {
    id,
    mode: mode as BenchmarkCase["mode"],
    task: stringValue(input.task) ?? stringValue(input.query) ?? id,
    ...(query ? { query } : {}),
    ...(target ? { target: normalizeRelativePath(target) } : {}),
    expectedFiles: normalizeFiles(input.expectedFiles),
    excludedFiles: normalizeFiles(input.excludedFiles),
    ...(budget ? { budget } : {}),
    successCriteria: stringList(input.successCriteria),
    ...(agentPrompt ? { agentPrompt } : {}),
    ...(allowedCommands.length > 0 ? { allowedCommands } : {})
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
