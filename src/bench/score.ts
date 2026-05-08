import type { BenchmarkCase, BenchmarkComparison, BenchmarkReport, BenchmarkResultRecord } from "../types.js";

export function scoreBenchmarkCase(input: {
  runId: string;
  benchmarkCase: BenchmarkCase;
  actualFiles: string[];
  responseTokens: number;
  observedCodexTokens?: number | undefined;
  hookContextEmitted?: number | undefined;
  hookContextSuppressed?: number | undefined;
  taskOutcome?: BenchmarkResultRecord["taskOutcome"] | undefined;
  summary: string;
  metadata?: Record<string, unknown> | undefined;
}): Omit<BenchmarkResultRecord, "id" | "createdAt"> {
  const expectedFiles = unique(input.benchmarkCase.expectedFiles);
  const requiredTouchedFiles = unique(input.benchmarkCase.requiredTouchedFiles ?? []);
  const actualFiles = unique(input.actualFiles);
  const excludedFiles = unique(input.benchmarkCase.excludedFiles);
  const expectedHits = expectedFiles.filter((file) => actualFiles.includes(file));
  const missedExpectedFiles = expectedFiles.filter((file) => !actualFiles.includes(file));
  const agentChangedFiles = stringArrayMetadata(input.metadata?.agentChangedFiles);
  const requiredTouchedHits = requiredTouchedFiles.filter((file) => agentChangedFiles.includes(file));
  const missingRequiredTouchedFiles = requiredTouchedFiles.filter((file) => !agentChangedFiles.includes(file));
  const topFive = actualFiles.slice(0, 5);
  const excludedHits = actualFiles.filter((file) => excludedFiles.some((excluded) => fileMatchesBenchmarkPattern(file, excluded)));
  const expectedFileRecall = expectedFiles.length > 0 ? ratio(expectedHits.length, expectedFiles.length) : 1;
  const topKHitRate = expectedFiles.length > 0 ? (expectedFiles.some((file) => topFive.includes(file)) ? 1 : 0) : 1;
  const unexpectedFileRate = actualFiles.length > 0 ? ratio(excludedHits.length, actualFiles.length) : 0;
  const responsePenalty = Math.min(0.15, Math.max(0, input.responseTokens - (input.benchmarkCase.budget ?? 1200)) / 8000);
  const requestedOutcome = input.taskOutcome ?? "pass";
  const requiredTouchedSatisfied = requiredTouchedFiles.length === 0 || missingRequiredTouchedFiles.length === 0;
  const mcpSuccess = !requiresMcpSuccess(input.metadata) || numberMetadata(input.metadata?.actualMcpToolCalls ?? input.metadata?.mcpToolCalls) > 0;
  const qualityGatePassed = requestedOutcome === "pass" && requiredTouchedSatisfied && excludedHits.length === 0 && mcpSuccess;
  const outcome = requestedOutcome === "fail" || requestedOutcome === "skipped"
    ? requestedOutcome
    : qualityGatePassed
      ? "pass"
      : "partial";
  const outcomeMultiplier = outcome === "fail" ? 0.45 : outcome === "partial" ? 0.75 : outcome === "skipped" ? 0 : 1;
  const score = clampScore(
    (0.52 * expectedFileRecall + 0.28 * topKHitRate + 0.2 * (1 - unexpectedFileRate) - responsePenalty) *
      100 *
      outcomeMultiplier
  );

  return {
    runId: input.runId,
    caseId: input.benchmarkCase.id,
    caseMode: input.benchmarkCase.mode,
    score,
    expectedFileRecall,
    topKHitRate,
    unexpectedFileRate,
    responseTokens: input.responseTokens,
    ...(input.observedCodexTokens !== undefined ? { observedCodexTokens: input.observedCodexTokens } : {}),
    hookContextEmitted: input.hookContextEmitted ?? 0,
    hookContextSuppressed: input.hookContextSuppressed ?? 0,
    taskOutcome: outcome,
    expectedFiles,
    actualFiles,
    excludedFiles,
    summary: input.summary,
    recommendations: recommendationsFor({
      expectedFiles,
      actualFiles,
      excludedHits,
      missingRequiredTouchedFiles,
      mcpSuccess,
      responseTokens: input.responseTokens,
      budget: input.benchmarkCase.budget,
      outcome
    }),
    metadata: {
      ...(input.metadata ?? {}),
      missedExpectedFiles,
      irrelevantFilesRead: excludedHits,
      expectedFilesMentioned: expectedHits,
      requiredTouchedFiles,
      requiredTouchedFilesTouched: requiredTouchedHits,
      missingRequiredTouchedFiles,
      requiredTouchedSatisfied,
      mcpSuccess,
      qualityGatePassed
    }
  };
}

