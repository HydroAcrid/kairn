import type {
  BenchmarkAssistanceStatus,
  BenchmarkAssistanceMode,
  BenchmarkCase,
  BenchmarkComparison,
  BenchmarkOfficialEvaluation,
  BenchmarkOfficialEvaluationBucket,
  BenchmarkOfficialEvaluationSummary,
  BenchmarkReport,
  BenchmarkResultRecord
} from "../types.js";
import { classificationNegativeEvidenceReason, classifyAssistance } from "./assistClassification.js";
import { evaluateBehaviorTarget, summarizeBehaviorTargets } from "./behaviorTargets.js";

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
  const metadataHasRequiredTouchedFiles = Object.prototype.hasOwnProperty.call(input.metadata ?? {}, "requiredTouchedFiles");
  const requiredTouchedFiles = unique(
    metadataHasRequiredTouchedFiles
      ? stringArrayMetadata(input.metadata?.requiredTouchedFiles)
      : input.benchmarkCase.requiredTouchedFiles ?? []
  );
  const actualFiles = unique(input.actualFiles);
  const excludedFiles = unique(input.benchmarkCase.excludedFiles);
  const metadataHasAgentChangedFiles = Object.prototype.hasOwnProperty.call(input.metadata ?? {}, "agentChangedFiles");
  const agentChangedFiles = stringArrayMetadata(input.metadata?.agentChangedFiles);
  const qnaEvaluation = input.benchmarkCase.qnaEvaluation;
  const expectedCoverageFiles =
    requiredTouchedFiles.length > 0 && !qnaEvaluation && metadataHasAgentChangedFiles
      ? unique(agentChangedFiles)
      : actualFiles;
  const expectedHits = expectedFiles.filter((file) => expectedCoverageFiles.includes(file));
  const missedExpectedFiles = expectedFiles.filter((file) => !expectedCoverageFiles.includes(file));
  const requiredTouchedHits = requiredTouchedFiles.filter((file) => agentChangedFiles.includes(file));
  const missingRequiredTouchedFiles = requiredTouchedFiles.filter((file) => !agentChangedFiles.includes(file));
  const requestedOutcome = input.taskOutcome ?? "pass";
  const requiredTouchedSatisfied = requiredTouchedFiles.length === 0 || missingRequiredTouchedFiles.length === 0;
  const productionOnlyScopeExpected = benchmarkCaseRequiresProductionOnly(input.benchmarkCase);
  const topFive = expectedCoverageFiles.slice(0, 5);
  const excludedHits = actualFiles.filter((file) => excludedFiles.some((excluded) => fileMatchesBenchmarkPattern(file, excluded)));
  const minExpectedHits = Math.max(0, Math.min(expectedFiles.length, input.benchmarkCase.minExpectedHits ?? expectedFiles.length));
  const rawExpectedCoverageSatisfied = expectedFiles.length === 0 || expectedHits.length >= minExpectedHits;
  const sourceScopeCoverageOverride =
    productionOnlyScopeExpected &&
    !qnaEvaluation &&
    requiredTouchedFiles.length > 0 &&
    requiredTouchedSatisfied;
  const expectedCoverageSatisfied = rawExpectedCoverageSatisfied || sourceScopeCoverageOverride;
  const expectedFileRecall = expectedFiles.length > 0 ? ratio(expectedHits.length, expectedFiles.length) : 1;
  const effectiveExpectedFileRecall =
    sourceScopeCoverageOverride
      ? 1
      : expectedFiles.length > 0 && minExpectedHits > 0
        ? ratio(Math.min(expectedHits.length, minExpectedHits), minExpectedHits)
        : 1;
  const topKHitRate = expectedFiles.length > 0 ? (expectedFiles.some((file) => topFive.includes(file)) ? 1 : 0) : 1;
  const unexpectedFileRate = actualFiles.length > 0 ? ratio(excludedHits.length, actualFiles.length) : 0;
  const responsePenalty = Math.min(0.15, Math.max(0, input.responseTokens - (input.benchmarkCase.budget ?? 1200)) / 8000);
  const mcpRequired = requiresMcpSuccess(input.metadata);
  const mcpSuccess = !mcpRequired || numberMetadata(input.metadata?.actualMcpToolCalls ?? input.metadata?.mcpToolCalls) > 0;
  const qnaMinSourceMentions = Math.max(
    0,
    Math.min(expectedFiles.length, qnaEvaluation?.minSourceMentions ?? minExpectedHits)
  );
  const qnaGroundingPassed = !qnaEvaluation || expectedFiles.length === 0 || expectedHits.length >= qnaMinSourceMentions;
  const qnaNoRepoChangesPassed = !qnaEvaluation?.requireNoRepoChanges || agentChangedFiles.length === 0;
  const sourceInvariantPassed = input.metadata?.sourceInvariantPassed !== false;
  const diffScopePassed = input.metadata?.diffScopePassed !== false;
  const scopeViolationCount = stringArrayMetadata(input.metadata?.scopeViolations ?? input.metadata?.diffScopeViolations).length;
  const testsEdited = stringArrayMetadata(input.metadata?.testsEdited);
  const testEditViolationFiles = productionOnlyScopeExpected ? testsEdited : [];
  const extraProductionEditViolationFiles =
    productionOnlyScopeExpected && requiredTouchedFiles.length > 0 && !input.benchmarkCase.allowedDiffScopes?.length
      ? agentChangedFiles.filter((file) => !requiredTouchedFiles.includes(file))
      : [];
  const sourceScopeDisciplinePassed = diffScopePassed &&
    scopeViolationCount === 0 &&
    testEditViolationFiles.length === 0 &&
    extraProductionEditViolationFiles.length === 0;
  const qualityGatePassed =
    requestedOutcome === "pass" &&
    requiredTouchedSatisfied &&
    expectedCoverageSatisfied &&
    excludedHits.length === 0 &&
    mcpSuccess &&
    qnaGroundingPassed &&
    qnaNoRepoChangesPassed &&
    sourceInvariantPassed &&
    sourceScopeDisciplinePassed;
  const outcome = requestedOutcome === "fail" || requestedOutcome === "skipped"
    ? requestedOutcome
    : qualityGatePassed
      ? "pass"
      : "partial";
  const outcomeMultiplier = outcome === "fail" ? 0.45 : outcome === "partial" ? 0.75 : outcome === "skipped" ? 0 : 1;
  const expectedRecallSignal = qnaEvaluation ? effectiveExpectedFileRecall : expectedFileRecall;
  const score = clampScore(
    (0.52 * expectedRecallSignal + 0.28 * topKHitRate + 0.2 * (1 - unexpectedFileRate) - responsePenalty) *
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
      mcpReturnedFileCount: numberMetadata(input.metadata?.mcpReturnedFileCount),
      mcpReturnedNoiseFileCount: numberMetadata(input.metadata?.mcpReturnedNoiseFileCount),
      mcpReturnedTestFanoutCount: numberMetadata(input.metadata?.mcpReturnedTestFanoutCount),
      mcpContextEfficiency: numberMetadata(input.metadata?.mcpContextEfficiency),
      responseTokens: input.responseTokens,
      budget: input.benchmarkCase.budget,
      outcome,
      minExpectedHits,
      expectedCoverageSatisfied,
      qnaGroundingPassed,
      qnaNoRepoChangesPassed,
      qnaMinSourceMentions,
      qnaSourceMentionCount: expectedHits.length,
      qnaUnexpectedRepoChanges: qnaEvaluation?.requireNoRepoChanges ? agentChangedFiles : [],
      scopeViolations: stringArrayMetadata(input.metadata?.scopeViolations ?? input.metadata?.diffScopeViolations),
      testEditViolationFiles,
      extraProductionEditViolationFiles,
      sourceScopeDisciplinePassed
    }),
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.benchmarkCase.contextBehavior ? { contextBehavior: input.benchmarkCase.contextBehavior } : {}),
      ...(input.benchmarkCase.officialEvaluation
        ? {
            officialEvaluation: input.benchmarkCase.officialEvaluation,
            officialBenchmarkSource: input.benchmarkCase.officialEvaluation.source,
            officialTaskClass: input.benchmarkCase.officialEvaluation.taskClass,
            officialEvaluator: input.benchmarkCase.officialEvaluation.evaluator,
            kairnApplicability: input.benchmarkCase.officialEvaluation.kairnApplicability,
            kairnMetricEligible: input.benchmarkCase.officialEvaluation.kairnMetricEligible,
            officialLiveRisk: input.benchmarkCase.officialEvaluation.liveRisk
          }
        : {}),
      missedExpectedFiles,
      irrelevantFilesRead: excludedHits,
      expectedFilesMentioned: expectedHits,
      minExpectedHits,
      rawExpectedCoverageSatisfied,
      expectedCoverageSatisfied,
      sourceScopeCoverageOverride,
      effectiveExpectedFileRecall,
      requiredTouchedFiles,
      requiredTouchedFilesTouched: requiredTouchedHits,
      missingRequiredTouchedFiles,
      requiredTouchedSatisfied,
      mcpRequired,
      mcpSuccess,
      sourceInvariantPassed,
      diffScopePassed,
      scopeViolations: stringArrayMetadata(input.metadata?.scopeViolations ?? input.metadata?.diffScopeViolations),
      productionOnlyScopeExpected,
      testEditViolationFiles,
      extraProductionEditViolationFiles,
      sourceScopeDiscipline: sourceScopeDisciplinePassed ? "passed" : "failed",
      ...(qnaEvaluation
        ? {
            qnaEvaluation,
            qnaSourceMentions: expectedHits,
            qnaSourceMentionCount: expectedHits.length,
            qnaMinSourceMentions,
            qnaGroundingPassed,
            qnaNoRepoChangesPassed,
            qnaUnexpectedRepoChanges: qnaEvaluation.requireNoRepoChanges ? agentChangedFiles : []
          }
        : {}),
      qualityGatePassed,
      validSavings: qualityGatePassed,
      invalidSavings: !qualityGatePassed,
      negativeEvidenceReason: qualityGatePassed
        ? undefined
        : negativeEvidenceReason({
            requestedOutcome,
            requiredTouchedSatisfied,
            expectedCoverageSatisfied,
            excludedHits,
            mcpSuccess,
            qnaGroundingPassed,
            qnaNoRepoChangesPassed,
            sourceInvariantPassed,
            sourceScopeDisciplinePassed
          })
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
  const officialEvaluationSummary = summarizeOfficialEvaluations(input.results);

  return {
    run: input.run,
    results: input.results,
    overallScore,
    ...(observed ? { observed } : {}),
    weakestCases,
    recommendations,
    ...(officialEvaluationSummary ? { officialEvaluationSummary } : {})
  };
}

