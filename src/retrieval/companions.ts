import type { FileRecord, GraphEdgeRecord, HybridScoredResult, SemanticChunkRecord, SymbolRecord } from "../types.js";
import { tokenizeLexical } from "../semantic/tokenize.js";

export type CompanionCandidate = {
  file: FileRecord;
  score: number;
  reasons: string[];
};

type CompanionRole = {
  id: string;
  terms: string[];
  reason: string;
};

const ROLE_GROUPS: CompanionRole[] = [
  {
    id: "routing-dependency",
    terms: ["router", "routing", "route", "routes", "dependency", "dependencies", "depends", "resolver", "resolvers", "resolve"],
    reason: "routing/dependency pair"
  },
  {
    id: "controller-repository-model",
    terms: ["controller", "controllers", "repository", "repositories", "model", "models", "schema", "service", "services"],
    reason: "controller/repository/model pair"
  },
  {
    id: "scheduler-renderer",
    terms: ["scheduler", "schedule", "renderer", "render", "queue", "flush", "callback"],
    reason: "scheduler/renderer pair"
  },
  {
    id: "interceptor-dispatch-adapter",
    terms: ["interceptor", "interceptors", "dispatch", "dispatcher", "adapter", "adapters", "request", "response", "proxy"],
    reason: "interceptor/dispatch/adapter pair"
  },
  {
    id: "validation-callback",
    terms: ["validation", "validations", "validator", "callbacks", "callback", "associated"],
    reason: "validation/callback pair"
  },
  {
    id: "group-context-handler",
    terms: ["group", "routergroup", "context", "ctx", "handler", "handlers", "middleware", "route", "routing", "engine", "mux", "router", "chain", "mount"],
    reason: "group/context/handler pair"
  },
  {
    id: "normalization-case",
    terms: ["filename", "file", "path", "normalize", "normalization", "case", "sensitivity", "extension", "extensions"],
    reason: "normalization/case pair"
  },
  {
    id: "fixture-context",
    terms: ["fixture", "fixtures", "scope", "parametrize", "parametrized", "python", "request"],
    reason: "same fixture surface"
  }
];

const COMPANION_STOP_TERMS = new Set([
  "debug",
  "fix",
  "seeded",
  "regression",
  "bug",
  "failure",
  "failing",
  "implementation",
  "source",
  "production",
  "behavior",
  "issue",
  "task",
  "file",
  "files",
  "test",
  "tests",
  "spec",
  "should",
  "must",
  "when",
  "with",
  "from",
  "into",
  "that",
  "this"
]);

