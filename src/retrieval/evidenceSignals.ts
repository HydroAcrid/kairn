// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type {
  ContextShownRecord,
  EvidenceCandidate,
  EvidenceFeatureVector,
  EvidenceReason,
  EvidenceTaskIntent,
  EvidenceTaskSignals,
  FileRecord,
  GraphEdgeRecord,
  HybridScoredResult,
  SymbolRecord
} from "../types.js";
import { tokenizeLexical } from "../semantic/tokenize.js";

export const DEFAULT_INITIAL_CANDIDATE_LIMIT = 64;
export const DEFAULT_ENRICHED_CANDIDATE_LIMIT = 128;

// A short failure list is precise evidence. A large suite-wide list is not:
// treating every named check as a hard reference can consume the entire
// bounded union before the task's own source symbols are considered.
const MAX_PRECISE_FAILURE_CHECKS = 8;
const MAX_IDENTIFIER_LENGTH = 96;
const MAX_PREFERRED_IDENTIFIERS = 64;
const MAX_IDENTIFIERS = 240;
const MAX_GRAPH_OR_PACKAGE_SEEDS = 16;
const MAX_EXACT_SOURCE_HEADER_COMPANIONS = 2;
const MAX_RETRIEVAL_QUERIES = 3;
const IMPLEMENTATION_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cxx", ".m", ".mm"]);
const HEADER_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".hxx"]);
const AMBIGUOUS_SINGLE_FILE_STEMS = new Set([
  "base",
  "common",
  "config",
  "constant",
  "core",
  "field",
  "helper",
  "index",
  "main",
  "model",
  "setting",
  "type",
  "util"
]);

const SOURCE_EXTENSIONS = "ts|tsx|js|jsx|mjs|cjs|py|pyi|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rb|rs";
const FILE_REFERENCE = new RegExp(
  `(?:^|[\\s"'(\\[{])((?:[A-Za-z]:)?[^\\s"'()\\[\\]{}]+?\\.(?:${SOURCE_EXTENSIONS}|json|ya?ml|toml|md|mdx|css|scss))(?=$|[\\s"'):,;\\]}.#])`,
  "gim"
);
const FILE_REFERENCE_WITH_LINE = new RegExp(
  `(?:^|[\\s"'(\\[{])((?:[A-Za-z]:)?[^\\s"'()\\[\\]{}]+?\\.(?:${SOURCE_EXTENSIONS}|json|ya?ml|toml|md|mdx|css|scss))(?::\\d+(?::\\d+)?|\\(\\d+(?:,\\d+)?\\)|["']?\\s*,\\s*line\\s+\\d+)`,
  "gim"
);

export type EvidenceCandidateInput = {
  files: FileRecord[];
  query: string;
  symbols: SymbolRecord[];
  edges: GraphEdgeRecord[];
  legacyResults: HybridScoredResult[];
  shown?: ContextShownRecord[];
  changedFiles?: Set<string>;
  initialLimit?: number;
  enrichedLimit?: number;
};

export type EvidenceCandidateSet = {
  signals: EvidenceTaskSignals;
  candidates: EvidenceCandidate[];
};

export function extractEvidenceTaskSignals(query: string): EvidenceTaskSignals {
  const explicitPaths = extractFileReferences(query, FILE_REFERENCE);
  const failureReferences = extractFileReferences(query, FILE_REFERENCE_WITH_LINE);
  const retrievalQueries = buildEvidenceRetrievalQueries(query);
  const signalQuery = (retrievalQueries.at(-1) ?? query)
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ");
  const identifiers = new Set<string>();
  const preferredIdentifiers = new Set<string>();
  const failureIdentifiers = new Set<string>();
  const identifierMatches = [...signalQuery.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*\b/g)];

  for (const match of identifierMatches) {
    addIdentifierForms(identifiers, match[0] ?? "");
  }

  // Named failing checks must survive long stack traces, logs, request dumps,
  // and compiler output. They frequently identify a test symbol whose direct
  // source/test edge is the cheapest path to production code, so add them
  // before other preferred identifiers consume the bounded symbol budget.
  for (const identifier of extractFailureCheckIdentifiers(query)) {
    addIdentifierForms(failureIdentifiers, identifier);
    addIdentifierForms(preferredIdentifiers, identifier);
  }

  // Explicitly delimited names are the strongest symbol terms even when they
  // appear late in a long natural-language prompt. Only backticks carry this
  // meaning: quoted strings in issue examples are usually data, not symbols.
  for (const match of signalQuery.matchAll(/`([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)`/g)) {
    addIdentifierForms(preferredIdentifiers, match[1] ?? "");
  }
  // A qualified reference usually names a member rather than a filename. Add
  // its terminal component so Foo::bar and Foo.bar can exactly match `bar`.
  for (const match of identifierMatches) {
    const value = match[0] ?? "";
    if (isQualifiedIdentifier(value)) addIdentifierForms(preferredIdentifiers, value);
  }
  // CamelCase, snake_case, calls, and similar code-shaped words are stronger
  // evidence than ordinary prose, but ordinary words remain as fallback terms.
  for (const match of identifierMatches) {
    const value = match[0] ?? "";
    if (isCodeLikeIdentifier(value, signalQuery, match.index ?? 0)) {
      addIdentifierForms(preferredIdentifiers, value);
    }
  }

  return {
    queryTerms: uniqueInOrder(retrievalQueries.flatMap((retrievalQuery) => tokenizeLexical(retrievalQuery))),
    explicitPaths,
    mentionedBasenames: [...new Set(explicitPaths.map((filePath) => path.posix.basename(filePath).toLowerCase()))],
    preferredIdentifiers: [...preferredIdentifiers].slice(0, MAX_PREFERRED_IDENTIFIERS),
    identifiers: [...identifiers].slice(0, MAX_IDENTIFIERS),
    failureIdentifiers: [...failureIdentifiers],
    failureReferences,
    intent: classifyEvidenceIntent(query)
  };
}