function summarizeOfficialEvaluations(results: BenchmarkResultRecord[]): BenchmarkOfficialEvaluationSummary | undefined {
  const officialResults = results
    .map((result) => ({ result, official: officialEvaluationMetadata(result.metadata.officialEvaluation) }))
    .filter((item): item is { result: BenchmarkResultRecord; official: BenchmarkOfficialEvaluation } => Boolean(item.official));
  if (officialResults.length === 0) return undefined;

  const byTaskClass: BenchmarkOfficialEvaluationSummary["byTaskClass"] = {};
  const byEvaluator: BenchmarkOfficialEvaluationSummary["byEvaluator"] = {};
  const byApplicability: BenchmarkOfficialEvaluationSummary["byApplicability"] = {};
  for (const item of officialResults) {
    addOfficialBucket(byTaskClass, item.official.taskClass, item.result, item.official);
    addOfficialBucket(byEvaluator, item.official.evaluator, item.result, item.official);
    addOfficialBucket(byApplicability, item.official.kairnApplicability, item.result, item.official);
  }
  finalizeOfficialBuckets(byTaskClass);
  finalizeOfficialBuckets(byEvaluator);
  finalizeOfficialBuckets(byApplicability);
  return {
    totalCases: officialResults.length,
    kairnMetricEligibleCases: officialResults.filter((item) => item.official.kairnMetricEligible).length,
    byTaskClass,
    byEvaluator,
    byApplicability
  };
}

