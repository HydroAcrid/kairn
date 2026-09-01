// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import type {
  FileRecord,
  ParsedFile,
  RepoGraph,
  SemanticDocumentRecord,
  SymbolRecord
} from "../types.js";
import { readTextFile } from "../retrieval/readSource.js";
import { sha256 } from "../utils/hash.js";
import { estimateTokens } from "../utils/tokens.js";

export const SEMANTIC_DOCUMENT_SCHEMA_VERSION = "semantic-documents-v8" as const;
// Keep structured metadata plus representative source within a compact CPU
// inference window. The model still receives multiple regions from large
// files, while cold indexing cost remains proportional to useful evidence.
const MAX_DOCUMENT_CHARS = 512;
const MIN_SOURCE_BODY_CHARS = 112;
const MAX_FILE_SYMBOLS = 12;
const MAX_DIRECT_IMPORTS = 4;
const MAX_DOCUMENTATION_SNIPPETS = 3;
const MAX_SYMBOL_DOCUMENTS_PER_FILE = 2;

export function buildSemanticDocuments(input: {
  rootPath: string;
  graph: RepoGraph;
  maxDocuments: number;
}): SemanticDocumentRecord[] {
  const parsedByFile = new Map(input.graph.parsedFiles.map((parsed) => [parsed.filePath, parsed]));
  const symbolsByFile = groupSymbols(input.graph.symbols);
  const fileDocuments: SemanticDocumentRecord[] = [];
  const symbolQueues = new Map<string, SemanticSymbolDocumentCandidate[]>();

  for (const file of stableEligibleFiles(input.graph.files)) {
    let content: string;
    try {
      content = readTextFile(input.rootPath, file.path);
    } catch {
      continue;
    }
    const parsed = parsedByFile.get(file.path);
    const symbols = symbolsByFile.get(file.path) ?? [];
    fileDocuments.push(buildFileDocument(file, parsed, symbols, content));
    const symbolDocuments = uniqueSemanticContent(symbols
      .map((symbol) => {
        const document = buildSymbolDocument(file, parsed, symbol, content);
        return document
          ? {
              document,
              spanLines: Math.max(1, symbol.endLine - symbol.startLine + 1),
              outer: isOuterBehavioralSymbol(symbol, symbols)
            }
          : undefined;
      })
      .filter((candidate): candidate is SemanticSymbolDocumentCandidate => Boolean(candidate)));
    if (symbolDocuments.length > 0) symbolQueues.set(file.path, symbolDocuments);
  }

  const selected = [...fileDocuments];
  // Source and test file-level coverage is mandatory. Tests often contain the
  // behavioral vocabulary that links a natural-language failure to its
  // production implementation through precise parser-observed call/test
  // edges. Use the remaining bounded budget to represent one behavioral body
  // from as many files as possible
  // before spending a second slot anywhere. The previous symbol-count-
  // weighted policy repeatedly enriched complex files while leaving ordinary
  // implementation files with only a very small file-level synopsis.
  const remainingDocumentBudget = Math.max(0, input.maxDocuments - selected.length);
  const symbolBudget = Math.min(
    remainingDocumentBudget,
    selected.length * MAX_SYMBOL_DOCUMENTS_PER_FILE
  );
  if (symbolBudget > 0) {
    selected.push(...allocateSymbolDocuments(symbolQueues, symbolBudget));
  }

  return uniqueDocuments(selected).sort((left, right) =>
    left.filePath.localeCompare(right.filePath) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

function buildFileDocument(
  file: FileRecord,
  parsed: ParsedFile | undefined,
  symbols: SymbolRecord[],
  content: string
): SemanticDocumentRecord {
  const behavioralSymbols = semanticBehaviorSymbols(symbols);
  const declaredSymbols = evenlySampleIncludingEndpoints(
    behavioralSymbols,
    Math.min(MAX_FILE_SYMBOLS, behavioralSymbols.length)
  ).map((symbol) => symbol.name);
  const documentation = extractLeadingDocumentation(content, behavioralSymbols);
  const directImports = parsed?.imports.length
    ? evenlySampleIncludingEndpoints(parsed.imports, Math.min(MAX_DIRECT_IMPORTS, parsed.imports.length))
      .map((item) => boundedField(item, 48))
    : [];
  const prefix = [
    `file: ${boundedField(file.path, 96)}`,
    `language: ${file.language}`,
    `role: ${file.kind}`,
    `module: ${boundedField(path.posix.dirname(file.path), 56)}`,
    boundedWholeItemList("declared symbols", declaredSymbols, 140),
    ...(documentation.length > 0
      ? [boundedList("documentation", documentation, 120)]
      : []),
    boundedWholeItemList("direct imports", directImports, 80),
    "",
    "representative source:"
  ].join("\n");
  const text = composeDocument(prefix, content);
  return semanticDocument({
    rootPath: file.rootPath,
    filePath: file.path,
    kind: "file",
    identity: `${file.path}\0file`,
    text
  });
}

function buildSymbolDocument(
  file: FileRecord,
  parsed: ParsedFile | undefined,
  symbol: SymbolRecord,
  content: string
): SemanticDocumentRecord | undefined {
  const body = sliceLines(content, symbol.startLine, symbol.endLine);
  if (!body.trim()) return undefined;
  const directImports = parsed?.imports.length
    ? evenlySampleIncludingEndpoints(parsed.imports, Math.min(MAX_DIRECT_IMPORTS, parsed.imports.length))
      .map((item) => boundedField(item, 48))
    : [];
  const prefix = [
    `file: ${boundedField(file.path, 160)}`,
    `language: ${file.language}`,
    `role: ${file.kind}`,
    `module: ${boundedField(path.posix.dirname(file.path), 80)}`,
    `symbol: ${symbol.name}`,
    `symbol kind: ${symbol.kind}`,
    `signature: ${boundedField(symbol.signature, 140)}`,
    `exported: ${symbol.exported ? "yes" : "no"}`,
    boundedList("direct imports", directImports, 140),
    ""
  ].join("\n");
  const text = composeDocument(prefix, body);
  return semanticDocument({
    rootPath: file.rootPath,
    filePath: file.path,
    kind: "symbol",
    symbol: symbol.name,
    identity: [
      file.path,
      "symbol",
      symbol.kind,
      symbol.name,
      symbol.signature,
      symbol.startLine,
      symbol.endLine
    ].join("\0"),
    text
  });
}

function semanticDocument(input: {
  rootPath: string;
  filePath: string;
  kind: "file" | "symbol";
  symbol?: string;
  identity: string;
  text: string;
}): SemanticDocumentRecord {
  return {
    rootPath: input.rootPath,
    id: `sdoc_${sha256(input.identity).slice(0, 24)}`,
    filePath: input.filePath,
    kind: input.kind,
    ...(input.symbol ? { symbol: input.symbol } : {}),
    text: input.text,
    hash: sha256(`${SEMANTIC_DOCUMENT_SCHEMA_VERSION}\0${input.text}`),
    tokenEstimate: estimateTokens(input.text),
    schemaVersion: SEMANTIC_DOCUMENT_SCHEMA_VERSION
  };
}

function stableEligibleFiles(files: FileRecord[]): FileRecord[] {
  return files
    .filter((file) =>
      file.indexTier !== "tier0" &&
      ["source", "test", "route", "component", "schema", "config"].includes(file.kind)
    )
    .sort((left, right) => left.path.localeCompare(right.path));
}

function groupSymbols(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const symbol of behaviorSymbols(symbols).sort((left, right) =>
    left.filePath.localeCompare(right.filePath) ||
    left.startLine - right.startLine ||
    left.name.localeCompare(right.name)
  )) {
    grouped.set(symbol.filePath, [...(grouped.get(symbol.filePath) ?? []), symbol]);
  }
  return grouped;
}

function semanticBehaviorSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  const behavioral = behaviorSymbols(symbols);
  return behavioral.filter((symbol) => isOuterBehavioralSymbol(symbol, behavioral));
}

function behaviorSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  return symbols.filter((symbol) =>
    symbol.exported ||
    ["function", "class", "interface", "type", "component", "default"].includes(symbol.kind)
  );
}

function isOuterBehavioralSymbol(symbol: SymbolRecord, symbols: SymbolRecord[]): boolean {
  return symbol.exported || !symbols.some((parent) =>
      parent !== symbol &&
      parent.filePath === symbol.filePath &&
      parent.startLine <= symbol.startLine &&
      parent.endLine >= symbol.endLine &&
      (
        parent.startLine < symbol.startLine ||
        parent.endLine > symbol.endLine
      )
    );
}

function representativeSource(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const sectionCount = 5;
  const separator = "\n[…]\n";
  const available = maxChars - separator.length * (sectionCount - 1);
  const sectionSize = Math.max(1, Math.floor(available / sectionCount));
  const finalStart = content.length - sectionSize;
  return Array.from({ length: sectionCount }, (_, index) => {
    const start = Math.floor((finalStart * index) / (sectionCount - 1));
    return content.slice(start, start + sectionSize);
  }).join(separator);
}

function sliceLines(content: string, startLine: number, endLine: number): string {
  return content.split(/\r?\n/).slice(Math.max(0, startLine - 1), Math.max(startLine, endLine)).join("\n");
}

