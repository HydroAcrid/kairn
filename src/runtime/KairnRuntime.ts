import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import type {
  BenchmarkAssistanceMode,
  BenchmarkComparison,
  BenchmarkProofReport,
  BenchmarkReport,
  BenchmarkResultRecord,
  BenchmarkRunMode,
  ContextPrime,
  ContextQueryMode,
  ContextResponse,
  ContextResponseMode,
  CodexUsageRecord,
  EvalComparison,
  EvalObservationRecord,
  EvalRunMode,
  EvalRunReport,
  FailureContext,
  FileRecord,
  BenchmarkCaseMode,
  HookHandlingResult,
  HookOutputProfile,
  HybridScoredResult,
  InitResult,
  MetricsBucket,
  MetricsEventKind,
  MetricsSummary,
  NormalizedHookEvent,
  OutputKind,
  PrimeQuality,
  PrimeProfile,
  TaskSession,
  WatchEventKind,
  WatchEventRecord,
  WatchEventSource,
  WatchRecommendation,
  WatchSnapshot
} from "../types.js";
import { ensureKairnDir, getKairnPaths } from "../config/paths.js";
import { SqliteStore } from "../store/sqliteStore.js";
import { compressOutput as compressOutputText } from "../compression/compressOutput.js";
import { reviewGitDiff } from "../git/reviewDiff.js";
import { hybridSearch } from "../retrieval/hybridRetrieval.js";
import { findRelatedFiles, findTestsFor } from "../retrieval/relatedFiles.js";
import { extractSymbol, readTextFile, summarizeFile } from "../retrieval/readSource.js";
import { decideResponse } from "../retrieval/responseRouter.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath, resolveRoot } from "../utils/paths.js";
import { estimateTokens, truncateToBudget } from "../utils/tokens.js";
import { indexRepo } from "../indexer/indexRepo.js";
import { classifyObservedCommand } from "../watch/classifyCommand.js";
import { extractFailureFiles } from "../watch/failureParser.js";
import { normalizeHookPayload } from "../watch/normalizeHook.js";
import { nowIso } from "../utils/time.js";
import { classifyQueryIntent, type QueryIntent } from "../retrieval/queryIntent.js";
import { mergeCodexUsage, parseCodexUsageFooter, readCodexTranscript } from "../eval/codexUsage.js";
import { loadBenchmarkSuite } from "../bench/suite.js";
import { buildBenchmarkReport, compareBenchmarkReports, scoreBenchmarkCase } from "../bench/score.js";
import { runAgentBenchmarkCase } from "../bench/agent.js";

export class KairnRuntime {
  private readonly rootPath: string;
  private readonly store: SqliteStore;

  constructor(root?: string) {
    this.rootPath = resolveRoot(root);
    const paths = ensureKairnDir(this.rootPath);
    this.store = new SqliteStore(paths.databasePath);
  }

  close(): void {
    this.store.close();
  }

  async init(): Promise<InitResult> {
    const paths = ensureKairnDir(this.rootPath);
    const index = await indexRepo(this.rootPath);
    this.store.replaceIndex({
      rootPath: this.rootPath,
      files: index.graph.files,
      symbols: index.graph.symbols,
      edges: index.graph.edges,
      semanticChunks: index.semanticChunks,
      semanticVectors: index.semanticVectors,
      lexicalDocuments: index.lexical.documents,
      lexicalTerms: index.lexical.terms,
      lexicalStats: index.lexical.stats
    });

    return {
      rootPath: paths.rootPath,
      kairnDir: paths.kairnDir,
      configPath: paths.configPath,
      databasePath: paths.databasePath,
      scan: index.scan,
      graph: index.graph,
      semantic: {
        chunks: index.semanticChunks.length,
        vectors: index.semanticVectors.length
      }
    };
  }

  async startTask(task: string): Promise<{ session: TaskSession; response: ContextResponse }> {
    await this.init();
    const session = this.store.createSession({
      id: `task_${randomUUID()}`,
      rootPath: this.rootPath,
      task,
      verificationHints: ["Review changed files", "Run related tests", "Check for context drift"]
    });
    const response = await this.findContext({
      sessionId: session.id,
      query: task,
      requestType: "initial_brief",
      budget: 1600
    });

    return {
      session: this.getSession(session.id),
      response
    };
  }