function officialEvaluationMetadata(value: unknown): BenchmarkOfficialEvaluation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<BenchmarkOfficialEvaluation>;
  if (
    typeof record.source !== "string" ||
    typeof record.taskClass !== "string" ||
    typeof record.evaluator !== "string" ||
    typeof record.kairnApplicability !== "string" ||
    typeof record.kairnMetricEligible !== "boolean" ||
    typeof record.liveRisk !== "string"
  ) {
    return undefined;
  }
  return {
    source: record.source,
    taskClass: record.taskClass,
    evaluator: record.evaluator,
    kairnApplicability: record.kairnApplicability,
    kairnMetricEligible: record.kairnMetricEligible,
    liveRisk: record.liveRisk,
    reasons: Array.isArray(record.reasons) ? record.reasons.filter((item): item is string => typeof item === "string") : [],
    ...(Array.isArray(record.recommendedModes)
      ? { recommendedModes: record.recommendedModes.filter((item): item is BenchmarkAssistanceMode => typeof item === "string") }
      : {})
  };
}

function addOfficialBucket<T extends string>(
  buckets: Partial<Record<T, BenchmarkOfficialEvaluationBucket>>,
  key: T,
  result: BenchmarkResultRecord,
  official: BenchmarkOfficialEvaluation
): void {
  const existing = buckets[key] ?? {
    cases: 0,
    qualityPasses: 0,
    observedCases: 0,
    observedTokens: 0,
    tokenUnavailableOfficialPasses: 0,
    averageScore: 0,
    kairnMetricEligibleCases: 0
  };
  existing.cases += 1;
  if (result.metadata.qualityGatePassed === true) existing.qualityPasses += 1;
  if (result.observedCodexTokens !== undefined) {
    existing.observedCases += 1;
    existing.observedTokens += result.observedCodexTokens;
  } else if (result.metadata.qualityGatePassed === true) {
    existing.tokenUnavailableOfficialPasses += 1;
  }
  existing.averageScore += result.score;
  if (official.kairnMetricEligible) existing.kairnMetricEligibleCases += 1;
  buckets[key] = existing;
}

