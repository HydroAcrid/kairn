// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type {
  ExperimentAttemptMetrics,
  ExperimentAttemptResult,
  ExperimentCondition,
  ExperimentConditionAggregate,
  ExperimentPairComparison,
  ExperimentPlan,
  ExperimentReport,
  ExperimentStratumAggregate,
  PublicEvidenceV1
} from "../types.js";
import { sha256 } from "../utils/hash.js";

export function aggregateExperimentResults(
  conditions: ExperimentCondition[],
  attempts: ExperimentAttemptResult[]
): ExperimentConditionAggregate[] {
  return conditions.map((condition) => {
    const rows = attempts.filter((item) => item.attempt.condition === condition);
    const valid = rows.filter((item) => item.traceValid && (item.status === "passed" || item.status === "failed"));
    const quality = valid.filter((item) => item.metrics.qualityGatePassed);
    return {
      condition,
      attempts: rows.length,
      validAttempts: valid.length,
      qualityPasses: quality.length,
      qualityPassRate: ratio(quality.length, valid.length),
      requiredSourceFoundRate: ratio(valid.filter((item) => item.metrics.requiredSourceFound).length, valid.length),
      requiredSourceContentRecall: mean(valid.map((item) => item.metrics.requiredSourceContentRecall)),
      medianTotalModelTokens: median(quality.map((item) => item.metrics.totalModelTokens)),
      medianUncachedInputTokens: median(quality.map((item) => item.metrics.uncachedInputTokens)),
      medianCacheCreationInputTokens: median(quality.map((item) => item.metrics.cacheCreationInputTokens)),
      medianCachedInputTokens: median(quality.map((item) => item.metrics.cachedInputTokens)),
      medianOutputTokens: median(quality.map((item) => item.metrics.outputTokens)),
      medianEstimatedToolResultTokens: median(quality.map((item) => item.metrics.estimatedToolResultTokens)),
      medianTokensBeforeRequiredSource: median(
        quality
          .map((item) => item.metrics.modelTokensBeforeFirstRequiredContent)
          .filter((value): value is number => value !== undefined)
      ),
      medianTimeToRequiredSourceMs: median(
        quality
          .map((item) => item.metrics.timeToFirstRequiredContentMs)
          .filter((value): value is number => value !== undefined)
      ),
      medianEstimatedRepositoryContentTokens: median(quality.map((item) => item.metrics.estimatedRepositoryContentTokens)),
      medianEstimatedKairnGuidanceTokens: median(quality.map((item) => item.metrics.estimatedKairnGuidanceTokens)),
      medianEstimatedReasonblocksGuidanceTokens: median(quality.map((item) => item.metrics.estimatedReasonblocksGuidanceTokens)),
      medianEstimatedVerificationTokens: median(quality.map((item) => item.metrics.estimatedVerificationTokens)),
      explicitNoiseFilesOpened: sum(valid.map((item) => item.metrics.explicitNoiseFilesOpened)),
      excludedFilesTouched: sum(valid.map((item) => item.metrics.excludedFilesTouched)),
      extraneousFilesOpened: sum(valid.map((item) => item.metrics.extraneousFilesOpened)),
      estimatedUnnecessaryEmissionTokens: sum(valid.map((item) => item.metrics.estimatedUnnecessaryEmissionTokens)),
      estimatedAvoidableRepeatReadTokens: sum(valid.map((item) => item.metrics.estimatedAvoidableRepeatReadTokens)),
      medianColdIndexingMs: median(
        quality.map((item) => item.metrics.coldIndexingMs).filter((value): value is number => value !== undefined)
      )
    };
  });
}

const COMPARISONS: Array<{ id: string; baseline: ExperimentCondition; treatment: ExperimentCondition }> = [
  { id: "kairn_vs_vanilla", baseline: "vanilla", treatment: "kairn" },
  { id: "reasonblocks_vs_vanilla", baseline: "vanilla", treatment: "reasonblocks" },
  { id: "combined_vs_vanilla", baseline: "vanilla", treatment: "kairn_reasonblocks" },
  { id: "combined_vs_kairn", baseline: "kairn", treatment: "kairn_reasonblocks" },
  { id: "combined_vs_reasonblocks", baseline: "reasonblocks", treatment: "kairn_reasonblocks" }
];

