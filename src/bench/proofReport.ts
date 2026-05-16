import type {
  BenchmarkAssistClassification,
  BenchmarkAssistanceMode,
  BenchmarkAssistanceStatus,
  BenchmarkComparison,
  BenchmarkProofReport,
  BenchmarkReport,
  BenchmarkResultRecord
} from "../types.js";
import { classifyAssistance } from "./assistClassification.js";
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
  kairnCodexSession: BenchmarkReport[];
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
  const kairnCodexSession = optionalLatestReport(input.kairnCodexSession);
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
  const kairnCodexSessionVsBaseline = kairnCodexSession ? compareBenchmarkReports(baseline, kairnCodexSession) : undefined;
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
      kairn_codex_session: input.kairnCodexSession,
      mcp_first: input.mcpFirst,
      real_mcp_first: input.realMcpFirst,
      mcp_first_plus_hook_full_prime: input.mcpFirstPlusHookFullPrime,
      hybrid_mcp_brief: input.hybridMcpBrief
    }
  });
  const caseRepeatClassifications = buildCaseRepeatClassifications({
    baseline: input.baseline,
    reports: {
      prompt_only: input.promptOnly,
      prompt_plus_hooks: input.promptPlusHooks,
      manual_prime: input.manualPrime,
      hook_full_prime: input.hookFullPrime,
      hook_tiny_directive: input.hookTinyDirective,
      hook_tiny_with_failures: input.hookTinyWithFailures,
      kairn_codex_session: input.kairnCodexSession,
      mcp_first: input.mcpFirst,
      real_mcp_first: input.realMcpFirst,
      mcp_first_plus_hook_full_prime: input.mcpFirstPlusHookFullPrime,
      hybrid_mcp_brief: input.hybridMcpBrief
    }
  });
  const recommendations = uniqueStrings([
    ...(input.repeat > 1
      ? ["Repeat proof: prefer aggregate medians and case repeat classifications over the latest-run observedTokenDeltas field."]
      : []),
    ...aggregateRecommendations(aggregate),
    recommendationForDelta("Prompt-only hooks vs baseline", promptOnlyVsBaseline?.observedTokenDelta),
    recommendationForDelta("Prompt+tool hooks vs baseline", promptPlusVsBaseline?.observedTokenDelta),
    recommendationForDelta("Manual prime vs baseline", manualPrimeVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hook full prime vs baseline", hookFullPrimeVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hook tiny directive vs baseline", hookTinyDirectiveVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hook tiny+failures vs baseline", hookTinyWithFailuresVsBaseline?.observedTokenDelta),
    recommendationForDelta("Kairn Codex session vs baseline", kairnCodexSessionVsBaseline?.observedTokenDelta),
    recommendationForDelta("MCP-first vs baseline", mcpFirstVsBaseline?.observedTokenDelta),
    recommendationForDelta("Real MCP-first vs baseline", realMcpFirstVsBaseline?.observedTokenDelta),
    recommendationForDelta("MCP-first + full-prime hook vs baseline", mcpFirstPlusHookFullPrimeVsBaseline?.observedTokenDelta),
    recommendationForDelta("Hybrid MCP brief vs baseline", hybridMcpBriefVsBaseline?.observedTokenDelta),
    ...caseRepeatClassifications
      .filter((item) => item.verdict !== "consistent_win" && item.verdict !== "consistent_abstention")
      .slice(0, 6)
      .map((item) => `${item.mode}/${item.caseId}: ${item.recommendation}`),
    ...(manualPrimeVsBaseline?.recommendations.slice(0, 4) ?? promptOnlyVsBaseline?.recommendations.slice(0, 4) ?? [])
]);
  const observedTokenDeltas = {
    ...(promptOnlyVsBaseline?.observedTokenDelta ? { promptOnlyVsBaseline: promptOnlyVsBaseline.observedTokenDelta } : {}),
    ...(promptPlusVsBaseline?.observedTokenDelta ? { promptPlusHooksVsBaseline: promptPlusVsBaseline.observedTokenDelta } : {}),
    ...(manualPrimeVsBaseline?.observedTokenDelta ? { manualPrimeVsBaseline: manualPrimeVsBaseline.observedTokenDelta } : {}),
    ...(hookFullPrimeVsBaseline?.observedTokenDelta ? { hookFullPrimeVsBaseline: hookFullPrimeVsBaseline.observedTokenDelta } : {}),
    ...(hookTinyDirectiveVsBaseline?.observedTokenDelta ? { hookTinyDirectiveVsBaseline: hookTinyDirectiveVsBaseline.observedTokenDelta } : {}),
    ...(hookTinyWithFailuresVsBaseline?.observedTokenDelta ? { hookTinyWithFailuresVsBaseline: hookTinyWithFailuresVsBaseline.observedTokenDelta } : {}),
    ...(kairnCodexSessionVsBaseline?.observedTokenDelta ? { kairnCodexSessionVsBaseline: kairnCodexSessionVsBaseline.observedTokenDelta } : {}),
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
    ...(kairnCodexSession ? { kairnCodexSession } : {}),
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
      kairn_codex_session: input.kairnCodexSession,
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
      kairnCodexSessionVsBaseline,
      mcpFirstVsBaseline,
      realMcpFirstVsBaseline,
      mcpFirstPlusHookFullPrimeVsBaseline,
      hybridMcpBriefVsBaseline
    ]),
    ...(caseRepeatClassifications.length > 0 ? { caseRepeatClassifications } : {}),
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
      kairnCodexSessionVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.kairn_codex_session?.medianTokens),
      realMcpFirstVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.real_mcp_first?.medianTokens),
      mcpFirstPlusHookFullPrimeVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.mcp_first_plus_hook_full_prime?.medianTokens),
      hybridMcpBriefVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.hybrid_mcp_brief?.medianTokens)
    }
  };
}