/**
 * Builds a small ordered set of retrieval queries from an issue or task. The
 * first variants favor the task narrative; the final variant preserves useful
 * code identifiers. Template comments, URLs, and broad suite dumps are never
 * allowed to dominate the bounded lexical and symbol budgets.
 */
export function buildEvidenceRetrievalQueries(query: string): string[] {
  const withoutTemplateNoise = query
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/https?:\/\/[^\s<>()]+/gi, " ");
  const withoutBroadFailures = stripBroadFailureCheckSections(withoutTemplateNoise);
  const narrativeSource = withoutBroadFailures.replace(/```[\s\S]*?```/g, " ");
  const headline = extractTaskHeadline(narrativeSource);
  const narrative = normalizeQueryText(narrativeSource);
  const codeAware = normalizeQueryText(withoutBroadFailures);
  return uniqueInOrder([headline, narrative, codeAware].filter(Boolean)).slice(0, MAX_RETRIEVAL_QUERIES);
}

export function selectEvidenceSymbolTerms(signals: EvidenceTaskSignals, limit: number): string[] {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const selected = uniqueInOrder(signals.failureIdentifiers).slice(0, boundedLimit);
  const seen = new Set(selected);
  const preferredWeight = signals.preferredIdentifiers.length <= 32 ? 2 : 1;
  const channels = [
    { values: signals.preferredIdentifiers, weight: preferredWeight },
    { values: signals.queryTerms, weight: 1 },
    { values: signals.identifiers, weight: 1 }
  ];
  const cursors = channels.map(() => 0);
  let progressed = true;
  while (selected.length < boundedLimit && progressed) {
    progressed = false;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const channel = channels[channelIndex]!;
      for (let take = 0; take < channel.weight && selected.length < boundedLimit; take += 1) {
        let cursor = cursors[channelIndex] ?? 0;
        while (cursor < channel.values.length && seen.has(channel.values[cursor]!)) cursor += 1;
        cursors[channelIndex] = cursor + 1;
        const term = channel.values[cursor];
        if (!term) break;
        selected.push(term);
        seen.add(term);
        progressed = true;
      }
    }
  }
  return selected;
}

