import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import type { ContextQueryMode, ContextResponse, FileRecord, HybridScoredResult, InitResult, OutputKind, TaskSession } from "../types.js";
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
        scored
      }),
      input.budget
    );

    this.recordShown(input.sessionId, "context", decision.mode, content);

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
  }): ContextResponse {
    this.store.getSession(input.sessionId);
    const content = compressOutputText(input.output, input.type, input.budget);

    this.store.recordCommand({
      sessionId: input.sessionId,
      type: input.type,
      summary: content
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
  scored: HybridScoredResult[];
}): string {
  const highConfidence =
    input.scored.length > 0
      ? input.scored
          .map((file) => {
            const scoreBreakdown = [
              `semantic ${file.semanticScore}`,
              `keyword ${file.keywordScore}`,
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
    `Selection: ${input.decisionReason}`,
    "",
    "## Ranked Files",
    highConfidence
  ];

  if (input.mode === "snippets" || input.mode === "exact_code") {
    sections.push("", "## Matched Snippets", formatMatchedSnippets(input.scored.slice(0, 5)));
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

function formatMatchedSnippets(files: HybridScoredResult[]): string {
  const snippets = files.flatMap((file) =>
    file.chunks.slice(0, 2).map((chunk) => {
      const title = chunk.symbol
        ? `${file.path} :: ${chunk.symbol} (${chunk.startLine ?? "?"}-${chunk.endLine ?? "?"})`
        : file.path;
      return [
        `### ${title}`,
        "",
        "```",
        chunk.text.split(/\r?\n/).slice(0, 80).join("\n"),
        "```"
      ].join("\n");
    })
  );

  return snippets.length > 0 ? snippets.join("\n\n") : "No semantic snippets were available for the top files.";
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