function finalizeOfficialBuckets<T extends string>(buckets: Partial<Record<T, BenchmarkOfficialEvaluationBucket>>): void {
  for (const key of Object.keys(buckets) as T[]) {
    const bucket = buckets[key];
    if (!bucket || bucket.cases === 0) continue;
    bucket.averageScore = Number((bucket.averageScore / bucket.cases).toFixed(2));
  }
}

export function compareBenchmarkReports(before: BenchmarkReport, after: BenchmarkReport): BenchmarkComparison {
  const beforeByCase = new Map(before.results.map((result) => [result.caseId, result]));
  const improvedCases: string[] = [];
  const regressedCases: string[] = [];
  const caseBehaviorOutcomes: NonNullable<BenchmarkComparison["caseBehaviorOutcomes"]> = [];

  for (const result of after.results) {
    const previous = beforeByCase.get(result.caseId);
    if (!previous) continue;
    const delta = result.score - previous.score;
    if (delta >= 5) improvedCases.push(result.caseId);
    if (delta <= -5) regressedCases.push(result.caseId);
    const behaviorOutcome = behaviorTargetOutcome({ before: previous, after: result });
    if (behaviorOutcome) caseBehaviorOutcomes.push(behaviorOutcome);
  }
  const tokenDelta = observedTokenDelta(before, after);
  const behaviorTargetSummary = summarizeBehaviorTargets(caseBehaviorOutcomes);

  return {
    before,
    after,
    scoreDelta: Number((after.overallScore - before.overallScore).toFixed(2)),
    ...(tokenDelta ? { observedTokenDelta: tokenDelta } : {}),
    ...(caseBehaviorOutcomes.length > 0 ? { behaviorTargetSummary, caseBehaviorOutcomes } : {}),
    improvedCases,
    regressedCases,
    recommendations: comparisonRecommendations({ before, after, regressedCases, caseBehaviorOutcomes })
  };
}

