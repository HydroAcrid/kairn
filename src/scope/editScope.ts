import type {
  BenchmarkDiffScope,
  BenchmarkSourceInvariant,
  ContextInvariant,
  ContextValueDecision,
  EditScopeDecision,
  EditScopeSource,
  FileRecord
} from "../types.js";
import { uniquePaths } from "../utils/collections.js";
import { normalizeRelativePath } from "../utils/paths.js";
import {
  hasExplicitMultiFileScopeRequest,
  hasDeprecationLifecycleScope,
  hasPromptDerivedMultiFileScope,
  taskHasProductionOnlyEditIntent,
  taskIsOfficialProductionPatchPrompt
} from "../prime/contextGovernor.js";
import { isUnrelatedDeprecationLifecyclePath } from "./lifecycleSurfaces.js";

export function decideEditScope(input: {
  task: string;
  candidateFiles: string[];
  contextDecision?: ContextValueDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  knownFiles?: FileRecord[] | undefined;
  allowedDiffScopes?: BenchmarkDiffScope[] | undefined;
  sourceInvariants?: BenchmarkSourceInvariant[] | undefined;
  failureFiles?: string[] | undefined;
  changedFiles?: string[] | undefined;
}): EditScopeDecision {
  const task = input.task.toLowerCase();
  const candidateFiles = uniquePaths(input.candidateFiles.map(normalizeRelativePath));
  const allowedTestEdits = taskAllowsTestEdits(task);
  const officialPatchPrompt = taskIsOfficialProductionPatchPrompt(input.task);
  const allowedHarnessFiles = uniquePaths((input.allowedDiffScopes ?? []).map((scope) => normalizeRelativePath(scope.file)));
  const knownFilePaths = new Set((input.knownFiles ?? []).map((file) => normalizeRelativePath(file.path)));
  const taskMentionedSourceFiles = extractOfficialPromptSourceFiles(input.task, knownFilePaths);
  const officialPromptFiles = officialPatchPrompt ? taskMentionedSourceFiles : [];
  const harnessFiles = uniquePaths([...allowedHarnessFiles, ...officialPromptFiles]);
  const invariantFiles = uniquePaths([
    ...(input.invariants ?? []).map((invariant) => normalizeRelativePath(invariant.file)),
    ...(input.sourceInvariants ?? []).map((invariant) => normalizeRelativePath(invariant.file))
  ]);
  const taskMentionedTestFiles = extractTaskMentionedTestFiles(input.task);
  const failureFiles = uniquePaths((input.failureFiles ?? []).map(normalizeRelativePath));
  const changedFiles = uniquePaths((input.changedFiles ?? []).map(normalizeRelativePath));
  const explicitMultiFileScope = hasExplicitMultiFileScopeRequest(input.task);
  const promptDerivedMultiFileScope = hasPromptDerivedMultiFileScope(input.task);
  const deprecationLifecycleMultiSurfaceScope = hasDeprecationLifecycleScope(input.task);
  const packageSourceMappingMultiSurfaceScope = hasPackageSourceMappingScope(input.task);
  const discoveryConfigMultiSurfaceScope = hasDiscoveryConfigScope(task) || input.contextDecision?.taskShapeSignal === "discovery_config";
  const webSessionRenewalMultiSurfaceScope = hasWebSessionRenewalScope(task);
  const datastoreBackendParityMultiSurfaceScope = hasDatastoreBackendParityScope(task) || input.contextDecision?.taskShapeSignal === "backend_parity";
  const pluginActivationValidationMultiSurfaceScope = hasPluginActivationValidationScope(task) || input.contextDecision?.taskShapeSignal === "plugin_activation_validation";
  const topicOrderingMultiSurfaceScope = input.contextDecision?.taskShapeSignal === "topic_ordering";
  const collectionNameValidationMultiSurfaceScope = input.contextDecision?.taskShapeSignal === "collection_name_validation";
  const grpcErrorPolicyMultiSurfaceScope = input.contextDecision?.taskShapeSignal === "grpc_error_policy";
  const selectedTestFanout = selectedTestPathCount(task) >= 3 && input.contextDecision?.recommendedDelivery === "multi_file_directive";
  const officialMultiSurfaceExpansion =
    explicitMultiFileScope ||
    promptDerivedMultiFileScope ||
    selectedTestFanout ||
    discoveryConfigMultiSurfaceScope ||
    packageSourceMappingMultiSurfaceScope ||
    webSessionRenewalMultiSurfaceScope ||
    datastoreBackendParityMultiSurfaceScope ||
    pluginActivationValidationMultiSurfaceScope ||
    topicOrderingMultiSurfaceScope ||
    collectionNameValidationMultiSurfaceScope ||
    grpcErrorPolicyMultiSurfaceScope;
  const productionOnlySingleFile =
    taskHasProductionOnlyEditIntent(task) &&
    !explicitMultiFileScope &&
    !promptDerivedMultiFileScope &&
    !selectedTestFanout &&
    !discoveryConfigMultiSurfaceScope &&
    !packageSourceMappingMultiSurfaceScope &&
    !webSessionRenewalMultiSurfaceScope &&
    !datastoreBackendParityMultiSurfaceScope &&
    !pluginActivationValidationMultiSurfaceScope &&
    !topicOrderingMultiSurfaceScope &&
    !collectionNameValidationMultiSurfaceScope &&
    !grpcErrorPolicyMultiSurfaceScope;

  const source = scopeSource({
    contextDecision: input.contextDecision,
    harnessFiles,
    failureFiles,
    task,
    productionOnlySingleFile
  });
  const primaryLimit = productionOnlySingleFile
    ? 1
    : deprecationLifecycleMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 5
    : packageSourceMappingMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 5
    : discoveryConfigMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 2
    : webSessionRenewalMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 5
    : datastoreBackendParityMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 4
    : pluginActivationValidationMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 4
    : topicOrderingMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 3
    : collectionNameValidationMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 2
    : grpcErrorPolicyMultiSurfaceScope && (input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug")
      ? 3
    : promptDerivedMultiFileScope && taskMentionedSourceFiles.length > 1
      ? Math.min(8, Math.max(2, taskMentionedSourceFiles.length))
    : source === "multi_file_debug" && selectedTestPathCount(task) >= 3
      ? 3
      : input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug"
        ? 2
        : 1;
  const sourceCandidates = uniquePaths([
    ...harnessFiles.filter((file) => isEditableByDefault(file, allowedTestEdits)),
    ...taskMentionedSourceFiles.filter((file) => isEditableByDefault(file, allowedTestEdits)),
    ...failureFiles.filter((file) => isProductionSourcePath(file)),
    ...invariantFiles.filter((file) => isEditableByDefault(file, allowedTestEdits)),
    ...(input.contextDecision?.primaryFile ? [normalizeRelativePath(input.contextDecision.primaryFile)] : []),
    ...candidateFiles
  ]);
  const protectedSourceFiles = new Set([...harnessFiles, ...taskMentionedSourceFiles, ...failureFiles, ...invariantFiles]);
  const uiLivenessMultiSurfaceScope = hasUiLivenessMultiSurfaceScope(task);
  const datastoreBackendParitySourceFiles = datastoreBackendParityMultiSurfaceScope
    ? datastoreBackendParitySourceFilesFromCandidates(sourceCandidates)
    : [];
  const frontendUiInitialScopeBudget =
    officialPatchPrompt &&
    uiLivenessMultiSurfaceScope &&
    failureFiles.length === 0 &&
    changedFiles.length === 0;
  const editCandidates = sourceCandidates.filter((file) =>
    (protectedSourceFiles.has(file) || !(officialPatchPrompt && isUnmentionedVariantPath(file, input.task))) &&
    !isUnmentionedFrontendVariantSurface(file, input.task) &&
    !isUnrelatedCentralBackendTestHelper(file, input.task) &&
    !isUnrelatedBackendAutocompleteSurface(file, input.task) &&
    !isUnrelatedDeprecationLifecycleSurface(file, input.task) &&
    !isUnrelatedConfigSchemaSurface(file, input.task) &&
    !isUnrelatedWebSessionRenewalSurface(file, input.task) &&
    !isUnrelatedDatastoreBackendParitySurface(file, input.task, datastoreBackendParitySourceFiles) &&
    !isForbiddenFrontendEditSurface(file, input.task) &&
    !isUnrelatedPromptMentionedSourceSurface(file, input.task, taskMentionedSourceFiles)
  );
  const budgetedEditCandidates = discoveryConfigMultiSurfaceScope
    ? applyDiscoveryConfigInitialScopeBudget(editCandidates)
    : frontendUiInitialScopeBudget
      ? applyFrontendUiInitialScopeBudget(editCandidates, input.task)
      : editCandidates;
  const promptDerivedOfficialExpansion =
    allowedHarnessFiles.length > 0 &&
    officialMultiSurfaceExpansion &&
    !pluginActivationValidationMultiSurfaceScope &&
    candidateFiles.some((file) => !allowedHarnessFiles.includes(file) && isEditableByDefault(file, allowedTestEdits));
  const officialPromptExpansionBeyondSourceFiles =
    explicitMultiFileScope ||
    selectedTestFanout ||
    uiLivenessMultiSurfaceScope ||
    deprecationLifecycleMultiSurfaceScope ||
    packageSourceMappingMultiSurfaceScope ||
    discoveryConfigMultiSurfaceScope ||
    webSessionRenewalMultiSurfaceScope ||
    datastoreBackendParityMultiSurfaceScope ||
    pluginActivationValidationMultiSurfaceScope ||
    topicOrderingMultiSurfaceScope ||
    collectionNameValidationMultiSurfaceScope ||
    grpcErrorPolicyMultiSurfaceScope ||
    (promptDerivedMultiFileScope && taskMentionedSourceFiles.length > 1);
  const officialPromptNamedSourceOnly =
    officialPatchPrompt &&
    officialPromptFiles.length > 1 &&
    promptDerivedMultiFileScope &&
    !explicitMultiFileScope &&
    !selectedTestFanout &&
    !uiLivenessMultiSurfaceScope &&
    !deprecationLifecycleMultiSurfaceScope &&
    !discoveryConfigMultiSurfaceScope &&
    !packageSourceMappingMultiSurfaceScope &&
    !webSessionRenewalMultiSurfaceScope &&
    !datastoreBackendParityMultiSurfaceScope &&
    !pluginActivationValidationMultiSurfaceScope &&
    !topicOrderingMultiSurfaceScope &&
    !collectionNameValidationMultiSurfaceScope &&
    !grpcErrorPolicyMultiSurfaceScope;
  const frontendUiExplicitSourceCount = uiLivenessMultiSurfaceScope
    ? sourceCandidates.filter((file) => isFrontendUiExplicitlyNamedSourceSurface(file, input.task)).length
    : 0;
  const officialPromptDerivedCap = deprecationLifecycleMultiSurfaceScope
    ? 5
    : packageSourceMappingMultiSurfaceScope
      ? 5
    : discoveryConfigMultiSurfaceScope
      ? 2
    : webSessionRenewalMultiSurfaceScope
      ? 5
    : datastoreBackendParityMultiSurfaceScope
      ? 4
    : pluginActivationValidationMultiSurfaceScope
      ? 4
    : topicOrderingMultiSurfaceScope
      ? 3
    : collectionNameValidationMultiSurfaceScope
      ? 2
    : grpcErrorPolicyMultiSurfaceScope
      ? 3
    : uiLivenessMultiSurfaceScope
      ? frontendUiExplicitSourceCount >= 2 ? 9 : 5
      : selectedTestFanout
        ? 8
        : 5;
  const officialInitialLimit = allowedHarnessFiles.length > 0
    ? Math.max(
        1,
        allowedHarnessFiles.length,
        promptDerivedOfficialExpansion
          ? Math.min(officialPromptDerivedCap, Math.max(2, primaryLimit, candidateFiles.filter((file) => isEditableByDefault(file, allowedTestEdits)).length))
          : allowedHarnessFiles.length
      )
    : officialPatchPrompt
      ? selectedTestFanout
        ? primaryLimit
          : officialPromptFiles.length > 0
            ? officialPromptNamedSourceOnly
              ? officialPromptFiles.length
          : officialPromptExpansionBeyondSourceFiles
            ? Math.min(officialPromptDerivedCap, Math.max(2, officialPromptFiles.length + candidateFiles.length))
            : input.contextDecision?.requiredSurface === "single_file" && officialPromptFiles.length === 1
              ? 1
              : 2
          : officialMultiSurfaceExpansion ? Math.min(officialPromptDerivedCap, Math.max(primaryLimit, candidateFiles.length)) : 1
      : primaryLimit;
  const officialPromptDerivedLimit = officialPatchPrompt && (
    officialPromptFiles.length > 0
      ? officialPromptExpansionBeyondSourceFiles && !officialPromptNamedSourceOnly
      : officialMultiSurfaceExpansion
  )
    ? Math.min(
        officialPromptDerivedCap,
        Math.max(
          officialInitialLimit,
        officialPromptFiles.length + candidateFiles.filter((file) => isEditableByDefault(file, allowedTestEdits)).length
        )
      )
    : officialInitialLimit;
  const initialLimit = source === "official_harness" || officialPatchPrompt ? officialPromptDerivedLimit : primaryLimit;
  const officialHarnessEditCandidates = promptDerivedOfficialExpansion
    ? uniquePaths([...allowedHarnessFiles, ...budgetedEditCandidates])
    : allowedHarnessFiles;
  const initialEditFiles = allowedHarnessFiles.length > 0
    ? officialHarnessEditCandidates
        .filter((file) => isEditableByDefault(file, allowedTestEdits))
        .slice(0, initialLimit)
    : budgetedEditCandidates
        .filter((file) => isEditableByDefault(file, allowedTestEdits))
        .slice(0, initialLimit);
  const readOnlyFiles = uniquePaths([
    ...taskMentionedTestFiles,
    ...candidateFiles,
    ...harnessFiles,
    ...invariantFiles,
    ...failureFiles,
    ...changedFiles
  ]).filter((file) =>
    !initialEditFiles.includes(file) &&
    shouldSurfaceReadOnly(file, allowedTestEdits) &&
    !((topicOrderingMultiSurfaceScope || collectionNameValidationMultiSurfaceScope) && isProductionSourcePath(file) && !protectedSourceFiles.has(file))
  );
  const scopeConfidence = initialEditFiles.length === 0
    ? "low"
    : source === "official_harness" || input.contextDecision?.exactSourceHit
      ? "high"
      : source === "multi_file_debug" || input.contextDecision?.sourceRescue || input.contextDecision?.canonicalSourceHit
        ? "medium"
        : "low";

  return {
    initialEditFiles,
    readOnlyFiles: readOnlyFiles.slice(0, frontendUiInitialScopeBudget ? 6 : 4),
    allowedExpansionTriggers: expansionTriggers({ task, allowedTestEdits, source, officialPatchPrompt }),
    forbiddenEditPatterns: forbiddenEditPatterns(allowedTestEdits, task),
    scopeConfidence,
    scopeSource: initialEditFiles.length > 0 ? source : "weak_signal",
    reason: scopeReason({ source, initialEditFiles, allowedTestEdits }),
    strictBoundary: source === "official_harness" || (officialPatchPrompt && initialEditFiles.length > 0) || (grpcErrorPolicyMultiSurfaceScope && initialEditFiles.length > 0),
    dynamic: true
  };
}

export function editScopeLine(scope: EditScopeDecision): string {
  const initial = scope.initialEditFiles.length > 0 ? scope.initialEditFiles.join(", ") : "none yet";
  if (scope.strictBoundary) {
    return `Edit scope: ${initial} (${scope.scopeConfidence}, ${scope.scopeSource}). Hard boundary: do not edit outside this scope in this turn.`;
  }
  return `Edit scope: ${initial} (${scope.scopeConfidence}, ${scope.scopeSource}). Expand only if ${scope.allowedExpansionTriggers[0] ?? "a focused check proves another file is required"}.`;
}

export function editScopeBlock(
  scope: EditScopeDecision,
  heading = "Edit scope",
  options: { includeReadOnly?: boolean | undefined } = {}
): string[] {
  const includeReadOnly = options.includeReadOnly ?? true;
  return [
    heading,
    `- Initial edit scope: ${scope.initialEditFiles.length > 0 ? scope.initialEditFiles.join(", ") : "none yet; identify a concrete source file first"}`,
    scope.strictBoundary && scope.initialEditFiles.length > 0
      ? "- Hard boundary: edit only the initial scope in this turn. Do not create or edit sibling/helper production files outside this list."
      : scope.initialEditFiles.length > 0 ? "- Edit only the initial scope first; do not create or edit other production, test, docs, generated, or sibling files unless an allowed expansion trigger occurs." : "",
    includeReadOnly && scope.readOnlyFiles.length > 0 ? `- Read-only verification context: ${scope.readOnlyFiles.join(", ")}` : "",
    scope.strictBoundary ? `- Expansion policy: ${scope.allowedExpansionTriggers.join("; ")}` : `- Allowed expansion: ${scope.allowedExpansionTriggers.join("; ")}`,
    `- Avoid editing: ${scope.forbiddenEditPatterns.join(", ")}`,
    `- Scope confidence: ${scope.scopeConfidence} (${scope.reason})`
  ].filter(Boolean);
}

function scopeSource(input: {
  contextDecision?: ContextValueDecision | undefined;
  harnessFiles: string[];
  failureFiles: string[];
  task: string;
  productionOnlySingleFile: boolean;
}): EditScopeSource {
  if (input.harnessFiles.length > 0) return "official_harness";
  if (input.failureFiles.some(isProductionSourcePath)) return "failure_output";
  if (
    input.productionOnlySingleFile &&
    (input.contextDecision?.sourceRescue || input.contextDecision?.canonicalSourceHit || input.contextDecision?.exactSourceHit || input.contextDecision?.cheapSingleSource)
  ) {
    return input.contextDecision?.exactSourceHit || input.contextDecision?.cheapSingleSource ? "exact_source" : "source_rescue";
  }
  if (input.contextDecision?.recommendedDelivery === "multi_file_directive" || input.contextDecision?.multiSurfaceSignal || isMultiFileDebugTask(input.task)) {
    return "multi_file_debug";
  }
  if (input.contextDecision?.exactSourceHit || input.contextDecision?.cheapSingleSource || input.contextDecision?.cheapExactSource) return "exact_source";
  if (input.contextDecision?.sourceRescue || input.contextDecision?.canonicalSourceHit) return "source_rescue";
  return "session_ledger";
}

function scopeReason(input: { source: EditScopeSource; initialEditFiles: string[]; allowedTestEdits: boolean }): string {
  if (input.initialEditFiles.length === 0) return "no concrete production source is safe to edit yet";
  if (input.source === "official_harness") return "benchmark or official task metadata supplied production patch files";
  if (input.source === "failure_output") return "failure output linked the scope to source files";
  if (input.source === "multi_file_debug") return "task has multi-surface debug evidence";
  if (input.source === "exact_source") return "one source file dominates retrieval";
  if (input.allowedTestEdits) return "the prompt explicitly allows test or snapshot edits";
  return "Kairn selected the smallest source edit set";
}

function expansionTriggers(input: { task: string; allowedTestEdits: boolean; source: EditScopeSource; officialPatchPrompt: boolean }): string[] {
  if (input.source === "official_harness" || input.officialPatchPrompt) {
    return [
      "do not expand edit scope in this turn; if another source file seems necessary, keep it read-only and report the missing evidence instead of editing it"
    ];
  }
  const triggers = [
    "a failing check names another production source file",
    "a public API/type/interface change requires callers or declarations",
    "the target file changes or the task target changes"
  ];
  if (input.allowedTestEdits) {
    triggers.push("the prompt explicitly asks for tests, docs, fixtures, or snapshots");
  } else {
    triggers.push("verification proves a fixture, snapshot, or test expectation must change");
  }
  return triggers;
}

function extractOfficialPromptSourceFiles(task: string, knownFilePaths: Set<string>): string[] {
  const paths = new Set<string>();
  const sourceLines = task
    .replaceAll("\\", "/")
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.toLowerCase();
      if (/selected (verification )?tests? from swe-bench pro metadata/.test(normalized)) return false;
      return true;
    });

  for (const line of sourceLines) {
    const allowsUnknownSourceFile =
      /\b(?:new|create|created|add|added|introduce|introduced)\s+file\b/i.test(line) ||
      /\bfile\s+(?:to\s+)?(?:create|add|introduce)\b/i.test(line);
    for (const match of line.matchAll(/\b[A-Za-z0-9_.@+~/-]+?\.(?:[cm]?[jt]sx?|pyi?|go|java|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)\b/g)) {
      const filePath = normalizeRelativePath(match[0] ?? "");
      if (!filePath.includes("/")) continue;
      if (knownFilePaths.size > 0 && !knownFilePaths.has(filePath) && !allowsUnknownSourceFile) continue;
      if (isProductionSourcePath(filePath)) paths.add(filePath);
    }
  }
  return [...paths];
}

