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
  const identifiers = new Set<string>();
  const preferredIdentifiers = new Set<string>();
  const identifierMatches = [...query.matchAll(/\b[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*\b/g)];

  for (const match of identifierMatches) {
    addIdentifierForms(identifiers, match[0] ?? "");
  }

  // Explicitly delimited names are the strongest symbol terms even when they
  // appear late in a long natural-language prompt.
  for (const match of query.matchAll(/[`'"]([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)[`'"]/g)) {
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
    if (isCodeLikeIdentifier(value, query, match.index ?? 0)) {
      addIdentifierForms(preferredIdentifiers, value);
    }
  }

  return {
    queryTerms: [...new Set(tokenizeLexical(query))],
    explicitPaths,
    mentionedBasenames: [...new Set(explicitPaths.map((filePath) => path.posix.basename(filePath).toLowerCase()))],
    preferredIdentifiers: [...preferredIdentifiers],
    identifiers: [...identifiers],
    failureReferences,
    intent: classifyEvidenceIntent(query)
  };
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
    if (signals.mentionedBasenames.includes(path.posix.basename(normalizeRepoPath(file.path)).toLowerCase())) {
      addSignal(file.path, "basename");
    }
  }

  for (const symbol of [...input.symbols].sort((left, right) => left.filePath.localeCompare(right.filePath) || left.name.localeCompare(right.name))) {
    const identity = normalizeIdentity(symbol.name);
    if (!identity) continue;
    if (signals.preferredIdentifiers.includes(identity)) {
      addSignal(symbol.filePath, "exact_symbol");
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

  const initialPaths = selectInitialPaths({
    reasonsByPath,
    legacyByPath,
    filesByPath,
    limit: initialLimit
  });

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
    if (signals.preferredIdentifiers.includes(identity)) reasons.add("exact_symbol");
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

function groupSymbols(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    const filePath = normalizeRepoPath(symbol.filePath);
    grouped.set(filePath, [...(grouped.get(filePath) ?? []), symbol]);
  }
  return grouped;
}

function selectInitialPaths(input: {
  reasonsByPath: Map<string, Set<EvidenceReason>>;
  legacyByPath: Map<string, HybridScoredResult>;
  filesByPath: Map<string, FileRecord>;
  limit: number;
}): string[] {
  const selected: string[] = [];
  const selectedPaths = new Set<string>();
  const add = (filePath: string): void => {
    if (selected.length >= input.limit || selectedPaths.has(filePath)) return;
    selected.push(filePath);
    selectedPaths.add(filePath);
  };
  const candidatesFor = (reason: EvidenceReason): string[] =>
    [...input.reasonsByPath.entries()]
      .filter(([, reasons]) => reasons.has(reason))
      .map(([filePath]) => filePath)
      .sort((left, right) =>
        channelScore(reason, right, input.legacyByPath, input.filesByPath) -
          channelScore(reason, left, input.legacyByPath, input.filesByPath) ||
        left.localeCompare(right)
      );

  // Failure and exact-path references are hard evidence and cannot be crowded
  // out by a high-cardinality basename, lexical, or session channel.
  for (const reason of ["failure_reference", "exact_path"] as const) {
    for (const filePath of candidatesFor(reason)) add(filePath);
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
  return filesByPath.get(filePath)?.importance ?? 0;
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
