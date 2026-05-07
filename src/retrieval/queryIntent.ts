import { tokenizeLexical } from "../semantic/tokenize.js";

export type QueryIntentPrimary = "ui" | "backend" | "data" | "auth" | "test" | "infra" | "docs" | "generic";

export type QueryIntent = {
  primary: QueryIntentPrimary;
  confidence: number;
  matchedTerms: string[];
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
    "view",
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
  test: new Set(["test", "tests", "spec", "vitest", "jest", "verify", "failure", "failing"]),
  infra: new Set(["build", "deploy", "ci", "vercel", "config", "package", "script", "lint", "typecheck"]),
  docs: new Set(["docs", "readme", "documentation", "markdown", "guide", "plan"])
};

const INTENT_PRIORITY: QueryIntentPrimary[] = ["test", "auth", "data", "backend", "ui", "infra", "docs"];

export function classifyQueryIntent(query: string): QueryIntent {
  const terms = tokenizeLexical(query);
  const scores = new Map<QueryIntentPrimary, string[]>();

  for (const [intent, dictionary] of Object.entries(INTENT_TERMS) as Array<[Exclude<QueryIntentPrimary, "generic">, Set<string>]>) {
    const matched = terms.filter((term) => dictionary.has(term));
    if (matched.length > 0) {
      scores.set(intent, [...new Set(matched)]);
    }
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
    matchedTerms
  };
}
