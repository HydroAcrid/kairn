import type {
  FileRecord,
  LexicalDocumentRecord,
  LexicalStatsRecord,
  LexicalTermRecord,
  SemanticChunkRecord,
  SymbolRecord
} from "../types.js";
import { tokenizeLexical } from "../semantic/tokenize.js";
import { sha256 } from "../utils/hash.js";
import { estimateTokens } from "../utils/tokens.js";
import { createBudgetProfile, lexicalIndexBudget } from "../budget/adaptiveBudget.js";

const K1 = 1.4;
const B = 0.72;
const LOW_SIGNAL_QUERY_TERMS = new Set(["debug", "seeded", "failing", "failure", "regression", "production", "source", "check"]);

export type LexicalIndex = {
  documents: LexicalDocumentRecord[];
  terms: LexicalTermRecord[];
  stats: LexicalStatsRecord;
};

export function buildLexicalIndex(input: {
  rootPath: string;
  files: FileRecord[];
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  maxStateMb?: number | undefined;
}): LexicalIndex {
  const documents: LexicalDocumentRecord[] = [];
  const terms: LexicalTermRecord[] = [];

  const symbolsByFile = groupBy(input.symbols, (symbol) => symbol.filePath);
  const chunksByFile = groupBy(input.chunks, (chunk) => chunk.filePath);
  const budget = lexicalIndexBudget(createBudgetProfile({
    fileCount: input.files.length,
    symbolCount: input.symbols.length,
    chunkCount: input.chunks.length,
    maxStateMb: input.maxStateMb
  }));

  for (const file of input.files) {
    const fileSymbols = symbolsByFile.get(file.path) ?? [];
    const fileChunks = (chunksByFile.get(file.path) ?? []).slice(0, budget.chunksPerFileDocument);
    addDocument({
      rootPath: input.rootPath,
      documents,
      terms,
      maxLexicalTerms: budget.maxLexicalTerms,
      id: `file:${file.path}`,
      filePath: file.path,
      kind: "file",
      text: [
        file.path,
        file.kind,
        file.language,
        ...fileSymbols.map((symbol) => `${symbol.name} ${symbol.kind} ${symbol.signature}`),
        ...fileChunks.map((chunk) => `${chunk.symbol ?? ""} ${chunk.text}`).slice(0, 8)
      ].join("\n")
    });
  }

  for (const symbol of input.symbols.slice(0, budget.maxSymbolDocuments)) {
    addDocument({
      rootPath: input.rootPath,
      documents,
      terms,
      maxLexicalTerms: budget.maxLexicalTerms,
      id: `symbol:${symbol.filePath}:${symbol.name}:${symbol.startLine}`,
      filePath: symbol.filePath,
      kind: "symbol",
      symbol: symbol.name,
      text: `${symbol.filePath}\n${symbol.name}\n${symbol.kind}\n${symbol.signature}`
    });
  }

  for (const chunk of input.chunks.slice(0, budget.maxChunkDocuments)) {
    addDocument({
      rootPath: input.rootPath,
      documents,
      terms,
      maxLexicalTerms: budget.maxLexicalTerms,
      id: `chunk:${chunk.id}`,
      filePath: chunk.filePath,
      kind: "chunk",
      ...(chunk.symbol ? { symbol: chunk.symbol } : {}),
      text: `${chunk.filePath}\n${chunk.symbol ?? ""}\n${chunk.text}`
    });
  }

  const averageDocumentLength =
    documents.length > 0
      ? documents.reduce((total, document) => total + document.length, 0) / documents.length
      : 0;

  return {
    documents,
    terms,
    stats: {
      rootPath: input.rootPath,
      documentCount: documents.length,
      averageDocumentLength: Number(averageDocumentLength.toFixed(4))
    }
  };
}