export function buildPairComparisons(attempts: ExperimentAttemptResult[], seed: number): ExperimentPairComparison[] {
  const byBlock = new Map<string, ExperimentAttemptResult[]>();
  for (const attempt of attempts) {
    byBlock.set(attempt.attempt.blockId, [...(byBlock.get(attempt.attempt.blockId) ?? []), attempt]);
  }
  return COMPARISONS.map((comparison) => {
    const scheduled = [...byBlock.values()].filter((rows) =>
      rows.some((row) => row.attempt.condition === comparison.baseline || row.attempt.condition === comparison.treatment)
    );
    const paired = scheduled.flatMap((rows) => {
      const baseline = rows.find((row) => row.attempt.condition === comparison.baseline);
      const treatment = rows.find((row) => row.attempt.condition === comparison.treatment);
      return baseline && treatment ? [{ baseline, treatment }] : [];
    });
    const protocolValid = paired.filter(({ baseline, treatment }) => isProtocolValid(baseline) && isProtocolValid(treatment));
    const eligiblePairs = protocolValid
      .filter(({ baseline, treatment }) => baseline.metrics.qualityGatePassed && treatment.metrics.qualityGatePassed);
    const eligible = eligiblePairs
      .map(({ baseline, treatment }) => {
        const delta = treatment.metrics.totalModelTokens - baseline.metrics.totalModelTokens;
        const reduction = baseline.metrics.totalModelTokens > 0
          ? ((baseline.metrics.totalModelTokens - treatment.metrics.totalModelTokens) / baseline.metrics.totalModelTokens) * 100
          : 0;
        return { taskId: baseline.task.id, delta, reduction };
      });
    const deltas = eligible.map((item) => item.delta);
    return {
      ...comparison,
      scheduledBlocks: scheduled.length,
      protocolValidPairs: protocolValid.length,
      qualityEligiblePairs: eligible.length,
      qualityIneligiblePairs: Math.max(0, protocolValid.length - eligible.length),
      medianSignedTotalTokenDelta: median(deltas),
      medianTokenReductionPercent: round(medianNumber(eligible.map((item) => item.reduction)), 2),
      signedTotalTokenDeltaCi95: clusteredMedianConfidenceInterval(eligible, seed + stableSeed(comparison.id)),
      improvements: deltas.filter((value) => value < 0).length,
      regressions: deltas.filter((value) => value > 0).length,
      ties: deltas.filter((value) => value === 0).length,
      metricEffects: {
        totalModelTokens: pairedMetricEffect(eligiblePairs, (metrics) => metrics.totalModelTokens),
        modelTokensBeforeFirstRequiredPathHint: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.modelTokensBeforeFirstRequiredPathHint
        ),
        timeToFirstRequiredPathHintMs: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.timeToFirstRequiredPathHintMs
        ),
        modelTokensBeforeFirstRequiredContent: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.modelTokensBeforeFirstRequiredContent
        ),
        timeToFirstRequiredContentMs: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.timeToFirstRequiredContentMs
        ),
        explicitNoiseFilesOpened: pairedMetricEffect(eligiblePairs, (metrics) => metrics.explicitNoiseFilesOpened),
        explicitNoiseReadEvents: pairedMetricEffect(eligiblePairs, (metrics) => metrics.explicitNoiseReadEvents),
        extraneousFilesOpened: pairedMetricEffect(eligiblePairs, (metrics) => metrics.extraneousFilesOpened),
        requiredSourceContentRecall: pairedMetricEffect(eligiblePairs, (metrics) => metrics.requiredSourceContentRecall),
        requiredSourceToolReadRecall: pairedMetricEffect(eligiblePairs, (metrics) => metrics.requiredSourceToolReadRecall),
        estimatedToolResultTokens: pairedMetricEffect(eligiblePairs, (metrics) => metrics.estimatedToolResultTokens),
        estimatedRepositoryContentTokens: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.estimatedRepositoryContentTokens
        ),
        estimatedProviderInjectionTokens: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.estimatedProviderInjectionTokens
        ),
        estimatedKairnGuidanceTokens: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.estimatedKairnGuidanceTokens
        ),
        estimatedReasonblocksGuidanceTokens: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.estimatedReasonblocksGuidanceTokens
        ),
        estimatedUnnecessaryEmissionTokens: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.estimatedUnnecessaryEmissionTokens
        ),
        crossTurnRepeatReadEvents: pairedMetricEffect(eligiblePairs, (metrics) => metrics.crossTurnRepeatReadEvents),
        avoidableCrossTurnRepeatReadEvents: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.avoidableCrossTurnRepeatReadEvents
        ),
        estimatedAvoidableRepeatReadTokens: pairedMetricEffect(
          eligiblePairs,
          (metrics) => metrics.estimatedAvoidableRepeatReadTokens
        )
      }
    };
  });
}

export function buildStrataAggregates(
  attempts: ExperimentAttemptResult[],
  conditions: ExperimentCondition[],
  seed: number
): ExperimentStratumAggregate[] {
  const keys = new Map<string, { language: ExperimentAttemptResult["task"]["language"]; taskClass: ExperimentAttemptResult["task"]["taskClass"] }>();
  for (const attempt of attempts) {
    keys.set(`${attempt.task.language}:${attempt.task.taskClass}`, {
      language: attempt.task.language,
      taskClass: attempt.task.taskClass
    });
  }
  return [...keys.values()]
    .sort((left, right) => left.language.localeCompare(right.language) || left.taskClass.localeCompare(right.taskClass))
    .map((key, index) => {
      const rows = attempts.filter((attempt) => attempt.task.language === key.language && attempt.task.taskClass === key.taskClass);
      return {
        ...key,
        attempts: rows.length,
        aggregates: aggregateExperimentResults(conditions, rows),
        comparisons: buildPairComparisons(rows, seed + index + 1)
      };
    });
}

