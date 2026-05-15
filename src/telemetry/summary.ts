import fs from "node:fs";
import path from "node:path";
import type { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { TelemetryPayload } from "../types.js";
import { buildTelemetryPayload } from "./payload.js";
import { buildBetaReport } from "./report.js";
import { assertSafeTelemetryPayload } from "./sanitize.js";

export type PrivateBetaTelemetrySummary = {
  generatedAt: string;
  payload: TelemetryPayload;
  beta: ReturnType<typeof buildBetaReport>;
  sections: {
    installSetupFailures: number;
    hookFailures: number;
    mcpFailures: number;
    overAssistClusters: number;
    missedOpportunityClusters: number;
    correctAbstentionRate: number;
    tokenEstimatesByMode: Record<string, number>;
  };
};

export function buildPrivateBetaTelemetrySummary(input: {
  runtime: KairnRuntime;
  installationId: string;
  repoSalt: string;
  sessionId?: string | undefined;
}): PrivateBetaTelemetrySummary {
  const payload = buildTelemetryPayload(input);
  assertSafeTelemetryPayload(payload);
  const beta = buildBetaReport({ runtime: input.runtime, sessionId: input.sessionId });
  const decisionsTotal = payload.decisions.emit + payload.decisions.shrink + payload.decisions.suppress + payload.decisions.requestEvidence;
  return {
    generatedAt: new Date().toISOString(),
    payload,
    beta,
    sections: {
      installSetupFailures: beta.status.setupOrHookIssues,
      hookFailures: payload.hooks.failures,
      mcpFailures: 0,
      overAssistClusters: payload.assistance.overAssist,
      missedOpportunityClusters: payload.assistance.missedOpportunity,
      correctAbstentionRate: decisionsTotal > 0 ? round(payload.decisions.suppress / decisionsTotal) : 0,
      tokenEstimatesByMode: {
        all: payload.tokens.estimatedSaved,
        active: payload.tokens.activeEstimatedSaved,
        passive: payload.tokens.passiveEstimatedSaved
      }
    }
  };
}

export function writePrivateBetaTelemetrySummary(input: {
  summary: PrivateBetaTelemetrySummary;
  outPath: string;
}): void {
  const absolute = path.resolve(input.outPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, formatPrivateBetaTelemetrySummary(input.summary));
}

export function formatPrivateBetaTelemetrySummary(summary: PrivateBetaTelemetrySummary): string {
  return [
    "# Kairn Private Beta Telemetry Summary",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Setup And Delivery",
    "",
    `- Install/setup failures: ${summary.sections.installSetupFailures}`,
    `- Hook failures: ${summary.sections.hookFailures}`,
    `- MCP failures: ${summary.sections.mcpFailures}`,
    "",
    "## Assistance",
    "",
    `- Decisions: emit=${summary.payload.decisions.emit}, shrink=${summary.payload.decisions.shrink}, suppress=${summary.payload.decisions.suppress}, request_evidence=${summary.payload.decisions.requestEvidence}`,
    `- Active sessions: ${summary.payload.assistance.active}`,
    `- Passive/silent sessions: ${summary.payload.assistance.passiveSuppressed + summary.payload.assistance.none}`,
    `- Over-assist clusters: ${summary.sections.overAssistClusters}`,
    `- Missed opportunity clusters: ${summary.sections.missedOpportunityClusters}`,
    `- Correct abstention rate estimate: ${(summary.sections.correctAbstentionRate * 100).toFixed(2)}%`,
    "",
    "## Tokens",
    "",
    `- Estimated saved tokens: ${summary.payload.tokens.estimatedSaved}`,
    `- Active estimated saved tokens: ${summary.payload.tokens.activeEstimatedSaved}`,
    `- Passive estimated saved tokens: ${summary.payload.tokens.passiveEstimatedSaved}`,
    "",
    "## Context",
    "",
    `- Repeated files avoided: ${summary.payload.ledger.repeatedFilesAvoided}`,
    `- Repeated snippets avoided: ${summary.payload.ledger.repeatedSnippetsAvoided}`,
    `- Scope violations: ${summary.payload.scope.violations}`,
    "",
    "## Privacy",
    "",
    "This report is generated from sanitized aggregate telemetry. It intentionally omits prompts, source, diffs, file paths, filenames, repo names, branch names, and raw command output.",
    ""
  ].join("\n");
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
