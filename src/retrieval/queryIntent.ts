import { tokenizeLexical } from "../semantic/tokenize.js";

export type QueryIntentPrimary = "ui" | "backend" | "data" | "auth" | "test" | "workflow" | "infra" | "docs" | "generic";

export type QueryIntent = {
  primary: QueryIntentPrimary;
  confidence: number;
  matchedTerms: string[];
  matchedPhrases?: string[];
};

const INTENT_TERMS: Record<Exclude<QueryIntentPrimary, "generic">, Set<string>> = {
  ui: new Set([
    "mobile",
    "layout",
    "responsive",
    "drawer",
    "sheet",
    "tabs",
    "tab",
    "card",
    "cards",
    "filter",
    "filters",
    "button",
    "modal",
    "nav",
    "navbar",
    "menu",
    "settings",
    "wheel",
    "overlay",
    "hero",
    "screen",
    "component",
    "components",
    "tsx",
    "jsx",
    "page",
    "dashboard",
    "render",
    "css",
    "tailwind",
    "style",
    "styles",
    "editor"
  ]),
  backend: new Set([
    "api",
    "server",
    "route",
    "handler",
    "repository",
    "parser",
    "parse",
    "ingest",
    "sync",
    "worker",
    "queue",
    "retry",
    "metrics",
    "generation",
    "pipeline",
    "orchestration",
    "engine",
    "workflow",
    "adapter",
    "gmail",
    "oauth",
    "token",
    "auth",
    "access",
    "service",
    "endpoint"
  ]),
  data: new Set([
    "database",
    "db",
    "schema",
    "migration",
    "supabase",
    "sql",
    "table",
    "record",
    "repository",
    "storage",
    "query",
    "owner",
    "scoping"
  ]),
  auth: new Set(["auth", "oauth", "login", "session", "token", "permission", "access", "allowed", "owner"]),
  test: new Set(["test", "tests", "spec", "vitest", "jest", "verify"]),
  workflow: new Set([
    "attempt",
    "attempts",
    "queue",
    "review",
    "retry",
    "ignore",
    "ignored",
    "tracker",
    "needs",
    "requeued",
    "source",
    "email",
    "status",
    "manual",
    "correction",
    "sync"
  ]),
  infra: new Set(["build", "deploy", "ci", "vercel", "config", "package", "script", "lint", "typecheck"]),
  docs: new Set(["docs", "readme", "documentation", "markdown", "guide", "plan"])
};

const INTENT_PRIORITY: QueryIntentPrimary[] = ["test", "workflow", "auth", "data", "backend", "ui", "infra", "docs"];

const WORKFLOW_PHRASES = [
  "review queue",
  "sync attempts",
  "sync attempt",
  "add to tracker",
  "sync status",
  "manual correction"
];

const WORKFLOW_STATUS_VALUES = ["needs_review", "needs review", "requeued", "ignored", "sourceEmailId", "source email id"];

export function classifyQueryIntent(query: string): QueryIntent {
  const terms = tokenizeLexical(query);
  const workflow = detectWorkflowIntent(query, terms);
  const scores = new Map<QueryIntentPrimary, string[]>();
  const negatedTestIntent = hasNegatedIntent(query, ["test", "tests", "spec", "specs", "pytest", "vitest", "jest"]);
  const negatedDocsIntent = hasNegatedIntent(query, ["doc", "docs", "documentation", "readme", "example", "examples"]);

  for (const [intent, dictionary] of Object.entries(INTENT_TERMS) as Array<[Exclude<QueryIntentPrimary, "generic">, Set<string>]>) {
    if (intent === "workflow" && workflow.matchedPhrases.length === 0) continue;
    if (intent === "test" && negatedTestIntent) continue;
    if (intent === "docs" && negatedDocsIntent) continue;
    const matched = terms.filter((term) => dictionary.has(term));
    if (matched.length > 0) {
      scores.set(intent, [...new Set(matched)]);
    }
  }

  if (workflow.matchedPhrases.length > 0 && !hasExplicitTestIntent(terms)) {
    return {
      primary: "workflow",
      confidence: Math.min(1, Math.max(workflow.matchedPhrases.length / 3, workflow.matchedTerms.length / 6)),
      matchedTerms: workflow.matchedTerms,
      matchedPhrases: workflow.matchedPhrases
    };
  }

  if (scores.size === 0) {
    return {
      primary: "generic",
      confidence: 0,
      matchedTerms: []
    };
  }

  const [primary, matchedTerms] = [...scores.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return INTENT_PRIORITY.indexOf(a[0]) - INTENT_PRIORITY.indexOf(b[0]);
  })[0]!;

  return {
    primary,
    confidence: Math.min(1, matchedTerms.length / 4),
    matchedTerms,
    ...(primary === "workflow" ? { matchedPhrases: workflow.matchedPhrases } : {})
  };
}

function detectWorkflowIntent(query: string, terms: string[]): { matchedTerms: string[]; matchedPhrases: string[] } {
  const normalized = normalizeForPhraseMatching(query);
  const matchedPhrases = [...WORKFLOW_PHRASES, ...WORKFLOW_STATUS_VALUES].filter((phrase) =>
    normalized.includes(normalizeForPhraseMatching(phrase))
  );
  const hasStatus = WORKFLOW_STATUS_VALUES.some((phrase) => normalized.includes(normalizeForPhraseMatching(phrase)));
  const hasWorkflowPhrase = matchedPhrases.length > 0;
  if (!hasWorkflowPhrase && !hasStatus) return { matchedTerms: [], matchedPhrases: [] };

  const workflowTerms = [...new Set(terms.filter((term) => INTENT_TERMS.workflow.has(term)))];
  return {
    matchedTerms: workflowTerms,
    matchedPhrases
  };
}

function normalizeForPhraseMatching(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExplicitTestIntent(terms: string[], query = ""): boolean {
  if (query && hasNegatedIntent(query, ["test", "tests", "spec", "specs", "pytest", "vitest", "jest"])) return false;
  return terms.some((term) => INTENT_TERMS.test.has(term));
}

function hasNegatedIntent(query: string, targets: string[]): boolean {
  const normalized = normalizeForPhraseMatching(query);
  const targetPattern = targets.map(escapeRegExp).join("|");
  return new RegExp(`\\b(?:do not|dont|don t|never|avoid|without|no)\\b(?:\\s+[a-z0-9]+){0,8}\\s+\\b(?:${targetPattern})\\b`).test(normalized) ||
    new RegExp(`\\b(?:${targetPattern})\\b(?:\\s+[a-z0-9]+){0,6}\\s+\\b(?:unless|except)\\b(?:\\s+[a-z0-9]+){0,8}\\s+\\b(?:fail|fails|failed|failure|named|requested)\\b`).test(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
