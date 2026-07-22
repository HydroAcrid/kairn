// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { buildRepoGraph } from "../graph/buildGraph.js";
import { budgetGraphEdges } from "../graph/budget.js";
import { enrichGraphWithTypeScript } from "../ts/tsGraph.js";
import { buildLexicalIndex, type LexicalIndex } from "../lexical/bm25.js";
import { parseSourceFile } from "../parser/parseFile.js";
import { readTextFile } from "../retrieval/readSource.js";
import { scanRepo } from "../scanner/scanRepo.js";
import { buildSemanticChunks } from "../semantic/chunk.js";
import { embedText, VECTOR_DIMENSIONS } from "../semantic/vector.js";
import type { ParsedFile, RepoGraph, ScanResult, SemanticChunkRecord, SemanticVectorRecord } from "../types.js";
import { loadIndexingConfig } from "../config/indexing.js";
import { compactParsedSymbols } from "./symbolCompaction.js";

export type RepoIndex = {
  scan: ScanResult;
  graph: RepoGraph;
  semanticChunks: SemanticChunkRecord[];
  semanticVectors: SemanticVectorRecord[];
  lexical: LexicalIndex;
};

export async function indexRepo(rootPath: string): Promise<RepoIndex> {
  const config = loadIndexingConfig(rootPath);
  const scan = await scanRepo(rootPath);
  const parsedFiles = await parseFilesWithLimit({
    rootPath,
    files: scan.files.filter(shouldParseFile),
    concurrency: process.platform === "win32" ? 1 : 8
  });
  const compactedParsedFiles = compactParsedSymbols({
    files: scan.files,
    parsedFiles,
    maxStateMb: config.maxStateMb
  });
  const baseGraph = buildRepoGraph({
    rootPath,
    files: scan.files,
    parsedFiles: compactedParsedFiles,
    goModules: loadGoModules(rootPath, scan.files)
  });
  const enrichedGraph = await enrichGraphWithTypeScript({
    rootPath,
    graph: baseGraph
  });
  const graph = {
    ...enrichedGraph,
    edges: budgetGraphEdges({
      edges: enrichedGraph.edges,
      files: enrichedGraph.files,
      budget: {
        maxTotalEdges: config.maxGraphEdges,
        maxTypeScriptEnrichmentEdges: 10_000
      }
    })
  };
  const semanticChunks = selectSemanticChunks(buildSemanticChunks(rootPath, graph), config.maxSemanticChunks);
  const semanticVectors = semanticChunks.map((chunk) => ({
    rootPath,
    chunkId: chunk.id,
    dimensions: VECTOR_DIMENSIONS,
    vector: embedText(chunk.text)
  }));
  const lexical = buildLexicalIndex({
    rootPath,
    files: graph.files,
    symbols: graph.symbols,
    chunks: semanticChunks,
    maxStateMb: config.maxStateMb
  });

  return {
    scan,
    graph,
    semanticChunks,
    semanticVectors,
    lexical
  };
}