export function findCompanionCandidates(input: {
  files: FileRecord[];
  ranked: HybridScoredResult[];
  query: string;
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  edges: GraphEdgeRecord[];
  limit?: number;
}): CompanionCandidate[] {
  const limit = input.limit ?? 2;
  if (limit <= 0 || input.ranked.length === 0) return [];

  const queryTerms = termSet(input.query);
  const roleSignals = detectRoleSignals(queryTerms, input.query);
  if (roleSignals.length === 0 && !hasMultiSurfaceQuerySignal(queryTerms)) return [];

  const symbolsByFile = groupByFile(input.symbols, (symbol) => symbol.filePath);
  const chunksByFile = groupByFile(input.chunks, (chunk) => chunk.filePath);
  const filesByPath = new Map(input.files.map((file) => [file.path, file]));
  const seedFiles = input.ranked
    .filter((file) => isCompanionSeed(file))
    .slice(0, 1);
  if (seedFiles.length === 0) return [];

  const seedPaths = new Set(seedFiles.map((file) => file.path));
  const edgeNeighbors = buildEdgeNeighborMap(input.edges);
  const candidates: CompanionCandidate[] = [];

  for (const file of input.files) {
    if (seedPaths.has(file.path) || isNoisyCompanionFile(file) || isLikelyTestPath(file.path)) continue;

    const sourceScore = scoreSourceRoleHints(file, input.query, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const roleMatches = matchRoleSignals(file, roleSignals, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const sourceText = searchableText(file, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const sourceTerms = termSet(sourceText);
    const pathTerms = termSet(file.path);
    const specificQueryHits = [...queryTerms].filter((term) => !COMPANION_STOP_TERMS.has(term) && sourceTerms.has(term));
    const rolePathMatches = roleSignals.filter((role) => role.terms.some((term) => pathTerms.has(canonicalTerm(term))));
    const pathQueryHits = [...queryTerms].filter((term) => !COMPANION_STOP_TERMS.has(term) && pathTerms.has(term));

    let score = sourceScore.score;
    const reasons = [...sourceScore.reasons];

    if (specificQueryHits.length > 0) {
      score += Math.min(56, specificQueryHits.length * 14);
      reasons.push(`specific task term match: ${specificQueryHits.slice(0, 4).join(", ")}`);
    }
    if (pathQueryHits.length > 0) {
      score += Math.min(360, pathQueryHits.length * 120);
      reasons.push(`specific path term match: ${pathQueryHits.slice(0, 4).join(", ")}`);
    }

    for (const role of roleMatches) {
      score += 44;
      reasons.push(role.reason);
    }
    if (rolePathMatches.length > 0) {
      score += rolePathMatches.length * 220;
      reasons.push(...rolePathMatches.map((role) => `role path match: ${role.reason}`));
    }
    if (isDownstreamAdapterForCoreFlow(file.path, queryTerms)) {
      score -= 520;
      reasons.push("downstream adapter companion downranked");
    }
    if (isFrameworkHelperForCoreFlow(file.path, queryTerms)) {
      score -= 420;
      reasons.push("framework helper downranked for core flow prompt");
    }
    if (isRequestFlowCoordinator(sourceTerms, queryTerms)) {
      score += 520;
      reasons.push("request flow coordinator");
    }
    if (isSupportConfigForCoreFlow(file.path, queryTerms)) {
      score -= 360;
      reasons.push("support config downranked for core flow prompt");
    }
    if (isCaseSensitivityAnchor(file.path, queryTerms)) {
      score += 620;
      reasons.push("case-sensitivity anchor");
    }
    if (isDownstreamComparatorOrFilter(file.path, queryTerms)) {
      score -= 260;
      reasons.push("downstream comparator/filter downranked for core path prompt");
    }

    for (const seed of seedFiles) {
      const seedRoles = matchRoleSignals(seed, roleSignals, symbolsByFile.get(seed.path) ?? [], chunksByFile.get(seed.path) ?? []);
      if (roleMatches.length > 0 && seedRoles.length > 0 && samePackageSurface(seed.path, file.path)) {
        score += 54;
        reasons.push("same package");
      } else if (sameModuleSurface(seed.path, file.path)) {
        score += 28;
        reasons.push("same module surface");
      }

      if (edgeNeighbors.get(seed.path)?.has(file.path)) {
        score += 60;
        reasons.push("import neighbor");
      }
      if (sameRoleCategory(seed.path, file.path)) {
        score -= 120;
        reasons.push("same role duplicate downranked");
      }
      if (isPlatformVariantPath(file.path)) {
        score -= 360;
        reasons.push("platform-specific variant downranked");
      }
      if (isGoMiddlewareForRouterCore(file.path, queryTerms)) {
        score -= 900;
        reasons.push("go middleware helper downranked for router core prompt");
      }
      if (isGoPackageAnchor(seed, file, roleSignals)) {
        score += 240;
        reasons.push("go package anchor");
      }
    }

    if (score >= 55 && reasons.length > 0) {
      candidates.push({
        file: filesByPath.get(file.path) ?? file,
        score: Math.round(score),
        reasons: uniqueReasons(reasons).slice(0, 6)
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    .slice(0, limit);
}

export function applyCompanionCandidatesToResults(
  ranked: HybridScoredResult[],
  companions: CompanionCandidate[]
): HybridScoredResult[] {
  if (ranked.length === 0 || companions.length === 0) return ranked;
  const byPath = new Map(ranked.map((file) => [file.path, file]));
  const companionPaths = new Set(companions.map((candidate) => candidate.file.path));
  const companionResults = companions.map((candidate) => {
    const existing = byPath.get(candidate.file.path);
    if (existing) {
      return {
        ...existing,
        score: existing.score,
        behaviorScore: existing.behaviorScore + candidate.score,
        reasons: uniqueReasons([...existing.reasons, ...candidate.reasons.map((reason) => `companion: ${reason}`)])
      };
    }
    return {
      ...candidate.file,
      score: Math.max(1, candidate.score),
      reasons: candidate.reasons.map((reason) => `companion: ${reason}`),
      semanticScore: 0,
      keywordScore: 0,
      bm25Score: 0,
      behaviorScore: candidate.score,
      graphScore: 0,
      intentScore: 0,
      sessionScore: 0,
      importanceScore: candidate.file.importance,
      gitScore: 0,
      chunks: []
    } satisfies HybridScoredResult;
  });

  const rest = ranked.slice(1).filter((file) => !companionPaths.has(file.path));
  const sourceRest = rest.filter((file) => !isLikelyTestPath(file.path) && !isNoisySourcePath(file.path));
  const noisyRest = rest.filter((file) => isLikelyTestPath(file.path) || isNoisySourcePath(file.path));
  return uniqueResults([ranked[0]!, ...companionResults, ...sourceRest, ...noisyRest]);
}

export function scoreSourceRoleHints(
  file: FileRecord,
  query: string,
  symbols: SymbolRecord[],
  chunks: SemanticChunkRecord[]
): { score: number; reasons: string[] } {
  const queryTerms = termSet(query);
  const roleSignals = detectRoleSignals(queryTerms, query);
  if (roleSignals.length === 0) return { score: 0, reasons: [] };

  if (file.kind === "doc" || isNoisySourcePath(file.path) || isLikelyTestPath(file.path)) {
    return { score: -140, reasons: ["role noise downranked"] };
  }
  if (!isUniversalSourceFile(file)) {
    return { score: -60, reasons: ["non-source role downranked"] };
  }

  const matches = matchRoleSignals(file, roleSignals, symbols, chunks);
  const pathTerms = termSet(file.path);
  const pathMatches = roleSignals.filter((role) => role.terms.some((term) => pathTerms.has(canonicalTerm(term))));
  if (matches.length === 0 && pathMatches.length === 0) return { score: 0, reasons: [] };

  const isSource = isUniversalSourceFile(file);
  const score = matches.length * (isSource ? 42 : 18) + pathMatches.length * 120 + (isPrimaryUniversalSourcePath(file) ? 26 : 0);
  return {
    score,
    reasons: uniqueReasons([
      ...matches.map((match) => `role match: ${match.reason}`),
      ...pathMatches.map((match) => `role path match: ${match.reason}`)
    ])
  };
}

export function isNoisySourcePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return /(^|\/)(docs?|docs_src|documentation|_?examples|demo|demos|devtools|codemods|fixtures|fixture|generated|dist|build|coverage|website|site|playground|storybook|testing|testdata|integration)\//.test(
    normalized
  );
}

export function isLikelyTestPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(basename) ||
    normalized.includes("__tests__/") ||
    /^test_.*\.pyi?$/.test(basename) ||
    /_test\.pyi?$/.test(basename) ||
    /(^|\/)tests?\//.test(normalized) ||
    /_test\.go$/.test(basename) ||
    /^test.*\.go$/.test(basename) ||
    /(_test|_spec)\.rb$/.test(basename) ||
    /(test|tests)\.java$/.test(basename) ||
    /(_test|_tests|_unittest)\.(cc|cpp|cxx|c|hh|hpp|hxx)$/.test(basename)
  );
}

function detectRoleSignals(queryTerms: Set<string>, query: string): CompanionRole[] {
  const normalized = normalizeText(query);
  return ROLE_GROUPS.filter((role) =>
    role.terms.some((term) => queryTerms.has(term) || normalized.includes(normalizeText(term)))
  );
}

function hasMultiSurfaceQuerySignal(queryTerms: Set<string>): boolean {
  const signals = ["integration", "flow", "framework", "pipeline", "request", "response", "callback", "handler", "middleware", "routing"];
  return signals.filter((term) => queryTerms.has(term)).length >= 2;
}

function matchRoleSignals(
  file: Pick<FileRecord, "path" | "kind" | "language">,
  roles: CompanionRole[],
  symbols: SymbolRecord[],
  chunks: SemanticChunkRecord[]
): CompanionRole[] {
  const text = normalizeText(searchableText(file, symbols, chunks));
  const terms = termSet(text);
  return roles.filter((role) =>
    role.terms.some((term) => terms.has(canonicalTerm(term)) || text.includes(normalizeText(term)))
  );
}

function searchableText(
  file: Pick<FileRecord, "path" | "kind" | "language">,
  symbols: SymbolRecord[],
  chunks: SemanticChunkRecord[]
): string {
  return [
    file.path,
    file.kind,
    file.language,
    ...symbols.map((symbol) => symbol.name),
    ...chunks.map((chunk) => `${chunk.symbol ?? ""} ${chunk.text.slice(0, 800)}`)
  ].join(" ");
}

function isCompanionSeed(file: FileRecord): boolean {
  return isUniversalSourceFile(file) && !isNoisyCompanionFile(file) && !isLikelyTestPath(file.path);
}

function isNoisyCompanionFile(file: FileRecord): boolean {
  return file.kind === "doc" || isNoisySourcePath(file.path);
}

function isUniversalSourceFile(file: Pick<FileRecord, "path" | "kind" | "language">): boolean {
  if (["source", "component", "route"].includes(file.kind)) return true;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|c|cc|cpp|cxx|h|hh|hpp|hxx|go|rb)$/.test(file.path.toLowerCase());
}

function isPrimaryUniversalSourcePath(file: Pick<FileRecord, "path" | "language">): boolean {
  const normalized = file.path.toLowerCase();
  if (file.language === "java") return normalized.startsWith("src/main/java/") || normalized.includes("/src/main/java/");
  if (file.language === "cpp" || file.language === "c") {
    return normalized.startsWith("include/") || normalized.includes("/include/") || normalized.startsWith("src/") || normalized.includes("/src/");
  }
  if (file.language === "python") {
    return normalized.startsWith("src/") || normalized.includes("/src/") || /^[a-z_][\w-]*\//.test(normalized);
  }
  if (file.language === "go") return !normalized.includes("/vendor/") && !normalized.includes("/testdata/");
  if (file.language === "ruby") return normalized.startsWith("lib/") || normalized.startsWith("app/") || normalized.includes("/lib/");
  return normalized.startsWith("src/") || normalized.includes("/src/") || normalized.startsWith("lib/") || normalized.includes("/lib/");
}

function samePackageSurface(left: string, right: string): boolean {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  if (leftParts[0] && leftParts[0] === rightParts[0]) return true;
  return commonPrefixLength(leftParts, rightParts) >= 2;
}

function sameModuleSurface(left: string, right: string): boolean {
  return commonPrefixLength(left.split("/").slice(0, -1), right.split("/").slice(0, -1)) >= 1;
}

function sameRoleCategory(left: string, right: string): boolean {
  const leftCategory = roleCategory(left);
  return Boolean(leftCategory && leftCategory === roleCategory(right));
}

function roleCategory(filePath: string): string | undefined {
  const normalized = filePath.toLowerCase();
  if (/(^|\/)adapters?\//.test(normalized) || /adapter/.test(normalized.split("/").at(-1) ?? "")) return "adapter";
  if (/interceptor/.test(normalized)) return "interceptor";
  if (/dispatch/.test(normalized)) return "dispatch";
  if (/dependenc/.test(normalized)) return "dependency";
  if (/routing|router|route/.test(normalized)) return "routing";
  if (/scheduler/.test(normalized)) return "scheduler";
  if (/renderer/.test(normalized)) return "renderer";
  if (/callback/.test(normalized)) return "callback";
  if (/validation/.test(normalized)) return "validation";
  if (/context/.test(normalized)) return "context";
  if (/handler|middleware/.test(normalized)) return "handler";
  if (/(^|\/)(gin|engine|mux)\.go$/.test(normalized)) return "engine";
  return undefined;
}

function isPlatformVariantPath(filePath: string): boolean {
  return /_(appengine|windows|linux|darwin|unix|posix|wasm|js)\./i.test(filePath);
}

function isGoPackageAnchor(seed: FileRecord, file: FileRecord, roles: CompanionRole[]): boolean {
  if (seed.language !== "go" || file.language !== "go") return false;
  if (file.path.includes("/")) return false;
  if (!roles.some((role) => role.id === "group-context-handler" || role.id === "routing-dependency")) return false;
  const basename = file.path.toLowerCase();
  return ["gin.go", "chi.go", "mux.go", "router.go", "engine.go", "server.go", "context.go", "chain.go"].includes(basename);
}

function isDownstreamAdapterForCoreFlow(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!/(^|\/)adapters?\//.test(normalized)) return false;
  return queryTerms.has("interceptor") || queryTerms.has("dispatch") || queryTerms.has("dispatcher");
}

function isFrameworkHelperForCoreFlow(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!/(^|\/)(helpers?|utils?)\//.test(normalized)) return false;
  return queryTerms.has("interceptor") || queryTerms.has("dispatch") || queryTerms.has("adapter") || queryTerms.has("adapters");
}

function isRequestFlowCoordinator(sourceTerms: Set<string>, queryTerms: Set<string>): boolean {
  const asksInterceptorFlow =
    queryTerms.has("interceptor") &&
    (queryTerms.has("dispatch") || queryTerms.has("adapter") || queryTerms.has("request") || queryTerms.has("response"));
  if (!asksInterceptorFlow) return false;
  return sourceTerms.has("interceptor") && sourceTerms.has("request") && (sourceTerms.has("dispatch") || sourceTerms.has("dispatcher"));
}

function isSupportConfigForCoreFlow(filePath: string, queryTerms: Set<string>): boolean {
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  const asksInterceptorFlow = queryTerms.has("interceptor") && (queryTerms.has("dispatch") || queryTerms.has("adapter"));
  if (!asksInterceptorFlow) return false;
  return /(merge[-_]?config|defaults?|headers?|validator|params|serializer|transform)/.test(basename);
}

function isGoMiddlewareForRouterCore(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!normalized.startsWith("middleware/")) return false;
  return ["router", "route", "context", "chain", "mount"].some((term) => queryTerms.has(term));
}

function isCaseSensitivityAnchor(filePath: string, queryTerms: Set<string>): boolean {
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  return /(^|\/)io(case)?\.java$/.test(filePath.toLowerCase()) || (basename.includes("case") && queryTerms.has("sensitivity"));
}

function isDownstreamComparatorOrFilter(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!/(^|\/)(comparator|filefilter)\//.test(normalized)) return false;
  return queryTerms.has("filename") || queryTerms.has("path") || queryTerms.has("normalize") || queryTerms.has("normalization");
}

function commonPrefixLength(left: string[], right: string[]): number {
  let count = 0;
  while (left[count] && right[count] && left[count] === right[count]) count += 1;
  return count;
}

function buildEdgeNeighborMap(edges: GraphEdgeRecord[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const edge of edges) {
    map.set(edge.fromFile, new Set([...(map.get(edge.fromFile) ?? []), edge.toFile]));
    map.set(edge.toFile, new Set([...(map.get(edge.toFile) ?? []), edge.fromFile]));
  }
  return map;
}

function groupByFile<T>(records: T[], filePathFor: (record: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const filePath = filePathFor(record);
    grouped.set(filePath, [...(grouped.get(filePath) ?? []), record]);
  }
  return grouped;
}

function uniqueResults(results: HybridScoredResult[]): HybridScoredResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.path)) return false;
    seen.add(result.path);
    return true;
  });
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons.filter(Boolean))];
}

function normalizeText(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function termSet(input: string): Set<string> {
  return new Set(
    tokenizeLexical(input)
      .filter((term) => term.length > 1)
      .flatMap((term) => {
        const canonical = canonicalTerm(term);
        return canonical === term ? [term] : [term, canonical];
      })
  );
}

function canonicalTerm(term: string): string {
  if (term === "dependencies") return "dependency";
  if (term === "repositories") return "repository";
  if (term === "controllers") return "controller";
  if (term === "models") return "model";
  if (term === "routes") return "route";
  if (term === "handlers") return "handler";
  if (term === "callbacks") return "callback";
  if (term === "ctx") return "context";
  if (term === "validations") return "validation";
  if (term === "interceptors") return "interceptor";
  if (term === "adapters") return "adapter";
  if (term === "resolvers") return "resolver";
  if (term === "extensions") return "extension";
  if (term === "fixtures") return "fixture";
  if (term === "groups") return "group";
  if (term === "requests") return "request";
  if (term === "responses") return "response";
  return term;
}
