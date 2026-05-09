import type {
  BenchmarkComparison,
  BenchmarkEnduranceReport,
  BenchmarkMatrixReport,
  BenchmarkProofReport,
  BenchmarkReport,
  ContextPrime,
  EvalComparison,
  EvalRunReport,
  MetricsSummary,
  WatchSnapshot
} from "../types.js";
import { printJson } from "./output.js";

export function printContextPrime(prime: ContextPrime): void {
  process.stdout.write(`${prime.content}\n`);
  if (prime.warnings.length > 0) {
    process.stdout.write(`\n## Warnings\n${prime.warnings.map((warning) => `- ${warning}`).join("\n")}\n`);
  }
}

export function printWatchSnapshot(snapshot: WatchSnapshot, json: boolean): void {
  if (json) {
    printJson(snapshot);
    return;
  }

  process.stdout.write(
    [
      "Kairn watch snapshot.",
      `Session: ${snapshot.sessionId}`,
      `Indexed files: ${snapshot.indexedFiles}`,
      `Changed files: ${snapshot.changedFiles.length}`,
      snapshot.changedFiles.length > 0 ? snapshot.changedFiles.map((file) => `- ${file}`).join("\n") : "No git diff detected.",
      snapshot.recommendations.length > 0
        ? ["", "Recommendations", ...snapshot.recommendations.map((item) => `- ${item.summary}`)].join("\n")
        : "",
      ""
    ].filter(Boolean).join("\n")
  );
}

