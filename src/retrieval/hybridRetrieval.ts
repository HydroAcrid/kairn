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
import { tokenizeLexical } from "../semantic/tokenize.js";
import { classifyQueryIntent, type QueryIntent } from "./queryIntent.js";
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
  const intent = classifyQueryIntent(input.query);
  const keywordScores = new Map(scoreFiles(input.files, input.query, input.symbols).map((file) => [file.path, file]));
  const semanticScores = scoreSemanticChunks(input.query, input.chunks, input.vectors);
  const symbolsByFile = groupByFile(input.symbols, (symbol) => symbol.filePath);
  const chunksByFile = groupByFile(input.chunks, (chunk) => chunk.filePath);
  const intentScores = scoreIntentMatches(input.files, intent, input.query, symbolsByFile, chunksByFile);
  const graphScores = scoreGraphNeighbors(input.edges, keywordScores, semanticScores, intentScores, intent, input.files);
  const shownFiles = new Set((input.shown ?? []).map((record) => record.filePath).filter((filePath): filePath is string => Boolean(filePath)));

  return input.files
    .map((file) => {
      const keyword = keywordScores.get(file.path);
      const semantic = semanticScores.get(file.path);
      const intentMatch = intentScores.get(file.path);
      const graphScore = graphScores.get(file.path) ?? 0;
      const sessionScore = shownFiles.has(file.path) ? -3 : 0;
      const gitScore = input.changedFiles?.has(file.path) ? 8 : 0;
      const semanticScore = semantic?.score ?? 0;
      const keywordScore = keyword?.score ?? 0;
      const intentScore = intentMatch?.score ?? 0;
      const importanceScore = file.importance;
      const reasons = mergeReasons([
        ...(keyword?.reasons ?? []),
        ...(semantic && semantic.score > 0.06 ? semanticReasons(semantic.chunks) : []),
        ...(intentMatch?.reasons ?? []),
        ...(graphScore > 0 ? ["graph neighbor"] : []),
        ...(shownFiles.has(file.path) ? ["already shown"] : []),
        ...(gitScore > 0 ? ["changed in diff"] : [])
      ]);
      const score =
        importanceScore +
        keywordScore * 1.15 +
        semanticScore * 42 +
        intentScore +
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
        intentScore,
        sessionScore,
        importanceScore,
        gitScore,
        chunks: semantic?.chunks ?? selectIntentChunks(chunksByFile.get(file.path) ?? [], intent)
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
  semanticScores: Map<string, { score: number }>,
  intentScores: Map<string, { score: number }>,
  intent: QueryIntent,
  files: FileRecord[]
): Map<string, number> {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const seeds = new Set<string>();
  for (const [filePath, scored] of keywordScores) {
    if (scored.score >= 18 && isGraphSeedAllowed(filesByPath.get(filePath), intent, intentScores.get(filePath)?.score ?? 0)) {
      seeds.add(filePath);
    }
  }
  for (const [filePath, scored] of semanticScores) {
    if (scored.score >= 0.14 && isGraphSeedAllowed(filesByPath.get(filePath), intent, intentScores.get(filePath)?.score ?? 0)) {
      seeds.add(filePath);
    }
  }
  for (const [filePath, scored] of intentScores) {
    if (scored.score >= 18) {
      seeds.add(filePath);
    }
  }

  const scores = new Map<string, number>();
  for (const edge of edges) {
    if (seeds.has(edge.fromFile)) {
      const target = filesByPath.get(edge.toFile);
      scores.set(edge.toFile, (scores.get(edge.toFile) ?? 0) + graphWeight(edge.type, intent, target));
    }
    if (seeds.has(edge.toFile)) {
      const target = filesByPath.get(edge.fromFile);
      scores.set(edge.fromFile, (scores.get(edge.fromFile) ?? 0) + graphWeight(edge.type, intent, target));
    }
  }

  const capped = new Map<string, number>();
  for (const [filePath, score] of scores) {
    capped.set(filePath, Math.min(score, graphCap(intent, filesByPath.get(filePath))));
  }
  return capped;
}

function graphWeight(type: GraphEdgeRecord["type"], intent: QueryIntent, target?: FileRecord): number {
  if ((type === "tested_by" || type === "test_for") && intent.primary !== "test") return 2;
  if (type === "tested_by" || type === "test_for") return 42;
  if (intent.primary === "ui" && target && !isUiFile(target)) return 2;
  if (type === "imports" || type === "imported_by") return 5;
  if (type === "parent_route") return 4;
  return 2;
}

function semanticReasons(chunks: SemanticChunkRecord[]): string[] {
  return chunks.map((chunk) => chunk.symbol ? `semantic match: ${chunk.symbol}` : "semantic match");
}

function mergeReasons(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, 10);
}

