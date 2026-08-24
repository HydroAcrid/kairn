// SPDX-License-Identifier: Apache-2.0

import type { FileRecord, RepoGraph, SemanticChunkRecord, SymbolRecord } from "../types.js";
import { readTextFile } from "../retrieval/readSource.js";
import { sha256 } from "../utils/hash.js";
import { estimateTokens } from "../utils/tokens.js";

const MAX_CHUNK_CHARS = 8_000;
const MAX_SUMMARY_LINES = 120;

export function buildSemanticChunks(rootPath: string, graph: RepoGraph): SemanticChunkRecord[] {
  const parsedByFile = new Map(graph.parsedFiles.map((parsed) => [parsed.filePath, parsed]));
  const symbolsByFile = groupSymbolsByFile(graph.symbols);
  const chunks: SemanticChunkRecord[] = [];

  for (const file of graph.files) {
    if (!shouldBuildChunkForFile(file)) {
      continue;
    }

    let content: string;
    try {
      content = readTextFile(rootPath, file.path);
    } catch {
      continue;
    }

    const symbols = symbolsByFile.get(file.path) ?? [];
    chunks.push(chunkForFileSummary(file, content, parsedByFile.get(file.path)?.imports ?? []));
    if (file.indexTier === "tier3" && symbols.length > 0) {
      for (const symbol of symbols) {
        const chunk = chunkForSymbol(file, symbol, content, parsedByFile.get(file.path)?.imports ?? []);
        if (chunk) chunks.push(chunk);
      }
    }
  }

  return chunks.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.id.localeCompare(b.id));
}

function shouldBuildChunkForFile(file: FileRecord): boolean {
  if (!file.indexTier) return true;
  return file.indexTier === "tier1" || file.indexTier === "tier2" || file.indexTier === "tier3" || file.indexTier === "tier4";
}

function chunkForSymbol(
  file: FileRecord,
  symbol: SymbolRecord,
  content: string,
  imports: string[]
): SemanticChunkRecord | undefined {
  const snippet = sliceLines(content, symbol.startLine, symbol.endLine);
  if (!snippet.trim()) return undefined;

  const text = truncateChunkText(
    [
      `file: ${file.path}`,
      `kind: ${file.kind}`,
      `language: ${file.language}`,
      `symbol: ${symbol.name}`,
      `symbol kind: ${symbol.kind}`,
      `exported: ${symbol.exported ? "yes" : "no"}`,
      imports.length > 0 ? `imports: ${imports.join(" ")}` : "imports: none",
      `signature: ${symbol.signature}`,
      "",
      snippet
    ].join("\n")
  );
  const hash = sha256(text);

  return {
    rootPath: file.rootPath,
    id: chunkId(file.path, "symbol", symbol.name, symbol.startLine, hash),
    filePath: file.path,
    kind: "symbol",
    symbol: symbol.name,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    text,
    hash,
    tokenEstimate: estimateTokens(text)
  };
}

function chunkForFileSummary(file: FileRecord, content: string, imports: string[]): SemanticChunkRecord {
  const lines = content.split(/\r?\n/);
  const interestingLines = lines
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_SUMMARY_LINES)
    .join("\n");
  const text = truncateChunkText(
    [
      `file: ${file.path}`,
      `kind: ${file.kind}`,
      `language: ${file.language}`,
      `size: ${file.size}`,
      imports.length > 0 ? `imports: ${imports.join(" ")}` : "imports: none",
      "",
      interestingLines
    ].join("\n")
  );
  const hash = sha256(text);

  return {
    rootPath: file.rootPath,
    id: chunkId(file.path, "file_summary", "", 1, hash),
    filePath: file.path,
    kind: "file_summary",
    text,
    hash,
    tokenEstimate: estimateTokens(text)
  };
}

function groupSymbolsByFile(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    grouped.set(symbol.filePath, [...(grouped.get(symbol.filePath) ?? []), symbol]);
  }
  return grouped;
}

function sliceLines(content: string, startLine: number, endLine: number): string {
  return content.split(/\r?\n/).slice(startLine - 1, endLine).join("\n");
}

function truncateChunkText(text: string): string {
  if (text.length <= MAX_CHUNK_CHARS) return text;
  return `${text.slice(0, MAX_CHUNK_CHARS)}\n[chunk truncated]`;
}

function chunkId(filePath: string, kind: string, symbol: string, startLine: number, hash: string): string {
  return `chunk_${sha256(`${filePath}:${kind}:${symbol}:${startLine}:${hash}`).slice(0, 24)}`;
}