export function buildBenchmarkReport(input: {
  run: BenchmarkReport["run"];
  results: BenchmarkResultRecord[];
}): BenchmarkReport {
  const scoredResults = input.results.filter((result) => result.taskOutcome !== "skipped");
  const observedResults = input.results.filter((result) => result.observedCodexTokens !== undefined);
  const overallScore =
    scoredResults.length > 0
      ? Number((scoredResults.reduce((total, result) => total + result.score, 0) / scoredResults.length).toFixed(2))
      : 0;
  const observed =
    observedResults.length > 0
      ? {
          codexTokens: observedResults.reduce((total, result) => total + (result.observedCodexTokens ?? 0), 0),
          codexCaseCount: observedResults.length
        }
      : undefined;
  const weakestCases = [...input.results].sort((a, b) => a.score - b.score).slice(0, 5);
  const recommendations = unique(
    weakestCases.flatMap((result) => result.recommendations).concat(overallScore < 70 ? ["Overall score is low; inspect weak cases before tuning retrieval."] : [])
  );

  return {
    run: input.run,
    results: input.results,
    overallScore,
    ...(observed ? { observed } : {}),
    weakestCases,
    recommendations
  };
}

export function compareBenchmarkReports(before: BenchmarkReport, after: BenchmarkReport): BenchmarkComparison {
  const beforeByCase = new Map(before.results.map((result) => [result.caseId, result]));
  const improvedCases: string[] = [];
  const regressedCases: string[] = [];

  for (const result of after.results) {
    const previous = beforeByCase.get(result.caseId);
    if (!previous) continue;
    const delta = result.score - previous.score;
    if (delta >= 5) improvedCases.push(result.caseId);
    if (delta <= -5) regressedCases.push(result.caseId);
  }
  const tokenDelta = observedTokenDelta(before, after);

  return {
    before,
    after,
    scoreDelta: Number((after.overallScore - before.overallScore).toFixed(2)),
    ...(tokenDelta ? { observedTokenDelta: tokenDelta } : {}),
    improvedCases,
    regressedCases,
    recommendations: comparisonRecommendations({ before, after, regressedCases })
  };
}

function observedTokenDelta(before: BenchmarkReport, after: BenchmarkReport): BenchmarkComparison["observedTokenDelta"] {
  const beforeTokens = before.observed?.codexTokens;
  const afterTokens = after.observed?.codexTokens;
  if (beforeTokens === undefined || afterTokens === undefined) return undefined;
  const savedTokens = beforeTokens - afterTokens;
  return {
    beforeTokens,
    afterTokens,
    savedTokens,
    savingsRate: beforeTokens > 0 ? Number((savedTokens / beforeTokens).toFixed(4)) : 0
  };
}

function recommendationsFor(input: {
  expectedFiles: string[];
  actualFiles: string[];
  excludedHits: string[];
  missingRequiredTouchedFiles: string[];
  mcpSuccess: boolean;
  responseTokens: number;
  budget?: number | undefined;
  outcome: BenchmarkResultRecord["taskOutcome"];
}): string[] {
  const recommendations: string[] = [];
  const missed = input.expectedFiles.filter((file) => !input.actualFiles.includes(file));
  if (missed.length > 0) {
    recommendations.push(`Expected files missed: ${missed.slice(0, 4).join(", ")}.`);
  }
  if (input.excludedHits.length > 0) {
    recommendations.push(`Unexpected files surfaced: ${input.excludedHits.slice(0, 4).join(", ")}.`);
  }
  if (input.missingRequiredTouchedFiles.length > 0) {
    recommendations.push(`Required source files were not touched: ${input.missingRequiredTouchedFiles.slice(0, 4).join(", ")}.`);
  }
  if (!input.mcpSuccess) {
    recommendations.push("MCP mode did not record an actual Kairn MCP tool call.");
  }
  if (input.budget && input.responseTokens > input.budget) {
    recommendations.push("Response exceeded the benchmark budget; tune response routing or snippets.");
  }
  if (input.outcome === "skipped") {
    recommendations.push("Agent case skipped; configure an explicit agent command to collect live-agent evidence.");
  }
  if (input.outcome === "fail") {
    recommendations.push("Task outcome failed; inspect linked files and hook recommendations.");
  }
  return recommendations;
}

function comparisonRecommendations(input: {
  before: BenchmarkReport;
  after: BenchmarkReport;
  regressedCases: string[];
}): string[] {
  const recommendations: string[] = [];
  if (input.after.overallScore < input.before.overallScore) {
    recommendations.push("Benchmark score regressed; review changed retrieval scoring before shipping.");
  }
  if (input.regressedCases.length > 0) {
    recommendations.push(`Regressed cases: ${input.regressedCases.join(", ")}.`);
  }
  recommendations.push(...input.after.recommendations.slice(0, 5));
  return unique(recommendations);
}

function ratio(value: number, total: number): number {
  return Number((value / total).toFixed(4));
}

function clampScore(value: number): number {
  return Number(Math.max(0, Math.min(100, value)).toFixed(2));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function fileMatchesBenchmarkPattern(filePath: string, pattern: string): boolean {
  if (!pattern) return false;
  if (filePath === pattern) return true;
  if (pattern.endsWith("/")) return filePath.startsWith(pattern);
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  }
  return false;
}

function stringArrayMetadata(value: unknown): string[] {
  return Array.isArray(value) ? unique(value.filter((item): item is string => typeof item === "string" && Boolean(item))) : [];
}

function numberMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requiresMcpSuccess(metadata: Record<string, unknown> | undefined): boolean {
  const assistanceMode = typeof metadata?.assistanceMode === "string" ? metadata.assistanceMode : "";
  return assistanceMode === "mcp_first" ||
    assistanceMode === "real_mcp_first" ||
    assistanceMode === "mcp_first_plus_hook_full_prime" ||
    assistanceMode === "hybrid_mcp_brief";
}