function buildCaseRepeatClassifications(input: {
  baseline: BenchmarkReport[];
  reports: Partial<Record<BenchmarkAssistanceMode, BenchmarkReport[]>>;
}): NonNullable<BenchmarkProofReport["caseRepeatClassifications"]> {
  const rows: NonNullable<BenchmarkProofReport["caseRepeatClassifications"]> = [];
  for (const [mode, reports] of Object.entries(input.reports) as Array<[BenchmarkAssistanceMode, BenchmarkReport[] | undefined]>) {
    if (!reports || reports.length === 0) continue;
    const observations = new Map<string, Array<{
      baselineTokens?: number;
      modeTokens?: number;
      savedTokens?: number;
      classification: BenchmarkAssistClassification;
      assistanceStatus: BenchmarkAssistanceStatus;
      qualityGatePassed: boolean;
    }>>();

    const pairs = Math.min(input.baseline.length, reports.length);
    for (let index = 0; index < pairs; index += 1) {
      const baseline = input.baseline[index]!;
      const report = reports[index]!;
      const baselineByCase = new Map(baseline.results.map((result) => [result.caseId, result]));
      for (const result of report.results) {
        const before = baselineByCase.get(result.caseId);
        if (!before) continue;
        const baselineTokens = before.observedCodexTokens;
        const modeTokens = result.observedCodexTokens;
        const savedTokens = baselineTokens !== undefined && modeTokens !== undefined ? baselineTokens - modeTokens : undefined;
        const qualityGatePassed = resultQualityGatePassed(result);
        const assistanceStatus = resultAssistanceStatus(result);
        const classification = classifyAssistance({
          assistanceStatus,
          qualityGatePassed,
          savedTokens,
          baselineTokens,
          baselineQualityGatePassed: resultQualityGatePassed(before),
          turnCount: 1
        });
        const bucket = observations.get(result.caseId) ?? [];
        bucket.push({
          ...(baselineTokens !== undefined ? { baselineTokens } : {}),
          ...(modeTokens !== undefined ? { modeTokens } : {}),
          ...(savedTokens !== undefined ? { savedTokens } : {}),
          classification: classification.assistClassification,
          assistanceStatus,
          qualityGatePassed
        });
        observations.set(result.caseId, bucket);
      }
    }

    for (const [caseId, items] of observations) {
      const classifications = countClassifications(items.map((item) => item.classification));
      const baselineTokens = items.map((item) => item.baselineTokens).filter((value): value is number => value !== undefined);
      const modeTokens = items.map((item) => item.modeTokens).filter((value): value is number => value !== undefined);
      const savedTokens = items.map((item) => item.savedTokens).filter((value): value is number => value !== undefined);
      const baselineMedianTokens = baselineTokens.length > 0 ? median(baselineTokens) : undefined;
      const modeMedianTokens = modeTokens.length > 0 ? median(modeTokens) : undefined;
      const medianSavedTokens = savedTokens.length > 0 ? median(savedTokens) : undefined;
      const medianSavingsRate = baselineMedianTokens && baselineMedianTokens > 0 && medianSavedTokens !== undefined
        ? Number((medianSavedTokens / baselineMedianTokens).toFixed(4))
        : undefined;
      const activeRuns = items.filter((item) => item.assistanceStatus === "active").length;
      const suppressedRuns = items.filter((item) => item.assistanceStatus === "passive_suppressed").length;
      const qualityPasses = items.filter((item) => item.qualityGatePassed).length;
      const verdict = repeatVerdict({
        repeats: items.length,
        classifications,
        qualityPasses,
        activeRuns,
        suppressedRuns
      });
      rows.push({
        mode,
        caseId,
        repeats: items.length,
        qualityPasses,
        activeRuns,
        suppressedRuns,
        ...(baselineMedianTokens !== undefined ? { baselineMedianTokens } : {}),
        ...(modeMedianTokens !== undefined ? { modeMedianTokens } : {}),
        ...(medianSavedTokens !== undefined ? { medianSavedTokens } : {}),
        ...(medianSavingsRate !== undefined ? { medianSavingsRate } : {}),
        classifications,
        verdict,
        recommendation: repeatRecommendation({ mode, caseId, verdict, classifications, medianSavedTokens, medianSavingsRate })
      });
    }
  }

  return rows.sort((a, b) => a.mode.localeCompare(b.mode) || a.caseId.localeCompare(b.caseId));
}

