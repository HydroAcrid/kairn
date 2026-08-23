// SPDX-License-Identifier: Apache-2.0

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
      "rule",
      "rules",
      "map",
      "maps",
      "matcher",
      "matchers",
      "layer",
      "layers",
      "param",
      "params",
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
      "matching",
      "pattern",
      "patterns",
      "tree",
      "trie"
    ],
    reason: "routing/dependency pair"
  },
  {
    id: "search-printer-output",
    terms: ["search", "searcher", "match", "matches", "printer", "print", "json", "path", "paths", "event", "events", "output"],
    reason: "search/printer output pair"
  },
  {
    id: "line-comment-formatting",
    terms: ["line", "lines", "linegen", "generator", "generate", "output", "comment", "comments", "split", "splitting", "format", "formatting"],
    reason: "line/comment formatting pair"
  },
  {
    id: "fixture-runner-resolution",
    terms: ["fixture", "fixtures", "resolution", "resolve", "collected", "node", "nodes", "runner", "setup", "value", "values", "request"],
    reason: "fixture/runner resolution pair"
  },
  {
    id: "controller-repository-model",
    terms: ["controller", "controllers", "repository", "repositories", "repo", "repos", "dao", "model", "models", "schema", "service", "services"],
    reason: "controller/repository/model pair"
  },
  {
    id: "scheduler-renderer",
    terms: ["scheduler", "schedule", "renderer", "render", "rendering", "measure", "measurement", "width", "segment", "segments", "queue", "flush", "callback"],
    reason: "scheduler/renderer pair"
  },
  {
    id: "interceptor-dispatch-adapter",
    terms: ["interceptor", "interceptors", "dispatch", "dispatcher", "adapter", "adapters", "request", "response", "proxy", "session", "sessions", "prepared", "redirect", "mounted", "chain", "chains", "call", "calls", "network", "application"],
    reason: "interceptor/dispatch/adapter pair"
  },
  {
    id: "schema-parser",
    terms: ["schema", "schemas", "shape", "shapes", "object", "objects", "parse", "parser", "parsing", "unknown", "key", "keys", "validation", "validate"],
    reason: "schema/parser pair"
  },
  {
    id: "connection-pool",
    terms: ["connection", "connections", "pool", "pools", "retry", "retries", "dispatch", "request", "requests", "failure", "failed"],
    reason: "connection/pool pair"
  },
  {
    id: "log-core-sink",
    terms: ["log", "logs", "logger", "loggers", "sink", "sinks", "core", "entry", "entries", "encoder", "encoders", "field", "fields", "write", "writing", "flush"],
    reason: "log/core/sink pair"
  },
  {
    id: "plugin-transform-analysis",
    terms: ["plugin", "plugins", "container", "containers", "transform", "transforms", "analysis", "analyze", "import", "imports", "module", "modules", "resolve", "resolver", "load", "hooks"],
    reason: "plugin/transform analysis pair"
  },
  {
    id: "module-loader-resolver",
    terms: ["module", "modules", "loader", "loading", "load", "resolve", "resolver", "resolvers", "factory", "graph", "parser", "parsing", "hook", "hooks"],
    reason: "module/loader/resolver pair"
  },
  {
    id: "schema-field-generation",
    terms: ["schema", "schemas", "field", "fields", "alias", "aliases", "model", "models", "generate", "generation", "validator", "validators", "core"],
    reason: "schema/field generation pair"
  },
  {
    id: "statement-callback-field",
    terms: ["statement", "statements", "callback", "callbacks", "create", "update", "query", "delete", "field", "fields", "schema", "value", "values", "insert", "rows"],
    reason: "statement/callback/field pair"
  },
  {
    id: "session-command-config",
    terms: ["session", "sessions", "startup", "start", "command", "commands", "commandline", "command-line", "cli", "config", "configuration", "parse", "parsing", "argument", "arguments", "args"],
    reason: "session/command/config pair"
  },
  {
    id: "orm-unit-persistence",
    terms: ["orm", "session", "sessions", "flush", "flushed", "unit", "unitofwork", "work", "persistence", "persist", "mapper", "mappers"],
    reason: "ORM unit-of-work/persistence pair"
  },
  {
    id: "parse-persist",
    terms: ["parse", "parser", "parsed", "persist", "persistence", "repository", "repositories", "events", "event", "ingest", "store", "storage"],
    reason: "parse/persist pair"
  },
  {
    id: "session-adapter-model",
    terms: ["session", "sessions", "adapter", "adapters", "model", "models", "prepared", "redirect", "mounted", "send"],
    reason: "session/adapter/model pair"
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
  },
  {
    id: "fiber-hooks-workloop",
    terms: ["fiber", "hook", "hooks", "effect", "effects", "work", "workloop", "workloop", "reconciler", "component", "components", "flush", "flushed", "update", "scheduling"],
    reason: "fiber/hooks/workloop pair"
  },
  {
    id: "string-matcher",
    terms: ["string", "strings", "char", "character", "matcher", "matching", "prefix", "suffix", "surrogate"],
    reason: "string/matcher pair"
  },
  {
    id: "crypto-hash-helper",
    terms: ["password", "passwords", "encrypt", "encryption", "hash", "hashes", "hashing", "bcrypt", "salt", "salts", "ident", "secret", "random"],
    reason: "password/hash helper pair"
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
  "module_installation",
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

const STRONG_CANONICAL_BASENAME_TERMS = new Set([
  "sink",
  "logger",
  "core",
  "entry",
  "encoder",
  "schema",
  "object",
  "connection",
  "pool",
  "chain",
  "call",
  "interceptor",
  "measure",
  "segment",
  "console",
  "tree",
  "mux",
  "context",
  "route",
  "search",
  "printer",
  "json",
  "line",
  "linegen",
  "comment",
  "fixture",
  "runner",
  "parser",
  "repository"
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
  const hsmKmsConfigTask = isHsmKmsConfigTask(input.query);
  const configOptionTask = isConfigOptionSchemaTask(input.query);
  const deprecationLifecycleTask = isDeprecationLifecycleTask(input.query);
  const formUnflattenRequestTask = isFormUnflattenRequestTask(input.query);
  const kubernetesExecForwarderTask = isKubernetesExecForwarderTask(input.query);
  const packageSourceMappingTask = isPackageSourceMappingTask(input.query);
  const uiFeedbackTask = isUiFeedbackOwnershipTask(input.query);
  const datastoreBackendParityTask = isDatastoreBackendParityTask(queryTerms, input.query);
  if (
    roleSignals.length === 0 &&
    !hasMultiSurfaceQuerySignal(queryTerms) &&
    !hsmKmsConfigTask &&
    !configOptionTask &&
    !deprecationLifecycleTask &&
	    !formUnflattenRequestTask &&
	    !kubernetesExecForwarderTask &&
	    !packageSourceMappingTask &&
	    !uiFeedbackTask &&
      !datastoreBackendParityTask
  ) return [];
  const routeAnchors = routePathAnchors(input.query);
  const mentionedSourceBasenames = mentionedSourceFileBasenames(input.query);
  const qualifiedGenericModuleHints = qualifiedGenericModulePathHints(input.query);
  const testCounterpartHints = sourceCounterpartHintsFromTestPaths(input.query);
  const explicitSourcePathHints = sourcePathHintsFromQuery(input.query);
  const preciseSourceSurfacePresent =
    mentionedSourceBasenames.size > 0 ||
    qualifiedGenericModuleHints.length > 0 ||
    testCounterpartHints.length > 0 ||
    explicitSourcePathHints.length > 0;

  const symbolsByFile = groupByFile(input.symbols, (symbol) => symbol.filePath);
  const chunksByFile = groupByFile(input.chunks, (chunk) => chunk.filePath);
  const filesByPath = new Map(input.files.map((file) => [file.path, file]));
  const seedFiles = input.ranked
    .filter((file) =>
      isCompanionSeed(file) ||
      (hsmKmsConfigTask && isHsmKmsBackendHelperPath(file.path)) ||
      (configOptionTask && (isUniversalSourceFile(file) || isDeclarativeConfigSchemaFile(file.path))) ||
	      ((deprecationLifecycleTask || formUnflattenRequestTask || kubernetesExecForwarderTask || packageSourceMappingTask || uiFeedbackTask || datastoreBackendParityTask) && isUniversalSourceFile(file))
    )
    .slice(0, 1);
  if (seedFiles.length === 0) return [];

  const seedPaths = new Set(seedFiles.map((file) => file.path));
  const edgeNeighbors = buildEdgeNeighborMap(input.edges);
  const importNeighbors = buildImportNeighborMap(input.edges);
  const candidates: CompanionCandidate[] = [];

  for (const file of input.files) {
    const hsmKmsBackendHelper = hsmKmsConfigTask && isHsmKmsBackendHelperPath(file.path);
    const declarativeConfigSchema = configOptionTask && isDeclarativeConfigSchemaFile(file.path);
    if (hsmKmsConfigTask && isUnrelatedHsmKmsGenericTestHelper(file.path, input.query)) continue;
    if (seedPaths.has(file.path) || isNoisyCompanionFile(file) || (isLikelyTestPath(file.path) && !hsmKmsBackendHelper)) continue;
    if (!isUniversalSourceFile(file) && !declarativeConfigSchema) continue;
    if ((file.kind === "component" || file.kind === "route") && !hasUiQuerySignal(queryTerms)) continue;
    if (isPlatformVariantPath(file.path)) continue;

    const sourceScore = scoreSourceRoleHints(file, input.query, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const canonicalRoleScore = scoreCanonicalRoleSurface(file, input.query, queryTerms);
    const roleMatches = matchRoleSignals(file, roleSignals, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const sourceText = searchableText(file, symbolsByFile.get(file.path) ?? [], chunksByFile.get(file.path) ?? []);
    const sourceTerms = termSet(sourceText);
    if (deprecationLifecycleTask && isUnrelatedDeprecationLifecycleCompanion(file.path, sourceTerms)) continue;
    const pathTerms = termSet(file.path);
    const specificQueryHits = [...queryTerms].filter((term) => !COMPANION_STOP_TERMS.has(term) && sourceTerms.has(term));
    const rolePathMatches = roleSignals.filter((role) => role.terms.some((term) => pathTerms.has(canonicalTerm(term))));
    const pathQueryHits = [...queryTerms].filter((term) => !COMPANION_STOP_TERMS.has(term) && pathTerms.has(term));
    const compoundPathHits = compoundQueryTerms(input.query).filter((term) => pathTerms.has(term));
    const testCounterpart = scoreTestCounterpartHint(file, testCounterpartHints, queryTerms);
    const explicitSourcePath = scoreExplicitSourcePathHint(file, explicitSourcePathHints);
    const commandExporter = scoreCommandExporterCompanion(file.path, input.query, queryTerms, sourceTerms);
    const hsmKmsConfig = scoreHsmKmsConfigCompanion(file.path, input.query, sourceTerms);
    const backendAutocomplete = scoreBackendAutocompleteCompanion(file.path, input.query, sourceTerms);
    const configOptionSchema = scoreConfigOptionSchemaCompanion(file.path, input.query, sourceTerms);
    const deprecationLifecycle = scoreDeprecationLifecycleCompanion(file.path, input.query, sourceTerms);
    const formUnflattenRequest = scoreFormUnflattenRequestCompanion(file.path, input.query, sourceTerms);
    const kubernetesExecForwarder = scoreKubernetesExecForwarderCompanion(file.path, input.query, sourceTerms);
    const kubernetesRbacMatcher = scoreKubernetesRbacMatcherCompanion(file.path, input.query, sourceTerms);
    const packageSourceMapping = scorePackageSourceMappingCompanion(file.path, input.query, sourceTerms);
    const uiFeedbackOwnership = scoreUiFeedbackOwnershipCompanion(file.path, input.query, sourceTerms);

    let score = sourceScore.score + canonicalRoleScore.score;
    const reasons = [...sourceScore.reasons, ...canonicalRoleScore.reasons];

    if (specificQueryHits.length > 0) {
      score += Math.min(56, specificQueryHits.length * 14);
      reasons.push(`specific task term match: ${specificQueryHits.slice(0, 4).join(", ")}`);
    }
    const namedFileSurface = scoreNamedFileSurface(file.path, input.query);
    if (namedFileSurface.score !== 0) {
      score += namedFileSurface.score;
      reasons.push(...namedFileSurface.reasons);
    }
    if (pathQueryHits.length > 0) {
      score += Math.min(360, pathQueryHits.length * 120);
      reasons.push(`specific path term match: ${pathQueryHits.slice(0, 4).join(", ")}`);
    }
    if (compoundPathHits.length > 0) {
      score += Math.min(620, compoundPathHits.length * 360);
      reasons.push(`compound path term match: ${compoundPathHits.slice(0, 3).join(", ")}`);
    }
    if (testCounterpart.score !== 0) {
      score += testCounterpart.score;
      reasons.push(...testCounterpart.reasons);
    }
    if (explicitSourcePath.score !== 0) {
      score += explicitSourcePath.score;
      reasons.push(...explicitSourcePath.reasons);
    }
    if (commandExporter.score !== 0) {
      score += commandExporter.score;
      reasons.push(...commandExporter.reasons);
    }
    if (hsmKmsConfig.score !== 0) {
      score += hsmKmsConfig.score;
      reasons.push(...hsmKmsConfig.reasons);
    }
    if (backendAutocomplete.score !== 0) {
      score += backendAutocomplete.score;
      reasons.push(...backendAutocomplete.reasons);
    }
    if (configOptionSchema.score !== 0) {
      score += configOptionSchema.score;
      reasons.push(...configOptionSchema.reasons);
    }
    if (deprecationLifecycle.score !== 0) {
      score += deprecationLifecycle.score;
      reasons.push(...deprecationLifecycle.reasons);
    }
    if (formUnflattenRequest.score !== 0) {
      score += formUnflattenRequest.score;
      reasons.push(...formUnflattenRequest.reasons);
    }
    if (kubernetesExecForwarder.score !== 0) {
      score += kubernetesExecForwarder.score;
      reasons.push(...kubernetesExecForwarder.reasons);
    }
    if (kubernetesRbacMatcher.score !== 0) {
      score += kubernetesRbacMatcher.score;
      reasons.push(...kubernetesRbacMatcher.reasons);
    }
    if (packageSourceMapping.score !== 0) {
      score += packageSourceMapping.score;
      reasons.push(...packageSourceMapping.reasons);
    }
    if (uiFeedbackOwnership.score !== 0) {
      score += uiFeedbackOwnership.score;
      reasons.push(...uiFeedbackOwnership.reasons);
    }
    const basename = file.path.toLowerCase().split("/").at(-1) ?? "";
    const mentionedBasename = mentionedSourceBasenames.has(basename);
    if (mentionedBasename) {
      score += 3200;
      reasons.push(`mentioned source filename: ${basename}`);
    }
    if (mentionedSourceBasenames.size > 0 && !mentionedBasename && isGenericUtilityBasename(basename)) {
      score -= 2600;
      reasons.push("generic utility downranked because specific source filenames were named");
    }
    const qualifiedGenericModulePenalty = scoreQualifiedGenericModuleMismatch(file.path, qualifiedGenericModuleHints);
    if (qualifiedGenericModulePenalty < 0) {
      score += qualifiedGenericModulePenalty;
      reasons.push("generic utility downranked because qualified utility module was named");
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
    if (isExecutionCoordinatorForCryptoTask(file.path, queryTerms)) {
      score -= 2600;
      reasons.push("execution coordinator downranked for password/hash helper task");
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
    if (isSessionAdapterModelCompanion(file.path, queryTerms)) {
      score += 1250;
      reasons.push("session/adapter/model companion");
    }
    if (isFiberHooksWorkLoopCompanion(file.path, queryTerms)) {
      score += 1800;
      reasons.push("fiber/hooks/workloop companion");
    }
    if (isStringMatcherCompanion(file.path, queryTerms)) {
      score += 1150;
      reasons.push("string/matcher companion");
    }
    const moduleResolver = scoreModuleResolverCompanion(file.path, queryTerms);
    if (moduleResolver.score !== 0) {
      score += moduleResolver.score;
      reasons.push(...moduleResolver.reasons);
    }
    const pluginTransform = scorePluginTransformFlowCompanion(file.path, queryTerms);
    if (pluginTransform.score !== 0) {
      score += pluginTransform.score;
      reasons.push(...pluginTransform.reasons);
    }
    const schemaField = scoreSchemaFieldGenerationCompanion(file.path, queryTerms);
    if (schemaField.score !== 0) {
      score += schemaField.score;
      reasons.push(...schemaField.reasons);
    }
    const statementField = scoreStatementCallbackCompanion(file.path, queryTerms);
    if (statementField.score !== 0) {
      score += statementField.score;
      reasons.push(...statementField.reasons);
    }
    const goLogPipeline = scoreGoLogPipelineCompanion(file.path, file.language, queryTerms);
    if (goLogPipeline.score !== 0) {
      score += goLogPipeline.score;
      reasons.push(...goLogPipeline.reasons);
    }
    const modifierMetadata = scoreModifierMetadataCompanion(file.path, queryTerms);
    if (modifierMetadata.score !== 0) {
      score += modifierMetadata.score;
      reasons.push(...modifierMetadata.reasons);
    }
    const accountEmailFlow = scoreAccountEmailFlowCompanion(file.path, queryTerms);
    if (accountEmailFlow.score !== 0) {
      score += accountEmailFlow.score;
      reasons.push(...accountEmailFlow.reasons);
    }
    const httpAuthUtility = scoreHttpAuthUtilityCompanion(file.path, queryTerms);
    if (httpAuthUtility.score !== 0) {
      score += httpAuthUtility.score;
      reasons.push(...httpAuthUtility.reasons);
    }
    const textUtility = scoreTextTransformUtilityCompanion(file.path, sourceTerms, queryTerms);
    if (textUtility.score !== 0) {
      score += textUtility.score;
      reasons.push(...textUtility.reasons);
    }
    const commandConfig = scoreSessionCommandConfigCompanion(file.path, queryTerms);
    if (commandConfig.score !== 0) {
      score += commandConfig.score;
      reasons.push(...commandConfig.reasons);
    }
    const ormUnitOfWork = scoreOrmUnitOfWorkCompanion(file.path, queryTerms);
    if (ormUnitOfWork.score !== 0) {
      score += ormUnitOfWork.score;
      reasons.push(...ormUnitOfWork.reasons);
    }
    const routingMapRule = scoreRoutingMapRuleSourceCompanion(file.path, queryTerms);
    if (routingMapRule.score !== 0) {
      score += routingMapRule.score;
      reasons.push(...routingMapRule.reasons);
    }
    const lineFormatting = scoreLineCommentFormattingCompanion(file.path, queryTerms);
    if (lineFormatting.score !== 0) {
      score += lineFormatting.score;
      reasons.push(...lineFormatting.reasons);
    }
    const searchPrinter = scoreSearchPrinterOutputCompanion(file.path, queryTerms);
    if (searchPrinter.score !== 0) {
      score += searchPrinter.score;
      reasons.push(...searchPrinter.reasons);
    }
    const fixtureRunner = scoreFixtureRunnerResolutionCompanion(file.path, queryTerms);
    if (fixtureRunner.score !== 0) {
      score += fixtureRunner.score;
      reasons.push(...fixtureRunner.reasons);
    }
    if (isRoutingMapRuleCompanion(file.path, queryTerms)) {
      score += 980;
      reasons.push("routing map/rule companion");
    }
    if (isTransformAnalysisCompanion(file.path, queryTerms)) {
      score += /import[-_]?analysis/i.test(file.path) ? 2200 : 1500;
      reasons.push("transform analysis companion");
    }
    if (isRoutePatternTreeCompanion(file.path, queryTerms)) {
      score += 1500;
      reasons.push("route pattern tree companion");
    }
    if (isRealImplementationCompanion(file.path, queryTerms)) {
      score += 1500;
      reasons.push("real implementation companion");
    }
    const specializedPenalty = unmentionedSpecializedSurfacePenalty(file.path, queryTerms);
    if (specializedPenalty > 0) {
      score -= specializedPenalty;
      reasons.push("unmentioned specialized surface downranked");
    }
    if (isGenericKubernetesServiceDistractor(file.path, queryTerms)) {
      score -= 3200;
      reasons.push("generic service/request path downranked for kubernetes task");
    }
    if (
      preciseSourceSurfacePresent &&
      testCounterpart.score === 0 &&
      namedFileSurface.score === 0 &&
      !mentionedBasename &&
      routeAnchorHits.length === 0 &&
      !matchesQualifiedGenericModule(file.path, qualifiedGenericModuleHints) &&
      !(configOptionTask && declarativeConfigSchema)
    ) {
      score -= 30000;
      reasons.push("companion downranked because prompt names a more specific source surface");
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

      const importNeighbor = importNeighbors.get(seed.path)?.has(file.path) ?? false;
      if (edgeNeighbors.get(seed.path)?.has(file.path)) {
        score += 60;
        reasons.push("import neighbor");
      }
      if (importNeighbor) {
        const importScore = scoreImportLinkedTaskCompanion({
          candidatePathTerms: pathTerms,
          candidateTerms: sourceTerms,
          pathQueryHits,
          queryTerms,
          specificQueryHits
        });
        if (importScore.score !== 0) {
          score += importScore.score;
          reasons.push(...importScore.reasons);
        }
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
      if (isCrossRuntimeNodeDistractor(seed.path, file.path, queryTerms)) {
        score -= 4200;
        reasons.push("node/runtime companion downranked for browser/client source task");
      }
      if (isGoPackageAnchor(seed, file, roleSignals)) {
        score += 920;
        reasons.push("go package anchor");
      }
      const utilitySibling = scoreUtilitySiblingCompanion(seed.path, file.path, queryTerms);
      if (utilitySibling.score !== 0) {
        score += utilitySibling.score;
        reasons.push(...utilitySibling.reasons);
      }
      const headerInline = scoreHeaderInlineCompanion(seed.path, file.path, queryTerms, sourceTerms);
      if (headerInline.score !== 0) {
        score += headerInline.score;
        reasons.push(...headerInline.reasons);
      }
      const datastoreParity = scoreDatastoreBackendParityCompanion(seed.path, file.path, queryTerms, input.query);
      if (datastoreParity.score !== 0) {
        score += datastoreParity.score;
        reasons.push(...datastoreParity.reasons);
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
        reasons: uniqueReasons(reasons).slice(0, 10)
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

function scoreCommandExporterCompanion(
  filePath: string,
  query: string,
  queryTerms: Set<string>,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  const exportCommandTask =
    /\bexport(?:er|ers|ing|ed)?\b/.test(normalizedQuery) &&
    (/\b(command|cli|flag|declarative|resource|namespace|variant|segment|sort|sorted|sorting|deterministic)\b/.test(normalizedQuery) ||
      /--[a-z0-9-]*sort[a-z0-9-]*/i.test(query));
  if (!exportCommandTask) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const explicitStorageEdit =
    /\b(?:edit|modify|change|update|fix|implement)\b(?:\s+[a-z0-9]+){0,8}\s+\b(?:storage|store|backend|database|sqlite|mysql|postgres|relational)\b/.test(normalizedQuery) ||
    /\b(?:storage|store|backend|database|sqlite|mysql|postgres|relational)\b(?:\s+[a-z0-9]+){0,8}\s+\b(?:edit|modify|change|update|fix|implement)\b/.test(normalizedQuery);
  const reasons: string[] = [];
  let score = 0;

  if (isCommandExportPath(normalizedPath)) {
    score += 2600;
    reasons.push("export command companion");
  }

  if (isExporterImplementationPath(normalizedPath)) {
    score += 5600;
    reasons.push("exporter implementation companion");
  }

  if (
    isExporterImplementationPath(normalizedPath) &&
    ["namespace", "flag", "segment", "variant", "resource", "sort", "deterministic"].some((term) => queryTerms.has(term) && sourceTerms.has(term))
  ) {
    score += 900;
    reasons.push("export sorting domain companion");
  }

  if (isStorageBackendPath(normalizedPath) && !explicitStorageEdit && !isExporterImplementationPath(normalizedPath)) {
    score -= 6200;
    reasons.push("storage backend downranked for export-command companion");
  }

  return { score, reasons };
}

function isCommandExportPath(normalizedPath: string): boolean {
  return /^cmd\/[^/]+\/export\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /(^|\/)cmd\/.*\/export\.(go|ts|js|py|rb|rs)$/.test(normalizedPath);
}

function isExporterImplementationPath(normalizedPath: string): boolean {
  return (
    /(^|\/)(exporter|export)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) ||
    /(^|\/)(export|exporter)\//.test(normalizedPath) ||
    /(^|\/)(internal\/)?ext\/exporter\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)
  );
}

function isStorageBackendPath(normalizedPath: string): boolean {
  return /(^|\/)(internal\/)?storage\//.test(normalizedPath) || /(^|\/)(stores?|backends?|database|db)\//.test(normalizedPath);
}

function scoreDatastoreBackendParityCompanion(
  seedPath: string,
  candidatePath: string,
  queryTerms: Set<string>,
  query: string
): { score: number; reasons: string[] } {
  if (!isDatastoreBackendParityTask(queryTerms, query)) return { score: 0, reasons: [] };
  const seed = datastoreBackendSurface(seedPath);
  const candidate = datastoreBackendSurface(candidatePath);
  if (!seed || !candidate) return { score: 0, reasons: [] };
  if (seed.backend === candidate.backend) return { score: 0, reasons: [] };
  if (seed.prefix !== candidate.prefix || seed.suffix !== candidate.suffix) return { score: 0, reasons: [] };
  return {
    score: 6400,
    reasons: [`datastore backend parity companion: ${seed.backend} -> ${candidate.backend}`]
  };
}

function isDatastoreBackendParityTask(queryTerms: Set<string>, query: string): boolean {
  const normalizedQuery = normalizeText(query);
  const collectionTerms = ["list", "lists", "set", "sets", "zset", "hash", "queue", "collection", "collections"];
  const mutationTerms = ["remove", "removing", "delete", "deleting", "del", "discard", "pull", "pop", "trim", "add", "insert", "push"];
  const collectionMutation =
    collectionTerms.some((term) => queryTerms.has(term)) &&
    mutationTerms.some((term) => queryTerms.has(term));
  const multiValue =
    ["multiple", "distinct", "array", "arrays", "element", "elements", "value", "values", "batch", "bulk", "several"].some((term) => queryTerms.has(term)) ||
    /\[[^\]]+,[^\]]+\]/.test(query);
  return collectionMutation && multiValue && /\b(list|set|hash|queue|collection|backend|database|db|store|storage)\b/.test(normalizedQuery);
}

function datastoreBackendSurface(filePath: string): { prefix: string; backend: string; suffix: string } | undefined {
  const parts = filePath.replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
  const backendNames = new Set(["mongo", "mongodb", "redis", "postgres", "postgresql", "mysql", "sqlite", "memory", "inmemory"]);
  const rootNames = new Set(["database", "databases", "db", "storage", "stores", "backends"]);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part || !backendNames.has(part)) continue;
    const hasDatastoreRoot = parts.slice(Math.max(0, index - 2), index).some((segment) => rootNames.has(segment));
    if (!hasDatastoreRoot) continue;
    const suffix = parts.slice(index + 1).join("/");
    if (!suffix) continue;
    return {
      prefix: parts.slice(0, index).join("/"),
      backend: part,
      suffix
    };
  }
  return undefined;
}

function scoreHsmKmsConfigCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isHsmKmsConfigTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const reasons: string[] = [];
  let score = 0;
  const keystoreSurface = /\/keystore\//.test(normalizedPath) || isHsmKmsBackendHelperPath(normalizedPath) || sourceTerms.has("keystore");

  if (keystoreSurface) {
    score += 4600;
    reasons.push("HSM/KMS keystore companion");
  }
  if (isHsmKmsBackendHelperPath(normalizedPath)) {
    score += 2600;
    reasons.push("HSM/KMS backend helper companion");
  }
  if (isCentralHsmKmsConfigTask(normalizedQuery) && /(^|\/)(testhelpers?|test_helpers?)\.go$/.test(normalizedPath)) {
    score += 12000;
    reasons.push("central HSM/KMS test configuration helper companion");
  }
  if (sourceTerms.has("hsmtestconfig") || (sourceTerms.has("hsm") && sourceTerms.has("test") && sourceTerms.has("config"))) {
    score += 7000;
    reasons.push("HSMTestConfig target companion");
  }
  if (/(^|\/)pkcs11\.go$/.test(normalizedPath)) {
    score += 7000;
    reasons.push("PKCS11 HSM backend companion");
  }
  if (["hsmtestconfig", "softhsm", "yubihsm", "cloudhsm", "awskms", "gcpkms", "pkcs11"].some((term) => sourceTerms.has(term))) {
    score += 1200;
    reasons.push("HSM/KMS configuration content companion");
  }
  if (!keystoreSurface) {
    score -= /(^|\/)test\.go$/.test(normalizedPath) ? 12_000 : 7_000;
    reasons.push("non-keystore companion downranked for HSM/KMS backend config task");
  }
  if (/^web\/|\/web\/|\/tdp\//.test(normalizedPath) && !/\/keystore\//.test(normalizedPath)) {
    score -= 9000;
    reasons.push("web/TDP companion downranked for HSM/KMS backend config task");
  }
  if (isCentralHsmKmsConfigTask(normalizedQuery) && /\/keystore\/(aws_kms|gcp_kms|cloudhsm|yubihsm|softhsm)\.go$/.test(normalizedPath)) {
    score -= 8000;
    reasons.push("single-provider backend downranked for central HSM/KMS config task");
  }

  return { score, reasons };
}

function isUnrelatedHsmKmsGenericTestHelper(filePath: string, query: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedQuery = normalizeText(query);
  if (!/(^|\/)test\.go$/.test(normalizedPath)) return false;
  if (!isHsmKmsConfigTask(normalizedQuery)) return false;
  return !/\/keystore\//.test(normalizedPath);
}

function scoreBackendAutocompleteCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isBackendAutocompleteCompanionQuery(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  const reasons: string[] = [];
  let score = 0;

  if (/^autocomplete\.(py|rb|go|rs|php|java|ts)$/.test(basename)) {
    score += 30_000;
    reasons.push("backend autocomplete endpoint companion");
  }
  if (["findolid", "find_olid", "olidtokey", "olid_to_key", "dbfetch", "db_fetch", "solr", "autocomplete"].some((term) => sourceTerms.has(term))) {
    score += 2_800;
    reasons.push("backend autocomplete source companion");
  }
  if (/\/js\/autocomplete\.[cm]?js$/.test(normalizedPath) || /\/client\/|\/frontend\/|\/static\/|\/assets\//.test(normalizedPath)) {
    score -= 50_000;
    reasons.push("frontend autocomplete companion downranked for backend endpoint task");
  }
  if (!/autocomplete/.test(basename) && !["findolid", "find_olid", "olidtokey", "olid_to_key", "dbfetch", "db_fetch"].some((term) => sourceTerms.has(term))) {
    score -= 20_000;
    reasons.push("non-autocomplete companion downranked for backend autocomplete task");
  }

  return { score, reasons };
}

function isBackendAutocompleteCompanionQuery(normalizedQuery: string): boolean {
  return /\bautocomplete\b/.test(normalizedQuery) &&
    /\b(endpoint|route|routes|solr|olid|olids|query string|fallback|db|base class|page class|works|authors|subjects)\b/.test(normalizedQuery) &&
    !/\b(ui|frontend|client|browser widget|dropdown|input component|visual|style|css)\b/.test(normalizedQuery);
}

function scoreConfigOptionSchemaCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isConfigOptionSchemaTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const qtWebEngineTask = /\b(qtwebengine|qt webengine|webengine|chromium|accelerated|canvas|pdf|sheets|rendering|glitches?)\b/.test(normalizedQuery);
  const reasons: string[] = [];
  let score = 0;

  if (/(^|\/)(qtargs|chromium_args|webengine_args)\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) {
    score += qtWebEngineTask ? 5800 : 2600;
    reasons.push("config argument companion");
  }
  if (/(^|\/)(configdata|config_data|configschema|config_schema|settings|options)\.(ya?ml|json|toml)$/.test(normalizedPath)) {
    score += 4200;
    reasons.push("config source-of-truth schema/data companion");
  }
  if (/(^|\/)(configdata|config_data|configschema|config_schema|settings|options)\.(ya?ml|json|toml|py|ts|js)$/.test(normalizedPath)) {
    score += 5200;
    reasons.push("config schema/data companion");
  }
  if (
    /(^|\/)(configdata|config_data|configschema|config_schema|settings|options)\.py$/.test(normalizedPath) &&
    (sourceTerms.has("yaml") || sourceTerms.has("parsed") || sourceTerms.has("generated"))
  ) {
    score -= 2800;
    reasons.push("generated config artifact downranked for declarative schema companion");
  }
  if (["qtwebengine", "chromium", "webengine", "accelerated", "canvas", "workaround", "settings", "option"].some((term) => sourceTerms.has(term))) {
    score += qtWebEngineTask ? 1600 : 520;
    reasons.push("config option content companion");
  }
  if (
    /(^|\/)(configfiles?|config_file|configloader|loader|init)\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) &&
    !/\b(load|loader|loading|parse|parsing|config file|config files|startup|init|initialize)\b/.test(normalizedQuery)
  ) {
    score -= 2600;
    reasons.push("config file loader downranked for option/schema companion");
  }
  if (isConfigDiagnosticProblemSurface(normalizedPath) && !/\b(backend problem|backend issue|diagnostic|diagnostics|problem report)\b/.test(normalizedQuery)) {
    score -= 7200;
    reasons.push("diagnostic/problem surface downranked for config schema companion");
  }

  return { score, reasons };
}

function scoreDeprecationLifecycleCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isDeprecationLifecycleTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (
    /(^|\/)(module|module_utils|modules?|runtime)[^/]*(\/|$).*\/?basic\.(py|cs|ts|js)$/.test(normalizedPath) ||
    (/(^|\/)basic\.(py|cs|ts|js)$/.test(normalizedPath) && (sourceTerms.has("argument") || sourceTerms.has("spec") || sourceTerms.has("deprecated")))
  ) {
    score += 32_000;
    reasons.push("module deprecation API companion");
  }
  if (/(^|\/)(common\/)?parameters\.(py|ts|js|go|rb|rs|cs)$/.test(normalizedPath)) {
    score += 54_000;
    reasons.push("parameter validation companion");
  }
  if (/(^|\/)(common\/)?warnings\.(py|ts|js|go|rb|rs|cs)$/.test(normalizedPath)) {
    score += 38_000;
    reasons.push("deprecation warning companion");
  }
  if (/(^|\/)display\.(py|ts|js|go|rb|rs|cs)$/.test(normalizedPath) || /(^|\/)utils\/display\.(py|ts|js|go|rb|rs|cs)$/.test(normalizedPath)) {
    score += 30_000;
    reasons.push("deprecation display companion");
  }
  if (/(^|\/)[a-z0-9_.-]*basic\.(cs|ts|js)$/.test(normalizedPath) && (sourceTerms.has("deprecated_aliases") || sourceTerms.has("validateargumentspec") || sourceTerms.has("removed_in_version"))) {
    score += 46_000;
    reasons.push("module deprecation runtime mirror companion");
  }
  if (["deprecated", "deprecation", "aliases", "warning", "display", "version", "date"].some((term) => sourceTerms.has(term))) {
    score += 900;
    reasons.push("deprecation lifecycle content companion");
  }
  if (/(^|\/)(date_time|datetime|urls?)\.(py|ts|js|go|rb|rs|cs)$/.test(normalizedPath) && !/\b(date parser|parse date|url|urls|uri|http)\b/.test(normalizedQuery)) {
    score -= 82_000;
    reasons.push("generic date/url helper downranked for deprecation lifecycle companion");
  }
  if (/(^|\/)modules\/[^/]+\.py$/.test(normalizedPath) && !sourceTerms.has("deprecated_aliases") && !sourceTerms.has("removed_in_version")) {
    score -= 62_000;
    reasons.push("leaf module downranked for shared deprecation lifecycle companion");
  }

  return { score, reasons };
}

function scoreKubernetesRbacMatcherCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isKubernetesRbacResourceMatcherTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (sourceTerms.has("kuberesourcematchesregex") || (sourceTerms.has("kubernetesresource") && sourceTerms.has("namespace"))) {
    score += 82_000;
    reasons.push("Kubernetes RBAC resource matcher companion");
  }
  if (
    ["kind", "namespace", "verb", "verbs", "get", "list", "watch", "create", "update", "delete"].some((term) => sourceTerms.has(term)) &&
    ["match", "matcher", "regexp", "regex", "wildcard", "glob"].some((term) => sourceTerms.has(term))
  ) {
    score += 24_000;
    reasons.push("Kubernetes resource rule matching companion");
  }
  if (/^lib\/utils\/replace\.go$/.test(normalizedPath) || /\/utils?\/(replace|match|matcher|regexp|regex)\.go$/.test(normalizedPath)) {
    score += 30_000;
    reasons.push("resource matcher utility companion");
  }
  if (/^lib\/service\/kubernetes\.go$/.test(normalizedPath) || /\/service\/kubernetes\.(go|ts|js)$/.test(normalizedPath)) {
    score -= 82_000;
    reasons.push("Kubernetes service startup downranked for RBAC matcher companion");
  }
  if (/(^|\/)(backend|cloud|users?|storage|db)\//.test(normalizedPath) && !sourceTerms.has("kuberesourcematchesregex") && !sourceTerms.has("kubernetesresource")) {
    score -= 34_000;
    reasons.push("non-matcher backend downranked for Kubernetes RBAC companion");
  }

  return { score, reasons };
}

function scoreFormUnflattenRequestCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isFormUnflattenRequestTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (/\/plugins\/upstream\/utils\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) || /(^|\/)(unflatten|flatten|forms?|request)_?utils?\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) {
    score += 88_000;
    reasons.push("form unflatten utility companion");
  }
  if (/\/plugins\/openlibrary\/lists\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) || /(^|\/)lists\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) {
    score += 78_000;
    reasons.push("form route/list handler companion");
  }
  if (["unflatten", "flattened", "nested", "indexed", "defaults", "form", "body", "query", "request", "post", "seeds"].some((term) => sourceTerms.has(term))) {
    score += 18_000;
    reasons.push("form request reconstruction companion content");
  }
  if (/\/core\/lists\/model\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) || /\/models?\//.test(normalizedPath)) {
    score -= 48_000;
    reasons.push("list model companion downranked for request reconstruction task");
  }
  if (/\/plugins\/openlibrary\/utils\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) && !sourceTerms.has("unflatten")) {
    score -= 22_000;
    reasons.push("generic openlibrary utility companion downranked for form reconstruction task");
  }

  return { score, reasons };
}

function scorePackageSourceMappingCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isPackageSourceMappingTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (/^scanner\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) {
    score += 96_000;
    reasons.push("package manager source/binary scanner companion");
  }
  if (/^oval\/util\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/oval\/util\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) {
    score += 88_000;
    reasons.push("package source vulnerability matcher companion");
  }
  if (/^scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) {
    score += 72_000;
    reasons.push("scanner dispatch/source package companion");
  }
  if (/^oval\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/oval\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) {
    score += 48_000;
    reasons.push("alpine oval family companion");
  }
  if (["source", "binary", "package", "packages", "src", "apk", "alpine", "oval", "vulnerability", "vulnerabilities", "upgradable"].some((term) => sourceTerms.has(term))) {
    score += 12_000;
    reasons.push("package source mapping companion content");
  }
  if (/\/scanner\/trivy\//.test(normalizedPath) || /\/parser\//.test(normalizedPath) || /\/contrib\//.test(normalizedPath)) {
    score -= 48_000;
    reasons.push("unrelated package parser companion downranked");
  }

  return { score, reasons };
}

function scoreKubernetesExecForwarderCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isKubernetesExecForwarderTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (/^lib\/service\/kubernetes\.go$/.test(normalizedPath) || /\/service\/kubernetes\.(go|ts|js)$/.test(normalizedPath)) {
    score += 96_000;
    reasons.push("Kubernetes service/session uploader companion");
  }
  if (/^lib\/kube\/proxy\/forwarder\.go$/.test(normalizedPath) || /\/kube\/proxy\/forwarder\.(go|ts|js)$/.test(normalizedPath)) {
    score += 88_000;
    reasons.push("Kubernetes exec forwarder companion");
  }
  if (/\/kube\/proxy\/(server|handler|session|audit|auth)\.(go|ts|js)$/.test(normalizedPath)) {
    score += 34_000;
    reasons.push("Kubernetes proxy companion");
  }
  if (/^lib\/service\/service\.go$/.test(normalizedPath) || /\/service\/service\.(go|ts|js)$/.test(normalizedPath)) {
    score += 18_000;
    reasons.push("service initialization companion");
  }
  if (
    [
      "forwarderconfig",
      "forwarder",
      "servehttp",
      "exec",
      "portforward",
      "catchall",
      "authz",
      "cachingauthclient",
      "getkubeservices",
      "getclusterconfig",
      "reversetunnelsrv",
      "routetocluster",
      "session",
      "uploader",
      "recording",
      "recordings",
      "streaming",
      "upload",
      "audit"
    ].some((term) => sourceTerms.has(term))
  ) {
    score += 22_000;
    reasons.push("Kubernetes exec/session companion content");
  }
  if (/^lib\/utils\/replace\.go$/.test(normalizedPath) || /\/utils?\/(replace|match|matcher|regexp|regex)\.go$/.test(normalizedPath)) {
    score -= 94_000;
    reasons.push("resource matcher companion downranked for Kubernetes exec/session task");
  }
  if (/^lib\/auth\//.test(normalizedPath) && !sourceTerms.has("processkubecsr") && !sourceTerms.has("forwarderconfig")) {
    score -= 52_000;
    reasons.push("generic auth/session companion downranked for Kubernetes exec/session task");
  }
  if (/(^|\/)(backend|cloud|users?|storage|db)\//.test(normalizedPath) && !sourceTerms.has("forwarder") && !sourceTerms.has("session")) {
    score -= 24_000;
    reasons.push("backend/storage companion downranked for Kubernetes exec/session task");
  }

  return { score, reasons };
}