function extractLeadingDocumentation(content: string, symbols: SymbolRecord[]): string[] {
  const lines = content.split(/\r?\n/);
  const snippets = symbols
    .slice()
    .sort((left, right) => left.startLine - right.startLine || left.name.localeCompare(right.name))
    .map((symbol) => leadingDocumentationForLine(lines, symbol.startLine))
    .filter((snippet): snippet is string => Boolean(snippet));
  const unique = [...new Set(snippets)];
  return evenlySampleIncludingEndpoints(
    unique,
    Math.min(MAX_DOCUMENTATION_SNIPPETS, unique.length)
  );
}

function leadingDocumentationForLine(lines: string[], startLine: number): string | undefined {
  if (lines.length === 0 || startLine <= 1 || startLine > lines.length) return undefined;
  let cursor = startLine - 2;
  while (cursor >= 0 && isDeclarationAnnotation(lines[cursor]!)) cursor -= 1;
  if (cursor < 0 || !lines[cursor]!.trim()) return undefined;

  const lastLine = lines[cursor]!.trim();
  if (lastLine.startsWith("//") || lastLine.startsWith("#")) {
    const marker = lastLine.startsWith("//") ? "//" : "#";
    const collected: string[] = [];
    while (cursor >= 0 && lines[cursor]!.trim().startsWith(marker)) {
      collected.unshift(stripLineComment(lines[cursor]!.trim(), marker));
      cursor -= 1;
    }
    return normalizeDocumentation(collected.join(" "));
  }

  if (!lastLine.endsWith("*/")) return undefined;
  const collected: string[] = [];
  while (cursor >= 0) {
    const line = lines[cursor]!.trim();
    collected.unshift(line);
    cursor -= 1;
    if (line.startsWith("/*")) break;
  }
  if (!collected[0]?.startsWith("/*")) return undefined;
  return normalizeDocumentation(
    collected
      .join(" ")
      .replace(/^\/\*+\s*/, "")
      .replace(/\s*\*\/$/, "")
      .replace(/\s*\*\s*/g, " ")
  );
}

function isDeclarationAnnotation(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("@") || trimmed.startsWith("#[");
}

function stripLineComment(line: string, marker: string): string {
  return line.slice(marker.length).trim();
}

function normalizeDocumentation(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function truncateDocument(text: string): string {
  return text.length <= MAX_DOCUMENT_CHARS
    ? text
    : `${text.slice(0, MAX_DOCUMENT_CHARS)}\n[semantic document truncated]`;
}

function composeDocument(prefix: string, body: string): string {
  const separator = "\n";
  const prefixBudget = Math.max(
    1,
    MAX_DOCUMENT_CHARS - MIN_SOURCE_BODY_CHARS - separator.length
  );
  const boundedPrefix = prefix.length <= prefixBudget
    ? prefix
    : prefix.slice(0, prefixBudget).trimEnd();
  const bodyBudget = Math.max(
    MIN_SOURCE_BODY_CHARS,
    MAX_DOCUMENT_CHARS - boundedPrefix.length - separator.length
  );
  return truncateDocument(
    `${boundedPrefix}${separator}${representativeSource(body, bodyBudget)}`
  );
}

function boundedList(label: string, values: string[], maxChars: number): string {
  if (values.length === 0) return `${label}: none`;
  const prefix = `${label}: `;
  const available = Math.max(1, maxChars - prefix.length);
  const separator = "; ";
  const perItem = Math.max(
    1,
    Math.floor((available - separator.length * (values.length - 1)) / values.length)
  );
  return `${prefix}${values.map((value) => boundedField(value, perItem)).join(separator)}`;
}

function boundedWholeItemList(label: string, values: string[], maxChars: number): string {
  if (values.length === 0) return `${label}: none`;
  const prefix = `${label}: `;
  const available = Math.max(1, maxChars - prefix.length);
  for (let count = values.length; count >= 1; count -= 1) {
    const selected = evenlySampleIncludingEndpoints(values, count)
      .map((value) => boundedField(value, 48));
    const rendered = selected.join("; ");
    if (rendered.length <= available) return `${prefix}${rendered}`;
  }
  return `${prefix}${boundedField(values[0]!, available)}`;
}

function boundedField(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function uniqueDocuments(documents: SemanticDocumentRecord[]): SemanticDocumentRecord[] {
  const byId = new Map<string, SemanticDocumentRecord>();
  for (const document of documents) {
    const existing = byId.get(document.id);
    if (!existing) {
      byId.set(document.id, document);
      continue;
    }
    if (
      existing.filePath !== document.filePath ||
      existing.kind !== document.kind ||
      existing.hash !== document.hash
    ) {
      throw new Error(`Semantic document identity collision for ${document.id}.`);
    }
  }
  return [...byId.values()];
}

type SemanticSymbolDocumentCandidate = {
  document: SemanticDocumentRecord;
  spanLines: number;
  outer: boolean;
};

function uniqueSemanticContent(
  candidates: SemanticSymbolDocumentCandidate[]
): SemanticSymbolDocumentCandidate[] {
  const byContent = new Map<string, SemanticSymbolDocumentCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.document.filePath,
      candidate.document.kind,
      candidate.document.hash
    ].join("\0");
    if (!byContent.has(key)) byContent.set(key, candidate);
  }
  return [...byContent.values()];
}