function scoreIntentMatches(
  files: FileRecord[],
  intent: QueryIntent,
  query: string,
  symbolsByFile: Map<string, SymbolRecord[]>,
  chunksByFile: Map<string, SemanticChunkRecord[]>
): Map<string, { score: number; reasons: string[] }> {
  const scores = new Map<string, { score: number; reasons: string[] }>();
  const queryTerms = new Set(tokenizeLexical(query));

  for (const file of files) {
    const reasons: string[] = [];
    let score = 0;
    const fileText = [
      file.path,
      file.kind,
      ...(symbolsByFile.get(file.path)?.map((symbol) => symbol.name) ?? []),
      ...(chunksByFile.get(file.path)?.map((chunk) => `${chunk.symbol ?? ""} ${chunk.text.slice(0, 1200)}`) ?? [])
    ].join(" ").toLowerCase();
    const basename = file.path.toLowerCase().split("/").at(-1) ?? file.path.toLowerCase();
    const matchedTerms = intent.matchedTerms.filter((term) => fileText.includes(term));
    const domainTerms = [...queryTerms].filter((term) => !intent.matchedTerms.includes(term) && !GENERIC_DOMAIN_TERMS.has(term));
    const matchedDomainTerms = domainTerms.filter((term) => fileText.includes(term));
    const filenameIntentTerms = intent.matchedTerms.filter((term) => basename.includes(term));
    const filenameDomainTerms = domainTerms.filter((term) => basename.includes(term));

    if (intent.primary === "ui") {
      if (isUiFile(file)) {
        score += 34;
        reasons.push("ui intent file");
      }
      if (/\.(tsx|jsx)$/.test(file.path)) {
        score += 18;
        reasons.push("tsx/jsx UI surface");
      }
      if (file.path.startsWith("app/") || file.path.startsWith("src/app/")) {
        score += 22;
        reasons.push("app route surface");
      }
      if (isUiControlSurface(file)) {
        score += 14;
        reasons.push("ui control surface");
      }
      if (matchedTerms.length > 0) {
        score += matchedTerms.length * 9;
        reasons.push(`ui term match: ${matchedTerms.slice(0, 3).join(", ")}`);
      }
      if (filenameIntentTerms.length > 0) {
        score += filenameIntentTerms.reduce((total, term) => total + (GENERIC_UI_FILENAME_TERMS.has(term) ? 18 : 46), 0);
        reasons.push(`ui filename intent match: ${filenameIntentTerms.slice(0, 3).join(", ")}`);
      }
      if (matchedDomainTerms.length > 0) {
        score += matchedDomainTerms.length * 14;
        reasons.push(`domain term match: ${matchedDomainTerms.slice(0, 3).join(", ")}`);
      } else if (domainTerms.length > 0 && isUiFile(file)) {
        score -= 12;
        reasons.push("missing domain term for ui intent");
      }
      if (filenameDomainTerms.length > 0) {
        score += filenameDomainTerms.length * 26;
        reasons.push(`domain filename match: ${filenameDomainTerms.slice(0, 3).join(", ")}`);
      }
      if (isBackendHeavy(file) && !hasSpecificBackendIntent(queryTerms)) {
        score -= 42;
        reasons.push("backend file downranked for ui intent");
      }
      if (file.kind === "test" && !queryTerms.has("test") && !queryTerms.has("tests")) {
        score -= 16;
        reasons.push("test downranked for ui intent");
      }
    } else if (intent.primary === "backend" || intent.primary === "data" || intent.primary === "auth") {
      if (isBackendHeavy(file)) {
        score += 28;
        reasons.push(`${intent.primary} intent file`);
      }
      if (hasBackendFilenameIntentMatch(file, intent)) {
        score += 88;
        reasons.push(`${intent.primary} filename intent match`);
      }
      if (matchedTerms.length > 0) {
        score += matchedTerms.length * 8;
        reasons.push(`${intent.primary} term match: ${matchedTerms.slice(0, 3).join(", ")}`);
      }
      if (isUiFile(file) && matchedTerms.length === 0) {
        score -= 12;
        reasons.push("ui file downranked for backend/data intent");
      }
    } else if (intent.primary === "test") {
      if (file.kind === "test") {
        score += 86;
        reasons.push("test intent file");
      } else {
        score -= 45;
        reasons.push("non-test downranked for test intent");
      }
      if (matchedTerms.length > 0) {
        score += matchedTerms.length * 7;
        reasons.push(`test term match: ${matchedTerms.slice(0, 3).join(", ")}`);
      }
    } else if (intent.primary === "infra" || intent.primary === "docs") {
      if (matchedTerms.length > 0) {
        score += matchedTerms.length * 7;
        reasons.push(`${intent.primary} term match: ${matchedTerms.slice(0, 3).join(", ")}`);
      }
      if (intent.primary === "docs" && file.kind === "doc") score += 20;
      if (intent.primary === "infra" && file.kind === "config") score += 20;
    }

    if (score !== 0) {
      scores.set(file.path, {
        score,
        reasons
      });
    }
  }

  return scores;
}