export function buildEvidenceCandidates(input: EvidenceCandidateInput): EvidenceCandidateSet {
  const initialLimit = Math.max(1, Math.min(input.initialLimit ?? DEFAULT_INITIAL_CANDIDATE_LIMIT, DEFAULT_INITIAL_CANDIDATE_LIMIT));
  const enrichedLimit = Math.max(initialLimit, Math.min(input.enrichedLimit ?? DEFAULT_ENRICHED_CANDIDATE_LIMIT, DEFAULT_ENRICHED_CANDIDATE_LIMIT));
  const signals = extractEvidenceTaskSignals(input.query);
  const filesByPath = new Map(input.files.map((file) => [normalizeRepoPath(file.path), file]));
  const legacyByPath = new Map(input.legacyResults.map((file) => [normalizeRepoPath(file.path), file]));
  const symbolsByFile = groupSymbols(input.symbols);
  const shownFiles = new Set(
    (input.shown ?? [])
      .map((record) => record.filePath)
      .filter((filePath): filePath is string => Boolean(filePath))
      .map(normalizeRepoPath)
  );
  const changedFiles = new Set([...(input.changedFiles ?? [])].map(normalizeRepoPath));
  const reasonsByPath = new Map<string, Set<EvidenceReason>>();
  const exactSymbolPriorityByPath = new Map<string, number>();
  const focusedFileStemTerms = tokenizeLexical(buildEvidenceRetrievalQueries(input.query)[0] ?? input.query);

  const addSignal = (filePath: string, reason: EvidenceReason): void => {
    const normalized = normalizeRepoPath(filePath);
    if (!filesByPath.has(normalized)) return;
    const reasons = reasonsByPath.get(normalized) ?? new Set<EvidenceReason>();
    reasons.add(reason);
    reasonsByPath.set(normalized, reasons);
  };

  const orderedFiles = stableFiles(input.files);
  const unambiguousFailureReferences = unambiguousFileReferences(signals.failureReferences, orderedFiles);
  const unambiguousExplicitPaths = unambiguousFileReferences(signals.explicitPaths, orderedFiles);

  // Add signal classes in evidence-strength order. A common basename can match
  // hundreds of files, so mixing these checks in a single path-sorted loop can
  // otherwise fill the bounded union before the exact path is reached.
  for (const file of orderedFiles) {
    if (unambiguousFailureReferences.some((candidate) => pathsReferToSameFile(file.path, candidate))) {
      addSignal(file.path, "failure_reference");
    }
  }
  for (const file of orderedFiles) {
    if (unambiguousExplicitPaths.some((candidate) => pathsReferToSameFile(file.path, candidate))) {
      addSignal(file.path, "exact_path");
    }
  }
  for (const file of orderedFiles) {
    if (
      signals.mentionedBasenames.includes(path.posix.basename(normalizeRepoPath(file.path)).toLowerCase()) ||
      fileStemMatchesQuery(file.path, focusedFileStemTerms)
    ) {
      addSignal(file.path, "basename");
    }
  }

  for (const symbol of [...input.symbols].sort((left, right) => left.filePath.localeCompare(right.filePath) || left.name.localeCompare(right.name))) {
    const identity = normalizeIdentity(symbol.name);
    if (!identity) continue;
    const preferredIndex = signals.preferredIdentifiers.indexOf(identity);
    if (signals.failureIdentifiers.includes(identity)) {
      addSignal(symbol.filePath, "failure_reference");
      addSignal(symbol.filePath, "exact_symbol");
      exactSymbolPriorityByPath.set(symbol.filePath, signals.preferredIdentifiers.length + 1);
    } else if (preferredIndex >= 0) {
      addSignal(symbol.filePath, "exact_symbol");
      exactSymbolPriorityByPath.set(
        symbol.filePath,
        Math.max(exactSymbolPriorityByPath.get(symbol.filePath) ?? 0, signals.preferredIdentifiers.length - preferredIndex)
      );
    } else if (signals.preferredIdentifiers.some((candidate) => candidate.length >= 4 && (identity.startsWith(candidate) || candidate.startsWith(identity)))) {
      addSignal(symbol.filePath, "symbol_prefix");
    }
  }

  for (const result of sortLegacy(input.legacyResults, (file) => file.bm25Score)) {
    if (result.bm25Score > 0) addSignal(result.path, "lexical");
  }
  for (const result of sortLegacy(input.legacyResults, (file) => file.keywordScore)) {
    if (result.keywordScore > 0) addSignal(result.path, "lexical");
  }
  for (const result of sortLegacy(input.legacyResults, (file) => file.semanticScore)) {
    if (result.semanticScore > 0.03) addSignal(result.path, "semantic");
  }
  // Reserve bounded-union capacity for lexically retrieved files whose role
  // matches the task. Otherwise docs/tests with repeated issue vocabulary can
  // consume every slot before the production implementation is considered.
  for (const result of input.legacyResults) {
    const file = filesByPath.get(normalizeRepoPath(result.path));
    if (!file || (result.bm25Score <= 0 && result.keywordScore <= 0 && result.semanticScore <= 0.03)) continue;
    if (isProductionEvidenceFile(file)) addSignal(file.path, "production_source");
    if (roleMatchesIntent(file, signals.intent)) addSignal(file.path, "role_match");
    if (signals.intent === "test" && isTestFile(file)) addSignal(file.path, "test_requested");
  }
  for (const filePath of [...changedFiles].sort()) addSignal(filePath, "git_diff");
  for (const filePath of [...shownFiles].sort()) addSignal(filePath, "already_delivered");

  if (reasonsByPath.size === 0) {
    for (const file of [...input.files].sort((left, right) => right.importance - left.importance || left.path.localeCompare(right.path)).slice(0, 16)) {
      addSignal(file.path, roleReason(file, signals.intent));
    }
  }

  const preliminaryInitialPaths = selectInitialPaths({
    reasonsByPath,
    legacyByPath,
    filesByPath,
    exactSymbolPriorityByPath,
    intent: signals.intent,
    limit: initialLimit
  });
  const graphPriorityByPath = new Map<string, number>();
  const preliminaryNeighbors = roundRobinGraphNeighbors({
    seedPaths: preliminaryInitialPaths,
    edges: input.edges,
    filesByPath,
    limit: Math.max(0, enrichedLimit - preliminaryInitialPaths.length)
  });
  for (const { edge, neighbor } of preliminaryNeighbors) {
    const precision = graphEdgePrecision(edge);
    const existingReasons = reasonsByPath.get(neighbor) ?? new Set<EvidenceReason>();
    const retrievalBackedImport = precision === 1 &&
      isProductionEvidenceFile(filesByPath.get(neighbor)!) &&
      ["exact_symbol", "symbol_prefix", "basename", "lexical", "semantic"].some((reason) =>
        existingReasons.has(reason as EvidenceReason)
      );
    if (precision < 2 && !retrievalBackedImport) continue;
    existingReasons.add("graph_neighbor");
    if (edge.type === "test_for" || edge.type === "tested_by") existingReasons.add("source_test_pair");
    reasonsByPath.set(neighbor, existingReasons);
    graphPriorityByPath.set(
      neighbor,
      Math.max(graphPriorityByPath.get(neighbor) ?? 0, precision * 100 + channelScore("lexical", neighbor, legacyByPath, filesByPath))
    );
  }
  const packagePriorityByDirectory = new Map<string, number>();
  preliminaryInitialPaths.forEach((filePath, index) => {
    const directory = path.posix.dirname(filePath);
    if (directory === ".") return;
    packagePriorityByDirectory.set(
      directory,
      Math.max(packagePriorityByDirectory.get(directory) ?? 0, preliminaryInitialPaths.length - index)
    );
  });
  for (const [filePath, reasons] of reasonsByPath) {
    if (preliminaryInitialPaths.includes(filePath)) continue;
    const file = filesByPath.get(filePath);
    if (!file || !isProductionEvidenceFile(file)) continue;
    const directoryPriority = packagePriorityByDirectory.get(path.posix.dirname(filePath));
    if (!directoryPriority) continue;
    if (!["exact_symbol", "symbol_prefix", "basename", "lexical", "semantic"].some((reason) => reasons.has(reason as EvidenceReason))) {
      continue;
    }
    reasons.add("graph_neighbor");
    graphPriorityByPath.set(
      filePath,
      Math.max(
        graphPriorityByPath.get(filePath) ?? 0,
        50 + directoryPriority + channelScore("lexical", filePath, legacyByPath, filesByPath)
      )
    );
  }
  const baselineInitialPaths = selectInitialPaths({
    reasonsByPath,
    legacyByPath,
    filesByPath,
    exactSymbolPriorityByPath,
    graphPriorityByPath,
    intent: signals.intent,
    limit: initialLimit
  });
  const sourceHeaderMerge = mergeExactSourceHeaderCompanions({
    baselinePaths: baselineInitialPaths,
    files: input.files,
    filesByPath,
    legacyByPath,
    intent: signals.intent,
    limit: initialLimit
  });
  const initialPaths = sourceHeaderMerge.paths;
  for (const filePath of sourceHeaderMerge.companions) {
    const reasons = reasonsByPath.get(filePath) ?? new Set<EvidenceReason>();
    reasons.add("graph_neighbor");
    reasonsByPath.set(filePath, reasons);
  }

  const enrichedPaths = [...initialPaths];
  const selectedPaths = new Set(enrichedPaths);
  for (const { edge, neighbor } of roundRobinGraphNeighbors({
    seedPaths: initialPaths,
    edges: input.edges,
    filesByPath,
    limit: Math.max(0, enrichedLimit - enrichedPaths.length)
  })) {
    const reasons = reasonsByPath.get(neighbor) ?? new Set<EvidenceReason>();
    reasons.add("graph_neighbor");
    if (edge.type === "test_for" || edge.type === "tested_by") reasons.add("source_test_pair");
    reasonsByPath.set(neighbor, reasons);
    if (!selectedPaths.has(neighbor) && enrichedPaths.length < enrichedLimit) {
      enrichedPaths.push(neighbor);
      selectedPaths.add(neighbor);
    }
  }

  const candidates = enrichedPaths.map((filePath) => {
    const file = filesByPath.get(filePath)!;
    const legacy = legacyByPath.get(filePath);
    const symbols = symbolsByFile.get(filePath) ?? [];
    const reasons = reasonsByPath.get(filePath) ?? new Set<EvidenceReason>();
    addDerivedReasons(reasons, file, legacy, signals, symbols, shownFiles, changedFiles);
    return {
      path: file.path,
      reasons: sortEvidenceReasons(reasons),
      features: buildFeatureVector({ file, legacy, reasons, symbols, signals })
    };
  });

  return { signals, candidates };
}

