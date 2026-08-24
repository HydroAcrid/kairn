// SPDX-License-Identifier: Apache-2.0

import type { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { MetricsSummary } from "../types.js";

export type BetaReport = {
  schemaVersion: 2;
  generatedAt: string;
  sessions: number;
  window: {
    requested: number;
    sampled: number;
    available: number;
  };
  headline: {
    estimatedContextSavingsRate: number;
    estimatedContextTokensAvoided: number;
    basis: "quality_gated_estimate" | "all_sessions_estimate" | "no_data";
  };
  status: {
    helped: number;
    silent: number;
    mayHaveOverAssisted: number;
    missedOpportunity: number;
    setupOrHookIssues: number;
  };
  tokens: {
    estimatedBaseline: number;
    estimatedOutput: number;
    estimatedSaved: number;
    activeEstimatedSaved: number;
    passiveEstimatedSaved: number;
    estimatedSavingsRate: number;
    qualityGatedEstimatedBaseline: number;
    qualityGatedEstimatedOutput: number;
    qualityGatedEstimatedSaved: number;
    qualityGatedEstimatedSavingsRate: number;
    qualityGatedSessions: number;
    observedTotal?: number;
  };
  quality: {
    sessionsPassingVerification: number;
    sessionsFailingVerification: number;
    sessionsUnverified: number;
    harmfulAssists: number;
    recommendationsMade: number;
    recommendationsLaterUsed: number;
    recommendationsLaterTouched: number;
    recommendationUseRate?: number;
    recommendationTouchRate?: number;
  };
  decisions: {
    interventions: number;
    stayedSilent: number;
    emitted: number;
    shrunk: number;
    requestedEvidence: number;
  };
  context: {
    repeatedFilesAvoided: number;
    repeatedSnippetsAvoided: number;
    activeFiles: number;
    unresolvedFailures: number;
  };
  hooks: {
    invocations: number;
    failures: number;
    suppressed: number;
  };
  mcp: {
    calls: number;
  };
  verdict: "beta_positive" | "mixed" | "needs_attention" | "no_data";
  summary: string[];
};

export function buildBetaReport(input: {
  runtime: KairnRuntime;
  sessionId?: string | undefined;
  limit?: number | undefined;
}): BetaReport {
  const requested = input.sessionId ? 1 : normalizeLimit(input.limit);
  const available = input.runtime.listSessions({ allRoots: false }).length;
  const sessions = input.sessionId
    ? [input.runtime.getSession(input.sessionId)]
    : input.runtime.listSessions({ allRoots: false, limit: requested });
  const metrics = sessions.map((session) => input.runtime.getMetrics(session.id));
  const totals = summarizeTokens(metrics);
  const quality = summarizeQuality(metrics);
  const status = summarizeStatus(metrics);
  const decisions = summarizeDecisions(metrics);
  const context = summarizeContext(metrics);
  const hooks = summarizeHooks(metrics);
  const mcp = { calls: metrics.reduce((total, item) => total + item.delivery.mcp.calls, 0) };
  const headline = summarizeHeadline(totals, metrics.length);
  const verdict = chooseVerdict({ sessions: sessions.length, status, hooks, totals, quality });
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sessions: sessions.length,
    window: { requested, sampled: sessions.length, available },
    headline,
    status,
    tokens: totals,
    quality,
    decisions,
    context,
    hooks,
    mcp,
    verdict,
    summary: betaSummary({ verdict, status, totals, quality, decisions, context })
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 12;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("Beta report session limit must be an integer from 1 to 500.");
  }
  return value;
}