export function printMetrics(metrics: MetricsSummary): void {
  const lines = [
    "Kairn metrics.",
    `Session: ${metrics.sessionId}`,
    `Events measured: ${metrics.totals.events}`,
    `Estimated baseline tokens: ${metrics.totals.baselineTokens}`,
    `Kairn output tokens: ${metrics.totals.outputTokens}`,
    `Estimated tokens saved: ${metrics.totals.savedTokens}`,
    `Estimated savings rate: ${Math.round(metrics.totals.savingsRate * 100)}%`,
    "",
    "By kind",
    ...Object.entries(metrics.byKind).map(
      ([kind, bucket]) => `- ${kind}: ${bucket.savedTokens} saved across ${bucket.events} event(s)`
    ),
    "",
    "Watcher/hooks",
    `- events: ${metrics.watch.events}`,
    `- failures: ${metrics.watch.failures}`,
    `- file changes: ${metrics.watch.fileChanges}`,
    `- hook events: ${metrics.watch.hooks}`,
    "",
    "Index tiers",
    `- files: ${metrics.index.files}`,
    ...Object.entries(metrics.index.tiers).map(([tier, count]) => `- ${tier}: ${count}`),
    "",
    "Observed Codex usage",
    metrics.observed.latestCodexUsage
      ? `- latest: ${metrics.observed.latestCodexUsage.totalTokens} total (${metrics.observed.latestCodexUsage.inputTokens} input, ${metrics.observed.latestCodexUsage.outputTokens} output)`
      : "- latest: none ingested",
    `- eval runs: ${metrics.observed.evalRuns}`,
    `- eval observations: ${metrics.observed.observations}`,
    "",
    "Session ledger",
    `- events: ${metrics.ledger.events}`,
    `- phase: ${metrics.ledger.currentPhase}`,
    `- repeated files avoided: ${metrics.ledger.repeatedFilesAvoided}`,
    `- repeated snippets avoided: ${metrics.ledger.repeatedSnippetsAvoided}`,
    `- recommended files used: ${metrics.ledger.recommendedFilesUsed.length}`,
    `- unresolved failures: ${metrics.ledger.unresolvedFailures}`,
    `- active files: ${metrics.ledger.workingSet.activeFiles.slice(0, 5).join(", ") || "none"}`,
    `- next read: ${metrics.ledger.workingSet.nextSmallestUsefulRead ?? "none"}`,
    `- open risks: ${metrics.ledger.workingSet.openRisks.length}`,
    ""
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printEvalReport(report: EvalRunReport | { runs: EvalRunReport[] }): void {
  const reports = "runs" in report ? report.runs : [report];
  const lines = ["Kairn eval report."];

  for (const item of reports) {
    lines.push(
      "",
      `Run: ${item.run.id}`,
      `Mode: ${item.run.mode}`,
      `Label: ${item.run.label}`,
      `Task: ${item.run.task}`,
      `Status: ${item.run.status}`,
      item.run.sessionId ? `Session: ${item.run.sessionId}` : "Session: none",
      item.codexUsage
        ? `Observed Codex tokens: ${item.codexUsage.totalTokens} total (${item.codexUsage.inputTokens} input, ${item.codexUsage.outputTokens} output)`
        : "Observed Codex tokens: none",
      `Estimated Kairn saved tokens: ${item.estimatedMetrics?.totals.savedTokens ?? 0}`,
      `Hooks: ${item.watch.hooks}; failures: ${item.watch.failures}; file changes: ${item.watch.fileChanges}`,
      `Observations: ${item.observations.length}`
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printEvalComparison(comparison: EvalComparison): void {
  const lines = [
    "Kairn eval comparison.",
    `Baseline: ${comparison.baseline.run.id} (${comparison.baseline.run.label})`,
    `Kairn: ${comparison.kairn.run.id} (${comparison.kairn.run.label})`,
    "",
    "Observed Codex usage",
    comparison.observedTokenDelta
      ? `- saved: ${comparison.observedTokenDelta.savedTokens} tokens (${Math.round(comparison.observedTokenDelta.savingsRate * 100)}%)`
      : "- saved: unavailable; ingest Codex usage for both runs",
    comparison.observedTokenDelta
      ? `- baseline: ${comparison.observedTokenDelta.baselineTokens}; kairn: ${comparison.observedTokenDelta.kairnTokens}`
      : "",
    "",
    "Estimated Kairn metrics",
    `- saved: ${comparison.estimatedKairnSavings.savedTokens} tokens (${Math.round(comparison.estimatedKairnSavings.savingsRate * 100)}%)`,
    `- events: ${comparison.estimatedKairnSavings.events}`,
    "",
    "Signals",
    `- kairn hooks: ${comparison.kairn.watch.hooks}`,
    `- kairn failures: ${comparison.kairn.watch.failures}`,
    `- kairn file changes: ${comparison.kairn.watch.fileChanges}`,
    `- outcome notes: ${comparison.outcomeNotes.length}`,
    ""
  ].filter(Boolean);

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printBenchmarkReport(report: BenchmarkReport | { runs: BenchmarkReport[] }): void {
  const reports = "runs" in report ? report.runs : [report];
  const lines = ["Kairn benchmark report."];

  for (const item of reports) {
    lines.push(
      "",
      `Run: ${item.run.id}`,
      `Suite: ${item.run.suiteName}`,
      `Mode: ${item.run.mode}`,
      `Status: ${item.run.status}`,
      `Overall score: ${item.overallScore}`,
      `Cases: ${item.results.length}`,
      item.observed
        ? `Observed Codex tokens: ${item.observed.codexTokens} across ${item.observed.codexCaseCount} case(s)`
        : "Observed Codex tokens: none",
      item.weakestCases.length > 0 ? `Weakest: ${item.weakestCases.map((result) => `${result.caseId} (${result.score})`).join(", ")}` : "Weakest: none",
      item.recommendations.length > 0 ? ["Recommendations", ...item.recommendations.map((entry) => `- ${entry}`)].join("\n") : "Recommendations: none"
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printBenchmarkMatrixReport(report: BenchmarkMatrixReport): void {
  const lines = [
    "Kairn repo-matrix preflight.",
    `Matrix: ${report.name}`,
    `Repos: ${report.totals.repos}; passed ${report.totals.passedRepos}; failed ${report.totals.failedRepos}; skipped ${report.totals.skippedRepos}`,
    `Cases: ${report.totals.cases}; quality-passing ${report.totals.qualityPassingCases}`,
    `State gates: ${report.totals.statePassingRepos}/${report.totals.repos} repo(s) within limit`,
    "",
    "Repos"
  ];

  for (const repo of report.repos) {
    lines.push(
      `- ${repo.repo.id}: ${repo.status}; files ${repo.index.files}; state ${repo.index.totalSizeMb}MB; cases ${repo.cases.filter((item) => item.qualityGatePassed).length}/${repo.cases.length}`
    );
    for (const item of repo.weakestCases.slice(0, 3)) {
      lines.push(
        `  - ${item.caseId}: failed; decision ${item.contextDecision ?? "n/a"}; top ${item.returnedFiles.slice(0, 3).join(", ") || "none"}`
      );
    }
  }

  lines.push(
    "",
    "Recommendations",
    ...(report.recommendations.length > 0 ? report.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  );

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printBenchmarkEnduranceReport(report: BenchmarkEnduranceReport): void {
  const lines = [
    "Kairn endurance benchmark.",
    `Suite: ${report.suiteName}`,
    "",
    "Modes"
  ];

  for (const mode of report.reports) {
    const observed = mode.totalObservedCodexTokens !== undefined ? `${mode.totalObservedCodexTokens} observed Codex tokens` : "observed Codex tokens unavailable";
    lines.push(
      `- ${mode.mode}: ${mode.qualityGatePassed ? "quality passed" : "quality failed"}; assistance ${mode.assistanceStatus}; ${observed}; response tokens ${mode.totalResponseTokens}; turns ${mode.turns.length}`,
      `  assistance: emitted ${mode.assistanceActions.emitted}, shrunk ${mode.assistanceActions.shrunk}, suppressed ${mode.assistanceActions.suppressed}, MCP ${mode.assistanceActions.mcpCalls}, failure contexts ${mode.assistanceActions.failureContexts}`,
      `  ledger: phase ${mode.ledger?.currentPhase ?? "n/a"}, repeated files avoided ${mode.ledger?.repeatedFilesAvoided ?? 0}, recommended files used ${mode.ledger?.recommendedFilesUsed.length ?? 0}`,
      `  working set: active ${mode.ledger?.workingSet.activeFiles.slice(0, 3).join(", ") || "none"}; next ${mode.ledger?.workingSet.nextSmallestUsefulRead?.filePath ?? "none"}`
    );
    for (const turn of mode.turns) {
      lines.push(
        `  - ${turn.turnId}: ${turn.outcome}; tokens ${turn.observedCodexTokens ?? "n/a"}; repeated avoided ${turn.repeatedFilesAvoided}/${turn.repeatedSnippetsAvoided}; ${turn.summary}`
      );
    }
  }

  lines.push("", "Deltas");
  for (const [mode, delta] of Object.entries(report.deltas)) {
    if (delta.savedTokens === undefined) {
      lines.push(`- ${mode}: unavailable`);
      continue;
    }
    if (!delta.qualityGatePassed && (delta.savedTokens ?? 0) > 0) {
      lines.push(`- ${mode}: ${delta.savedTokens} fewer tokens, invalid savings because quality failed`);
    } else if (!delta.assistanceEligible && (delta.savedTokens ?? 0) > 0) {
      lines.push(`- ${mode}: ${delta.savedTokens} fewer tokens, passive/suppressed evidence only`);
    } else {
      lines.push(`- ${mode}: ${delta.savedTokens} tokens (${Math.round((delta.savingsRate ?? 0) * 100)}%)`);
    }
  }

  lines.push(
    "",
    "Recommendations",
    ...(report.recommendations.length > 0 ? report.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printBenchmarkComparison(comparison: BenchmarkComparison): void {
  const lines = [
    "Kairn benchmark comparison.",
    `Before: ${comparison.before.run.id} (${comparison.before.overallScore})`,
    `After: ${comparison.after.run.id} (${comparison.after.overallScore})`,
    `Score delta: ${comparison.scoreDelta}`,
    "",
    "Observed Codex usage",
    comparison.observedTokenDelta
      ? comparison.observedTokenDelta.qualityGatePassed === false && comparison.observedTokenDelta.savedTokens > 0
        ? `- invalid savings: ${comparison.observedTokenDelta.savedTokens} fewer tokens, but quality gate failed`
        : `- saved: ${comparison.observedTokenDelta.savedTokens} tokens (${Math.round(comparison.observedTokenDelta.savingsRate * 100)}%)`
      : "- saved: unavailable; run agent commands that print Codex token footers",
    comparison.observedTokenDelta
      ? `- before: ${comparison.observedTokenDelta.beforeTokens}; after: ${comparison.observedTokenDelta.afterTokens}`
      : "",
    "",
    comparison.improvedCases.length > 0 ? `Improved: ${comparison.improvedCases.join(", ")}` : "Improved: none",
    comparison.regressedCases.length > 0 ? `Regressed: ${comparison.regressedCases.join(", ")}` : "Regressed: none",
    "",
    "Recommendations",
    ...(comparison.recommendations.length > 0 ? comparison.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function printBenchmarkProof(report: BenchmarkProofReport): void {
  const lines = [
    "Kairn benchmark proof.",
    "",
    "Observed Codex usage",
    formatProofDelta("Prompt-only hooks vs baseline", report.observedTokenDeltas.promptOnlyVsBaseline),
    formatProofDelta("Prompt+tool hooks vs baseline", report.observedTokenDeltas.promptPlusHooksVsBaseline),
    formatProofDelta("Manual prime vs baseline", report.observedTokenDeltas.manualPrimeVsBaseline),
    formatProofDelta("Hook full prime vs baseline", report.observedTokenDeltas.hookFullPrimeVsBaseline),
    formatProofDelta("Hook tiny directive vs baseline", report.observedTokenDeltas.hookTinyDirectiveVsBaseline),
    formatProofDelta("Hook tiny+failures vs baseline", report.observedTokenDeltas.hookTinyWithFailuresVsBaseline),
    formatProofDelta("MCP-first vs baseline", report.observedTokenDeltas.mcpFirstVsBaseline),
    formatProofDelta("Real MCP-first vs baseline", report.observedTokenDeltas.realMcpFirstVsBaseline),
    formatProofDelta("MCP-first + full-prime hook vs baseline", report.observedTokenDeltas.mcpFirstPlusHookFullPrimeVsBaseline),
    report.aggregate ? `- Repeat count: ${report.aggregate.repeat}` : "",
    report.aggregate?.deltas.promptOnlyVsBaseline?.savingsRate !== undefined
      ? `- Prompt-only median savings: ${Math.round(report.aggregate.deltas.promptOnlyVsBaseline.savingsRate * 100)}%`
      : "",
    "",
    "Cases",
    ...report.caseDeltas.map((item) => {
      const proactiveVsBaseline = item.proactiveVsBaseline !== undefined ? item.proactiveVsBaseline : "n/a";
      const proactiveVsPassive = item.proactiveVsPassive !== undefined ? item.proactiveVsPassive : "n/a";
      return `- ${item.caseId}: baseline ${item.baselineTokens ?? "n/a"}, passive ${item.passiveHooksTokens ?? "n/a"}, proactive ${item.proactiveTokens ?? "n/a"}; proactive-baseline delta ${proactiveVsBaseline}; proactive-passive delta ${proactiveVsPassive}`;
    }),
    "",
    "Recommendations",
    ...(report.recommendations.length > 0 ? report.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  return [
    `# Kairn Benchmark Run ${report.run.id}`,
    "",
    `- Suite: ${report.run.suiteName}`,
    `- Mode: ${report.run.mode}`,
    `- Status: ${report.run.status}`,
    `- Overall score: ${report.overallScore}`,
    report.observed ? `- Observed Codex tokens: ${report.observed.codexTokens} across ${report.observed.codexCaseCount} case(s)` : "- Observed Codex tokens: none",
    "",
    "## Cases",
    ...report.results.map(
      (result) =>
        `- ${result.caseId}: ${result.score} ` +
        `(recall ${Math.round(result.expectedFileRecall * 100)}%, top-k ${Math.round(result.topKHitRate * 100)}%, unexpected ${Math.round(result.unexpectedFileRate * 100)}%, outcome ${result.taskOutcome})`
    ),
    "",
    "## Weakest Cases",
    ...(report.weakestCases.length > 0 ? report.weakestCases.map((result) => `- ${result.caseId}: ${result.score}`) : ["- none"]),
    "",
    "## Recommendations",
    ...(report.recommendations.length > 0 ? report.recommendations.map((entry) => `- ${entry}`) : ["- none"]),
    ""
  ].join("\n");
}

function formatProofDelta(label: string, delta: BenchmarkComparison["observedTokenDelta"]): string {
  if (!delta) return `- ${label}: unavailable`;
  if (!delta.qualityGatePassed && delta.savedTokens > 0) {
    return `- ${label}: ${delta.savedTokens} fewer tokens, invalid savings (quality gate failed)`;
  }
  return `- ${label}: ${delta.savedTokens} tokens (${Math.round(delta.savingsRate * 100)}%)`;
}