type GraphNeighbor = {
  edge: GraphEdgeRecord;
  neighbor: string;
};

/**
 * Expands one graph hop without letting a high-degree early seed consume the
 * entire enrichment budget. Precise source/test relationships lead each
 * seed's queue, and the queues are drained round-robin in initial-candidate
 * order. This preserves deterministic output while giving every seed a fair
 * chance to contribute a useful companion.
 */
function roundRobinGraphNeighbors(input: {
  seedPaths: string[];
  edges: GraphEdgeRecord[];
  filesByPath: Map<string, FileRecord>;
  limit: number;
}): GraphNeighbor[] {
  if (input.limit <= 0 || input.seedPaths.length === 0) return [];
  const seedSet = new Set(input.seedPaths);
  const priorities = [3, 2, 1, 0] as const;
  const bySeed = new Map<string, Map<number, GraphNeighbor[]>>();
  for (const seed of input.seedPaths) {
    bySeed.set(seed, new Map(priorities.map((priority) => [priority, []])));
  }

  for (const edge of input.edges) {
    const from = normalizeRepoPath(edge.fromFile);
    const to = normalizeRepoPath(edge.toFile);
    const priority = graphEdgePrecision(edge);
    if (seedSet.has(from) && input.filesByPath.has(to)) {
      bySeed.get(from)!.get(priority)!.push({ edge, neighbor: to });
    }
    if (seedSet.has(to) && input.filesByPath.has(from) && from !== to) {
      bySeed.get(to)!.get(priority)!.push({ edge, neighbor: from });
    }
  }

  for (const priorityBuckets of bySeed.values()) {
    for (const neighbors of priorityBuckets.values()) {
      neighbors.sort((left, right) =>
        left.neighbor.localeCompare(right.neighbor) || left.edge.type.localeCompare(right.edge.type)
      );
    }
  }

  const selected: GraphNeighbor[] = [];
  const selectedNeighborIndexes = new Map<string, number>();
  // Drain high-precision relationships first. Within a precision class, take
  // at most one new neighbor per seed per round.
  for (const priority of priorities) {
    const cursors = new Map(input.seedPaths.map((seed) => [seed, 0]));
    let madeProgress = true;
    while (selected.length < input.limit && madeProgress) {
      madeProgress = false;
      for (const seed of input.seedPaths) {
        const neighbors = bySeed.get(seed)?.get(priority) ?? [];
        let cursor = cursors.get(seed) ?? 0;
        while (cursor < neighbors.length) {
          const candidate = neighbors[cursor++]!;
          if (seedSet.has(candidate.neighbor) || selectedNeighborIndexes.has(candidate.neighbor)) continue;
          selected.push(candidate);
          selectedNeighborIndexes.set(candidate.neighbor, selected.length - 1);
          madeProgress = true;
          break;
        }
        cursors.set(seed, cursor);
        if (selected.length >= input.limit) break;
      }
    }
    if (selected.length >= input.limit) break;
  }
  return selected;
}

function graphEdgePrecision(edge: GraphEdgeRecord): number {
  if (edge.type === "test_for" || edge.type === "tested_by") return 3;
  if (edge.type === "definition" || edge.type === "implementation") return 2;
  if (edge.type === "imports" || edge.type === "imported_by") return 1;
  return 0;
}

