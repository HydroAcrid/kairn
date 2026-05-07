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
  "implement"
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
  return tokenizeLexical(query).filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function tokenizeSymbol(symbol: string): string[] {
  return tokenizeLexical(symbol).filter((term) => term.length > 2 && !STOPWORDS.has(term));
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