async function parseFilesWithLimit(input: {
  rootPath: string;
  files: Array<{ path: string; language: string }>;
  concurrency: number;
}): Promise<ParsedFile[]> {
  const results: ParsedFile[] = [];
  const concurrency = Math.max(1, Math.min(input.concurrency, input.files.length || 1));
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < input.files.length) {
      const file = input.files[nextIndex];
      nextIndex += 1;
      if (!file) continue;
      results.push(await parseIndexedFile(input.rootPath, file));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

async function parseIndexedFile(rootPath: string, file: { path: string; language: string }): Promise<ParsedFile> {
  try {
    return await parseSourceFile({
      rootPath,
      filePath: file.path,
      content: readTextFile(rootPath, file.path),
      language: file.language
    });
  } catch {
    return {
      rootPath,
      filePath: file.path,
      language: file.language,
      symbols: [],
      imports: [],
      hasErrors: true
    };
  }
}

function shouldParseFile(file: { indexTier?: string; kind: string; language: string }): boolean {
  if (file.indexTier === "tier0") return false;
  return (
    file.kind === "source" ||
    file.kind === "component" ||
    file.kind === "route" ||
    file.kind === "test" ||
    ["typescript", "javascript", "python", "go", "java", "kotlin", "c", "cpp"].includes(file.language)
  );
}

function loadGoModules(
  rootPath: string,
  files: Array<{ path: string; indexTier?: string }>
): Array<{ directory: string; modulePath: string }> {
  const modules: Array<{ directory: string; modulePath: string }> = [];

  for (const file of files) {
    if (path.posix.basename(file.path) !== "go.mod" || file.indexTier === "tier0") continue;
    try {
      const rawModulePath = readTextFile(rootPath, file.path).match(/^\s*module\s+(\S+)/m)?.[1];
      const modulePath = rawModulePath?.replace(/^["`]|["`]$/g, "");
      if (!modulePath) continue;
      modules.push({
        directory: path.posix.dirname(file.path),
        modulePath
      });
    } catch {
      // A missing or unreadable module manifest simply disables local Go
      // package edges; lexical and symbol evidence remain available.
    }
  }

  return modules.sort((a, b) => a.directory.localeCompare(b.directory) || a.modulePath.localeCompare(b.modulePath));
}

function selectSemanticChunks(chunks: SemanticChunkRecord[], maxChunks: number): SemanticChunkRecord[] {
  const ranked = chunks
    .slice()
    .sort((a, b) => chunkPriority(b) - chunkPriority(a) || a.filePath.localeCompare(b.filePath) || a.id.localeCompare(b.id));
  const selectedById = new Set<string>();
  const selected: SemanticChunkRecord[] = [];
  const fileSeen = new Set<string>();

  for (const chunk of ranked) {
    if (fileSeen.has(chunk.filePath)) continue;
    fileSeen.add(chunk.filePath);
    selectedById.add(chunk.id);
    selected.push(chunk);
    if (selected.length >= maxChunks) break;
  }

  for (const chunk of ranked) {
    if (selected.length >= maxChunks) break;
    if (selectedById.has(chunk.id)) continue;
    selectedById.add(chunk.id);
    selected.push(chunk);
  }

  return selected
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.id.localeCompare(b.id));
}

function chunkPriority(chunk: SemanticChunkRecord): number {
  const filePath = chunk.filePath.toLowerCase();
  let score = chunk.kind === "symbol" ? 90 : 30;
  if (filePath.startsWith("src/") || filePath.includes("/src/")) score += 35;
  if (filePath.startsWith("packages/") || filePath.includes("/packages/")) score += 24;
  if (filePath.startsWith("include/") || filePath.includes("/include/")) score += 30;
  if (filePath.startsWith("lib/") || filePath.includes("/lib/")) score += 24;
  if (/(^|\/)(utils?|helpers?|shared|common)(\/|\.|-|_)/.test(filePath)) score += 42;
  if (/(^|\/)[a-z0-9]+(?:[-_][a-z0-9]+){1,}\.[a-z0-9]+$/.test(filePath)) score += 18;
  if (/(^|\/)(index|main|router|client|server|core)\.[cm]?[jt]sx?$/.test(filePath)) score -= 18;
  if (/(^|\/)(tests?|spec)\//.test(filePath)) score -= 8;
  if (/(^|\/)(docs?|documentation|examples|demo|demos|fixtures?|__fixtures__|compiled|generated|gen|vendor|third[_-]party|dist|build|coverage|website|site|playground|storybook|codemods?|devtools)\//.test(filePath)) {
    score -= 80;
  }
  if (chunk.tokenEstimate < 450 && chunk.kind === "symbol") score += 8;
  if (chunk.tokenEstimate > 1_500) score -= 10;
  return score;
}