function selectIntentChunks(chunks: SemanticChunkRecord[], intent: QueryIntent): SemanticChunkRecord[] {
  if (chunks.length === 0 || intent.primary === "generic") return chunks.slice(0, 3);
  const matched = chunks.filter((chunk) =>
    intent.matchedTerms.some((term) => `${chunk.symbol ?? ""} ${chunk.text}`.toLowerCase().includes(term))
  );
  return (matched.length > 0 ? matched : chunks).slice(0, 3);
}

function isGraphSeedAllowed(file: FileRecord | undefined, intent: QueryIntent, intentScore: number): boolean {
  if (!file) return false;
  if (intent.primary === "ui") return intentScore > 0 || isUiFile(file);
  if (intent.primary === "test") return file.kind === "test" || intentScore > 0;
  return true;
}

function graphCap(intent: QueryIntent, file: FileRecord | undefined): number {
  if (intent.primary === "ui") return file && isUiFile(file) ? 14 : 8;
  if (intent.primary === "test") return 54;
  return 18;
}

function isUiFile(file: FileRecord): boolean {
  return (
    file.kind === "component" ||
    file.kind === "route" ||
    file.kind === "style" ||
    /\.(tsx|jsx|css|scss)$/.test(file.path) ||
    file.path.startsWith("app/") ||
    file.path.startsWith("src/app/")
  );
}

function isBackendHeavy(file: FileRecord): boolean {
  return (
    file.kind === "schema" ||
    /(^|\/)(lib|server|api|supabase)\//.test(file.path) ||
    /(parser|repository|ingest|access|types?|schema|migration|gmail|oauth|route)\.[cm]?[jt]sx?$/.test(file.path)
  );
}

function isUiControlSurface(file: FileRecord): boolean {
  return /(tabs?|table|panel|sheet|drawer|card|filter|button|modal|settings|wheel|overlay|hero|nav)\.[cm]?[jt]sx?$/.test(file.path.toLowerCase());
}

function hasSpecificBackendIntent(queryTerms: Set<string>): boolean {
  return ["api", "server", "repository", "parser", "ingest", "gmail", "oauth", "supabase", "database", "schema"].some((term) =>
    queryTerms.has(term)
  );
}

function hasBackendFilenameIntentMatch(file: FileRecord, intent: QueryIntent): boolean {
  const basename = file.path.toLowerCase().split("/").at(-1) ?? file.path.toLowerCase();
  return intent.matchedTerms.some((term) => basename.includes(term));
}

function groupByFile<T>(records: T[], filePathFor: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const filePath = filePathFor(record);
    grouped.set(filePath, [...(grouped.get(filePath) ?? []), record]);
  }
  return grouped;
}

const GENERIC_DOMAIN_TERMS = new Set(["app", "apps", "application", "applications", "feature", "page", "screen"]);
const GENERIC_UI_FILENAME_TERMS = new Set(["settings", "layout", "mobile", "dashboard", "page", "view", "component", "screen"]);