function buildFeatureVector(input: {
  file: FileRecord;
  legacy: HybridScoredResult | undefined;
  reasons: Set<EvidenceReason>;
  symbols: SymbolRecord[];
  signals: EvidenceTaskSignals;
}): EvidenceFeatureVector {
  const lexical = (input.legacy?.bm25Score ?? 0) + (input.legacy?.keywordScore ?? 0);
  return {
    exactPath: binary(input.reasons.has("exact_path")),
    basenameMatch: binary(input.reasons.has("basename")),
    exactSymbol: binary(input.reasons.has("exact_symbol")),
    symbolPrefix: binary(input.reasons.has("symbol_prefix")),
    bm25: normalizePositive(input.legacy?.bm25Score ?? 0, 8),
    keyword: normalizePositive(input.legacy?.keywordScore ?? 0, 8),
    semantic: clamp01(input.legacy?.semanticScore ?? 0),
    failureReference: binary(input.reasons.has("failure_reference")),
    gitChanged: binary(input.reasons.has("git_diff")),
    alreadyDelivered: binary(input.reasons.has("already_delivered")),
    graphNeighbor: binary(input.reasons.has("graph_neighbor")),
    sourceTestPair: binary(input.reasons.has("source_test_pair")),
    productionSource: binary(isProductionEvidenceFile(input.file)),
    testFile: binary(isTestFile(input.file)),
    docsFile: binary(isDocsFile(input.file)),
    generatedVendor: binary(isGeneratedOrVendor(input.file.path)),
    intentRoleMatch: binary(roleMatchesIntent(input.file, input.signals.intent)),
    importance: clamp01(Math.max(0, input.file.importance) / 100),
    contentCost: clamp01(Math.log2(Math.max(1, input.file.size)) / 20),
    missingSymbols: binary(input.symbols.length === 0),
    missingLexical: binary(lexical <= 0)
  };
}

function addDerivedReasons(
  reasons: Set<EvidenceReason>,
  file: FileRecord,
  legacy: HybridScoredResult | undefined,
  signals: EvidenceTaskSignals,
  symbols: SymbolRecord[],
  shownFiles: Set<string>,
  changedFiles: Set<string>
): void {
  const normalizedPath = normalizeRepoPath(file.path);
  if (shownFiles.has(normalizedPath)) reasons.add("already_delivered");
  if (changedFiles.has(normalizedPath)) reasons.add("git_diff");
  if ((legacy?.bm25Score ?? 0) > 0 || (legacy?.keywordScore ?? 0) > 0) reasons.add("lexical");
  if ((legacy?.semanticScore ?? 0) > 0.03) reasons.add("semantic");
  if (isProductionEvidenceFile(file)) reasons.add("production_source");
  if (isGeneratedOrVendor(file.path)) reasons.add("generated_vendor");
  if (signals.intent === "test" && isTestFile(file)) reasons.add("test_requested");
  if (roleMatchesIntent(file, signals.intent)) reasons.add("role_match");
  if (file.size >= 64 * 1024) reasons.add("content_cost");

  for (const symbol of symbols) {
    const identity = normalizeIdentity(symbol.name);
    if (signals.failureIdentifiers.includes(identity)) {
      reasons.add("failure_reference");
      reasons.add("exact_symbol");
    } else if (signals.preferredIdentifiers.includes(identity)) reasons.add("exact_symbol");
    else if (signals.preferredIdentifiers.some((candidate) => candidate.length >= 4 && identity.startsWith(candidate))) reasons.add("symbol_prefix");
  }
}

function classifyEvidenceIntent(query: string): EvidenceTaskIntent {
  const terms = new Set(tokenizeLexical(query));
  if (["source", "production", "implementation", "debug", "failure", "failing", "failed", "error", "exception", "bug", "incorrect", "regression"].some((term) => terms.has(term))) return "source";
  if (["test", "tests", "spec", "specs", "verify", "verification", "coverage"].some((term) => terms.has(term))) return "test";
  if (["docs", "documentation", "readme", "guide", "example", "examples"].some((term) => terms.has(term))) return "docs";
  if (["refactor", "code"].some((term) => terms.has(term))) return "source";
  return "unknown";
}

function extractFileReferences(query: string, pattern: RegExp): string[] {
  const references = new Set<string>();
  pattern.lastIndex = 0;
  for (const match of query.matchAll(pattern)) {
    const normalized = normalizeMentionedPath(match[1] ?? "");
    if (normalized) references.add(normalized);
  }
  return [...references].sort();
}

function normalizeMentionedPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function pathsReferToSameFile(filePath: string, mentionedPath: string): boolean {
  const file = normalizeRepoPath(filePath).toLowerCase();
  const mentioned = normalizeMentionedPath(mentionedPath);
  return file === mentioned || mentioned.endsWith(`/${file}`) || file.endsWith(`/${mentioned}`);
}

function unambiguousFileReferences(references: string[], files: FileRecord[]): string[] {
  return references.filter((reference) => {
    let matches = 0;
    for (const file of files) {
      if (!pathsReferToSameFile(file.path, reference)) continue;
      matches += 1;
      if (matches > 1) return false;
    }
    return matches === 1;
  });
}

function normalizeIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function addIdentifierForms(target: Set<string>, value: string): void {
  if (value.length > MAX_IDENTIFIER_LENGTH) return;
  const forms = isQualifiedIdentifier(value)
    ? [value.split(/::|\./).at(-1) ?? "", value]
    : [value];
  for (const form of forms) {
    const normalized = normalizeIdentity(form);
    if (normalized.length >= 3) target.add(normalized);
  }
}

function isQualifiedIdentifier(value: string): boolean {
  if (!/(?:\.|::)/.test(value)) return false;
  return !new RegExp(`\\.(?:${SOURCE_EXTENSIONS}|json|ya?ml|toml|md|mdx|css|scss)$`, "i").test(value);
}

