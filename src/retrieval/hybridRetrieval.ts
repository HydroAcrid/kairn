import type {
  ContextShownRecord,
  FileRecord,
  GraphEdgeRecord,
  HybridScoredResult,
  SemanticChunkRecord,
  SemanticVectorRecord,
  SymbolRecord
} from "../types.js";
import { cosineSimilarity, embedText } from "../semantic/vector.js";
import { scoreFiles } from "./scoreResults.js";

export function hybridSearch(input: {
  files: FileRecord[];
  query: string;
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  vectors: SemanticVectorRecord[];
  edges: GraphEdgeRecord[];
  shown?: ContextShownRecord[];
  changedFiles?: Set<string>;
}): HybridScoredResult[] {
  const keywordScores = new Map(scoreFiles(input.files, input.query, input.symbols).map((file) => [file.path, file]));
  const semanticScores = scoreSemanticChunks(input.query, input.chunks, input.vectors);
  const graphScores = scoreGraphNeighbors(input.edges, keywordScores, semanticScores);
  const shownFiles = new Set((input.shown ?? []).map((record) => record.filePath).filter((filePath): filePath is string => Boolean(filePath)));

  return input.files
    .map((file) => {
      const keyword = keywordScores.get(file.path);
      const semantic = semanticScores.get(file.path);
      const graphScore = graphScores.get(file.path) ?? 0;
      const sessionScore = shownFiles.has(file.path) ? -3 : 0;
      const gitScore = input.changedFiles?.has(file.path) ? 8 : 0;
      const semanticScore = semantic?.score ?? 0;
      const keywordScore = keyword?.score ?? 0;
      const importanceScore = file.importance;
      const reasons = mergeReasons([
        ...(keyword?.reasons ?? []),
        ...(semantic && semantic.score > 0.06 ? semanticReasons(semantic.chunks) : []),
        ...(graphScore > 0 ? ["graph neighbor"] : []),
        ...(shownFiles.has(file.path) ? ["already shown"] : []),
        ...(gitScore > 0 ? ["changed in diff"] : [])
      ]);
      const score =
        importanceScore +
        keywordScore * 1.15 +
        semanticScore * 42 +
        graphScore +
        sessionScore +
        gitScore;

      return {
        ...file,
        score: Number(score.toFixed(3)),
        reasons,
        semanticScore: Number(semanticScore.toFixed(3)),
        keywordScore: Number(keywordScore.toFixed(3)),
        graphScore,
        sessionScore,
        importanceScore,
        gitScore,
        chunks: semantic?.chunks ?? []
      };
    })
    .filter((file) => file.score > 0 && file.reasons.length > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function scoreSemanticChunks(
  query: string,
  chunks: SemanticChunkRecord[],
  vectors: SemanticVectorRecord[]
): Map<string, { score: number; chunks: SemanticChunkRecord[] }> {
  const queryVector = embedText(query);
  if (queryVector.every((value) => value === 0)) return new Map();

  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const scoredChunks = vectors
    .map((vector) => {
      const chunk = chunksById.get(vector.chunkId);
      if (!chunk) return undefined;
      return {
        chunk,
        score: cosineSimilarity(queryVector, vector.vector)
      };
    })
    .filter((item): item is { chunk: SemanticChunkRecord; score: number } => item !== undefined && item.score > 0.02)
    .sort((a, b) => b.score - a.score || a.chunk.filePath.localeCompare(b.chunk.filePath));

  const byFile = new Map<string, { score: number; chunks: SemanticChunkRecord[] }>();
  for (const item of scoredChunks) {
    const existing = byFile.get(item.chunk.filePath);
    const score = Math.max(existing?.score ?? 0, item.score);
    byFile.set(item.chunk.filePath, {
      score,
      chunks: [...(existing?.chunks ?? []), item.chunk].slice(0, 3)
    });
  }

  return byFile;
}

function scoreGraphNeighbors(
  edges: GraphEdgeRecord[],
  keywordScores: Map<string, { score: number }>,
  semanticScores: Map<string, { score: number }>
): Map<string, number> {
  const seeds = new Set<string>();
  for (const [filePath, scored] of keywordScores) {
    if (scored.score >= 10) seeds.add(filePath);
  }
  for (const [filePath, scored] of semanticScores) {
    if (scored.score >= 0.12) seeds.add(filePath);
  }

  const scores = new Map<string, number>();
  for (const edge of edges) {
    if (seeds.has(edge.fromFile)) {
      scores.set(edge.toFile, (scores.get(edge.toFile) ?? 0) + graphWeight(edge.type));
    }
    if (seeds.has(edge.toFile)) {
      scores.set(edge.fromFile, (scores.get(edge.fromFile) ?? 0) + graphWeight(edge.type));
    }
  }

  return scores;
}

function graphWeight(type: GraphEdgeRecord["type"]): number {
  if (type === "tested_by" || type === "test_for") return 6;
  if (type === "imports" || type === "imported_by") return 5;
  if (type === "parent_route") return 4;
  return 2;
}

function semanticReasons(chunks: SemanticChunkRecord[]): string[] {
  return chunks.map((chunk) => chunk.symbol ? `semantic match: ${chunk.symbol}` : "semantic match");
}

function mergeReasons(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, 8);
}
