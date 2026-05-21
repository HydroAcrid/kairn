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
import { hasExplicitMultiFileScopeRequest, taskHasProductionOnlyEditIntent } from "../prime/contextGovernor.js";

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
  const harnessFiles = uniquePaths((input.allowedDiffScopes ?? []).map((scope) => normalizeRelativePath(scope.file)));
  const invariantFiles = uniquePaths([
    ...(input.invariants ?? []).map((invariant) => normalizeRelativePath(invariant.file)),
    ...(input.sourceInvariants ?? []).map((invariant) => normalizeRelativePath(invariant.file))
  ]);
  const taskMentionedTestFiles = extractTaskMentionedTestFiles(input.task);
  const failureFiles = uniquePaths((input.failureFiles ?? []).map(normalizeRelativePath));
  const changedFiles = uniquePaths((input.changedFiles ?? []).map(normalizeRelativePath));
  const productionOnlySingleFile = taskHasProductionOnlyEditIntent(task) && !hasExplicitMultiFileScopeRequest(task);

  const source = scopeSource({
    contextDecision: input.contextDecision,
    harnessFiles,
    failureFiles,
    task,
    productionOnlySingleFile
  });
  const primaryLimit = productionOnlySingleFile
    ? 1
    : source === "multi_file_debug" && selectedTestPathCount(task) >= 3
      ? 3
      : input.contextDecision?.recommendedDelivery === "multi_file_directive" || source === "multi_file_debug"
        ? 2
        : 1;
  const sourceCandidates = uniquePaths([
    ...harnessFiles.filter((file) => isEditableByDefault(file, allowedTestEdits)),
    ...failureFiles.filter((file) => isProductionSourcePath(file)),
    ...invariantFiles.filter((file) => isEditableByDefault(file, allowedTestEdits)),
    ...(input.contextDecision?.primaryFile ? [normalizeRelativePath(input.contextDecision.primaryFile)] : []),
    ...candidateFiles
  ]);
  const initialEditFiles = sourceCandidates
    .filter((file) => isEditableByDefault(file, allowedTestEdits))
    .slice(0, source === "official_harness" ? Math.max(1, harnessFiles.length) : primaryLimit);
  const readOnlyFiles = uniquePaths([
    ...taskMentionedTestFiles,
    ...candidateFiles,
    ...harnessFiles,
    ...invariantFiles,
    ...failureFiles,
    ...changedFiles
  ]).filter((file) => !initialEditFiles.includes(file) && shouldSurfaceReadOnly(file, allowedTestEdits));
  const scopeConfidence = initialEditFiles.length === 0
    ? "low"
    : source === "official_harness" || input.contextDecision?.exactSourceHit
      ? "high"
      : source === "multi_file_debug" || input.contextDecision?.sourceRescue || input.contextDecision?.canonicalSourceHit
        ? "medium"
        : "low";

  return {
    initialEditFiles,
    readOnlyFiles: readOnlyFiles.slice(0, 4),
    allowedExpansionTriggers: expansionTriggers({ task, allowedTestEdits }),
    forbiddenEditPatterns: forbiddenEditPatterns(allowedTestEdits),
    scopeConfidence,
    scopeSource: initialEditFiles.length > 0 ? source : "weak_signal",
    reason: scopeReason({ source, initialEditFiles, allowedTestEdits }),
    dynamic: true
  };
}

export function editScopeLine(scope: EditScopeDecision): string {
  const initial = scope.initialEditFiles.length > 0 ? scope.initialEditFiles.join(", ") : "none yet";
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
    scope.initialEditFiles.length > 0 ? "- Edit only the initial scope first; do not create or edit other production, test, docs, generated, or sibling files unless an allowed expansion trigger occurs." : "",
    includeReadOnly && scope.readOnlyFiles.length > 0 ? `- Read-only verification context: ${scope.readOnlyFiles.join(", ")}` : "",
    `- Allowed expansion: ${scope.allowedExpansionTriggers.join("; ")}`,
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
  if (input.source === "official_harness") return "benchmark or official task metadata supplied allowed production patch files";
  if (input.source === "failure_output") return "failure output linked the scope to source files";
  if (input.source === "multi_file_debug") return "task has multi-surface debug evidence";
  if (input.source === "exact_source") return "one source file dominates retrieval";
  if (input.allowedTestEdits) return "the prompt explicitly allows test or snapshot edits";
  return "Kairn selected the smallest source edit set";
}

function expansionTriggers(input: { task: string; allowedTestEdits: boolean }): string[] {
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

function forbiddenEditPatterns(allowedTestEdits: boolean): string[] {
  return allowedTestEdits
    ? ["docs/", "examples/", "generated/", "dist/", "vendor/", "node_modules/"]
    : ["tests/", "test/", "__tests__/", "docs/", "examples/", "generated/", "dist/", "vendor/", "node_modules/"];
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
  return /\.(?:[cm]?[jt]sx?|pyi?|go|java|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/.test(normalized);
}

function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.includes("__tests__/") ||
    /^test_.*\.pyi?$/.test(normalized.split("/").at(-1) ?? normalized) ||
    /_test\.pyi?$/.test(normalized) ||
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

function taskAllowsTestEdits(task: string): boolean {
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