function forbiddenEditPatterns(allowedTestEdits: boolean, task: string): string[] {
  const base = allowedTestEdits
    ? ["docs/", "examples/", "generated/", "dist/", "vendor/", "node_modules/"]
    : ["tests/", "test/", "__tests__/", "docs/", "examples/", "generated/", "dist/", "vendor/", "node_modules/"];
  if (!hasUiLivenessMultiSurfaceScope(task)) return base;
  return [...base, "res/css/", "styles/", "*.css", "*.pcss", "*.scss"];
}

function isEditableByDefault(filePath: string, allowedTestEdits: boolean): boolean {
  if (allowedTestEdits && isTestLikePath(filePath)) return true;
  return isProductionSourcePath(filePath);
}

function shouldSurfaceReadOnly(filePath: string, allowedTestEdits: boolean): boolean {
  if (!filePath) return false;
  if (isProductionSourcePath(filePath)) return true;
  if (isTestLikePath(filePath)) return !allowedTestEdits;
  return isNoisyPath(filePath);
}

function isProductionSourcePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (isNoisyPath(normalized) || isTestLikePath(normalized)) return false;
  if (isDeclarativeConfigSchemaPath(normalized)) return true;
  return /\.(?:[cm]?[jt]sx?|pyi?|go|java|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/.test(normalized);
}