function isCodeLikeIdentifier(value: string, query: string, index: number): boolean {
  if (isQualifiedIdentifier(value)) return true;
  if (/[_$]|\d/.test(value)) return true;
  if (/[a-z0-9][A-Z]|^[A-Z]{2,}[A-Za-z0-9]*$/.test(value)) return true;
  return /^\s*\(/.test(query.slice(index + value.length));
}

function extractFailureCheckIdentifiers(query: string): string[] {
  const output = new Set<string>();
  const addFrom = (value: string): void => {
    for (const match of value.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*\b/g)) {
      const identifier = match[0] ?? "";
      if (isStructuredFailureIdentifier(identifier)) output.add(identifier);
    }
  };
  const lines = query.split(/\r?\n/);
  let inFailureSection = false;
  for (const line of lines) {
    const header = line.match(/^\s*(?:#{1,6}\s*)?(?:initial\s+)?failing\s+(?:checks?|tests?)\s*:\s*(.*)$/i);
    if (header) {
      inFailureSection = true;
      addFrom(header[1] ?? "");
      continue;
    }
    if (inFailureSection) {
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        addFrom(bullet[1] ?? "");
        continue;
      }
      if (!line.trim()) continue;
      inFailureSection = false;
    }
    const runnerFailure = line.match(/^\s*(?:---\s+FAIL:\s*|FAILED\s+|FAIL\s+)(.+)$/i);
    if (runnerFailure) addFrom(runnerFailure[1] ?? "");
  }
  return output.size <= MAX_PRECISE_FAILURE_CHECKS ? [...output] : [];
}

function isStructuredFailureIdentifier(value: string): boolean {
  if (isQualifiedIdentifier(value)) return true;
  if (/^test(?:[A-Z0-9_$]|_)/.test(value) || /(?:Test|Tests)$/.test(value)) return true;
  if (/^(?:Test|IT)[A-Z0-9_$]/.test(value)) return true;
  return /[_$]|\d|[a-z0-9][A-Z]/.test(value);
}

function groupSymbols(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const filePath = normalizeRepoPath(symbol.filePath);
    grouped.set(filePath, [...(grouped.get(filePath) ?? []), symbol]);
  }
  return grouped;
}

function fileStemMatchesQuery(filePath: string, queryTerms: string[]): boolean {
  const basename = path.posix.basename(normalizeRepoPath(filePath)).toLowerCase();
  const extension = path.posix.extname(basename);
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  const stemTerms = uniqueInOrder(tokenizeLexical(stem))
    .map(normalizeInflectedTerm)
    .filter((term) => term.length >= 3);
  if (
    stemTerms.length === 0 ||
    (
      stemTerms.length === 1 &&
      (stemTerms[0]!.length < 8 || AMBIGUOUS_SINGLE_FILE_STEMS.has(stemTerms[0]!))
    )
  ) {
    return false;
  }
  const normalizedQueryTerms = new Set(queryTerms.map(normalizeInflectedTerm));
  return stemTerms.every((term) => normalizedQueryTerms.has(term));
}

