import path from "node:path";
import type { FileRecord, ScoredFile, SymbolRecord } from "../types.js";

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

  return files
    .map((file) => scoreFile(file, terms, symbolsByFile.get(file.path) ?? []))
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function scoreFile(file: FileRecord, terms: string[], symbols: SymbolRecord[]): ScoredFile {
  const pathLower = file.path.toLowerCase();
  const basename = path.basename(pathLower);
  const reasons: string[] = [];
  let score = file.importance;

  for (const term of terms) {
    if (pathLower.includes(term)) {
      score += 8;
      reasons.push(`path contains "${term}"`);
    }

    if (basename.includes(term)) {
      score += 5;
      reasons.push(`filename contains "${term}"`);
    }
  }

  for (const symbol of symbols) {
    const symbolTerms = tokenizeSymbol(symbol.name);
    const matched = terms.filter((term) => symbol.name.toLowerCase().includes(term) || symbolTerms.includes(term));
    if (matched.length > 0) {
      score += 12 + matched.length * 4;
      reasons.push(`symbol match: ${symbol.name}`);
    }

    if (symbol.exported && matched.length > 0) {
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
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function tokenizeSymbol(symbol: string): string[] {
  return symbol
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}