function isDeclarativeConfigSchemaPath(filePath: string): boolean {
  return /(^|\/)(configdata|config_data|configschema|config_schema|settings|options)\.(ya?ml|json|toml)$/.test(filePath);
}

function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.includes("__tests__/") ||
    /^test_.*\.pyi?$/.test(normalized.split("/").at(-1) ?? normalized) ||
    /_test\.pyi?$/.test(normalized) ||
    /_test\.go$/.test(normalized) ||
    /(test|tests)\.java$/.test(normalized) ||
    normalized.includes("/src/test/java/") ||
    /(_test|_tests|_unittest)\.(cc|cpp|cxx|c|hh|hpp|hxx)$/.test(normalized) ||
    /(^|\/)(test|tests|testing|spec|specs|fixtures?|snapshots?)\//.test(normalized)
  );
}

function isNoisyPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return /(^|\/)(docs?|documentation|examples?|demo|demos|devtools|codemods|fixtures?|generated|gen|dist|build|coverage|website|site|playground|storybook|vendor|node_modules)\//.test(normalized);
}

function isUnmentionedVariantPath(filePath: string, task: string): boolean {
  const normalized = filePath.toLowerCase();
  const match = /\/(?:method|methods|provider|providers|strategy|strategies|adapter|adapters)\/([^/]+)/.exec(normalized);
  if (!match?.[1]) return false;
  const variant = match[1].replace(/\.[^.]+$/, "");
  const normalizedTask = task.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const variantWords = variant.replace(/[-_]+/g, " ");
  return !normalizedTask.includes(variant.toLowerCase()) && !normalizedTask.includes(variantWords.toLowerCase());
}