function observedTokenDelta(before: BenchmarkReport, after: BenchmarkReport): BenchmarkComparison["observedTokenDelta"] {
  const beforeTokens = before.observed?.codexTokens;
  const afterTokens = after.observed?.codexTokens;
  if (beforeTokens === undefined || afterTokens === undefined) return undefined;
  const savedTokens = beforeTokens - afterTokens;
  const baselineQualityGatePassed = reportQualityGatePassed(before);
  const qualityGatePassed = reportQualityGatePassed(after);
  const assistanceStatus = reportAssistanceStatus(after);
  const classification = classifyAssistance({
    assistanceStatus,
    qualityGatePassed,
    savedTokens,
    baselineTokens: beforeTokens,
    baselineQualityGatePassed,
    turnCount: before.results.length
  });
  const negativeEvidenceReason =
    classificationNegativeEvidenceReason({
      classification,
      qualityFailureReason: "Token reduction is invalid because one or more quality gates failed."
    }) ??
    (!qualityGatePassed && savedTokens > 0 ? "Token reduction is invalid because one or more quality gates failed." : undefined);
  return {
    beforeTokens,
    afterTokens,
    savedTokens,
    savingsRate: beforeTokens > 0 ? Number((savedTokens / beforeTokens).toFixed(4)) : 0,
    qualityGatePassed,
    assistanceStatus,
    assistanceEligible: classification.assistanceEligible,
    baselineDifficulty: classification.baselineDifficulty,
    baselineTokenCost: beforeTokens,
    abstentionOutcome: classification.abstentionOutcome,
    missedOpportunity: classification.missedOpportunity,
    overAssist: classification.overAssist,
    harmfulAssist: classification.harmfulAssist,
    assistClassification: classification.assistClassification,
    validSavings: qualityGatePassed && classification.assistanceEligible && savedTokens > 0 ? savedTokens : 0,
    invalidSavings: !qualityGatePassed && savedTokens > 0 ? savedTokens : 0,
    ...(qualityGatePassed && !classification.assistanceEligible && savedTokens > 0 ? { passiveSavings: savedTokens } : {}),
    ...(negativeEvidenceReason ? { negativeEvidenceReason } : {})
  };
}