function normalizeInflectedTerm(value: string): string {
  const term = value.toLowerCase();
  if (term.length <= 4 || term.endsWith("ss")) return term;
  if (term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (/(?:ses|xes|zes|ches|shes)$/.test(term)) return term.slice(0, -2);
  return term.endsWith("s") ? term.slice(0, -1) : term;
}

function mergeExactSourceHeaderCompanions(input: {
  baselinePaths: string[];
  files: FileRecord[];
  filesByPath: Map<string, FileRecord>;
  legacyByPath: Map<string, HybridScoredResult>;
  intent: EvidenceTaskIntent;
  limit: number;
}): { paths: string[]; companions: string[] } {
  const baseline = input.baselinePaths.slice(0, input.limit);
  if (
    input.intent !== "source" &&
    input.intent !== "unknown"
  ) {
    return { paths: baseline, companions: [] };
  }

  const filesByStem = new Map<string, { implementations: string[]; headers: string[] }>();
  for (const file of input.files) {
    if (!isProductionEvidenceFile(file) || isGeneratedOrVendor(file.path)) continue;
    const extension = path.posix.extname(file.path).toLowerCase();
    const kind = IMPLEMENTATION_EXTENSIONS.has(extension)
      ? "implementations"
      : HEADER_EXTENSIONS.has(extension)
        ? "headers"
        : undefined;
    if (!kind) continue;
    const normalizedPath = normalizeRepoPath(file.path);
    const stem = normalizedPath.slice(0, -extension.length);
    const group = filesByStem.get(stem) ?? { implementations: [], headers: [] };
    group[kind].push(normalizedPath);
    filesByStem.set(stem, group);
  }
  for (const group of filesByStem.values()) {
    group.implementations.sort();
    group.headers.sort();
  }

  const selected = new Set(baseline);
  const companionCandidatesByPath = new Map<string, { path: string; seedIndex: number; seedEvidence: number }>();
  baseline.forEach((seedPath, seedIndex) => {
    const extension = path.posix.extname(seedPath).toLowerCase();
    const counterparts = IMPLEMENTATION_EXTENSIONS.has(extension)
      ? filesByStem.get(seedPath.slice(0, -extension.length))?.headers
      : HEADER_EXTENSIONS.has(extension)
        ? filesByStem.get(seedPath.slice(0, -extension.length))?.implementations
        : undefined;
    for (const counterpart of counterparts ?? []) {
      if (selected.has(counterpart)) continue;
      const candidate = {
        path: counterpart,
        seedIndex,
        seedEvidence: channelScore("role_match", seedPath, input.legacyByPath, input.filesByPath)
      };
      const existing = companionCandidatesByPath.get(counterpart);
      if (
        !existing ||
        candidate.seedEvidence > existing.seedEvidence ||
        (candidate.seedEvidence === existing.seedEvidence && candidate.seedIndex < existing.seedIndex)
      ) {
        companionCandidatesByPath.set(counterpart, candidate);
      }
    }
  });
  const companions = [...companionCandidatesByPath.values()]
    .sort((left, right) =>
      right.seedEvidence - left.seedEvidence ||
      left.seedIndex - right.seedIndex ||
      left.path.localeCompare(right.path)
    )
    .slice(0, MAX_EXACT_SOURCE_HEADER_COMPANIONS)
    .map((candidate) => candidate.path);

  const protectedPrefixLength = Math.max(
    Math.ceil(baseline.length * 0.75),
    baseline.length - MAX_EXACT_SOURCE_HEADER_COMPANIONS
  );
  const appendCount = Math.min(companions.length, Math.max(0, input.limit - baseline.length));
  const merged = [...baseline, ...companions.slice(0, appendCount)];
  const replacementCompanions = companions.slice(appendCount);
  const replaceCount = Math.min(
    replacementCompanions.length,
    Math.max(0, baseline.length - protectedPrefixLength)
  );
  if (replaceCount > 0) {
    merged.splice(
      baseline.length - replaceCount,
      replaceCount,
      ...replacementCompanions.slice(0, replaceCount)
    );
  }
  return {
    paths: merged,
    companions: companions.slice(0, appendCount + replaceCount)
  };
}

function selectInitialPaths(input: {
  reasonsByPath: Map<string, Set<EvidenceReason>>;
  legacyByPath: Map<string, HybridScoredResult>;
  filesByPath: Map<string, FileRecord>;
  exactSymbolPriorityByPath: Map<string, number>;
  graphPriorityByPath?: Map<string, number> | undefined;
  intent: EvidenceTaskIntent;
  limit: number;
}): string[] {
  const selected: string[] = [];
  const selectedPaths = new Set<string>();
  const add = (filePath: string): void => {
    if (selected.length >= input.limit || selectedPaths.has(filePath)) return;
    selected.push(filePath);
    selectedPaths.add(filePath);
  };
  const candidatesFor = (reason: EvidenceReason, strongestExactFirst = false): string[] =>
    [...input.reasonsByPath.entries()]
      .filter(([, reasons]) => reasons.has(reason))
      .map(([filePath]) => filePath)
      .sort((left, right) =>
        (strongestExactFirst
          ? (input.exactSymbolPriorityByPath.get(right) ?? 0) - (input.exactSymbolPriorityByPath.get(left) ?? 0)
          : 0) ||
        (
          reason === "basename" && (input.intent === "source" || input.intent === "unknown")
            ? Number(isProductionEvidenceFile(input.filesByPath.get(right)!)) -
              Number(isProductionEvidenceFile(input.filesByPath.get(left)!))
            : 0
        ) ||
        channelScore(reason, right, input.legacyByPath, input.filesByPath) -
          channelScore(reason, left, input.legacyByPath, input.filesByPath) ||
        left.localeCompare(right)
      );

  // Failure and exact-path references are hard evidence and cannot be crowded
  // out by a high-cardinality basename, lexical, or session channel.
  for (const reason of ["failure_reference", "exact_path"] as const) {
    for (const filePath of candidatesFor(reason)) add(filePath);
  }

  // Reserve only a tiny precision lane for the strongest quoted/qualified
  // exact symbols. The normal exact-symbol channel below remains ordered by
  // file importance so a single noisy prompt cannot displace broad recall.
  for (const filePath of candidatesFor("exact_symbol", true).slice(0, 2)) add(filePath);

  // A complete, non-generic filename stem expressed in the task is also
  // precise evidence, including cross-extension references from built output.
  // Keep this lane small because common basenames can still be ambiguous.
  for (const filePath of candidatesFor("basename").slice(0, 4)) add(filePath);

  // Direct source/test and definition relationships are candidate generators,
  // not merely post-64 enrichment. Retrieval-backed imports receive the same
  // treatment in a small lane, while arbitrary high-degree import fanout stays
  // outside the initial bound.
  for (const filePath of [...(input.graphPriorityByPath?.keys() ?? [])]
    .sort((left, right) =>
      (input.graphPriorityByPath?.get(right) ?? 0) - (input.graphPriorityByPath?.get(left) ?? 0) ||
      left.localeCompare(right)
    )
    .slice(0, Math.min(MAX_GRAPH_OR_PACKAGE_SEEDS, input.limit))) {
    add(filePath);
  }

  // Required production-source recall is the primary gate for debugging and
  // source-localization tasks, but the role prior must not replace independent
  // evidence generators. Split the remaining bound evenly so basename, symbol,
  // lexical, graph, and session evidence can still rescue production files that
  // are weak in the blended role ordering.
  if (input.intent === "source" || input.intent === "unknown") {
    const independentReserve = Math.max(1, Math.ceil(input.limit / 2));
    for (const filePath of candidatesFor("production_source").slice(0, Math.max(0, input.limit - independentReserve))) {
      add(filePath);
    }
  }

  // The remaining independent generators take turns contributing candidates.
  // This keeps one broad signal class from consuming all 64 initial slots.
  const channels: EvidenceReason[] = [
    "exact_symbol",
    "basename",
    "symbol_prefix",
    "lexical",
    "git_diff",
    "already_delivered",
    "semantic",
    "test_requested",
    "role_match",
    "production_source",
    "content_cost"
  ];
  const pathsByChannel = new Map(channels.map((reason) => [reason, candidatesFor(reason)]));
  const cursors = new Map(channels.map((reason) => [reason, 0]));
  let progressed = true;
  while (selected.length < input.limit && progressed) {
    progressed = false;
    for (const reason of channels) {
      const paths = pathsByChannel.get(reason) ?? [];
      let cursor = cursors.get(reason) ?? 0;
      while (cursor < paths.length && selectedPaths.has(paths[cursor]!)) cursor += 1;
      cursors.set(reason, cursor + 1);
      const next = paths[cursor];
      if (!next) continue;
      add(next);
      progressed = true;
      if (selected.length >= input.limit) break;
    }
  }

  return selected;
}

function channelScore(
  reason: EvidenceReason,
  filePath: string,
  legacyByPath: Map<string, HybridScoredResult>,
  filesByPath: Map<string, FileRecord>
): number {
  const legacy = legacyByPath.get(filePath);
  if (reason === "lexical") return (legacy?.bm25Score ?? 0) + (legacy?.keywordScore ?? 0);
  if (reason === "semantic") return legacy?.semanticScore ?? 0;
  if (reason === "basename" || reason === "role_match" || reason === "production_source" || reason === "test_requested") {
    return (legacy?.bm25Score ?? 0) + (legacy?.keywordScore ?? 0) + (legacy?.semanticScore ?? 0) * 4 +
      (reason === "basename" && isProductionEvidenceFile(filesByPath.get(filePath)!) ? 4 : 0) +
      (filesByPath.get(filePath)?.importance ?? 0) / 100;
  }
  return filesByPath.get(filePath)?.importance ?? 0;
}

function stripBroadFailureCheckSections(query: string): string {
  const lines = query.split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.match(/^\s*(?:#{1,6}\s*)?(?:initial\s+)?failing\s+(?:checks?|tests?)\s*:\s*(.*)$/i);
    if (!header) {
      output.push(lines[index]!);
      continue;
    }
    const section = [lines[index]!];
    let bulletCount = header[1]?.trim() ? 1 : 0;
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor]!;
      if (/^\s*[-*]\s+/.test(line)) {
        bulletCount += 1;
        section.push(line);
        cursor += 1;
        continue;
      }
      if (!line.trim()) {
        section.push(line);
        cursor += 1;
        continue;
      }
      break;
    }
    if (bulletCount <= MAX_PRECISE_FAILURE_CHECKS) output.push(...section);
    index = cursor - 1;
  }
  return output.join("\n");
}

