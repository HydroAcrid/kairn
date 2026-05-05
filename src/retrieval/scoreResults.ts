import path from "node:path";
import type { FileRecord, ScoredFile } from "../types.js";

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

export function scoreFiles(files: FileRecord[], query: string): ScoredFile[] {
  const terms = tokenize(query);

  return files
    .map((file) => scoreFile(file, terms))
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function scoreFile(file: FileRecord, terms: string[]): ScoredFile {
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

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}
