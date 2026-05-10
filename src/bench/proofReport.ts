import type { BenchmarkAssistanceMode, BenchmarkComparison, BenchmarkProofReport, BenchmarkReport } from "../types.js";
import { compareBenchmarkReports } from "./score.js";
import { uniqueStrings } from "../utils/collections.js";

export function buildBenchmarkProofReport(input: {
  baseline: BenchmarkReport[];
  promptOnly: BenchmarkReport[];
  promptPlusHooks: BenchmarkReport[];
  manualPrime: BenchmarkReport[];
  hookFullPrime: BenchmarkReport[];
  hookTinyDirective: BenchmarkReport[];
  hookTinyWithFailures: BenchmarkReport[];
  mcpFirst: BenchmarkReport[];
  realMcpFirst: BenchmarkReport[];
  mcpFirstPlusHookFullPrime: BenchmarkReport[];
  hybridMcpBrief: BenchmarkReport[];
  repeat: number;
}): BenchmarkProofReport {
  const baseline = latestReport(input.baseline);
  const promptOnly = optionalLatestReport(input.promptOnly);
  const promptPlusHooks = optionalLatestReport(input.promptPlusHooks);
  const manualPrime = optionalLatestReport(input.manualPrime);
  const hookFullPrime = optionalLatestReport(input.hookFullPrime);
  const hookTinyDirective = optionalLatestReport(input.hookTinyDirective);
  const hookTinyWithFailures = optionalLatestReport(input.hookTinyWithFailures);
  const mcpFirst = optionalLatestReport(input.mcpFirst);
  const realMcpFirst = optionalLatestReport(input.realMcpFirst);
  const mcpFirstPlusHookFullPrime = optionalLatestReport(input.mcpFirstPlusHookFullPrime);
  const hybridMcpBrief = optionalLatestReport(input.hybridMcpBrief);
  const passiveHooks = promptPlusHooks ?? promptOnly ?? baseline;
  const proactive = manualPrime ?? baseline;
  const promptOnlyVsBaseline = promptOnly ? compareBenchmarkReports(baseline, promptOnly) : undefined;
  const promptPlusVsBaseline = promptPlusHooks ? compareBenchmarkReports(baseline, promptPlusHooks) : undefined;
  const manualPrimeVsBaseline = manualPrime ? compareBenchmarkReports(baseline, manualPrime) : undefined;
  const hookFullPrimeVsBaseline = hookFullPrime ? compareBenchmarkReports(baseline, hookFullPrime) : undefined;
  const hookTinyDirectiveVsBaseline = hookTinyDirective ? compareBenchmarkReports(baseline, hookTinyDirective) : undefined;
  const hookTinyWithFailuresVsBaseline = hookTinyWithFailures ? compareBenchmarkReports(baseline, hookTinyWithFailures) : undefined;
  const mcpFirstVsBaseline = mcpFirst ? compareBenchmarkReports(baseline, mcpFirst) : undefined;
  const realMcpFirstVsBaseline = realMcpFirst ? compareBenchmarkReports(baseline, realMcpFirst) : undefined;
  const mcpFirstPlusHookFullPrimeVsBaseline = mcpFirstPlusHookFullPrime ? compareBenchmarkReports(baseline, mcpFirstPlusHookFullPrime) : undefined;
  const hybridMcpBriefVsBaseline = hybridMcpBrief ? compareBenchmarkReports(baseline, hybridMcpBrief) : undefined;
  const proactiveVsPassive = manualPrime && passiveHooks ? compareBenchmarkReports(passiveHooks, manualPrime) : undefined;
  const baselineByCase = new Map(baseline.results.map((result) => [result.caseId, result]));
  const promptOnlyByCase = new Map(promptOnly?.results.map((result) => [result.caseId, result]) ?? []);
  const promptPlusByCase = new Map(promptPlusHooks?.results.map((result) => [result.caseId, result]) ?? []);
  const manualPrimeByCase = new Map(manualPrime?.results.map((result) => [result.caseId, result]) ?? []);
  const caseIds = uniqueStrings([...baselineByCase.keys(), ...promptOnlyByCase.keys(), ...promptPlusByCase.keys(), ...manualPrimeByCase.keys()]);
  const caseDeltas = caseIds.map((caseId) => {
    const baseline = baselineByCase.get(caseId);
    const passiveHooks = promptPlusByCase.get(caseId) ?? promptOnlyByCase.get(caseId);
    const proactive = manualPrimeByCase.get(caseId);
    return {
      caseId,
      ...(baseline?.observedCodexTokens !== undefined ? { baselineTokens: baseline.observedCodexTokens } : {}),
      ...(passiveHooks?.observedCodexTokens !== undefined ? { passiveHooksTokens: passiveHooks.observedCodexTokens } : {}),
      ...(proactive?.observedCodexTokens !== undefined ? { proactiveTokens: proactive.observedCodexTokens } : {}),
      ...(baseline?.observedCodexTokens !== undefined && proactive?.observedCodexTokens !== undefined
        ? { proactiveVsBaseline: baseline.observedCodexTokens - proactive.observedCodexTokens }
        : {}),
      ...(passiveHooks?.observedCodexTokens !== undefined && proactive?.observedCodexTokens !== undefined
        ? { proactiveVsPassive: passiveHooks.observedCodexTokens - proactive.observedCodexTokens }
        : {}),
      outcome: {
        baseline: baseline?.taskOutcome ?? "skipped",
        passiveHooks: passiveHooks?.taskOutcome ?? "skipped",
        proactive: proactive?.taskOutcome ?? "skipped"
      }
    };
  });
  const aggregate = buildProofAggregate({
    repeat: input.repeat,
    reports: {
      baseline: input.baseline,
      prompt_only: input.promptOnly,
      prompt_plus_hooks: input.promptPlusHooks,
      manual_prime: input.manualPrime,
      hook_full_prime: input.hookFullPrime,
      hook_tiny_directive: input.hookTinyDirective,
      hook_tiny_with_failures: input.hookTinyWithFailures,
      mcp_first: input.mcpFirst,
      real_mcp_first: input.realMcpFirst,
      mcp_first_plus_hook_full_prime: input.mcpFirstPlusHookFullPrime,
      hybrid_mcp_brief: input.hybridMcpBrief
    }
  });
  const recommendations = uniqueStrings([
    recommendationForDelta("Prompt-only hooks vs baseline", promptOnlyVsBaseline?.observedTokenDelta),
    recommendationForDelta("Prompt+tool hooks vs baseline", promptPlusVsBaseline?.observedTokenDelta),
    recommendationForDelta("Manual prime vs baseline", manualPrimeVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hook full prime vs baseline", hookFullPrimeVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hook tiny directive vs baseline", hookTinyDirectiveVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hook tiny+failures vs baseline", hookTinyWithFailuresVsBaseline?.observedTokenDelta),
    recommendationForDelta("MCP-first vs baseline", mcpFirstVsBaseline?.observedTokenDelta),
    recommendationForDelta("Real MCP-first vs baseline", realMcpFirstVsBaseline?.observedTokenDelta),
    recommendationForDelta("MCP-first + full-prime hook vs baseline", mcpFirstPlusHookFullPrimeVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hybrid MCP brief vs baseline", hybridMcpBriefVsBaseline?.observedTokenDelta),
    ...(manualPrimeVsBaseline?.recommendations.slice(0, 4) ?? promptOnlyVsBaseline?.recommendations.slice(0, 4) ?? [])
  ]);
  const observedTokenDeltas = {
    ...(promptOnlyVsBaseline?.observedTokenDelta ? { promptOnlyVsBaseline: promptOnlyVsBaseline.observedTokenDelta } : {}),
    ...(promptPlusVsBaseline?.observedTokenDelta ? { promptPlusHooksVsBaseline: promptPlusVsBaseline.observedTokenDelta } : {}),
    ...(manualPrimeVsBaseline?.observedTokenDelta ? { manualPrimeVsBaseline: manualPrimeVsBaseline.observedTokenDelta } : {}),
    ...(hookFullPrimeVsBaseline?.observedTokenDelta ? { hookFullPrimeVsBaseline: hookFullPrimeVsBaseline.observedTokenDelta } : {}),
    ...(hookTinyDirectiveVsBaseline?.observedTokenDelta ? { hookTinyDirectiveVsBaseline: hookTinyDirectiveVsBaseline.observedTokenDelta } : {}),
    ...(hookTinyWithFailuresVsBaseline?.observedTokenDelta ? { hookTinyWithFailuresVsBaseline: hookTinyWithFailuresVsBaseline.observedTokenDelta } : {}),
    ...(mcpFirstVsBaseline?.observedTokenDelta ? { mcpFirstVsBaseline: mcpFirstVsBaseline.observedTokenDelta } : {}),
    ...(realMcpFirstVsBaseline?.observedTokenDelta ? { realMcpFirstVsBaseline: realMcpFirstVsBaseline.observedTokenDelta } : {}),
    ...(mcpFirstPlusHookFullPrimeVsBaseline?.observedTokenDelta ? { mcpFirstPlusHookFullPrimeVsBaseline: mcpFirstPlusHookFullPrimeVsBaseline.observedTokenDelta } : {}),
    ...(hybridMcpBriefVsBaseline?.observedTokenDelta ? { hybridMcpBriefVsBaseline: hybridMcpBriefVsBaseline.observedTokenDelta } : {}),
    ...(promptPlusVsBaseline?.observedTokenDelta ? { passiveVsBaseline: promptPlusVsBaseline.observedTokenDelta } : {}),
    ...(manualPrimeVsBaseline?.observedTokenDelta ? { proactiveVsBaseline: manualPrimeVsBaseline.observedTokenDelta } : {}),
    ...(proactiveVsPassive?.observedTokenDelta ? { proactiveVsPassive: proactiveVsPassive.observedTokenDelta } : {})
  };

  return {
    baseline,
    ...(promptOnly ? { promptOnly } : {}),
    ...(promptPlusHooks ? { promptPlusHooks } : {}),
    ...(manualPrime ? { manualPrime } : {}),
    ...(hookFullPrime ? { hookFullPrime } : {}),
    ...(hookTinyDirective ? { hookTinyDirective } : {}),
    ...(hookTinyWithFailures ? { hookTinyWithFailures } : {}),
    ...(mcpFirst ? { mcpFirst } : {}),
    ...(realMcpFirst ? { realMcpFirst } : {}),
    ...(mcpFirstPlusHookFullPrime ? { mcpFirstPlusHookFullPrime } : {}),
    ...(hybridMcpBrief ? { hybridMcpBrief } : {}),
    passiveHooks,
    proactive,
    runs: {
      baseline: input.baseline,
      prompt_only: input.promptOnly,
      prompt_plus_hooks: input.promptPlusHooks,
      manual_prime: input.manualPrime,
      hook_full_prime: input.hookFullPrime,
      hook_tiny_directive: input.hookTinyDirective,
      hook_tiny_with_failures: input.hookTinyWithFailures,
      mcp_first: input.mcpFirst,
      real_mcp_first: input.realMcpFirst,
      mcp_first_plus_hook_full_prime: input.mcpFirstPlusHookFullPrime,
      hybrid_mcp_brief: input.hybridMcpBrief
    },
    aggregate,
    abstentionSummary: summarizeAssistClassifications(observedTokenDeltas),
    behaviorTargetSummary: summarizeBehaviorTargetComparisons([
      promptOnlyVsBaseline,
      promptPlusVsBaseline,
      manualPrimeVsBaseline,
      hookFullPrimeVsBaseline,
      hookTinyDirectiveVsBaseline,
      hookTinyWithFailuresVsBaseline,
      mcpFirstVsBaseline,
      realMcpFirstVsBaseline,
      mcpFirstPlusHookFullPrimeVsBaseline,
      hybridMcpBriefVsBaseline
    ]),
    observedTokenDeltas,
    caseDeltas,
    recommendations
  };
}

export function shuffleItems<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function latestReport(reports: BenchmarkReport[]): BenchmarkReport {
  const report = reports.at(-1);
  if (!report) {
    throw new Error("Benchmark proof requires at least one baseline report.");
  }
  return report;
}

function optionalLatestReport(reports: BenchmarkReport[]): BenchmarkReport | undefined {
  return reports.at(-1);
}

function buildProofAggregate(input: {
  repeat: number;
  reports: Partial<Record<BenchmarkAssistanceMode, BenchmarkReport[]>>;
}): NonNullable<BenchmarkProofReport["aggregate"]> {
  const modes: NonNullable<BenchmarkProofReport["aggregate"]>["modes"] = {};
  for (const [mode, reports] of Object.entries(input.reports) as Array<[BenchmarkAssistanceMode, BenchmarkReport[] | undefined]>) {
    const tokenTotals = (reports ?? []).map((report) => report.observed?.codexTokens).filter((value): value is number => typeof value === "number");
    const qualityPassingReports = (reports ?? []).filter(reportQualityGatePassed).length;
    modes[mode] = {
      reports: reports?.length ?? 0,
      ...(tokenTotals.length > 0 ? { meanTokens: mean(tokenTotals), medianTokens: median(tokenTotals) } : {}),
      qualityPassingReports,
      caseCount: reports?.reduce((total, report) => total + report.results.length, 0) ?? 0
    };
  }

  return {
    repeat: input.repeat,
    modes,
    deltas: {
      promptOnlyVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.prompt_only?.medianTokens),
      promptPlusHooksVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.prompt_plus_hooks?.medianTokens),
      manualPrimeVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.manual_prime?.medianTokens),
      hookFullPrimeVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.hook_full_prime?.medianTokens),
      realMcpFirstVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.real_mcp_first?.medianTokens),
      mcpFirstPlusHookFullPrimeVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.mcp_first_plus_hook_full_prime?.medianTokens),
      hybridMcpBriefVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.hybrid_mcp_brief?.medianTokens)
    }
  };
}

