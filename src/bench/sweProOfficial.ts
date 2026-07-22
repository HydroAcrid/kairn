// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

export type SweProOfficialPatchMode = "gold" | "empty";

export type SweProOfficialPrepReport = {
  generatedAt: string;
  source: "ScaleAI/SWE-bench_Pro";
  status: "ready" | "blocked" | "completed" | "failed";
  rowsSelected: number;
  rowIds: string[];
  officialRepoPath: string;
  outputDir: string;
  rawSamplePath: string;
  patchPath: string;
  evaluatorOutputDir: string;
  patchMode: SweProOfficialPatchMode | "provided";
  missingAssets: Array<{ rowId: string; missing: string[] }>;
  warnings: string[];
  commands: string[];
  evaluator?: {
    ran: boolean;
    exitCode?: number | undefined;
    stdoutPath?: string | undefined;
    stderrPath?: string | undefined;
    evalResultsPath?: string | undefined;
    results?: SweProOfficialEvalResult[] | undefined;
  } | undefined;
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

export function prepareSweProOfficialEvaluator(input: {
  rowsPath: string;
  rowIds?: string[] | undefined;
  limit?: number | undefined;
  outputDir: string;
  officialRepoPath?: string | undefined;
  patchPath?: string | undefined;
  patchMode?: SweProOfficialPatchMode | undefined;
  pythonCommand?: string | undefined;
  dockerhubUsername?: string | undefined;
  numWorkers?: number | undefined;
  useLocalDocker?: boolean | undefined;
  dockerPlatform?: string | undefined;
  run?: boolean | undefined;
  redo?: boolean | undefined;
}): SweProOfficialPrepReport {
  const rows = loadSweBenchProRows(input.rowsPath);
  const requested = new Set((input.rowIds ?? []).filter(Boolean));
  const selectedRows = selectRows({ rows, rowIds: requested, limit: input.limit });
  const rowIds = selectedRows.map((row) => row.instance_id);
  const outputDir = path.resolve(input.outputDir);
  const officialRepoPath = path.resolve(input.officialRepoPath ?? path.join(".kairn", "eval", "SWE-bench_Pro-os"));
  const evaluatorOutputDir = path.join(outputDir, "eval-output");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(evaluatorOutputDir, { recursive: true });

  const rawSamplePath = path.join(outputDir, "swe-pro-raw-sample.jsonl");
  fs.writeFileSync(rawSamplePath, `${selectedRows.map((row) => JSON.stringify(row)).join("\n")}${selectedRows.length > 0 ? "\n" : ""}`);

  const patchMode = input.patchPath ? "provided" : input.patchMode ?? "empty";
  const patchPath = input.patchPath ? path.resolve(input.patchPath) : path.join(outputDir, `${patchMode}-patches.json`);
  if (!input.patchPath) {
    fs.writeFileSync(patchPath, `${JSON.stringify(selectedRows.map((row) => ({
      instance_id: row.instance_id,
      patch: patchMode === "gold" ? row.patch : "",
      prefix: patchMode
    })), null, 2)}\n`);
  }

  const missingAssets = selectedRows
    .map((row) => ({ rowId: row.instance_id, missing: missingOfficialAssets(officialRepoPath, row.instance_id) }))
    .filter((item) => item.missing.length > 0);
  const warnings: string[] = [];
  if (selectedRows.length === 0) warnings.push("No SWE-Pro rows were selected.");
  if (!fs.existsSync(path.join(officialRepoPath, "swe_bench_pro_eval.py"))) {
    warnings.push("Official SWE-bench_Pro evaluator script was not found.");
  }
  if (missingAssets.length > 0) {
    warnings.push("Some selected rows are missing official run scripts, parser scripts, or Dockerfiles.");
  }
  if (patchMode === "gold") {
    warnings.push("Gold patches are for evaluator setup smoke only; do not use them for model/Kairn savings claims.");
  }
  if (patchMode === "empty") {
    warnings.push("Empty patches are a setup/control artifact and are expected to fail official evaluation.");
  }

  const commandArgs = officialEvaluatorArgs({
    officialRepoPath,
    rawSamplePath,
    patchPath,
    evaluatorOutputDir,
    dockerhubUsername: input.dockerhubUsername ?? "jefzda",
    numWorkers: input.numWorkers ?? 1,
    useLocalDocker: input.useLocalDocker ?? true,
    dockerPlatform: input.dockerPlatform,
    redo: input.redo
  });
  const pythonCommand = resolveCommand(input.pythonCommand ?? "python3");
  const command = `${shellQuote(pythonCommand)} ${commandArgs.map(shellQuote).join(" ")}`;
  const commands = [
    command,
    "When evaluating generated agent patches, replace --patch_path with the baseline/Kairn patch JSON and keep gold patches out of prompts."
  ];

  if (!input.run || warnings.some((warning) => warning.includes("not found") || warning.includes("missing official"))) {
    return {
      generatedAt: new Date().toISOString(),
      source: "ScaleAI/SWE-bench_Pro",
      status: warnings.length > 0 && (selectedRows.length === 0 || missingAssets.length > 0 || !fs.existsSync(path.join(officialRepoPath, "swe_bench_pro_eval.py"))) ? "blocked" : "ready",
      rowsSelected: selectedRows.length,
      rowIds,
      officialRepoPath,
      outputDir,
      rawSamplePath,
      patchPath,
      evaluatorOutputDir,
      patchMode,
      missingAssets,
      warnings,
      commands
    };
  }

  const stdoutPath = path.join(outputDir, "evaluator.stdout.log");
  const stderrPath = path.join(outputDir, "evaluator.stderr.log");
  const result = spawnSync(pythonCommand, commandArgs, {
    cwd: officialRepoPath,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  const stdout = result.stdout ?? "";
  const stderr = [result.stderr ?? "", result.error ? `\nspawn error: ${result.error.message}\n` : ""].join("");
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  const evalResultsPath = path.join(evaluatorOutputDir, "eval_results.json");
  const parsed = loadFlatEvalResults(evalResultsPath);
  const infrastructureFailed = /DockerException|Error in eval_with|returned None|Failed to pull|output\.json not found|generated an exception|spawn error/i.test(`${stdout}\n${stderr}`);
  const runWarnings = [
    ...warnings,
    ...(infrastructureFailed ? ["Official evaluator run failed before producing valid test results; inspect evaluator stdout/stderr."] : [])
  ];
  const results = selectedRows.map((row) => ({
    rowId: row.instance_id,
    passed: parsed.get(row.instance_id) === true,
    resultPath: evalResultsPath
  }));
  return {
    generatedAt: new Date().toISOString(),
    source: "ScaleAI/SWE-bench_Pro",
    status: !result.error && result.status === 0 && parsed.size > 0 && !infrastructureFailed ? "completed" : "failed",
    rowsSelected: selectedRows.length,
    rowIds,
    officialRepoPath,
    outputDir,
    rawSamplePath,
    patchPath,
    evaluatorOutputDir,
    patchMode,
    missingAssets,
    warnings: runWarnings,
    commands,
    evaluator: {
      ran: true,
      exitCode: result.status ?? (result.error ? -1 : undefined),
      stdoutPath,
      stderrPath,
      evalResultsPath,
      results
    }
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

function loadFlatEvalResults(inputPath: string): Map<string, boolean> {
  const absolute = path.resolve(inputPath);
  if (!fs.existsSync(absolute)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
  const output = new Map<string, boolean>();
  if (!isRecord(parsed)) return output;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") output.set(key, value);
  }
  return output;
}

function missingOfficialAssets(officialRepoPath: string, rowId: string): string[] {
  return [
    path.join("run_scripts", rowId, "run_script.sh"),
    path.join("run_scripts", rowId, "parser.py"),
    path.join("dockerfiles", "base_dockerfile", rowId, "Dockerfile"),
    path.join("dockerfiles", "instance_dockerfile", rowId, "Dockerfile")
  ].filter((relative) => !fs.existsSync(path.join(officialRepoPath, relative)));
}

function officialEvaluatorArgs(input: {
  officialRepoPath: string;
  rawSamplePath: string;
  patchPath: string;
  evaluatorOutputDir: string;
  dockerhubUsername: string;
  numWorkers: number;
  useLocalDocker: boolean;
  dockerPlatform?: string | undefined;
  redo?: boolean | undefined;
}): string[] {
  return [
    path.join(input.officialRepoPath, "swe_bench_pro_eval.py"),
    "--raw_sample_path",
    input.rawSamplePath,
    "--patch_path",
    input.patchPath,
    "--output_dir",
    input.evaluatorOutputDir,
    "--scripts_dir",
    path.join(input.officialRepoPath, "run_scripts"),
    "--num_workers",
    String(Math.max(1, Math.floor(input.numWorkers))),
    "--dockerhub_username",
    input.dockerhubUsername,
    ...(input.useLocalDocker ? ["--use_local_docker"] : []),
    ...(input.dockerPlatform ? ["--docker_platform", input.dockerPlatform] : []),
    ...(input.redo ? ["--redo"] : [])
  ];
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveCommand(command: string): string {
  if (command.includes("/") || command.startsWith(".")) return path.resolve(command);
  return command;
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