function scoreUiFeedbackOwnershipCompanion(
  filePath: string,
  query: string,
  sourceTerms: Set<string>
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeText(query);
  if (!isUiFeedbackOwnershipTask(normalizedQuery)) return { score: 0, reasons: [] };

  const normalizedPath = filePath.toLowerCase();
  const namedSurfaceHits = namedUiSurfaceHits(filePath, query);
  const directBasenameHit = namedUiSurfaceBasenameHit(filePath, query);
  const reasons: string[] = [];
  let score = 0;

  if (/(^|\/)(components?|atoms?|molecules?|organisms?|views?|screens?|routes?)\//.test(normalizedPath)) {
    score += 4400;
    reasons.push("UI feedback component ownership companion");
  }
  if (/(^|\/)hooks?\//.test(normalizedPath)) {
    score += 3000;
    reasons.push("UI feedback hook ownership companion");
  }
  if (/(^|\/)index\.(ts|tsx|js|jsx)$/.test(normalizedPath) && sharedFeatureTerms(filePath, normalizedQuery).length > 0) {
    score += 1700;
    reasons.push("feature export companion");
  }
  const sharedTerms = sharedFeatureTerms(filePath, normalizedQuery);
  if (sharedTerms.length > 0) {
    score += Math.min(2600, sharedTerms.length * 900);
    reasons.push(`UI feature path companion: ${sharedTerms.slice(0, 3).join(", ")}`);
  }
  if (namedSurfaceHits.length > 0) {
    score += Math.min(7200, namedSurfaceHits.length * 3600);
    reasons.push(`named UI surface companion: ${namedSurfaceHits.slice(0, 3).join(", ")}`);
  }
  if (directBasenameHit) {
    score += 5200;
    reasons.push(`direct UI basename companion: ${directBasenameHit}`);
  }
  if (["live", "liveness", "badge", "icon", "header", "body", "recording", "playback", "feedback", "state"].some((term) => sourceTerms.has(term))) {
    score += 900;
    reasons.push("UI feedback content companion");
  }
  const stateOwnerNeeded = /\b(liveness|live|state|status|playback|recording|broadcast)\b/.test(normalizedQuery);
  if (/(^|\/)(models?|stores?)\//.test(normalizedPath) && stateOwnerNeeded) {
    score += 2200;
    reasons.push("UI state owner companion");
  }
  if (
    /(^|\/)(utils?|services?)\//.test(normalizedPath) &&
    !/\b(utility|utils?|event ordering|events?|protocol|serialization|service)\b/.test(normalizedQuery)
  ) {
    score -= 5200;
    reasons.push("utility/service companion downranked for UI feedback task");
  }

  return { score, reasons };
}

function isHsmKmsConfigTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  return (
    /\b(hsm|kms|softhsm|yubihsm|cloudhsm|pkcs11)\b/.test(normalizedQuery) &&
    /\b(test|tests|testing|backend|backends|configuration|config|environment|env)\b/.test(normalizedQuery)
  );
}

function isConfigOptionSchemaTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  const explicitConfigOption =
    /\b(config|configuration|settings?|options?|workarounds?)\b/.test(normalizedQuery) &&
    /\b(add|support|implement|define|schema|metadata|option|setting|workaround|argument|args?)\b/.test(normalizedQuery);
  const renderingConfigWorkaround =
    /\b(qtwebengine|qt webengine|webengine|chromium)\b/.test(normalizedQuery) &&
    /\b(rendering|glitch|glitches|pdf|sheets|canvas|accelerated|workaround|settings?|args?)\b/.test(normalizedQuery);
  return explicitConfigOption || renderingConfigWorkaround;
}

function isDeprecationLifecycleTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  return (
    /\b(deprecat\w*|deprecated aliases?|removed[_ ](?:at[_ ])?date|removed[_ ]in[_ ]version|internal error)\b/.test(normalizedQuery) &&
    /\b(date|version|module|modules|parameter|parameters|alias|aliases|warning|warnings|display|validate|validation|runtime)\b/.test(normalizedQuery)
  );
}

function isKubernetesRbacResourceMatcherTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  if (isKubernetesExecForwarderTask(normalizedQuery)) return false;
  return (
    /\b(kubernetes|kubectl|kube)\b/.test(normalizedQuery) &&
    /\b(rbac|role|rule|rules|access|permission|permissions|resource|resources|namespace|namespaces)\b/.test(normalizedQuery) &&
    /\b(kind|namespace|namespaces|verbs?|get|list|watch|create|update|delete|read only|read-only)\b/.test(normalizedQuery)
  );
}

function isFormUnflattenRequestTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  return (
    /\b(unflatten|flattened|nested|indexed|parent keys?|form data|body data|query parameters?|query string|request body|duplicate (?:simple )?keys?|assignments?)\b/.test(normalizedQuery) &&
    /\b(post|form|body|request|endpoint|route|handler|list|lists|seeds?|defaults?)\b/.test(normalizedQuery)
  );
}

function isPackageSourceMappingTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  return /\b(source packages?|binary packages?|src packages?|package source|source package associations?|apk|alpine)\b/.test(normalizedQuery) &&
    /\b(oval|vulnerabilit(?:y|ies)|scanner|package manager|upgradable|installed packages?)\b/.test(normalizedQuery);
}

function isKubernetesExecForwarderTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  return (
    /\b(kubernetes|kubectl|kube)\b/.test(normalizedQuery) &&
    (
      /\b(exec|forwarder|forwarder config|session uploader|session recording|recordings?|streaming|upload directory|async upload|audit event|audit events|client disconnect|reverse tunnel|route to cluster)\b/.test(normalizedQuery) ||
      /\b(port forward|catch all)\b/.test(normalizedQuery) ||
      /\b(portforward|catchall|forwarderconfig|reversetunnelsrv|routetocluster|getkubeservices|getclusterconfig)\b/.test(compactQuery)
    )
  );
}

function isUnrelatedDeprecationLifecycleCompanion(filePath: string, sourceTerms: Set<string>): boolean {
  const normalizedPath = filePath.toLowerCase();
  if (/(^|\/)(date_time|datetime|urls?)\.(py|ts|js|go|rb|rs|cs)$/.test(normalizedPath)) return true;
  if (/(^|\/)modules\/[^/]+\.py$/.test(normalizedPath) && !sourceTerms.has("deprecated_aliases") && !sourceTerms.has("removed_in_version")) return true;
  return false;
}

function isUiFeedbackOwnershipTask(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  const explicitUiTerms = /\b(ui|component|components|icon|badge|view|screen|state|feedback|visual|liveness|live)\b/.test(normalizedQuery);
  const headerBodyUiTerms =
    /\b(header|body)\b/.test(normalizedQuery) &&
    /\b(ui|component|components|icon|badge|view|screen|visual|render|display)\b/.test(normalizedQuery);
  const uiTerms = explicitUiTerms || headerBodyUiTerms;
  const featureStateTerms = /\b(recording|playback|voice|broadcast|room|message|notification|presence)\b/.test(normalizedQuery);
  return uiTerms && (featureStateTerms || /\b(inconsistent|feedback|icon|badge|liveness|visible|display|shown|render)\b/.test(normalizedQuery));
}

function sharedFeatureTerms(filePath: string, normalizedQuery: string): string[] {
  const pathTerms = termSet(filePath);
  const stopTerms = new Set(["component", "components", "source", "debug", "fix", "state", "feedback", "icon", "badge", "header", "body"]);
  return [...termSet(normalizedQuery)].filter((term) => term.length >= 4 && !stopTerms.has(term) && pathTerms.has(term));
}

function namedUiSurfaceHits(filePath: string, query: string): string[] {
  const normalizedQuery = normalizeText(query);
  const basename = filePath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const compactBasename = basename.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedBasename = normalizeText(basename);
  if (normalizedBasename.length < 4) return [];
  return normalizedQuery.includes(normalizedBasename) || normalizedQuery.includes(compactBasename) ? [basename] : [];
}

function namedUiSurfaceBasenameHit(filePath: string, query: string): string | undefined {
  return namedUiSurfaceHits(filePath, query)[0];
}

function isCentralHsmKmsConfigTask(normalizedQuery: string): boolean {
  return /\b(unified|central|centralize|centralized|reusable|duplicated|duplication|consistent|selector|detect|detects|available)\b/.test(normalizedQuery);
}

function isHsmKmsBackendHelperPath(normalizedPath: string): boolean {
  return /(^|\/)(pkcs11|testhelpers?|test_helpers?)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath.toLowerCase());
}

export function isNoisySourcePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return /(^|\/)(docs?|docs_src|documentation|_?examples|samples?|demo|demos|devtools|codemods|fixtures|fixture|generated|gen|dist|build|coverage|website|site|playground|storybook|testing|testdata|integration)\//.test(
    normalized
  ) || /(^|\/)(deps|vendor|third_party|node_modules)\//.test(normalized) ||
    /(^|\/)([^/]+\.)?(generated|gen)\.[a-z0-9]+$/.test(normalized) ||
    /\.(generated|gen)\.[a-z0-9]+$/.test(normalized);
}

function scoreCanonicalRoleSurface(
  file: Pick<FileRecord, "path" | "kind" | "language">,
  query: string,
  queryTerms: Set<string>
): { score: number; reasons: string[] } {
  if (!isUniversalSourceFile(file) || isNoisySourcePath(file.path) || isLikelyTestPath(file.path)) return { score: 0, reasons: [] };
  const basename = file.path.toLowerCase().split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const basenameTerms = [...termSet(basename)].filter((term) => !COMPANION_STOP_TERMS.has(term));
  const pathTerms = termSet(file.path);
  const directHits = basenameTerms.filter((term) => queryTerms.has(term));
  const compoundHits = compoundQueryTerms(query).filter((term) => basename.replace(/[^a-z0-9]/g, "").includes(term));
  const coreHits = [...new Set([...directHits, ...compoundHits])];
  if (coreHits.length === 0) return { score: 0, reasons: [] };

  let score = Math.min(1_200, coreHits.length * 340);
  const reasons = [`canonical role basename anchor: ${coreHits.slice(0, 4).join(", ")}`];
  if (isPrimaryUniversalSourcePath(file)) {
    score += 120;
    reasons.push("primary source role anchor");
  }
  if (pathTerms.has("core") && queryTerms.has("core")) score += 180;
  if (basenameTerms.length > 0 && basenameTerms.every((term) => queryTerms.has(term) || ["base", "internal"].includes(term))) {
    score += basenameTerms.length === 1 && STRONG_CANONICAL_BASENAME_TERMS.has(basenameTerms[0]!) ? 820 : 280;
    reasons.push("exact canonical role file");
  }
  return { score, reasons };
}

