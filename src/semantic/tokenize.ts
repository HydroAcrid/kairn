// SPDX-License-Identifier: Apache-2.0

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
  "from",
  "into",
  "this",
  "that",
  "true",
  "false",
  "return",
  "const",
  "let",
  "var",
  "function",
  "class",
  "interface",
  "type",
  "export",
  "import"
]);

export function tokenizeLexical(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

export function uniqueTerms(input: string): string[] {
  return [...new Set(tokenizeLexical(input))];
}