function aggregateDelta(beforeMedianTokens: number | undefined, afterMedianTokens: number | undefined) {
  if (beforeMedianTokens === undefined || afterMedianTokens === undefined) return {};
  const savedTokens = beforeMedianTokens - afterMedianTokens;
  return {
    beforeMedianTokens,
    afterMedianTokens,
    savedTokens,
    savingsRate: beforeMedianTokens > 0 ? Number((savedTokens / beforeMedianTokens).toFixed(4)) : 0
  };
}

function mean(values: number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[midpoint - 1]! + sorted[midpoint]!) / 2) : sorted[midpoint]!;
}

function recommendationForDelta(label: string, delta: BenchmarkComparison["observedTokenDelta"]): string {
  if (!delta) return `${label}: observed Codex usage unavailable.`;
  if (!delta.qualityGatePassed && delta.savedTokens > 0) {
    return `${label}: reduced ${delta.savedTokens} observed Codex tokens, but this is invalid savings because quality gates failed.`;
  }
  if (delta.assistanceEligible === false && delta.savedTokens > 0) {
    return `${label}: reduced ${delta.savedTokens} observed Codex tokens, but this is ${delta.assistClassification ?? "passive evidence"} rather than Kairn-assisted savings.`;
  }
  if (delta.assistClassification === "over_assist") {
    return `${label}: Kairn was active but increased observed Codex usage by ${Math.abs(delta.savedTokens)} tokens.`;
  }
  if (delta.savedTokens > 0) {
    return `${label}: saved ${delta.savedTokens} observed Codex tokens (${Math.round(delta.savingsRate * 100)}%).`;
  }
  return `${label}: increased observed Codex usage by ${Math.abs(delta.savedTokens)} tokens (${Math.round(Math.abs(delta.savingsRate) * 100)}%).`;
}