function countClassifications(values: BenchmarkAssistClassification[]): Partial<Record<BenchmarkAssistClassification, number>> {
  const counts: Partial<Record<BenchmarkAssistClassification, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function repeatVerdict(input: {
  repeats: number;
  classifications: Partial<Record<BenchmarkAssistClassification, number>>;
  qualityPasses: number;
  activeRuns: number;
  suppressedRuns: number;
}): NonNullable<BenchmarkProofReport["caseRepeatClassifications"]>[number]["verdict"] {
  if (input.repeats < 2) return "insufficient_data";
  if (input.qualityPasses < input.repeats) return "quality_risk";
  const valid = input.classifications.valid_assist ?? 0;
  const abstained = input.classifications.correct_abstention ?? 0;
  const missed = (input.classifications.missed_savings_opportunity ?? 0) + (input.classifications.missed_quality_opportunity ?? 0);
  const over = input.classifications.over_assist ?? 0;
  const harmful = (input.classifications.harmful_invalid_assist ?? 0) + (input.classifications.passive_quality_regression ?? 0);
  if (harmful > 0) return "quality_risk";
  if (valid === input.repeats && input.activeRuns === input.repeats) return "consistent_win";
  if (abstained === input.repeats && input.suppressedRuns === input.repeats) return "consistent_abstention";
  if (missed >= Math.ceil(input.repeats / 2)) return "missed_opportunity";
  if (over >= Math.ceil(input.repeats / 2)) return "over_assist";
  return "volatile";
}

function repeatRecommendation(input: {
  mode: BenchmarkAssistanceMode;
  caseId: string;
  verdict: NonNullable<BenchmarkProofReport["caseRepeatClassifications"]>[number]["verdict"];
  classifications: Partial<Record<BenchmarkAssistClassification, number>>;
  medianSavedTokens?: number | undefined;
  medianSavingsRate?: number | undefined;
}): string {
  const savings = input.medianSavedTokens !== undefined && input.medianSavingsRate !== undefined
    ? ` median ${input.medianSavedTokens} tokens (${Math.round(input.medianSavingsRate * 100)}%)`
    : "";
  switch (input.verdict) {
    case "consistent_win":
      return `Consistent active win for ${input.mode}${savings}.`;
    case "consistent_abstention":
      return `Consistent correct abstention; keep this class quiet.`;
    case "missed_opportunity":
      return `Repeated missed opportunity; Kairn stayed passive while baseline was expensive.`;
    case "over_assist":
      return `Repeated over-assist; tighten emit confidence or suppress this behavior class.`;
    case "quality_risk":
      return `Quality risk repeated; do not count token reductions until quality stabilizes.`;
    case "volatile":
      return `Mixed repeat outcomes (${JSON.stringify(input.classifications)}); require more repeats before tuning from ${input.caseId}.`;
    case "insufficient_data":
      return `Only one repeat; treat ${input.mode}/${input.caseId} as exploratory evidence.`;
  }
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

function aggregateRecommendations(aggregate: NonNullable<BenchmarkProofReport["aggregate"]>): string[] {
  const labels: Record<string, string> = {
    promptOnlyVsBaseline: "Prompt-only median",
    promptPlusHooksVsBaseline: "Prompt+tool hooks median",
    manualPrimeVsBaseline: "Manual prime median",
    hookFullPrimeVsBaseline: "Hook full-prime median",
    kairnCodexSessionVsBaseline: "Kairn Codex session median",
    realMcpFirstVsBaseline: "Real MCP-first median",
    mcpFirstPlusHookFullPrimeVsBaseline: "MCP-first + hook median",
    hybridMcpBriefVsBaseline: "Hybrid MCP brief median"
  };
  return Object.entries(aggregate.deltas).flatMap(([key, value]) => {
    if (!value || value.savedTokens === undefined || value.savingsRate === undefined) return [];
    const label = labels[key] ?? key;
    return [
      value.savedTokens >= 0
        ? `${label}: saved ${value.savedTokens} observed Codex tokens by repeat median (${Math.round(value.savingsRate * 100)}%).`
        : `${label}: increased observed Codex tokens by repeat median ${Math.abs(value.savedTokens)} (${Math.round(Math.abs(value.savingsRate) * 100)}%).`
    ];
  });
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

function resultQualityGatePassed(result: BenchmarkResultRecord): boolean {
  return result.taskOutcome === "pass" && result.metadata.qualityGatePassed === true;
}

function resultAssistanceStatus(result: BenchmarkResultRecord): BenchmarkAssistanceStatus {
  const mcpToolCalls = numberMetadata(result.metadata.actualMcpToolCalls ?? result.metadata.mcpToolCalls);
  const mcpReturnedFileCount = numberMetadata(result.metadata.mcpReturnedFileCount);
  const mcpContextActions = Array.isArray(result.metadata.actualMcpContextActions)
    ? result.metadata.actualMcpContextActions.filter((item): item is string => typeof item === "string")
    : [];
  const mcpSuppressedOnly =
    mcpToolCalls > 0 &&
    mcpReturnedFileCount === 0 &&
    mcpContextActions.some((action) => action === "suppress" || action === "request_evidence");
  const hasActiveAssistance =
    result.hookContextEmitted > 0 ||
    (mcpToolCalls > 0 && mcpReturnedFileCount > 0) ||
    (!mcpSuppressedOnly && result.metadata.primeEmitted === true) ||
    (!mcpSuppressedOnly && numberMetadata(result.metadata.primeEmitted) > 0) ||
    (!mcpSuppressedOnly && result.metadata.primeDecision === "emit") ||
    (!mcpSuppressedOnly && result.metadata.primeDecision === "shrink") ||
    (!mcpSuppressedOnly && result.metadata.contextDecision === "emit") ||
    (!mcpSuppressedOnly && result.metadata.contextDecision === "shrink") ||
    result.metadata.assistanceMode === "manual_prime";
  if (hasActiveAssistance) return "active";
  const hasSuppressedAssistance =
    mcpSuppressedOnly ||
    result.hookContextSuppressed > 0 ||
    result.metadata.primeSuppressed === true ||
    numberMetadata(result.metadata.primeSuppressed) > 0 ||
    result.metadata.primeDecision === "suppress" ||
    result.metadata.contextDecision === "suppress" ||
    result.metadata.primeDecision === "request_evidence" ||
    result.metadata.contextDecision === "request_evidence";
  return hasSuppressedAssistance ? "passive_suppressed" : "none";
}

function numberMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
