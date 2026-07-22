// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  mergeCodexUsage,
  parseCodexUsageFooter,
  readCodexTranscript
} from "../../eval/codexUsage.js";
import { codexUsageFromObservation } from "../../eval/usageObservation.js";
import { emptyMetricsBucket } from "../../metrics/summary.js";
import type {
  EvalComparison,
  EvalObservationRecord,
  EvalRunMode,
  EvalRunReport
} from "../../types.js";
import { sha256 } from "../../utils/hash.js";
import { uniquePaths } from "../../utils/collections.js";
import type { RuntimeDeps } from "../deps.js";
import type { MetricsService } from "./MetricsService.js";

export class EvalService {
  constructor(
    private readonly deps: RuntimeDeps,
    private readonly metricsService: MetricsService
  ) {}

  startEvalRun(input: {
    task: string;
    label: string;
    mode: EvalRunMode;
    sessionId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) {
    if (input.sessionId) this.deps.store.getSession(input.sessionId);
    return this.deps.store.createEvalRun({
      id: `eval_${randomUUID()}`,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      rootPath: this.deps.rootPath,
      task: input.task,
      label: input.label,
      mode: input.mode,
      status: "active",
      metadata: input.metadata ?? {}
    });
  }

  ingestCodexUsage(input: {
    sessionId: string;
    runId?: string | undefined;
    usageText?: string | undefined;
    transcriptPath?: string | undefined;
  }): EvalObservationRecord {
    const session = this.deps.store.getSession(input.sessionId);
    const run = input.runId
      ? this.deps.store.getEvalRun(input.runId)
      : this.findLatestEvalRunForSession(input.sessionId);
    if (run.sessionId && run.sessionId !== input.sessionId) {
      throw new Error(`Eval run ${run.id} belongs to a different session.`);
    }

    const footerUsage = input.usageText ? parseCodexUsageFooter(input.usageText) : undefined;
    const transcript = input.transcriptPath ? readCodexTranscript({ transcriptPath: input.transcriptPath }) : undefined;
    const usage = mergeCodexUsage({
      footerUsage,
      transcriptUsage: transcript?.usage,
      transcriptMetadata: transcript?.metadata,
      transcriptPath: transcript?.transcriptPath,
      transcriptHash: transcript?.transcriptHash
    });

    if (!usage) {
      throw new Error("No Codex token usage could be parsed from --usage, stdin, or --transcript.");
    }

    const observation = this.deps.store.recordEvalObservation({
      runId: run.id,
      sessionId: input.sessionId,
      kind: "codex_usage",
      summary: `Codex usage: ${usage.totalTokens} total tokens (${usage.inputTokens} input, ${usage.outputTokens} output).`,
      metrics: {
        codexUsage: usage,
        ...(input.usageText ? { usageTextHash: sha256(input.usageText) } : {}),
        rootPath: session.rootPath
      },
      files: [],
      contentHash: sha256(JSON.stringify(usage))
    });
    if (transcript?.feedback && (transcript.feedback.filesRead.length > 0 || transcript.feedback.filesEdited.length > 0 || transcript.feedback.commands.length > 0)) {
      const files = uniquePaths([...transcript.feedback.filesRead, ...transcript.feedback.filesEdited]);
      this.deps.store.recordEvalObservation({
        runId: run.id,
        sessionId: input.sessionId,
        kind: "agent_file_usage",
        summary: `Agent usage: ${transcript.feedback.filesRead.length} read file(s), ${transcript.feedback.filesEdited.length} edited file(s), ${transcript.feedback.commands.length} command(s).`,
        metrics: {
          feedback: transcript.feedback,
          transcriptHash: transcript.transcriptHash,
          rootPath: session.rootPath
        },
        files,
        contentHash: sha256(JSON.stringify({ files, feedback: transcript.feedback }))
      });
    }

    return observation;
  }

  getEvalFeedback(input: { sessionId: string }): EvalObservationRecord {
    this.deps.store.getSession(input.sessionId);
    const latestRun = this.findLatestEvalRunForSession(input.sessionId);
    const metrics = this.deps.store.listMetricsEvents(input.sessionId);
    const observations = this.deps.store.listEvalObservations({ sessionId: input.sessionId });
    const recommendedFiles = uniquePaths(metrics.flatMap((event) => event.files));
    const agentUsageFiles = uniquePaths(
      observations
        .filter((event) => event.kind === "agent_file_usage")
        .flatMap((event) => event.files)
    );
    const recommendedFilesUsed = recommendedFiles.filter((file) => agentUsageFiles.includes(file));
    const missedRecommendedFiles = recommendedFiles.filter((file) => !agentUsageFiles.includes(file));
    const unpromptedFilesUsed = agentUsageFiles.filter((file) => !recommendedFiles.includes(file));

    return this.deps.store.recordEvalObservation({
      runId: latestRun.id,
      sessionId: input.sessionId,
      kind: "retrieval_feedback",
      summary: `Retrieval feedback: ${recommendedFilesUsed.length}/${recommendedFiles.length} recommended file(s) appeared in agent usage.`,
      metrics: {
        recommendedCount: recommendedFiles.length,
        agentUsageCount: agentUsageFiles.length,
        recommendedFilesUsed,
        missedRecommendedFiles,
        unpromptedFilesUsed
      },
      files: uniquePaths([...recommendedFilesUsed, ...unpromptedFilesUsed]),
      contentHash: sha256(JSON.stringify({ recommendedFiles, agentUsageFiles }))
    });
  }

  addEvalNote(input: {
    runId: string;
    outcome: "pass" | "fail" | "partial";
    summary: string;
    files?: string[] | undefined;
    sessionId?: string | undefined;
  }): EvalObservationRecord {
    const run = this.deps.store.getEvalRun(input.runId);
    const sessionId = input.sessionId ?? run.sessionId;
    const observation = this.deps.store.recordEvalObservation({
      runId: run.id,
      ...(sessionId ? { sessionId } : {}),
      kind: "manual_outcome",
      summary: input.summary,
      metrics: {
        outcome: input.outcome
      },
      files: uniquePaths(input.files ?? []),
      contentHash: sha256([input.outcome, input.summary, ...(input.files ?? [])].join("\n"))
    });
    this.deps.store.updateEvalRunStatus(run.id, input.outcome === "pass" ? "completed" : "active");
    return observation;
  }

  getEvalReport(input: { runId?: string | undefined; sessionId?: string | undefined }): EvalRunReport | { runs: EvalRunReport[] } {
    if (input.runId) return this.buildEvalReport(this.deps.store.getEvalRun(input.runId));
    const runs = this.deps.store
      .listEvalRuns({
        rootPath: this.deps.rootPath,
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      })
      .map((run) => this.buildEvalReport(run));
    return { runs };
  }

  compareEvalRuns(input: { baselineRunId: string; kairnRunId: string }): EvalComparison {
    const baseline = this.buildEvalReport(this.deps.store.getEvalRun(input.baselineRunId));
    const kairn = this.buildEvalReport(this.deps.store.getEvalRun(input.kairnRunId));
    const baselineTokens = baseline.codexUsage?.totalTokens;
    const kairnTokens = kairn.codexUsage?.totalTokens;
    const observedTokenDelta =
      baselineTokens !== undefined && kairnTokens !== undefined
        ? {
            baselineTokens,
            kairnTokens,
            // Signed by design: a negative value is a token regression and must
            // remain visible in evidence instead of being flattened to zero.
            savedTokens: baselineTokens - kairnTokens,
            savingsRate: baselineTokens > 0 ? Number(((baselineTokens - kairnTokens) / baselineTokens).toFixed(4)) : 0
          }
        : undefined;

    return {
      baseline,
      kairn,
      ...(observedTokenDelta ? { observedTokenDelta } : {}),
      estimatedKairnSavings: kairn.estimatedMetrics?.totals ?? {
        ...emptyMetricsBucket(),
        savingsRate: 0
      },
      outcomeNotes: [...baseline.observations, ...kairn.observations].filter((event) => event.kind === "manual_outcome")
    };
  }

  private findLatestEvalRunForSession(sessionId: string) {
    const runs = this.deps.store.listEvalRuns({ sessionId });
    const run = runs.at(-1);
    if (!run) {
      throw new Error(`No eval run exists for session ${sessionId}. Start one with kairn eval start.`);
    }
    return run;
  }

  private buildEvalReport(run: ReturnType<RuntimeDeps["store"]["getEvalRun"]>): EvalRunReport {
    const observations = this.deps.store.listEvalObservations({ runId: run.id });
    const codexObservation = [...observations].reverse().find((event) => event.kind === "codex_usage");
    const codexUsage = codexUsageFromObservation(codexObservation);
    const watchEvents = run.sessionId ? this.deps.store.listWatchEvents(run.sessionId) : [];
    return {
      run,
      observations,
      ...(codexUsage ? { codexUsage } : {}),
      ...(run.sessionId ? { estimatedMetrics: this.metricsService.getMetrics(run.sessionId) } : {}),
      watch: {
        events: watchEvents.length,
        failures: watchEvents.filter((event) => event.kind === "failure").length,
        fileChanges: watchEvents.filter((event) => event.kind === "file_change" || event.kind === "diff_change").length,
        hooks: watchEvents.filter((event) => event.kind === "hook").length
      }
    };
  }
}