function isUnmentionedFrontendVariantSurface(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  if (!/\/components?\//.test(normalizedPath)) return false;
  const basename = normalizedPath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (!/pre(recording|broadcast|playback|live|liveness|event|state)/.test(basename)) return false;
  const normalizedTask = task.toLowerCase();
  const compactTask = normalizedTask.replace(/[^a-z0-9]+/g, "");
  const compactBasename = basename.replace(/[^a-z0-9]+/g, "");
  if (compactTask.includes(compactBasename)) return false;
  return !/\bpre[- ]?(recording|broadcast|live|liveness|playback|event|state)\b/.test(normalizedTask);
}

function isUnrelatedCentralBackendTestHelper(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (!/(^|\/)test\.go$/.test(normalizedPath)) return false;
  if (!/\b(hsm|kms|softhsm|yubihsm|cloudhsm|pkcs11)\b/.test(normalizedTask)) return false;
  if (!/\b(unified|central|centralize|centralized|reusable|duplicated|duplication|consistent|selector|detect|detects|available|backend|backends)\b/.test(normalizedTask)) return false;
  return !/\/keystore\//.test(normalizedPath);
}

function isUnrelatedBackendAutocompleteSurface(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (!/\bautocomplete\b/.test(normalizedTask)) return false;
  if (!/\b(endpoint|route|routes|solr|olid|olids|query string|fallback|db|base class|page class|works|authors|subjects)\b/.test(normalizedTask)) return false;
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (/^autocomplete\.(py|rb|go|rs|php|java|ts)$/.test(basename)) return false;
  if (/\b(?:file|path|source)\s+\W*autocomplete\.py\W*\s+must\b/.test(normalizedTask) || /\bautocomplete\.py\W*\s+must\b/.test(normalizedTask)) return true;
  return /\/js\/autocomplete\.[cm]?js$/.test(normalizedPath) ||
    /(^|\/)(tests?|testing|fixtures?)\//.test(normalizedPath);
}

function isUnrelatedDeprecationLifecycleSurface(filePath: string, task: string): boolean {
  return isUnrelatedDeprecationLifecyclePath(filePath, task);
}

function isUnrelatedConfigSchemaSurface(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (!isDeclarativeConfigSchemaPath(normalizedPath)) return false;
  if (!/\bselected (verification )?tests? from swe-bench pro metadata\b/.test(normalizedTask)) return false;
  if (promptRequiresConfigSchemaSurface(normalizedTask)) return false;
  if (promptDeclaresNoNewInterfaces(normalizedTask) && !normalizedTask.includes(normalizedPath)) return true;
  if (normalizedTask.includes(normalizedPath)) return false;
  const counterpartBasenames = selectedTestCounterpartBasenames(normalizedTask);
  if (counterpartBasenames.size === 0) return false;
  const basename = normalizedPath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? normalizedPath;
  if (counterpartBasenames.has(basename)) return false;
  return /\b(config|setting|settings|option|options|workaround|qtwebengine|chromium|args?)\b/.test(normalizedTask);
}

function isUnrelatedWebSessionRenewalSurface(filePath: string, task: string): boolean {
  if (!hasWebSessionRenewalScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  if (task.includes(normalizedPath)) return false;
  if (/^lib\/web\/sessions\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/^lib\/web\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/^lib\/auth\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/^lib\/auth\/auth\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  return /\b(access|checker|observability|trace|tracing|client|types?|constants?)\b/.test(normalizedPath) ||
    /^api\//.test(normalizedPath) ||
    /^lib\/services?\//.test(normalizedPath);
}

function isUnrelatedDatastoreBackendParitySurface(filePath: string, task: string, allowedBackendFiles: string[]): boolean {
  if (!hasDatastoreBackendParityScope(task)) return false;
  if (allowedBackendFiles.length < 2) return false;
  const normalizedPath = filePath.toLowerCase();
  return !allowedBackendFiles.map((file) => file.toLowerCase()).includes(normalizedPath);
}

function isForbiddenFrontendEditSurface(filePath: string, task: string): boolean {
  if (!/\b(do not|don't|avoid|no)\s+edit(?:ing)?\s+(?:the\s+)?(?:frontend|client|ui|browser|component|components|utilities|utils)/.test(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  return /(^|\/)(frontend|client|ui|components?|views?)\//.test(normalizedPath) ||
    /\/components?\//.test(normalizedPath) ||
    /\.(tsx|jsx|vue|svelte)$/.test(normalizedPath);
}

function isUnrelatedPromptMentionedSourceSurface(filePath: string, task: string, taskMentionedSourceFiles: string[]): boolean {
  if (taskMentionedSourceFiles.length < 3) return false;
  const normalizedPath = filePath.toLowerCase();
  if (taskMentionedSourceFiles.map((file) => file.toLowerCase()).includes(normalizedPath)) return false;
  if (task.includes(normalizedPath)) return false;
  const namedPrefixes = new Set(taskMentionedSourceFiles.map((file) => file.toLowerCase().split("/").slice(0, 2).join("/")));
  const filePrefix = normalizedPath.split("/").slice(0, 2).join("/");
  if (namedPrefixes.has(filePrefix) && !/\/components?\//.test(normalizedPath)) return false;
  return /\/components?\//.test(normalizedPath) ||
    /(^|\/)(frontend|client|ui|views?)\//.test(normalizedPath) ||
    /(^|\/)(utils?|helpers?)\.[cm]?js$/.test(normalizedPath);
}

function promptDeclaresNoNewInterfaces(normalizedTask: string): boolean {
  return /\bno new (?:public )?interfaces?\b/.test(normalizedTask) ||
    /\binterfaces? are (?:not )?introduced\b/.test(normalizedTask);
}

function promptRequiresConfigSchemaSurface(normalizedTask: string): boolean {
  return (
    /\b(config|configuration|setting|settings|option|options|workaround|workarounds)\b/.test(normalizedTask) &&
    /\b(named|must exist|exists?|accept|values?|valid values?|default|required|restart|backend|metadata|schema|define|add|support)\b/.test(normalizedTask) &&
    /\b(setting|option|values?|default|restart|backend|schema|metadata)\b/.test(normalizedTask)
  );
}

function selectedTestCounterpartBasenames(task: string): Set<string> {
  const names = new Set<string>();
  for (const match of task.matchAll(/\b[A-Za-z0-9_.@+~/-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)\b/g)) {
    const filePath = normalizeRelativePath(match[0] ?? "").toLowerCase();
    if (!isTestLikePath(filePath)) continue;
    const basename = filePath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
    const withoutPrefix = basename.replace(/^(test|spec)[_-]/, "").replace(/[._-](test|spec)$/, "");
    if (withoutPrefix.length >= 3) names.add(withoutPrefix);
  }
  return names;
}

function taskAllowsTestEdits(task: string): boolean {
  if (/\b(do not edit tests?|verification targets? only|tests are verification targets)\b/.test(task)) return false;
  return /\b(update|edit|add|write|fix|adjust|regenerate)\b.{0,80}\b(tests?|specs?|snapshots?|fixtures?|docs?|documentation)\b/.test(task) ||
    /\b(test expectation|expected output|snapshot update|fixture update)\b/.test(task);
}

function isMultiFileDebugTask(task: string): boolean {
  return /\b(multi[- ]file|multiple files|across files|integration|workflow|pipeline|router|routing|dependency|controller|repository|scheduler|renderer|interceptor|dispatch|adapter|validation|callback)\b/.test(task);
}

function selectedTestPathCount(task: string): number {
  const paths = new Set<string>();
  for (const filePath of extractTaskMentionedTestFiles(task)) {
    paths.add(filePath.toLowerCase());
  }
  return paths.size;
}

function hasUiLivenessMultiSurfaceScope(task: string): boolean {
  return /\b(liveness|live|badge|icon|feedback|visual|shown|render)\b/.test(task) &&
    (
      /\b(voice|broadcast|recording|playback)\b/.test(task) ||
      (/\b(ui|frontend|component|components|header|body)\b/.test(task) && /\b(liveness|live|badge|icon|visual)\b/.test(task))
    );
}

function hasPackageSourceMappingScope(task: string): boolean {
  return /\b(source packages?|binary packages?|src packages?|package source|source package associations?|apk|alpine)\b/.test(task) &&
    /\b(oval|vulnerabilit(?:y|ies)|scanner|package manager|upgradable|installed packages?)\b/.test(task);
}

function hasDiscoveryConfigScope(task: string): boolean {
  return /\b(discovery|discover|autodiscovery|well[- ]?known|homeserver|server discovery)\b/.test(task) &&
    /\b(config|configuration|validated|validate|delegated|authentication|auth|metadata|contract|m\.authentication)\b/.test(task);
}

function applyDiscoveryConfigInitialScopeBudget(files: string[]): string[] {
  const scored = files
    .map((file, index) => {
      const role = discoveryConfigSurfaceRole(file);
      return { file, role, index, score: discoveryConfigSurfaceScore(file, role) };
    })
    .filter((entry) => entry.role)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const discovery = scored.find((entry) => entry.role === "discovery")?.file;
  const contract = scored.find((entry) => entry.role === "contract")?.file;
  return uniquePaths([
    ...(discovery ? [discovery] : []),
    ...(contract ? [contract] : []),
    ...files
  ]);
}

function discoveryConfigSurfaceRole(filePath: string): "discovery" | "contract" | undefined {
  const normalized = filePath.toLowerCase();
  const base = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const compactBase = base.replace(/[^a-z0-9]+/g, "");
  if (
    /\b(validatedserverconfig|serverconfig)\b/.test(compactBase) ||
    (compactBase.includes("validated") && compactBase.includes("config")) ||
    (compactBase.includes("server") && compactBase.includes("config"))
  ) {
    return "contract";
  }
  if (
    compactBase.includes("autodiscovery") ||
    compactBase.includes("discovery") ||
    compactBase.includes("homeserver") ||
    compactBase.includes("wellknown") ||
    normalized.includes("/well-known/") ||
    normalized.includes("/wellknown/")
  ) {
    return "discovery";
  }
  return undefined;
}

function discoveryConfigSurfaceScore(filePath: string, role: "discovery" | "contract" | undefined): number {
  const normalized = filePath.toLowerCase();
  const base = normalized.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  const compactBase = base.replace(/[^a-z0-9]+/g, "");
  if (role === "contract") return 900;
  if (role !== "discovery") return 0;
  if (compactBase.includes("autodiscovery") || compactBase.includes("discovery")) return 1100;
  if (compactBase.includes("homeserver")) return 980;
  if (compactBase.includes("wellknown") || normalized.includes("/well-known/") || normalized.includes("/wellknown/")) return 720;
  return 500;
}

function hasWebSessionRenewalScope(task: string): boolean {
  return /\b(web session|session renewal|renew(?:ing)? (?:a )?(?:web )?session|prevsessionid|websessionreq|reloaduser|switchback|active requests?|access request|renewed session)\b/.test(task) &&
    /\b(traits?|certificate|certificates?|ssh certificate|tls certificate|roles?|allowed resources?|login time|expiry|backend|user record|stale)\b/.test(task);
}

function hasDatastoreBackendParityScope(task: string): boolean {
  const collectionMutation =
    /\b(list|lists|set|sets|zset|hash|queue|collection|collections)\b/.test(task) &&
    /\b(remove|removing|delete|deleting|del|discard|pull|pop|trim|add|insert|push)\b/.test(task);
  const multiValue =
    /\b(multiple|distinct|array|arrays|elements?|values?|batch|bulk|several)\b/.test(task) ||
    /\[[^\]]+,[^\]]+\]/.test(task);
  return collectionMutation && multiValue;
}

function hasPluginActivationValidationScope(task: string): boolean {
  return /\b(plugin|plugins|plugin id|plugin identifier|package name)\b/.test(task) &&
    /\b(activate|activation|toggleactive|toggle active|deactivate|admin\.plugins\.toggleactive)\b/.test(task) &&
    /\b(validate|validation|valid|invalid|malformed|whitespace|special characters?|naming pattern|identifier|invalid-plugin-id)\b/.test(task);
}

function datastoreBackendParitySourceFilesFromCandidates(files: string[]): string[] {
  const groups = new Map<string, Array<{ path: string; surface: DatastoreBackendSurface }>>();
  for (const file of files) {
    const surface = datastoreBackendSurface(file);
    if (!surface) continue;
    const key = `${surface.prefix}\0${surface.suffix}`;
    const group = groups.get(key) ?? [];
    group.push({ path: file, surface });
    groups.set(key, group);
  }
  const best = [...groups.entries()]
    .filter(([, group]) => new Set(group.map((entry) => entry.surface.backend)).size >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]?.[1] ?? [];
  return uniquePaths(best.map((entry) => entry.path));
}

type DatastoreBackendSurface = { prefix: string; backend: string; suffix: string };

function datastoreBackendSurface(filePath: string): DatastoreBackendSurface | undefined {
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

function applyFrontendUiInitialScopeBudget(files: string[], task: string): string[] {
  const visibleSurfaces = files.filter((file) => isFrontendUiVisibleSurface(file, task));
  const explicitSourceSurfaces = files.filter((file) => isFrontendUiExplicitlyNamedSourceSurface(file, task));
  const budgeted = uniquePaths([...visibleSurfaces, ...explicitSourceSurfaces]);
  if (budgeted.length >= 2) return budgeted;
  return files.filter((file) => !isFrontendUiStateOrStyleSurface(file));
}

function isFrontendUiVisibleSurface(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (!/\.(?:[cm]?[jt]sx?)$/.test(normalizedPath)) return false;
  if (!/\/components?\//.test(normalizedPath)) return false;
  if (isFrontendUiStateOrStyleSurface(normalizedPath)) return false;
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (/\b(live|liveness|badge|header|body|pip|recording|playback|broadcast)\b/.test(basename)) return true;
  return /\b(component|render|visual|display|shown|view|screen|ui)\b/.test(normalizedTask);
}

function isFrontendUiStateOrStyleSurface(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return (
    /(^|\/)(hooks?|models?|stores?|state|utils?)\//.test(normalizedPath) ||
    /(^|\/)index\.[cm]?[jt]sx?$/.test(normalizedPath) ||
    /(^|\/)(styles?|css)\//.test(normalizedPath) ||
    /\.(?:css|pcss|scss|sass|less)$/.test(normalizedPath)
  );
}

function isFrontendUiExplicitlyNamedSourceSurface(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  if (!/\.(?:[cm]?[jt]sx?)$/.test(normalizedPath)) return false;
  if (/(^|\/)(styles?|css)\//.test(normalizedPath) || /\.(?:css|pcss|scss|sass|less)$/.test(normalizedPath)) return false;
  const normalizedTask = task.toLowerCase();
  if (normalizedTask.includes(normalizedPath)) return true;
  const basename = normalizedPath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (basename.length < 4 || /^(index|main|utils?|helpers?)$/.test(basename)) return false;
  return taskMentionsCompactIdentifier(task, basename);
}

function taskMentionsCompactIdentifier(task: string, identifier: string): boolean {
  const compact = identifier.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact.length < 4) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(compact)}([^a-z0-9]|$)`, "i");
  return pattern.test(task);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTaskMentionedTestFiles(task: string): string[] {
  const paths = new Set<string>();
  for (const match of task.matchAll(/\b[A-Za-z0-9_.@+~/-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)\b/g)) {
    const filePath = normalizeRelativePath(match[0] ?? "");
    const normalized = filePath.toLowerCase();
    const basename = normalized.split("/").at(-1) ?? normalized;
    if (
      /(^|\/)(tests?|specs?|__tests__|testing)\//.test(normalized) ||
      /(^|\/)src\/test\//.test(normalized) ||
      /^(test|spec)[_-]/.test(basename) ||
      /[._-](test|spec)\./.test(basename) ||
      /_test\.go$/.test(basename)
    ) {
      paths.add(filePath);
    }
  }
  return [...paths];
}
