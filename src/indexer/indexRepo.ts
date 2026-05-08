import { buildRepoGraph } from "../graph/buildGraph.js";
import { budgetGraphEdges } from "../graph/budget.js";
import { enrichGraphWithTypeScript } from "../ts/tsGraph.js";
import { buildLexicalIndex, type LexicalIndex } from "../lexical/bm25.js";
import { parseSourceFile } from "../parser/parseFile.js";
import { readTextFile } from "../retrieval/readSource.js";
import { scanRepo } from "../scanner/scanRepo.js";
import { buildSemanticChunks } from "../semantic/chunk.js";
import { embedText, VECTOR_DIMENSIONS } from "../semantic/vector.js";
import type { RepoGraph, ScanResult, SemanticChunkRecord, SemanticVectorRecord } from "../types.js";
import { loadIndexingConfig } from "../config/indexing.js";

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
  const parsedFiles = scan.files.filter(shouldParseFile).map((file) => {
    try {
      return parseSourceFile({
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
  });
  const baseGraph = buildRepoGraph({
    rootPath,
    files: scan.files,
    parsedFiles
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
    chunks: semanticChunks
  });

  return {
    scan,
    graph,
    semanticChunks,
    semanticVectors,
    lexical
  };
}

function shouldParseFile(file: { indexTier?: string; kind: string; language: string }): boolean {
  if (file.indexTier === "tier0") return false;
  return (
    file.kind === "source" ||
    file.kind === "component" ||
    file.kind === "route" ||
    file.kind === "test" ||
    ["typescript", "javascript", "python", "java", "c", "cpp"].includes(file.language)
  );
}

function selectSemanticChunks(chunks: SemanticChunkRecord[], maxChunks: number): SemanticChunkRecord[] {
  return chunks
    .slice()
    .sort((a, b) => chunkPriority(b) - chunkPriority(a) || a.filePath.localeCompare(b.filePath) || a.id.localeCompare(b.id))
    .slice(0, maxChunks)
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.id.localeCompare(b.id));
}

function chunkPriority(chunk: SemanticChunkRecord): number {
  const filePath = chunk.filePath.toLowerCase();
  let score = chunk.kind === "symbol" ? 90 : 30;
  if (filePath.startsWith("src/") || filePath.includes("/src/")) score += 35;
  if (filePath.startsWith("packages/") || filePath.includes("/packages/")) score += 24;
  if (filePath.startsWith("include/") || filePath.includes("/include/")) score += 30;
  if (filePath.startsWith("django/") || filePath.startsWith("lib/")) score += 24;
  if (/(^|\/)(tests?|spec)\//.test(filePath)) score -= 8;
  if (/(^|\/)(docs?|documentation|examples|demo|demos|fixtures|fixture|generated|dist|build|coverage|website|site|playground|storybook|codemods?|devtools)\//.test(filePath)) {
    score -= 80;
  }
  if (chunk.tokenEstimate > 1_500) score -= 10;
  return score;
}