  async primeContext(input: {
    task: string;
    sessionId?: string | undefined;
    budget?: number | undefined;
    mode?: ContextQueryMode | undefined;
    profile?: PrimeProfile | undefined;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | undefined;
    eventName?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ContextPrime> {
    await this.init();
    const task = input.task;
    const profile = resolvePrimeProfile(input.profile ?? "auto", task);
    const budget = input.budget ?? defaultPrimeBudget(profile);
    const limits = primeProfileLimits(profile);
    const session = input.sessionId
      ? this.store.getSession(input.sessionId)
      : this.store.createSession({
          id: `task_${randomUUID()}`,
          rootPath: this.rootPath,
          task: input.task,
          verificationHints: ["Start from Kairn prime context", "Avoid broad scans unless the prime is insufficient", "Run related tests before finalizing"]
        });
    const resolvedTask = input.task || session.task;
    const context = await this.findContext({
      sessionId: session.id,
      query: resolvedTask,
      requestType: "find_context",
      budget: Math.max(360, Math.floor(budget * limits.contextRatio)),
      mode: input.mode ?? "snippets"
    });
    const primaryFile = context.suggestedNextContext[0] ?? context.files[0];
    const related = primaryFile
      ? await this.getRelatedFiles({
          sessionId: session.id,
          target: primaryFile,
          budget: 420
        }).catch(() => undefined)
      : undefined;
    const tests = await this.findTests({
      sessionId: session.id,
      target: primaryFile,
      budget: 420
    }).catch(() => undefined);
    const files = uniquePaths([
      ...context.suggestedNextContext.slice(0, limits.topFiles),
      ...context.files.slice(0, limits.topFiles),
      ...(related?.related ?? []).slice(0, limits.relatedFiles),
      ...(tests?.files ?? []).slice(0, limits.testFiles)
    ]);
    const suggestedCommands = [
      `kairn context --session ${session.id} --root <repo> --query "${resolvedTask.replaceAll('"', '\\"')}" --mode snippets`,
      ...(primaryFile ? [`kairn context --session ${session.id} --root <repo> --related ${primaryFile}`] : []),
      ...(primaryFile ? [`kairn context --session ${session.id} --root <repo> --tests ${primaryFile}`] : [])
    ];
    const quality = evaluatePrimeQuality({
      task: resolvedTask,
      context,
      knownFiles: this.store.listFiles(session.rootPath)
    });
    const content = quality.action === "suppress"
      ? formatSuppressedPrimeContext({ task: resolvedTask, sessionId: session.id, profile, quality })
      : quality.action === "shrink"
        ? formatShrunkPrimeContext({
            task: resolvedTask,
            sessionId: session.id,
            profile,
            quality,
            context,
            budget: Math.min(budget, 420)
          })
        : formatPrimeContext({
      task: resolvedTask,
      sessionId: session.id,
      profile,
      budget,
      limits,
      context,
      relatedFiles: related?.related ?? [],
      testFiles: tests?.files ?? [],
      suggestedCommands
        });
    const fileRecords = this.store.listFiles(session.rootPath).filter((file) => files.includes(file.path));

    this.recordShown(session.id, "context", "brief", content);
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "prime_context",
      eventName: input.eventName ?? "prime_context",
      source: input.source ?? "cli",
      responseMode: "brief",
      baselineTokens: estimateFileBaselineTokens(fileRecords),
      outputTokens: estimateTokens(content),
      files,
      metadata: {
        ...input.metadata,
        taskHash: sha256(resolvedTask),
        profile,
        budget,
        quality,
        contextTokenEstimate: context.tokenEstimate,
        relatedCount: related?.related.length ?? 0,
        testCount: tests?.files.length ?? 0,
        estimator: "prime selected files as full-source baseline"
      }
    });
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "prime_quality",
      eventName: quality.action,
      source: input.source ?? "cli",
      responseMode: "brief",
      baselineTokens: 0,
      outputTokens: 0,
      files,
      metadata: {
        ...quality,
        taskHash: sha256(resolvedTask),
        profile
      }
    });

    return {
      session: this.getSession(session.id),
      task: resolvedTask,
      profile,
      content,
      files,
      tokenEstimate: estimateTokens(content),
      quality,
      warnings: uniqueStrings([...context.warnings, ...(related?.warnings ?? []), ...(tests?.warnings ?? [])]),
      suggestedCommands
    };
  }

  getSession(sessionId: string): TaskSession {
    return this.store.getSession(sessionId);
  }

  listSessions(input?: { limit?: number | undefined; allRoots?: boolean | undefined }): TaskSession[] {
    return this.store.listSessions({ rootPath: input?.allRoots ? undefined : this.rootPath, limit: input?.limit });
  }

  getMetrics(sessionId: string): MetricsSummary {
    const session = this.store.getSession(sessionId);
    const events = this.store.listMetricsEvents(sessionId);
    const watchEvents = this.store.listWatchEvents(sessionId);
    const evalRuns = this.store.listEvalRuns({ sessionId });
    const evalObservations = this.store.listEvalObservations({ sessionId });
    const latestCodexUsage = [...evalObservations].reverse().find((event) => event.kind === "codex_usage");
    const latestCodexUsageRecord = codexUsageFromObservation(latestCodexUsage);
    const totals = summarizeMetrics(events);

    return {
      sessionId,
      rootPath: session.rootPath,
      totals: {
        ...totals,
        savingsRate: totals.baselineTokens > 0 ? Number((totals.savedTokens / totals.baselineTokens).toFixed(4)) : 0
      },
      byKind: groupMetrics(events, (event) => event.eventKind),
      bySource: groupMetrics(events, (event) => event.source),
      watch: {
        events: watchEvents.length,
        failures: watchEvents.filter((event) => event.kind === "failure").length,
        fileChanges: watchEvents.filter((event) => event.kind === "file_change" || event.kind === "diff_change").length,
        hooks: watchEvents.filter((event) => event.source === "claude" || event.source === "codex" || event.source === "generic").length
      },
      observed: {
        evalRuns: evalRuns.length,
        observations: evalObservations.length,
        ...(latestCodexUsageRecord ? { latestCodexUsage: latestCodexUsageRecord } : {})
      },
      recentEvents: events.slice(-10)
    };
  }

  startEvalRun(input: {
    task: string;
    label: string;
    mode: EvalRunMode;
    sessionId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) {
    if (input.sessionId) this.store.getSession(input.sessionId);
    return this.store.createEvalRun({
      id: `eval_${randomUUID()}`,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      rootPath: this.rootPath,
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
    const session = this.store.getSession(input.sessionId);
    const run = input.runId
      ? this.store.getEvalRun(input.runId)
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

    const observation = this.store.recordEvalObservation({
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
      this.store.recordEvalObservation({
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
    const session = this.store.getSession(input.sessionId);
    const latestRun = this.findLatestEvalRunForSession(input.sessionId);
    const metrics = this.store.listMetricsEvents(input.sessionId);
    const observations = this.store.listEvalObservations({ sessionId: input.sessionId });
    const recommendedFiles = uniquePaths(metrics.flatMap((event) => event.files));
    const agentUsageFiles = uniquePaths(
      observations
        .filter((event) => event.kind === "agent_file_usage")
        .flatMap((event) => event.files)
    );
    const recommendedFilesUsed = recommendedFiles.filter((file) => agentUsageFiles.includes(file));
    const missedRecommendedFiles = recommendedFiles.filter((file) => !agentUsageFiles.includes(file));
    const unpromptedFilesUsed = agentUsageFiles.filter((file) => !recommendedFiles.includes(file));

    return this.store.recordEvalObservation({
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
    const run = this.store.getEvalRun(input.runId);
    const sessionId = input.sessionId ?? run.sessionId;
    const observation = this.store.recordEvalObservation({
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
    this.store.updateEvalRunStatus(run.id, input.outcome === "pass" ? "completed" : "active");
    return observation;
  }

  getEvalReport(input: { runId?: string | undefined; sessionId?: string | undefined }): EvalRunReport | { runs: EvalRunReport[] } {
    if (input.runId) return this.buildEvalReport(this.store.getEvalRun(input.runId));
    const runs = this.store
      .listEvalRuns({
        rootPath: this.rootPath,
        ...(input.sessionId ? { sessionId: input.sessionId } : {})
      })
      .map((run) => this.buildEvalReport(run));
    return { runs };
  }

  compareEvalRuns(input: { baselineRunId: string; kairnRunId: string }): EvalComparison {
    const baseline = this.buildEvalReport(this.store.getEvalRun(input.baselineRunId));
    const kairn = this.buildEvalReport(this.store.getEvalRun(input.kairnRunId));
    const baselineTokens = baseline.codexUsage?.totalTokens;
    const kairnTokens = kairn.codexUsage?.totalTokens;
    const observedTokenDelta =
      baselineTokens !== undefined && kairnTokens !== undefined
        ? {
            baselineTokens,
            kairnTokens,
            savedTokens: Math.max(0, baselineTokens - kairnTokens),
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

  async runBenchmark(input: {
    suitePath?: string | undefined;
    mode: BenchmarkRunMode;
    agentCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
    assistanceMode?: BenchmarkAssistanceMode | undefined;
  }): Promise<BenchmarkReport> {
    await this.init();
    const suite = loadBenchmarkSuite({
      suitePath: input.suitePath,
      files: this.store.listFiles(this.rootPath)
    });
    const { session } = await this.startTask(`Benchmark: ${suite.name}`);
    const run = this.store.createBenchmarkRun({
      id: `bench_${randomUUID()}`,
      rootPath: this.rootPath,
      suiteId: suite.id,
      suiteName: suite.name,
      mode: input.mode,
      status: "active",
      metadata: {
        sessionId: session.id,
        caseCount: suite.cases.length,
        agentConfigured: Boolean(input.agentCommand),
        assistanceMode: input.assistanceMode ?? "baseline"
      }
    });

    for (const benchmarkCase of suite.cases.filter((item) => benchmarkCaseApplies(item.mode, input.mode))) {
      const result =
        benchmarkCase.mode === "agent"
          ? await this.runAgentBenchmarkCase({
              runId: run.id,
              benchmarkCase,
              agentCommand: input.agentCommand,
              agentTimeoutMs: input.agentTimeoutMs,
              assistanceMode: input.assistanceMode ?? "baseline"
            })
          : await this.runReplayBenchmarkCase({
              runId: run.id,
              sessionId: session.id,
              benchmarkCase
            });
      this.store.recordBenchmarkResult(result);
    }

    const completed = this.store.updateBenchmarkRunStatus(run.id, "completed");
    return this.buildBenchmarkReport(completed.id);
  }

  async proveBenchmark(input: {
    suitePath?: string | undefined;
    baselineCommand: string;
    promptOnlyCommand?: string | undefined;
    promptPlusHooksCommand?: string | undefined;
    manualPrimeCommand?: string | undefined;
    hookFullPrimeCommand?: string | undefined;
    hookTinyDirectiveCommand?: string | undefined;
    hookTinyWithFailuresCommand?: string | undefined;
    mcpFirstCommand?: string | undefined;
    realMcpFirstCommand?: string | undefined;
    mcpFirstPlusHookFullPrimeCommand?: string | undefined;
    passiveCommand?: string | undefined;
    proactiveCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
    repeat?: number | undefined;
    shuffleOrder?: boolean | undefined;
  }): Promise<BenchmarkProofReport> {
    const repeat = Math.max(1, Math.floor(Number(input.repeat ?? 1) || 1));
    const modeCommands: Array<{ mode: BenchmarkAssistanceMode; command: string }> = [
      { mode: "baseline", command: input.baselineCommand },
      ...(input.promptOnlyCommand ?? input.passiveCommand ? [{ mode: "prompt_only" as const, command: (input.promptOnlyCommand ?? input.passiveCommand)! }] : []),
      ...(input.promptPlusHooksCommand ?? input.passiveCommand
        ? [{ mode: "prompt_plus_hooks" as const, command: (input.promptPlusHooksCommand ?? input.passiveCommand)! }]
        : []),
      ...(input.manualPrimeCommand ?? input.proactiveCommand ? [{ mode: "manual_prime" as const, command: (input.manualPrimeCommand ?? input.proactiveCommand)! }] : []),
      ...(input.hookFullPrimeCommand ? [{ mode: "hook_full_prime" as const, command: input.hookFullPrimeCommand }] : []),
      ...(input.hookTinyDirectiveCommand ? [{ mode: "hook_tiny_directive" as const, command: input.hookTinyDirectiveCommand }] : []),
      ...(input.hookTinyWithFailuresCommand ? [{ mode: "hook_tiny_with_failures" as const, command: input.hookTinyWithFailuresCommand }] : []),
      ...(input.mcpFirstCommand ? [{ mode: "mcp_first" as const, command: input.mcpFirstCommand }] : []),
      ...(input.realMcpFirstCommand ? [{ mode: "real_mcp_first" as const, command: input.realMcpFirstCommand }] : []),
      ...(input.mcpFirstPlusHookFullPrimeCommand ? [{ mode: "mcp_first_plus_hook_full_prime" as const, command: input.mcpFirstPlusHookFullPrimeCommand }] : [])
    ];
    const baselineReports: BenchmarkReport[] = [];
    const promptOnlyReports: BenchmarkReport[] = [];
    const promptPlusHooksReports: BenchmarkReport[] = [];
    const manualPrimeReports: BenchmarkReport[] = [];
    const hookFullPrimeReports: BenchmarkReport[] = [];
    const hookTinyDirectiveReports: BenchmarkReport[] = [];
    const hookTinyWithFailuresReports: BenchmarkReport[] = [];
    const mcpFirstReports: BenchmarkReport[] = [];
    const realMcpFirstReports: BenchmarkReport[] = [];
    const mcpFirstPlusHookFullPrimeReports: BenchmarkReport[] = [];

    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const order = input.shuffleOrder ? shuffleItems(modeCommands) : modeCommands;
      for (const item of order) {
        const report = await this.runProofModeBenchmark({
          suitePath: input.suitePath,
          command: item.command,
          agentTimeoutMs: input.agentTimeoutMs,
          assistanceMode: item.mode
        });
        if (item.mode === "baseline") baselineReports.push(report);
        if (item.mode === "prompt_only" || item.mode === "passive_hooks") promptOnlyReports.push(report);
        if (item.mode === "prompt_plus_hooks") promptPlusHooksReports.push(report);
        if (item.mode === "manual_prime" || item.mode === "proactive") manualPrimeReports.push(report);
        if (item.mode === "hook_full_prime") hookFullPrimeReports.push(report);
        if (item.mode === "hook_tiny_directive") hookTinyDirectiveReports.push(report);
        if (item.mode === "hook_tiny_with_failures") hookTinyWithFailuresReports.push(report);
        if (item.mode === "mcp_first") mcpFirstReports.push(report);
        if (item.mode === "real_mcp_first") realMcpFirstReports.push(report);
        if (item.mode === "mcp_first_plus_hook_full_prime") mcpFirstPlusHookFullPrimeReports.push(report);
      }
    }

    if (baselineReports.length === 0) {
      baselineReports.push(await this.runProofModeBenchmark({
        suitePath: input.suitePath,
        command: input.baselineCommand,
        agentTimeoutMs: input.agentTimeoutMs,
        assistanceMode: "baseline"
      }));
    }

    return buildBenchmarkProofReport({
      baseline: baselineReports,
      promptOnly: promptOnlyReports,
      promptPlusHooks: promptPlusHooksReports,
      manualPrime: manualPrimeReports,
      hookFullPrime: hookFullPrimeReports,
      hookTinyDirective: hookTinyDirectiveReports,
      hookTinyWithFailures: hookTinyWithFailuresReports,
      mcpFirst: mcpFirstReports,
      realMcpFirst: realMcpFirstReports,
      mcpFirstPlusHookFullPrime: mcpFirstPlusHookFullPrimeReports,
      repeat
    });
  }

  private async runProofModeBenchmark(input: {
    suitePath?: string | undefined;
    command: string;
    agentTimeoutMs?: number | undefined;
    assistanceMode: BenchmarkAssistanceMode;
  }): Promise<BenchmarkReport> {
    try {
      return await this.runBenchmark({
        suitePath: input.suitePath,
        mode: "agent",
        agentCommand: input.command,
        agentTimeoutMs: input.agentTimeoutMs,
        assistanceMode: input.assistanceMode
      });
    } catch (error) {
      return this.buildFailedProofModeReport({
        suitePath: input.suitePath,
        assistanceMode: input.assistanceMode,
        error
      });
    }
  }

  private buildFailedProofModeReport(input: {
    suitePath?: string | undefined;
    assistanceMode: BenchmarkAssistanceMode;
    error: unknown;
  }): BenchmarkReport {
    const suite = loadBenchmarkSuite({
      suitePath: input.suitePath,
      files: this.store.listFiles(this.rootPath)
    });
    const session = this.store.createSession({
      id: `task_${randomUUID()}`,
      rootPath: this.rootPath,
      task: `Failed benchmark mode: ${input.assistanceMode}`,
      verificationHints: ["Inspect benchmark mode setup before trusting token deltas."]
    });
    const run = this.store.createBenchmarkRun({
      id: `bench_${randomUUID()}`,
      rootPath: this.rootPath,
      suiteId: suite.id,
      suiteName: suite.name,
      mode: "agent",
      status: "active",
      metadata: {
        sessionId: session.id,
        caseCount: suite.cases.length,
        agentConfigured: true,
        assistanceMode: input.assistanceMode,
        modeError: input.error instanceof Error ? input.error.message : String(input.error)
      }
    });

    for (const benchmarkCase of suite.cases.filter((item) => benchmarkCaseApplies(item.mode, "agent"))) {
      this.store.recordBenchmarkResult({
        runId: run.id,
        caseId: benchmarkCase.id,
        caseMode: benchmarkCase.mode,
        score: 0,
        expectedFileRecall: 0,
        topKHitRate: 0,
        unexpectedFileRate: 0,
        responseTokens: 0,
        hookContextEmitted: 0,
        hookContextSuppressed: 0,
        taskOutcome: "fail",
        expectedFiles: benchmarkCase.expectedFiles,
        actualFiles: [],
        excludedFiles: benchmarkCase.excludedFiles,
        summary: `Benchmark mode ${input.assistanceMode} failed before producing a result.`,
        recommendations: ["Fix this proof mode before using its token delta."],
        metadata: {
          assistanceMode: input.assistanceMode,
          modeError: input.error instanceof Error ? input.error.message : String(input.error)
        }
      });
    }

    this.store.updateBenchmarkRunStatus(run.id, "abandoned");
    return this.buildBenchmarkReport(run.id);
  }

  getBenchmarkReport(input: { runId?: string | undefined }): BenchmarkReport | { runs: BenchmarkReport[] } {
    if (input.runId) return this.buildBenchmarkReport(input.runId);
    return {
      runs: this.store.listBenchmarkRuns({ rootPath: this.rootPath }).map((run) => this.buildBenchmarkReport(run.id))
    };
  }

  compareBenchmarkRuns(input: { beforeRunId: string; afterRunId: string }): BenchmarkComparison {
    return compareBenchmarkReports(this.buildBenchmarkReport(input.beforeRunId), this.buildBenchmarkReport(input.afterRunId));
  }

  async findContext(input: {
    sessionId: string;
    query?: string | undefined;
    requestType?: "initial_brief" | "find_context" | undefined;
    budget?: number | undefined;
    mode?: ContextQueryMode | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const files = await this.refreshIndex(session.rootPath);
    const symbols = this.store.listSymbols(session.rootPath);
    const edges = this.store.listGraphEdges(session.rootPath);
    const chunks = this.store.listSemanticChunks(session.rootPath);
    const vectors = this.store.listSemanticVectors(session.rootPath);
    const lexicalDocuments = this.store.listLexicalDocuments(session.rootPath);
    const lexicalTerms = this.store.listLexicalTerms(session.rootPath);
    const lexicalStats = this.store.getLexicalStats(session.rootPath);
    const changedFiles = await this.getChangedFiles(session.rootPath);
    const query = input.query ?? session.task;
    const intent = classifyQueryIntent(query);
    const scored = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors,
      lexicalDocuments,
      lexicalTerms,
      lexicalStats,
      edges,
      shown: session.filesShown,
      changedFiles
    }).slice(0, 12);
    const repeatedFiles = scored.filter((file) => file.reasons.includes("already shown")).length;
    const decision = decideResponse({
      requestType: input.requestType ?? "find_context",
      query,
      repeatedFiles,
      graphAvailable: edges.length > 0,
      ...(input.mode ? { explicitMode: input.mode } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(scored[0] ? { topScore: scored[0].score } : {})
    });
    const content = truncateToBudget(
      formatContextResults({
        title: input.requestType === "initial_brief" ? "Kairn Context Brief" : "Kairn Context Results",
        task: session.task,
        query,
        decisionReason: decision.reason,
        mode: decision.mode,
        intent,
        scored,
        ...(input.budget ? { budget: input.budget } : {})
      }),
      input.budget
    );

    this.recordShown(input.sessionId, "context", decision.mode, content);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "find_context",
      eventName: input.requestType ?? "find_context",
      responseMode: decision.mode,
      baselineTokens: estimateFileBaselineTokens(scored.slice(0, 5)),
      outputTokens: estimateTokens(content),
      files: scored.slice(0, 5).map((file) => file.path),
      metadata: {
        query,
        resultCount: scored.length,
        estimator: "top 5 ranked files as full-source baseline"
      }
    });

    return {
      mode: decision.mode,
      content,
      files: scored.map((file) => file.path),
      symbols: [],
      related: [],
      warnings:
        scored.length === 0
          ? [...decision.warnings, "No hybrid retrieval matches found. Try a more specific query."]
          : decision.warnings,
      suggestedNextContext: scored.slice(0, 5).map((file) => file.path),
      tokenEstimate: estimateTokens(content)
    };
  }

  async readFile(input: {
    sessionId: string;
    target: string;
    mode?: "exact" | "summary" | undefined;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const target = normalizeRelativePath(input.target);
    const files = await this.refreshIndex(session.rootPath);
    const file = files.find((record) => record.path === target);

    if (!file) {
      throw new Error(`File is not in Kairn inventory: ${target}`);
    }

    const content = readTextFile(session.rootPath, target);
    const exact = input.mode === "exact" || input.mode === undefined;
    const responseContent = exact
      ? truncateToBudget(
          [`# Exact Source`, "", `## ${target}`, "", "```", content, "```"].join("\n"),
          input.budget ?? 3000
        )
      : truncateToBudget(summarizeFile(file, content), input.budget ?? 1600);
    const mode = exact ? "exact_code" : "compressed_summary";

    this.store.recordContextShown({
      sessionId: input.sessionId,
      kind: exact ? "file" : "summary",
      filePath: target,
      mode,
      contentHash: sha256(responseContent)
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "read_file",
      eventName: exact ? "read_file_exact" : "read_file_summary",
      responseMode: mode,
      baselineTokens: estimateTokens(content),
      outputTokens: estimateTokens(responseContent),
      files: [target],
      metadata: {
        target,
        requestedMode: input.mode ?? "exact",
        estimator: "full target file as baseline"
      }
    });

    return {
      mode,
      content: responseContent,
      files: [target],
      symbols: [],
      related: [],
      warnings: [],
      suggestedNextContext: [],
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async readSymbol(input: {
    sessionId: string;
    target: string;
    symbol: string;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const target = normalizeRelativePath(input.target);
    await this.refreshIndex(session.rootPath);
    const content = readTextFile(session.rootPath, target);
    const storedSymbol = this.store.findSymbol(session.rootPath, target, input.symbol);
    const fallbackSymbol = storedSymbol ? null : extractSymbol(content, input.symbol);
    const symbol = storedSymbol
      ? {
          snippet: sliceLines(content, storedSymbol.startLine, storedSymbol.endLine),
          startLine: storedSymbol.startLine,
          endLine: storedSymbol.endLine
        }
      : fallbackSymbol;

    if (!symbol) {
      const warning = `Symbol "${input.symbol}" was not found in ${target} with the lightweight extractor.`;
      const responseContent = [`# Symbol Not Found`, "", warning].join("\n");
      return {
        mode: "compressed_summary",
        content: responseContent,
        files: [target],
        symbols: [],
        related: [],
        warnings: [warning],
        suggestedNextContext: [target],
        tokenEstimate: estimateTokens(responseContent)
      };
    }

    const responseContent = truncateToBudget(
      [
        "# Exact Symbol Source",
        "",
        `File: ${target}`,
        `Symbol: ${input.symbol}`,
        `Lines: ${symbol.startLine}-${symbol.endLine}`,
        "",
        "```",
        symbol.snippet,
        "```"
      ].join("\n"),
      input.budget ?? 2000
    );

    this.store.recordContextShown({
      sessionId: input.sessionId,
      kind: "symbol",
      filePath: target,
      symbol: input.symbol,
      mode: "exact_code",
      contentHash: sha256(responseContent)
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "read_symbol",
      eventName: "read_symbol",
      responseMode: "exact_code",
      baselineTokens: estimateTokens(content),
      outputTokens: estimateTokens(responseContent),
      files: [target],
      metadata: {
        target,
        symbol: input.symbol,
        estimator: "full target file as baseline"
      }
    });

    return {
      mode: "exact_code",
      content: responseContent,
      files: [target],
      symbols: [input.symbol],
      related: [],
      warnings: [],
      suggestedNextContext: [],
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async getRelatedFiles(input: {
    sessionId: string;
    target: string;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const target = normalizeRelativePath(input.target);
    const files = await this.refreshIndex(session.rootPath);
    const graphRelated = this.getGraphRelatedFiles(session.rootPath, target);
    const semanticRelated = this.getSemanticRelatedFiles(session.rootPath, target, files);
    const relatedByPath = new Map<string, { file: FileRecord; reason: string }>();

    for (const item of [...graphRelated, ...semanticRelated]) {
      const existing = relatedByPath.get(item.file.path);
      relatedByPath.set(item.file.path, {
        file: item.file,
        reason: mergeReasonText(existing?.reason, item.reason)
      });
    }

    if (relatedByPath.size === 0) {
      for (const file of findRelatedFiles(session.rootPath, files, target)) {
        relatedByPath.set(file.path, { file, reason: "heuristic fallback" });
      }
    }

    const related = [...relatedByPath.values()]
      .sort((a, b) => b.file.importance - a.file.importance || a.file.path.localeCompare(b.file.path))
      .slice(0, 20);
    const responseContent = truncateToBudget(
      [
        "# Related Files",
        "",
        `Target: ${target}`,
        "",
        related.length > 0
          ? related
              .map(({ file, reason }) => `- ${file.path} (${file.kind}, importance ${file.importance}): ${reason}`)
              .join("\n")
          : "No related files found from deterministic heuristics."
      ].join("\n"),
      input.budget ?? 1200
    );

    this.recordShown(input.sessionId, "context", "graph_neighbors", responseContent, target);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "related",
      eventName: "related",
      responseMode: "graph_neighbors",
      baselineTokens: estimateFileBaselineTokens(related.map(({ file }) => file)),
      outputTokens: estimateTokens(responseContent),
      files: related.map(({ file }) => file.path),
      metadata: {
        target,
        resultCount: related.length,
        estimator: "related files as full-source baseline"
      }
    });

    return {
      mode: "graph_neighbors",
      content: responseContent,
      files: [target],
      symbols: [],
      related: related.map(({ file }) => file.path),
      warnings: related.length === 0 ? ["No related files found from graph or fallback heuristics."] : [],
      suggestedNextContext: related.slice(0, 5).map(({ file }) => file.path),
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async findTests(input: {
    sessionId: string;
    target?: string | undefined;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const files = await this.refreshIndex(session.rootPath);
    const target = input.target ? normalizeRelativePath(input.target) : undefined;
    const graphTests = target ? this.getGraphTests(session.rootPath, target) : [];
    const semanticTests = this.getSemanticTests(session.rootPath, files, target, session.task);
    const testsByPath = new Map<string, FileRecord>();

    for (const file of [...graphTests, ...semanticTests]) {
      testsByPath.set(file.path, file);
    }

    if (testsByPath.size === 0) {
      for (const file of findTestsFor(files, target)) {
        testsByPath.set(file.path, file);
      }
    }

    const tests = [...testsByPath.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, 30);
    const packageScripts = this.readPackageScripts(session.rootPath);
    const responseContent = truncateToBudget(
      [
        "# Related Tests",
        "",
        target ? `Target: ${target}` : `Task: ${session.task}`,
        "",
        "## Test Files",
        tests.length > 0 ? tests.map((file) => `- ${file.path}`).join("\n") : "No matching test files found.",
        "",
        "## Package Scripts",
        packageScripts.length > 0 ? packageScripts.map((script) => `- ${script}`).join("\n") : "No package scripts found."
      ].join("\n"),
      input.budget ?? 1200
    );

    this.recordShown(input.sessionId, "tests", "brief", responseContent, input.target);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "tests",
      eventName: "find_tests",
      responseMode: "brief",
      baselineTokens: estimateFileBaselineTokens(tests),
      outputTokens: estimateTokens(responseContent),
      files: tests.map((file) => file.path),
      metadata: {
        ...(target ? { target } : {}),
        resultCount: tests.length,
        estimator: "test files as full-source baseline"
      }
    });

    return {
      mode: "brief",
      content: responseContent,
      files: tests.map((file) => file.path),
      symbols: [],
      related: [],
      warnings: tests.length === 0 ? ["No related tests found by filename/path heuristics."] : [],
      suggestedNextContext: tests.slice(0, 5).map((file) => file.path),
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async reviewDiff(input: { sessionId: string; budget?: number | undefined }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const review = await reviewGitDiff(session.rootPath, session);
    const content = truncateToBudget(review.summary, input.budget ?? 1600);

    this.store.recordDiff({
      sessionId: input.sessionId,
      files: review.files,
      summary: content
    });

    this.store.recordContextShown({
      sessionId: input.sessionId,
      kind: "diff",
      mode: "verification_plan",
      contentHash: sha256(content)
    });
    const changedFileRecords = this.store.listFiles(session.rootPath).filter((file) => review.files.includes(file.path));
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "diff",
      eventName: "review_diff",
      responseMode: "verification_plan",
      baselineTokens: estimateFileBaselineTokens(changedFileRecords),
      outputTokens: estimateTokens(content),
      files: review.files,
      metadata: {
        changedFiles: review.files.length,
        missingContextFiles: review.missingContextFiles.length,
        estimator: "changed files as full-source baseline"
      }
    });

    return {
      mode: "verification_plan",
      content,
      files: review.files,
      symbols: [],
      related: review.missingContextFiles,
      warnings:
        review.missingContextFiles.length > 0
          ? ["Some changed files were not previously shown by Kairn."]
          : [],
      suggestedNextContext: review.missingContextFiles,
      tokenEstimate: estimateTokens(content)
    };
  }

  async getFailureContext(input: {
    sessionId: string;
    type: OutputKind;
    output?: string | undefined;
    files?: string[] | undefined;
    command?: string | undefined;
    budget?: number | undefined;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | undefined;
    eventName?: string | undefined;
  }): Promise<FailureContext> {
    const session = this.store.getSession(input.sessionId);
    await this.refreshIndex(session.rootPath);
    const knownFiles = this.store.listFiles(session.rootPath).map((file) => file.path);
    const failureFiles = extractFailureFiles({
      output: input.output,
      rootPath: session.rootPath,
      knownFiles,
      explicitFiles: input.files
    });
    const changedFiles = [...(await this.getChangedFiles(session.rootPath))].sort();
    const seedFiles = uniquePaths([...failureFiles, ...changedFiles]).slice(0, 4);
    const relatedFiles = new Set<string>();
    const testFiles = new Set<string>();
    const warnings: string[] = [];

    for (const file of seedFiles) {
      try {
        const related = await this.getRelatedFiles({ sessionId: input.sessionId, target: file, budget: 500 });
        for (const relatedFile of related.suggestedNextContext.slice(0, 4)) relatedFiles.add(relatedFile);
      } catch {
        warnings.push(`Could not resolve related files for ${file}.`);
      }

      try {
        const tests = await this.findTests({ sessionId: input.sessionId, target: file, budget: 500 });
        for (const testFile of tests.suggestedNextContext.slice(0, 4)) testFiles.add(testFile);
      } catch {
        warnings.push(`Could not resolve tests for ${file}.`);
      }
    }

    const outputSummary = input.output ? compressOutputText(input.output, input.type, 480) : "";
    const files = uniquePaths([...failureFiles, ...relatedFiles, ...testFiles, ...changedFiles]).slice(0, 12);
    const content = truncateToBudget(
      [
        "# Kairn Failure Context",
        "",
        input.command ? `Command: ${input.command}` : undefined,
        `Output kind: ${input.type}`,
        failureFiles.length > 0 ? `Failure files: ${failureFiles.join(", ")}` : "Failure files: none detected.",
        changedFiles.length > 0 ? `Changed files: ${changedFiles.slice(0, 8).join(", ")}` : undefined,
        relatedFiles.size > 0 ? `Related source: ${[...relatedFiles].slice(0, 8).join(", ")}` : undefined,
        testFiles.size > 0 ? `Likely tests: ${[...testFiles].slice(0, 8).join(", ")}` : undefined,
        "",
        outputSummary ? "## Compressed Failure Output" : undefined,
        outputSummary || undefined,
        "",
        "## Agent Guidance",
        "- Inspect failure files first, then related source/tests.",
        "- Avoid broad scans until these files are insufficient."
      ].filter(Boolean).join("\n"),
      input.budget ?? 1200
    );

    this.store.recordCommand({
      sessionId: input.sessionId,
      type: input.type,
      summary: content
    });
    this.recordShown(input.sessionId, "context", "failure_context", content);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "failure_context",
      eventName: input.eventName ?? "failure_context",
      source: input.source ?? "runtime",
      responseMode: "failure_context",
      baselineTokens: input.output ? estimateTokens(input.output) + estimateFileBaselineTokens(this.store.listFiles(session.rootPath).filter((file) => files.includes(file.path))) : 0,
      outputTokens: estimateTokens(content),
      files,
      metadata: {
        outputKind: input.type,
        failureFiles: failureFiles.length,
        relatedFiles: relatedFiles.size,
        testFiles: testFiles.size,
        changedFiles: changedFiles.length,
        estimator: "raw failure output plus linked full-source files as baseline"
      }
    });

    return {
      session: this.getSession(input.sessionId),
      type: input.type,
      content,
      files,
      failureFiles,
      relatedFiles: [...relatedFiles],
      testFiles: [...testFiles],
      changedFiles,
      tokenEstimate: estimateTokens(content),
      warnings: uniqueStrings(warnings)
    };
  }

  async getNextContext(input: {
    sessionId: string;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const latestFailure = [...this.store.listWatchEvents(input.sessionId)]
      .reverse()
      .find((event) => event.kind === "failure" && event.files.length > 0);

    if (latestFailure?.files[0]) {
      const related = await this.getRelatedFiles({
        sessionId: input.sessionId,
        target: latestFailure.files[0],
        budget: 500
      });
      const nextReads = uniquePaths([latestFailure.files[0], ...related.suggestedNextContext]).slice(0, 2);
      const content = truncateToBudget(
        [
          "# Kairn Next Context",
          "",
          `Latest failure file: ${latestFailure.files[0]}`,
          "",
          "## Next Reads",
          ...nextReads.map((file) => `- ${file}`),
          "",
          "Agent guidance: inspect these files before broad scans."
        ].join("\n"),
        input.budget ?? 700
      );
      return {
        ...related,
        content,
        files: nextReads,
        related: nextReads.filter((file) => file !== latestFailure.files[0]),
        suggestedNextContext: nextReads,
        tokenEstimate: estimateTokens(content),
        warnings: uniqueStrings([...related.warnings, "Next context selected from latest failure event."])
      };
    }

    const diff = await this.reviewDiff({ sessionId: input.sessionId, budget: input.budget ?? 900 });
    if (diff.suggestedNextContext.length > 0) {
      const nextReads = diff.suggestedNextContext.slice(0, 2);
      const content = truncateToBudget(
        [
          "# Kairn Next Context",
          "",
          "Current diff has files that Kairn has not shown yet.",
          "",
          "## Next Reads",
          ...nextReads.map((file) => `- ${file}`),
          "",
          "Agent guidance: read the smallest missing diff context before broader review."
        ].join("\n"),
        input.budget ?? 700
      );
      return {
        ...diff,
        content,
        files: nextReads,
        suggestedNextContext: nextReads,
        tokenEstimate: estimateTokens(content),
        warnings: uniqueStrings([...diff.warnings, "Next context selected from current diff."])
      };
    }

    return this.findContext({
      sessionId: input.sessionId,
      query: session.task,
      requestType: "find_context",
      budget: input.budget ?? 900,
      mode: "brief"
    });
  }

  recordMcpToolCall(input: {
    toolName: string;
    sessionId?: string | undefined;
    result: unknown;
    input?: unknown;
  }): void {
    const sessionId = input.sessionId ?? sessionIdFromMcpValue(input.result) ?? sessionIdFromMcpValue(input.input);
    if (!sessionId) return;

    let session: TaskSession;
    try {
      session = this.store.getSession(sessionId);
    } catch {
      return;
    }

    const files = uniquePaths([
      ...filesFromMcpValue(input.result),
      ...filesFromMcpValue(input.input)
    ]);
    this.recordMetricsEvent({
      sessionId,
      rootPath: session.rootPath,
      eventKind: "mcp_tool_call",
      eventName: input.toolName,
      source: "mcp",
      baselineTokens: 0,
      outputTokens: tokenEstimateFromMcpValue(input.result),
      files,
      metadata: {
        toolName: input.toolName,
        resultFileCount: files.length,
        resultMode: responseModeFromMcpValue(input.result)
      }
    });
  }

  compressOutput(input: {
    sessionId: string;
    type: OutputKind;
    output: string;
    budget?: number | undefined;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | undefined;
    eventName?: string | undefined;
  }): ContextResponse {
    const session = this.store.getSession(input.sessionId);
    const content = compressOutputText(input.output, input.type, input.budget);

    this.store.recordCommand({
      sessionId: input.sessionId,
      type: input.type,
      summary: content
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "compression",
      eventName: input.eventName ?? `compress_${input.type}`,
      source: input.source ?? "runtime",
      responseMode: "failure_context",
      baselineTokens: estimateTokens(input.output),
      outputTokens: estimateTokens(content),
      files: [],
      metadata: {
        outputKind: input.type,
        estimator: "raw command output as baseline"
      }
    });

    return {
      mode: "failure_context",
      content,
      files: [],
      symbols: [],
      related: [],
      warnings: [],
      suggestedNextContext: [],
      tokenEstimate: estimateTokens(content)
    };
  }

  async recordFileChanges(input: {
    sessionId: string;
    files: string[];
    source?: WatchEventSource | undefined;
    eventName?: string | undefined;
  }): Promise<WatchEventRecord | undefined> {
    this.store.getSession(input.sessionId);
    const files = uniquePaths(input.files);
    if (files.length === 0) return undefined;

    return this.recordWatchEvent({
      sessionId: input.sessionId,
      source: input.source ?? "watch",
      kind: "file_change",
      eventName: input.eventName ?? "FileChanged",
      files,
      summary: `Files changed: ${files.join(", ")}`,
      metadata: { count: files.length }
    });
  }

  async createWatchSnapshot(input: {
    sessionId: string;
    changedFiles?: string[] | undefined;
    source?: WatchEventSource | undefined;
  }): Promise<WatchSnapshot> {
    const session = this.store.getSession(input.sessionId);
    const files = await this.refreshIndex(session.rootPath);
    const explicitlyChanged = uniquePaths(input.changedFiles ?? []);

    if (explicitlyChanged.length > 0) {
      await this.recordFileChanges({
        sessionId: input.sessionId,
        files: explicitlyChanged,
        source: input.source ?? "watch"
      });
    }

    const changedFiles = [...(await this.getChangedFiles(session.rootPath))].sort();
    const recommendations: WatchRecommendation[] = [];

    if (changedFiles.length > 0) {
      const changeHash = sha256(changedFiles.join("\n"));
      const lastDiffEvent = [...this.store.listWatchEvents(input.sessionId)]
        .reverse()
        .find((event) => event.kind === "diff_change");

      if (lastDiffEvent?.contentHash !== changeHash) {
        const diff = await reviewGitDiff(session.rootPath, session);
        this.store.recordDiff({
          sessionId: input.sessionId,
          files: diff.files,
          summary: diff.summary
        });
        this.recordWatchEvent({
          sessionId: input.sessionId,
          source: input.source ?? "watch",
          kind: "diff_change",
          eventName: "GitDiffChanged",
          files: changedFiles,
          summary: diff.summary,
          contentHash: changeHash,
          metadata: {
            expectedFilesTouched: diff.expectedFilesTouched,
            unexpectedFiles: diff.unexpectedFiles,
            missingContextFiles: diff.missingContextFiles
          }
        });

        if (diff.missingContextFiles.length > 0) {
          recommendations.push({
            summary: "Changed files include files not previously shown by Kairn.",
            files: diff.missingContextFiles,
            suggestedNextContext: diff.missingContextFiles.slice(0, 5),
            warnings: ["Review missing changed-file context before continuing."],
            content: diff.summary
          });
        }
      }
    }

    return {
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      changedFiles,
      indexedFiles: files.length,
      watchEvents: this.store.listWatchEvents(input.sessionId, 25),
      recommendations,
      createdAt: nowIso()
    };
  }

  async handleHookEvent(input: {
    sessionId?: string | undefined;
    event: NormalizedHookEvent;
    primeBudget?: number | undefined;
    primeProfile?: PrimeProfile | undefined;
    hookOutput?: HookOutputProfile | undefined;
    transport?: "cli" | "daemon" | undefined;
    daemonAttempted?: boolean | undefined;
    daemonHit?: boolean | undefined;
    refreshIndex?: boolean | undefined;
  }): Promise<HookHandlingResult> {
    const hookStartedAt = Date.now();
    const hookOutput = input.hookOutput ?? "full-prime";
    const session = await this.resolveHookSession({
      sessionId: input.sessionId,
      event: input.event
    });
    const refreshStartedAt = Date.now();
    if (input.refreshIndex ?? true) {
      await this.refreshIndex(session.rootPath);
    }
    const refreshIndexMs = Date.now() - refreshStartedAt;
    const knownFiles = this.store.listFiles(session.rootPath).map((file) => file.path);
    const outputKind = classifyObservedCommand({
      command: input.event.command,
      output: input.event.output,
      eventName: input.event.eventName
    });
    const linkedFiles = extractFailureFiles({
      output: input.event.output,
      rootPath: session.rootPath,
      knownFiles,
      explicitFiles: input.event.files
    });
    const kind = input.event.exitCode && input.event.exitCode !== 0 ? "failure" : input.event.kind;
    const promptHash = input.event.output && isPromptEvent(input.event.eventName) ? sha256(input.event.output) : undefined;
    const duplicatePromptPrime = Boolean(
      promptHash &&
        isHighConfidencePrompt(input.event.eventName, input.event.output) &&
        this.hasPromptPrimeForHook({
          sessionId: session.id,
          event: input.event,
          promptHash
        })
    );
    let primeElapsedMs = 0;
    const shouldPrimePrompt =
      hookOutput !== "failure-only" &&
      promptHash &&
      !duplicatePromptPrime &&
      isHighConfidencePrompt(input.event.eventName, input.event.output);
    const prime = shouldPrimePrompt
      ? await (async () => {
          const startedAt = Date.now();
          try {
            return await this.primeContext({
              task: input.event.output!,
              sessionId: session.id,
              budget: input.primeBudget ?? 1200,
              mode: "snippets",
              profile: input.primeProfile ?? "auto",
              source: input.event.source,
              eventName: "prime_context_hook",
              metadata: {
                promptHash,
                hostSessionId: input.event.hostSessionId ?? null,
                turnId: stringMetadata(input.event.metadata, "turn_id") ?? null,
                hookEventName: input.event.eventName,
                hookOutput,
                transport: input.transport ?? "cli"
              }
            });
          } finally {
            primeElapsedMs = Date.now() - startedAt;
          }
        })()
      : undefined;
    const emittedPrime = prime?.quality?.action === "suppress"
      ? undefined
      : prime && hookOutput === "tiny-directive"
        ? withTinyDirectivePrime(prime, input.primeBudget ?? 600)
        : prime;
    const failureContext = kind === "failure"
      ? await this.getFailureContext({
          sessionId: session.id,
          type: outputKind,
          output: input.event.output,
          files: linkedFiles,
          command: input.event.command,
          budget: 1000,
          source: input.event.source,
          eventName: input.event.eventName
        })
      : undefined;
    const failureOnlyNonFailure = hookOutput === "failure-only" && kind !== "failure";
    const shouldCompressOutput =
      Boolean(input.event.output) &&
      !isPromptEvent(input.event.eventName) &&
      !failureContext &&
      !failureOnlyNonFailure &&
      !isTrivialSuccessfulHook({
        eventKind: kind,
        command: input.event.command,
        output: input.event.output,
        linkedFiles,
        exitCode: input.event.exitCode
      });
    const response = shouldCompressOutput
      ? this.compressOutput({
          sessionId: session.id,
          type: outputKind,
          output: input.event.output!,
          budget: 1200,
          source: input.event.source,
          eventName: input.event.eventName
        })
      : undefined;
    const recommendation = emittedPrime
      ? undefined
      : failureContext
        ? failureRecommendation(failureContext)
        : failureOnlyNonFailure
          ? undefined
        : await this.recommendFromHook({
          sessionId: session.id,
          command: input.event.command,
          response,
          linkedFiles,
          outputKind,
          eventKind: kind
        });
    const summary = [
      input.event.command ? `Command: ${input.event.command}` : `Event: ${input.event.eventName}`,
      input.event.toolName ? `Tool: ${input.event.toolName}` : "",
      input.event.exitCode !== undefined ? `Exit code: ${input.event.exitCode}` : "",
      linkedFiles.length > 0 ? `Linked files: ${linkedFiles.join(", ")}` : "",
      emittedPrime?.content ? emittedPrime.content : failureContext?.content ? failureContext.content : response?.content ? response.content : ""
    ].filter(Boolean).join("\n\n");
    const event = this.recordWatchEvent({
      sessionId: session.id,
      source: input.event.source,
      kind,
      eventName: input.event.eventName,
      toolName: input.event.toolName,
      command: input.event.command,
      files: linkedFiles,
      exitCode: input.event.exitCode,
      summary: truncateToBudget(summary, 1200),
      metadata: {
        ...input.event.metadata,
        outputKind,
        ...(input.event.cwd ? { cwd: input.event.cwd } : {}),
        ...(input.event.hostSessionId ? { hostSessionId: input.event.hostSessionId } : {}),
        ...(input.event.timestamp ? { timestamp: input.event.timestamp } : {}),
        ...(promptHash ? { promptHash } : {}),
        ...(duplicatePromptPrime ? { duplicatePromptPrime: true } : {}),
        hookOutput,
        transport: input.transport ?? "cli",
        daemonAttempted: Boolean(input.daemonAttempted),
        daemonHit: Boolean(input.daemonHit),
        refreshIndexMs,
        primeElapsedMs,
        hookLatencyMs: Date.now() - hookStartedAt
      }
    });
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "hook_signal",
      eventName: emittedPrime || recommendation ? "hook_recommendation_emitted" : "hook_recommendation_suppressed",
      source: input.event.source,
      baselineTokens: 0,
      outputTokens: emittedPrime?.content ? estimateTokens(emittedPrime.content) : failureContext?.tokenEstimate ?? (recommendation?.content ? estimateTokens(recommendation.content) : 0),
      files: emittedPrime?.files ?? failureContext?.files ?? recommendation?.files ?? linkedFiles,
      metadata: {
        eventName: input.event.eventName,
        hookKind: kind,
        outputKind,
        hookOutput,
        transport: input.transport ?? "cli",
        daemonAttempted: Boolean(input.daemonAttempted),
        daemonHit: Boolean(input.daemonHit),
        refreshIndexMs,
        primeElapsedMs,
        hookLatencyMs: Date.now() - hookStartedAt,
        linkedFiles: linkedFiles.length,
        recommendation: emittedPrime ? (hookOutput === "tiny-directive" ? "tiny_prime_emitted" : "prime_emitted") : prime ? "prime_quality_suppressed" : recommendation ? "emitted" : duplicatePromptPrime ? "duplicate_suppressed" : promptHash ? "prompt_suppressed" : "suppressed",
        proactivePrime: Boolean(emittedPrime),
        primeQuality: prime?.quality,
        failureContext: Boolean(failureContext),
        duplicatePromptPrime,
        compressedOutput: Boolean(response),
        trivialSuccessfulOutput: Boolean(input.event.output) && !shouldCompressOutput && !response
      }
    });

    return {
      session: this.getSession(session.id),
      event,
      ...(recommendation ? { recommendation } : {}),
      ...(response ? { response } : {}),
      ...(failureContext ? { failureContext } : {}),
      ...(emittedPrime ? { prime: emittedPrime } : {})
    };
  }

  listWatchEvents(sessionId: string, limit?: number): WatchEventRecord[] {
    this.store.getSession(sessionId);
    return this.store.listWatchEvents(sessionId, limit);
  }

  private async resolveHookSession(input: {
    sessionId?: string | undefined;
    event: NormalizedHookEvent;
  }): Promise<TaskSession> {
    const hostSessionId = hostSessionIdForEvent(input.event);

    if (input.sessionId) {
      const session = this.store.getSession(input.sessionId);
      if (hostSessionId) {
        this.store.upsertHostSessionLink({
          source: input.event.source,
          rootPath: session.rootPath,
          hostSessionId,
          sessionId: session.id,
          metadata: hostSessionMetadata(input.event)
        });
      }
      return session;
    }

    if (hostSessionId) {
      const link = this.store.getHostSessionLink({
        source: input.event.source,
        rootPath: this.rootPath,
        hostSessionId
      });
      if (link) {
        this.store.upsertHostSessionLink({
          source: input.event.source,
          rootPath: this.rootPath,
          hostSessionId,
          sessionId: link.sessionId,
          metadata: hostSessionMetadata(input.event)
        });
        return this.store.getSession(link.sessionId);
      }
    }

    const session = this.store.createSession({
      id: `task_${randomUUID()}`,
      rootPath: this.rootPath,
      task: taskFromHookEvent(input.event),
      verificationHints: ["Start from Kairn hook context", "Avoid broad scans unless Kairn context is insufficient", "Run related tests before finalizing"]
    });

    if (hostSessionId) {
      this.store.upsertHostSessionLink({
        source: input.event.source,
        rootPath: this.rootPath,
        hostSessionId,
        sessionId: session.id,
        metadata: hostSessionMetadata(input.event)
      });
    }

    return session;
  }

  private hasPromptPrimeForHook(input: {
    sessionId: string;
    event: NormalizedHookEvent;
    promptHash: string;
  }): boolean {
    const turnId = stringMetadata(input.event.metadata, "turn_id");
    return this.store.listMetricsEvents(input.sessionId).some((event) => {
      if (event.eventKind !== "prime_context" || event.eventName !== "prime_context_hook") return false;
      if (event.metadata.promptHash !== input.promptHash) return false;
      return turnId ? event.metadata.turnId === turnId : true;
    });
  }

  private findLatestEvalRunForSession(sessionId: string) {
    const run = this.store.listEvalRuns({ sessionId, limit: 1 })[0];
    if (!run) {
      throw new Error(`No eval run exists for session ${sessionId}. Run kairn eval start first or pass --run.`);
    }
    return run;
  }

  private buildEvalReport(run: ReturnType<SqliteStore["getEvalRun"]>): EvalRunReport {
    const observations = this.store.listEvalObservations({ runId: run.id });
    const watchEvents = run.sessionId ? this.store.listWatchEvents(run.sessionId) : [];
    const codexUsage = codexUsageFromObservation([...observations].reverse().find((event) => event.kind === "codex_usage"));
    return {
      run,
      observations,
      ...(codexUsage ? { codexUsage } : {}),
      ...(run.sessionId ? { estimatedMetrics: this.getMetrics(run.sessionId) } : {}),
      watch: {
        events: watchEvents.length,
        failures: watchEvents.filter((event) => event.kind === "failure").length,
        fileChanges: watchEvents.filter((event) => event.kind === "file_change" || event.kind === "diff_change").length,
        hooks: watchEvents.filter((event) => event.source === "claude" || event.source === "codex" || event.source === "generic").length
      }
    };
  }

  private async promptContextResponse(input: {
    sessionId: string;
    eventName: string;
    prompt?: string | undefined;
  }): Promise<ContextResponse | undefined> {
    if (!isHighConfidencePrompt(input.eventName, input.prompt)) return undefined;
    return this.findContext({
      sessionId: input.sessionId,
      query: input.prompt,
      requestType: "find_context",
      budget: 900,
      mode: "brief"
    });
  }

  private buildBenchmarkReport(runId: string): BenchmarkReport {
    const run = this.store.getBenchmarkRun(runId);
    const results = this.store.listBenchmarkResults(runId);
    return buildBenchmarkReport({ run, results });
  }

  private async runReplayBenchmarkCase(input: {
    runId: string;
    sessionId: string;
    benchmarkCase: Parameters<typeof scoreBenchmarkCase>[0]["benchmarkCase"];
  }): Promise<Omit<BenchmarkResultRecord, "id" | "createdAt">> {
    const benchmarkCase = input.benchmarkCase;
    if (benchmarkCase.mode === "context") {
      const response = await this.findContext({
        sessionId: input.sessionId,
        query: benchmarkCase.query ?? benchmarkCase.task,
        budget: benchmarkCase.budget,
        mode: "snippets"
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.files,
        responseTokens: response.tokenEstimate,
        summary: `Context replay returned ${response.files.length} files.`,
        metadata: {
          queryHash: sha256(benchmarkCase.query ?? benchmarkCase.task),
          responseMode: response.mode,
          warnings: response.warnings
        }
      });
    }

    if (benchmarkCase.mode === "related") {
      const response = await this.getRelatedFiles({
        sessionId: input.sessionId,
        target: requireBenchmarkTarget(benchmarkCase),
        budget: benchmarkCase.budget
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.related,
        responseTokens: response.tokenEstimate,
        summary: `Related replay returned ${response.related.length} related files.`,
        metadata: { target: benchmarkCase.target }
      });
    }

    if (benchmarkCase.mode === "tests") {
      const response = await this.findTests({
        sessionId: input.sessionId,
        target: benchmarkCase.target,
        budget: benchmarkCase.budget
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.files,
        responseTokens: response.tokenEstimate,
        summary: `Test replay returned ${response.files.length} test files.`,
        metadata: benchmarkCase.target ? { target: benchmarkCase.target } : {}
      });
    }

    if (benchmarkCase.mode === "diff") {
      const response = await this.reviewDiff({
        sessionId: input.sessionId,
        budget: benchmarkCase.budget
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.files,
        responseTokens: response.tokenEstimate,
        summary: `Diff replay returned ${response.files.length} changed files.`,
        metadata: { warnings: response.warnings }
      });
    }

    if (benchmarkCase.mode === "hook") {
      const referenceFile = benchmarkCase.expectedFiles[0] ?? benchmarkCase.target ?? "src/app.test.ts";
      const event = normalizeHookPayload({
        source: "generic",
        payload: {
          eventName: "PostToolUse",
          command: "pnpm test",
          output: `FAIL ${referenceFile}:1:1\nExpected benchmark assertion to pass`,
          exitCode: 1
        }
      });
      const result = await this.handleHookEvent({ sessionId: input.sessionId, event });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: uniquePaths([...(result.event.files ?? []), ...(result.recommendation?.suggestedNextContext ?? [])]),
        responseTokens: (result.response?.tokenEstimate ?? 0) + estimateTokens(result.recommendation?.content ?? ""),
        hookContextEmitted: result.recommendation ? 1 : 0,
        hookContextSuppressed: result.recommendation ? 0 : 1,
        taskOutcome: result.event.files.includes(referenceFile) ? "pass" : "partial",
        summary: `Hook replay linked ${result.event.files.length} file(s).`,
        metadata: {
          eventKind: result.event.kind,
          recommendation: Boolean(result.recommendation)
        }
      });
    }

    return this.runAgentBenchmarkCase({
      runId: input.runId,
      benchmarkCase,
      agentCommand: undefined
    });
  }

  private async runAgentBenchmarkCase(input: {
    runId: string;
    benchmarkCase: Parameters<typeof scoreBenchmarkCase>[0]["benchmarkCase"];
    agentCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
    assistanceMode?: BenchmarkAssistanceMode | undefined;
  }): Promise<Omit<BenchmarkResultRecord, "id" | "createdAt">> {
    const result = await runAgentBenchmarkCase({
      rootPath: this.rootPath,
      benchmarkCase: input.benchmarkCase,
      agentCommand: input.agentCommand,
      timeoutMs: input.agentTimeoutMs,
      preparePrompt:
        input.assistanceMode === "manual_prime" || input.assistanceMode === "proactive"
          ? async ({ workspacePath, prompt }) => {
              const workspaceRuntime = new KairnRuntime(workspacePath);
              try {
                const prime = await workspaceRuntime.primeContext({
                  task: prompt,
                  budget: input.benchmarkCase.budget
                });
                return {
                  prompt: [
                    prime.content,
                    "",
                    "User task:",
                    prompt,
                    "",
                    "Use the Kairn context above first. Avoid broad scans unless the provided files are insufficient."
                  ].join("\n"),
                  metadata: {
                    assistanceMode: input.assistanceMode === "proactive" ? "proactive" : "manual_prime",
                    primeProfile: prime.profile,
                    primeSessionId: prime.session.id,
                    primeTokenEstimate: prime.tokenEstimate,
                    primeFiles: prime.files,
                    primeWarnings: prime.warnings
                  }
                };
              } finally {
                workspaceRuntime.close();
              }
            }
          : input.assistanceMode === "mcp_first" ||
              input.assistanceMode === "real_mcp_first" ||
              input.assistanceMode === "mcp_first_plus_hook_full_prime"
            ? ({ prompt }) => ({
                prompt: [
                  "Kairn MCP-first instruction:",
                  "Before broad file scans, call `kairn_prepare_task` with this task.",
                  "For follow-up reads, call `kairn_get_next_context`.",
                  "For failures, call `kairn_get_failure_context`.",
                  "Use the smallest Kairn-recommended read before `rg --files`, large `sed`, or full-file reads.",
                  "",
                  "User task:",
                  prompt
                ].join("\n"),
                metadata: {
                  assistanceMode: input.assistanceMode,
                  mcpFirstInstructionsPrepended: true
                }
              })
          : undefined
    });
    const workspaceMetrics = collectWorkspaceKairnMetrics(result.workspacePath);
    return scoreBenchmarkCase({
      runId: input.runId,
      benchmarkCase: input.benchmarkCase,
      actualFiles: result.actualFiles,
      responseTokens: result.responseTokens,
      observedCodexTokens: result.observedCodexTokens,
      taskOutcome: result.outcome,
      summary: result.summary,
      metadata: {
        assistanceMode: input.assistanceMode ?? "baseline",
        ...workspaceMetrics,
        ...result.metadata
      }
    });
  }

  private async refreshIndex(rootPath: string) {
    const index = await indexRepo(rootPath);
    this.store.replaceIndex({
      rootPath,
      files: index.graph.files,
      symbols: index.graph.symbols,
      edges: index.graph.edges,
      semanticChunks: index.semanticChunks,
      semanticVectors: index.semanticVectors,
      lexicalDocuments: index.lexical.documents,
      lexicalTerms: index.lexical.terms,
      lexicalStats: index.lexical.stats
    });
    return index.graph.files;
  }

  private recordWatchEvent(record: {
    sessionId: string;
    source: WatchEventSource;
    kind: WatchEventKind;
    eventName: string;
    toolName?: string | undefined;
    command?: string | undefined;
    files: string[];
    exitCode?: number | undefined;
    summary: string;
    contentHash?: string | undefined;
    metadata: Record<string, unknown>;
  }): WatchEventRecord {
    const contentHash = record.contentHash ?? sha256([record.summary, record.files.join("\n")].join("\n"));
    return this.store.recordWatchEvent({
      sessionId: record.sessionId,
      source: record.source,
      kind: record.kind,
      eventName: record.eventName,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      ...(record.command ? { command: record.command } : {}),
      files: uniquePaths(record.files),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      summary: record.summary,
      contentHash,
      metadata: record.metadata
    });
  }

  private async recommendFromHook(input: {
    sessionId: string;
    command?: string | undefined;
    response?: ContextResponse | undefined;
    linkedFiles: string[];
    outputKind: OutputKind;
    eventKind: WatchEventKind;
  }): Promise<WatchRecommendation | undefined> {
    const suggested = new Set<string>(input.linkedFiles);
    const warnings = [...(input.response?.warnings ?? [])];

    if (input.response?.mode === "brief") {
      for (const file of input.response.suggestedNextContext.slice(0, 5)) {
        suggested.add(file);
      }
    }

    for (const linkedFile of input.linkedFiles.slice(0, 2)) {
      try {
        const related = await this.getRelatedFiles({ sessionId: input.sessionId, target: linkedFile, budget: 700 });
        for (const file of related.suggestedNextContext.slice(0, 3)) {
          suggested.add(file);
        }
      } catch {
        // Related context is best-effort for hook recommendations.
      }

      try {
        const tests = await this.findTests({ sessionId: input.sessionId, target: linkedFile, budget: 700 });
        for (const file of tests.suggestedNextContext.slice(0, 3)) {
          suggested.add(file);
        }
      } catch {
        // Test discovery is best-effort for hook recommendations.
      }
    }

    if (suggested.size === 0 && !input.response) return undefined;
    if (suggested.size === 0 && input.response && input.eventKind !== "failure" && input.outputKind === "generic") return undefined;

    const files = [...suggested].slice(0, 10);
    return {
      summary: input.linkedFiles.length > 0
        ? `Observed ${input.outputKind} output linked to ${input.linkedFiles.length} file(s).`
        : `Observed ${input.outputKind} output${input.command ? ` from "${input.command}"` : ""}.`,
      files,
      suggestedNextContext: files.slice(0, 5),
      warnings,
      content: [
        "# Kairn Hook Recommendation",
        "",
        input.command ? `Command: ${input.command}` : undefined,
        `Output kind: ${input.outputKind}`,
        files.length > 0 ? `Suggested next context: ${files.join(", ")}` : "No linked files were detected.",
        "",
        input.response?.content
      ].filter(Boolean).join("\n")
    };
  }

  private async getChangedFiles(rootPath: string): Promise<Set<string>> {
    try {
      const output = await simpleGit(rootPath).diff(["--name-only"]);
      return new Set(
        output
          .split(/\r?\n/)
          .map((line) => normalizeRelativePath(line.trim()))
          .filter(Boolean)
      );
    } catch {
      return new Set();
    }
  }

  private getGraphRelatedFiles(rootPath: string, target: string) {
    const filesByPath = new Map(this.store.listFiles(rootPath).map((file) => [file.path, file]));
    const edges = this.store.listGraphEdgesForFile(rootPath, target);
    const related = new Map<string, { file: FileRecord; reason: string }>();

    for (const edge of edges) {
      const relatedPath = edge.fromFile === target ? edge.toFile : edge.fromFile;
      const file = filesByPath.get(relatedPath);
      if (!file) continue;
      const reason = graphReason(edge.type, edge.fromFile === target);
      const existing = related.get(relatedPath);
      const reasons = new Set([...(existing?.reason.split("; ") ?? []), reason]);
      related.set(relatedPath, {
        file,
        reason: [...reasons].join("; ")
      });
    }

    return [...related.values()].sort((a, b) => b.file.importance - a.file.importance || a.file.path.localeCompare(b.file.path));
  }

  private getGraphTests(rootPath: string, target: string) {
    const filesByPath = new Map(this.store.listFiles(rootPath).map((file) => [file.path, file]));
    const edges = this.store
      .listGraphEdgesForFile(rootPath, target)
      .filter((edge) => edge.type === "tested_by" || edge.type === "test_for");
    const tests = new Map<string, FileRecord>();

    for (const edge of edges) {
      const path = edge.type === "tested_by" && edge.fromFile === target ? edge.toFile : edge.fromFile;
      const file = filesByPath.get(path);
      if (file?.kind === "test") {
        tests.set(file.path, file);
      }
    }

    return [...tests.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private getSemanticRelatedFiles(rootPath: string, target: string, files: FileRecord[]) {
    const targetChunks = this.store.listSemanticChunksForFile(rootPath, target);
    if (targetChunks.length === 0) return [];

    const query = targetChunks
      .map((chunk) => [target, chunk.symbol ?? "", chunk.text.slice(0, 2000)].join("\n"))
      .join("\n");
    const scored = hybridSearch({
      files,
      query,
      symbols: this.store.listSymbols(rootPath),
      chunks: this.store.listSemanticChunks(rootPath),
      vectors: this.store.listSemanticVectors(rootPath),
      edges: this.store.listGraphEdges(rootPath)
    });

    return scored
      .filter((file) => file.path !== target)
      .slice(0, 10)
      .map((file) => ({
        file,
        reason: file.reasons.includes("graph neighbor")
          ? "semantic/graph neighbor"
          : `semantic neighbor${file.chunks[0]?.symbol ? `: ${file.chunks[0].symbol}` : ""}`
      }));
  }

  private getSemanticTests(rootPath: string, files: FileRecord[], target: string | undefined, task: string) {
    const queryParts = [target ?? task, "test spec verify"];
    if (target) {
      queryParts.push(...this.store.listSemanticChunksForFile(rootPath, target).map((chunk) => chunk.text.slice(0, 1200)));
      queryParts.push(...this.store.listSymbolsForFile(rootPath, target).map((symbol) => symbol.name));
    }

    const scored = hybridSearch({
      files,
      query: queryParts.join("\n"),
      symbols: this.store.listSymbols(rootPath),
      chunks: this.store.listSemanticChunks(rootPath),
      vectors: this.store.listSemanticVectors(rootPath),
      edges: this.store.listGraphEdges(rootPath)
    });

    return scored.filter((file) => file.kind === "test").slice(0, 20);
  }

  private recordShown(
    sessionId: string,
    kind: "file" | "symbol" | "summary" | "diff" | "tests" | "context",
    mode: ContextResponse["mode"],
    content: string,
    filePath?: string
  ): void {
    this.store.recordContextShown({
      sessionId,
      kind,
      ...(filePath ? { filePath } : {}),
      mode,
      contentHash: sha256(content)
    });
  }

  private recordMetricsEvent(input: {
    sessionId: string;
    rootPath: string;
    eventKind: MetricsEventKind;
    eventName: string;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | undefined;
    responseMode?: ContextResponseMode | undefined;
    baselineTokens: number;
    outputTokens: number;
    files: string[];
    metadata?: Record<string, unknown> | undefined;
  }): void {
    const baselineTokens = Math.max(0, Math.round(input.baselineTokens));
    const outputTokens = Math.max(0, Math.round(input.outputTokens));
    this.store.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: input.rootPath,
      eventKind: input.eventKind,
      eventName: input.eventName,
      source: input.source ?? "runtime",
      ...(input.responseMode ? { responseMode: input.responseMode } : {}),
      baselineTokens,
      outputTokens,
      savedTokens: Math.max(0, baselineTokens - outputTokens),
      files: uniquePaths(input.files),
      metadata: input.metadata ?? {}
    });
  }

  private readPackageScripts(rootPath: string): string[] {
    const packageJsonPath = path.join(rootPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      return Object.entries(parsed.scripts ?? {}).map(([name, command]) => `${name}: ${command}`);
    } catch {
      return [];
    }
  }
}

export function createRuntime(root?: string): KairnRuntime {
  return new KairnRuntime(root ?? getKairnPaths().rootPath);
}

function failureRecommendation(context: FailureContext): WatchRecommendation {
  return {
    summary: `Failure context linked ${context.failureFiles.length} failure file(s).`,
    files: context.files,
    suggestedNextContext: context.files.slice(0, 5),
    warnings: context.warnings,
    content: context.content
  };
}

function formatContextResults(input: {
  title: string;
  task: string;
  query: string;
  decisionReason: string;
  mode: ContextResponse["mode"];
  intent: QueryIntent;
  scored: HybridScoredResult[];
  budget?: number | undefined;
}): string {
  const highConfidence =
    input.scored.length > 0
      ? input.scored
          .map((file) => {
            const scoreBreakdown = [
              `bm25 ${file.bm25Score}`,
              `semantic ${file.semanticScore}`,
              `keyword ${file.keywordScore}`,
              `behavior ${file.behaviorScore}`,
              `intent ${file.intentScore}`,
              `graph ${file.graphScore}`,
              `git ${file.gitScore}`
            ].join(", ");
            return `- ${file.path} (${file.kind}, score ${file.score}; ${scoreBreakdown}): ${file.reasons.join("; ")}`;
          })
          .join("\n")
      : "No high-confidence files found from hybrid retrieval.";

  const sections = [
    `# ${input.title}`,
    "",
    `Task: ${input.task}`,
    `Query: ${input.query}`,
    `Response Mode: ${input.mode}`,
    `Detected Intent: ${input.intent.primary}${input.intent.matchedTerms.length > 0 ? ` (${input.intent.matchedTerms.join(", ")})` : ""}`,
    `Selection: ${input.decisionReason}`,
    "",
    "## Ranked Files",
    highConfidence
  ];

  if (input.mode === "snippets" || input.mode === "exact_code") {
    const snippetFiles = input.scored.filter((file) => file.intentScore > 0 || !file.reasons.includes("graph neighbor"));
    const files = (snippetFiles.length > 0 ? snippetFiles : input.scored).slice(0, 5);
    sections.push("", "## Matched Snippets", formatMatchedSnippets(files, Math.max(180, Math.floor((input.budget ?? 1600) * 0.42))));
  }

  if (input.mode === "compressed_summary") {
    sections.push("", "## Compact Summary", formatCompactSummary(input.scored.slice(0, 6)));
  }

  sections.push(
    "",
    "## Suggested Next Context",
    input.scored
      .slice(0, 5)
      .map((file) => `- Read ${file.path}`)
      .join("\n") || "Run a more specific context query."
  );

  return sections.join("\n");
}

type ResolvedPrimeProfile = Exclude<PrimeProfile, "auto">;

type PrimeProfileLimits = {
  topFiles: number;
  relatedFiles: number;
  testFiles: number;
  contextRatio: number;
  snippetBudget: number;
  includeCommands: boolean;
};

function formatPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  budget: number;
  limits: PrimeProfileLimits;
  context: ContextResponse;
  relatedFiles: string[];
  testFiles: string[];
  suggestedCommands: string[];
}): string {
  const topFiles = uniquePaths(input.context.suggestedNextContext.length > 0 ? input.context.suggestedNextContext : input.context.files).slice(0, input.limits.topFiles);
  const related = uniquePaths(input.relatedFiles).filter((file) => !topFiles.includes(file)).slice(0, input.limits.relatedFiles);
  const tests = uniquePaths(input.testFiles).slice(0, input.limits.testFiles);
  const sections = [
    "# Kairn Proactive Context",
    "",
    "Start with this context before broad repository scans. If it is insufficient, then use targeted reads or Kairn context commands.",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    "",
    "## Start Here",
    topFiles.length > 0 ? topFiles.map((file) => `- ${file}`).join("\n") : "- No high-confidence files found.",
    "",
    "## Targeted Context",
    compactPrimeContext(input.context.content, input.limits.snippetBudget),
    "",
    "## Likely Tests",
    tests.length > 0 ? tests.map((file) => `- ${file}`).join("\n") : "- No likely tests found.",
    "",
    related.length > 0 ? ["## Related Files", related.map((file) => `- ${file}`).join("\n"), ""].join("\n") : "",
    input.limits.includeCommands
      ? ["## More Context", input.suggestedCommands.slice(0, 2).map((command) => `- ${command}`).join("\n"), ""].join("\n")
      : "",
    "",
    "## Agent Guidance",
    "- Prefer targeted reads of the Start Here files over `rg --files` or large file ranges.",
    "- Do not edit files unless the user task explicitly asks for edits."
  ].filter((section) => section !== "");

  return fitSectionsToBudget(sections, input.budget);
}

function withTinyDirectivePrime(prime: ContextPrime, requestedBudget: number): ContextPrime {
  const budget = Math.max(240, Math.min(600, requestedBudget));
  const content = formatTinyDirectivePrime({ prime, budget });
  return {
    ...prime,
    content,
    tokenEstimate: estimateTokens(content),
    warnings: uniqueStrings([...prime.warnings, "tiny directive hook output"])
  };
}

function formatTinyDirectivePrime(input: { prime: ContextPrime; budget: number }): string {
  const files = input.prime.files.slice(0, 3);
  const likelyTest = files.find((file) => /\b(test|spec)\b|__tests__/.test(file));
  const symbols = extractPrimeSymbolHints(input.prime.content).slice(0, 4);
  const lines = [
    "# Kairn Start Points",
    "",
    "Use these before broad repo search.",
    "",
    `Task: ${input.prime.task}`,
    `Session: ${input.prime.session.id}`,
    "",
    "Start here:",
    files.length > 0
      ? files.map((file, index) => `${index + 1}. ${file}`).join("\n")
      : "No high-confidence start file found.",
    symbols.length > 0 ? `Symbols: ${symbols.join(", ")}` : "",
    likelyTest ? `Likely test: ${likelyTest}` : "",
    "",
    "Instruction: inspect the start files first; only use broad search if these are insufficient."
  ].filter(Boolean);

  return fitSectionsToBudget(lines, input.budget);
}

function extractPrimeSymbolHints(content: string): string[] {
  const symbols: string[] = [];
  for (const match of content.matchAll(/\bsymbol match:\s*([A-Za-z_$][\w$]*)/g)) {
    symbols.push(match[1]!);
  }
  for (const match of content.matchAll(/\bsymbol:\s*([A-Za-z_$][\w$]*)/g)) {
    symbols.push(match[1]!);
  }
  return uniqueStrings(symbols);
}

function evaluatePrimeQuality(input: {
  task: string;
  context: ContextResponse;
  knownFiles: FileRecord[];
}): PrimeQuality {
  const scores = extractRankedScores(input.context.content);
  const topScore = scores[0] ?? 0;
  const secondScore = scores[1] ?? 0;
  const topGap = Number(Math.max(0, topScore - secondScore).toFixed(3));
  const normalizedTask = input.task.toLowerCase();
  const exactPathMentioned = input.knownFiles.some((file) => normalizedTask.includes(file.path.toLowerCase()));
  const reasons: string[] = [];

  if (exactPathMentioned) reasons.push("prompt already names an exact indexed file");
  if (topScore >= 250) reasons.push("high-confidence top retrieval score");
  if (topGap >= 80) reasons.push("top result is clearly separated");
  if (topScore > 0 && topScore < 90) reasons.push("low top retrieval score");
  if (topScore > 0 && topGap < 20) reasons.push("top results are tightly clustered");
  if (input.context.files.length === 0) reasons.push("no retrieved files");

  let score = 42;
  score += Math.min(34, topScore / 24);
  score += Math.min(18, topGap / 12);
  if (exactPathMentioned) score -= 44;
  if (input.context.files.length === 0) score -= 45;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const action = exactPathMentioned || score < 42
    ? "suppress"
    : score < 68 || topGap < 20
      ? "shrink"
      : "emit";
  const expectedSavingsRisk = action === "suppress" ? "high" : action === "shrink" ? "medium" : "low";

  return {
    score,
    action,
    reasons: reasons.length > 0 ? reasons : ["retrieval confidence is acceptable"],
    topScore,
    topGap,
    exactPathMentioned,
    expectedSavingsRisk
  };
}

function formatSuppressedPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  quality: PrimeQuality;
}): string {
  return [
    "# Kairn Prime Suppressed",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    `Quality score: ${input.quality.score}`,
    `Reason: ${input.quality.reasons.join("; ")}`,
    "",
    "Kairn did not emit proactive context because it is unlikely to save tokens for this prompt."
  ].join("\n");
}

function formatShrunkPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  quality: PrimeQuality;
  context: ContextResponse;
  budget: number;
}): string {
  const topFiles = input.context.suggestedNextContext.slice(0, 3);
  const sections = [
    "# Kairn Compact Prime",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    `Quality score: ${input.quality.score} (${input.quality.action})`,
    "",
    "## Start Here",
    topFiles.length > 0 ? topFiles.map((file) => `- ${file}`).join("\n") : "- No high-confidence files found.",
    "",
    "## Targeted Context",
    compactPrimeContext(input.context.content, Math.max(160, Math.floor(input.budget * 0.42))),
    "",
    "## Agent Guidance",
    "- Use this only as a starting point; avoid broad scans if these files fit the task."
  ];
  return fitSectionsToBudget(sections, input.budget);
}

function extractRankedScores(content: string): number[] {
  const scores: number[] = [];
  const pattern = /score\s+([\d.]+)/g;
  for (const match of content.matchAll(pattern)) {
    const score = Number(match[1]);
    if (Number.isFinite(score)) scores.push(score);
  }
  return scores;
}

function resolvePrimeProfile(profile: PrimeProfile, task: string): ResolvedPrimeProfile {
  if (profile !== "auto") return profile;
  const intent = classifyQueryIntent(task).primary;
  if (intent === "ui" || intent === "workflow" || intent === "test") return intent;
  if (intent === "backend" || intent === "data" || intent === "auth") return "backend";
  return "generic";
}

function defaultPrimeBudget(profile: ResolvedPrimeProfile): number {
  switch (profile) {
    case "ui":
      return 700;
    case "workflow":
      return 900;
    case "backend":
      return 1100;
    case "test":
      return 900;
    case "generic":
      return 800;
  }
}

function primeProfileLimits(profile: ResolvedPrimeProfile): PrimeProfileLimits {
  switch (profile) {
    case "ui":
      return { topFiles: 3, relatedFiles: 2, testFiles: 2, contextRatio: 0.5, snippetBudget: 330, includeCommands: false };
    case "workflow":
      return { topFiles: 4, relatedFiles: 3, testFiles: 2, contextRatio: 0.55, snippetBudget: 430, includeCommands: false };
    case "backend":
      return { topFiles: 4, relatedFiles: 3, testFiles: 3, contextRatio: 0.62, snippetBudget: 560, includeCommands: true };
    case "test":
      return { topFiles: 4, relatedFiles: 2, testFiles: 4, contextRatio: 0.56, snippetBudget: 430, includeCommands: true };
    case "generic":
      return { topFiles: 3, relatedFiles: 2, testFiles: 2, contextRatio: 0.5, snippetBudget: 360, includeCommands: false };
  }
}

function compactPrimeContext(content: string, budget: number): string {
  const snippetIndex = content.indexOf("## Matched Snippets");
  const selected = snippetIndex >= 0 ? content.slice(snippetIndex).replace(/^## Matched Snippets\s*/m, "").trim() : content;
  return truncateToBudget(selected, budget);
}

function fitSectionsToBudget(sections: string[], budget: number): string {
  const accepted: string[] = [];
  let used = 0;
  for (const section of sections) {
    const tokens = estimateTokens(section);
    if (used + tokens <= budget) {
      accepted.push(section);
      used += tokens;
      continue;
    }
    const remaining = Math.max(0, budget - used - 16);
    if (remaining > 60) {
      accepted.push(truncateToBudget(section, remaining));
    }
    break;
  }
  return accepted.join("\n");
}

function buildBenchmarkProofReport(input: {
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
      mcp_first_plus_hook_full_prime: input.mcpFirstPlusHookFullPrime
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
    ...(manualPrimeVsBaseline?.recommendations.slice(0, 4) ?? promptOnlyVsBaseline?.recommendations.slice(0, 4) ?? [])
  ]);

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
      mcp_first_plus_hook_full_prime: input.mcpFirstPlusHookFullPrime
    },
    aggregate,
    observedTokenDeltas: {
      ...(promptOnlyVsBaseline?.observedTokenDelta ? { promptOnlyVsBaseline: promptOnlyVsBaseline.observedTokenDelta } : {}),
      ...(promptPlusVsBaseline?.observedTokenDelta ? { promptPlusHooksVsBaseline: promptPlusVsBaseline.observedTokenDelta } : {}),
      ...(manualPrimeVsBaseline?.observedTokenDelta ? { manualPrimeVsBaseline: manualPrimeVsBaseline.observedTokenDelta } : {}),
      ...(hookFullPrimeVsBaseline?.observedTokenDelta ? { hookFullPrimeVsBaseline: hookFullPrimeVsBaseline.observedTokenDelta } : {}),
      ...(hookTinyDirectiveVsBaseline?.observedTokenDelta ? { hookTinyDirectiveVsBaseline: hookTinyDirectiveVsBaseline.observedTokenDelta } : {}),
      ...(hookTinyWithFailuresVsBaseline?.observedTokenDelta ? { hookTinyWithFailuresVsBaseline: hookTinyWithFailuresVsBaseline.observedTokenDelta } : {}),
      ...(mcpFirstVsBaseline?.observedTokenDelta ? { mcpFirstVsBaseline: mcpFirstVsBaseline.observedTokenDelta } : {}),
      ...(realMcpFirstVsBaseline?.observedTokenDelta ? { realMcpFirstVsBaseline: realMcpFirstVsBaseline.observedTokenDelta } : {}),
      ...(mcpFirstPlusHookFullPrimeVsBaseline?.observedTokenDelta ? { mcpFirstPlusHookFullPrimeVsBaseline: mcpFirstPlusHookFullPrimeVsBaseline.observedTokenDelta } : {}),
      ...(promptPlusVsBaseline?.observedTokenDelta ? { passiveVsBaseline: promptPlusVsBaseline.observedTokenDelta } : {}),
      ...(manualPrimeVsBaseline?.observedTokenDelta ? { proactiveVsBaseline: manualPrimeVsBaseline.observedTokenDelta } : {}),
      ...(proactiveVsPassive?.observedTokenDelta ? { proactiveVsPassive: proactiveVsPassive.observedTokenDelta } : {})
    },
    caseDeltas,
    recommendations
  };
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
    modes[mode] = {
      reports: reports?.length ?? 0,
      ...(tokenTotals.length > 0 ? { meanTokens: mean(tokenTotals), medianTokens: median(tokenTotals) } : {}),
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
      mcpFirstPlusHookFullPrimeVsBaseline: aggregateDelta(modes.baseline?.medianTokens, modes.mcp_first_plus_hook_full_prime?.medianTokens)
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

function shuffleItems<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function recommendationForDelta(label: string, delta: BenchmarkComparison["observedTokenDelta"]): string {
  if (!delta) return `${label}: observed Codex usage unavailable.`;
  if (delta.savedTokens > 0) {
    return `${label}: saved ${delta.savedTokens} observed Codex tokens (${Math.round(delta.savingsRate * 100)}%).`;
  }
  return `${label}: increased observed Codex usage by ${Math.abs(delta.savedTokens)} tokens (${Math.round(Math.abs(delta.savingsRate) * 100)}%).`;
}

function collectWorkspaceKairnMetrics(workspacePath: string): Record<string, unknown> {
  const databasePath = path.join(workspacePath, ".kairn", "kairn.sqlite");
  if (!fs.existsSync(databasePath)) {
    return {
      primeEmitted: 0,
      hookInvocations: 0
    };
  }

  const runtime = new KairnRuntime(workspacePath);
  try {
    const sessions = runtime.listSessions({ allRoots: true });
    const metrics = sessions.map((session) => runtime.getMetrics(session.id));
    return {
      kairnSessionCount: sessions.length,
      primeEmitted: metrics.reduce((total, item) => total + (item.byKind.prime_context?.events ?? 0), 0),
      primeTokens: metrics.reduce((total, item) => total + (item.byKind.prime_context?.outputTokens ?? 0), 0),
      primeQualityEvents: metrics.reduce((total, item) => total + (item.byKind.prime_quality?.events ?? 0), 0),
      hookInvocations: metrics.reduce((total, item) => total + (item.byKind.hook_signal?.events ?? 0), 0),
      failureContextUsed: metrics.reduce((total, item) => total + (item.byKind.failure_context?.events ?? 0), 0),
      mcpToolCalls: metrics.reduce((total, item) => total + (item.byKind.mcp_tool_call?.events ?? 0), 0),
      mcpFilesReturned: uniquePaths(
        metrics.flatMap((item) =>
          item.recentEvents
            .filter((event) => event.eventKind === "mcp_tool_call")
            .flatMap((event) => event.files)
        )
      )
    };
  } catch {
    return {
      primeEmitted: 0,
      hookInvocations: 0
    };
  } finally {
    runtime.close();
  }
}

function sessionIdFromMcpValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId === "string") return record.sessionId;
  const session = record.session;
  if (session && typeof session === "object" && typeof (session as Record<string, unknown>).id === "string") {
    return (session as Record<string, string>).id;
  }
  return undefined;
}

function filesFromMcpValue(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const fields = [record.files, record.related, record.suggestedNextContext, record.failureFiles, record.testFiles, record.changedFiles];
  return uniquePaths(
    fields.flatMap((field) => Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [])
  );
}

function tokenEstimateFromMcpValue(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.tokenEstimate === "number") return Math.max(0, Math.round(record.tokenEstimate));
  if (typeof record.content === "string") return estimateTokens(record.content);
  return 0;
}

function responseModeFromMcpValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mode = (value as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode : undefined;
}

function formatMatchedSnippets(files: HybridScoredResult[], budget = 700): string {
  const snippets: string[] = [];
  let usedTokens = 0;
  let omitted = 0;

  for (const file of files) {
    for (const chunk of file.chunks.slice(0, 2)) {
      const title = chunk.symbol
        ? `${file.path} :: ${chunk.symbol} (${chunk.startLine ?? "?"}-${chunk.endLine ?? "?"})`
        : file.path;
      const block = [
        `### ${title}`,
        "",
        "```",
        chunk.text.split(/\r?\n/).slice(0, 60).join("\n"),
        "```"
      ].join("\n");
      const blockTokens = estimateTokens(block);
      if (usedTokens + blockTokens > budget) {
        omitted += 1;
        if (snippets.length === 0) {
          snippets.push(truncateToBudget(block, budget));
          usedTokens = budget;
        }
        continue;
      }
      snippets.push(block);
      usedTokens += blockTokens;
    }
  }

  if (snippets.length === 0) return "No semantic snippets were available within the response budget.";
  const budgetNote =
    omitted > 0 ? `\n\nSnippet budget reached; omitted ${omitted} lower-priority snippet${omitted === 1 ? "" : "s"}.` : "";
  return `${snippets.join("\n\n")}${budgetNote}`;
}

function formatCompactSummary(files: HybridScoredResult[]): string {
  if (files.length === 0) return "No matching files to summarize.";
  return files
    .map((file) => {
      const chunkSummary = file.chunks
        .slice(0, 2)
        .map((chunk) => chunk.symbol ?? chunk.kind)
        .join(", ");
      return `- ${file.path}: ${file.reasons.slice(0, 3).join("; ")}${chunkSummary ? ` (${chunkSummary})` : ""}`;
    })
    .join("\n");
}

function estimateFileBaselineTokens(files: Pick<FileRecord, "size">[]): number {
  return files.reduce((total, file) => total + Math.ceil(file.size / 4), 0);
}

function summarizeMetrics(events: { baselineTokens: number; outputTokens: number; savedTokens: number }[]): MetricsBucket {
  return events.reduce<MetricsBucket>(
    (totals, event) => ({
      events: totals.events + 1,
      baselineTokens: totals.baselineTokens + event.baselineTokens,
      outputTokens: totals.outputTokens + event.outputTokens,
      savedTokens: totals.savedTokens + event.savedTokens
    }),
    emptyMetricsBucket()
  );
}

function groupMetrics<T extends { baselineTokens: number; outputTokens: number; savedTokens: number }>(
  events: T[],
  keyFor: (event: T) => string
): Record<string, MetricsBucket> {
  const grouped: Record<string, MetricsBucket> = {};
  for (const event of events) {
    const key = keyFor(event);
    const current = grouped[key] ?? emptyMetricsBucket();
    grouped[key] = {
      events: current.events + 1,
      baselineTokens: current.baselineTokens + event.baselineTokens,
      outputTokens: current.outputTokens + event.outputTokens,
      savedTokens: current.savedTokens + event.savedTokens
    };
  }
  return grouped;
}

function emptyMetricsBucket(): MetricsBucket {
  return {
    events: 0,
    baselineTokens: 0,
    outputTokens: 0,
    savedTokens: 0
  };
}

function codexUsageFromObservation(observation: EvalObservationRecord | undefined): CodexUsageRecord | undefined {
  const value = observation?.metrics.codexUsage;
  if (!isRecord(value)) return undefined;
  const totalTokens = numberField(value.totalTokens);
  const inputTokens = numberField(value.inputTokens);
  const cachedInputTokens = numberField(value.cachedInputTokens);
  const outputTokens = numberField(value.outputTokens);
  const source = stringField(value.source);
  if (
    totalTokens === undefined ||
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    outputTokens === undefined ||
    (source !== "footer" && source !== "transcript" && source !== "footer+transcript")
  ) {
    return undefined;
  }
  const model = stringField(value.model);
  const hostSessionId = stringField(value.hostSessionId);
  const turnId = stringField(value.turnId);
  const transcriptPath = stringField(value.transcriptPath);
  const transcriptHash = stringField(value.transcriptHash);

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(model ? { model } : {}),
    ...(hostSessionId ? { hostSessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(transcriptHash ? { transcriptHash } : {}),
    source
  };
}

function isPromptEvent(eventName: string): boolean {
  return eventName.toLowerCase() === "userpromptsubmit";
}

function hostSessionIdForEvent(event: NormalizedHookEvent): string | undefined {
  return event.hostSessionId
    ?? stringMetadata(event.metadata, "session_id")
    ?? stringMetadata(event.metadata, "hostSessionId")
    ?? stringMetadata(event.metadata, "turn_id");
}

function hostSessionMetadata(event: NormalizedHookEvent): Record<string, unknown> {
  return {
    eventName: event.eventName,
    ...(event.hostSessionId ? { hostSessionId: event.hostSessionId } : {}),
    ...(stringMetadata(event.metadata, "turn_id") ? { turnId: stringMetadata(event.metadata, "turn_id") } : {}),
    ...(stringMetadata(event.metadata, "model") ? { model: stringMetadata(event.metadata, "model") } : {})
  };
}

function taskFromHookEvent(event: NormalizedHookEvent): string {
  if (isPromptEvent(event.eventName) && event.output?.trim()) {
    return truncateText(event.output.trim(), 240);
  }
  if (event.command) {
    return `Observed ${event.source} command: ${truncateText(event.command, 180)}`;
  }
  return `Observed ${event.source} ${event.eventName} hook session`;
}

function isHighConfidencePrompt(eventName: string, prompt: string | undefined): boolean {
  if (!isPromptEvent(eventName) || !prompt) return false;
  const normalized = prompt.toLowerCase();
  if (normalized.startsWith("run ")) return false;
  return /\b(fix|identify|find|implement|update|refactor|debug|error|failing|component|api|layout|parser|mobile|review|queue|sync|gmail|test|hook|metrics|eval)\b/.test(normalized);
}

function isTrivialSuccessfulHook(input: {
  eventKind: WatchEventKind;
  command?: string | undefined;
  output?: string | undefined;
  linkedFiles: string[];
  exitCode?: number | undefined;
}): boolean {
  if (!input.output || input.eventKind === "failure" || input.linkedFiles.length > 0) return false;
  if (input.exitCode !== undefined && input.exitCode !== 0) return false;
  const lineCount = input.output.split(/\r?\n/).filter((line) => line.trim()).length;
  const outputTokens = estimateTokens(input.output);
  const command = input.command?.trim().toLowerCase() ?? "";
  if (["pwd", "git status", "git branch", "npm pkg get scripts", "pnpm pkg get scripts"].includes(command)) return true;
  return lineCount <= 12 && outputTokens <= 80 && !/\b(error|fail|failed|exception|traceback|ts\d{4})\b/i.test(input.output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value;
}

function benchmarkCaseApplies(caseMode: BenchmarkCaseMode, runMode: BenchmarkRunMode): boolean {
  if (runMode === "replay") return caseMode !== "agent";
  if (runMode === "agent") return caseMode === "agent";
  return true;
}

function requireBenchmarkTarget(benchmarkCase: { id: string; target?: string | undefined; expectedFiles: string[] }): string {
  const target = benchmarkCase.target ?? benchmarkCase.expectedFiles[0];
  if (!target) {
    throw new Error(`Benchmark case ${benchmarkCase.id} requires a target or expected file.`);
  }
  return target;
}

function sliceLines(content: string, startLine: number, endLine: number): string {
  return content.split(/\r?\n/).slice(startLine - 1, endLine).join("\n");
}

function graphReason(type: string, targetIsFromFile: boolean): string {
  if (type === "imports") return targetIsFromFile ? "imports target" : "imported by target";
  if (type === "imported_by") return targetIsFromFile ? "imported by target" : "imports target";
  if (type === "tested_by") return targetIsFromFile ? "test for target" : "tested source";
  if (type === "test_for") return targetIsFromFile ? "tested source" : "test for target";
  if (type === "parent_route") return targetIsFromFile ? "parent route" : "route segment file";
  if (type === "definition") return targetIsFromFile ? "definition target" : "defined from target";
  if (type === "reference") return targetIsFromFile ? "references target" : "referenced by target";
  if (type === "type_reference") return targetIsFromFile ? "type reference target" : "type referenced by target";
  if (type === "implementation") return targetIsFromFile ? "implementation target" : "implemented by target";
  if (type === "call") return targetIsFromFile ? "calls target" : "called by target";
  return type;
}

function mergeReasonText(left: string | undefined, right: string): string {
  return [...new Set([...(left?.split("; ") ?? []), right])].filter(Boolean).join("; ");
}

function uniquePaths(files: string[]): string[] {
  return [...new Set(files.map((file) => normalizeRelativePath(file).replace(/^\.\//, "")).filter(Boolean))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