function reportAssistanceStatus(report: BenchmarkReport): BenchmarkAssistanceStatus {
  if (report.results.some((result) => resultAssistanceStatus(result) === "active")) return "active";
  return report.results.some((result) => resultAssistanceStatus(result) === "passive_suppressed") ? "passive_suppressed" : "none";
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

function behaviorTargetOutcome(input: {
  before: BenchmarkResultRecord;
  after: BenchmarkResultRecord;
}): NonNullable<BenchmarkComparison["caseBehaviorOutcomes"]>[number] | undefined {
  const behavior =
    typeof input.after.metadata.contextBehavior === "string"
      ? input.after.metadata.contextBehavior
      : typeof input.before.metadata.contextBehavior === "string"
        ? input.before.metadata.contextBehavior
        : undefined;
  const beforeTokens = input.before.observedCodexTokens;
  const afterTokens = input.after.observedCodexTokens;
  const savedTokens = beforeTokens !== undefined && afterTokens !== undefined ? beforeTokens - afterTokens : undefined;
  const assistanceStatus = resultAssistanceStatus(input.after);
  const classification = classifyAssistance({
    assistanceStatus,
    qualityGatePassed: input.after.metadata.qualityGatePassed === true,
    savedTokens,
    baselineTokens: beforeTokens,
    baselineQualityGatePassed: input.before.metadata.qualityGatePassed === true,
    turnCount: 1
  });
  return evaluateBehaviorTarget({
    caseId: input.after.caseId,
    behavior: behavior as Parameters<typeof evaluateBehaviorTarget>[0]["behavior"],
    assistanceStatus,
    assistClassification: classification.assistClassification,
    qualityGatePassed: input.after.metadata.qualityGatePassed === true,
    baselineQualityGatePassed: input.before.metadata.qualityGatePassed === true,
    baselineTokens: beforeTokens,
    afterTokens,
    savedTokens
  });
}

function recommendationsFor(input: {
  expectedFiles: string[];
  actualFiles: string[];
  excludedHits: string[];
  missingRequiredTouchedFiles: string[];
  mcpSuccess: boolean;
  mcpReturnedFileCount?: number | undefined;
  mcpReturnedNoiseFileCount?: number | undefined;
  mcpReturnedTestFanoutCount?: number | undefined;
  mcpContextEfficiency?: number | undefined;
  responseTokens: number;
  budget?: number | undefined;
  outcome: BenchmarkResultRecord["taskOutcome"];
  minExpectedHits: number;
  expectedCoverageSatisfied: boolean;
  qnaGroundingPassed: boolean;
  qnaNoRepoChangesPassed: boolean;
  qnaMinSourceMentions: number;
  qnaSourceMentionCount: number;
  qnaUnexpectedRepoChanges: string[];
  scopeViolations: string[];
  testEditViolationFiles: string[];
  extraProductionEditViolationFiles: string[];
  sourceScopeDisciplinePassed: boolean;
}): string[] {
  const recommendations: string[] = [];
  const missed = input.expectedFiles.filter((file) => !input.actualFiles.includes(file));
  if (missed.length > 0 && !input.expectedCoverageSatisfied) {
    recommendations.push(`Expected files missed: ${missed.slice(0, 4).join(", ")}.`);
  }
  if (!input.qnaGroundingPassed) {
    recommendations.push(
      `QnA answer did not mention enough expected source files (${input.qnaSourceMentionCount}/${input.qnaMinSourceMentions}).`
    );
  }
  if (!input.qnaNoRepoChangesPassed) {
    recommendations.push(`QnA task modified repo files: ${input.qnaUnexpectedRepoChanges.slice(0, 4).join(", ")}.`);
  }
  if (!input.sourceScopeDisciplinePassed) {
    const violations = [
      ...input.scopeViolations,
      ...input.testEditViolationFiles.map((file) => `${file}: test edit in production-source-only task`),
      ...input.extraProductionEditViolationFiles.map((file) => `${file}: edit outside required production source scope`)
    ];
    recommendations.push(`Diff scope violations: ${violations.slice(0, 4).join("; ")}.`);
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
  if ((input.mcpReturnedTestFanoutCount ?? 0) > 1) {
    recommendations.push(`MCP returned too many test files (${input.mcpReturnedTestFanoutCount}); tighten focused context before claiming savings.`);
  }
  if ((input.mcpReturnedNoiseFileCount ?? 0) > 0) {
    recommendations.push(`MCP returned noisy files (${input.mcpReturnedNoiseFileCount}); filter docs/examples/generated/devtools from compact responses.`);
  }
  if ((input.mcpReturnedFileCount ?? 0) > 4 && (input.mcpContextEfficiency ?? 1) < 0.5) {
    recommendations.push("MCP returned broad low-efficiency context; stop expanding after high-confidence source hits.");
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
  if (input.outcome !== "pass") {
    recommendations.push("Observed token reductions for this case must be treated as invalid until the quality gate passes.");
  }
  return recommendations;
}

function comparisonRecommendations(input: {
  before: BenchmarkReport;
  after: BenchmarkReport;
  regressedCases: string[];
  caseBehaviorOutcomes?: NonNullable<BenchmarkComparison["caseBehaviorOutcomes"]>;
}): string[] {
  const recommendations: string[] = [];
  if (input.after.overallScore < input.before.overallScore) {
    recommendations.push("Benchmark score regressed; review changed retrieval scoring before shipping.");
  }
  if (input.regressedCases.length > 0) {
    recommendations.push(`Regressed cases: ${input.regressedCases.join(", ")}.`);
  }
  if (input.after.results.some((result) => result.metadata.qualityGatePassed === false)) {
    recommendations.push("After-run has quality-gate failures; any lower observed token usage is negative evidence, not valid savings.");
  }
  for (const outcome of input.caseBehaviorOutcomes ?? []) {
    if (outcome.outcome === "missed") {
      recommendations.push(`${outcome.caseId}: ${outcome.behavior} target missed - ${outcome.reason}`);
    }
  }
  recommendations.push(...input.after.recommendations.slice(0, 5));
  return unique(recommendations);
}

function reportQualityGatePassed(report: BenchmarkReport): boolean {
  const scored = report.results.filter((result) => result.taskOutcome !== "skipped");
  return scored.length > 0 && scored.every((result) => result.metadata.qualityGatePassed === true);
}

function negativeEvidenceReason(input: {
  requestedOutcome: BenchmarkResultRecord["taskOutcome"];
  requiredTouchedSatisfied: boolean;
  expectedCoverageSatisfied: boolean;
  excludedHits: string[];
  mcpSuccess: boolean;
  qnaGroundingPassed: boolean;
  qnaNoRepoChangesPassed: boolean;
  sourceInvariantPassed: boolean;
  sourceScopeDisciplinePassed: boolean;
}): string {
  if (input.requestedOutcome !== "pass") return "verification or requested task outcome did not pass";
  if (!input.requiredTouchedSatisfied) return "required production source files were not touched";
  if (!input.expectedCoverageSatisfied) return "minimum expected source coverage was not met";
  if (input.excludedHits.length > 0) return "excluded/noisy files were surfaced or touched";
  if (!input.mcpSuccess) return "MCP mode did not record an actual Kairn MCP call";
  if (!input.qnaGroundingPassed) return "QnA answer did not cite enough expected source evidence";
  if (!input.qnaNoRepoChangesPassed) return "QnA task modified repository files";
  if (!input.sourceInvariantPassed) return "declared source invariants failed";
  if (!input.sourceScopeDisciplinePassed) return "agent edited outside the allowed source scope";
  return "quality gate failed";
}

function benchmarkCaseRequiresProductionOnly(benchmarkCase: BenchmarkCase): boolean {
  const text = [
    benchmarkCase.task,
    benchmarkCase.query,
    benchmarkCase.agentPrompt,
    ...(benchmarkCase.successCriteria ?? [])
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(test|tests|spec|specs)\s+(?:should|must|are|were)\s+not\s+(?:be\s+)?touched\b/.test(text)) return true;
  if (/\bdo not (?:edit|touch|modify|change)\s+(?:tests?|specs?)\b/.test(text)) return true;
  if (/\bproduction source only\b/.test(text)) return true;
  if (/\bfix (?:the )?production (?:source|header|file|module|code)\b/.test(text) && /\bdo not edit unrelated files\b/.test(text)) return true;
  if (/\bfix\b.{0,80}\bin production (?:source|header|file|module|code)\b/.test(text) && /\bdo not (?:edit|touch|modify|change) unrelated files\b/.test(text)) return true;
  if (/\bproduction (?:source|header|file|module|code)\b/.test(text) && /\bdo not (?:edit|touch|modify|change) unrelated files\b/.test(text)) return true;
  return false;
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
    assistanceMode === "mcp_first_plus_hook_full_prime";
}