function allocateSymbolDocuments(
  queues: Map<string, SemanticSymbolDocumentCandidate[]>,
  budget: number
): SemanticDocumentRecord[] {
  const entries = [...queues.entries()]
    .filter(([, documents]) => documents.length > 0)
    .map(([filePath, documents]) => ({
      filePath,
      documents
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  let remaining = Math.min(
    Math.max(0, Math.floor(budget)),
    entries.reduce(
      (sum, entry) => sum + Math.min(MAX_SYMBOL_DOCUMENTS_PER_FILE, entry.documents.length),
      0
    )
  );
  const allocations = new Map(entries.map((entry) => [entry.filePath, 0]));

  // Maximize repository coverage first. When the configured global cap cannot
  // fit every file, sample the stable path-ordered inventory rather than
  // favoring filenames or repositories with more declarations.
  for (let depth = 1; depth <= MAX_SYMBOL_DOCUMENTS_PER_FILE && remaining > 0; depth += 1) {
    const eligible = entries.filter((entry) => entry.documents.length >= depth);
    const selected = evenlySampleIncludingEndpoints(eligible, Math.min(remaining, eligible.length));
    for (const entry of selected) {
      allocations.set(entry.filePath, (allocations.get(entry.filePath) ?? 0) + 1);
    }
    remaining -= selected.length;
  }

  return entries.flatMap((entry) =>
    selectBehavioralSymbolDocuments(entry.documents, allocations.get(entry.filePath) ?? 0)
      .map((candidate) => candidate.document)
  );
}

function selectBehavioralSymbolDocuments(
  candidates: SemanticSymbolDocumentCandidate[],
  count: number
): SemanticSymbolDocumentCandidate[] {
  if (count <= 0) return [];
  if (count >= candidates.length) return [...candidates];
  const orderedOuter = candidates
    .filter((candidate) => candidate.outer)
    .sort((left, right) =>
      right.spanLines - left.spanLines ||
      (left.document.symbol ?? "").localeCompare(right.document.symbol ?? "") ||
      left.document.id.localeCompare(right.document.id)
    );
  const selected = orderedOuter.slice(0, count);
  if (selected.length >= count) return selected;
  const selectedIds = new Set(selected.map((candidate) => candidate.document.id));
  const nested = candidates
    .filter((candidate) => !candidate.outer && !selectedIds.has(candidate.document.id))
    .sort((left, right) =>
      right.spanLines - left.spanLines ||
      (left.document.symbol ?? "").localeCompare(right.document.symbol ?? "") ||
      left.document.id.localeCompare(right.document.id)
    );
  return [...selected, ...nested.slice(0, count - selected.length)];
}

function evenlySample<T>(values: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= values.length) return [...values];
  const sampled: T[] = [];
  for (let index = 0; index < count; index += 1) {
    sampled.push(values[Math.floor(((index + 0.5) * values.length) / count)]!);
  }
  return sampled;
}

function evenlySampleIncludingEndpoints<T>(values: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= values.length) return [...values];
  if (count === 1) return [values[0]!];
  return Array.from({ length: count }, (_, index) =>
    values[Math.round((index * (values.length - 1)) / (count - 1))]!
  );
}
