import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import type {
  BenchmarkComparison,
  BenchmarkReport,
  BenchmarkResultRecord,
  BenchmarkRunMode,
  ContextQueryMode,
  ContextResponse,
  ContextResponseMode,
  CodexUsageRecord,
  EvalComparison,
  EvalObservationRecord,
  EvalRunMode,
  EvalRunReport,
  FileRecord,
  BenchmarkCaseMode,
  HookHandlingResult,
  HybridScoredResult,
  InitResult,
  MetricsBucket,
  MetricsEventKind,
  MetricsSummary,
  NormalizedHookEvent,
  OutputKind,
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
      semanticVectors: index.semanticVectors
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

  getSession(sessionId: string): TaskSession {
    return this.store.getSession(sessionId);
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

    return this.store.recordEvalObservation({
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
        agentConfigured: Boolean(input.agentCommand)
      }
    });

    for (const benchmarkCase of suite.cases.filter((item) => benchmarkCaseApplies(item.mode, input.mode))) {
      const result =
        benchmarkCase.mode === "agent"
          ? this.runAgentBenchmarkCase({
              runId: run.id,
              benchmarkCase,
              agentCommand: input.agentCommand,
              agentTimeoutMs: input.agentTimeoutMs
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
    const changedFiles = await this.getChangedFiles(session.rootPath);
    const query = input.query ?? session.task;
    const intent = classifyQueryIntent(query);
    const scored = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors,
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
    sessionId: string;
    event: NormalizedHookEvent;
  }): Promise<HookHandlingResult> {
    const session = this.store.getSession(input.sessionId);
    await this.refreshIndex(session.rootPath);
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
    const shouldCompressOutput =
      Boolean(input.event.output) &&
      !isPromptEvent(input.event.eventName) &&
      !isTrivialSuccessfulHook({
        eventKind: kind,
        command: input.event.command,
        output: input.event.output,
        linkedFiles,
        exitCode: input.event.exitCode
      });
    const response = shouldCompressOutput
      ? this.compressOutput({
          sessionId: input.sessionId,
          type: outputKind,
          output: input.event.output!,
          budget: 1200,
          source: input.event.source,
          eventName: input.event.eventName
        })
      : await this.promptContextResponse({
          sessionId: input.sessionId,
          eventName: input.event.eventName,
          prompt: input.event.output
        });
    const recommendation = await this.recommendFromHook({
      sessionId: input.sessionId,
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
      response?.content ? response.content : ""
    ].filter(Boolean).join("\n\n");
    const event = this.recordWatchEvent({
      sessionId: input.sessionId,
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
        ...(input.event.timestamp ? { timestamp: input.event.timestamp } : {})
      }
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "hook_signal",
      eventName: recommendation ? "hook_recommendation_emitted" : "hook_recommendation_suppressed",
      source: input.event.source,
      baselineTokens: 0,
      outputTokens: recommendation?.content ? estimateTokens(recommendation.content) : 0,
      files: recommendation?.files ?? linkedFiles,
      metadata: {
        eventName: input.event.eventName,
        hookKind: kind,
        outputKind,
        linkedFiles: linkedFiles.length,
        recommendation: recommendation ? "emitted" : "suppressed",
        compressedOutput: Boolean(response),
        trivialSuccessfulOutput: Boolean(input.event.output) && !shouldCompressOutput && !response
      }
    });

    return {
      event,
      ...(recommendation ? { recommendation } : {}),
      ...(response ? { response } : {})
    };
  }

  listWatchEvents(sessionId: string, limit?: number): WatchEventRecord[] {
    this.store.getSession(sessionId);
    return this.store.listWatchEvents(sessionId, limit);
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

  private runAgentBenchmarkCase(input: {
    runId: string;
    benchmarkCase: Parameters<typeof scoreBenchmarkCase>[0]["benchmarkCase"];
    agentCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
  }): Omit<BenchmarkResultRecord, "id" | "createdAt"> {
    const result = runAgentBenchmarkCase({
      rootPath: this.rootPath,
      benchmarkCase: input.benchmarkCase,
      agentCommand: input.agentCommand,
      timeoutMs: input.agentTimeoutMs
    });
    return scoreBenchmarkCase({
      runId: input.runId,
      benchmarkCase: input.benchmarkCase,
      actualFiles: result.actualFiles,
      responseTokens: result.responseTokens,
      observedCodexTokens: result.observedCodexTokens,
      taskOutcome: result.outcome,
      summary: result.summary,
      metadata: result.metadata
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
      semanticVectors: index.semanticVectors
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
              `semantic ${file.semanticScore}`,
              `keyword ${file.keywordScore}`,
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

function isHighConfidencePrompt(eventName: string, prompt: string | undefined): boolean {
  if (!isPromptEvent(eventName) || !prompt) return false;
  const normalized = prompt.toLowerCase();
  if (normalized.startsWith("run ") || normalized.includes("do not edit files")) return false;
  return /\b(fix|implement|update|refactor|debug|error|failing|component|api|layout|parser|mobile|test|hook|metrics|eval)\b/.test(normalized);
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
  return type;
}

function mergeReasonText(left: string | undefined, right: string): string {
  return [...new Set([...(left?.split("; ") ?? []), right])].filter(Boolean).join("; ");
}

function uniquePaths(files: string[]): string[] {
  return [...new Set(files.map((file) => normalizeRelativePath(file).replace(/^\.\//, "")).filter(Boolean))].sort();
}