export function scoreBm25Files(input: {
  query: string;
  documents: LexicalDocumentRecord[];
  terms: LexicalTermRecord[];
  stats?: LexicalStatsRecord | undefined;
}): Map<string, { score: number; reasons: string[] }> {
  const queryTerms = [...new Set(tokenizeLexical(input.query).filter((term) => !LOW_SIGNAL_QUERY_TERMS.has(term)))];
  if (queryTerms.length === 0 || input.documents.length === 0 || input.terms.length === 0) return new Map();

  const documentById = new Map(input.documents.map((document) => [document.id, document]));
  const termsByTerm = groupBy(input.terms, (term) => term.term);
  const averageLength = input.stats?.averageDocumentLength || average(input.documents.map((document) => document.length)) || 1;
  const documentCount = input.stats?.documentCount || input.documents.length;
  const fileScores = new Map<string, { score: number; reasons: Set<string>; docScores: number[] }>();

  for (const queryTerm of queryTerms) {
    const termRows = termsByTerm.get(queryTerm) ?? [];
    if (termRows.length === 0) continue;
    const documentFrequency = new Set(termRows.map((row) => row.documentId)).size;
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));

    for (const row of termRows) {
      const document = documentById.get(row.documentId);
      if (!document) continue;
      const tf = row.frequency;
      const normalizedTf = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (document.length / averageLength)));
      const docScore = idf * normalizedTf * weightForDocument(document, queryTerm);
      const current = fileScores.get(row.filePath) ?? { score: 0, reasons: new Set<string>(), docScores: [] };
      current.score += docScore;
      current.docScores.push(docScore);
      if (docScore > 0.2) current.reasons.add(`bm25 exact match: ${queryTerm}`);
      fileScores.set(row.filePath, current);
    }
  }

  const result = new Map<string, { score: number; reasons: string[] }>();
  for (const [filePath, item] of fileScores) {
    const maxDoc = Math.max(...item.docScores, 0);
    const score = maxDoc * 36 + item.score * 8;
    if (score <= 0) continue;
    result.set(filePath, {
      score: Number(score.toFixed(3)),
      reasons: [...item.reasons].slice(0, 5)
    });
  }

  return result;
}

function addDocument(input: {
  rootPath: string;
  documents: LexicalDocumentRecord[];
  terms: LexicalTermRecord[];
  maxLexicalTerms: number;
  id: string;
  filePath: string;
  kind: LexicalDocumentRecord["kind"];
  symbol?: string | undefined;
  text: string;
}): void {
  if (input.terms.length >= input.maxLexicalTerms) return;
  const tokens = tokenizeLexical(input.text);
  if (tokens.length === 0) return;
  const id = uniqueDocumentId({
    preferredId: input.id,
    documents: input.documents,
    text: input.text
  });
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  input.documents.push({
    rootPath: input.rootPath,
    id,
    filePath: input.filePath,
    kind: input.kind,
    ...(input.symbol ? { symbol: input.symbol } : {}),
    length: tokens.length,
    tokenEstimate: estimateTokens(input.text),
    hash: sha256(input.text)
  });

  for (const [term, frequency] of frequencies) {
    if (input.terms.length >= input.maxLexicalTerms) break;
    input.terms.push({
      rootPath: input.rootPath,
      term,
      documentId: id,
      filePath: input.filePath,
      frequency
    });
  }
}

function uniqueDocumentId(input: {
  preferredId: string;
  documents: LexicalDocumentRecord[];
  text: string;
}): string {
  if (!input.documents.some((document) => document.id === input.preferredId)) return input.preferredId;
  const suffix = sha256(input.text).slice(0, 10);
  const withHash = `${input.preferredId}:${suffix}`;
  if (!input.documents.some((document) => document.id === withHash)) return withHash;
  let index = 2;
  while (input.documents.some((document) => document.id === `${withHash}:${index}`)) {
    index += 1;
  }
  return `${withHash}:${index}`;
}

function weightForDocument(document: LexicalDocumentRecord, queryTerm: string): number {
  let weight = document.kind === "symbol" ? 1.45 : document.kind === "chunk" ? 1.2 : 1;
  if (document.symbol && tokenizeLexical(document.symbol).includes(queryTerm)) weight += 0.65;
  if (document.filePath.toLowerCase().includes(queryTerm.toLowerCase())) weight += 0.25;
  return weight;
}

function groupBy<T>(records: T[], keyFor: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const key = keyFor(record);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return grouped;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}
