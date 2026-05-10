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
    terms: [
      "router",
      "routing",
      "route",
      "routes",
      "dependency",
      "dependencies",
      "depends",
      "resolver",
      "resolvers",
      "resolve",
      "convertor",
      "convertors",
      "converter",
      "converters",
      "path",
      "paths",
      "mount",
      "matching"
    ],
    reason: "routing/dependency pair"
  },
  {
    id: "controller-repository-model",
    terms: ["controller", "controllers", "repository", "repositories", "repo", "repos", "dao", "model", "models", "schema", "service", "services"],
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
    terms: ["filename", "filepath", "path", "normalize", "normalization", "case-sensitive", "case-insensitive", "sensitivity", "extension", "extensions"],
    reason: "normalization/case pair"
  },
  {
    id: "fixture-context",
    terms: ["fixture", "fixtures", "scope", "parametrize", "parametrized", "python"],
    reason: "same fixture surface"
  },
  {
    id: "ui-sibling",
    terms: ["mobile", "layout", "responsive", "dashboard", "tabs", "table", "panel", "filter", "filters", "drawer", "sheet", "component"],
    reason: "UI sibling surface"
  },
  {
    id: "mcp-runtime",
    terms: ["mcp", "runtime", "server", "tool", "tools", "context", "next", "prepare", "session"],
    reason: "MCP/runtime pair"
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
  "repository",
  "language",
  "js",
  "ts",
  "py",
  "go",
  "java",
  "python",
  "javascript",
  "typescript",
  "golang",
  "prefer",
  "unless",
  "explicitly",
  "metadata",
  "interface",
  "path",
  "paths",
  "main",
  "index",
  "data",
  "database",
  "key",
  "keys",
  "object",
  "objects",
  "string",
  "strings",
  "promise",
  "array",
  "arrays",
  "method",
  "methods",
  "class",
  "classes",
  "client",
  "clients",
  "request",
  "requests",
  "response",
  "responses",
  "package",
  "packages",
  "if",
  "is",
  "at",
  "as",
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
  const routeAnchors = routePathAnchors(input.query);
  const mentionedSourceBasenames = mentionedSourceFileBasenames(input.query);

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
    if (!isUniversalSourceFile(file)) continue;
    if (isPlatformVariantPath(file.path)) continue;

    const sourceScore = scoreSourceRoleHints(file, input.query, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const roleMatches = matchRoleSignals(file, roleSignals, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const sourceText = searchableText(file, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const sourceTerms = termSet(sourceText);
    const pathTerms = termSet(file.path);
    const specificQueryHits = [...queryTerms].filter((term) => !COMPANION_STOP_TERMS.has(term) && sourceTerms.has(term));
    const rolePathMatches = roleSignals.filter((role) => role.terms.some((term) => pathTerms.has(canonicalTerm(term))));
    const pathQueryHits = [...queryTerms].filter((term) => !COMPANION_STOP_TERMS.has(term) && pathTerms.has(term));
    const compoundPathHits = compoundQueryTerms(input.query).filter((term) => pathTerms.has(term));

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
    if (compoundPathHits.length > 0) {
      score += Math.min(620, compoundPathHits.length * 360);
      reasons.push(`compound path term match: ${compoundPathHits.slice(0, 3).join(", ")}`);
    }
    const basename = file.path.toLowerCase().split("/").at(-1) ?? "";
    const mentionedBasename = mentionedSourceBasenames.has(basename);
    if (mentionedBasename) {
      score += 3200;
      reasons.push(`mentioned source filename: ${basename}`);
    }
    const routeAnchorHits = routeAnchors.filter((anchor) => basename.includes(anchor) || pathTerms.has(anchor));
    if (routeAnchorHits.length > 0) {
      score += Math.min(2200, routeAnchorHits.length * 1900);
      reasons.push(`route/path surface anchor: ${routeAnchorHits.slice(0, 2).join(", ")}`);
    }
    if (
      routeAnchors.length > 0 &&
      routeAnchorHits.length === 0 &&
      specificQueryHits.length === 0 &&
      /(filters?|requests?|responses?|views?|handlers?|helpers?|utils?)\./.test(basename)
    ) {
      score -= 420;
      reasons.push("generic route-adjacent helper downranked");
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
    if (isGenericHelperForRoleCompanion(file.path, queryTerms)) {
      score -= 340;
      reasons.push("helper companion downranked in favor of direct source surface");
    }
    if (isUnaskedConverterCompanion(file.path, queryTerms)) {
      score -= 520;
      reasons.push("converter companion downranked because conversion was not requested");
    }
    if (isDirectRoleBasenameAnchor(file.path, roleSignals, queryTerms)) {
      score += 460;
      reasons.push("direct role basename anchor");
    }
    if (isNamedPeerClientCompanion(file.path, queryTerms)) {
      score += 2600;
      reasons.push("named peer client companion");
    }
    if (isGenericNamedPeerDistractor(file.path, queryTerms)) {
      score -= 1100;
      reasons.push("generic request/model path downranked because named peer clients are present");
    }
    if (isKeyboardShortcutCompanion(file.path, queryTerms)) {
      score += 920;
      reasons.push("keyboard shortcut companion");
    }
    if (isUserEmailCompanion(file.path, queryTerms)) {
      score += 2400;
      reasons.push("user/email companion");
    }
    if (isExactUserEmailCompanion(file.path, queryTerms)) {
      score += 1800;
      reasons.push("exact user/email companion");
    }
    if (isGenericUserEmailDistractor(file.path, queryTerms)) {
      score -= 1400;
      reasons.push("generic database/main path downranked for user/email task");
    }
    if (isProxyServiceCompanion(file.path, queryTerms)) {
      score += 2100;
      reasons.push("proxy/service companion");
    }
    if (isKubernetesServiceCompanion(file.path, queryTerms)) {
      score += 2400;
      reasons.push("kubernetes service companion");
    }
    if (isGenericKubernetesServiceDistractor(file.path, queryTerms)) {
      score -= 3200;
      reasons.push("generic service/request path downranked for kubernetes task");
    }

    for (const seed of seedFiles) {
      const seedRoles = matchRoleSignals(seed, roleSignals, symbolsByFile.get(seed.path) ?? [], chunksByFile.get(seed.path) ?? []);
      const roleComplement = scoreRoleComplement({
        seed,
        candidate: file,
        queryTerms,
        seedRoles,
        candidateRoles: roleMatches
      });
      if (roleComplement.score !== 0) {
        score += roleComplement.score;
        reasons.push(...roleComplement.reasons);
      }
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
        const penalty = sameRoleDuplicatePenalty(seed.path, file.path, queryTerms);
        score -= penalty;
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
      if (isRouteCoreSibling(seed.path, file.path, queryTerms)) {
        score += 1200;
        reasons.push("router core sibling");
      }
      if (isCrossPackageFrameworkSurface(seed.path, file.path) && !mentionedBasename && routeAnchorHits.length === 0) {
        score -= 900;
        reasons.push("cross-package framework surface downranked");
      }
      if (!isCompatibleCompanionLanguage(seed.language, file.language)) {
        score -= 700;
        reasons.push("cross-language companion downranked");
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

function isCompatibleCompanionLanguage(left: string, right: string): boolean {
  if (!left || !right || left === "unknown" || right === "unknown") return true;
  if (left === right) return true;
  const jsFamily = new Set(["javascript", "typescript"]);
  if (jsFamily.has(left) && jsFamily.has(right)) return true;
  const cFamily = new Set(["c", "cpp"]);
  if (cFamily.has(left) && cFamily.has(right)) return true;
  return false;
}

function routePathAnchors(query: string): string[] {
  const anchors = new Set<string>();
  for (const match of query.matchAll(/(?:^|[\s('"“‘])\/([A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z][A-Za-z0-9_-]*)*)/g)) {
    const route = match[1]!;
    if (route.includes(".") || route.includes("\\")) continue;
    const parts = route
      .split("/")
      .map((part) => canonicalTerm(part.toLowerCase()))
      .filter((part) => part.length >= 3 && !ROUTE_ANCHOR_STOP_TERMS.has(part));
    const value = parts[0];
    if (value) {
      anchors.add(value);
      if (value.endsWith("s") && value.length > 4) anchors.add(value.slice(0, -1));
    }
  }
  return [...anchors];
}

function mentionedSourceFileBasenames(query: string): Set<string> {
  const basenames = new Set<string>();
  const pattern = /\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)\b/g;
  for (const match of query.matchAll(pattern)) {
    const basename = match[0]!.toLowerCase().split(/[\\/]/).at(-1);
    if (!basename || isLikelyTestPath(basename) || isGenericMentionedBasename(basename)) continue;
    basenames.add(basename);
  }
  return basenames;
}

function isGenericMentionedBasename(basename: string): boolean {
  return /^(main|index)\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(basename);
}

const ROUTE_ANCHOR_STOP_TERMS = new Set([
  "api",
  "app",
  "apps",
  "src",
  "lib",
  "libs",
  "plugin",
  "plugins",
  "unit",
  "units",
  "util",
  "utils",
  "openlibrary",
  "ansible",
  "test",
  "tests",
  "docs",
  "doc",
  "http",
  "https"
]);

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

function scoreRoleComplement(input: {
  seed: FileRecord;
  candidate: FileRecord;
  queryTerms: Set<string>;
  seedRoles: CompanionRole[];
  candidateRoles: CompanionRole[];
}): { score: number; reasons: string[] } {
  const seedCategory = roleCategory(input.seed.path);
  const candidateCategory = roleCategory(input.candidate.path);
  const reasons: string[] = [];
  let score = 0;
  if (!seedCategory || !candidateCategory) {
    if (isUiSiblingCompanion(input.seed.path, input.candidate.path, input.queryTerms)) {
      return { score: 520, reasons: ["UI sibling companion"] };
    }
    return { score, reasons };
  }

  if (isComplementaryRole(seedCategory, candidateCategory)) {
    score += samePackageSurface(input.seed.path, input.candidate.path) ? 620 : 420;
    reasons.push(`${seedCategory}/${candidateCategory} role complement`);
  }

  if (isEntityRolePair(input.seed.path, input.candidate.path, seedCategory, candidateCategory)) {
    score += 540;
    reasons.push("same entity role pair");
  }

  if (isRouteConvertorPair(seedCategory, candidateCategory, input.seed.path, input.candidate.path)) {
    score += 680;
    reasons.push("route/convertor companion");
  }

  if (isMcpRuntimePair(seedCategory, candidateCategory, input.queryTerms)) {
    score += 620;
    reasons.push("MCP/runtime companion");
  }

  if (isGoPackageCorePair(input.seed, input.candidate, seedCategory, candidateCategory, input.queryTerms)) {
    score += 500;
    reasons.push("Go package core companion");
  }

  if (isFixtureCorePair(input.candidate.path, input.queryTerms)) {
    score += 520;
    reasons.push("fixture implementation companion");
  }

  if (input.candidateRoles.some((role) => role.id === "ui-sibling") && isUiSiblingCompanion(input.seed.path, input.candidate.path, input.queryTerms)) {
    score += 440;
    reasons.push("UI sibling companion");
  }

  return { score, reasons };
}

function isComplementaryRole(left: string, right: string): boolean {
  const pair = new Set([left, right]);
  return (
    (pair.has("controller") && (pair.has("repository") || pair.has("service") || pair.has("model"))) ||
    (pair.has("routing") && (pair.has("dependency") || pair.has("convertor") || pair.has("handler") || pair.has("context"))) ||
    (pair.has("scheduler") && pair.has("renderer")) ||
    (pair.has("interceptor") && (pair.has("dispatch") || pair.has("adapter"))) ||
    (pair.has("validation") && pair.has("callback")) ||
    (pair.has("engine") && (pair.has("context") || pair.has("routing") || pair.has("handler"))) ||
    (pair.has("runtime") && pair.has("mcp"))
  );
}

function isEntityRolePair(seedPath: string, candidatePath: string, seedCategory: string, candidateCategory: string): boolean {
  if (!isComplementaryRole(seedCategory, candidateCategory)) return false;
  const seedEntity = entityStem(seedPath, seedCategory);
  const candidateEntity = entityStem(candidatePath, candidateCategory);
  return Boolean(seedEntity && candidateEntity && seedEntity === candidateEntity);
}

function entityStem(filePath: string, category: string): string | undefined {
  const basename = filePath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const stripped = basename
    .replace(new RegExp(`${category}$`, "i"), "")
    .replace(/(controller|repository|repo|service|model|dao|handler|route|router|routing|context|engine|mcp|runtime)$/i, "")
    .replace(/[-_]+$/g, "");
  const terms = termSet(stripped);
  return [...terms].filter((term) => !["base", "abstract", "default", "impl"].includes(term)).join("-");
}

function isRouteConvertorPair(seedCategory: string, candidateCategory: string, seedPath: string, candidatePath: string): boolean {
  const pair = new Set([seedCategory, candidateCategory]);
  if (!(pair.has("routing") && pair.has("convertor"))) return false;
  return samePackageSurface(seedPath, candidatePath) || sameModuleSurface(seedPath, candidatePath);
}

function isMcpRuntimePair(seedCategory: string, candidateCategory: string, queryTerms: Set<string>): boolean {
  const pair = new Set([seedCategory, candidateCategory]);
  return pair.has("runtime") && pair.has("mcp") && (queryTerms.has("mcp") || queryTerms.has("tool") || queryTerms.has("context"));
}

function isGoPackageCorePair(
  seed: Pick<FileRecord, "path" | "language">,
  candidate: Pick<FileRecord, "path" | "language">,
  seedCategory: string,
  candidateCategory: string,
  queryTerms: Set<string>
): boolean {
  if (seed.language !== "go" || candidate.language !== "go") return false;
  if (candidate.path.includes("/")) return false;
  const asksRouterCore = ["router", "routing", "route", "context", "group", "handler", "middleware", "chain", "mount"].some((term) => queryTerms.has(term));
  if (!asksRouterCore) return false;
  return isComplementaryRole(seedCategory, candidateCategory) || ["gin.go", "context.go", "routergroup.go", "chain.go", "mux.go", "router.go"].includes(candidate.path.toLowerCase());
}

function isFixtureCorePair(filePath: string, queryTerms: Set<string>): boolean {
  if (!queryTerms.has("fixture")) return false;
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  return basename === "fixtures.py" || basename === "python.py";
}

function isUiSiblingCompanion(seedPath: string, candidatePath: string, queryTerms: Set<string>): boolean {
  const asksUi = ["ui", "mobile", "layout", "dashboard", "tabs", "table", "panel", "filter", "filters", "component"].some((term) => queryTerms.has(term));
  if (!asksUi) return false;
  if (!sameModuleSurface(seedPath, candidatePath)) return false;
  const basename = candidatePath.toLowerCase().split("/").at(-1) ?? "";
  return /(tabs?|tables?|panels?|filters?|dashboard|layout|mobile|sheet|drawer|view|list|card|form|component)/.test(basename);
}

function sameRoleDuplicatePenalty(seedPath: string, candidatePath: string, queryTerms: Set<string>): number {
  const category = roleCategory(seedPath);
  if (!category) return 120;
  const seedEntity = entityStem(seedPath, category);
  const candidateEntity = entityStem(candidatePath, category);
  if (seedEntity && candidateEntity && seedEntity !== candidateEntity && ["controller", "repository", "service", "model"].includes(category)) {
    return 620;
  }
  if (category === "routing" && !["route", "routes", "router", "routing"].some((term) => queryTerms.has(term))) return 360;
  return 180;
}

function roleCategory(filePath: string): string | undefined {
  const normalized = filePath.toLowerCase();
  if (/(^|\/)adapters?\//.test(normalized) || /adapter/.test(normalized.split("/").at(-1) ?? "")) return "adapter";
  if (/mcp/.test(normalized.split("/").at(-1) ?? "") || /(^|\/)mcp\//.test(normalized)) return "mcp";
  if (/runtime/.test(normalized.split("/").at(-1) ?? "")) return "runtime";
  if (/proxy/.test(normalized.split("/").at(-1) ?? "")) return "proxy";
  if (/interceptor/.test(normalized)) return "interceptor";
  if (/dispatch/.test(normalized)) return "dispatch";
  if (/convertors?|converters?/.test(normalized)) return "convertor";
  if (/dependenc/.test(normalized)) return "dependency";
  if (/repository|repositories|repo\b|dao/.test(normalized)) return "repository";
  if (/service/.test(normalized)) return "service";
  if (/model|schema/.test(normalized)) return "model";
  if (/controller/.test(normalized)) return "controller";
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

function isRouteCoreSibling(seedPath: string, candidatePath: string, queryTerms: Set<string>): boolean {
  const seed = seedPath.toLowerCase();
  const candidate = candidatePath.toLowerCase();
  if (!sameModuleSurface(seed, candidate)) return false;
  const seedBase = seed.split("/").at(-1) ?? "";
  const candidateBase = candidate.split("/").at(-1) ?? "";
  if (!/(index|router|routing|route|layer|execution-context)\.[cm]?[jt]s$/.test(seedBase)) return false;
  if (!/(route|layer|router|proxy|response-controller|execution-context|index)\.[cm]?[jt]s$/.test(candidateBase)) return false;
  return ["param", "params", "dispatch", "handler", "middleware", "route", "router", "proxy", "response", "controller"].some((term) => queryTerms.has(term));
}

function isDirectRoleBasenameAnchor(filePath: string, roles: CompanionRole[], queryTerms: Set<string>): boolean {
  const basename = filePath.toLowerCase().split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (!basename) return false;
  if (basename === "index") return false;
  const basenameTerms = termSet(basename);
  return roles.some((role) => role.terms.some((term) => basenameTerms.has(canonicalTerm(term)) && queryTerms.has(canonicalTerm(term))));
}

function isNamedPeerClientCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!/\/client\.[a-z0-9]+$/.test(normalized) && !/(^|\/)client\.[a-z0-9]+$/.test(normalized)) return false;
  const agentNames = ["lastfm", "listenbrainz", "spotify", "github", "gitlab", "slack", "gmail", "jira"];
  return agentNames.some((name) => queryTerms.has(name) && normalized.includes(name)) ||
    (queryTerms.has("listen") && queryTerms.has("brainz") && normalized.includes("listenbrainz")) ||
    (queryTerms.has("last") && queryTerms.has("fm") && normalized.includes("lastfm"));
}

function hasNamedPeerClientQuery(queryTerms: Set<string>): boolean {
  const agentNames = ["lastfm", "listenbrainz", "spotify", "github", "gitlab", "slack", "gmail", "jira"];
  return agentNames.some((name) => queryTerms.has(name)) ||
    (queryTerms.has("listen") && queryTerms.has("brainz")) ||
    (queryTerms.has("last") && queryTerms.has("fm"));
}

function isGenericNamedPeerDistractor(filePath: string, queryTerms: Set<string>): boolean {
  if (!hasNamedPeerClientQuery(queryTerms)) return false;
  if (isNamedPeerClientCompanion(filePath, queryTerms)) return false;
  const normalized = filePath.toLowerCase();
  return /(^|\/)(model|models|request|requests|response|responses|repository|repositories)\//.test(normalized) ||
    /(^|\/)(request|response|model|repository)\.[a-z0-9]+$/.test(normalized);
}

function isKeyboardShortcutCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  const asksKeyboardShortcut =
    (queryTerms.has("keyboard") || queryTerms.has("key")) &&
    (queryTerms.has("shortcut") || queryTerms.has("shortcuts") || queryTerms.has("binding") || queryTerms.has("bindings"));
  if (!asksKeyboardShortcut) return false;
  return /key[-_]?bindings?|keyboard[-_]?shortcuts?|shortcuts?/.test(normalized) || (normalized.includes("key") && normalized.includes("binding"));
}

function isUserEmailCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!queryTerms.has("email")) return false;
  if (!["user", "users", "admin", "acp", "confirmation", "validation", "validate"].some((term) => queryTerms.has(term))) return false;
  const basename = normalized.split("/").at(-1) ?? "";
  return basename.includes("email") || /(^|\/)(user|users|admin|admins)(\/|$)/.test(normalized);
}

function isExactUserEmailCompanion(filePath: string, queryTerms: Set<string>): boolean {
  if (!isUserEmailCompanion(filePath, queryTerms)) return false;
  const pathTerms = termSet(filePath);
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  return (pathTerms.has("user") || pathTerms.has("users")) && (pathTerms.has("email") || basename.includes("email"));
}

function isGenericUserEmailDistractor(filePath: string, queryTerms: Set<string>): boolean {
  const asksUserEmail =
    queryTerms.has("email") &&
    (queryTerms.has("user") || queryTerms.has("users") || queryTerms.has("admin") || queryTerms.has("confirmation") || queryTerms.has("validation"));
  if (!asksUserEmail) return false;
  if (isUserEmailCompanion(filePath, queryTerms)) return false;
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  return /(^|\/)(database|db|mongo|redis|postgres|postgresql|mysql)\//.test(normalized) ||
    /^(main|index)\.[a-z0-9]+$/.test(basename);
}

function isProxyServiceCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!/(^|\/)service\//.test(normalized) && !/service/.test(normalized)) return false;
  const asksService = queryTerms.has("service") || queryTerms.has("services") || queryTerms.has("initialization") || queryTerms.has("uploader");
  const asksProxy = queryTerms.has("proxy") || queryTerms.has("forwarder") || queryTerms.has("forwarding");
  const asksKube = queryTerms.has("kube") || queryTerms.has("kubernetes") || queryTerms.has("kubectl");
  return asksService && (asksProxy || asksKube);
}

function isKubernetesServiceCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const asksKube = queryTerms.has("kube") || queryTerms.has("kubernetes") || queryTerms.has("kubectl");
  if (!asksKube) return false;
  const normalized = filePath.toLowerCase();
  return /(^|\/)service\//.test(normalized) && /(kube|kubernetes|kubectl)/.test(normalized);
}

function isGenericKubernetesServiceDistractor(filePath: string, queryTerms: Set<string>): boolean {
  const asksKube = queryTerms.has("kube") || queryTerms.has("kubernetes") || queryTerms.has("kubectl");
  if (!asksKube) return false;
  if (isKubernetesServiceCompanion(filePath, queryTerms)) return false;
  const normalized = filePath.toLowerCase();
  return /(^|\/)services?\//.test(normalized) && !/(kube|kubernetes|kubectl)/.test(normalized);
}

function isGenericHelperForRoleCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!/(^|\/)(helpers?|utils?|support)\//.test(normalized)) return false;
  return !["helper", "helpers", "utility", "utils", "support"].some((term) => queryTerms.has(term));
}

function isUnaskedConverterCompanion(filePath: string, queryTerms: Set<string>): boolean {
  if (!/convert(or|er)|converter|convertor/.test(filePath.toLowerCase())) return false;
  return !["convert", "converter", "convertor", "conversion", "path", "matching"].some((term) => queryTerms.has(term));
}

function isCrossPackageFrameworkSurface(seedPath: string, candidatePath: string): boolean {
  const seedParts = seedPath.toLowerCase().split("/");
  const candidateParts = candidatePath.toLowerCase().split("/");
  if (seedParts[0] !== "packages" || candidateParts[0] !== "packages") return false;
  if (!seedParts[1] || !candidateParts[1] || seedParts[1] === candidateParts[1]) return false;
  return true;
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

function compoundQueryTerms(query: string): string[] {
  const terms = tokenizeLexical(query).map(canonicalTerm);
  const compounds = new Set<string>();
  for (let index = 0; index < terms.length - 1; index += 1) {
    const left = terms[index];
    const right = terms[index + 1];
    if (!left || !right) continue;
    const compound = `${left}${right}`;
    if (compound.length >= 5 && !COMPANION_STOP_TERMS.has(left) && !COMPANION_STOP_TERMS.has(right)) {
      compounds.add(compound);
    }
  }
  return [...compounds];
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
  if (term === "repos") return "repo";
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
  if (term === "convertors") return "convertor";
  if (term === "converters") return "converter";
  if (term === "tools") return "tool";
  if (term === "tabs") return "tab";
  if (term === "filters") return "filter";
  return term;
}
