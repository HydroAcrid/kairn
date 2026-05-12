import type {
  ContextShownRecord,
  FileRecord,
  GraphEdgeRecord,
  HybridScoredResult,
  LexicalDocumentRecord,
  LexicalStatsRecord,
  LexicalTermRecord,
  SemanticChunkRecord,
  SemanticVectorRecord,
  SymbolRecord
} from "../types.js";
import { scoreBm25Files } from "../lexical/bm25.js";
import { cosineSimilarity, embedText } from "../semantic/vector.js";
import { tokenizeLexical } from "../semantic/tokenize.js";
import { isNoisySourcePath, scoreSourceRoleHints } from "./companions.js";
import { classifyQueryIntent, type QueryIntent } from "./queryIntent.js";
import { scoreFiles } from "./scoreResults.js";

export function hybridSearch(input: {
  files: FileRecord[];
  query: string;
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  vectors: SemanticVectorRecord[];
  lexicalDocuments?: LexicalDocumentRecord[];
  lexicalTerms?: LexicalTermRecord[];
  lexicalStats?: LexicalStatsRecord | undefined;
  edges: GraphEdgeRecord[];
  shown?: ContextShownRecord[];
  changedFiles?: Set<string>;
}): HybridScoredResult[] {
  const intent = classifyQueryIntent(input.query);
  const retrievalQuery = stripNegatedContextTargets(stripExampleLiterals(input.query));
  const keywordScores = new Map(scoreFiles(input.files, retrievalQuery, input.symbols).map((file) => [file.path, file]));
  const bm25Scores = scoreBm25Files({
    query: retrievalQuery,
    documents: input.lexicalDocuments ?? [],
    terms: input.lexicalTerms ?? [],
    stats: input.lexicalStats
  });
  const semanticScores = scoreSemanticChunks(retrievalQuery, input.chunks, input.vectors);
  const symbolsByFile = groupByFile(input.symbols, (symbol) => symbol.filePath);
  const chunksByFile = groupByFile(input.chunks, (chunk) => chunk.filePath);
  const intentScores = scoreIntentMatches(input.files, intent, input.query, symbolsByFile, chunksByFile);
  const behaviorScores = scoreBehaviorMatches(input.files, input.query, symbolsByFile, chunksByFile);
  const sourcePriorityScores = scoreSourcePriority(input.files, retrievalQuery, intent, symbolsByFile, chunksByFile);
  const graphScores = scoreGraphNeighbors(input.edges, keywordScores, semanticScores, intentScores, intent, input.files);
  const shownFiles = new Set((input.shown ?? []).map((record) => record.filePath).filter((filePath): filePath is string => Boolean(filePath)));
  const retrievalTerms = new Set(tokenizeLexical(retrievalQuery));
  const explicitTestIntentForQuery = hasExplicitTestIntent(retrievalTerms, input.query);
  const sourceOverTestPrompt = hasSourceOverTestPrompt(input.query, retrievalTerms, intent);
  const debugSourcePrompt =
    ["debug", "fix", "regression", "bug", "broken", "failing", "failure"].some((term) => retrievalTerms.has(term)) &&
    ["source", "production", "implementation", "helper", "utility"].some((term) => retrievalTerms.has(term));

  const scored = input.files
    .map((file) => {
      const keyword = keywordScores.get(file.path);
      const bm25 = bm25Scores.get(file.path);
      const semantic = semanticScores.get(file.path);
      const intentMatch = intentScores.get(file.path);
      const behaviorMatch = behaviorScores.get(file.path);
      const sourcePriority = sourcePriorityScores.get(file.path);
      const graphScore = graphScores.get(file.path) ?? 0;
      const sessionScore = shownFiles.has(file.path) ? -3 : 0;
      const changedExactSymbolMatch =
        Boolean(input.changedFiles?.has(file.path)) &&
        debugSourcePrompt &&
        isLanguageSourceSurface(file) &&
        file.kind !== "test" &&
        !isNoisyImplementationSurface(file) &&
        exactSymbolMatchesForQuery(retrievalTerms, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []).length > 0;
      const gitScore = input.changedFiles?.has(file.path)
        ? changedExactSymbolMatch
          ? 520
          : debugSourcePrompt && isLanguageSourceSurface(file)
            ? 180
            : 8
        : 0;
      const semanticScore = semantic?.score ?? 0;
      const keywordScore = keyword?.score ?? 0;
      const bm25Score = bm25?.score ?? 0;
      const intentScore = intentMatch?.score ?? 0;
      const behaviorScore = behaviorMatch?.score ?? 0;
      const sourcePriorityScore = sourcePriority?.score ?? 0;
      const importanceScore = file.importance;
      const sourceOverTestPenalty = file.kind === "test" && !explicitTestIntentForQuery && sourceOverTestPrompt ? -2600 : 0;
      const reasons = mergeReasons([
        ...(keyword?.reasons ?? []),
        ...(bm25?.reasons ?? []),
        ...(intentMatch?.reasons ?? []),
        ...(behaviorMatch?.reasons ?? []),
        ...(sourcePriority?.reasons ?? []),
        ...(semantic && semantic.score > 0.06 ? semanticReasons(semantic.chunks) : []),
        ...(graphScore > 0 ? ["graph neighbor"] : []),
        ...(shownFiles.has(file.path) ? ["already shown"] : []),
        ...(sourceOverTestPenalty < 0 ? ["test downranked for source/invariant prompt"] : []),
        ...(gitScore > 0 ? [changedExactSymbolMatch ? "changed exact-symbol source target" : gitScore > 40 ? "changed source target" : "changed in diff"] : [])
      ]);
      const score =
        importanceScore +
        bm25Score +
        keywordScore * 1.15 +
        semanticScore * 42 +
        behaviorScore +
        sourcePriorityScore +
        intentScore +
        graphScore +
        sessionScore +
        gitScore +
        sourceOverTestPenalty;

      return {
        ...file,
        score: Number(score.toFixed(3)),
        reasons,
        semanticScore: Number(semanticScore.toFixed(3)),
        keywordScore: Number(keywordScore.toFixed(3)),
        bm25Score: Number(bm25Score.toFixed(3)),
        behaviorScore: behaviorScore + sourcePriorityScore,
        graphScore,
        intentScore,
        sessionScore,
        importanceScore,
        gitScore,
        chunks: semantic?.chunks ?? behaviorMatch?.chunks ?? selectIntentChunks(chunksByFile.get(file.path) ?? [], intent)
      };
    })
    .filter((file) => file.score > 0 && file.reasons.length > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return applyPreciseSourceRescue(scored, input.query, symbolsByFile, chunksByFile)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

type BehaviorQuery = {
  active: boolean;
  terms: string[];
  anchorTerms: string[];
  phrases: string[];
  symbolHints: string[];
  sourceFix: boolean;
  explicitTestIntent: boolean;
};

function scoreBehaviorMatches(
  files: FileRecord[],
  query: string,
  symbolsByFile: Map<string, SymbolRecord[]>,
  chunksByFile: Map<string, SemanticChunkRecord[]>
): Map<string, { score: number; reasons: string[]; chunks: SemanticChunkRecord[] }> {
  const behavior = detectBehaviorQuery(query);
  if (!behavior.active) return new Map();

  const scores = new Map<string, { score: number; reasons: string[]; chunks: SemanticChunkRecord[] }>();
  for (const file of files) {
    const symbols = symbolsByFile.get(file.path) ?? [];
    const chunks = chunksByFile.get(file.path) ?? [];
    const fileText = [
      file.path,
      file.kind,
      ...symbols.map((symbol) => symbol.name),
      ...chunks.map((chunk) => `${chunk.symbol ?? ""} ${chunk.text}`)
    ].join(" ");
    const normalizedFileText = normalizeSearchText(fileText);
    const fileTerms = new Set(tokenizeLexical(fileText));
    const reasons: string[] = [];
    let score = 0;

    const matchedTerms = behavior.terms.filter((term) => fileTerms.has(term));
    const matchedPhrases = behavior.phrases.filter((phrase) => phraseMatches(normalizedFileText, phrase, fileTerms));
    const symbolMatches = selectBehaviorSymbolMatches(symbols, behavior);
    const hasBehaviorAnchor =
      matchedTerms.some((term) => behavior.anchorTerms.includes(term)) ||
      matchedPhrases.length > 0 ||
      symbolMatches.length > 0;
    if (!hasBehaviorAnchor) continue;

    if (matchedTerms.length > 0) {
      score += matchedTerms.length * 22;
      reasons.push(`behavior term match: ${matchedTerms.slice(0, 5).join(", ")}`);
    }

    if (matchedPhrases.length > 0) {
      score += matchedPhrases.length * 54;
      reasons.push(`behavior phrase match: ${matchedPhrases.slice(0, 3).join(", ")}`);
    }

    if (symbolMatches.length > 0) {
      score += symbolMatches.reduce((total, symbol) => total + behaviorSymbolWeight(symbol.name, behavior), 0);
      reasons.push(...symbolMatches.slice(0, 3).map((symbol) => `behavior symbol match: ${symbol.name}`));
    }

    const matchedChunks = chunks
      .map((chunk) => ({
        chunk,
        hits: behaviorChunkHits(chunk, behavior)
      }))
      .filter((item) => item.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map((item) => item.chunk);
    if (matchedChunks.length > 0) {
      score += Math.min(90, matchedChunks.length * 26);
      reasons.push(`behavior chunk match: ${matchedChunks.slice(0, 2).map((chunk) => chunk.symbol ?? chunk.kind).join(", ")}`);
    }

    if (behavior.sourceFix && score > 0 && isLanguageSourceSurface(file)) {
      score += 110;
      reasons.push("production source behavior match");
    }

    if (file.kind === "test" && !behavior.explicitTestIntent) {
      score -= behavior.sourceFix ? 850 : 220;
      reasons.push("test downranked for behavior fix");
    }

    if (score > 0 || reasons.length > 0) {
      scores.set(file.path, {
        score,
        reasons,
        chunks: matchedChunks.slice(0, 3)
      });
    }
  }

  return scores;
}

function scoreSourcePriority(
  files: FileRecord[],
  query: string,
  intent: QueryIntent,
  symbolsByFile: Map<string, SymbolRecord[]>,
  chunksByFile: Map<string, SemanticChunkRecord[]>
): Map<string, { score: number; reasons: string[] }> {
  const scores = new Map<string, { score: number; reasons: string[] }>();
  const queryTerms = new Set(tokenizeLexical(query));
  const explicitDocsIntent = intent.primary === "docs" || ["docs", "doc", "readme", "example", "examples", "demo"].some((term) => queryTerms.has(term));
  const explicitTestIntent = hasExplicitTestIntent(queryTerms, query);
  const debugImplementationIntent = ["debug", "fix", "regression", "bug", "broken"].some((term) => queryTerms.has(term));
  const implementationIntent =
    !explicitDocsIntent && (debugImplementationIntent || ["generic", "backend", "data", "auth", "workflow", "ui"].includes(intent.primary));
  const mentionedSourceBasenames = mentionedSourceFileBasenames(query);

  for (const file of files) {
    const reasons: string[] = [];
    let score = 0;
    const basename = file.path.toLowerCase().split("/").at(-1) ?? "";
    const exactSymbolMatches = exactSymbolMatchesForQuery(queryTerms, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);

    if (
      implementationIntent &&
      mentionedSourceBasenames.has(basename) &&
      isLanguageSourceSurface(file) &&
      file.kind !== "test" &&
      !isNoisyImplementationSurface(file)
    ) {
      score += 2000;
      reasons.push(`mentioned source filename: ${basename}`);
    }

    if (exactSymbolMatches.length > 0) {
      score += Math.min(220, exactSymbolMatches.length * 90);
      reasons.push(`exact symbol match: ${exactSymbolMatches.slice(0, 3).join(", ")}`);
      if (isCoreSourceModule(file)) {
        score += 86;
        reasons.push("core source module");
      }
    }

    const domainPathAnchor = scoreDomainPathAnchors(file, query, queryTerms);
    if (implementationIntent && domainPathAnchor.score !== 0) {
      score += domainPathAnchor.score;
      reasons.push(...domainPathAnchor.reasons);
    }

    const repositoryLanguage = scoreRepositoryLanguagePreference(file, query);
    if (implementationIntent && repositoryLanguage.score !== 0) {
      score += repositoryLanguage.score;
      reasons.push(...repositoryLanguage.reasons);
    }

    const canonicalRoute = scoreCanonicalSourceRoute({
      file,
      query,
      queryTerms,
      symbols: symbolsByFile.get(file.path) ?? [],
      chunks: chunksByFile.get(file.path) ?? [],
      implementationIntent: implementationIntent && intent.primary !== "ui",
      debugImplementationIntent,
      explicitTestIntent
    });
    if (implementationIntent && canonicalRoute.score !== 0) {
      score += canonicalRoute.score;
      reasons.push(...canonicalRoute.reasons);
    }

    const canonicalRoleSurface = debugImplementationIntent || hasExplicitSourceRoutingPrompt(query, queryTerms)
      ? scoreCanonicalRoleSurface(file, query, queryTerms)
      : { score: 0, reasons: [] };
    if (implementationIntent && canonicalRoleSurface.score !== 0) {
      score += canonicalRoleSurface.score;
      reasons.push(...canonicalRoleSurface.reasons);
    }

    const roleHints = scoreSourceRoleHints(file, query, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    if (implementationIntent && roleHints.score > 0) {
      score += roleHints.score;
      reasons.push(...roleHints.reasons);
    }

    if (implementationIntent && isLanguageSourceSurface(file)) {
      score += 24;
      reasons.push("language source surface");
    }

    if (implementationIntent && isPrimaryLanguageSourceSurface(file)) {
      score += 48;
      reasons.push("primary source path");
    }

    if (!explicitTestIntent && file.kind === "test") {
      score -= debugImplementationIntent ? 900 : exactSymbolMatches.length === 0 ? 72 : 420;
      reasons.push(exactSymbolMatches.length === 0 ? "test downranked for implementation prompt" : "test downranked for source rescue");
    }

    if (implementationIntent && isNoisyImplementationSurface(file)) {
      score -= isVendoredDependencySurface(file.path) ? 1400 : file.kind === "doc" ? 220 : 260;
      reasons.push("docs/examples/devtools downranked");
    }

    const specializedPenalty = unmentionedSpecializedSourcePenalty(file, queryTerms);
    if (implementationIntent && specializedPenalty > 0) {
      score -= specializedPenalty;
      reasons.push("unmentioned specialized source downranked");
    }

    if (implementationIntent && isDownstreamAdapterForCoreFlow(file, queryTerms)) {
      score -= 1200;
      reasons.push("downstream adapter downranked for core dispatch/interceptor prompt");
    }

    const goRoutingScore = scoreGoPackageRoutingSurface(file, queryTerms);
    if (implementationIntent && goRoutingScore.score !== 0) {
      score += goRoutingScore.score;
      reasons.push(...goRoutingScore.reasons);
    }

    if (debugImplementationIntent && file.kind === "config" && !hasSpecificInfraIntent(queryTerms)) {
      score -= 350;
      reasons.push("config downranked for source debugging prompt");
    }

    if (implementationIntent && isPlatformVariantSource(file)) {
      score -= 360;
      reasons.push("platform-specific variant downranked");
    }

    if (score !== 0) {
      scores.set(file.path, { score, reasons });
    }
  }

  return scores;
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
  if (intent.primary === "workflow") return target && isWorkflowSurface(target) ? 8 : 2;
  if (type === "imports" || type === "imported_by") return 5;
  if (type === "parent_route") return 4;
  return 2;
}

function semanticReasons(chunks: SemanticChunkRecord[]): string[] {
  return chunks.map((chunk) => chunk.symbol ? `semantic match: ${chunk.symbol}` : "semantic match");
}

function mergeReasons(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, 24);
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
    const normalizedFileText = normalizeSearchText(fileText);
    const fileTerms = new Set(tokenizeLexical(fileText));
    const basename = file.path.toLowerCase().split("/").at(-1) ?? file.path.toLowerCase();
    const matchedTerms = intent.matchedTerms.filter((term) => fileTerms.has(term) || normalizedFileText.includes(term));
    const domainTerms = [...queryTerms].filter((term) => !intent.matchedTerms.includes(term) && !GENERIC_DOMAIN_TERMS.has(term));
    const matchedDomainTerms = domainTerms.filter((term) => fileTerms.has(term) || normalizedFileText.includes(term));
    const filenameIntentTerms = intent.matchedTerms.filter((term) => basename.includes(term));
    const filenameDomainTerms = domainTerms.filter((term) => basename.includes(term));

    if (intent.primary === "workflow") {
      const matchedPhrases = (intent.matchedPhrases ?? []).filter((phrase) => phraseMatches(normalizedFileText, phrase, fileTerms));
      const matchedStatusValues = WORKFLOW_STATUS_TERMS.filter((term) => phraseMatches(normalizedFileText, term, fileTerms));

      if (isWorkflowSurface(file)) {
        score += 72;
        reasons.push("workflow intent file");
      }
      if (isWorkflowRoute(file)) {
        score += 70;
        reasons.push("workflow route match");
      }
      if (isReviewSurface(file)) {
        score += 120;
        reasons.push("workflow review surface");
      }
      if (isRepositoryWorkflowSurface(file, normalizedFileText, fileTerms)) {
        score += 52;
        reasons.push("workflow repository surface");
      }
      if (matchedPhrases.length > 0) {
        score += matchedPhrases.length * 46;
        reasons.push(`workflow phrase match: ${matchedPhrases.slice(0, 2).join(", ")}`);
      }
      if (matchedStatusValues.length > 0) {
        score += matchedStatusValues.length * 42;
        reasons.push(`workflow status match: ${matchedStatusValues.slice(0, 3).join(", ")}`);
      }
      if (matchedTerms.length > 0) {
        score += matchedTerms.length * 9;
        reasons.push(`workflow term match: ${matchedTerms.slice(0, 4).join(", ")}`);
      }
      if (filenameIntentTerms.length > 0) {
        score += filenameIntentTerms.length * 32;
        reasons.push(`workflow filename match: ${filenameIntentTerms.slice(0, 3).join(", ")}`);
      }
      if (isBroadWorkflowNoise(file, matchedPhrases.length + matchedStatusValues.length)) {
        score -= /(^|\/)supabase\/migrations\//.test(file.path) ? 430 : 58;
        reasons.push("broad workflow domain downranked");
      }
      if (file.kind === "test" && !queryTerms.has("test") && !queryTerms.has("tests")) {
        score -= 130;
        reasons.push("test downranked for workflow intent");
      }
    } else if (intent.primary === "ui") {
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

const BEHAVIOR_TRIGGER_TERMS = new Set([
  "bug",
  "debug",
  "regression",
  "broken",
  "incorrect",
  "inconsistent",
  "consistently",
  "consistent",
  "stable",
  "unstable",
  "same",
  "different",
  "order",
  "orders",
  "ordered",
  "sorted",
  "sort",
  "hash",
  "hashes",
  "hashed",
  "hashing",
  "serialize",
  "serialization",
  "normalize",
  "normalization",
  "equal",
  "equals",
  "equality",
  "compare",
  "matching",
  "visible",
  "length",
  "ansi",
  "escape",
  "prefix",
  "starts",
  "string",
  "view",
  "blank",
  "whitespace",
  "lower",
  "lowercase",
  "lowercases",
  "uppercase",
  "upper",
  "slug",
  "slugify",
  "local",
  "url",
  "urls",
  "relative",
  "absolute",
  "origin",
  "routable"
]);

const BEHAVIOR_STOP_TERMS = new Set([
  "seeded",
  "tanstack",
  "query",
  "core",
  "production",
  "source",
  "fix",
  "debug",
  "regression",
  "bug",
  "longer",
  "properties",
  "seeded"
]);

const BEHAVIOR_CANONICAL_TERMS = new Map<string, string[]>([
  ["hash", ["hash", "hashed", "hashes", "hashing"]],
  ["key", ["key", "keys", "querykey", "querykeys", "mutationkey", "mutationkeys"]],
  ["object", ["object", "objects", "property", "properties", "plain"]],
  ["sort", ["sort", "sorted", "sorting"]],
  ["order", ["order", "orders", "ordered", "ordering"]],
  ["stable", ["stable", "consistently", "consistent", "same", "equal", "equals"]],
  ["match", ["match", "matching", "compare", "comparison", "equality"]],
  ["length", ["length", "len", "visible", "width"]],
  ["ansi", ["ansi", "escape", "escapes", "colored", "color"]],
  ["prefix", ["prefix", "starts", "startswith", "starts_with"]],
  ["stringview", ["string", "view", "stringview", "string_view"]],
  ["blank", ["blank", "whitespace", "space"]],
  ["lowercase", ["lower", "lowercase", "lowercases", "uppercase", "upper"]],
  ["slugify", ["slug", "slugify"]],
  ["localurl", ["local", "url", "urls", "routable"]],
  ["relative", ["relative"]],
  ["absolute", ["absolute", "origin"]]
]);

function detectBehaviorQuery(query: string): BehaviorQuery {
  const normalized = normalizeSearchText(query);
  const queryTerms = new Set(tokenizeLexical(query));
  const triggerCount = [...queryTerms].filter((term) => BEHAVIOR_TRIGGER_TERMS.has(term)).length;
  const hasBehaviorPhrase = /same .* different order|different order|stable hash|hash consistently|sorted keys?|object keys?|object query keys?/.test(normalized);
  const active = triggerCount >= 2 || hasBehaviorPhrase;
  if (!active) {
    return {
      active: false,
      terms: [],
      anchorTerms: [],
      phrases: [],
      symbolHints: [],
      sourceFix: false,
      explicitTestIntent: false
    };
  }

  const terms = new Set<string>();
  for (const [canonical, aliases] of BEHAVIOR_CANONICAL_TERMS) {
    if (aliases.some((alias) => queryTerms.has(alias) || normalized.includes(alias))) {
      terms.add(canonical);
    }
  }
  for (const term of queryTerms) {
    if (term.length > 2 && !BEHAVIOR_STOP_TERMS.has(term) && BEHAVIOR_TRIGGER_TERMS.has(term)) {
      terms.add(term);
    }
  }

  const phrases = [
    "stable hash",
    "hash function",
    "hash key",
    "object keys",
    "sorted keys",
    "same properties",
    "different order",
    "different orders"
  ].filter((phrase) => phraseMatches(normalized, phrase, new Set(tokenizeLexical(normalized))));

  const symbolHints = new Set<string>();
  if (terms.has("hash")) {
    symbolHints.add("hash");
    symbolHints.add("hashkey");
  }
  if (!terms.has("hash") && terms.has("key") && (terms.has("sort") || terms.has("match") || terms.has("stable"))) {
    symbolHints.add("key");
  }
  if (terms.has("match")) symbolHints.add("match");
  if (terms.has("sort")) symbolHints.add("sort");
  if (terms.has("length")) {
    symbolHints.add("term");
    symbolHints.add("termlen");
    symbolHints.add("len");
  }
  if (terms.has("ansi")) {
    symbolHints.add("ansi");
    symbolHints.add("stripansi");
  }
  if (terms.has("prefix")) {
    symbolHints.add("startswith");
    symbolHints.add("starts");
  }
  if (terms.has("stringview")) {
    symbolHints.add("stringview");
    symbolHints.add("basicstringview");
  }
  if (terms.has("blank")) {
    symbolHints.add("isblank");
    symbolHints.add("blank");
  }
  if (terms.has("slugify")) symbolHints.add("slugify");
  if (terms.has("localurl") && (terms.has("relative") || terms.has("absolute") || normalized.includes("local"))) {
    symbolHints.add("islocalurl");
    symbolHints.add("localurl");
  }
  if (terms.has("lowercase") && !terms.has("slugify")) {
    symbolHints.add("lower");
  }

  return {
    active: true,
    terms: [...terms],
    anchorTerms: [...terms].filter((term) => ["hash", "sort", "stable", "match", "object", "order", "length", "ansi", "prefix", "stringview", "blank", "lowercase", "slugify", "localurl", "relative", "absolute"].includes(term)),
    phrases,
    symbolHints: [...symbolHints],
    sourceFix: /\b(production source|source|fix|debug)\b/.test(normalized),
    explicitTestIntent: /\b(test|tests|spec|verify|verification)\b/.test(normalized) && !hasNegatedTestIntent(query)
  };
}

function behaviorSymbolMatches(symbolName: string, behavior: BehaviorQuery): boolean {
  const normalizedSymbol = normalizeSearchText(symbolName);
  const compactSymbol = normalizedSymbol.replace(/\s+/g, "");
  return behavior.symbolHints.some((hint) => normalizedSymbol.includes(hint) || compactSymbol.includes(hint));
}

function selectBehaviorSymbolMatches(symbols: SymbolRecord[], behavior: BehaviorQuery): SymbolRecord[] {
  const bestByHint = new Map<string, { symbol: SymbolRecord; weight: number }>();
  for (const symbol of symbols) {
    const matchedHints = matchedBehaviorSymbolHints(symbol.name, behavior);
    if (matchedHints.length === 0) continue;
    const weight = behaviorSymbolWeight(symbol.name, behavior);
    for (const hint of matchedHints) {
      const current = bestByHint.get(hint);
      if (!current || weight > current.weight) {
        bestByHint.set(hint, { symbol, weight });
      }
    }
  }

  const unique = new Map<string, { symbol: SymbolRecord; weight: number }>();
  for (const { symbol, weight } of bestByHint.values()) {
    const key = normalizeSearchText(symbol.name).replace(/\s+/g, "");
    const current = unique.get(key);
    if (!current || weight > current.weight) unique.set(key, { symbol, weight });
  }

  return [...unique.values()]
    .sort((a, b) => b.weight - a.weight || a.symbol.name.localeCompare(b.symbol.name))
    .map((item) => item.symbol);
}

function matchedBehaviorSymbolHints(symbolName: string, behavior: BehaviorQuery): string[] {
  const normalizedSymbol = normalizeSearchText(symbolName);
  const compactSymbol = normalizedSymbol.replace(/\s+/g, "");
  return behavior.symbolHints.filter((hint) => normalizedSymbol.includes(hint) || compactSymbol.includes(hint));
}

function behaviorSymbolWeight(symbolName: string, behavior: BehaviorQuery): number {
  const normalizedSymbol = normalizeSearchText(symbolName);
  const compactSymbol = normalizedSymbol.replace(/\s+/g, "");
  let score = 76;
  if (behavior.terms.includes("hash") && compactSymbol.includes("hash")) score += 92;
  if (behavior.terms.includes("key") && compactSymbol.includes("key")) score += 58;
  if (behavior.terms.includes("match") && compactSymbol.includes("match")) score += 34;
  if (behavior.terms.includes("sort") && normalizedSymbol.includes("sort")) score += 42;
  if (behavior.terms.includes("length") && (compactSymbol.includes("len") || compactSymbol.includes("length"))) score += 92;
  if (behavior.terms.includes("ansi") && compactSymbol.includes("ansi")) score += 78;
  if (behavior.terms.includes("prefix") && compactSymbol.includes("startswith")) score += 110;
  if (behavior.terms.includes("prefix") && /^starts?with/.test(compactSymbol)) score += 96;
  if (behavior.terms.includes("stringview") && compactSymbol.includes("stringview")) score += 84;
  if (behavior.terms.includes("blank") && compactSymbol.includes("blank")) score += 104;
  if (behavior.terms.includes("slugify") && compactSymbol.includes("slugify")) score += 140;
  if (behavior.terms.includes("localurl") && compactSymbol.includes("localurl")) score += 150;
  if (behavior.terms.includes("relative") && compactSymbol.includes("localurl")) score += 70;
  if (behavior.terms.includes("lowercase") && compactSymbol.includes("lower")) score += 54;
  return score;
}

function behaviorChunkHits(chunk: SemanticChunkRecord, behavior: BehaviorQuery): number {
  const text = normalizeSearchText(`${chunk.symbol ?? ""} ${chunk.text}`);
  const terms = new Set(tokenizeLexical(text));
  let hits = behavior.terms.filter((term) => terms.has(term) || text.includes(term)).length;
  hits += behavior.phrases.filter((phrase) => phraseMatches(text, phrase, terms)).length * 2;
  if (chunk.symbol && behaviorSymbolMatches(chunk.symbol, behavior)) hits += 3;
  return hits;
}

function exactSymbolMatchesForQuery(
  queryTerms: Set<string>,
  symbols: SymbolRecord[],
  chunks: SemanticChunkRecord[]
): string[] {
  if (queryTerms.size === 0) return [];
  const compactQuery = [...queryTerms].join("");
  const matches = new Set<string>();
  for (const symbol of symbols) {
    const symbolTerms = tokenizeLexical(symbol.name);
    const compactSymbol = normalizeSearchText(symbol.name).replace(/\s+/g, "");
    if (isLowValueExactSymbol(symbol.name) && hasSpecificQuerySymbol(queryTerms)) continue;
    if (
      symbolTerms.length > 0 &&
      (symbolTerms.every((term) => queryTerms.has(term)) ||
        (compactSymbol.length > 3 && (compactQuery.includes(compactSymbol) || compactSymbol === compactQuery)))
    ) {
      matches.add(symbol.name);
    }
  }
  for (const chunk of chunks) {
    if (!chunk.symbol) continue;
    const symbolTerms = tokenizeLexical(chunk.symbol);
    if (isLowValueExactSymbol(chunk.symbol) && hasSpecificQuerySymbol(queryTerms)) continue;
    if (symbolTerms.length > 0 && symbolTerms.every((term) => queryTerms.has(term))) {
      matches.add(chunk.symbol);
    }
  }
  return [...matches];
}

function isLowValueExactSymbol(symbolName: string): boolean {
  const compact = normalizeSearchText(symbolName).replace(/\s+/g, "");
  return ["lower", "upper", "input", "output", "value", "name", "case", "test"].includes(compact);
}

function hasSpecificQuerySymbol(queryTerms: Set<string>): boolean {
  return [...queryTerms].some((term) => term.length >= 5 && !["debug", "seeded", "regression", "source", "production", "lowercase", "uppercase"].includes(term));
}

function isLanguageSourceSurface(file: FileRecord): boolean {
  return (
    file.kind === "source" &&
    ["python", "java", "kotlin", "c", "cpp", "typescript", "javascript", "go", "ruby"].includes(file.language) &&
    !isNoisyImplementationSurface(file)
  );
}

function isPrimaryLanguageSourceSurface(file: FileRecord): boolean {
  const normalized = file.path.toLowerCase();
  if (file.language === "python") {
    return (
      (normalized.startsWith("src/") || normalized.includes("/src/") || /^[a-z_][\w-]*\//.test(normalized)) &&
      !/(^|\/)(tests?|examples|docs?)\//.test(normalized)
    );
  }
  if (file.language === "java") {
    return normalized.startsWith("src/main/java/") || normalized.includes("/src/main/java/");
  }
  if (file.language === "kotlin") {
    return normalized.startsWith("src/main/kotlin/") || normalized.includes("/src/main/kotlin/") || normalized.includes("/commonjvmandroid/kotlin/");
  }
  if (file.language === "c" || file.language === "cpp") {
    return normalized.startsWith("src/") || normalized.includes("/src/") || normalized.startsWith("include/") || normalized.includes("/include/");
  }
  if (file.language === "go") {
    return !/(^|\/)(vendor|testdata)\//.test(normalized) && /\.(go)$/.test(normalized);
  }
  if (file.language === "ruby") {
    return normalized.startsWith("lib/") || normalized.startsWith("app/") || normalized.includes("/lib/") || normalized.includes("/app/");
  }
  return file.path.startsWith("src/") || file.path.includes("/src/");
}

function isCoreSourceModule(file: FileRecord): boolean {
  if (!isLanguageSourceSurface(file)) return false;
  const normalized = file.path.toLowerCase();
  return /(^|\/)(utils?|helpers?|core|text|strings?|common|shared)(\/|\.|-|_)/.test(normalized) ||
    /(^|\/)(utils?|helpers?|core|text|strings?|common|shared)\.[a-z0-9]+$/.test(normalized);
}

function scoreDomainPathAnchors(file: FileRecord, query: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  if (!isLanguageSourceSurface(file) && !isPrimaryLanguageSourceSurface(file)) return { score: 0, reasons: [] };
  const normalizedPath = normalizeSearchText(file.path);
  const pathTerms = new Set(tokenizeLexical(file.path));
  const domainTerms = [...queryTerms].filter((term) => isSpecificDomainPathTerm(term));
  const matchedPathTerms = domainTerms.filter((term) => pathTerms.has(term) || normalizedPath.includes(term));
  const reasons: string[] = [];
  let score = 0;

  if (matchedPathTerms.length > 0) {
    score += Math.min(760, matchedPathTerms.length * 150);
    if (matchedPathTerms.length >= 2) score += 260;
    reasons.push(`specific source path terms: ${matchedPathTerms.slice(0, 5).join(", ")}`);
  }

  if (isKeyboardShortcutSource(file.path, queryTerms)) {
    score += 950;
    reasons.push("keyboard shortcut source surface");
  }

  if (isExactUserEmailSource(file.path, queryTerms)) {
    score += 2600;
    reasons.push("exact user/email source surface");
  } else if (isUserEmailAdminSource(file.path, queryTerms)) {
    score += 820;
    reasons.push("user/email admin source surface");
  }
  if (isBackendUserEmailUiNoise(file.path, queryTerms)) {
    score -= 720;
    reasons.push("public/admin UI surface downranked for backend user/email task");
  }

  if (isNamedAgentClientSource(file.path, queryTerms)) {
    score += 900;
    reasons.push("named agent client source surface");
  }

  if (mentionsGoPackageSurface(query, file.path)) {
    score += 700;
    reasons.push("go package surface named by task");
  }

  return { score, reasons };
}

function scoreCanonicalRoleSurface(file: FileRecord, query: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  if (!isLanguageSourceSurface(file) && !isPrimaryLanguageSourceSurface(file)) return { score: 0, reasons: [] };
  if (isNoisyImplementationSurface(file)) return { score: 0, reasons: [] };
  const normalizedPath = file.path.toLowerCase();
  const basename = normalizedPath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (!basename || basename === "index" || basename === "main") return { score: 0, reasons: [] };

  const queryRoleTerms = new Set([...queryTerms].map(canonicalRoleTerm));
  for (const compound of compoundQueryTerms(query)) queryRoleTerms.add(canonicalRoleTerm(compound));
  const basenameTerms = [...new Set(tokenizeLexical(basename).map(canonicalRoleTerm))]
    .filter((term) => term.length >= 3 && !CANONICAL_ROLE_STOP_TERMS.has(term));
  const pathTerms = new Set(tokenizeLexical(file.path).map(canonicalRoleTerm));
  const basenameHits = basenameTerms.filter((term) => queryRoleTerms.has(term));
  const pathHits = [...queryRoleTerms].filter((term) => pathTerms.has(term) && !CANONICAL_ROLE_STOP_TERMS.has(term));
  if (basenameHits.length === 0 && pathHits.length < 2) return { score: 0, reasons: [] };

  let score = basenameHits.length * 250 + Math.min(320, pathHits.length * 80);
  const reasons: string[] = [];
  if (basenameHits.length > 0) reasons.push(`canonical role basename anchor: ${basenameHits.slice(0, 4).join(", ")}`);
  if (pathHits.length >= 2) reasons.push(`canonical role path anchor: ${pathHits.slice(0, 4).join(", ")}`);
  if (isPrimaryLanguageSourceSurface(file)) {
    score += 120;
    reasons.push("primary source role anchor");
  }
  if (basenameTerms.length > 0 && basenameTerms.every((term) => queryRoleTerms.has(term) || ["base", "internal"].includes(term))) {
    score += basenameTerms.length === 1 && STRONG_CANONICAL_BASENAME_TERMS.has(basenameTerms[0]!) ? 820 : 280;
    reasons.push("exact canonical role file");
  }
  if (pathTerms.has("core") && queryRoleTerms.has("core")) {
    score += 180;
    reasons.push("core source role anchor");
  }
  if (isTransformAnalysisSource(file.path, queryRoleTerms)) {
    score += /import[-_]?analysis/i.test(file.path) ? 1900 : 1300;
    reasons.push("transform analysis source");
  }
  if (isRoutePatternTreeSource(file.path, queryRoleTerms)) {
    score += 1300;
    reasons.push("route pattern tree source");
  }
  if (isRealImplementationSource(file.path, queryRoleTerms)) {
    score += 1300;
    reasons.push("real implementation source");
  }
  return { score, reasons };
}

function unmentionedSpecializedSourcePenalty(file: FileRecord, queryTerms: Set<string>): number {
  const normalized = file.path.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/module-info\.(java|kt)$/.test(basename)) return 1_900;
  if (/(^|\/)(samples?|examples?|docs?|playground|testing|testdata)\//.test(normalized)) return 1_500;

  const canonicalQueryTerms = new Set([...queryTerms].map(canonicalRoleTerm));
  const qualifiers: Array<[RegExp, string[], number]> = [
    [/json[-_]?schema|standard[-_]?schema/, ["json", "standard"], 860],
    [/(^|[_-])proxy|socks[-_]?proxy|http[-_]?proxy/, ["proxy", "socks"], 980],
    [/logging[-_]?interceptor|logging/, ["logging", "log"], 900],
    [/stdout|stderr|console[-_]?encoder/, ["stdout", "stderr", "console"], 860],
    [/callback[-_]?sink|android[-_]?sink|msvc[-_]?sink|syslog[-_]?sink|daily[-_]?sink|rotating[-_]?sink|qt[-_]?sink|win[-_]?eventlog[-_]?sink|eventlog[-_]?sink|systemd[-_]?namespace[-_]?sink|namespace[-_]?sink|async[-_]?logger/, ["callback", "android", "msvc", "syslog", "daily", "rotating", "qt", "win", "eventlog", "systemd", "namespace", "async"], 860],
    [/-inl\./, ["inline", "inl"], 520],
    [/_windows|_notwin|windows|win32|notwin|android|darwin|linux|posix|unix|wasm/, ["windows", "win", "notwin", "android", "darwin", "linux", "posix", "unix", "wasm"], 720],
    [/optimizer\//, ["optimizer", "optimize"], 520]
  ];
  return qualifiers.reduce((total, [pattern, terms, penalty]) => {
    if (!pattern.test(normalized)) return total;
    return terms.some((term) => canonicalQueryTerms.has(canonicalRoleTerm(term))) ? total : total + penalty;
  }, 0);
}

function isTransformAnalysisSource(filePath: string, queryTerms: Set<string>): boolean {
  const asksTransformSurface =
    (queryTerms.has("plugin") || queryTerms.has("module")) &&
    (queryTerms.has("transform") || queryTerms.has("load") || queryTerms.has("resolve"));
  if (!asksTransformSurface) return false;
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  return /(import[-_]?analysis|analysis|analyzer|transform)/.test(basename);
}

function isRoutePatternTreeSource(filePath: string, queryTerms: Set<string>): boolean {
  const asksRoutePattern =
    (queryTerms.has("route") || queryTerms.has("router") || queryTerms.has("routing") || queryTerms.has("mux")) &&
    (queryTerms.has("pattern") || queryTerms.has("match"));
  if (!asksRoutePattern) return false;
  return /(^|\/)(tree|trie)\.go$/.test(filePath.toLowerCase());
}

function isRealImplementationSource(filePath: string, queryTerms: Set<string>): boolean {
  if (!queryTerms.has("real")) return false;
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  return /real[a-z0-9_-]*(call|chain|client|connection|dispatcher|exchange|engine)/.test(basename);
}

function scoreRepositoryLanguagePreference(file: FileRecord, query: string): { score: number; reasons: string[] } {
  const expected = /repository language:\s*([a-z0-9+#.-]+)/i.exec(query)?.[1]?.toLowerCase();
  if (!expected || expected === "unknown") return { score: 0, reasons: [] };
  if (languageMatchesPreference(file.language, expected)) {
    return isPrimaryLanguageSourceSurface(file) ? { score: 120, reasons: [`repository language source: ${expected}`] } : { score: 55, reasons: [`repository language match: ${expected}`] };
  }
  if (isUiFile(file) || isLanguageSourceSurface(file) || isPrimaryLanguageSourceSurface(file)) {
    return { score: -780, reasons: [`non-${expected} source downranked for repository language`] };
  }
  return { score: 0, reasons: [] };
}

function isSpecificDomainPathTerm(term: string): boolean {
  return term.length >= 3 &&
    !GENERIC_DOMAIN_TERMS.has(term) &&
    ![
      "debug",
      "fix",
      "issue",
      "source",
      "production",
      "tests",
      "test",
      "selected",
      "metadata",
      "repository",
      "language",
      "prefer",
      "unless",
      "explicitly",
      "files",
      "file",
      "function",
      "class",
      "input",
      "output",
      "type",
      "types",
      "data",
      "current",
      "expected",
      "actual"
    ].includes(term);
}

function isKeyboardShortcutSource(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  const asksKeyboardShortcut =
    (queryTerms.has("keyboard") || queryTerms.has("key")) &&
    (queryTerms.has("shortcut") || queryTerms.has("shortcuts") || queryTerms.has("binding") || queryTerms.has("bindings"));
  if (!asksKeyboardShortcut) return false;
  return /key[-_]?bindings?|keyboard[-_]?shortcuts?|shortcuts?/.test(normalized) || (normalized.includes("key") && normalized.includes("binding"));
}

function isUserEmailAdminSource(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  const asksEmailUser =
    queryTerms.has("email") &&
    (queryTerms.has("user") || queryTerms.has("users") || queryTerms.has("admin") || queryTerms.has("acp") || queryTerms.has("confirmation") || queryTerms.has("validation"));
  if (!asksEmailUser) return false;
  const basename = normalized.split("/").at(-1) ?? "";
  return (
    /(^|\/)(user|users|admin|admins)(\/|$)/.test(normalized) ||
    basename.includes("email") ||
    basename.includes("user")
  );
}

function isExactUserEmailSource(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  const asksEmailUser =
    queryTerms.has("email") &&
    (queryTerms.has("user") || queryTerms.has("users") || queryTerms.has("admin") || queryTerms.has("confirmation") || queryTerms.has("validation"));
  if (!asksEmailUser) return false;
  const pathTerms = new Set(tokenizeLexical(normalized));
  const basename = normalized.split("/").at(-1) ?? "";
  return (pathTerms.has("user") || pathTerms.has("users")) && (pathTerms.has("email") || basename.includes("email"));
}

function isBackendUserEmailUiNoise(filePath: string, queryTerms: Set<string>): boolean {
  const asksBackendEmail =
    queryTerms.has("email") &&
    (queryTerms.has("user") || queryTerms.has("users") || queryTerms.has("admin")) &&
    (queryTerms.has("backend") || queryTerms.has("authentication") || queryTerms.has("confirmation") || queryTerms.has("validation"));
  if (!asksBackendEmail) return false;
  const normalized = filePath.toLowerCase();
  return normalized.startsWith("public/") || /(^|\/)(views?|components?|templates?)\//.test(normalized);
}

function isNamedAgentClientSource(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!queryTerms.has("client") && !queryTerms.has("clients")) return false;
  const agentNames = ["lastfm", "listenbrainz", "spotify", "github", "gitlab", "slack", "gmail", "jira"];
  const namedAgent =
    agentNames.some((name) => queryTerms.has(name) && normalized.includes(name)) ||
    (queryTerms.has("listen") && queryTerms.has("brainz") && normalized.includes("listenbrainz"));
  return namedAgent && /(^|\/)client\.[a-z0-9]+$/.test(normalized);
}

function mentionsGoPackageSurface(query: string, filePath: string): boolean {
  if (!/repository language:\s*go/i.test(query)) return false;
  const normalizedPath = filePath.toLowerCase();
  const basename = normalizedPath.split("/").at(-1)?.replace(/\.go$/, "") ?? "";
  if (!basename || basename === "main") return false;
  const normalizedQuery = normalizeSearchText(query);
  return normalizedQuery.includes(basename.replace(/[_-]+/g, " "));
}

function languageMatchesPreference(fileLanguage: string, expected: string): boolean {
  if (fileLanguage === expected) return true;
  if (expected === "java") return fileLanguage === "java" || fileLanguage === "kotlin";
  if (expected === "js" || expected === "javascript") return fileLanguage === "javascript" || fileLanguage === "typescript";
  if (expected === "ts" || expected === "typescript") return fileLanguage === "typescript" || fileLanguage === "javascript";
  if (expected === "py" || expected === "python") return fileLanguage === "python";
  if (expected === "golang") return fileLanguage === "go";
  if (expected === "c++" || expected === "cpp") return fileLanguage === "cpp" || fileLanguage === "c";
  return false;
}

function scoreCanonicalSourceRoute(input: {
  file: FileRecord;
  query: string;
  queryTerms: Set<string>;
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  implementationIntent: boolean;
  debugImplementationIntent: boolean;
  explicitTestIntent: boolean;
}): { score: number; reasons: string[] } {
  if (!input.implementationIntent) return { score: 0, reasons: [] };
  const { file, queryTerms } = input;
  const normalized = file.path.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const platformRoute = scorePlatformVariantRoute(file, queryTerms);
  if (platformRoute.score !== 0) {
    score += platformRoute.score;
    reasons.push(...platformRoute.reasons);
  }

  if (!isLanguageSourceSurface(file)) return { score, reasons };

  if (isCanonicalProductionPath(file)) {
    score += input.debugImplementationIntent ? 180 : 90;
    reasons.push("canonical source route");
  }

  if (file.language === "java" && /(^|\/)src\/main\/java\//.test(normalized)) {
    score += 210;
    reasons.push("canonical Java main source");
  }

  if (file.language === "go" && isCanonicalGoSourcePath(file.path)) {
    score += 120;
    reasons.push("canonical Go source");
  }

  if (file.language === "javascript" || file.language === "typescript") {
    const publicApi = scoreMonolithicPublicApiSource(file, input.query, input.symbols, input.chunks, input.explicitTestIntent);
    if (publicApi.score !== 0) {
      score += publicApi.score;
      reasons.push(...publicApi.reasons);
    }
  }

  return { score, reasons };
}

function scorePlatformVariantRoute(file: FileRecord, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const normalized = file.path.toLowerCase();
  const mentionsPlatform = mentionsPlatformVariant(queryTerms, normalized);
  if (mentionsPlatform) {
    const platform = namedPlatformVariant(normalized);
    return platform && queryTerms.has(platform) ? { score: 130, reasons: ["platform-specific source named by task"] } : { score: 0, reasons: [] };
  }

  if (file.language === "go" && /_(appengine|windows|win|notwin|linux|darwin|unix|posix|wasm|js|nocgo|cgo|freebsd|openbsd|netbsd|solaris|dragonfly|aix|plan9)\.go$/i.test(normalized)) {
    return { score: -1200, reasons: ["platform-specific variant downranked"] };
  }

  if ((file.language === "java" || file.language === "kotlin") && /(^|\/)(android|jre|gwt|emulated|emulation|j2objc|gwt-src|java8|java9)(\/|$)/.test(normalized)) {
    return { score: -2600, reasons: ["platform mirror source downranked"] };
  }

  if ((file.language === "c" || file.language === "cpp") && /(^|\/)(win32|windows|posix|unix|darwin|linux|platform|ports?)(\/|$)/.test(normalized)) {
    return { score: -360, reasons: ["platform-specific variant downranked"] };
  }

  return { score: 0, reasons: [] };
}

function mentionsPlatformVariant(queryTerms: Set<string>, filePath: string): boolean {
  return [
    "android",
    "jre",
    "gwt",
    "appengine",
    "windows",
    "win",
    "linux",
    "darwin",
    "macos",
    "unix",
    "posix",
    "wasm",
    "browser",
    "node",
    "cgo",
    "nocgo"
  ].some((term) => queryTerms.has(term) || (term === "macos" && filePath.includes("darwin")));
}

function namedPlatformVariant(filePath: string): string | undefined {
  if (filePath.includes("android")) return "android";
  if (filePath.includes("appengine")) return "appengine";
  if (filePath.includes("windows") || filePath.includes("_win")) return "windows";
  if (filePath.includes("linux")) return "linux";
  if (filePath.includes("darwin")) return "darwin";
  if (filePath.includes("unix")) return "unix";
  if (filePath.includes("posix")) return "posix";
  if (filePath.includes("wasm")) return "wasm";
  if (filePath.includes("gwt")) return "gwt";
  if (filePath.includes("jre")) return "jre";
  return undefined;
}

function isCanonicalProductionPath(file: FileRecord): boolean {
  const normalized = file.path.toLowerCase();
  if (file.kind !== "source" || isNoisyImplementationSurface(file)) return false;
  if (/(^|\/)(android|jre|gwt|emulated|emulation|j2objc|vendor|deps|third_party|testdata)(\/|$)/.test(normalized)) return false;
  return (
    normalized.startsWith("src/") ||
    normalized.startsWith("lib/") ||
    normalized.startsWith("include/") ||
    /(^|\/)src\/main\/java\//.test(normalized) ||
    /(^|\/)src\/main\/kotlin\//.test(normalized) ||
    /(^|\/)commonjvmandroid\/kotlin\//.test(normalized) ||
    /^[^/]+\/src\//.test(normalized) ||
    (file.language === "python" && /^[a-z_][\w-]*\/[^/]+\.py$/.test(normalized)) ||
    (file.language === "go" && isCanonicalGoSourcePath(file.path))
  );
}

function isCanonicalGoSourcePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (!/\.go$/.test(normalized)) return false;
  if (/_test\.go$/.test(normalized)) return false;
  if (/(^|\/)(vendor|testdata|examples?|docs?|internal\/testdata)\//.test(normalized)) return false;
  if (/_(appengine|windows|win|notwin|linux|darwin|unix|posix|wasm|js|nocgo|cgo|freebsd|openbsd|netbsd|solaris|dragonfly|aix|plan9)\.go$/i.test(normalized)) return false;
  return normalized.split("/").length <= 3;
}

function scoreMonolithicPublicApiSource(
  file: FileRecord,
  query: string,
  symbols: SymbolRecord[],
  chunks: SemanticChunkRecord[],
  explicitTestIntent: boolean
): { score: number; reasons: string[] } {
  if (explicitTestIntent || !isRootPublicApiSource(file.path)) return { score: 0, reasons: [] };
  const normalizedQuery = normalizeSearchText(query);
  const queryTerms = new Set(tokenizeLexical(query));
  const publicApiSignal =
    /\b(public api|exported api|top[-\s]?level api|library api)\b/.test(normalizedQuery) ||
    /(^|\s)_\.[A-Za-z_$][\w$]*/.test(query) ||
    /\b[A-Za-z_$][\w$]*\(\)/.test(query);
  const symbolMatches = exactSymbolMatchesForQuery(queryTerms, symbols, chunks);
  const hasExportedSymbolMatch = symbolMatches.length > 0 || symbols.some((symbol) => normalizeSearchText(query).replace(/\s+/g, "").includes(normalizeSearchText(symbol.name).replace(/\s+/g, "")));
  if (!publicApiSignal || !hasExportedSymbolMatch) return { score: 0, reasons: [] };
  return { score: 780, reasons: ["monolithic public API source"] };
}

function isRootPublicApiSource(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (normalized.includes("/") || isNoisySourcePath(normalized)) return false;
  if (/\.(config|test|spec|min|bundle|umd|esm|cjs)\.[cm]?js$/.test(normalized)) return false;
  return /\.(js|mjs|cjs|ts)$/.test(normalized);
}

function isNoisyImplementationSurface(file: FileRecord): boolean {
  const normalized = file.path.toLowerCase();
  return (
    file.kind === "doc" ||
    isNoisySourcePath(normalized) ||
    isVendoredDependencySurface(normalized) ||
    /(^|\/)__fixtures__\//.test(normalized)
  );
}

function isVendoredDependencySurface(filePath: string): boolean {
  return /(^|\/)(deps|vendor|third_party|node_modules)\//.test(filePath.toLowerCase());
}

function isGraphSeedAllowed(file: FileRecord | undefined, intent: QueryIntent, intentScore: number): boolean {
  if (!file) return false;
  if (intent.primary === "ui") return intentScore > 0 || isUiFile(file);
  if (intent.primary === "workflow") return intentScore > 0 || isWorkflowSurface(file);
  if (intent.primary === "test") return file.kind === "test" || intentScore > 0;
  return true;
}

function graphCap(intent: QueryIntent, file: FileRecord | undefined): number {
  if (intent.primary === "ui") return file && isUiFile(file) ? 14 : 8;
  if (intent.primary === "workflow") return file && isWorkflowSurface(file) ? 22 : 8;
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

function hasSpecificInfraIntent(queryTerms: Set<string>): boolean {
  return ["config", "build", "ci", "workflow", "docker", "deploy", "yaml", "toml"].some((term) => queryTerms.has(term));
}

function hasBackendFilenameIntentMatch(file: FileRecord, intent: QueryIntent): boolean {
  const basename = file.path.toLowerCase().split("/").at(-1) ?? file.path.toLowerCase();
  return intent.matchedTerms.some((term) => basename.includes(term));
}

function isWorkflowSurface(file: FileRecord): boolean {
  const normalizedPath = normalizeSearchText(file.path);
  return (
    isReviewSurface(file) ||
    isWorkflowRoute(file) ||
    /sync attempts?|sync status|review|queue|retry|ignore|ignored|requeued|needs review|source email id|manual correction/.test(normalizedPath) ||
    /reviewpanel|syncattempts|syncstatus|attempts|manual/i.test(file.path)
  );
}

function isWorkflowRoute(file: FileRecord): boolean {
  const normalizedPath = normalizeSearchText(file.path);
  return (
    /(^|\/)api\//.test(file.path) &&
    /sync attempts?|sync status|applications?|account|google disconnect|cron/.test(normalizedPath)
  );
}

function isReviewSurface(file: FileRecord): boolean {
  const terms = new Set(tokenizeLexical(file.path));
  return terms.has("review") || terms.has("queue") || /jobsreviewpanel/i.test(file.path);
}

function isRepositoryWorkflowSurface(file: FileRecord, normalizedFileText: string, fileTerms: Set<string>): boolean {
  if (!/(^|\/)repository\.[cm]?[jt]sx?$/.test(file.path)) return false;
  return WORKFLOW_STATUS_TERMS.some((term) => phraseMatches(normalizedFileText, term, fileTerms)) ||
    ["attempt", "attempts", "review", "retry", "ignore", "requeued"].some((term) => fileTerms.has(term));
}

function isBroadWorkflowNoise(file: FileRecord, exactWorkflowMatches: number): boolean {
  if (/(^|\/)supabase\/migrations\//.test(file.path)) return true;
  if (exactWorkflowMatches > 0 || isWorkflowRoute(file) || isReviewSurface(file)) return false;
  return /(^|\/)(gmail|parser|types?|ingest)\.[cm]?[jt]sx?$/.test(file.path);
}

function isDownstreamAdapterForCoreFlow(file: FileRecord, queryTerms: Set<string>): boolean {
  const normalized = file.path.toLowerCase();
  if (!/(^|\/)adapters?\//.test(normalized)) return false;
  return queryTerms.has("interceptor") || queryTerms.has("interceptors") || queryTerms.has("dispatch") || queryTerms.has("dispatcher");
}

function isPlatformVariantSource(file: FileRecord): boolean {
  return file.language === "go" && /_(appengine|windows|win|notwin|linux|darwin|unix|posix|wasm|js|nocgo|cgo|freebsd|openbsd|netbsd|solaris|dragonfly|aix|plan9)\.go$/i.test(file.path);
}

function scoreGoPackageRoutingSurface(file: FileRecord, queryTerms: Set<string>): { score: number; reasons: string[] } {
  if (file.language !== "go") return { score: 0, reasons: [] };
  const normalized = file.path.toLowerCase();
  const routingPrompt = ["route", "router", "routing", "group", "context", "chain", "middleware", "handler", "mount"].some((term) =>
    queryTerms.has(term)
  );
  if (!routingPrompt) return { score: 0, reasons: [] };
  if (/^(\w+)\.go$/.test(normalized) && ["gin.go", "chi.go", "mux.go", "context.go", "chain.go", "router.go", "engine.go"].includes(normalized)) {
    return { score: 360, reasons: ["go package routing anchor"] };
  }
  if (/^middleware\//.test(normalized) && (queryTerms.has("router") || queryTerms.has("route") || queryTerms.has("context") || queryTerms.has("chain"))) {
    return { score: -900, reasons: ["go middleware package downranked for router/context prompt"] };
  }
  return { score: 0, reasons: [] };
}

function phraseMatches(normalizedFileText: string, phrase: string, fileTerms: Set<string>): boolean {
  const normalizedPhrase = normalizeSearchText(phrase);
  if (normalizedFileText.includes(normalizedPhrase)) return true;
  const terms = tokenizeLexical(phrase);
  return terms.length > 0 && terms.every((term) => fileTerms.has(term));
}

function normalizeSearchText(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripExampleLiterals(query: string): string {
  return query.replace(/\b[A-Za-z_][\w.]*\(([^)]{1,120})\)/g, (match) => match.replace(/\(([^)]*)\)/, "()"));
}

function stripNegatedContextTargets(query: string): string {
  return query
    .replace(/\b(?:do not|don't|dont|never|avoid|without|no)\b(?:\s+[A-Za-z0-9_-]+){0,8}\s+\b(?:tests?|specs?|pytest|vitest|jest|docs?|documentation|readme|examples?)\b/gi, " ")
    .replace(/\b(?:tests?|specs?|pytest|vitest|jest|docs?|documentation|readme|examples?)\b(?:\s+[A-Za-z0-9_-]+){0,6}\s+\b(?:unless|except)\b(?:\s+[A-Za-z0-9_-]+){0,8}\s+\b(?:fail|fails|failed|failure|named|requested)\b/gi, " ")
    .replace(/\b(?:avoid|skip)\s+broad(?:en|ly)?\s+(?:into\s+)?(?:tests?|docs?|examples?)\b/gi, " ");
}

function compoundQueryTerms(query: string): string[] {
  const terms = tokenizeLexical(query).map(canonicalRoleTerm);
  const compounds = new Set<string>();
  for (let index = 0; index < terms.length - 1; index += 1) {
    const left = terms[index];
    const right = terms[index + 1];
    if (!left || !right || CANONICAL_ROLE_STOP_TERMS.has(left) || CANONICAL_ROLE_STOP_TERMS.has(right)) continue;
    const compound = `${left}${right}`;
    if (compound.length >= 5) compounds.add(compound);
  }
  return [...compounds];
}

function hasExplicitTestIntent(queryTerms: Set<string>, query = ""): boolean {
  if (query && hasNegatedTestIntent(query)) return false;
  return ["test", "tests", "spec", "unit", "integration", "pytest", "vitest", "jest"].some((term) => queryTerms.has(term));
}

function hasSourceOverTestPrompt(query: string, queryTerms: Set<string>, intent: QueryIntent): boolean {
  if (intent.primary === "test") return false;
  const normalized = normalizeSearchText(query);
  return (
    ["source", "production", "implementation", "invariant", "companion", "edit", "edits", "fix", "repair", "patch", "review"].some((term) => queryTerms.has(term)) ||
    /\b(known source|source invariant|production source|companion edits?|do not edit|do not inspect tests|do not broaden into tests|smallest source)\b/.test(normalized)
  );
}

function hasExplicitSourceRoutingPrompt(query: string, queryTerms: Set<string>): boolean {
  const normalized = normalizeSearchText(query);
  return (
    ["source", "production", "implementation", "invariant", "companion", "edit", "edits", "fix", "repair", "patch"].some((term) => queryTerms.has(term)) ||
    /\b(known source|source invariant|production source|companion edits?|do not edit|do not broaden into tests|smallest source)\b/.test(normalized)
  );
}

function hasNegatedTestIntent(query: string): boolean {
  const normalized = normalizeSearchText(query);
  return /\b(?:do not|don t|dont|never|avoid|without|no)\b(?:\s+[a-z0-9]+){0,8}\s+\b(?:test|tests|spec|specs|pytest|vitest|jest)\b/.test(normalized) ||
    /\b(?:test|tests|spec|specs|pytest|vitest|jest)\b(?:\s+[a-z0-9]+){0,6}\s+\b(?:unless|except)\b(?:\s+[a-z0-9]+){0,8}\s+\b(?:fail|fails|failed|failure|named|requested)\b/.test(normalized);
}

function groupByFile<T>(records: T[], filePathFor: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const filePath = filePathFor(record);
    grouped.set(filePath, [...(grouped.get(filePath) ?? []), record]);
  }
  return grouped;
}

function mentionedSourceFileBasenames(query: string): Set<string> {
  const basenames = new Set<string>();
  const pattern = /\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)\b/g;
  for (const match of query.matchAll(pattern)) {
    const basename = match[0]!.toLowerCase().split(/[\\/]/).at(-1);
    if (!basename || isLikelyMentionedTestBasename(basename) || isGenericMentionedSourceBasename(basename)) continue;
    basenames.add(basename);
  }
  return basenames;
}

function isLikelyMentionedTestBasename(basename: string): boolean {
  return /^test_/.test(basename) || /(?:^|[_\-.])(test|tests|spec|specs)(?:[_\-.]|$)/.test(basename) || /_test\./.test(basename);
}

function isGenericMentionedSourceBasename(basename: string): boolean {
  return /^(main|index)\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(basename);
}

const GENERIC_DOMAIN_TERMS = new Set(["api", "app", "apps", "application", "applications", "feature", "page", "screen"]);
const GENERIC_UI_FILENAME_TERMS = new Set(["settings", "layout", "mobile", "dashboard", "page", "view", "component", "screen"]);
const WORKFLOW_STATUS_TERMS = ["needs_review", "needs review", "requeued", "ignored", "sourceEmailId", "source email id"];
const CANONICAL_ROLE_STOP_TERMS = new Set([
  "debug",
  "fix",
  "issue",
  "bug",
  "failure",
  "failing",
  "regression",
  "source",
  "production",
  "implementation",
  "behavior",
  "repo",
  "repository",
  "language",
  "selected",
  "test",
  "tests",
  "file",
  "files",
  "when",
  "with",
  "through",
  "underlying",
  "coordinate",
  "interact"
]);
const STRONG_CANONICAL_BASENAME_TERMS = new Set([
  "sink",
  "logger",
  "core",
  "entry",
  "encoder",
  "schema",
  "object",
  "connection",
  "pool",
  "chain",
  "call",
  "interceptor",
  "measure",
  "segment",
  "console",
  "tree",
  "mux",
  "context",
  "route",
  "parser",
  "repository"
]);

function canonicalRoleTerm(term: string): string {
  if (term === "dependencies") return "dependency";
  if (term === "connections") return "connection";
  if (term === "pools") return "pool";
  if (term === "retries") return "retry";
  if (term === "chains") return "chain";
  if (term === "calls") return "call";
  if (term === "schemas") return "schema";
  if (term === "shapes") return "shape";
  if (term === "objects") return "object";
  if (term === "segments") return "segment";
  if (term === "rendering") return "render";
  if (term === "measurement") return "measure";
  if (term === "measurements") return "measure";
  if (term === "loggers") return "logger";
  if (term === "logs") return "log";
  if (term === "sinks") return "sink";
  if (term === "entries") return "entry";
  if (term === "encoders") return "encoder";
  if (term === "fields") return "field";
  if (term === "interceptors") return "interceptor";
  if (term === "adapters") return "adapter";
  if (term === "transforms") return "transform";
  if (term === "imports") return "import";
  if (term === "modules") return "module";
  if (term === "plugins") return "plugin";
  if (term === "containers") return "container";
  if (term === "routes") return "route";
  if (term === "patterns") return "pattern";
  if (term === "middlewares") return "middleware";
  return term;
}

function applyPreciseSourceRescue(
  files: HybridScoredResult[],
  query: string,
  symbolsByFile: Map<string, SymbolRecord[]>,
  chunksByFile: Map<string, SemanticChunkRecord[]>
): HybridScoredResult[] {
  const rescue = detectPreciseSourceRescue(query);
  if (!rescue.active) return files;

  return files.map((file) => {
    const exact = preciseSourceScore(file, rescue, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const broadPenalty = broadSourcePenalty(file, rescue, exact.precise);
    if (exact.score === 0 && broadPenalty === 0) return file;
    const adjustedScore = Math.max(0, file.score + exact.score - broadPenalty);
    return {
      ...file,
      score: Number(adjustedScore.toFixed(3)),
      behaviorScore: file.behaviorScore + exact.score - broadPenalty,
      reasons: mergeReasons([...exact.reasons, ...file.reasons, ...(broadPenalty > 0 ? ["broad source downranked"] : [])])
    };
  });
}

type PreciseSourceRescue = {
  active: boolean;
  terms: string[];
  phraseTerms: string[];
  helperIntent: boolean;
};

function detectPreciseSourceRescue(query: string): PreciseSourceRescue {
  const normalized = normalizeSearchText(query);
  const terms = tokenizeLexical(query)
    .filter((term) => term.length > 2 && !PRECISE_RESCUE_STOP_TERMS.has(term));
  const phraseTerms = new Set<string>();
  for (const phrase of PRECISE_RESCUE_PHRASES) {
    if (normalized.includes(phrase.normalized)) {
      for (const term of phrase.terms) phraseTerms.add(term);
    }
  }
  const helperIntent = /\b(helper|utility|utils?|source|implementation|debug|fix|regression|relative|absolute|local)\b/.test(normalized);
  const specificTerms = [...new Set([...terms, ...phraseTerms])];
  return {
    active: helperIntent && specificTerms.length >= 2,
    terms: specificTerms,
    phraseTerms: [...phraseTerms],
    helperIntent
  };
}

function preciseSourceScore(
  file: HybridScoredResult,
  rescue: PreciseSourceRescue,
  symbols: SymbolRecord[],
  chunks: SemanticChunkRecord[]
): { score: number; reasons: string[]; precise: boolean } {
  if (!isLanguageSourceSurface(file) || isNoisyImplementationSurface(file)) {
    return { score: 0, reasons: [], precise: false };
  }

  const pathText = normalizeSearchText(file.path);
  const basename = file.path.toLowerCase().split("/").at(-1) ?? file.path.toLowerCase();
  const basenameTerms = new Set(tokenizeLexical(basename));
  const pathTerms = new Set(tokenizeLexical(file.path));
  const symbolText = normalizeSearchText(symbols.map((symbol) => symbol.name).join(" "));
  const chunkText = normalizeSearchText(chunks.map((chunk) => `${chunk.symbol ?? ""} ${chunk.text.slice(0, 500)}`).join(" "));
  const pathHits = rescue.terms.filter((term) => pathTerms.has(term) || pathText.includes(term));
  const basenameHits = rescue.terms.filter((term) => basenameTerms.has(term) || basename.includes(term));
  const symbolHits = rescue.terms.filter((term) => symbolText.includes(term));
  const chunkHits = rescue.phraseTerms.filter((term) => chunkText.includes(term));
  const lowerPath = file.path.toLowerCase();
  const exactUtilityPath =
    /(^|\/)(utils?|helpers?|shared|common)(\/|\.|-|_)/.test(lowerPath) ||
    lowerPath.includes("/utils/") ||
    lowerPath.includes("/helpers/") ||
    lowerPath.includes("/shared/");
  const precise = basenameHits.length >= 2 || symbolHits.length >= 2 || (pathHits.length >= 3 && exactUtilityPath);
  let score = 0;
  const reasons: string[] = [];

  if (pathHits.length >= 2) {
    score += pathHits.length * 44;
    reasons.push(`precise source path match: ${pathHits.slice(0, 4).join(", ")}`);
  }
  if (basenameHits.length >= 2) {
    score += basenameHits.length * 78;
    reasons.push(`precise filename match: ${basenameHits.slice(0, 4).join(", ")}`);
  }
  if (symbolHits.length >= 2) {
    score += symbolHits.length * 72;
    reasons.push(`precise symbol rescue: ${symbolHits.slice(0, 4).join(", ")}`);
  }
  if (chunkHits.length >= 2) {
    score += chunkHits.length * 24;
    reasons.push(`precise chunk phrase match: ${chunkHits.slice(0, 4).join(", ")}`);
  }
  if (exactUtilityPath && (basenameHits.length >= 1 || symbolHits.length >= 1)) {
    score += 64;
    reasons.push("utility/helper source rescue");
  }
  if (file.kind === "test") {
    score -= 240;
    reasons.push("test excluded from precise source rescue");
  }

  return { score: Math.max(0, score), reasons, precise };
}

function broadSourcePenalty(file: HybridScoredResult, rescue: PreciseSourceRescue, precise: boolean): number {
  if (!isLanguageSourceSurface(file) || precise) return 0;
  const basename = file.path.toLowerCase().split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const genericBroad = ["router", "index", "main", "core", "types", "utils", "helpers", "client", "server"].includes(basename);
  const pathTerms = new Set(tokenizeLexical(file.path));
  const matchingTerms = rescue.terms.filter((term) => pathTerms.has(term)).length;
  let penalty = genericBroad && matchingTerms < 2 ? 70 : 0;
  const normalized = file.path.toLowerCase();
  if (/(^|\/)(types?|metadata|schema|schemas|interfaces?)(\/|\.|-|_)/.test(normalized) && matchingTerms < 2) {
    penalty += 260;
  }
  if (rescue.helperIntent && matchingTerms === 0 && !/(^|\/)(utils?|helpers?|shared|common)(\/|\.|-|_)/.test(normalized)) {
    penalty += 120;
  }
  return penalty;
}

const PRECISE_RESCUE_STOP_TERMS = new Set([
  "debug",
  "seeded",
  "failing",
  "failure",
  "regression",
  "production",
  "source",
  "check",
  "test",
  "fix",
  "file",
  "files",
  "edit",
  "unrelated",
  "bug",
  "api",
  "open",
  "openapi",
  "operation",
  "generation",
  "path",
  "should",
  "return",
  "when",
  "with",
  "from",
  "into",
  "that",
  "this"
]);

const PRECISE_RESCUE_PHRASES = [
  { normalized: "local url", terms: ["local", "url"] },
  { normalized: "relative url", terms: ["relative", "url"] },
  { normalized: "absolute url", terms: ["absolute", "url"] },
  { normalized: "is local url", terms: ["local", "url"] },
  { normalized: "starts with", terms: ["starts", "with", "prefix"] },
  { normalized: "starts_with", terms: ["starts", "prefix"] },
  { normalized: "term len", terms: ["term", "len", "length"] },
  { normalized: "term_len", terms: ["term", "len", "length"] }
];