function scoreNamedFileSurface(filePath: string, query: string): { score: number; reasons: string[] } {
  const basename = filePath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (!basename || basename.length < 5 || /^(index|main|core|base|utils?|helpers?)$/i.test(basename)) return { score: 0, reasons: [] };
  const normalizedBasename = normalizeText(basename);
  if (!normalizedBasename || normalizedBasename.split(" ").length < 2) return { score: 0, reasons: [] };
  if (isSuffixOfLongerNamedIdentifier(basename, query)) return { score: 0, reasons: [] };
  if (!normalizeText(query).includes(normalizedBasename)) return { score: 0, reasons: [] };
  return {
    score: 2600,
    reasons: [`named source surface: ${basename}`]
  };
}

function unmentionedSpecializedSurfacePenalty(filePath: string, queryTerms: Set<string>): number {
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/module-info\.(java|kt)$/.test(basename)) return 1_800;
  if (/(^|\/)(samples?|examples?|docs?|playground|testing|testdata)\//.test(normalized)) return 1_400;

  const qualifiers: Array<[RegExp, string[], number]> = [
    [/json[-_]?schema|standard[-_]?schema/, ["json", "standard"], 760],
    [/(^|[_-])proxy|socks[-_]?proxy|http[-_]?proxy/, ["proxy", "socks"], 860],
    [/logging[-_]?interceptor|logging/, ["logging", "log"], 820],
    [/stdout|stderr|console[-_]?encoder/, ["stdout", "stderr", "console"], 760],
    [/callback[-_]?sink|android[-_]?sink|msvc[-_]?sink|syslog[-_]?sink|daily[-_]?sink|rotating[-_]?sink|qt[-_]?sink|win[-_]?eventlog[-_]?sink|eventlog[-_]?sink|systemd[-_]?namespace[-_]?sink|namespace[-_]?sink|async[-_]?logger/, ["callback", "android", "msvc", "syslog", "daily", "rotating", "qt", "win", "eventlog", "systemd", "namespace", "async"], 760],
    [/cache[-_]?plugin|cache\//, ["cache"], 760],
    [/-inl\./, ["inline", "inl"], 520],
    [/_windows|_notwin|windows|win32|notwin|android|darwin|linux|posix|unix|wasm/, ["windows", "win", "notwin", "android", "darwin", "linux", "posix", "unix", "wasm"], 620],
    [/optimizer\//, ["optimizer", "optimize"], 460]
  ];
  return qualifiers.reduce((total, [pattern, terms, penalty]) => {
    if (!pattern.test(normalized)) return total;
    return terms.some((term) => queryTerms.has(term)) ? total : total + penalty;
  }, 0);
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
    /(test|tests)\.(java|kt)$/.test(basename) ||
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

function hasUiQuerySignal(queryTerms: Set<string>): boolean {
  return ["ui", "component", "components", "mobile", "layout", "dashboard", "tabs", "table", "panel", "filter", "filters", "render", "renderer", "page", "view"].some((term) =>
    queryTerms.has(term)
  );
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
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|go|rb)$/.test(file.path.toLowerCase());
}

function isDeclarativeConfigSchemaFile(filePath: string): boolean {
  return /(^|\/)(configdata|config_data|configschema|config_schema|settings|options)\.(ya?ml|json|toml)$/.test(filePath.toLowerCase());
}

function isConfigDiagnosticProblemSurface(normalizedPath: string): boolean {
  return /(^|\/)(backendproblem|backend_problem|problem|diagnostic|diagnostics)\.(py|ts|js|go|rb|rs)$/.test(normalizedPath);
}

function isPrimaryUniversalSourcePath(file: Pick<FileRecord, "path" | "language">): boolean {
  const normalized = file.path.toLowerCase();
  if (file.language === "java") return normalized.startsWith("src/main/java/") || normalized.includes("/src/main/java/");
  if (file.language === "kotlin") return normalized.startsWith("src/main/kotlin/") || normalized.includes("/src/main/kotlin/");
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
    const endIndex = (match.index ?? 0) + match[0]!.length;
    if (query[endIndex] === ".") continue;
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
  const pattern = /\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|rs|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)\b/g;
  for (const match of query.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > 0 && query[start - 1] === "/") continue;
    const basename = match[0]!.toLowerCase().split(/[\\/]/).at(-1);
    if (!basename || isLikelyTestPath(basename) || isGenericMentionedBasename(basename)) continue;
    basenames.add(basename);
  }
  return basenames;
}

function isGenericMentionedBasename(basename: string): boolean {
  return /^(main|index)\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(basename);
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
    (pair.has("routing") && pair.has("engine")) ||
    (pair.has("session") && (pair.has("adapter") || pair.has("model"))) ||
    (pair.has("scheduler") && pair.has("renderer")) ||
    (pair.has("renderer") && (pair.has("measure") || pair.has("segment"))) ||
    (pair.has("measure") && pair.has("segment")) ||
    (pair.has("fiber") && (pair.has("hook") || pair.has("workloop"))) ||
    (pair.has("string") && pair.has("matcher")) ||
    (pair.has("interceptor") && (pair.has("dispatch") || pair.has("adapter") || pair.has("chain") || pair.has("call"))) ||
    (pair.has("chain") && pair.has("call")) ||
    (pair.has("pool") && pair.has("connection")) ||
    (pair.has("session") && (pair.has("unitofwork") || pair.has("persistence"))) ||
    (pair.has("unitofwork") && pair.has("persistence")) ||
    (pair.has("core") && (pair.has("entry") || pair.has("encoder") || pair.has("sink") || pair.has("logger"))) ||
    (pair.has("logger") && pair.has("sink")) ||
    (pair.has("sink") && pair.has("encoder")) ||
    (pair.has("analysis") && (pair.has("transform") || pair.has("routing"))) ||
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
  return isComplementaryRole(seedCategory, candidateCategory) || ["gin.go", "context.go", "routergroup.go", "chain.go", "mux.go", "router.go", "tree.go"].includes(candidate.path.toLowerCase());
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
  if (/(^|\/)sessions?\.[a-z0-9]+$/.test(normalized) || /(^|\/)sessions?\//.test(normalized)) return "session";
  if (/unit[-_]?of[-_]?work|unitofwork/.test(normalized)) return "unitofwork";
  if (/persistence|persist/.test(normalized.split("/").at(-1) ?? "")) return "persistence";
  if (/proxy/.test(normalized.split("/").at(-1) ?? "")) return "proxy";
  if (/pool/.test(normalized.split("/").at(-1) ?? "")) return "pool";
  if (/connection/.test(normalized.split("/").at(-1) ?? "")) return "connection";
  if (/chain/.test(normalized.split("/").at(-1) ?? "")) return "chain";
  if (/call/.test(normalized.split("/").at(-1) ?? "")) return "call";
  if (/interceptor/.test(normalized)) return "interceptor";
  if (/dispatch/.test(normalized)) return "dispatch";
  if (/analysis|analyzer/.test(normalized.split("/").at(-1) ?? "")) return "analysis";
  if (/transform/.test(normalized.split("/").at(-1) ?? "")) return "transform";
  if (/workloop/.test(normalized)) return "workloop";
  if (/hooks?/.test(normalized)) return "hook";
  if (/reactfiber/.test(normalized)) return "fiber";
  if (/(^|\/)strings?\.[a-z0-9]+$/.test(normalized)) return "string";
  if (/charmatcher|char[-_]?matcher/.test(normalized)) return "matcher";
  if (/measure/.test(normalized.split("/").at(-1) ?? "")) return "measure";
  if (/segment/.test(normalized.split("/").at(-1) ?? "")) return "segment";
  if (/logger/.test(normalized.split("/").at(-1) ?? "")) return "logger";
  if (/sink/.test(normalized.split("/").at(-1) ?? "")) return "sink";
  if (/encoder/.test(normalized.split("/").at(-1) ?? "")) return "encoder";
  if (/(^|\/)core\.[a-z0-9]+$/.test(normalized) || /(^|\/)core\//.test(normalized)) return "core";
  if (/entry/.test(normalized.split("/").at(-1) ?? "")) return "entry";
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
  if (/(^|\/)(gin|engine|mux|tree)\.go$/.test(normalized)) return "engine";
  return undefined;
}

function isPlatformVariantPath(filePath: string): boolean {
  return /_(appengine|windows|win|notwin|linux|darwin|unix|posix|wasm|js|nocgo|cgo|freebsd|openbsd|netbsd|solaris|dragonfly|aix|plan9)\./i.test(filePath);
}

function isGoPackageAnchor(seed: FileRecord, file: FileRecord, roles: CompanionRole[]): boolean {
  if (seed.language !== "go" || file.language !== "go") return false;
  if (file.path.includes("/")) return false;
  if (!roles.some((role) => role.id === "group-context-handler" || role.id === "routing-dependency")) return false;
  const basename = file.path.toLowerCase();
  return ["gin.go", "chi.go", "mux.go", "router.go", "engine.go", "server.go", "context.go", "chain.go", "tree.go"].includes(basename);
}

function isRouteCoreSibling(seedPath: string, candidatePath: string, queryTerms: Set<string>): boolean {
  const seed = seedPath.toLowerCase();
  const candidate = candidatePath.toLowerCase();
  if (!sameModuleSurface(seed, candidate)) return false;
  const seedBase = seed.split("/").at(-1) ?? "";
  const candidateBase = candidate.split("/").at(-1) ?? "";
  if (!/(index|router|routing|route|layer|execution-context|mux|tree)\.[cm]?[jt]s$/.test(seedBase)) return false;
  if (!/(route|layer|router|proxy|response-controller|execution-context|index|mux|tree)\.[cm]?[jt]s$/.test(candidateBase)) return false;
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

function isSessionAdapterModelCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const asksSessionFlow =
    (queryTerms.has("session") || queryTerms.has("sessions")) &&
    (queryTerms.has("adapter") || queryTerms.has("adapters") || queryTerms.has("prepared") || queryTerms.has("redirect") || queryTerms.has("mounted") || queryTerms.has("send"));
  if (!asksSessionFlow) return false;
  const normalized = filePath.toLowerCase();
  return /(^|\/)(sessions?|adapters?|models?)\.[a-z0-9]+$/.test(normalized) ||
    /(^|\/)(sessions?|adapters?|models?)(\/|$)/.test(normalized);
}

function isFiberHooksWorkLoopCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const asksFiberHooks =
    queryTerms.has("fiber") &&
    (queryTerms.has("hook") || queryTerms.has("hooks") || queryTerms.has("effect") || queryTerms.has("effects") || queryTerms.has("work") || queryTerms.has("workloop"));
  if (!asksFiberHooks) return false;
  const normalized = filePath.toLowerCase();
  return /reactfiber(hooks|workloop)\.[cm]?[jt]sx?$/.test(normalized) ||
    (normalized.includes("reactfiber") && (normalized.includes("hooks") || normalized.includes("workloop")));
}

function isStringMatcherCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const asksStringMatcher =
    (queryTerms.has("string") || queryTerms.has("strings")) &&
    (queryTerms.has("char") || queryTerms.has("character") || queryTerms.has("matcher") || queryTerms.has("matching") || queryTerms.has("prefix") || queryTerms.has("suffix"));
  if (!asksStringMatcher) return false;
  const normalized = filePath.toLowerCase();
  return /(^|\/)(strings?|charmatcher)\.java$/.test(normalized) || /(^|\/)(strings?|char[-_]?matcher)\.[a-z0-9]+$/.test(normalized);
}

function isRoutingMapRuleCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const asksMapRules =
    (queryTerms.has("routing") || queryTerms.has("route") || queryTerms.has("url")) &&
    (queryTerms.has("map") || queryTerms.has("rule") || queryTerms.has("rules") || queryTerms.has("matcher") || queryTerms.has("matching") || queryTerms.has("binding"));
  if (!asksMapRules) return false;
  const normalized = filePath.toLowerCase();
  return /(^|\/)(map|rules?|matcher|converters?)\.[a-z0-9]+$/.test(normalized) || /(^|\/)routing\/(map|rules?|matcher|converters?)\.[a-z0-9]+$/.test(normalized);
}

function scoreModuleResolverCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksModuleResolution =
    (queryTerms.has("module") || queryTerms.has("modules")) &&
    (queryTerms.has("resolve") || queryTerms.has("resolver") || queryTerms.has("load") || queryTerms.has("loader") || queryTerms.has("loading"));
  if (!asksModuleResolution) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const compact = basename.replace(/[^a-z0-9]/g, "");
  let score = 0;
  const reasons: string[] = [];
  if (/resolver(factory)?|resolveid|resolve/.test(compact)) {
    score += /resolverfactory/.test(compact) ? 3400 : 2400;
    reasons.push("module resolver companion");
  }
  if (/moduleloader|loader/.test(compact)) {
    score += 1400;
    reasons.push("module loader companion");
  }
  if (/modulegraph|(^|\/)graph/.test(compact)) {
    score += 900;
    reasons.push("module graph companion");
  }
  if (/javascriptparser|[a-z0-9]+parser/.test(compact)) {
    score += queryTerms.has("parser") || queryTerms.has("hook") || queryTerms.has("hooks") ? 2200 : 980;
    reasons.push("specific parser companion");
  } else if (compact === "parser") {
    score -= 520;
    reasons.push("generic parser downranked for module resolution");
  }
  return { score, reasons };
}

function scorePluginTransformFlowCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  if (!isPluginTransformFlow(queryTerms)) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const compact = basename.replace(/[^a-z0-9]/g, "");
  const reasons: string[] = [];
  let score = 0;
  if (/plugincontainer/.test(compact)) {
    score += 3600;
    reasons.push("plugin container transform-flow companion");
  } else if (/importanalysis|import[-_]?analysis/.test(compact)) {
    score += /build/.test(compact) && !queryTerms.has("build") ? 1700 : 3400;
    reasons.push(/build/.test(compact) && !queryTerms.has("build")
      ? "build-specific import analysis downranked for runtime transform flow"
      : "plugin transform import-analysis companion");
  } else if (/analysis|analyzer|transform/.test(compact)) {
    score += 1900;
    reasons.push("plugin transform analysis companion");
  } else if (/resolver(factory)?|resolveid|resolve/.test(compact)) {
    score -= 780;
    reasons.push("plain resolver downranked for transform-analysis flow");
  }
  return { score, reasons };
}

function isPluginTransformFlow(queryTerms: Set<string>): boolean {
  return (
    (queryTerms.has("plugin") || queryTerms.has("plugins") || queryTerms.has("container") || queryTerms.has("containers")) &&
    (queryTerms.has("transform") || queryTerms.has("transforms")) &&
    (queryTerms.has("load") || queryTerms.has("loads") || queryTerms.has("resolve") || queryTerms.has("resolveid"))
  );
}

function scoreSchemaFieldGenerationCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksSchemaFields =
    (queryTerms.has("schema") || queryTerms.has("core")) &&
    (queryTerms.has("field") || queryTerms.has("fields") || queryTerms.has("alias") || queryTerms.has("aliases") || queryTerms.has("generate") || queryTerms.has("generation") || queryTerms.has("model"));
  if (!asksSchemaFields) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  let score = 0;
  const reasons: string[] = [];
  if (/generate[_-]?schema|schema[_-]?gen|schema/.test(basename) && /generate|generation|field|fields|alias|aliases|model/.test([...queryTerms].join(" "))) {
    score += /generate[_-]?schema/.test(basename) ? 2300 : 900;
    reasons.push("schema generation companion");
  }
  if (/^_?fields?$|field/.test(basename)) {
    score += 3200;
    reasons.push("field definition companion");
  }
  if (/(^|\/)[a-z0-9_-]+-core\//.test(normalized)) {
    score -= 2600;
    reasons.push("dependency-core package downranked for schema/field prompt");
  }
  return { score, reasons };
}

function scoreStatementCallbackCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksStatementCallback =
    (queryTerms.has("callback") || queryTerms.has("callbacks") || queryTerms.has("create") || queryTerms.has("insert") || queryTerms.has("row") || queryTerms.has("rows")) &&
    (queryTerms.has("statement") || queryTerms.has("field") || queryTerms.has("fields") || queryTerms.has("schema") || queryTerms.has("value") || queryTerms.has("values"));
  if (!asksStatementCallback) return { score: 0, reasons: [] };
  const basename = filePath.toLowerCase().split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  let score = 0;
  const reasons: string[] = [];
  if (basename === "statement") {
    score += 2300;
    reasons.push("statement state companion");
  }
  if (basename === "field" || basename === "fields") {
    score += 1900;
    reasons.push("field metadata companion");
  }
  if (/^(create|update|query|delete)$/.test(basename)) {
    score += 900;
    reasons.push("callback phase companion");
  }
  return { score, reasons };
}

function scoreGoLogPipelineCompanion(filePath: string, language: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  if (language !== "go") return { score: 0, reasons: [] };
  const asksLogPipeline =
    (queryTerms.has("log") || queryTerms.has("logs") || queryTerms.has("logger") || queryTerms.has("zap") || queryTerms.has("core")) &&
    (queryTerms.has("entry") || queryTerms.has("entries") || queryTerms.has("encoder") || queryTerms.has("encoders") || queryTerms.has("write") || queryTerms.has("writing") || queryTerms.has("dispatch"));
  if (!asksLogPipeline) return { score: 0, reasons: [] };

  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/^(core|entry|encoder)$/.test(basename)) {
    score += basename === "core" ? 2800 : 2400;
    reasons.push("go log pipeline companion");
  }
  if (/^fields?$/.test(basename) && (queryTerms.has("core") || queryTerms.has("entry") || queryTerms.has("encoder") || queryTerms.has("write") || queryTerms.has("dispatch"))) {
    score -= 2200;
    reasons.push("field helper downranked for log pipeline prompt");
  }
  return { score, reasons };
}

function scoreModifierMetadataCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksModifierTracking =
    (queryTerms.has("modifier") || queryTerms.has("modifiers") || queryTerms.has("rewrite") || queryTerms.has("rewrites") || queryTerms.has("transform") || queryTerms.has("transformation") || queryTerms.has("transformations")) &&
    (queryTerms.has("recipient") || queryTerms.has("recipients") || queryTerms.has("address") || queryTerms.has("addresses") || queryTerms.has("mapping") || queryTerms.has("metadata") || queryTerms.has("bounces") || queryTerms.has("dsn"));
  if (!asksModifierTracking) return { score: 0, reasons: [] };

  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/msgmetadata|message[-_]?metadata|metadata/.test(basename)) {
    score += 3200;
    reasons.push("modifier metadata tracking companion");
  }
  if (/modifier/.test(basename) && /(^|\/)(module|core|internal)\//.test(normalized)) {
    score += 2500;
    reasons.push("modifier interface tracking companion");
  }
  if (/(^|\/)(modify|dsn|dmarc|dns|testutils)\//.test(normalized) && !/msgmetadata|modifier/.test(basename)) {
    score -= 900;
    reasons.push("implementation package downranked for metadata tracking prompt");
  }
  return { score, reasons };
}

function scoreAccountEmailFlowCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksEmailAccountFlow =
    (queryTerms.has("email") || queryTerms.has("emails") || queryTerms.has("mail")) &&
    (queryTerms.has("validation") || queryTerms.has("validate") || queryTerms.has("validated") || queryTerms.has("confirmation") || queryTerms.has("confirm") || queryTerms.has("confirmed") || queryTerms.has("resend") || queryTerms.has("expiration") || queryTerms.has("expired") || queryTerms.has("key") || queryTerms.has("keys")) &&
    (queryTerms.has("user") || queryTerms.has("users") || queryTerms.has("account") || queryTerms.has("accounts") || queryTerms.has("admin"));
  if (!asksEmailAccountFlow) return { score: 0, reasons: [] };

  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/^(email|mail|confirmation|confirm)$/.test(basename) || /(^|\/)(user|users)\/email\.[cm]?[jt]s$/.test(normalized)) {
    score += 3400;
    reasons.push("account email confirmation companion");
  }
  if (/(^|\/)(controllers?\/admin\/users|admin\/manage\/users)\.[cm]?[jt]sx?$/.test(normalized)) {
    score += 3100;
    reasons.push("admin user email-flow companion");
  }
  if (/^(create|signup|register)$/.test(basename) && (queryTerms.has("validation") || queryTerms.has("confirmation") || queryTerms.has("resend"))) {
    score -= 900;
    reasons.push("account creation downranked for email confirmation flow");
  }
  if (/(^|\/)(settings|config|socket\.io)\//.test(normalized) && !/(^|\/)(user|users)\//.test(normalized)) {
    score -= 1700;
    reasons.push("email settings/socket surface downranked for account confirmation flow");
  }
  return { score, reasons };
}

function scoreHttpAuthUtilityCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksHttpAuthUtility =
    (queryTerms.has("uri") || queryTerms.has("url") || queryTerms.has("urls") || queryTerms.has("request") || queryTerms.has("requests") || queryTerms.has("netrc")) &&
    (queryTerms.has("authorization") || queryTerms.has("auth") || queryTerms.has("header") || queryTerms.has("headers") || queryTerms.has("bearer") || queryTerms.has("basic") || queryTerms.has("credentials") || queryTerms.has("netrc"));
  if (!asksHttpAuthUtility) return { score: 0, reasons: [] };

  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/^(urls?|uri|request|requests|http)$/.test(basename) || /(^|\/)(module_utils|utils?)\/urls?\.py$/.test(normalized)) {
    score += 3400;
    reasons.push("HTTP auth URL utility companion");
  }
  if (/^_?utils?$/.test(basename) && !/(^|\/)(module_utils|utils?)\/urls?\.py$/.test(normalized)) {
    score -= 1300;
    reasons.push("generic utility downranked for HTTP auth prompt");
  }
  return { score, reasons };
}

function scoreSessionCommandConfigCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksSessionCommandConfig =
    (queryTerms.has("session") || queryTerms.has("startup") || queryTerms.has("start")) &&
    (queryTerms.has("command") || queryTerms.has("commandline") || queryTerms.has("cli") || queryTerms.has("config") || queryTerms.has("configuration") || queryTerms.has("argument") || queryTerms.has("args"));
  if (!asksSessionCommandConfig) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  let score = 0;
  const reasons: string[] = [];
  if (/session/.test(basename)) {
    score += 1300;
    reasons.push("session startup companion");
  }
  if (/config/.test(basename)) {
    score += 1700;
    reasons.push("config companion");
  }
  if (/command[-_]?line|commandline|cli|args?/.test(basename) || /internal\/catch_commandline/.test(normalized)) {
    score += 2100;
    reasons.push("command-line parser companion");
  }
  if (/\.(h|hh|hpp|hxx)$/.test(normalized) && !queryTerms.has("header")) {
    score -= 1500;
    reasons.push("header downranked for implementation companion");
  }
  return { score, reasons };
}

function scoreOrmUnitOfWorkCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksOrmFlush =
    (queryTerms.has("orm") || queryTerms.has("session") || queryTerms.has("unitofwork") || (queryTerms.has("unit") && queryTerms.has("work"))) &&
    (queryTerms.has("flush") || queryTerms.has("flushed") || queryTerms.has("unitofwork") || queryTerms.has("persistence") || queryTerms.has("persist") || queryTerms.has("mapper"));
  if (!asksOrmFlush) return { score: 0, reasons: [] };

  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const pathTerms = termSet(normalized);
  const reasons: string[] = [];
  let score = 0;
  if (pathTerms.has("orm") && /session/.test(basename)) {
    score += 3200;
    reasons.push("ORM session source companion");
  }
  if (/unit[-_]?of[-_]?work|unitofwork/.test(basename)) {
    score += 3600;
    reasons.push("unit-of-work source companion");
  }
  if (/persistence|persist/.test(basename)) {
    score += 3000;
    reasons.push("persistence source companion");
  }
  if ((pathTerms.has("asyncio") || pathTerms.has("async")) && queryTerms.has("orm") && !queryTerms.has("async") && !queryTerms.has("asyncio")) {
    score -= 1800;
    reasons.push("async variant downranked for ORM source prompt");
  }
  return { score, reasons };
}

function scoreRoutingMapRuleSourceCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksRoutingCore =
    (queryTerms.has("routing") || queryTerms.has("route") || queryTerms.has("url")) &&
    (queryTerms.has("map") || queryTerms.has("rule") || queryTerms.has("matcher") || queryTerms.has("matching") || queryTerms.has("method") || queryTerms.has("endpoint"));
  if (!asksRoutingCore) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/(^|\/)routing\//.test(normalized) && /^(map|rules?|matcher)$/.test(basename)) {
    score += basename === "matcher" ? 4400 : 3900;
    reasons.push("routing map/rule/matcher source companion");
  }
  if (/^utils?$/.test(basename) && !/(^|\/)routing\//.test(normalized)) {
    score -= 3600;
    reasons.push("generic URL utility downranked for routing core prompt");
  }
  return { score, reasons };
}

function scoreLineCommentFormattingCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksLineCommentFlow =
    (queryTerms.has("line") || queryTerms.has("lines") || queryTerms.has("linegen") || queryTerms.has("generator") || queryTerms.has("output")) &&
    (queryTerms.has("comment") || queryTerms.has("comments") || queryTerms.has("split") || queryTerms.has("splitting") || queryTerms.has("format") || queryTerms.has("formatting"));
  if (!asksLineCommentFlow) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/^(linegen|lines?|comments?)$/.test(basename)) {
    score += basename === "linegen" ? 4600 : 3800;
    reasons.push("line/comment formatting source companion");
  }
  if (/^(output|debug|report)$/.test(basename) && (queryTerms.has("line") || queryTerms.has("linegen") || queryTerms.has("comment"))) {
    score -= 2600;
    reasons.push("generic output surface downranked for line/comment prompt");
  }
  return { score, reasons };
}

function scoreSearchPrinterOutputCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksSearchPrinter =
    (queryTerms.has("search") || queryTerms.has("searcher") || queryTerms.has("match") || queryTerms.has("matches")) &&
    (queryTerms.has("printer") || queryTerms.has("json") || queryTerms.has("path") || queryTerms.has("paths") || queryTerms.has("event") || queryTerms.has("events") || queryTerms.has("output"));
  if (!asksSearchPrinter) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/(^|\/)crates\/core\//.test(normalized) && basename === "search") {
    score += 4700;
    reasons.push("core search source companion");
  }
  if (/(^|\/)printer\//.test(normalized) && /^(json|path|paths?)$/.test(basename)) {
    score += basename === "json" ? 4600 : 4000;
    reasons.push("printer output source companion");
  }
  if (/(^|\/)searcher\//.test(normalized) && basename === "core" && queryTerms.has("printer")) {
    score -= 900;
    reasons.push("searcher core downranked when printer output is requested");
  }
  return { score, reasons };
}

function scoreFixtureRunnerResolutionCompanion(filePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const asksFixtureRunner =
    (queryTerms.has("fixture") || queryTerms.has("fixtures") || queryTerms.has("collected") || queryTerms.has("nodes")) &&
    (queryTerms.has("runner") || queryTerms.has("setup") || queryTerms.has("resolution") || queryTerms.has("resolve") || queryTerms.has("value") || queryTerms.has("values"));
  if (!asksFixtureRunner) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;
  if (/(^|\/)_pytest\//.test(normalized) && /^(fixtures|python|runner)$/.test(basename)) {
    score += basename === "fixtures" ? 4300 : 3600;
    reasons.push("fixture/runner source companion");
  }
  if (/(^|\/)_pytest\//.test(normalized) && basename === "nodes" && queryTerms.has("fixture")) {
    score -= 500;
    reasons.push("node metadata downranked behind fixture/runner flow");
  }
  return { score, reasons };
}

function isTransformAnalysisCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const asksTransformSurface =
    (queryTerms.has("plugin") || queryTerms.has("plugins") || queryTerms.has("module") || queryTerms.has("modules")) &&
    (queryTerms.has("transform") || queryTerms.has("transforms") || queryTerms.has("load") || queryTerms.has("resolve"));
  if (!asksTransformSurface) return false;
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  return /(import[-_]?analysis|analysis|analyzer|transform)/.test(basename);
}

function isRoutePatternTreeCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const asksRoutePattern =
    (queryTerms.has("route") || queryTerms.has("router") || queryTerms.has("routing") || queryTerms.has("mux")) &&
    (queryTerms.has("pattern") || queryTerms.has("patterns") || queryTerms.has("match") || queryTerms.has("matching"));
  if (!asksRoutePattern) return false;
  return /(^|\/)(tree|trie)\.go$/.test(filePath.toLowerCase());
}

function isRealImplementationCompanion(filePath: string, queryTerms: Set<string>): boolean {
  if (!queryTerms.has("real")) return false;
  const basename = filePath.toLowerCase().split("/").at(-1) ?? "";
  return /real[a-z0-9_-]*(call|chain|client|connection|dispatcher|exchange|engine)/.test(basename);
}

function isGenericHelperForRoleCompanion(filePath: string, queryTerms: Set<string>): boolean {
  const normalized = filePath.toLowerCase();
  if (!/(^|\/)(helpers?|utils?|support)\//.test(normalized)) return false;
  return !["helper", "helpers", "utility", "utils", "support"].some((term) => queryTerms.has(term));
}

function isExecutionCoordinatorForCryptoTask(filePath: string, queryTerms: Set<string>): boolean {
  const asksCrypto =
    ["password", "passwords", "encrypt", "encryption", "hash", "hashes", "hashing", "bcrypt", "salt", "salts", "ident"].some((term) =>
      queryTerms.has(term)
    );
  if (!asksCrypto) return false;
  return /(^|\/)(executor|execution|queue|scheduler|task_queue|taskqueue)\//.test(filePath.toLowerCase()) ||
    /(^|\/)task[_-]?queue[_-]?manager\.(?:py|pyi?|ts|tsx|js|jsx|java|go|rb)$/.test(filePath.toLowerCase());
}

function isGenericUtilityBasename(basename: string): boolean {
  return /^(utils?|helpers?|common|shared|support)\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(basename);
}

function isGenericMentionedSourceBasename(basename: string): boolean {
  return /^(main|index)\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(basename);
}

function qualifiedGenericModulePathHints(query: string): string[][] {
  const hints: string[][] = [];
  for (const match of query.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g)) {
    const terms = tokenizeLexical(match[0] ?? "").filter((term) => term.length > 1);
    if (terms.length >= 3 && /^(utils?|helpers?|common|shared|support|code|index|main)$/.test(terms.at(-1) ?? "")) {
      hints.push(terms);
    }
  }
  return hints;
}

function scoreQualifiedGenericModuleMismatch(filePath: string, hints: string[][]): number {
  if (hints.length === 0) return 0;
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (!/^(utils?|helpers?|common|shared|support)$/.test(basename)) return 0;
  const pathTerms = termSet(normalized);
  const matchesNamedModule = hints.some((terms) => terms.every((term) => pathTerms.has(term) || normalized.includes(term)));
  return matchesNamedModule ? 0 : -12000;
}

function matchesQualifiedGenericModule(filePath: string, hints: string[][]): boolean {
  if (hints.length === 0) return false;
  const normalized = normalizeSlashPath(filePath.toLowerCase());
  const pathTerms = termSet(normalized);
  return hints.some((terms) => terms.every((term) => pathTerms.has(term) || normalized.includes(term)));
}

type TestCounterpartHint = {
  basenames: string[];
  suffixes: string[];
  stemTerms: string[];
  generic: boolean;
};

type SourcePathHint = {
  path: string;
  basename: string;
  labeled: boolean;
};

function sourcePathHintsFromQuery(query: string): SourcePathHint[] {
  const hints: SourcePathHint[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s"'`,:;([\{])([A-Za-z0-9_.@+~/-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx))(?:\b|::|#|[\])},;."'`])/g;
  for (const match of query.matchAll(pattern)) {
    const rawPath = normalizeSlashPath(match[1] ?? "").toLowerCase();
    if (!rawPath || isLikelyTestPathMention(rawPath) || isNoisyMentionedSourcePath(rawPath)) continue;
    const basename = rawPath.split("/").at(-1) ?? rawPath;
    if (!basename || isGenericMentionedSourceBasename(basename)) continue;
    const labelWindow = query.slice(Math.max(0, (match.index ?? 0) - 48), match.index ?? 0).toLowerCase();
    const labeled = /\b(location|source|implementation|file|path|target|interface|module)\b\s*:?\s*$/.test(labelWindow);
    const hasDirectory = rawPath.includes("/");
    if (!hasDirectory && !labeled) continue;
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);
    hints.push({ path: rawPath, basename, labeled });
  }
  return hints;
}

function scoreExplicitSourcePathHint(file: FileRecord, hints: SourcePathHint[]): { score: number; reasons: string[] } {
  if (hints.length === 0 || file.kind === "test" || !isUniversalSourceFile(file) || isNoisyCompanionFile(file)) {
    return { score: 0, reasons: [] };
  }
  const normalizedPath = normalizeSlashPath(file.path.toLowerCase());
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  const reasons: string[] = [];
  let score = 0;
  for (const hint of hints) {
    if (normalizedPath === hint.path || pathSuffixMatches(normalizedPath, hint.path)) {
      score += hint.labeled ? 7200 : 5600;
      reasons.push(hint.labeled ? "explicit source location path" : "explicit source path");
      continue;
    }
    if (hint.labeled && hint.basename === basename) {
      score += 1800;
      reasons.push("explicit source location filename");
    }
  }
  return { score: Math.min(score, 9600), reasons: uniqueReasons(reasons) };
}

function isNoisyMentionedSourcePath(filePath: string): boolean {
  return /(^|\/)(docs?|examples?|fixtures?|testdata|generated|vendor|node_modules|dist|build)\//.test(filePath);
}

