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
  EvalComparison,
  EvalObservationRecord,
  EvalRunMode,
  EvalRunReport,
  FailureContext,
  FileRecord,
  HookHandlingResult,
  HookOutputProfile,
  InitResult,
  MetricsEventKind,
  MetricsSummary,
  NormalizedHookEvent,
  OutputKind,
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
import { classifyObservedCommand } from "../watch/classifyCommand.js";
import { extractFailureFiles } from "../watch/failureParser.js";
import { normalizeHookPayload } from "../watch/normalizeHook.js";
import { nowIso } from "../utils/time.js";
import { classifyQueryIntent } from "../retrieval/queryIntent.js";
import { loadBenchmarkSuite } from "../bench/suite.js";
import { buildBenchmarkReport, compareBenchmarkReports, scoreBenchmarkCase } from "../bench/score.js";
import { runAgentBenchmarkCase } from "../bench/agent.js";
import { buildBenchmarkProofReport, shuffleItems } from "../bench/proofReport.js";
import { benchmarkCaseApplies, requireBenchmarkTarget } from "../bench/runtimeHelpers.js";
import {
  defaultPrimeBudget,
  evaluatePrimeQuality,
  primeProfileLimits,
  resolvePrimeProfile
} from "../prime/quality.js";
import { evaluateContextValue } from "../prime/contextValue.js";
import {
  formatMcpBriefPrimeContext,
  formatPrimeContext,
  formatShrunkPrimeContext,
  formatSuppressedPrimeContext,
  withTinyDirectivePrime
} from "../prime/formatPrime.js";
import { estimateFileBaselineTokens } from "../metrics/baseline.js";
import { uniquePaths, uniqueStrings } from "../utils/collections.js";
import { formatContextResults } from "../context/formatContext.js";
import { failureRecommendation } from "../watch/recommendation.js";
import {
  hostSessionIdForEvent,
  hostSessionMetadata,
  isHighConfidencePrompt,
  isPromptEvent,
  isTrivialSuccessfulHook,
  stringMetadata,
  taskFromHookEvent
} from "../watch/hookPredicates.js";
import { graphReason, mergeReasonText } from "../graph/reasons.js";
import { sliceLines } from "../source/text.js";
import { IndexService } from "./services/IndexService.js";
import { MetricsService } from "./services/MetricsService.js";
import { EvalService } from "./services/EvalService.js";

export class KairnRuntime {
  private readonly rootPath: string;
  private readonly store: SqliteStore;
  private readonly indexService: IndexService;
  private readonly metricsService: MetricsService;
  private readonly evalService: EvalService;

  constructor(root?: string) {
    this.rootPath = resolveRoot(root);
    const paths = ensureKairnDir(this.rootPath);
    this.store = new SqliteStore(paths.databasePath);
    const deps = { rootPath: this.rootPath, store: this.store };
    this.indexService = new IndexService(deps);
    this.metricsService = new MetricsService(deps);
    this.evalService = new EvalService(deps, this.metricsService);
  }

  close(): void {
    this.store.close();
  }

