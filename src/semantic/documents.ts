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

export const SEMANTIC_DOCUMENT_SCHEMA_VERSION = "semantic-documents-v4" as const;
const MAX_DOCUMENT_CHARS = 1_800;
const MAX_FILE_SYMBOLS = 8;
const MAX_DIRECT_IMPORTS = 8;

export function buildSemanticDocuments(input: {
  rootPath: string;
  graph: RepoGraph;
  maxDocuments: number;
}): SemanticDocumentRecord[] {
  const parsedByFile = new Map(input.graph.parsedFiles.map((parsed) => [parsed.filePath, parsed]));
  const symbolsByFile = groupSymbols(input.graph.symbols);
  const fileDocuments: SemanticDocumentRecord[] = [];
  const symbolQueues = new Map<string, SemanticDocumentRecord[]>();

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
      .map((symbol) => buildSymbolDocument(file, parsed, symbol, content))
      .filter((document): document is SemanticDocumentRecord => Boolean(document)));
    if (symbolDocuments.length > 0) symbolQueues.set(file.path, symbolDocuments);
  }

  const selected = [...fileDocuments];
  const symbolBudget = Math.max(0, input.maxDocuments - selected.length);
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
  const declaredSymbols = evenlySampleIncludingEndpoints(symbols, Math.min(MAX_FILE_SYMBOLS, symbols.length))
    .map((symbol) => `${symbol.kind} ${boundedField(symbol.signature || symbol.name, 96)}`);
  const directImports = parsed?.imports.length
    ? evenlySampleIncludingEndpoints(parsed.imports, Math.min(MAX_DIRECT_IMPORTS, parsed.imports.length))
      .map((item) => boundedField(item, 80))
    : [];
  const prefix = [
    `file: ${file.path}`,
    `language: ${file.language}`,
    `role: ${file.kind}`,
    `module: ${path.posix.dirname(file.path)}`,
    boundedList("declared symbols", declaredSymbols, 320),
    boundedList("direct imports", directImports, 320),
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
      .map((item) => boundedField(item, 80))
    : [];
  const prefix = [
    `file: ${file.path}`,
    `language: ${file.language}`,
    `role: ${file.kind}`,
    `module: ${path.posix.dirname(file.path)}`,
    `symbol: ${symbol.name}`,
    `symbol kind: ${symbol.kind}`,
    `signature: ${symbol.signature}`,
    `exported: ${symbol.exported ? "yes" : "no"}`,
    boundedList("direct imports", directImports, 320),
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
  for (const symbol of [...symbols].sort((left, right) =>
    left.filePath.localeCompare(right.filePath) ||
    left.startLine - right.startLine ||
    left.name.localeCompare(right.name)
  )) {
    grouped.set(symbol.filePath, [...(grouped.get(symbol.filePath) ?? []), symbol]);
  }
  return grouped;
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

function truncateDocument(text: string): string {
  return text.length <= MAX_DOCUMENT_CHARS
    ? text
    : `${text.slice(0, MAX_DOCUMENT_CHARS)}\n[semantic document truncated]`;
}

function composeDocument(prefix: string, body: string): string {
  const separator = "\n";
  const bodyBudget = Math.max(1, MAX_DOCUMENT_CHARS - prefix.length - separator.length);
  return truncateDocument(`${prefix}${separator}${representativeSource(body, bodyBudget)}`);
}

function boundedList(label: string, values: string[], maxChars: number): string {
  if (values.length === 0) return `${label}: none`;
  const prefix = `${label}: `;
  const available = Math.max(1, maxChars - prefix.length);
  const joined = values.join("; ");
  return `${prefix}${joined.length <= available ? joined : `${joined.slice(0, available - 1)}…`}`;
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

function uniqueSemanticContent(documents: SemanticDocumentRecord[]): SemanticDocumentRecord[] {
  const byContent = new Map<string, SemanticDocumentRecord>();
  for (const document of documents) {
    const key = `${document.filePath}\0${document.kind}\0${document.hash}`;
    if (!byContent.has(key)) byContent.set(key, document);
  }
  return [...byContent.values()];
}

function allocateSymbolDocuments(
  queues: Map<string, SemanticDocumentRecord[]>,
  budget: number
): SemanticDocumentRecord[] {
  const entries = [...queues.entries()]
    .filter(([, documents]) => documents.length > 0)
    .map(([filePath, documents]) => ({
      filePath,
      documents,
      weight: Math.sqrt(documents.length),
      allocation: 0
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const capacity = entries.reduce((sum, entry) => sum + entry.documents.length, 0);
  let remaining = Math.min(Math.max(0, Math.floor(budget)), capacity);

  while (remaining > 0) {
    let selected: (typeof entries)[number] | undefined;
    let selectedPriority = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      if (entry.allocation >= entry.documents.length) continue;
      const priority = entry.weight / (entry.allocation + 1);
      if (
        priority > selectedPriority ||
        (priority === selectedPriority && entry.filePath.localeCompare(selected?.filePath ?? "") < 0)
      ) {
        selected = entry;
        selectedPriority = priority;
      }
    }
    if (!selected) break;
    selected.allocation += 1;
    remaining -= 1;
  }

  return entries.flatMap((entry) => evenlySample(entry.documents, entry.allocation));
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