function summarizeTokens(metrics: MetricsSummary[]): BetaReport["tokens"] {
  const estimatedBaseline = sum(metrics, (item) => item.totals.baselineTokens);
  const estimatedOutput = sum(metrics, (item) => item.totals.outputTokens);
  const estimatedSaved = sum(metrics, (item) => item.totals.savedTokens);
  const activeEstimatedSaved = sum(metrics.filter(hasActiveAssistance), (item) => item.totals.savedTokens);
  const passiveEstimatedSaved = sum(metrics.filter((item) => !hasActiveAssistance(item)), (item) => item.totals.savedTokens);
  const qualityGated = metrics.filter(isQualityPassingSession);
  const qualityGatedEstimatedBaseline = sum(qualityGated, (item) => item.totals.baselineTokens);
  const qualityGatedEstimatedOutput = sum(qualityGated, (item) => item.totals.outputTokens);
  const qualityGatedEstimatedSaved = sum(qualityGated, (item) => item.totals.savedTokens);
  const observed = metrics.map((item) => item.observed.latestCodexUsage?.totalTokens).filter((value): value is number => typeof value === "number");
  return {
    estimatedBaseline,
    estimatedOutput,
    estimatedSaved,
    activeEstimatedSaved,
    passiveEstimatedSaved,
    estimatedSavingsRate: rate(estimatedSaved, estimatedBaseline),
    qualityGatedEstimatedBaseline,
    qualityGatedEstimatedOutput,
    qualityGatedEstimatedSaved,
    qualityGatedEstimatedSavingsRate: rate(qualityGatedEstimatedSaved, qualityGatedEstimatedBaseline),
    qualityGatedSessions: qualityGated.length,
    ...(observed.length > 0 ? { observedTotal: observed.reduce((total, value) => total + value, 0) } : {})
  };
}

function summarizeHeadline(totals: BetaReport["tokens"], sessionCount: number): BetaReport["headline"] {
  if (sessionCount === 0 || totals.estimatedBaseline === 0) {
    return { estimatedContextSavingsRate: 0, estimatedContextTokensAvoided: 0, basis: "no_data" };
  }
  if (totals.qualityGatedSessions > 0 && totals.qualityGatedEstimatedBaseline > 0) {
    return {
      estimatedContextSavingsRate: totals.qualityGatedEstimatedSavingsRate,
      estimatedContextTokensAvoided: totals.qualityGatedEstimatedSaved,
      basis: "quality_gated_estimate"
    };
  }
  return {
    estimatedContextSavingsRate: totals.estimatedSavingsRate,
    estimatedContextTokensAvoided: totals.estimatedSaved,
    basis: "all_sessions_estimate"
  };
}

function summarizeQuality(metrics: MetricsSummary[]): BetaReport["quality"] {
  const sessionsPassingVerification = metrics.filter((item) => item.quality.latestVerification === "passed").length;
  const sessionsFailingVerification = metrics.filter((item) => item.quality.latestVerification === "failed").length;
  const recommendationsMade = sum(metrics, (item) => item.recommendations.made);
  const recommendationsLaterUsed = sum(metrics, (item) => item.recommendations.laterUsed);
  const recommendationsLaterTouched = sum(metrics, (item) => item.recommendations.laterTouched);
  return {
    sessionsPassingVerification,
    sessionsFailingVerification,
    sessionsUnverified: metrics.length - sessionsPassingVerification - sessionsFailingVerification,
    harmfulAssists: sum(metrics, (item) => item.assistance.harmful),
    recommendationsMade,
    recommendationsLaterUsed,
    recommendationsLaterTouched,
    ...(recommendationsMade > 0 ? {
      recommendationUseRate: recommendationsLaterUsed / recommendationsMade,
      recommendationTouchRate: recommendationsLaterTouched / recommendationsMade
    } : {})
  };
}

function summarizeStatus(metrics: MetricsSummary[]): BetaReport["status"] {
  return {
    helped: metrics.filter((item) => hasActiveAssistance(item) && item.totals.savedTokens > 0 && isQualityPassingSession(item)).length,
    silent: metrics.filter((item) => !hasActiveAssistance(item)).length,
    mayHaveOverAssisted: sum(metrics, (item) => item.assistance.overAssist),
    missedOpportunity: sum(metrics, (item) => item.assistance.missedOpportunity),
    setupOrHookIssues: sum(metrics, (item) => item.delivery.hooks.failures)
  };
}