function summarizeAssistClassifications(deltas: BenchmarkProofReport["observedTokenDeltas"]): NonNullable<BenchmarkProofReport["abstentionSummary"]> {
  const summary: NonNullable<BenchmarkProofReport["abstentionSummary"]> = {};
  for (const delta of Object.values(deltas)) {
    const classification = delta?.assistClassification;
    if (!classification) continue;
    summary[classification] = (summary[classification] ?? 0) + 1;
  }
  return summary;
}

function summarizeBehaviorTargetComparisons(comparisons: Array<BenchmarkComparison | undefined>): NonNullable<BenchmarkProofReport["behaviorTargetSummary"]> {
  const summary: NonNullable<BenchmarkProofReport["behaviorTargetSummary"]> = {};
  for (const comparison of comparisons) {
    for (const [behavior, bucket] of Object.entries(comparison?.behaviorTargetSummary ?? {})) {
      const current = summary[behavior as keyof typeof summary] ?? { cases: 0, met: 0, missed: 0 };
      current.cases += bucket.cases;
      current.met += bucket.met;
      current.missed += bucket.missed;
      summary[behavior as keyof typeof summary] = current;
    }
  }
  return summary;
}

function reportQualityGatePassed(report: BenchmarkReport): boolean {
  const scored = report.results.filter((result) => result.taskOutcome !== "skipped");
  return scored.length > 0 && scored.every((result) => result.metadata.qualityGatePassed === true);
}
