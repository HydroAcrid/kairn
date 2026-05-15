import fs from "node:fs";
import path from "node:path";
import { loadSweBenchProRows, type SweBenchProRow } from "./sweBenchPro.js";

export type SweProOfficialEvalResult = {
  rowId: string;
  passed: boolean;
  patchPath?: string | undefined;
  resultPath?: string | undefined;
  touchedRequiredSource?: boolean | undefined;
  scopePassed?: boolean | undefined;
  tokenMetrics?: {
    baselineTokens?: number | undefined;
    assistedTokens?: number | undefined;
  } | undefined;
};

export type SweProOfficialEvalReport = {
  generatedAt: string;
  source: "ScaleAI/SWE-bench_Pro";
  status: "planned" | "blocked" | "completed";
  rowsSelected: number;
  rowIds: string[];
  officialEvaluatorPassed: boolean;
  results: SweProOfficialEvalResult[];
  warnings: string[];
  commands: string[];
};

export function buildSweProOfficialEvalReport(input: {
  rowsPath?: string | undefined;
  rowIds?: string[] | undefined;
  limit?: number | undefined;
  evaluatorResultsPath?: string | undefined;
  officialRunnerCommand?: string | undefined;
}): SweProOfficialEvalReport {
  const rows = input.rowsPath ? loadSweBenchProRows(input.rowsPath) : [];
  const requested = new Set((input.rowIds ?? []).filter(Boolean));
  const selectedRows = selectRows({ rows, rowIds: requested, limit: input.limit });
  const rowIds = selectedRows.map((row) => row.instance_id);
  const parsedResults = input.evaluatorResultsPath ? loadEvaluatorResults(input.evaluatorResultsPath) : new Map<string, SweProOfficialEvalResult>();
  const results = rowIds.map((rowId) => {
    const parsed = parsedResults.get(rowId);
    if (parsed) return parsed;
    return {
      rowId,
      passed: false,
      ...(input.evaluatorResultsPath ? { resultPath: input.evaluatorResultsPath } : {})
    };
  });
  const officialEvaluatorPassed = results.length > 0 && results.every((result) => result.passed === true);
  const warnings: string[] = [];

  if (!input.rowsPath) {
    warnings.push("No SWE-Pro rows input was provided; official evaluator row ids could not be resolved.");
  }
  if (rowIds.length === 0) {
    warnings.push("No SWE-Pro row ids were selected.");
  }
  if (!input.evaluatorResultsPath) {
    warnings.push("No official evaluator result JSON was provided; SWE-Pro savings must remain invalid.");
  }
  if (input.evaluatorResultsPath && parsedResults.size === 0) {
    warnings.push("Official evaluator result JSON did not contain any recognized task results.");
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "ScaleAI/SWE-bench_Pro",
    status: input.evaluatorResultsPath ? "completed" : rowIds.length > 0 ? "planned" : "blocked",
    rowsSelected: rowIds.length,
    rowIds,
    officialEvaluatorPassed,
    results,
    warnings,
    commands: [
      input.officialRunnerCommand ??
        "Run the SWE-bench_Pro official Docker evaluator for each generated patch, then pass its JSON output with evaluatorResultsPath."
    ]
  };
}

function selectRows(input: {
  rows: SweBenchProRow[];
  rowIds: Set<string>;
  limit?: number | undefined;
}): SweBenchProRow[] {
  const limit = Math.max(1, Math.floor(input.limit ?? (input.rows.length || 1)));
  const selected = input.rows.filter((row) => input.rowIds.size === 0 || input.rowIds.has(row.instance_id));
  return selected.slice(0, limit);
}

function loadEvaluatorResults(inputPath: string): Map<string, SweProOfficialEvalResult> {
  const absolute = path.resolve(inputPath);
  if (!fs.existsSync(absolute)) return new Map();
  const text = fs.readFileSync(absolute, "utf8").trim();
  if (!text) return new Map();
  const parsed = JSON.parse(text) as unknown;
  const records = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.results)
      ? parsed.results
      : isRecord(parsed) && Array.isArray(parsed.instances)
        ? parsed.instances
        : isRecord(parsed) && Array.isArray(parsed.tasks)
          ? parsed.tasks
          : [];
  const output = new Map<string, SweProOfficialEvalResult>();
  for (const record of records) {
    if (!isRecord(record)) continue;
    const rowId = stringField(record, "rowId") ??
      stringField(record, "instance_id") ??
      stringField(record, "instanceId") ??
      stringField(record, "task_id");
    if (!rowId) continue;
    const passed = booleanField(record, "passed") ??
      booleanField(record, "resolved") ??
      booleanField(record, "success") ??
      false;
    output.set(rowId, {
      rowId,
      passed,
      patchPath: stringField(record, "patchPath"),
      resultPath: absolute,
      touchedRequiredSource: booleanField(record, "touchedRequiredSource"),
      scopePassed: booleanField(record, "scopePassed"),
      tokenMetrics: tokenMetrics(record)
    });
  }
  return output;
}

function tokenMetrics(record: Record<string, unknown>): SweProOfficialEvalResult["tokenMetrics"] {
  const baselineTokens = numberField(record, "baselineTokens");
  const assistedTokens = numberField(record, "assistedTokens") ?? numberField(record, "kairnTokens");
  return baselineTokens !== undefined || assistedTokens !== undefined ? { baselineTokens, assistedTokens } : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
