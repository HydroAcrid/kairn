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
import { buildSemanticDocuments } from "../semantic/documents.js";
import { embedText, VECTOR_DIMENSIONS } from "../semantic/vector.js";
import {
  loadLocalEmbeddingModel,
  quantizeSemanticEmbedding
} from "../semantic/modelRuntime.js";
import { getSemanticModelState } from "../semantic/modelManager.js";
import { DEFAULT_SEMANTIC_MODEL_ID } from "../semantic/modelRegistry.js";
import type {
  ParsedFile,
  RepoGraph,
  ScanResult,
  SemanticChunkRecord,
  SemanticDocumentRecord,
  SemanticEmbeddingRecord,
  SemanticRetrieverConfig,
  SemanticVectorRecord
} from "../types.js";
import { loadIndexingConfig } from "../config/indexing.js";
import { resolveSemanticRetrieverConfig } from "../config/semantic.js";
import { compactParsedSymbols } from "./symbolCompaction.js";

export type RepoIndex = {
  scan: ScanResult;
  graph: RepoGraph;
  semanticChunks: SemanticChunkRecord[];
  semanticVectors: SemanticVectorRecord[];
  semanticDocuments: SemanticDocumentRecord[];
  semanticEmbeddings: SemanticEmbeddingRecord[];
  semanticStatus: {
    modelId?: string;
    status: "disabled" | "unavailable" | "corrupt" | "incompatible" | "ready";
    reusedEmbeddings: number;
    createdEmbeddings: number;
    error?: string;
  };
  lexical: LexicalIndex;
};

export async function indexRepo(rootPath: string, options?: {
  semantic?: SemanticRetrieverConfig;
  existingEmbeddings?: SemanticEmbeddingRecord[];
  onSemanticEmbeddingBatch?: (embeddings: SemanticEmbeddingRecord[]) => void;
}): Promise<RepoIndex> {
  const config = loadIndexingConfig(rootPath);
  const semanticConfig = resolveSemanticRetrieverConfig(rootPath, options?.semantic);
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
  const semanticDocuments = semanticConfig.mode === "legacy"
    ? []
    : buildSemanticDocuments({
        rootPath,
        graph,
        maxDocuments: config.maxSemanticChunks
      });
  const semanticIndex = await buildModelEmbeddings({
    rootPath,
    config: semanticConfig,
    documents: semanticDocuments,
    existing: options?.existingEmbeddings ?? [],
    ...(options?.onSemanticEmbeddingBatch
      ? { onEmbeddingBatch: options.onSemanticEmbeddingBatch }
      : {})
  });
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
    semanticDocuments,
    semanticEmbeddings: semanticIndex.embeddings,
    semanticStatus: semanticIndex.status,
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
  const fileSummaries = chunks
    .filter((chunk) => chunk.kind === "file_summary")
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.id.localeCompare(right.id));
  const selected = fileSummaries.slice(0, maxChunks);
  if (selected.length >= maxChunks) return selected;
  const symbolsByFile = new Map<string, SemanticChunkRecord[]>();
  for (const chunk of chunks
    .filter((candidate) => candidate.kind === "symbol")
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.id.localeCompare(right.id))) {
    symbolsByFile.set(chunk.filePath, [...(symbolsByFile.get(chunk.filePath) ?? []), chunk]);
  }
  const paths = [...symbolsByFile.keys()].sort();
  const cursors = new Map(paths.map((filePath) => [filePath, 0]));
  let progressed = true;
  while (selected.length < maxChunks && progressed) {
    progressed = false;
    for (const filePath of paths) {
      const cursor = cursors.get(filePath) ?? 0;
      const chunk = symbolsByFile.get(filePath)?.[cursor];
      if (!chunk) continue;
      selected.push(chunk);
      cursors.set(filePath, cursor + 1);
      progressed = true;
      if (selected.length >= maxChunks) break;
    }
  }
  return selected.sort((left, right) =>
    left.filePath.localeCompare(right.filePath) || left.id.localeCompare(right.id)
  );
}

async function buildModelEmbeddings(input: {
  rootPath: string;
  config: SemanticRetrieverConfig;
  documents: SemanticDocumentRecord[];
  existing: SemanticEmbeddingRecord[];
  onEmbeddingBatch?: (embeddings: SemanticEmbeddingRecord[]) => void;
}): Promise<{
  embeddings: SemanticEmbeddingRecord[];
  status: RepoIndex["semanticStatus"];
}> {
  const modelId = input.config.modelId ?? DEFAULT_SEMANTIC_MODEL_ID;
  if (input.config.mode === "legacy") {
    return {
      embeddings: [],
      status: { status: "disabled", reusedEmbeddings: 0, createdEmbeddings: 0 }
    };
  }
  const state = getSemanticModelState({
    modelId,
    ...(input.config.modelPath ? { modelPath: input.config.modelPath } : {})
  });
  if (state.status !== "ready") {
    return {
      embeddings: [],
      status: {
        modelId,
        status: state.status,
        reusedEmbeddings: 0,
        createdEmbeddings: 0,
        ...(state.error ? { error: state.error } : {})
      }
    };
  }

  try {
    const model = await loadLocalEmbeddingModel({
      modelId,
      ...(input.config.modelPath ? { modelPath: input.config.modelPath } : {})
    });
    const existingByDocument = new Map(
      input.existing
        .filter((embedding) =>
          embedding.modelId === model.manifest.modelId &&
          embedding.schemaVersion === model.manifest.documentSchemaVersion &&
          embedding.dimensions === model.manifest.dimensions
        )
        .map((embedding) => [embedding.documentId, embedding])
    );
    const embeddings: SemanticEmbeddingRecord[] = [];
    const missing: SemanticDocumentRecord[] = [];
    for (const document of input.documents) {
      const existing = existingByDocument.get(document.id);
      if (existing?.documentHash === document.hash) embeddings.push(existing);
      else missing.push(document);
    }

    const batchSize = 16;
    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const batch = missing.slice(offset, offset + batchSize);
      const vectors = await model.embedDocuments(batch.map((document) => document.text));
      for (let index = 0; index < batch.length; index += 1) {
        const document = batch[index]!;
        embeddings.push(quantizeSemanticEmbedding({
          rootPath: input.rootPath,
          documentId: document.id,
          documentHash: document.hash,
          modelId: model.manifest.modelId,
          schemaVersion: model.manifest.documentSchemaVersion,
          vector: vectors[index]!
        }));
      }
      input.onEmbeddingBatch?.(embeddings.slice(-batch.length));
      await yieldToSemanticCheckpointTimers();
    }

    return {
      embeddings: embeddings.sort((left, right) => left.documentId.localeCompare(right.documentId)),
      status: {
        modelId: model.manifest.modelId,
        status: "ready",
        reusedEmbeddings: input.documents.length - missing.length,
        createdEmbeddings: missing.length
      }
    };
  } catch (error) {
    return {
      embeddings: [],
      status: {
        modelId,
        status: "incompatible",
        reusedEmbeddings: 0,
        createdEmbeddings: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function yieldToSemanticCheckpointTimers(): Promise<void> {
  // ONNX/WASM can resolve successive batches through a continuous microtask
  // chain. Yield to the event loop so background progress and snapshot timers
  // are not starved during long cold indexes.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
