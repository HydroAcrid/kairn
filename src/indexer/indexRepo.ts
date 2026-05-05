import { buildRepoGraph } from "../graph/buildGraph.js";
import { parseSourceFile } from "../parser/parseFile.js";
import { readTextFile } from "../retrieval/readSource.js";
import { scanRepo } from "../scanner/scanRepo.js";
import { buildSemanticChunks } from "../semantic/chunk.js";
import { embedText, VECTOR_DIMENSIONS } from "../semantic/vector.js";
import type { RepoGraph, ScanResult, SemanticChunkRecord, SemanticVectorRecord } from "../types.js";

export type RepoIndex = {
  scan: ScanResult;
  graph: RepoGraph;
  semanticChunks: SemanticChunkRecord[];
  semanticVectors: SemanticVectorRecord[];
};

export async function indexRepo(rootPath: string): Promise<RepoIndex> {
  const scan = await scanRepo(rootPath);
  const parsedFiles = scan.files.map((file) => {
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
  const graph = buildRepoGraph({
    rootPath,
    files: scan.files,
    parsedFiles
  });
  const semanticChunks = buildSemanticChunks(rootPath, graph);
  const semanticVectors = semanticChunks.map((chunk) => ({
    rootPath,
    chunkId: chunk.id,
    dimensions: VECTOR_DIMENSIONS,
    vector: embedText(chunk.text)
  }));

  return {
    scan,
    graph,
    semanticChunks,
    semanticVectors
  };
}