function summarizeDecisions(metrics: MetricsSummary[]): BetaReport["decisions"] {
  const emitted = sum(metrics, (item) => item.decisions.emit);
  const shrunk = sum(metrics, (item) => item.decisions.shrink);
  const requestedEvidence = sum(metrics, (item) => item.decisions.requestEvidence);
  return {
    interventions: emitted + shrunk + requestedEvidence,
    stayedSilent: sum(metrics, (item) => item.decisions.suppress),
    emitted,
    shrunk,
    requestedEvidence
  };
}

function hasActiveAssistance(item: MetricsSummary): boolean {
  return item.delivery.hooks.invocations > 0 || item.delivery.mcp.calls > 0 || (item.byKind.failure_context?.events ?? 0) > 0;
}

function isQualityPassingSession(item: MetricsSummary): boolean {
  return item.quality.latestVerification === "passed" && item.assistance.harmful === 0;
}

function summarizeContext(metrics: MetricsSummary[]): BetaReport["context"] {
  return {
    repeatedFilesAvoided: sum(metrics, (item) => item.ledger.repeatedFilesAvoided),
    repeatedSnippetsAvoided: sum(metrics, (item) => item.ledger.repeatedSnippetsAvoided),
    activeFiles: new Set(metrics.flatMap((item) => item.ledger.workingSet.activeFiles)).size,
    unresolvedFailures: sum(metrics, (item) => item.ledger.unresolvedFailures)
  };
}

function summarizeHooks(metrics: MetricsSummary[]): BetaReport["hooks"] {
  return {
    invocations: sum(metrics, (item) => item.delivery.hooks.invocations),
    failures: sum(metrics, (item) => item.delivery.hooks.failures),
    suppressed: sum(metrics, (item) => item.delivery.hooks.suppressed)
  };
}

function chooseVerdict(input: {
  sessions: number;
  status: BetaReport["status"];
  hooks: BetaReport["hooks"];
  totals: BetaReport["tokens"];
  quality: BetaReport["quality"];
}): BetaReport["verdict"] {
  if (input.sessions === 0) return "no_data";
  if (input.status.setupOrHookIssues > 0 || input.hooks.failures > 0 || input.quality.harmfulAssists > 0) return "needs_attention";
  if (input.status.mayHaveOverAssisted > input.status.helped || input.quality.sessionsFailingVerification > 0) return "mixed";
  if (input.quality.sessionsPassingVerification > 0 && input.totals.qualityGatedEstimatedSaved > 0) return "beta_positive";
  return "mixed";
}

function betaSummary(input: {
  verdict: BetaReport["verdict"];
  status: BetaReport["status"];
  totals: BetaReport["tokens"];
  quality: BetaReport["quality"];
  decisions: BetaReport["decisions"];
  context: BetaReport["context"];
}): string[] {
  const qualityLine = `${input.quality.sessionsPassingVerification} session(s) passed latest verification; ` +
    `${input.quality.sessionsFailingVerification} failed and ${input.quality.sessionsUnverified} were unverified.`;
  return [
    input.verdict === "beta_positive" ? "Kairn has quality-gated positive evidence in the sampled sessions." :
      input.verdict === "needs_attention" ? "Kairn has a harmful assist or setup/hook issue that needs attention." :
        input.verdict === "no_data" ? "No Kairn session data found yet." :
          input.status.helped === 0 && input.status.silent > 0 ? "Kairn was silent in the sampled sessions; this is passive evidence, not a savings claim." :
          "Kairn evidence is mixed or not verified yet; estimated reduction is directional.",
    qualityLine,
    `Signed estimated context delta: ${input.totals.estimatedSaved} tokens across all sampled sessions.`,
    `Kairn intervened ${input.decisions.interventions} time(s) and stayed silent ${input.decisions.stayedSilent} time(s).`,
    `Repeated context blocked: ${input.context.repeatedFilesAvoided} files, ${input.context.repeatedSnippetsAvoided} snippets.`,
    `Harmful assists: ${input.quality.harmfulAssists}; over-assist signals: ${input.status.mayHaveOverAssisted}.`
  ];
}

function sum(items: MetricsSummary[], select: (item: MetricsSummary) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function rate(saved: number, baseline: number): number {
  return baseline > 0 ? saved / baseline : 0;
}