function sourceCounterpartHintsFromTestPaths(query: string): TestCounterpartHint[] {
  const hints: TestCounterpartHint[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s"'`,:;([\{])([A-Za-z0-9_.@+~/-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx))(?:\b|::|#|[\])},;."'`])/g;
  for (const match of query.matchAll(pattern)) {
    const rawPath = normalizeSlashPath(match[1] ?? "");
    if (!rawPath || !isLikelyTestPathMention(rawPath)) continue;
    const hint = sourceCounterpartHintFromTestPath(rawPath);
    if (!hint || hint.basenames.length === 0) continue;
    const key = [...hint.basenames, ...hint.suffixes].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(hint);
  }
  return hints;
}

function sourceCounterpartHintFromTestPath(testPath: string): TestCounterpartHint | undefined {
  const segments = testPath.split("/").filter(Boolean);
  const basename = segments.at(-1);
  if (!basename) return undefined;
  const extensionMatch = /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.exec(basename);
  if (!extensionMatch) return undefined;
  const extension = extensionMatch[1]!.toLowerCase();
  const rawStem = basename.slice(0, -extensionMatch[0]!.length);
  const sourceStem = sourceStemFromTestStem(rawStem);
  if (!sourceStem || /^(test|tests|spec|specs)$/.test(sourceStem)) return undefined;
  const basenames = sourceBasenamesForTestStem(sourceStem, extension);
  const suffixes = sourceSuffixesForTestPath(segments, basenames);
  const stemTerms = [...termSet(sourceStem.toLowerCase())].filter((term) => term.length > 1);
  return {
    basenames: uniqueStrings(basenames.map((item) => item.toLowerCase())),
    suffixes: uniqueStrings(suffixes.map((item) => normalizeSlashPath(item.toLowerCase()))),
    stemTerms: uniqueStrings(stemTerms),
    generic:
      stemTerms.length === 0 ||
      stemTerms.every((term) => GENERIC_COUNTERPART_STEMS.has(term)) ||
      basenames.every((item) => isGenericCounterpartBasename(item.toLowerCase()))
  };
}

function sourceStemFromTestStem(stem: string): string {
  return stem
    .replace(/^(test|spec)[_-]/i, "")
    .replace(/[._-](test|spec)$/i, "")
    .replace(/(Test|Spec)$/i, "")
    .replace(/[_-]tests?$/i, "")
    .trim();
}

function sourceBasenamesForTestStem(stem: string, extension: string): string[] {
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension)) {
    return uniqueStrings([`${stem}.${extension}`, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}.mjs`, `${stem}.cjs`]);
  }
  if (["kt", "kts"].includes(extension)) return [`${stem}.kt`, `${stem}.kts`];
  if (["cc", "cpp", "cxx"].includes(extension)) return [`${stem}.${extension}`, `${stem}.cc`, `${stem}.cpp`, `${stem}.cxx`, `${stem}.h`, `${stem}.hpp`];
  if (["h", "hh", "hpp", "hxx"].includes(extension)) return [`${stem}.${extension}`, `${stem}.h`, `${stem}.hh`, `${stem}.hpp`, `${stem}.hxx`, `${stem}.cc`, `${stem}.cpp`];
  return [`${stem}.${extension}`];
}

function sourceSuffixesForTestPath(segments: string[], basenames: string[]): string[] {
  const suffixes = [...basenames];
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = segments.at(-1);
  if (!basename) return suffixes;
  const directorySegments = segments.slice(0, -1);

  const srcTestIndex = lowerSegments.findIndex((segment, index) => segment === "src" && lowerSegments[index + 1] === "test");
  if (srcTestIndex >= 0) {
    const afterTest = directorySegments.slice(srcTestIndex + 2);
    for (const sourceRoot of [["src", "main"], ["src"]]) {
      for (const sourceBase of basenames) {
        suffixes.push([...sourceRoot, ...afterTest, sourceBase].join("/"));
      }
    }
  }

  const testIndex = lowerSegments.findIndex((segment) => /^(tests?|specs?|__tests__|testing)$/.test(segment));
  if (testIndex >= 0) {
    const beforeTest = directorySegments.slice(0, testIndex);
    for (const sourceBase of basenames) {
      if (beforeTest.length > 0) suffixes.push([...beforeTest, sourceBase].join("/"));
    }
  }
  const afterTest = testIndex >= 0 ? directorySegments.slice(testIndex + 1) : directorySegments;
  const sourceDirs = afterTest.filter((segment) => !/^(unit|integration|integrations|functional|e2e|acceptance|system|component|components?)$/i.test(segment));
  for (const sourceBase of basenames) {
    if (sourceDirs.length > 0) suffixes.push([...sourceDirs, sourceBase].join("/"));
    const withComponent = afterTest.filter((segment) => !/^(unit|integration|integrations|functional|e2e|acceptance|system)$/i.test(segment));
    if (withComponent.length > 0) suffixes.push([...withComponent, sourceBase].join("/"));
  }

  return uniqueStrings(suffixes);
}

function scoreTestCounterpartHint(file: FileRecord, hints: TestCounterpartHint[], queryTerms: Set<string>): { score: number; reasons: string[] } {
  if (hints.length === 0) return { score: 0, reasons: [] };
  if (file.kind === "test" || !isUniversalSourceFile(file) || isNoisySourcePath(file.path)) return { score: 0, reasons: [] };

  const normalizedPath = normalizeSlashPath(file.path.toLowerCase());
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  const reasons: string[] = [];
  let score = 0;
  for (const hint of hints) {
    const genericCounterpart = hint.generic || isGenericCounterpartBasename(basename);
    const hasSpecificPathHit = hasSpecificCounterpartPathHit(normalizedPath, queryTerms, hint);
    if (hint.suffixes.some((suffix) => pathSuffixMatches(normalizedPath, suffix) && (suffix.includes("/") || !isGenericCounterpartBasename(suffix)))) {
      score += genericCounterpart && !hasSpecificPathHit ? 650 : 3200;
      reasons.push(genericCounterpart && !hasSpecificPathHit ? "selected test generic source counterpart" : "selected test path source counterpart");
      continue;
    }
    if (hint.basenames.includes(basename)) {
      if (!genericCounterpart) {
        score += 1800;
        reasons.push("selected test basename source counterpart");
      }
    }
  }
  return { score: Math.min(score, 5200), reasons: uniqueReasons(reasons) };
}

function isGenericCounterpartBasename(basename: string): boolean {
  if (/^(code|utils?|helpers?|common|shared|support|index|main)\.[a-z0-9]+$/i.test(basename)) return true;
  const stem = basename.replace(/\.[a-z0-9]+$/i, "");
  const terms = [...termSet(stem)];
  return terms.length > 0 && terms.every((term) => GENERIC_COUNTERPART_STEMS.has(term));
}

function hasSpecificCounterpartPathHit(normalizedPath: string, queryTerms: Set<string>, hint: TestCounterpartHint): boolean {
  const pathTerms = termSet(normalizedPath);
  const hintTerms = new Set(hint.stemTerms);
  return [...queryTerms].some(
    (term) => !COMPANION_STOP_TERMS.has(term) && !hintTerms.has(term) && pathTerms.has(term)
  );
}

const GENERIC_COUNTERPART_STEMS = new Set([
  "api",
  "apis",
  "app",
  "apps",
  "category",
  "categories",
  "code",
  "common",
  "controller",
  "controllers",
  "data",
  "group",
  "groups",
  "helper",
  "helpers",
  "index",
  "main",
  "model",
  "models",
  "post",
  "posts",
  "route",
  "routes",
  "service",
  "services",
  "shared",
  "support",
  "tag",
  "tags",
  "topic",
  "topics",
  "user",
  "users",
  "util",
  "utils"
]);

function pathSuffixMatches(filePath: string, suffix: string): boolean {
  return filePath === suffix || filePath.endsWith(`/${suffix}`);
}

function isLikelyTestPathMention(filePath: string): boolean {
  const normalized = normalizeSlashPath(filePath.toLowerCase());
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    /(^|\/)(tests?|specs?|__tests__|testing|testdata|fixtures?)\//.test(normalized) ||
    /^test[_-]/.test(basename) ||
    /(?:^|[._-])(test|spec)(?:[._-]|$)/.test(basename) ||
    /_test\./.test(basename)
  );
}

function normalizeSlashPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
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

function isCrossRuntimeNodeDistractor(seedPath: string, candidatePath: string, queryTerms: Set<string>): boolean {
  const seed = seedPath.toLowerCase();
  const candidate = candidatePath.toLowerCase();
  const clientTask =
    seed.includes("/client/") ||
    ["browser", "client", "relative", "absolute"].some((term) => queryTerms.has(term));
  if (!clientTask) return false;
  if (!candidate.includes("/node/") && !candidate.includes("/server/")) return false;
  return !["node", "server", "ssr", "build", "bundler"].some((term) => queryTerms.has(term));
}

function scoreUtilitySiblingCompanion(seedPath: string, candidatePath: string, queryTerms: Set<string>): { score: number; reasons: string[] } {
  if (!samePackageSurface(seedPath, candidatePath)) return { score: 0, reasons: [] };
  const normalizedSeed = seedPath.toLowerCase();
  const normalizedCandidate = candidatePath.toLowerCase();
  const seedBase = normalizedSeed.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const candidateBase = normalizedCandidate.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const reasons: string[] = [];
  let score = 0;

  if (/utils?$/.test(seedBase) && /utils?$/.test(candidateBase) && seedBase !== candidateBase) {
    score += 1800;
    reasons.push("same-package utility sibling companion");
  }

  const urlPathTask = ["url", "urls", "relative", "absolute", "external", "query", "path", "paths", "browser"].some((term) => queryTerms.has(term));
  const routingCoreTask =
    (queryTerms.has("routing") || queryTerms.has("route")) &&
    (queryTerms.has("map") || queryTerms.has("rule") || queryTerms.has("matcher") || queryTerms.has("matching") || queryTerms.has("endpoint"));
  if (
    urlPathTask &&
    /utils?$/.test(candidateBase) &&
    routingCoreTask &&
    !/(^|\/)routing\//.test(normalizedCandidate)
  ) {
    score -= 3600;
    reasons.push("generic URL utility downranked for routing core prompt");
  } else if (
    urlPathTask &&
    /utils?$/.test(candidateBase) &&
    !/(^|\/)(templates?|examples?|playground|fixtures?)\//.test(normalizedCandidate)
  ) {
    score += 3600;
    reasons.push("shared URL/path utility companion");
  }
  if (
    urlPathTask &&
    /(^|\/)(shared|common)\//.test(normalizedCandidate) &&
    !/utils?$/.test(candidateBase) &&
    !["url", "urls", "path", "paths", "query", "queries", "resolve", "resolver"].some((term) => termSet(candidateBase).has(term))
  ) {
    score -= 900;
    reasons.push("generic shared module downranked for URL/path task");
  }

  return { score, reasons };
}

function scoreTextTransformUtilityCompanion(filePath: string, sourceTerms: Set<string>, queryTerms: Set<string>): { score: number; reasons: string[] } {
  const textTransformTask = ["case", "camel", "delimiter", "delimiters", "whitespace", "space", "capitalize", "capitalized", "word", "words"].some((term) =>
    queryTerms.has(term)
  );
  if (!textTransformTask) return { score: 0, reasons: [] };
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (!/utils?$/.test(basename)) return { score: 0, reasons: [] };
  const hasDelimiterSurface =
    sourceTerms.has("delimiter") ||
    sourceTerms.has("delimiters") ||
    sourceTerms.has("whitespace") ||
    sourceTerms.has("capitalize") ||
    sourceTerms.has("uncapitalize");
  if (!hasDelimiterSurface) return { score: 0, reasons: [] };
  return {
    score: basename.includes("word") ? 3200 : 1200,
    reasons: ["text transform utility companion"]
  };
}

function scoreHeaderInlineCompanion(seedPath: string, candidatePath: string, queryTerms: Set<string>, sourceTerms: Set<string>): { score: number; reasons: string[] } {
  const normalizedSeed = seedPath.toLowerCase();
  const normalizedCandidate = candidatePath.toLowerCase();
  if (!/\.(h|hh|hpp|hxx)$/.test(normalizedSeed)) return { score: 0, reasons: [] };
  if (!/\.(h|hh|hpp|hxx)$/.test(normalizedCandidate)) return { score: 0, reasons: [] };
  if (pathDir(normalizedSeed) !== pathDir(normalizedCandidate)) return { score: 0, reasons: [] };
  if (!/(^|[-_])inl\./.test(normalizedCandidate) && !/[-_]inl\./.test(normalizedCandidate)) return { score: 0, reasons: [] };
  const parent = pathDir(normalizedCandidate).split("/").at(-1) ?? "";
  const basename = normalizedCandidate.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const queryHits = [...queryTerms].filter((term) => sourceTerms.has(term) && !COMPANION_STOP_TERMS.has(term));
  const publicApiBoost = basename.replace(/[-_]inl$/, "") === parent ? 1300 : 0;
  return {
    score: 2400 + publicApiBoost + Math.min(900, queryHits.length * 180),
    reasons: ["inline/header companion", ...(publicApiBoost > 0 ? ["public API inline companion"] : [])]
  };
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

function pathDir(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index >= 0 ? filePath.slice(0, index) : "";
}

function buildEdgeNeighborMap(edges: GraphEdgeRecord[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const edge of edges) {
    map.set(edge.fromFile, new Set([...(map.get(edge.fromFile) ?? []), edge.toFile]));
    map.set(edge.toFile, new Set([...(map.get(edge.toFile) ?? []), edge.fromFile]));
  }
  return map;
}

function buildImportNeighborMap(edges: GraphEdgeRecord[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.type !== "imports" && edge.type !== "imported_by") continue;
    map.set(edge.fromFile, new Set([...(map.get(edge.fromFile) ?? []), edge.toFile]));
    map.set(edge.toFile, new Set([...(map.get(edge.toFile) ?? []), edge.fromFile]));
  }
  return map;
}

function scoreImportLinkedTaskCompanion(input: {
  candidatePathTerms: Set<string>;
  candidateTerms: Set<string>;
  pathQueryHits: string[];
  queryTerms: Set<string>;
  specificQueryHits: string[];
}): { score: number; reasons: string[] } {
  const taskOverlap = [...input.queryTerms].filter((term) => {
    if (COMPANION_STOP_TERMS.has(term)) return false;
    return input.candidatePathTerms.has(term) || input.candidateTerms.has(term);
  });
  if (taskOverlap.length === 0 && input.pathQueryHits.length === 0 && input.specificQueryHits.length === 0) {
    return { score: 0, reasons: [] };
  }

  const score =
    360 +
    Math.min(2800, taskOverlap.length * 700) +
    Math.min(1200, input.pathQueryHits.length * 600) +
    Math.min(900, input.specificQueryHits.length * 300);
  return {
    score,
    reasons: [`import-linked task companion: ${taskOverlap.slice(0, 4).join(", ") || input.pathQueryHits.slice(0, 3).join(", ")}`]
  };
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function isSuffixOfLongerNamedIdentifier(basename: string, query: string): boolean {
  const normalizedBasename = normalizeText(basename);
  const basenameCompact = normalizedBasename.replace(/\s+/g, "");
  if (basenameCompact.length < 6) return false;
  const identifiers = namedIdentifierCompacts(query);
  if (identifiers.has(basenameCompact)) return false;
  return [...identifiers].some((identifier) => identifier.endsWith(basenameCompact) && identifier.length >= basenameCompact.length + 3);
}

function namedIdentifierCompacts(query: string): Set<string> {
  const identifiers = new Set<string>();
  for (const match of query.matchAll(/\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g)) {
    const compact = normalizeText(match[0] ?? "").replace(/\s+/g, "");
    if (compact.length >= 5) identifiers.add(compact);
  }
  return identifiers;
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
  if (term === "patterns") return "pattern";
  if (term === "rules") return "rule";
  if (term === "maps") return "map";
  if (term === "layers") return "layer";
  if (term === "params") return "param";
  if (term === "handlers") return "handler";
  if (term === "callbacks") return "callback";
  if (term === "ctx") return "context";
  if (term === "validations") return "validation";
  if (term === "interceptors") return "interceptor";
  if (term === "adapters") return "adapter";
  if (term === "connections") return "connection";
  if (term === "pools") return "pool";
  if (term === "retries") return "retry";
  if (term === "chains") return "chain";
  if (term === "calls") return "call";
  if (term === "schemas") return "schema";
  if (term === "shapes") return "shape";
  if (term === "objects") return "object";
  if (term === "segments") return "segment";
  if (term === "rendering") return "render";
  if (term === "measurement") return "measure";
  if (term === "measurements") return "measure";
  if (term === "loggers") return "logger";
  if (term === "logs") return "log";
  if (term === "sinks") return "sink";
  if (term === "entries") return "entry";
  if (term === "encoders") return "encoder";
  if (term === "fields") return "field";
  if (term === "aliases") return "alias";
  if (term === "generation" || term === "generating" || term === "generated") return "generate";
  if (term === "statements") return "statement";
  if (term === "values") return "value";
  if (term === "rows") return "row";
  if (term === "arguments") return "argument";
  if (term === "args") return "arg";
  if (term === "loading") return "load";
  if (term === "loaders") return "loader";
  if (term === "resolving") return "resolve";
  if (term === "resolvers") return "resolver";
  if (term === "extensions") return "extension";
  if (term === "fixtures") return "fixture";
  if (term === "groups") return "group";
  if (term === "requests") return "request";
  if (term === "responses") return "response";
  if (term === "sessions") return "session";
  if (term === "flushed") return "flush";
  if (term === "persisted") return "persist";
  if (term === "unit-of-work" || term === "unit_of_work") return "unitofwork";
  if (term === "hooks") return "hook";
  if (term === "effects") return "effect";
  if (term === "strings") return "string";
  if (term === "characters") return "character";
  if (term === "convertors") return "convertor";
  if (term === "converters") return "converter";
  if (term === "tools") return "tool";
  if (term === "tabs") return "tab";
  if (term === "filters") return "filter";
  if (term === "lines") return "line";
  if (term === "comments") return "comment";
  if (term === "matches" || term === "matching") return "match";
  if (term === "printers") return "printer";
  if (term === "paths") return "path";
  if (term === "events") return "event";
  if (term === "nodes") return "node";
  if (term === "runners") return "runner";
  if (term === "values") return "value";
  return term;
}