export function buildPublicEvidence(input: {
  report: Omit<ExperimentReport, "outputs">;
  plan: ExperimentPlan;
  kairnPackageVersion: string;
  harnessHash: string;
  toolSchemaHash: string;
  kairnCommit?: string | undefined;
  rankerModelId?: string | undefined;
  rankerModelHash?: string | undefined;
  anthropicVersion?: string | undefined;
  reasonblocksVersion?: string | undefined;
  reasonblocksServiceVersion?: string | undefined;
  reasonblocksServiceVersionSource?: "operator_asserted" | undefined;
  pythonVersion?: string | undefined;
  artifactUrl?: string | undefined;
}): PublicEvidenceV1 {
  const executionEnvironment = input.report.executionEnvironment;
  const executionEnvironmentComplete = Boolean(
    executionEnvironment?.verified &&
    /^[a-f0-9]{64}$/i.test(executionEnvironment.hash) &&
    input.plan.tasks.every((task) => executionEnvironment.dockerImages.some((image) => image.requestedImage === task.sandboxImage))
  );
  const complete = input.report.protocolComplete &&
    Boolean(input.artifactUrl) &&
    executionEnvironmentComplete &&
    input.report.attempts.length === input.report.expectedAttemptCount &&
    input.report.attempts.every((item) =>
      item.traceValid &&
      (item.status === "passed" || item.status === "failed") &&
      typeof item.traceDigest === "string" &&
      /^[a-f0-9]{64}$/i.test(item.traceDigest) &&
      typeof item.workspaceTreeDigest === "string" &&
      /^[a-f0-9]{64}$/i.test(item.workspaceTreeDigest) &&
      item.executionEnvironmentHash === executionEnvironment?.hash
    );
  const partial = input.report.attempts.some((item) => item.status !== "planned");
  const repeats = input.plan.tasks.length > 0
    ? Math.round(input.report.expectedAttemptCount / (input.plan.tasks.length * input.report.conditions.length))
    : 0;
  const withoutChecksum: Omit<PublicEvidenceV1, "checksum"> = {
    schemaVersion: "public-evidence.v1",
    campaign: {
      id: input.report.id,
      generatedAt: input.report.generatedAt,
      planHash: input.report.planHash,
      seed: input.report.seed,
      model: input.report.model,
      conditions: input.report.conditions,
      repeats,
      taskCount: input.plan.tasks.length,
      expectedAttemptCount: input.report.expectedAttemptCount,
      languages: [...new Set(input.plan.tasks.map((task) => task.language))].sort(),
      taskClasses: [...new Set(input.plan.tasks.map((task) => task.taskClass))].sort(),
      status: complete ? "complete" : partial ? "partial" : "methodology_only"
    },
    provenance: {
      ...(input.kairnCommit ? { kairnCommit: input.kairnCommit } : {}),
      kairnPackageVersion: input.kairnPackageVersion,
      harnessHash: input.harnessHash,
      toolSchemaHash: input.toolSchemaHash,
      ...(input.rankerModelId ? { rankerModelId: input.rankerModelId } : {}),
      ...(input.rankerModelHash ? { rankerModelHash: input.rankerModelHash } : {}),
      taskManifestHash: taskManifestHash(input.plan),
      ...(input.anthropicVersion ? { anthropicVersion: input.anthropicVersion } : {}),
      ...(input.reasonblocksVersion ? { reasonblocksVersion: input.reasonblocksVersion } : {}),
      ...(input.reasonblocksServiceVersion ? { reasonblocksServiceVersion: input.reasonblocksServiceVersion } : {}),
      ...(input.reasonblocksServiceVersionSource
        ? { reasonblocksServiceVersionSource: input.reasonblocksServiceVersionSource }
        : {}),
      ...(input.pythonVersion ? { pythonVersion: input.pythonVersion } : {}),
      ...(executionEnvironment
        ? {
            executionEnvironmentHash: executionEnvironment.hash,
            hostRuntime: executionEnvironment.hostRuntime
          }
        : {}),
      externalTrajectoryAllowed: input.report.externalTrajectoryAllowed
    },
    arms: input.report.conditions.map((condition) => ({
      condition,
      kairn: condition === "kairn" || condition === "kairn_reasonblocks",
      reasonblocks: condition === "reasonblocks" || condition === "kairn_reasonblocks",
      guidanceOrder: condition === "kairn_reasonblocks"
        ? ["kairn", "reasonblocks"]
        : condition === "kairn"
          ? ["kairn"]
          : condition === "reasonblocks"
            ? ["reasonblocks"]
            : []
    })),
    repositories: input.plan.tasks.map((task) => {
      const image = executionEnvironment?.dockerImages.find((item) => item.requestedImage === task.sandboxImage);
      return {
        taskId: task.id,
        repoUrl: task.repoUrl,
        commit: input.report.attempts.find((attempt) => attempt.task.id === task.id && attempt.resolvedRepoCommit)?.resolvedRepoCommit ?? task.ref,
        ...(task.sandboxImage ? { sandboxImage: task.sandboxImage } : {}),
        ...(image
          ? {
              sandboxImageId: image.id,
              sandboxRepoDigests: image.repoDigests,
              sandboxOs: image.os,
              sandboxArchitecture: image.architecture
            }
          : {}),
        language: task.language,
        taskClass: task.taskClass
      };
    }),
    definitions: {
      qualityGatePassed: "External verification, required-source, required-touch, exclusion, and trace-integrity gates passed.",
      requiredTouchedPassed: "Every preregistered required-touched file was changed by the attempt.",
      sourceInvariantPassed: "Every preregistered production-source invariant passed after the attempt.",
      diffScopePassed: "Every changed line stayed within the preregistered diff scope.",
      totalModelTokens: "Observed uncached input plus cached input plus output tokens reported by the model provider.",
      cacheCreationInputTokens: "Provider-reported cache-write input tokens; included in uncached input and reported separately.",
      modelTokensBeforeFirstRequiredPathHint: "Observed model tokens consumed after assistance starts and before a required production path first reaches the agent.",
      modelTokensBeforeFirstRequiredContent: "Observed model tokens consumed before required production-source content first reached the agent.",
      requiredSourceContentRecall: "Share of preregistered required production files whose content reached the agent.",
      requiredSourceToolReadRecall: "Share of preregistered required production files explicitly opened with read_file; search excerpts do not count.",
      explicitNoiseFilesOpened: "Unique content-bearing reads matching preregistered noise patterns.",
      excludedFilesTouched: "Unique changed files matching preregistered exclusion patterns.",
      estimatedProviderInjectionTokens: "UTF-8 character length divided by four for Kairn/ReasonBlocks rendered guidance; not provider billing usage.",
      estimatedToolResultTokens: "UTF-8 character length divided by four for every instrumented tool result delivered to the model; not provider billing usage.",
      estimatedRepositoryContentTokens: "UTF-8 character length divided by four for repository tool content; not provider billing usage.",
      estimatedUnnecessaryEmissionTokens: "Estimated rendered guidance tokens emitted on a preregistered abstention task or turn.",
      estimatedAvoidableRepeatReadTokens: "Estimated tokens from unchanged cross-turn rereads without an intervening edit, failure, or failed verification.",
      resourceMetrics: "Host-process and direct-child CPU/RSS only. Docker daemon and container workload remain outside these counters and cannot support whole-system resource claims.",
      reasonblocksServiceVersion: "A preregistered operator-supplied label for the hosted ReasonBlocks service; the SDK does not expose a server build identifier, so this is not independently observed.",
      coldIndexingMs: "Kairn's reported first-call local index refresh time inside the cold response; absent for arms without Kairn.",
      providerSetupMs: "Host-measured provider construction plus initial open/prime latency, reported separately for Kairn and ReasonBlocks.",
      workspaceTreeDigest: "SHA-256 over Git-tracked and unignored workspace paths, file kinds, executable bits, symlink targets, and bytes after setup and the preregistered initial failure; every four-arm task/repeat block must match.",
      medianSignedTotalTokenDelta: "Median paired treatment-minus-baseline observed model-token delta over pass/pass quality pairs; negative means fewer treatment tokens.",
      signedTotalTokenDeltaCi95: "Deterministic task-cluster bootstrap 95% interval for the paired median signed total-token delta.",
      metricEffects: "Metric-specific paired treatment-minus-baseline medians over pass/pass quality pairs. Each metric reports its own pair count; a negative delta means less in the treatment arm, except recall where a positive delta means better coverage.",
      qualityFailures: "Machine-readable reasons an attempt failed a measured quality requirement; invalid trace reasons and infrastructure errors are reported separately."
    },
    attempts: input.report.attempts.map((item) => ({
      id: item.attempt.id,
      taskId: item.task.id,
      condition: item.attempt.condition,
      language: item.task.language,
      taskClass: item.task.taskClass,
      repeat: item.attempt.repeat,
      blockId: item.attempt.blockId,
      order: item.attempt.order,
      status: item.status,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      traceValid: item.traceValid,
      ...(item.executionId ? { executionId: item.executionId } : {}),
      ...(item.executionEnvironmentHash ? { executionEnvironmentHash: item.executionEnvironmentHash } : {}),
      ...(item.workspaceTreeDigest ? { workspaceTreeDigest: item.workspaceTreeDigest } : {}),
      ...(item.traceDigest ? { traceDigest: item.traceDigest } : {}),
      invalidReasons: item.invalidReasons,
      qualityFailures: qualityFailureReasons(item),
      ...(item.resolvedRepoCommit ? { resolvedRepoCommit: item.resolvedRepoCommit } : {}),
      ...(item.error ? { error: `${item.status}_error` } : {}),
      metrics: item.metrics
    })),
    aggregates: input.report.aggregates,
    strata: input.report.strata,
    comparisons: input.report.comparisons,
    exclusions: input.report.attempts
      .map((item) => ({ item, reasons: publicEvidenceExclusionReasons(item) }))
      .filter(({ reasons }) => reasons.length > 0)
      .map(({ item, reasons }) => ({ attemptId: item.attempt.id, reasons })),
    ...(input.artifactUrl ? { artifactUrl: input.artifactUrl } : {})
  };
  return { ...withoutChecksum, checksum: sha256(canonicalJson(withoutChecksum)) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function writeExperimentOutputs(input: {
  outDir: string;
  report: Omit<ExperimentReport, "outputs">;
  plan: ExperimentPlan;
  manifest: Record<string, unknown>;
  kairnPackageVersion: string;
  harnessHash: string;
  toolSchemaHash: string;
  kairnCommit?: string | undefined;
  rankerModelId?: string | undefined;
  rankerModelHash?: string | undefined;
  anthropicVersion?: string | undefined;
  reasonblocksVersion?: string | undefined;
  reasonblocksServiceVersion?: string | undefined;
  reasonblocksServiceVersionSource?: "operator_asserted" | undefined;
  pythonVersion?: string | undefined;
  artifactUrl?: string | undefined;
}): ExperimentReport {
  fs.mkdirSync(input.outDir, { recursive: true });
  const manifestPath = path.join(input.outDir, "manifest.json");
  const attemptsPath = path.join(input.outDir, "attempts.jsonl");
  const resultsCsvPath = path.join(input.outDir, "results.csv");
  const failuresCsvPath = path.join(input.outDir, "failures.csv");
  const aggregatePath = path.join(input.outDir, "aggregate.json");
  const markdownPath = path.join(input.outDir, "report.md");
  const publicEvidencePath = path.join(input.outDir, "public-evidence.v1.json");
  const evidence = buildPublicEvidence({
    report: input.report,
    plan: input.plan,
    kairnPackageVersion: input.kairnPackageVersion,
    harnessHash: input.harnessHash,
    toolSchemaHash: input.toolSchemaHash,
    ...(input.kairnCommit ? { kairnCommit: input.kairnCommit } : {}),
    ...(input.rankerModelId ? { rankerModelId: input.rankerModelId } : {}),
    ...(input.rankerModelHash ? { rankerModelHash: input.rankerModelHash } : {}),
    ...(input.anthropicVersion ? { anthropicVersion: input.anthropicVersion } : {}),
    ...(input.reasonblocksVersion ? { reasonblocksVersion: input.reasonblocksVersion } : {}),
    ...(input.reasonblocksServiceVersion ? { reasonblocksServiceVersion: input.reasonblocksServiceVersion } : {}),
    ...(input.reasonblocksServiceVersionSource
      ? { reasonblocksServiceVersionSource: input.reasonblocksServiceVersionSource }
      : {}),
    ...(input.pythonVersion ? { pythonVersion: input.pythonVersion } : {}),
    ...(input.artifactUrl ? { artifactUrl: input.artifactUrl } : {})
  });

  writeJson(manifestPath, input.manifest);
  fs.writeFileSync(attemptsPath, input.report.attempts.map((item) => JSON.stringify(item)).join("\n") + (input.report.attempts.length ? "\n" : ""));
  fs.writeFileSync(resultsCsvPath, resultsCsv(input.report.attempts));
  fs.writeFileSync(failuresCsvPath, failuresCsv(input.report.attempts));
  writeJson(aggregatePath, {
    conditions: input.report.aggregates,
    strata: input.report.strata,
    comparisons: input.report.comparisons
  });
  fs.writeFileSync(markdownPath, experimentMarkdown(input.report));
  writeJson(publicEvidencePath, evidence);

  return {
    ...input.report,
    outputs: {
      manifestPath,
      attemptsPath,
      resultsCsvPath,
      failuresCsvPath,
      aggregatePath,
      markdownPath,
      publicEvidencePath
    }
  };
}

export function emptyAttemptMetrics(): ExperimentAttemptMetrics {
  return {
    requiredSourceFound: false,
    requiredSourceMissRate: 1,
    modelCallsBeforeFirstRequiredContent: 0,
    searchCallsBeforeFirstRequiredContent: 0,
    totalModelTokens: 0,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    estimatedToolResultTokens: 0,
    estimatedRepositoryContentTokens: 0,
    estimatedProviderInjectionTokens: 0,
    estimatedKairnGuidanceTokens: 0,
    estimatedReasonblocksGuidanceTokens: 0,
    estimatedVerificationTokens: 0,
    requiredSourceContentRecall: 0,
    requiredSourceToolReadRecall: 0,
    explicitNoiseFilesOpened: 0,
    excludedFilesTouched: 0,
    extraneousFilesOpened: 0,
    explicitNoiseReadEvents: 0,
    estimatedUnnecessaryEmissionTokens: 0,
    emissionRate: 0,
    suppressionRate: 0,
    crossTurnRepeatReadEvents: 0,
    avoidableCrossTurnRepeatReadEvents: 0,
    estimatedAvoidableRepeatReadTokens: 0,
    finalVerifierPassed: false,
    requiredTouchedPassed: false,
    sourceInvariantPassed: false,
    diffScopePassed: false,
    qualityGatePassed: false
  };
}

function experimentMarkdown(report: Omit<ExperimentReport, "outputs">): string {
  const lines = [
    `# ${report.name}`,
    "",
    `Campaign: \`${report.id}\`  `,
    `Generated: ${report.generatedAt}  `,
    `Model: \`${report.model}\`  `,
    `Seed: \`${report.seed}\``,
    "",
    "Token reductions below are medians over trace-valid, quality-passing attempts only.",
    "",
    "| Condition | Valid | Quality | Required source found | Median tokens | Tokens before source | Time before source |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.aggregates.map((item) =>
      `| ${item.condition} | ${item.validAttempts}/${item.attempts} | ${percent(item.qualityPassRate)} | ${percent(item.requiredSourceFoundRate)} | ${item.medianTotalModelTokens} | ${item.medianTokensBeforeRequiredSource} | ${item.medianTimeToRequiredSourceMs} ms |`
    ),
    "",
    "## Protocol integrity",
    "",
    `- Trace-valid attempts: ${report.attempts.filter((item) => item.traceValid).length}/${report.attempts.length}`,
    `- Infrastructure failures: ${report.attempts.filter((item) => item.status === "infrastructure_failure").length}`,
    `- Invalid attempts: ${report.attempts.filter((item) => item.status === "invalid").length}`,
    `- External trajectory consent: ${report.externalTrajectoryAllowed ? "enabled for public repositories" : "disabled"}`,
    "",
    "Reports preserve misses and signed token regressions. No result is a token win unless both quality gates pass."
  ];
  if (report.comparisons.length > 0) {
    lines.push(
      "",
      "## Paired token comparisons",
      "",
      "Signed deltas are treatment minus baseline; negative values mean the treatment used fewer observed model tokens.",
      "",
      "| Comparison | Eligible pass/pass pairs | Median signed delta | Median reduction | 95% CI | Regressions |",
      "|---|---:|---:|---:|---:|---:|",
      ...report.comparisons.map((item) =>
        `| ${item.id} | ${item.qualityEligiblePairs}/${item.scheduledBlocks} | ${item.medianSignedTotalTokenDelta} | ${item.medianTokenReductionPercent.toFixed(2)}% | ${formatInterval(item.signedTotalTokenDeltaCi95)} | ${item.regressions} |`
      ),
      "",
      "## Paired evidence effects",
      "",
      "Every row uses only pass/pass quality pairs. Counts are metric-specific because a source-timing metric is absent when that evidence was never delivered.",
      "",
      "| Comparison | Metric | Pairs | Median signed delta |",
      "|---|---|---:|---:|",
      ...report.comparisons.flatMap((comparison) =>
        Object.entries(comparison.metricEffects).map(([metric, effect]) =>
          `| ${comparison.id} | ${metric} | ${effect.pairCount} | ${effect.medianSignedDelta} |`
        )
      )
    );
  }
  return `${lines.join("\n")}\n`;
}

function resultsCsv(rows: ExperimentAttemptResult[]): string {
  const columns: Array<[string, (item: ExperimentAttemptResult) => unknown]> = [
    ["attempt_id", (item) => item.attempt.id],
    ["campaign_id", (item) => item.attempt.campaignId],
    ["task_id", (item) => item.task.id],
    ["condition", (item) => item.attempt.condition],
    ["language", (item) => item.task.language],
    ["task_class", (item) => item.task.taskClass],
    ["repeat", (item) => item.attempt.repeat],
    ["block_id", (item) => item.attempt.blockId],
    ["order", (item) => item.attempt.order],
    ["run_id", (item) => item.runId],
    ["execution_id", (item) => item.executionId ?? ""],
    ["execution_environment_hash", (item) => item.executionEnvironmentHash ?? ""],
    ["workspace_tree_digest", (item) => item.workspaceTreeDigest ?? ""],
    ["resolved_repo_commit", (item) => item.resolvedRepoCommit ?? ""],
    ["status", (item) => item.status],
    ["trace_valid", (item) => item.traceValid],
    ["invalid_reasons", (item) => item.invalidReasons.join("; ")],
    ["quality_failure_reasons", (item) => qualityFailureReasons(item).join("; ")],
    ["error", (item) => item.error ?? ""],
    ["started_at", (item) => item.startedAt],
    ["ended_at", (item) => item.endedAt],
    ["workspace_setup_ms", (item) => item.workspaceSetupMs],
    ["provider_setup_ms", (item) => item.providerSetupMs],
    ["kairn_setup_ms", (item) => item.kairnSetupMs ?? ""],
    ["reasonblocks_setup_ms", (item) => item.reasonblocksSetupMs ?? ""],
    ["online_ms", (item) => item.onlineMs],
    ["total_ms", (item) => item.totalMs],
    ["trace_path", (item) => item.tracePath ?? ""],
    ["trace_digest", (item) => item.traceDigest ?? ""],
    ["required_source_found", (item) => item.metrics.requiredSourceFound],
    ["required_source_miss_rate", (item) => item.metrics.requiredSourceMissRate],
    ["time_to_first_required_path_hint_ms", (item) => item.metrics.timeToFirstRequiredPathHintMs ?? ""],
    ["time_to_first_required_content_ms", (item) => item.metrics.timeToFirstRequiredContentMs ?? ""],
    ["model_tokens_before_first_required_path_hint", (item) => item.metrics.modelTokensBeforeFirstRequiredPathHint ?? ""],
    ["model_tokens_before_first_required_content", (item) => item.metrics.modelTokensBeforeFirstRequiredContent ?? ""],
    ["model_calls_before_first_required_content", (item) => item.metrics.modelCallsBeforeFirstRequiredContent],
    ["search_calls_before_first_required_content", (item) => item.metrics.searchCallsBeforeFirstRequiredContent],
    ["estimated_first_evidence_payload_tokens", (item) => item.metrics.estimatedFirstEvidencePayloadTokens ?? ""],
    ["total_model_tokens", (item) => item.metrics.totalModelTokens],
    ["uncached_input_tokens", (item) => item.metrics.uncachedInputTokens],
    ["cache_creation_input_tokens", (item) => item.metrics.cacheCreationInputTokens],
    ["cached_input_tokens", (item) => item.metrics.cachedInputTokens],
    ["output_tokens", (item) => item.metrics.outputTokens],
    ["estimated_tool_result_tokens", (item) => item.metrics.estimatedToolResultTokens],
    ["estimated_repository_content_tokens", (item) => item.metrics.estimatedRepositoryContentTokens],
    ["estimated_provider_injection_tokens", (item) => item.metrics.estimatedProviderInjectionTokens],
    ["estimated_kairn_guidance_tokens", (item) => item.metrics.estimatedKairnGuidanceTokens],
    ["estimated_reasonblocks_guidance_tokens", (item) => item.metrics.estimatedReasonblocksGuidanceTokens],
    ["estimated_verification_tokens", (item) => item.metrics.estimatedVerificationTokens],
    ["required_source_content_recall", (item) => item.metrics.requiredSourceContentRecall],
    ["required_source_tool_read_recall", (item) => item.metrics.requiredSourceToolReadRecall],
    ["explicit_noise_files_opened", (item) => item.metrics.explicitNoiseFilesOpened],
    ["excluded_files_touched", (item) => item.metrics.excludedFilesTouched],
    ["extraneous_files_opened", (item) => item.metrics.extraneousFilesOpened],
    ["explicit_noise_read_events", (item) => item.metrics.explicitNoiseReadEvents],
    ["estimated_unnecessary_emission_tokens", (item) => item.metrics.estimatedUnnecessaryEmissionTokens],
    ["emission_rate", (item) => item.metrics.emissionRate],
    ["suppression_rate", (item) => item.metrics.suppressionRate],
    ["cross_turn_repeat_read_events", (item) => item.metrics.crossTurnRepeatReadEvents],
    ["avoidable_cross_turn_repeat_read_events", (item) => item.metrics.avoidableCrossTurnRepeatReadEvents],
    ["estimated_avoidable_repeat_read_tokens", (item) => item.metrics.estimatedAvoidableRepeatReadTokens],
    ["cold_indexing_ms", (item) => item.metrics.coldIndexingMs ?? ""],
    ["cold_kairn_response_ms", (item) => item.metrics.coldKairnResponseMs ?? ""],
    ["median_warm_kairn_response_ms", (item) => item.metrics.medianWarmKairnResponseMs ?? ""],
    ["kairn_state_bytes", (item) => item.metrics.kairnStateBytes ?? ""],
    ["host_cpu_ms", (item) => item.metrics.hostCpuMs ?? ""],
    ["host_peak_rss_bytes", (item) => item.metrics.hostPeakRssBytes ?? ""],
    ["direct_child_cpu_ms", (item) => item.metrics.directChildCpuMs ?? ""],
    ["direct_child_peak_rss_bytes", (item) => item.metrics.directChildPeakRssBytes ?? ""],
    ["final_verifier_passed", (item) => item.metrics.finalVerifierPassed],
    ["required_touched_passed", (item) => item.metrics.requiredTouchedPassed],
    ["source_invariant_passed", (item) => item.metrics.sourceInvariantPassed],
    ["diff_scope_passed", (item) => item.metrics.diffScopePassed],
    ["quality_gate_passed", (item) => item.metrics.qualityGatePassed]
  ];
  const header = columns.map(([name]) => name);
  const body = rows.map((item) => columns.map(([, value]) => value(item)));
  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function failuresCsv(rows: ExperimentAttemptResult[]): string {
  const header = ["attempt_id", "task_id", "condition", "status", "trace_valid", "invalid_reasons", "quality_failure_reasons", "error"];
  const body = rows
    .filter((item) => exclusionReasons(item).length > 0)
    .map((item) => [
      item.attempt.id,
      item.task.id,
      item.attempt.condition,
      item.status,
      item.traceValid,
      item.invalidReasons.join("; "),
      qualityFailureReasons(item).join("; "),
      item.error ?? ""
    ]);
  return [header, ...body].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function writeJson(target: string, value: unknown): void {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

export function canonicalTaskManifest(plan: ExperimentPlan): unknown[] {
  return plan.tasks.map((task) => ({
    id: task.id,
    repoUrl: task.repoUrl,
    ref: task.ref,
    language: task.language,
    taskClass: task.taskClass,
    promptHash: sha256(task.prompt),
    turns: task.turns?.map((turn) => ({
      id: turn.id,
      promptHash: sha256(turn.prompt),
      assistanceExpectation: turn.assistanceExpectation ?? "optional"
    })) ?? [],
    requiredSourceFiles: task.requiredSourceFiles,
    allowedSupportFiles: task.allowedSupportFiles ?? [],
    explicitNoisePatterns: task.explicitNoisePatterns ?? [],
    requiredTouchedFiles: task.requiredTouchedFiles ?? [],
    sourceInvariants: task.sourceInvariants ?? [],
    allowedDiffScopes: task.allowedDiffScopes ?? [],
    assistanceExpectation: task.assistanceExpectation ?? "optional",
    setupCommandHashes: (task.setupCommands ?? []).map(sha256),
    setupPatchHash: task.setupPatch
      ? sha256(task.setupPatch)
      : task.setupPatchFile && fs.existsSync(task.setupPatchFile)
        ? sha256(fs.readFileSync(task.setupPatchFile))
        : null,
    sandboxImage: task.sandboxImage ?? null,
    initialFailureCommandHash: task.initialFailureCommand ? sha256(task.initialFailureCommand) : null,
    verificationCommandHash: sha256(task.verificationCommand)
  }));
}

export function taskManifestHash(plan: ExperimentPlan): string {
  return sha256(JSON.stringify(canonicalTaskManifest(plan)));
}

function isProtocolValid(attempt: ExperimentAttemptResult): boolean {
  return attempt.traceValid && (attempt.status === "passed" || attempt.status === "failed");
}

function qualityFailureReasons(attempt: ExperimentAttemptResult): string[] {
  if (!isProtocolValid(attempt)) return [];
  const reasons: string[] = [];
  if (!attempt.metrics.finalVerifierPassed) reasons.push("final_verification_failed");
  if (!attempt.metrics.requiredTouchedPassed) reasons.push("required_touch_failed");
  if (!attempt.metrics.sourceInvariantPassed) reasons.push("source_invariant_failed");
  if (!attempt.metrics.diffScopePassed) reasons.push("diff_scope_failed");
  if (!attempt.metrics.requiredSourceFound) reasons.push("required_source_incomplete");
  if (attempt.metrics.excludedFilesTouched > 0) reasons.push("excluded_file_touched");
  if (!attempt.metrics.qualityGatePassed) reasons.push("external_quality_gate_failed");
  if (attempt.status === "failed") reasons.push("attempt_status_failed");
  return uniqueStrings(reasons);
}

function exclusionReasons(attempt: ExperimentAttemptResult): string[] {
  const reasons = [
    ...attempt.invalidReasons,
    ...qualityFailureReasons(attempt),
    ...(attempt.status === "invalid" ? ["invalid_attempt"] : []),
    ...(attempt.status === "infrastructure_failure" ? ["infrastructure_failure"] : []),
    ...(attempt.error ? [`error: ${attempt.error}`] : [])
  ];
  return uniqueStrings(reasons);
}

function publicEvidenceExclusionReasons(attempt: ExperimentAttemptResult): string[] {
  return exclusionReasons(attempt).map((reason) => reason.startsWith("error: ") ? "attempt_error" : reason);
}

function pairedMetricEffect(
  pairs: Array<{ baseline: ExperimentAttemptResult; treatment: ExperimentAttemptResult }>,
  value: (metrics: ExperimentAttemptMetrics) => number | undefined
): { pairCount: number; medianSignedDelta: number } {
  const deltas = pairs.flatMap(({ baseline, treatment }) => {
    const baselineValue = value(baseline.metrics);
    const treatmentValue = value(treatment.metrics);
    return baselineValue !== undefined && treatmentValue !== undefined &&
      Number.isFinite(baselineValue) && Number.isFinite(treatmentValue)
      ? [treatmentValue - baselineValue]
      : [];
  });
  return {
    pairCount: deltas.length,
    medianSignedDelta: round(medianNumber(deltas), 4)
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function clusteredMedianConfidenceInterval(
  rows: Array<{ taskId: string; delta: number }>,
  seed: number
): { lower: number; upper: number } | null {
  if (rows.length === 0) return null;
  const clusters = new Map<string, number[]>();
  for (const row of rows) clusters.set(row.taskId, [...(clusters.get(row.taskId) ?? []), row.delta]);
  const groups = [...clusters.values()];
  if (groups.length === 1) {
    const value = median(groups[0] ?? []);
    return { lower: value, upper: value };
  }
  let state = (seed >>> 0) || 1;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const estimates: number[] = [];
  for (let iteration = 0; iteration < 4000; iteration += 1) {
    const sample: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      sample.push(...(groups[Math.floor(random() * groups.length)] ?? []));
    }
    estimates.push(median(sample));
  }
  estimates.sort((left, right) => left - right);
  return {
    lower: estimates[Math.floor(estimates.length * 0.025)] ?? estimates[0] ?? 0,
    upper: estimates[Math.min(estimates.length - 1, Math.floor(estimates.length * 0.975))] ?? estimates.at(-1) ?? 0
  };
}

function stableSeed(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function formatInterval(value: { lower: number; upper: number } | null): string {
  return value ? `[${value.lower}, ${value.upper}]` : "n/a";
}

function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : Number((value / total).toFixed(4));
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : Number((sum(values) / values.length).toFixed(4));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const left = sorted[middle - 1] ?? sorted[middle] ?? 0;
  const right = sorted[middle] ?? left;
  return sorted.length % 2 === 0 ? Math.round((left + right) / 2) : right;
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const left = sorted[middle - 1] ?? sorted[middle] ?? 0;
  const right = sorted[middle] ?? left;
  return sorted.length % 2 === 0 ? (left + right) / 2 : right;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
