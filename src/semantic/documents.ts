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

export const SEMANTIC_DOCUMENT_SCHEMA_VERSION = "semantic-documents-v2" as const;
const MAX_FILE_BODY_CHARS = 440;
const MAX_SYMBOL_BODY_CHARS = 500;
const MAX_DOCUMENT_CHARS = 768;
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
    const symbolDocuments = symbols
      .map((symbol) => buildSymbolDocument(file, parsed, symbol, content))
      .filter((document): document is SemanticDocumentRecord => Boolean(document));
    if (symbolDocuments.length > 0) symbolQueues.set(file.path, symbolDocuments);
  }

  const selected = [...fileDocuments];
  const symbolBudget = Math.max(0, input.maxDocuments - selected.length);
  if (symbolBudget > 0) {
    const paths = [...symbolQueues.keys()].sort();
    const cursors = new Map(paths.map((filePath) => [filePath, 0]));
    let progressed = true;
    while (selected.length < fileDocuments.length + symbolBudget && progressed) {
      progressed = false;
      for (const filePath of paths) {
        const cursor = cursors.get(filePath) ?? 0;
        const document = symbolQueues.get(filePath)?.[cursor];
        if (!document) continue;
        selected.push(document);
        cursors.set(filePath, cursor + 1);
        progressed = true;
        if (selected.length >= fileDocuments.length + symbolBudget) break;
      }
    }
  }

  return selected.sort((left, right) =>
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
  const exportedSymbols = symbols
    .filter((symbol) => symbol.exported)
    .slice(0, MAX_FILE_SYMBOLS)
    .map((symbol) => `${symbol.kind} ${boundedField(symbol.signature || symbol.name, 96)}`);
  const text = truncateDocument([
    `file: ${file.path}`,
    `language: ${file.language}`,
    `role: ${file.kind}`,
    `module: ${path.posix.dirname(file.path)}`,
    parsed?.imports.length
      ? `direct imports: ${parsed.imports.slice(0, MAX_DIRECT_IMPORTS).map((item) => boundedField(item, 80)).join(" ")}`
      : "direct imports: none",
    exportedSymbols.length ? `exported symbols: ${exportedSymbols.join("; ")}` : "exported symbols: none",
    "",
    "representative source:",
    representativeSource(content, MAX_FILE_BODY_CHARS)
  ].join("\n"));
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
  const body = sliceLines(content, symbol.startLine, symbol.endLine).slice(0, MAX_SYMBOL_BODY_CHARS);
  if (!body.trim()) return undefined;
  const text = truncateDocument([
    `file: ${file.path}`,
    `language: ${file.language}`,
    `role: ${file.kind}`,
    `module: ${path.posix.dirname(file.path)}`,
    `symbol: ${symbol.name}`,
    `symbol kind: ${symbol.kind}`,
    `signature: ${symbol.signature}`,
    `exported: ${symbol.exported ? "yes" : "no"}`,
    parsed?.imports.length
      ? `direct imports: ${parsed.imports.slice(0, MAX_DIRECT_IMPORTS).map((item) => boundedField(item, 80)).join(" ")}`
      : "direct imports: none",
    "",
    body
  ].join("\n"));
  return semanticDocument({
    rootPath: file.rootPath,
    filePath: file.path,
    kind: "symbol",
    symbol: symbol.name,
    identity: `${file.path}\0symbol\0${symbol.name}\0${symbol.startLine}`,
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
  const sectionSize = Math.floor(maxChars / 3);
  const middleStart = Math.max(0, Math.floor(content.length / 2) - Math.floor(sectionSize / 2));
  return [
    content.slice(0, sectionSize),
    "[middle of file]",
    content.slice(middleStart, middleStart + sectionSize),
    "[end of file]",
    content.slice(-sectionSize)
  ].join("\n");
}

function sliceLines(content: string, startLine: number, endLine: number): string {
  return content.split(/\r?\n/).slice(Math.max(0, startLine - 1), Math.max(startLine, endLine)).join("\n");
}

function truncateDocument(text: string): string {
  return text.length <= MAX_DOCUMENT_CHARS
    ? text
    : `${text.slice(0, MAX_DOCUMENT_CHARS)}\n[semantic document truncated]`;
}

function boundedField(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