function extractTaskHeadline(query: string): string {
  const selected: string[] = [];
  for (const rawLine of query.split(/\r?\n/)) {
    const line = rawLine
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*[-*]\s+/, "")
      .trim();
    if (!line || /^(?:initial\s+)?failing\s+(?:checks?|tests?)\s*:?$/i.test(line)) continue;
    if (/^(?:environment|configuration|system details|additional context)\s*:?$/i.test(line)) break;
    selected.push(line);
    if (selected.length >= 3 || selected.join(" ").length >= 600) break;
  }
  return normalizeQueryText(selected.join(" ").slice(0, 800));
}

function normalizeQueryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueInOrder<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sortLegacy(
  files: HybridScoredResult[],
  score: (file: HybridScoredResult) => number
): HybridScoredResult[] {
  return [...files].sort((left, right) => score(right) - score(left) || left.path.localeCompare(right.path));
}

function stableFiles(files: FileRecord[]): FileRecord[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

export function isProductionEvidenceFile(file: FileRecord): boolean {
  return ["source", "route", "component", "schema"].includes(file.kind) && !isTestFile(file) && !isDocsFile(file) && !isGeneratedOrVendor(file.path);
}

function isTestFile(file: FileRecord): boolean {
  return file.kind === "test" || /(^|\/)(tests?|specs?|__tests__)(\/|$)|(?:^|[._-])(test|spec)(?:[._-]|$)|_test\.go$/i.test(file.path);
}

function isDocsFile(file: FileRecord): boolean {
  return file.kind === "doc" || /(^|\/)(docs?|documentation|examples?|samples?)(\/|$)|(^|\/)readme(?:\.|$)/i.test(file.path);
}

function isGeneratedOrVendor(filePath: string): boolean {
  return /(^|\/)(node_modules|vendor|third_party|deps|generated|gen|dist|build|coverage)(\/|$)|\.(?:generated|gen)\.[^.]+$/i.test(filePath);
}

function roleMatchesIntent(file: FileRecord, intent: EvidenceTaskIntent): boolean {
  if (intent === "source") return isProductionEvidenceFile(file);
  if (intent === "test") return isTestFile(file);
  if (intent === "docs") return isDocsFile(file);
  return isProductionEvidenceFile(file);
}

function roleReason(file: FileRecord, intent: EvidenceTaskIntent): EvidenceReason {
  if (intent === "test" && isTestFile(file)) return "test_requested";
  if (roleMatchesIntent(file, intent)) return "role_match";
  return isProductionEvidenceFile(file) ? "production_source" : "content_cost";
}

const EVIDENCE_REASON_ORDER: EvidenceReason[] = [
  "failure_reference",
  "exact_path",
  "basename",
  "exact_symbol",
  "symbol_prefix",
  "lexical",
  "semantic",
  "git_diff",
  "already_delivered",
  "source_test_pair",
  "graph_neighbor",
  "test_requested",
  "role_match",
  "production_source",
  "generated_vendor",
  "content_cost"
];

function sortEvidenceReasons(reasons: Set<EvidenceReason>): EvidenceReason[] {
  return EVIDENCE_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function normalizePositive(value: number, scale: number): number {
  return clamp01(Math.log1p(Math.max(0, value)) / scale);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function binary(value: boolean): number {
  return value ? 1 : 0;
}