  async init(): Promise<InitResult> {
    return this.indexService.init();
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
    format?: "standard" | "mcp_brief" | undefined;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | undefined;
    eventName?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ContextPrime> {
    await this.init();
    const task = input.task;
    const profile = resolvePrimeProfile(input.profile ?? "auto", task);
    const budget = input.budget ?? defaultPrimeBudget(profile, task);
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
    const baseQuality = evaluatePrimeQuality({
      task: resolvedTask,
      context,
      knownFiles: this.store.listFiles(session.rootPath)
    });
    const contextDecision = evaluateContextValue({
      task: resolvedTask,
      profile,
      context,
      quality: baseQuality,
      knownFiles: this.store.listFiles(session.rootPath),
      repoFileCount: this.store.listFiles(session.rootPath).length,
      estimatedContextCost: budget
    });
    const quality = {
      ...baseQuality,
      score: contextDecision.score,
      action: contextDecision.action,
      reasons: contextDecision.reasons,
      expectedSavingsRisk: contextDecision.expectedSavingsRisk
    };
    const content = input.format === "mcp_brief"
      ? formatMcpBriefPrimeContext({
          task: resolvedTask,
          sessionId: session.id,
          profile,
          budget: Math.min(budget, 360),
          context,
          files,
          quality
        })
      : quality.action === "suppress"
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
        format: input.format ?? "standard",
        quality,
        contextDecision,
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
        contextDecision,
        taskHash: sha256(resolvedTask),
        profile
      }
    });
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "context_value_decision",
      eventName: contextDecision.action,
      source: input.source ?? "cli",
      responseMode: "brief",
      baselineTokens: 0,
      outputTokens: 0,
      files,
      metadata: {
        ...contextDecision,
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
      contextDecision,
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
    return this.metricsService.getMetrics(sessionId);
  }

  getCoordinationState(sessionId: string): MetricsSummary["coordination"] {
    return this.metricsService.getCoordinationState(sessionId);
  }

  startEvalRun(input: {
    task: string;
    label: string;
    mode: EvalRunMode;
    sessionId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) {
    return this.evalService.startEvalRun(input);
  }

  ingestCodexUsage(input: {
    sessionId: string;
    runId?: string | undefined;
    usageText?: string | undefined;
    transcriptPath?: string | undefined;
  }): EvalObservationRecord {
    return this.evalService.ingestCodexUsage(input);
  }

  getEvalFeedback(input: { sessionId: string }): EvalObservationRecord {
    return this.evalService.getEvalFeedback(input);
  }

  addEvalNote(input: {
    runId: string;
    outcome: "pass" | "fail" | "partial";
    summary: string;
    files?: string[] | undefined;
    sessionId?: string | undefined;
  }): EvalObservationRecord {
    return this.evalService.addEvalNote(input);
  }

  getEvalReport(input: { runId?: string | undefined; sessionId?: string | undefined }): EvalRunReport | { runs: EvalRunReport[] } {
    return this.evalService.getEvalReport(input);
  }

  compareEvalRuns(input: { baselineRunId: string; kairnRunId: string }): EvalComparison {
    return this.evalService.compareEvalRuns(input);
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
    hybridMcpBriefCommand?: string | undefined;
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
      ...(input.mcpFirstPlusHookFullPrimeCommand ? [{ mode: "mcp_first_plus_hook_full_prime" as const, command: input.mcpFirstPlusHookFullPrimeCommand }] : []),
      ...(input.hybridMcpBriefCommand ? [{ mode: "hybrid_mcp_brief" as const, command: input.hybridMcpBriefCommand }] : [])
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
    const hybridMcpBriefReports: BenchmarkReport[] = [];

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
        if (item.mode === "hybrid_mcp_brief") hybridMcpBriefReports.push(report);
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
      hybridMcpBrief: hybridMcpBriefReports,
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
    const coordination = this.getCoordinationState(input.sessionId);
    const avoidHookFiles = (files: string[]) => uniquePaths(files).filter((file) => !coordination.hookFiles.includes(file));
    const latestFailure = [...this.store.listWatchEvents(input.sessionId)]
      .reverse()
      .find((event) => event.kind === "failure" && event.files.length > 0);

    if (latestFailure?.files[0]) {
      const related = await this.getRelatedFiles({
        sessionId: input.sessionId,
        target: latestFailure.files[0],
        budget: 500
      });
      const nextReads = uniquePaths([
        ...avoidHookFiles([latestFailure.files[0], ...related.suggestedNextContext]),
        latestFailure.files[0]
      ]).slice(0, 2);
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
      const nextReads = uniquePaths([...avoidHookFiles(diff.suggestedNextContext), ...diff.suggestedNextContext]).slice(0, 2);
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

    const context = await this.findContext({
      sessionId: input.sessionId,
      query: session.task,
      requestType: "find_context",
      budget: input.budget ?? 900,
      mode: "brief"
    });
    const nextReads = uniquePaths([...avoidHookFiles(context.suggestedNextContext), ...context.suggestedNextContext]).slice(0, 2);
    if (nextReads.length === 0) return context;
    const content = truncateToBudget(
      [
        "# Kairn Next Context",
        "",
        "## Next Reads",
        ...nextReads.map((file) => `- ${file}`),
        "",
        coordination.hookFiles.length > 0 ? `Avoiding hook-shown files: ${coordination.hookFiles.slice(0, 3).join(", ")}` : "",
        "Agent guidance: read the first file before broad scans; use the fallback only if needed."
      ].filter(Boolean).join("\n"),
      input.budget ?? 700
    );
    return {
      ...context,
      content,
      files: nextReads,
      related: nextReads.slice(1),
      suggestedNextContext: nextReads,
      tokenEstimate: estimateTokens(content),
      warnings: uniqueStrings([...context.warnings, coordination.hookFiles.length > 0 ? "Next context avoided files already emitted by the hybrid hook." : ""])
    };
  }

  recordMcpToolCall(input: {
    toolName: string;
    sessionId?: string | undefined;
    result: unknown;
    input?: unknown;
  }): void {
    this.metricsService.recordMcpToolCall(input);
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
              format: hookOutput === "mcp-brief" ? "mcp_brief" : "standard",
              source: input.event.source,
              eventName: "prime_context_hook",
              metadata: {
                promptHash,
                hostSessionId: input.event.hostSessionId ?? null,
                turnId: stringMetadata(input.event.metadata, "turn_id") ?? null,
                hookEventName: input.event.eventName,
                hookOutput,
                ...(hookOutput === "mcp-brief" ? { coordinationMode: "mcp_hybrid" } : {}),
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
        recommendation: emittedPrime ? (hookOutput === "tiny-directive" ? "tiny_prime_emitted" : hookOutput === "mcp-brief" ? "mcp_brief_prime_emitted" : "prime_emitted") : prime ? "prime_quality_suppressed" : recommendation ? "emitted" : duplicatePromptPrime ? "duplicate_suppressed" : promptHash ? "prompt_suppressed" : "suppressed",
        ...(hookOutput === "mcp-brief" ? { coordinationMode: "mcp_hybrid", hookFiles: emittedPrime?.files ?? [] } : {}),
        proactivePrime: Boolean(emittedPrime),
        primeQuality: prime?.quality,
        contextDecision: prime?.contextDecision,
        decision: prime?.contextDecision?.action,
        decisionScore: prime?.contextDecision?.score,
        decisionReasons: prime?.contextDecision?.reasons,
        estimatedContextCost: prime?.contextDecision?.estimatedContextCost,
        expectedSavingsRisk: prime?.contextDecision?.expectedSavingsRisk,
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
              input.assistanceMode === "mcp_first_plus_hook_full_prime" ||
              input.assistanceMode === "hybrid_mcp_brief"
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
    return this.indexService.refreshIndex(rootPath);
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
    rootPath?: string | undefined;
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
    this.metricsService.recordMetricsEvent({
      sessionId: input.sessionId,
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
