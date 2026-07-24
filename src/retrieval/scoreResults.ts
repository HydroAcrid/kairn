// SPDX-License-Identifier: Apache-2.0

import type { FileRecord, ScoredFile, SymbolRecord } from "../types.js";
import { tokenizeLexical } from "../semantic/tokenize.js";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "and",
  "or",
  "in",
  "on",
  "with",
  "add",
  "update",
  "fix",
  "make",
  "build",
  "implement",
  "debug",
  "failing",
  "failure",
  "regression",
  "bug",
  "behavior",
  "source",
  "production"
]);

export function scoreFiles(files: FileRecord[], query: string, symbols: SymbolRecord[] = []): ScoredFile[] {
  const terms = tokenize(query);
  const symbolsByFile = groupSymbolsByFile(symbols);
  const broadTerms = findBroadTerms(files, terms, symbolsByFile);

  return files
    .map((file) => scoreFile(file, terms, broadTerms, symbolsByFile.get(file.path) ?? []))
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Scores full-inventory path tokens independently from file importance.
 * This prevents a file matching several specific task terms from disappearing
 * behind hundreds of important files that match one broad repository term.
 */
export function scorePathTokenCoverage(files: FileRecord[], query: string): ScoredFile[] {
  const queryTerms = [...new Set(tokenize(query).map(normalizePathToken))].slice(0, 64);
  if (queryTerms.length === 0) return [];
  const pathTermsByFile = new Map(
    files.map((file) => [
      file.path,
      [...new Set(tokenizeLexical(file.path).filter((term) => term.length > 2).map(normalizePathToken))]
    ])
  );
  const documentFrequency = new Map(
    queryTerms.map((queryTerm) => [
      queryTerm,
      files.filter((file) =>
        (pathTermsByFile.get(file.path) ?? []).some((pathTerm) => pathTermsMatch(queryTerm, pathTerm))
      ).length
    ])
  );

  return files
    .map((file): ScoredFile | undefined => {
      const pathTerms = pathTermsByFile.get(file.path) ?? [];
      const basenameTerms = new Set(
        tokenizeLexical(file.path.split("/").at(-1) ?? file.path).map(normalizePathToken)
      );
      const matchedTerms = queryTerms.filter((queryTerm) =>
        pathTerms.some((pathTerm) => pathTermsMatch(queryTerm, pathTerm))
      );
      if (matchedTerms.length === 0) return undefined;
      const score = matchedTerms.reduce((total, queryTerm) => {
        const frequency = documentFrequency.get(queryTerm) ?? files.length;
        const inverseFrequency = Math.log2((files.length + 1) / (frequency + 1)) + 1;
        const basenameMatch = [...basenameTerms].some((pathTerm) => pathTermsMatch(queryTerm, pathTerm));
        return total + inverseFrequency * (basenameMatch ? 1.5 : 1);
      }, 0) + matchedTerms.length * 0.5;
      return {
        ...file,
        score,
        reasons: matchedTerms.map((term) => `path token "${term}"`)
      };
    })
    .filter((file): file is ScoredFile => Boolean(file))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
}

function scoreFile(file: FileRecord, terms: string[], broadTerms: Set<string>, symbols: SymbolRecord[]): ScoredFile {
  const pathLower = file.path.toLowerCase();
  const basename = pathLower.split("/").at(-1) ?? pathLower;
  const reasons: string[] = [];
  let score = file.importance;

  for (const term of terms) {
    const broad = broadTerms.has(term);
    if (pathLower.includes(term)) {
      score += broad ? 2 : 8;
      reasons.push(broad ? `broad path term "${term}"` : `path contains "${term}"`);
    }

    if (basename.includes(term)) {
      score += broad ? 1 : 5;
      reasons.push(broad ? `broad filename term "${term}"` : `filename contains "${term}"`);
    }
  }

  for (const symbol of symbols) {
    const symbolTerms = tokenizeSymbol(symbol.name);
    const matched = terms.filter((term) => symbol.name.toLowerCase().includes(term) || symbolTerms.includes(term));
    if (matched.length > 0) {
      const nonBroadMatches = matched.filter((term) => !broadTerms.has(term)).length;
      score += nonBroadMatches > 0 ? 12 + nonBroadMatches * 4 : 3;
      reasons.push(`symbol match: ${symbol.name}`);
    }

    if (symbol.exported && matched.some((term) => !broadTerms.has(term))) {
      score += 3;
      reasons.push(`exported symbol: ${symbol.name}`);
    }
  }

  if (file.kind === "route") {
    score += 2;
    reasons.push("route file");
  }

  if (file.kind === "test" && terms.some((term) => ["test", "spec", "verify"].includes(term))) {
    score += 5;
    reasons.push("test requested");
  }

  if (terms.length === 0) {
    score = file.importance;
    reasons.push("default importance");
  } else if (terms.every((term) => broadTerms.has(term))) {
    score = Math.min(score, file.importance + 10);
  }

  return {
    ...file,
    score,
    reasons
  };
}

function groupSymbolsByFile(symbols: SymbolRecord[]): Map<string, SymbolRecord[]> {
  const grouped = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    grouped.set(symbol.filePath, [...(grouped.get(symbol.filePath) ?? []), symbol]);
  }
  return grouped;
}

function tokenize(query: string): string[] {
  return [...new Set(tokenizeLexical(query).filter((term) => term.length > 2 && !STOPWORDS.has(term)))];
}

function tokenizeSymbol(symbol: string): string[] {
  return tokenizeLexical(symbol).filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function normalizePathToken(value: string): string {
  const term = value.toLowerCase();
  if (term.length <= 4 || term.endsWith("ss")) return term;
  if (term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (/(?:ses|xes|zes|ches|shes)$/.test(term)) return term.slice(0, -2);
  return term.endsWith("s") ? term.slice(0, -1) : term;
}

function pathTermsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  return Math.min(left.length, right.length) >= 5 && (left.startsWith(right) || right.startsWith(left));
}

function findBroadTerms(files: FileRecord[], terms: string[], symbolsByFile: Map<string, SymbolRecord[]>): Set<string> {
  const broadTerms = new Set<string>();
  const threshold = Math.min(18, Math.max(4, Math.ceil(files.length * 0.12)));

  for (const term of terms) {
    const matches = files.filter((file) => {
      const haystack = [
        file.path,
        ...(symbolsByFile.get(file.path) ?? []).map((symbol) => symbol.name)
      ].join(" ").toLowerCase();
      return haystack.includes(term);
    }).length;

    if (matches >= threshold) {
      broadTerms.add(term);
    }
  }

  return broadTerms;
}
