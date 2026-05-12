import type { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { MetricsSummary } from "../types.js";

export type BetaReport = {
  generatedAt: string;
  sessions: number;
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
    observedTotal?: number;
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
}): BetaReport {
  const sessions = input.sessionId
    ? [input.runtime.getSession(input.sessionId)]
    : input.runtime.listSessions({ allRoots: false, limit: 50 });
  const metrics = sessions.map((session) => input.runtime.getMetrics(session.id));
  const totals = summarizeTokens(metrics);
  const status = summarizeStatus(metrics);
  const context = summarizeContext(metrics);
  const hooks = summarizeHooks(metrics);
  const mcp = { calls: metrics.reduce((total, item) => total + (item.byKind.mcp_tool_call?.events ?? 0), 0) };
  const verdict = chooseVerdict({ sessions: sessions.length, status, hooks, totals });
  return {
    generatedAt: new Date().toISOString(),
    sessions: sessions.length,
    status,
    tokens: totals,
    context,
    hooks,
    mcp,
    verdict,
    summary: betaSummary({ verdict, status, totals, context, hooks, mcp })
  };
}

function summarizeTokens(metrics: MetricsSummary[]): BetaReport["tokens"] {
  const estimatedBaseline = metrics.reduce((total, item) => total + item.totals.baselineTokens, 0);
  const estimatedOutput = metrics.reduce((total, item) => total + item.totals.outputTokens, 0);
  const estimatedSaved = metrics.reduce((total, item) => total + item.totals.savedTokens, 0);
  const activeEstimatedSaved = metrics.reduce((total, item) => {
    const hasActive = hasActiveAssistance(item);
    return total + (hasActive && item.totals.savedTokens > 0 ? item.totals.savedTokens : 0);
  }, 0);
  const passiveEstimatedSaved = metrics.reduce((total, item) => {
    const hasActive = hasActiveAssistance(item);
    return total + (!hasActive && item.totals.savedTokens > 0 ? item.totals.savedTokens : 0);
  }, 0);
  const observed = metrics.map((item) => item.observed.latestCodexUsage?.totalTokens).filter((value): value is number => typeof value === "number");
  return {
    estimatedBaseline,
    estimatedOutput,
    estimatedSaved,
    activeEstimatedSaved,
    passiveEstimatedSaved,
    estimatedSavingsRate: estimatedBaseline > 0 ? estimatedSaved / estimatedBaseline : 0,
    ...(observed.length > 0 ? { observedTotal: observed.reduce((sum, value) => sum + value, 0) } : {})
  };
}

function summarizeStatus(metrics: MetricsSummary[]): BetaReport["status"] {
  const status = {
    helped: 0,
    silent: 0,
    mayHaveOverAssisted: 0,
    missedOpportunity: 0,
    setupOrHookIssues: 0
  };
  for (const item of metrics) {
    const hasActive = hasActiveAssistance(item);
    if (hasActive && item.totals.savedTokens > 0) status.helped += 1;
    if (!hasActive) status.silent += 1;
    for (const event of item.recentEvents) {
      if (event.metadata.assistClassification === "over_assist") status.mayHaveOverAssisted += 1;
      if (event.metadata.assistClassification === "missed_savings_opportunity" || event.metadata.assistClassification === "missed_quality_opportunity") {
        status.missedOpportunity += 1;
      }
      if (event.eventKind === "hook_signal" && event.eventName.toLowerCase().includes("fail")) status.setupOrHookIssues += 1;
    }
  }
  return status;
}

function hasActiveAssistance(item: MetricsSummary): boolean {
  return (item.byKind.hook_signal?.events ?? 0) > 0 ||
    (item.byKind.mcp_tool_call?.events ?? 0) > 0 ||
    (item.byKind.failure_context?.events ?? 0) > 0;
}

function summarizeContext(metrics: MetricsSummary[]): BetaReport["context"] {
  return {
    repeatedFilesAvoided: metrics.reduce((total, item) => total + item.ledger.repeatedFilesAvoided, 0),
    repeatedSnippetsAvoided: metrics.reduce((total, item) => total + item.ledger.repeatedSnippetsAvoided, 0),
    activeFiles: new Set(metrics.flatMap((item) => item.ledger.workingSet.activeFiles)).size,
    unresolvedFailures: metrics.reduce((total, item) => total + item.ledger.unresolvedFailures, 0)
  };
}

function summarizeHooks(metrics: MetricsSummary[]): BetaReport["hooks"] {
  return {
    invocations: metrics.reduce((total, item) => total + (item.byKind.hook_signal?.events ?? 0), 0),
    failures: metrics.flatMap((item) => item.recentEvents).filter((event) => event.eventKind === "hook_signal" && event.eventName.toLowerCase().includes("fail")).length,
    suppressed: metrics.flatMap((item) => item.recentEvents).filter((event) => event.eventKind === "hook_signal" && event.metadata.primeSuppressed === true).length
  };
}

function chooseVerdict(input: {
  sessions: number;
  status: BetaReport["status"];
  hooks: BetaReport["hooks"];
  totals: BetaReport["tokens"];
}): BetaReport["verdict"] {
  if (input.sessions === 0) return "no_data";
  if (input.status.setupOrHookIssues > 0 || input.hooks.failures > 0) return "needs_attention";
  if (input.status.mayHaveOverAssisted > input.status.helped) return "mixed";
  if (input.status.helped > 0 && input.totals.activeEstimatedSaved > 0) return "beta_positive";
  return "mixed";
}

function betaSummary(input: {
  verdict: BetaReport["verdict"];
  status: BetaReport["status"];
  totals: BetaReport["tokens"];
  context: BetaReport["context"];
  hooks: BetaReport["hooks"];
  mcp: BetaReport["mcp"];
}): string[] {
  return [
    input.verdict === "beta_positive" ? "Kairn has active positive evidence in the sampled sessions." :
      input.verdict === "needs_attention" ? "Kairn has setup or hook issues that should be fixed before relying on beta results." :
        input.verdict === "no_data" ? "No Kairn session data found yet." :
          input.status.helped === 0 && input.status.silent > 0 ? "Kairn was silent in the sampled sessions; this is passive evidence, not an active savings claim." :
            "Kairn evidence is mixed; inspect over-assist and missed-opportunity events.",
    `Active estimated saved tokens: ${input.totals.activeEstimatedSaved}.`,
    `Passive/silent token delta: ${input.totals.passiveEstimatedSaved}.`,
    `Silent sessions: ${input.status.silent}; helped sessions: ${input.status.helped}.`,
    `Repeated context avoided: ${input.context.repeatedFilesAvoided} files, ${input.context.repeatedSnippetsAvoided} snippets.`,
    `Hook invocations: ${input.hooks.invocations}; MCP calls: ${input.mcp.calls}.`
  ];
}
