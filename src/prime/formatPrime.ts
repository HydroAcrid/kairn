import type { ContextInvariant, ContextPrime, ContextResponse, EditScopeDecision, EvidenceRequest, PrimeQuality } from "../types.js";
import { editScopeBlock, editScopeLine } from "../scope/editScope.js";
import { estimateTokens, truncateToBudget } from "../utils/tokens.js";
import { uniquePaths, uniqueStrings } from "../utils/collections.js";
import type { PrimeProfileLimits, ResolvedPrimeProfile } from "./quality.js";

export type OfficialGuardrailVariant =
  | "compact_official"
  | "semantic_official"
  | "topic_ordering_compact"
  | "paired_contract_compact"
  | "benchmark_generator_compact"
  | "collection_name_validation_compact"
  | "execution_state_migration_compact"
  | "grpc_error_policy_compact"
  | "request_body_form_compact"
  | "discovery_config_compact"
  | "package_source_mapping_compact"
  | "lifecycle_policy_compact"
  | "frontend_owner_map_compact";

export function formatPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  budget: number;
  limits: PrimeProfileLimits;
  context: ContextResponse;
  relatedFiles: string[];
  testFiles: string[];
  suggestedCommands: string[];
  invariants?: ContextInvariant[] | undefined;
  editScope?: EditScopeDecision | undefined;
}): string {
  if (input.profile === "failure_debug") {
    return formatFailureDebugPrime(input);
  }

  const topFiles = uniquePaths(input.context.suggestedNextContext.length > 0 ? input.context.suggestedNextContext : input.context.files).slice(0, input.limits.topFiles);
  const related = uniquePaths(input.relatedFiles).filter((file) => !topFiles.includes(file)).slice(0, input.limits.relatedFiles);
  const tests = uniquePaths(input.testFiles).slice(0, input.limits.testFiles);
  const sections = [
    "# Kairn Proactive Context",
    "",
    "Start with this context before broad repository scans. If it is insufficient, then use targeted reads or Kairn context commands.",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    "",
    "## Start Here",
    topFiles.length > 0 ? topFiles.map((file) => `- ${file}`).join("\n") : "- No high-confidence files found.",
    "",
    "## Targeted Context",
    compactPrimeContext(input.context.content, input.limits.snippetBudget),
    "",
    ...formatInvariantSections(input.invariants, "## Invariant To Preserve"),
    "",
    ...(input.editScope ? ["## Edit Scope", editScopeLine(input.editScope)] : []),
    "",
    "## Likely Tests",
    tests.length > 0 ? tests.map((file) => `- ${file}`).join("\n") : "- No likely tests found.",
    "",
    related.length > 0 ? ["## Related Files", related.map((file) => `- ${file}`).join("\n"), ""].join("\n") : "",
    input.limits.includeCommands
      ? ["## More Context", input.suggestedCommands.slice(0, 2).map((command) => `- ${command}`).join("\n"), ""].join("\n")
      : "",
    "",
    "## Agent Guidance",
    "- Prefer targeted reads of the Start Here files over `rg --files` or large file ranges.",
    "- Do not edit files unless the user task explicitly asks for edits."
  ].filter((section) => section !== "");

  return fitSectionsToBudget(sections, input.budget);
}

function formatFailureDebugPrime(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  budget: number;
  limits: PrimeProfileLimits;
  context: ContextResponse;
  testFiles: string[];
  invariants?: ContextInvariant[] | undefined;
  editScope?: EditScopeDecision | undefined;
}): string {
  const topFile = uniquePaths(input.context.suggestedNextContext.length > 0 ? input.context.suggestedNextContext : input.context.files)[0];
  const likelyTest = uniquePaths(input.testFiles)[0];
  const symbolHints = extractPrimeSymbolHints(input.context.content).slice(0, 3);
  const sections = [
    "# Kairn Failure Debug Context",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    "",
    "Start file:",
    topFile ? `- ${topFile}` : "- No high-confidence source file found.",
    symbolHints.length > 0 ? `Symbols: ${symbolHints.join(", ")}` : "",
    likelyTest ? `Likely check/test: ${likelyTest}` : "",
    "",
    "Focused snippet:",
    compactPrimeContext(input.context.content, input.limits.snippetBudget),
    "",
    ...formatInvariantSections(input.invariants, "Invariant to preserve:"),
    "",
    ...(input.editScope ? editScopeBlock(input.editScope, "Edit scope:") : []),
    "",
    "Instruction: inspect the start file and symbol first, patch only the production source, then run the failing check."
  ].filter(Boolean);

  return fitSectionsToBudget(sections, input.budget);
}

export function withTinyDirectivePrime(prime: ContextPrime, requestedBudget: number): ContextPrime {
  const budget = Math.max(240, Math.min(600, requestedBudget));
  const content = formatTinyDirectivePrime({ prime, budget });
  return {
    ...prime,
    content,
    tokenEstimate: estimateTokens(content),
    warnings: uniqueStrings([...prime.warnings, "tiny directive hook output"])
  };
}

export function formatMcpBriefPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  budget: number;
  context: ContextResponse;
  files: string[];
  quality: PrimeQuality;
  invariants?: ContextInvariant[] | undefined;
  editScope?: EditScopeDecision | undefined;
}): string {
  const files = uniquePaths(input.files).slice(0, 2);
  const primaryFile = files[0];
  const reason = primaryFile
    ? primaryReasonForFile(input.context, primaryFile)
    : "Kairn did not find a high-confidence start file.";
  const lines = [
    "# Kairn MCP Brief",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    `Profile: ${input.profile}`,
    "",
    "Start files:",
    files.length > 0 ? files.map((file, index) => `${index + 1}. ${file}`).join("\n") : "No high-confidence start file found.",
    "",
    `Reason: ${reason}`,
    "",
    ...formatInvariantSections(input.invariants, "Invariant:"),
    "",
    "Instruction: call `kairn_prepare_task` with this session id before broad, unclear, multi-file, failure-driven, or source-rescue reads. If it returns `stopCondition` or no `nextToolCalls`, continue from its files and do not call more Kairn unless a check fails or the target changes.",
    `Suggested MCP call: kairn_prepare_task({ "task": ${JSON.stringify(input.task)}, "sessionId": ${JSON.stringify(input.sessionId)}, "detail": "compact" })`,
    "",
    ...(input.editScope ? editScopeBlock(input.editScope, "Edit scope:") : []),
    "",
    `Quality: ${input.quality.score}/100 (${input.quality.action})`
  ];

  return fitSectionsToBudget(lines, input.budget);
}

export function formatSuppressedPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  quality: PrimeQuality;
}): string {
  return [
    "# Kairn Prime Suppressed",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    `Quality score: ${input.quality.score}`,
    `Reason: ${input.quality.reasons.join("; ")}`,
    "",
    "Kairn did not emit proactive context because it is unlikely to save tokens for this prompt."
  ].join("\n");
}

export function formatEvidenceRequestPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  quality: PrimeQuality;
  evidenceRequest?: EvidenceRequest | undefined;
}): string {
  const request = input.evidenceRequest ?? {
    kind: "clarify_task" as const,
    prompt: "Provide one concrete source file, symbol, failure output, or verification result before Kairn sends code context.",
    reason: "Kairn does not have enough reliable evidence to choose useful context."
  };
  return [
    "# Kairn Needs One More Signal",
    "",
    `Task: ${compactTaskLine(input.task)}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    `Decision: ${input.quality.action}`,
    "",
    `Needed evidence: ${request.prompt}`,
    `Why: ${request.reason}`,
    "",
    "Kairn did not include source snippets or edit targets for this turn."
  ].join("\n");
}

export function formatSourceRoutingPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  context: ContextResponse;
  files: string[];
  budget: number;
}): string {
  const files = uniquePaths(input.files).slice(0, 4);
  const sections = [
    "# Kairn Source Map",
    "",
    "Read-only source-identification task. Return the paths with short reasons unless a targeted read proves them wrong. Do not edit files or run broad repo scans.",
    "",
    "Relevant source files:",
    files.length > 0
      ? files.map((file, index) => `${index + 1}. ${file} - ${sourceMapReasonForFile(input.context, file)}`).join("\n")
      : "No high-confidence source files found.",
    "",
    `Session: ${input.sessionId}`
  ];

  return fitSectionsToBudget(sections, input.budget);
}

export function formatShrunkPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  quality: PrimeQuality;
  context: ContextResponse;
  files?: string[] | undefined;
  budget: number;
  invariants?: ContextInvariant[] | undefined;
  editScope?: EditScopeDecision | undefined;
  includeSnippet?: boolean | undefined;
  minimal?: boolean | undefined;
  includeVerification?: boolean | undefined;
}): string {
  const candidateFiles = uniquePaths(
    input.files && input.files.length > 0
      ? input.files
      : input.context.suggestedNextContext.length > 0
        ? input.context.suggestedNextContext
        : input.context.files
  );
  const topFileLimit = input.files && input.files.length > 1
    ? isUiFeedbackMultiSurfaceTask(input.task)
      ? 5
      : isExecutionStateMigrationTask(input.task)
      ? 3
      : 2
    : 1;
  const topFiles = candidateFiles.slice(0, topFileLimit);
  const symbolHints = extractPrimeSymbolHints(input.context.content).slice(0, 2);
  const multiFileDirective = topFiles.length > 1;
  const additionalTopFiles = topFiles.slice(2);
  const focusedContext = input.includeSnippet === false
    ? ""
    : formatFocusedContextBlock(input.context.content, Math.max(100, Math.floor(input.budget * 0.24)));
  const strictOfficialScope = input.editScope?.strictBoundary === true;
  const orderingGuardrail = configOrderingGuardrail(input.task);
  if (input.minimal) {
    if (strictOfficialScope) {
      const guardrailInput = {
        task: input.task,
        files: topFiles,
        editScope: input.editScope,
        invariants: input.invariants,
        budget: input.budget
      };
      const variant = officialGuardrailVariantFor(guardrailInput);
      if (variant === "compact_official") return formatCompactOfficialGuardrail(guardrailInput);
      if (variant === "topic_ordering_compact") return formatTopicOrderingOfficialGuardrail(guardrailInput);
      if (variant === "benchmark_generator_compact") return formatBenchmarkGeneratorOfficialGuardrail(guardrailInput);
      if (variant === "paired_contract_compact") return formatPairedContractOfficialGuardrail(guardrailInput);
      if (variant === "collection_name_validation_compact") return formatCollectionNameValidationOfficialGuardrail(guardrailInput);
      if (variant === "execution_state_migration_compact") return formatExecutionStateMigrationOfficialGuardrail(guardrailInput);
      if (variant === "grpc_error_policy_compact") return formatGrpcErrorPolicyOfficialGuardrail(guardrailInput);
      if (variant === "request_body_form_compact") return formatRequestBodyFormOfficialGuardrail(guardrailInput);
      if (variant === "discovery_config_compact") return formatDiscoveryConfigOfficialGuardrail(guardrailInput);
      if (variant === "package_source_mapping_compact") return formatPackageSourceMappingOfficialGuardrail(guardrailInput);
      if (variant === "lifecycle_policy_compact") return formatLifecyclePolicyOfficialGuardrail(guardrailInput);
      if (variant === "frontend_owner_map_compact") return formatFrontendOwnerMapOfficialGuardrail(guardrailInput);
      return formatSemanticOfficialGuardrail(guardrailInput);
    }
    const sections = [
      "# Kairn Fix Guardrail",
      "",
      `Task: ${compactTaskLine(input.task)}`,
      `Session: ${input.sessionId}`,
      "",
      "Start file:",
      topFiles.length > 0 ? `- ${topFiles[0]}` : "- No high-confidence source file found.",
      "",
      ...formatMinimalInvariantSections(input.invariants, "Invariant to preserve:"),
      orderingGuardrail,
      "",
      strictOfficialScope
        ? "Edit boundary: patch only the official edit scope. Do not edit sibling/helper production files outside that scope."
        : "Edit boundary: make the smallest production-source edit. Do not edit tests, snapshots, docs, examples, generated files, or sibling source files unless a focused failure proves expansion.",
      "Verification hint: use the narrowest relevant check.",
      strictOfficialScope
        ? "Stop condition: if the scope seems incomplete, stop and report the missing evidence instead of expanding edits."
        : "Stop condition: start with this file; expand only to a directly imported or called production helper when this file cannot satisfy the invariant.",
      "",
      ...formatMinimalReadOnlyScope(input.editScope),
      "",
      ...formatMinimalEditScope(input.editScope)
    ].filter(Boolean);
    return fitSectionsToBudget(sections, input.budget);
  }
  const sections = [
    "# Kairn Focused Start",
    "",
    `Task: ${compactTaskLine(input.task)}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    `Quality score: ${input.quality.score} (${input.quality.action})`,
    "",
    multiFileDirective ? "Primary source:" : "Start file:",
    topFiles[0] ? `- ${topFiles[0]} - ${primaryReasonForFile(input.context, topFiles[0])}` : "- No high-confidence source file found.",
    topFiles[1] ? "Companion source:" : "",
    topFiles[1] ? `- ${topFiles[1]} - ${primaryReasonForFile(input.context, topFiles[1])}` : "",
    additionalTopFiles.length > 0 ? "Additional source surfaces:" : "",
    additionalTopFiles.length > 0
      ? additionalTopFiles.map((file) => `- ${file} - ${primaryReasonForFile(input.context, file)}`).join("\n")
      : "",
    ...executionStateMigrationDirectiveLines(input.task, topFiles),
    symbolHints.length > 0 ? `Symbols: ${symbolHints.join(", ")}` : "",
    "",
    ...formatInvariantSections(input.invariants, "Invariant to preserve:", { includeVerification: input.includeVerification ?? multiFileDirective }),
    orderingGuardrail,
    "",
    strictOfficialScope
      ? "Stop condition: patch only the official edit scope; if another source file seems necessary, stop and report the missing evidence instead of editing it."
      : multiFileDirective
      ? "Stop condition: inspect only these source files first; avoid broad related-file/test scans unless neither file can satisfy the invariant or a failure names another file."
      : "Stop condition: preserve the invariant in the start file first; avoid broad related-file/test scans unless this file cannot satisfy the invariant or a failure names another file.",
    "",
    ...(input.editScope ? editScopeBlock(input.editScope, "Edit scope:", { includeReadOnly: multiFileDirective }) : []),
    focusedContext ? "" : "",
    focusedContext
  ].filter(Boolean);
  return fitSectionsToBudget(sections, input.budget);
}

function executionStateMigrationDirectiveLines(task: string, files: string[]): string[] {
  if (!isExecutionStateMigrationTask(task) || files.length < 2) return [];
  const ownerFiles = files.filter(isExecutionStateOwnerFile);
  const consumerFiles = files.filter((file) => !isExecutionStateOwnerFile(file));
  return [
    "Required migration edits: patch the state owner and every listed strategy/executor consumer; owner-only enum changes are incomplete.",
    ownerFiles.length > 0 ? `State owner: ${ownerFiles.join(", ")}` : "",
    consumerFiles.length > 0 ? `Consumer surfaces: ${consumerFiles.join(", ")}` : "",
    "Do not stop after adding enums/metaclass compatibility; update consumer comparisons and assignments in the same patch."
  ].filter(Boolean);
}

function formatCompactOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const startFile = input.files[0] ?? input.editScope?.initialEditFiles[0];
  const editFiles = uniquePaths([...(startFile ? [startFile] : []), ...(input.editScope?.initialEditFiles ?? [])]).slice(0, 3);
  const readOnly = input.editScope?.readOnlyFiles.slice(0, 2) ?? [];
  const sections = [
    "# Kairn Fix Guardrail",
    `Task: ${compactTaskLine(input.task, 40)}`,
    "Action: make the smallest production-source edit; do not stop after analysis if this scope is sufficient.",
    editFiles.length > 0 ? `Edit only: ${editFiles.join(", ")}` : "Edit only: the official production source scope.",
    configOrderingGuardrail(input.task),
    "Boundary: do not edit tests, docs, examples, generated files, or sibling source.",
    readOnly.length > 0 ? `Verify read-only: ${readOnly.join(", ")}` : "Verify with the narrowest relevant check.",
    "If another source file seems necessary, stop and report the missing evidence."
  ];
  return fitSectionsToBudget(sections, Math.min(input.budget, 190));
}

function formatSemanticOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const startFiles = uniquePaths([
    ...input.files,
    ...(input.editScope?.initialEditFiles ?? [])
  ]).slice(0, 3);
  const readOnly = input.editScope?.readOnlyFiles.slice(0, 2) ?? [];
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn Fix Guardrail",
    `Task: ${compactTaskLine(input.task, 48)}`,
    "Action: make the smallest production-source edit; do not stop after analysis if this scope is sufficient.",
    startFiles.length > 0 ? `Edit only: ${startFiles.join(", ")}` : "Edit only: the official production source scope.",
    invariant ? `Preserve: ${truncateToBudget(invariant.statement, 52)}` : "Preserve the failure/behavior invariant described by the task.",
    configOrderingGuardrail(input.task),
    "Boundary: no tests, docs, examples, generated files, or sibling source unless a failure proves the scope is incomplete.",
    readOnly.length > 0 ? `Verify read-only: ${readOnly.join(", ")}` : "Verify with the narrowest relevant check.",
    "If another source file seems necessary, stop and report the missing evidence."
  ];
  return fitSectionsToBudget(sections, Math.min(input.budget, 280));
}

function formatPairedContractOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = officialEditFiles(input).slice(0, 5);
  const readOnly = input.editScope?.readOnlyFiles.slice(0, 2) ?? [];
  const invariant = input.invariants?.[0];
  const backendParity = isDatastoreBackendParityTask(input.task);
  const databaseFailover = isDatabaseFailoverTask(input.task);
  const editFileList = databaseFailover ? sortDatabaseFailoverDirectiveFiles(editFiles) : editFiles;
  const fileRole = databaseFailover ? databaseFailoverRole : officialFileRole;
  const sections = [
    "# Kairn Paired Scope",
    `Task: ${compactTaskLine(input.task, 42)}`,
    backendParity
      ? "Action: apply the same collection-operation behavior across every datastore backend surface listed below."
      : databaseFailover
      ? "Action: patch every required database failover surface; a type/proxy-only patch is incomplete."
      : "Action: patch only the command/contract surfaces below; do not expand to backend/storage helpers unless the prompt names them.",
    editFiles.length > 0
      ? backendParity
        ? `Required backend edits: ${editFileList.map((file) => `${file} (${fileRole(file)})`).join(", ")}`
        : databaseFailover
        ? ["Required diff checklist:", ...editFileList.map((file) => `- ${file}: ${fileRole(file)}`)].join("\n")
        : `Edit scope: ${editFileList.map((file) => `${file} (${fileRole(file)})`).join(", ")}`
      : backendParity
        ? "Required backend edits: every datastore backend surface implementing this operation."
        : "Edit scope: the official production source surfaces.",
    databaseFailover ? "Completion: before submitting, changed files must include every checklist path unless new evidence proves one is unnecessary." : "",
    invariant ? `Invariant: ${truncateToBudget(invariant.statement, 42)}` : "",
    backendParity ? "Backend parity: patch every listed backend; do not stop after only the first backend passes locally." : "",
    configOrderingGuardrail(input.task),
    "Boundary: no tests, docs, examples, generated files, or sibling source.",
    readOnly.length > 0 ? `Read-only check: ${readOnly.join(", ")}` : "Verify with the narrowest relevant check.",
    "If a different production file appears necessary, stop and report the missing evidence."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, databaseFailover ? 280 : 240));
}

function formatBenchmarkGeneratorOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = sortBenchmarkGeneratorDirectiveFiles(officialEditFiles(input)).slice(0, 5);
  const coreFiles = benchmarkGeneratorCoreFiles(editFiles).slice(0, 2);
  const wiringFiles = editFiles
    .filter((file) => !coreFiles.includes(file))
    .filter((file) => coreFiles.length === 0 || !isGenericBenchmarkRegistryFile(file))
    .slice(0, 3);
  const readOnly = input.editScope?.readOnlyFiles.slice(0, 2) ?? [];
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn Benchmark Generator Scope",
    `Task: ${compactTaskLine(input.task, 42)}`,
    "Action: edit the core generator now. Do not spend the first pass analyzing registration surfaces.",
    coreFiles.length > 0
      ? `Core edit now: ${coreFiles.map((file) => `${file} (${officialFileRole(file)})`).join(", ")}`
      : "Core edit now: the production benchmark generator implementation.",
    wiringFiles.length > 0
      ? `Wire only after core implementation: ${wiringFiles.map((file) => `${file} (${officialFileRole(file)})`).join(", ")}`
      : "",
    invariant ? `Invariant: ${truncateToBudget(invariant.statement, 42)}` : "",
    "Boundary: no tests, docs, examples, generated files, or unrelated command surfaces.",
    readOnly.length > 0 ? `Read-only check: ${readOnly.join(", ")}` : "Verify with the narrowest benchmark/unit check.",
    "If time is tight, leave a correct core generator patch rather than no patch."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 240));
}

function sortBenchmarkGeneratorDirectiveFiles(files: string[]): string[] {
  return [...files].sort((left, right) => benchmarkGeneratorFileRank(left) - benchmarkGeneratorFileRank(right));
}

function benchmarkGeneratorCoreFiles(files: string[]): string[] {
  const sorted = sortBenchmarkGeneratorDirectiveFiles(files);
  const namedGeneratorFiles = sorted.filter((file) => {
    const normalized = file.toLowerCase();
    const basename = normalized.split("/").at(-1) ?? normalized;
    return /\/benchmark\/.*\.(?:[cm]?[jt]sx?|pyi?|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/.test(normalized) &&
      !isGenericBenchmarkRegistryBasename(basename);
  });
  if (namedGeneratorFiles.length > 0) return namedGeneratorFiles;
  const benchmarkFiles = sorted.filter((file) => /\/benchmark\/.*\.(?:[cm]?[jt]sx?|pyi?|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/.test(file.toLowerCase()));
  return benchmarkFiles.length > 0 ? benchmarkFiles : sorted.slice(0, 1);
}

function benchmarkGeneratorFileRank(filePath: string): number {
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/\/benchmark\/.*\.(?:[cm]?[jt]sx?|pyi?|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/.test(normalized)) {
    if (isGenericBenchmarkRegistryBasename(basename)) return 1;
    return 0;
  }
  if (/(^|\/)(client|api|sdk)\//.test(normalized) || /\/client\//.test(normalized)) return 2;
  if (/(^|\/)(cmd|cli|tool|tools|bin)\//.test(normalized) || /\/(cmd|cli|tool|tools|bin)\//.test(normalized)) return 3;
  return 4;
}

function isGenericBenchmarkRegistryFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  return /\/benchmark\/.*\.(?:[cm]?[jt]sx?|pyi?|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/.test(normalized) &&
    isGenericBenchmarkRegistryBasename(basename);
}

function isGenericBenchmarkRegistryBasename(basename: string): boolean {
  return /^(benchmark|benchmarks|index|registry|register|main)\./.test(basename);
}

function formatCollectionNameValidationOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = officialEditFiles(input).slice(0, 2);
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn Collection Scope",
    editFiles.length > 0 ? `Start scope: ${editFiles.join(", ")}` : "Start with the collection-name validation surfaces.",
    invariant
      ? `Rule: ${truncateToBudget(invariant.statement, 34)}`
      : "Rule: reject Python reserved keywords in namespace or collection name; preserve existing invalid-name rejection.",
    "Patch the smallest necessary validation surface first; touch its companion only if the contract requires it.",
    "Boundary: no helpers, tests, docs, examples, generated files, or sibling source.",
    "Need another file? Report evidence first."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 150));
}

function formatExecutionStateMigrationOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = sortExecutionStateMigrationDirectiveFiles(officialEditFiles(input)).slice(0, 5);
  const invariant = input.invariants?.[0];
  const ownerFiles = editFiles.filter(isExecutionStateOwnerFile);
  const consumerFiles = editFiles.filter((file) => !isExecutionStateOwnerFile(file));
  const sections = [
    "# Kairn State Migration Scope",
    "Required edit surfaces: patch the state owner and every listed consumer surface; owner-only enum changes are incomplete.",
    ownerFiles.length > 0
      ? `State owner: ${ownerFiles.map((file) => `${file} (${executionStateMigrationRole(file)})`).join(", ")}`
      : "State owner: the file defining the public state representation.",
    consumerFiles.length > 0
      ? `Required consumers: ${consumerFiles.map((file) => `${file} (${executionStateMigrationRole(file)})`).join(", ")}`
      : "Required consumers: every strategy/executor surface that compares or assigns the migrated state.",
    invariant
      ? `Rule: ${truncateToBudget(invariant.statement, 40)}`
      : "Rule: preserve behavior while moving comparisons, assignments, display, and compatibility shims to the new state type.",
    "Do not stop after adding enums/metaclass compatibility; update the consumer comparisons and assignments in the same patch.",
    "Boundary: no tests, docs, examples, generated files, or unrelated strategy plugins.",
    "Need another file? Report evidence first."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 260));
}

function sortExecutionStateMigrationDirectiveFiles(files: string[]): string[] {
  return [...files].sort((left, right) => executionStateMigrationFileRank(left) - executionStateMigrationFileRank(right));
}

function executionStateMigrationFileRank(filePath: string): number {
  const normalized = filePath.toLowerCase();
  if (isExecutionStateOwnerFile(normalized)) return 0;
  if (/(^|\/)strategy\/__init__\.(?:py|[cm]?[jt]sx?|go|rs|rb|php|java|kt|cs)$/.test(normalized)) return 1;
  if (/(^|\/)strategy\/linear\.(?:py|[cm]?[jt]sx?|go|rs|rb|php|java|kt|cs)$/.test(normalized)) return 2;
  if (/(^|\/)(strategy|strategies|executor|executors)\//.test(normalized)) return 3;
  return 4;
}

function isExecutionStateOwnerFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return /\b(play_iterator|playiterator|host_state|hoststate|state_machine|statemachine|iterator)\b/.test(normalized);
}

function executionStateMigrationRole(filePath: string): string {
  const normalized = filePath.toLowerCase();
  if (isExecutionStateOwnerFile(normalized)) return "state owner";
  if (/(^|\/)strategy\/__init__\./.test(normalized)) return "strategy state consumer";
  if (/(^|\/)strategy\/linear\./.test(normalized)) return "linear strategy consumer";
  if (/(^|\/)(strategy|strategies)\//.test(normalized)) return "strategy consumer";
  if (/(^|\/)(executor|executors)\//.test(normalized)) return "executor consumer";
  return officialFileRole(filePath);
}

function formatTopicOrderingOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = sortTopicOrderingDirectiveFiles(officialEditFiles(input)).slice(0, 4);
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn Topic Ordering Scope",
    editFiles.length > 0
      ? `Start scope: ${editFiles.map((file) => `${file} (${topicOrderingRole(file)})`).join(", ")}`
      : "Start with the pinned-topic owner surfaces.",
    invariant
      ? `Rule: ${truncateToBudget(invariant.statement, 36)}`
      : "Rule: preserve authorization, category isolation, no-op behavior, and deterministic pinned-topic order.",
    "Patch the primary owner first; touch client/socket companions only when behavior crosses that boundary.",
    "Boundary: no tests, account/topic-page shells, docs, generated files, or unrelated topic surfaces.",
    "Need another file? Report evidence first."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 170));
}

function sortTopicOrderingDirectiveFiles(files: string[]): string[] {
  return [...files].sort((left, right) => topicOrderingFileRank(left) - topicOrderingFileRank(right));
}

function topicOrderingFileRank(filePath: string): number {
  const normalized = filePath.toLowerCase();
  if (/src\/topics\/tools\.[cm]?[jt]s$/.test(normalized)) return 0;
  if (/src\/socket\.io\/topics\/tools\.[cm]?[jt]s$/.test(normalized)) return 1;
  if (/public\/src\/client\/category\/tools\.[cm]?[jt]s$/.test(normalized)) return 2;
  if (/category\/tools\.[cm]?[jt]s$/.test(normalized)) return 3;
  return 4;
}

function topicOrderingRole(filePath: string): string {
  const normalized = filePath.toLowerCase();
  if (/src\/topics\/tools\.[cm]?[jt]s$/.test(normalized)) return "topic order owner";
  if (/src\/socket\.io\/topics\/tools\.[cm]?[jt]s$/.test(normalized)) return "socket contract";
  if (/public\/src\/client\/category\/tools\.[cm]?[jt]s$/.test(normalized)) return "client caller";
  return officialFileRole(filePath);
}

function formatGrpcErrorPolicyOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = sortGrpcPolicyFilesForDirective(officialEditFiles(input)).slice(0, 4);
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn gRPC Status Scope",
    "Required edit surfaces: patch every listed file; middleware is the primary behavior owner.",
    ...(
      editFiles.length > 0
        ? editFiles.map((file) => `- ${file}: ${grpcPolicyAction(file)}`)
        : [
            "- gRPC middleware: map wrapped context cancellation/deadline errors to gRPC status codes.",
            "- auth middleware: propagate context cancellation/deadline errors instead of converting them to auth/internal failures.",
            "- server wiring: keep the existing middleware chain registered and ordered; do not implement the policy only here."
          ]
    ),
    invariant
      ? `Rule: ${truncateToBudget(invariant.statement, 38)}`
      : "Rule: context.Canceled maps to Canceled and context.DeadlineExceeded maps to DeadlineExceeded through auth/gRPC middleware.",
    "Do not add a new server interceptor as the only fix; update existing middleware behavior first.",
    "Do not stop after only server wiring or only one middleware; all listed surfaces are required.",
    "Boundary: no models, storage, tests, docs, examples, generated files, or unrelated source.",
    "Need another file? Report evidence first."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 250));
}

function formatRequestBodyFormOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = officialEditFiles(input).slice(0, 4);
  const readOnly = input.editScope?.readOnlyFiles.slice(0, 2) ?? [];
  const sections = [
    "# Kairn Request Scope",
    editFiles.length > 0 ? `Edit only: ${editFiles.map((file) => `${file} (${requestBodyFormRole(file)})`).join(", ")}` : "Edit only the request handler and reconstruction utility.",
    "Rules: body wins over query; preserve pair order; defaults only fill absent non-ancestor keys; later duplicate keys win.",
    "Boundary: no tests, models, admin, docs, generated, or sibling utilities.",
    readOnly.length > 0 ? `Verify read-only: ${readOnly.join(", ")}` : "Verify with the narrowest request/form check.",
    "Need another file? Report evidence first."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 150));
}

function formatDiscoveryConfigOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = officialEditFiles(input).slice(0, 4);
  const readOnly = input.editScope?.readOnlyFiles.slice(0, 2) ?? [];
  const sections = [
    "# Kairn Discovery Scope",
    editFiles.length > 0
      ? `Edit both: ${editFiles.map((file) => `${file} (${discoveryConfigRole(file)})`).join(", ")}`
      : "Edit both the discovery parser and validated server config contract.",
    "Rule: preserve delegated auth / m.authentication metadata through validated server configuration.",
    "Boundary: no settings UI, tests, docs, generated files, or unrelated discovery surfaces.",
    readOnly.length > 0 ? `Verify read-only: ${readOnly.join(", ")}` : "Verify with the narrowest discovery/config check.",
    "Need another file? Report evidence first."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 170));
}

function formatPackageSourceMappingOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = officialEditFiles(input).slice(0, 5);
  const readOnly = input.editScope?.readOnlyFiles.slice(0, 2) ?? [];
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn Package Scope",
    `Task: ${compactTaskLine(input.task, 42)}`,
    "Action: patch only the scanner/package parsing and vulnerability matching surfaces below.",
    editFiles.length > 0 ? `Edit scope: ${editFiles.map((file) => `${file} (${packageSourceRole(file)})`).join(", ")}` : "Edit scope: the package scanner and vulnerability matching source surfaces.",
    invariant ? `Invariant: ${truncateToBudget(invariant.statement, 54)}` : "Invariant: preserve binary package identity while recording source-package associations and matching vulnerabilities against source packages when needed.",
    "Scanner side: parse installed/upgradable package manager output into binary packages plus source package associations.",
    "Matching side: make OVAL/vulnerability checks consider source packages without losing binary package names.",
    "Boundary: no tests, docs, examples, generated files, unrelated parsers, or package formats outside this task.",
    readOnly.length > 0 ? `Read-only check: ${readOnly.join(", ")}` : "Verify with the narrowest relevant package scanner/OVAL check.",
    "If a different production file appears necessary, stop and report the missing evidence."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 300));
}

function formatLifecyclePolicyOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = officialEditFiles(input).filter((file) => !isGenericDateUrlHelper(file)).slice(0, 5);
  const readOnly = (input.editScope?.readOnlyFiles ?? []).filter((file) => !isGenericDateUrlHelper(file)).slice(0, 2);
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn Policy Scope",
    `Task: ${compactTaskLine(input.task, 42)}`,
    "Action: update the lifecycle/deprecation contract in the policy/source surfaces only.",
    editFiles.length > 0 ? `Edit scope: ${editFiles.map((file) => `${file} (${lifecycleRole(file)})`).join(", ")}` : "Edit scope: the official lifecycle policy/source surfaces.",
    invariant ? `Preserve: ${truncateToBudget(invariant.statement, 38)}` : "Preserve existing version/date warning behavior while adding the requested lifecycle path.",
    "Boundary: do not edit generic date/url helpers, leaf modules, tests, docs, examples, or generated files unless explicitly requested.",
    readOnly.length > 0 ? `Read-only check: ${readOnly.join(", ")}` : "Verify with the narrowest relevant deprecation/policy check.",
    "If another source file seems necessary, stop and report the missing evidence."
  ];
  return fitSectionsToBudget(sections, Math.min(input.budget, 230));
}

function formatFrontendOwnerMapOfficialGuardrail(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
  budget: number;
}): string {
  const editFiles = officialEditFiles(input);
  const visible = editFiles.filter(isVisibleUiOwner).slice(0, 5);
  const supporting = editFiles.filter((file) => !isVisibleUiOwner(file) && isExplicitFrontendSupportSurface(file, input.task)).slice(0, 4);
  const ownerMap = uniquePaths([...visible, ...supporting]);
  const invariant = input.invariants?.[0];
  const sections = [
    "# Kairn Owner Map",
    `Task: ${compactTaskLine(input.task, 42)}`,
    "Action: patch only the visible owner cluster and explicitly required state/export surfaces.",
    ownerMap.length > 0 ? `Owner scope: ${ownerMap.map((file) => `${file} (${frontendRole(file)})`).join(", ")}` : "Owner scope: the official frontend owner surfaces.",
    invariant ? `Preserve: ${truncateToBudget(invariant.statement, 36)}` : "",
    "Boundary: skip style files, tests, snapshots, pre-recording variants, broad containers, and unrelated UI shells unless directly named.",
    "Verify with the narrowest component/model check.",
    "If ownership is unclear, stop and ask for a source-owner signal instead of broadening."
  ];
  return fitSectionsToBudget(sections.filter(Boolean), Math.min(input.budget, 260));
}

function isUiFeedbackMultiSurfaceTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return (
    /\b(voice|broadcast)\b/.test(normalized) &&
    /\b(ui|component|render|rendering|badge|header|icon|label|visible|visual|view|screen|frontend)\b/.test(normalized) &&
    /\b(live|liveness|state|status|feedback|recording|playback|call)\b/.test(normalized)
  );
}

function isExecutionStateMigrationTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const stateTerms =
    /\b(playiterator|play iterator|hoststate|host state|run_state|run state|fail_state|failure state|execution state|iterator state|state representation|strategy plugin|strategy plugins)\b/.test(normalized) ||
    /\b(iteratingstates|failedstates|iterating_tasks|iterating_setup|failed_setup|failed_tasks)\b/.test(normalized);
  const migrationTerms =
    /\b(enum|enums|enumeration|intenum|intflag|public type|public representation|namespaced|legacy constants?|deprecated constants?|deprecation warning|backward compatibility|third-party|strategy\/linear|strategy\/__init__|metaclass|attribute access|string output)\b/.test(normalized);
  const behaviorTerms =
    /\b(preserve|redirect|emit|warn|compare|transition|assignment|bitwise|combinable|state descriptions?|readable state names?)\b/.test(normalized);
  return stateTerms && migrationTerms && behaviorTerms;
}

function configOrderingGuardrail(task: string): string {
  const normalized = task.toLowerCase();
  const configTask =
    /\b(config|configuration|setting|settings|option|options|workaround|workarounds)\b/.test(normalized) &&
    /\b(add|support|implement|define|schema|metadata|accept|values?|default|argument|args?)\b/.test(normalized);
  if (!configTask) return "";
  return "Preserve ordering: for existing config/settings maps, append new entries unless nearby code explicitly sorts keys.";
}

export function officialGuardrailVariantFor(input: {
  task: string;
  files: string[];
  editScope: EditScopeDecision | undefined;
  invariants?: ContextInvariant[] | undefined;
}): OfficialGuardrailVariant {
  const editFiles = uniquePaths([
    ...input.files,
    ...(input.editScope?.initialEditFiles ?? [])
  ]);
  if (isDiscoveryConfigTask(input.task) && editFiles.length > 1) return "discovery_config_compact";
  if (isLifecyclePolicyTask(input.task)) return "lifecycle_policy_compact";
  if (isUiFeedbackMultiSurfaceTask(input.task)) return "frontend_owner_map_compact";
  if (isTopicOrderingTask(input.task) && editFiles.length > 1) return "topic_ordering_compact";
  if (isCollectionNameValidationTask(input.task) && editFiles.length > 1) return "collection_name_validation_compact";
  if (isExecutionStateMigrationTask(input.task) && editFiles.length > 1) return "execution_state_migration_compact";
  if (isGrpcErrorPolicyTask(input.task) && editFiles.length > 1) return "grpc_error_policy_compact";
  if (isRequestBodyFormTask(input.task) && editFiles.length > 1) return "request_body_form_compact";
  if (isConverterOutputTask(input.task) && editFiles.length > 1) return "paired_contract_compact";
  if (isBenchmarkGeneratorTask(input.task) && editFiles.length > 1) return "benchmark_generator_compact";
  if (isDatabaseFailoverTask(input.task) && editFiles.length > 1) return "paired_contract_compact";
  if (isPackageSourceMappingTask(input.task) && editFiles.length > 1) return "package_source_mapping_compact";
  if (isDatastoreBackendParityTask(input.task) && editFiles.length > 1) return "paired_contract_compact";
  if (isPairedContractTask(input.task) && editFiles.length > 1) return "paired_contract_compact";
  if (editFiles.length > 1 && isRequirementHeavyMultiSurfaceTask(input.task)) return "paired_contract_compact";
  if (editFiles.length < 1 || editFiles.length > 2) return "semantic_official";
  if ((input.invariants?.length ?? 0) === 0) return "compact_official";
  return isTrivialExactSourceOfficialTask(input.task) ? "compact_official" : "semantic_official";
}

function officialEditFiles(input: {
  files: string[];
  editScope: EditScopeDecision | undefined;
}): string[] {
  return uniquePaths([
    ...input.files,
    ...(input.editScope?.initialEditFiles ?? [])
  ]).filter(isOfficialProductionEditFile);
}

function isOfficialProductionEditFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (/(^|\/)(tests?|testing|__tests__|spec|specs|fixtures?|testdata)\//.test(normalized)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return false;
  if (/(_test|_spec|_tests)\.(py|go|rb|cc|cpp|cxx|c|hpp|hh|hxx)$/.test(normalized)) return false;
  if (/(test|tests)\.java$/.test(normalized.split("/").at(-1) ?? "")) return false;
  return true;
}

function isPairedContractTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(command|commands?|cli|flag|flags|argument|arguments|args?|namespace|namespaces|variant|variants|sorting|sort|export|exports?|startup|runtime option|configuration|config|setting|settings|schema|session renewal|renew(?:ing)? session|websession|web session|certificate|access request)\b/.test(normalized);
}

function isTopicOrderingTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(topic|topics)\b/.test(normalized) &&
    /\b(pin|pinned|unpin|unpinned)\b/.test(normalized) &&
    /\b(order|ordering|reorder|reordering|position|relative)\b/.test(normalized);
}

function isDatabaseFailoverTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const databaseTerms = /\b(database|databases|db)\b/.test(normalized);
  const serviceTerms = /\b(service|services|server|servers|databaseserver|database server|database service)\b/.test(normalized);
  const failoverTerms = /\b(ha|high availability|failover|candidate|candidates|retry|shuffle|randomi[sz]e|offline tunnel|tunnel outage|reachable|unreachable|deduplicate|dedupe|same-name|same name|hostid|serverid|proxy context|tsh db ls)\b/.test(normalized);
  return databaseTerms && serviceTerms && failoverTerms;
}

function isRequestBodyFormTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(unflatten|flattened|nested|indexed|parent keys?|form data|body data|request body|query string|query parameters?|duplicate (?:simple )?keys?|assignments?)\b/.test(normalized) &&
    /\b(post|form|body|request|endpoint|route|handler|seeds?|defaults?)\b/.test(normalized);
}

function isCollectionNameValidationTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const validationTerms = /\b(validat(?:e|es|ed|ing|ion)|invalid|reject|accept|allowed?)\b/.test(normalized);
  const collectionTerms = /\b(collection names?|fqcn|fully qualified collection name|namespace\.collection|namespace|reserved keyword|python keyword|keyword)\b/.test(normalized);
  const packageSourceTerms = /\b(source packages?|binary packages?|src packages?|package source|source package associations?|oval|vulnerabilit(?:y|ies)|scanner|package manager|upgradable|installed packages?)\b/.test(normalized);
  return validationTerms && collectionTerms && !packageSourceTerms;
}

function isBenchmarkGeneratorTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const benchmarkTerms = /\b(benchmark|benchmarks|benchmarking|performance benchmark|load test|request rate|requests per second|rps)\b/.test(normalized);
  const generatorTerms = /\b(generator|generate|sequence|progression|linear|lower bound|upper bound|step size|minimum measurements|minimum window|getbenchmark|configuration|configurations)\b/.test(normalized);
  return benchmarkTerms && generatorTerms;
}

function isGrpcErrorPolicyTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const grpcTerms = /\b(grpc|rpc|status code|status codes|code canceled|code deadlineexceeded|deadline exceeded|unauthenticated|internal)\b/.test(normalized);
  const contextTerms = /\b(context\.canceled|context canceled|cancelled context|canceled context|context cancellation|context timeout|context\.deadlineexceeded|deadline exceeded|timeout|cancelled|canceled)\b/.test(normalized);
  const policyTerms = /\b(classif(?:y|ied|ication)|map|mapping|return|respond|propagate|convert|middleware|auth(?:entication)?|server)\b/.test(normalized);
  return grpcTerms && contextTerms && policyTerms;
}

function isPackageSourceMappingTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (isNarrowPackageParserTask(normalized)) return false;
  return /\b(source packages?|binary packages?|src packages?|package source|source package associations?|sourcerpm|source rpm|src\.rpm|rpm|apk|alpine|redhat|rhel|centos)\b/.test(normalized) &&
    /\b(oval|vulnerabilit(?:y|ies)|scanner|package manager|upgradable|installed packages?)\b/.test(normalized);
}

function grpcPolicyRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\/cmd\/grpc\./.test(normalized) || /(^|\/)grpc\./.test(normalized)) return "server wiring";
  if (/\/auth\/middleware\./.test(normalized)) return "auth middleware";
  if (/\/middleware\/grpc\/middleware\./.test(normalized)) return "grpc middleware";
  return officialFileRole(file);
}

function grpcPolicyAction(file: string): string {
  const role = grpcPolicyRole(file);
  if (role === "grpc middleware") {
    return "map wrapped context cancellation/deadline errors to Canceled/DeadlineExceeded before default Internal handling";
  }
  if (role === "auth middleware") {
    return "propagate context cancellation/deadline errors instead of converting them to Unauthenticated/Internal";
  }
  if (role === "server wiring") {
    return "keep/order the existing middleware chain only; do not implement a standalone context interceptor as the fix";
  }
  return `${role}; edit only if it owns context cancellation/deadline status policy`;
}

function grpcPolicyDirectiveRank(file: string): number {
  const normalized = file.toLowerCase();
  if (/\/middleware\/grpc\/middleware\./.test(normalized)) return 0;
  if (/\/auth\/middleware\./.test(normalized)) return 1;
  if (/\/cmd\/grpc\./.test(normalized) || /(^|\/)grpc\./.test(normalized)) return 2;
  return 3;
}

function sortGrpcPolicyFilesForDirective(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const rankDelta = grpcPolicyDirectiveRank(a) - grpcPolicyDirectiveRank(b);
    return rankDelta !== 0 ? rankDelta : a.localeCompare(b);
  });
}

function isDiscoveryConfigTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(discovery|discover|autodiscovery|well[- ]?known|homeserver|server discovery)\b/.test(normalized) &&
    /\b(config|configuration|validated|validate|delegated|authentication|auth|metadata|contract|m\.authentication)\b/.test(normalized);
}

function isConverterOutputTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (isPackageSourceMappingTask(task)) return false;
  const converterSignal =
    /\b(convert|converts|converted|converter|converters|conversion|adapter|adapters)\b/.test(normalized) ||
    /\b(trivy to vuls|trivy-to-vuls)\b/.test(normalized);
  const outputSignal =
    /\b(output|outputs|json|record|records|finding|findings|report|reports|contents?|cve|cves|severity|severities|debian|vuls|trivy)\b/.test(normalized);
  return converterSignal && outputSignal;
}

function isDatastoreBackendParityTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const collectionMutation =
    /\b(list|lists|set|sets|zset|hash|queue|collection|collections)\b/.test(normalized) &&
    /\b(remove|removing|delete|deleting|del|discard|pull|pop|trim|add|insert|push)\b/.test(normalized);
  const multiValue =
    /\b(multiple|distinct|array|arrays|elements?|values?|batch|bulk|several)\b/.test(normalized) ||
    /\[[^\]]+,[^\]]+\]/.test(task);
  return collectionMutation && multiValue;
}

function isRequirementHeavyMultiSurfaceTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const requirementMarkers = (normalized.match(/\n\s*-\s+/g) ?? []).length;
  return requirementMarkers >= 3 && /\b(requirements?|interface notes?|selected (?:verification )?tests)\b/.test(normalized);
}

function isLifecyclePolicyTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (isNarrowPackageParserTask(normalized)) return false;
  return /\b(deprecat(?:e|ed|ion)|removed?_?(?:in|at)|removal|lifecycle|alias|aliases|warning|warnings)\b/.test(normalized) &&
    /\b(date|version|policy|module|plugin|schema|metadata|validate|validation|warn|warning|removed)\b/.test(normalized);
}

function isNarrowPackageParserTask(normalized: string): boolean {
  const rpmParserTerms =
    /\b(sourcerpm|source rpm|src\.rpm|rpm filenames?|source filenames?|splitfilename|parseinstalledpackagesline|epoch)\b/.test(normalized);
  const scannerTerms = /\b(scanner|package manager|installed packages?|package information|package metadata|redhat|rhel|centos|rpm)\b/.test(normalized);
  const mappingTerms =
    /\b(oval|vulnerability matching|binary packages? derive|source package associations?|map binary packages?|package index|upgradable)\b/.test(normalized);
  return rpmParserTerms && scannerTerms && !mappingTerms;
}

function isGenericDateUrlHelper(file: string): boolean {
  const normalized = file.toLowerCase();
  return /(?:^|\/)(?:date|date_time|time|url|urlutils|utils?)\.(?:py|ts|tsx|js|go|rb|java|cs|cpp|c|h)$/.test(normalized) ||
    /\/facts\/(?:system\/)?date_time\./.test(normalized);
}

function officialFileRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\b(configdata|settings?|schema|options?)\b/.test(normalized)) return "schema/config";
  if (/\b(command|cmd|cli|args?|flags?)\b/.test(normalized)) return "command";
  if (/\b(export|serializer|writer)\b/.test(normalized)) return "exporter";
  if (/\b(runtime|launcher|startup)\b/.test(normalized)) return "runtime";
  return "source";
}

function databaseFailoverRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\bdatabaseserver\b/.test(normalized)) return "identity/sort contract";
  if (/\/srv\/db\/proxyserver\./.test(normalized) || /\/db\/proxyserver\./.test(normalized)) return "proxy retry/shuffle";
  if (/\/reversetunnel\/fake\./.test(normalized) || /\bfake(?:remote)?site\b/.test(normalized)) return "tunnel failure simulation";
  if (/(^|\/)tool\/tsh\/db\./.test(normalized) || /\/cli\/.*db\./.test(normalized)) return "CLI/list output";
  return officialFileRole(file);
}

function databaseFailoverDirectiveRank(file: string): number {
  const role = databaseFailoverRole(file);
  if (role === "identity/sort contract") return 0;
  if (role === "proxy retry/shuffle") return 1;
  if (role === "CLI/list output") return 2;
  if (role === "tunnel failure simulation") return 3;
  return 4;
}

function sortDatabaseFailoverDirectiveFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const rankDelta = databaseFailoverDirectiveRank(a) - databaseFailoverDirectiveRank(b);
    return rankDelta !== 0 ? rankDelta : a.localeCompare(b);
  });
}

function requestBodyFormRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\b(list|lists|route|routes|handler|controller|view|views)\b/.test(normalized)) return "route/form handler";
  if (/\b(unflatten|flatten|form|forms|request|utils?)\b/.test(normalized)) return "flattened-data utility";
  return "source";
}

function discoveryConfigRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\bvalidated|serverconfig|server_config|config(?:uration)?\b/.test(normalized)) return "validated config contract";
  if (/\b(auto)?discovery|wellknown|well-known|homeserver\b/.test(normalized)) return "discovery parser";
  return "source";
}

function packageSourceRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\bscanner\/alpine\b|\balpine\./.test(normalized)) return "package manager scanner";
  if (/\bscanner\/scanner\b/.test(normalized)) return "scanner dispatch";
  if (/\boval\/util\b/.test(normalized)) return "vulnerability matcher";
  if (/\boval\/alpine\b/.test(normalized)) return "alpine OVAL surface";
  return "source";
}

function lifecycleRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\b(schema|metadata|parameters?|argument_spec|configdata)\b/.test(normalized)) return "policy/schema";
  if (/\b(warning|warnings|display|deprecat)\b/.test(normalized)) return "warning path";
  if (/\b(basic|module_utils|module)\b/.test(normalized)) return "runtime contract";
  return "source";
}

function isVisibleUiOwner(file: string): boolean {
  const normalized = file.toLowerCase();
  return /\.(tsx|jsx|vue|svelte)$/.test(normalized) &&
    /\b(component|components|view|views|atoms|molecules|organisms|page|pages|screen|screens)\b/.test(normalized) &&
    !/\b(test|spec|snapshot|style|css|scss|pcss|pre[-_]?recording)\b/.test(normalized);
}

function isExplicitFrontendSupportSurface(file: string, task: string): boolean {
  const normalized = file.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (/\b(test|spec|snapshot|style|css|scss|pcss|pre[-_]?recording)\b/.test(normalized)) return false;
  if (/\b(hooks?|models?|stores?|actions?|selectors?|utils?|index)\b/.test(normalized)) {
    return /\b(state|model|hook|export|type|event|events|playback|recording|liveness|live)\b/.test(normalizedTask);
  }
  return false;
}

function frontendRole(file: string): string {
  const normalized = file.toLowerCase();
  if (/\bhooks?\b/.test(normalized)) return "hook";
  if (/\bmodels?\b/.test(normalized)) return "model";
  if (/(?:^|\/)index\./.test(normalized)) return "export";
  if (/\butils?\b/.test(normalized)) return "utility";
  return "visible component";
}

function isTrivialExactSourceOfficialTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (/\b(typeerror|traceback|stack trace|unsupported operand|combine|merge|interact|interaction|pipeline|lifecycle|flow|config(?:uration)?|session|cookie|auth|counts?|logging)\b/.test(normalized)) {
    return false;
  }
  if (/\b(two|three|multiple|several|both|across)\s+(?:production\s+)?(?:files?|sources?|functions?|modules?)\b/.test(normalized)) {
    return false;
  }
  return true;
}

export function fitSectionsToBudget(sections: string[], budget: number): string {
  const accepted: string[] = [];
  let used = 0;
  for (const section of sections) {
    const tokens = estimateTokens(section);
    if (used + tokens <= budget) {
      accepted.push(section);
      used += tokens;
      continue;
    }
    const remaining = Math.max(0, budget - used - 16);
    if (remaining > 60) {
      accepted.push(truncateToBudget(section, remaining));
    }
    break;
  }
  return accepted.join("\n");
}

function formatTinyDirectivePrime(input: { prime: ContextPrime; budget: number }): string {
  const files = input.prime.files.slice(0, 3);
  const likelyTest = files.find((file) => /\b(test|spec)\b|__tests__/.test(file));
  const symbols = extractPrimeSymbolHints(input.prime.content).slice(0, 4);
  const lines = [
    "# Kairn Start Points",
    "",
    "Use these before broad repo search.",
    "",
    `Task: ${compactTaskLine(input.prime.task)}`,
    `Session: ${input.prime.session.id}`,
    "",
    "Start here:",
    files.length > 0
      ? files.map((file, index) => `${index + 1}. ${file}`).join("\n")
      : "No high-confidence start file found.",
    symbols.length > 0 ? `Symbols: ${symbols.join(", ")}` : "",
    ...formatInvariantSections(input.prime.invariants, "Invariant:"),
    ...(input.prime.editScope ? editScopeBlock(input.prime.editScope, "Edit scope:") : []),
    likelyTest ? `Likely test: ${likelyTest}` : "",
    "",
    "Instruction: inspect the start files first; only use broad search if these are insufficient."
  ].filter(Boolean);

  return fitSectionsToBudget(lines, input.budget);
}

function compactTaskLine(task: string, budget = 72): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  const maxChars = Math.max(80, budget * 4);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatInvariantSections(
  invariants: ContextInvariant[] | undefined,
  heading: string,
  options: { includeVerification?: boolean | undefined } = {}
): string[] {
  const invariant = invariants?.[0];
  if (!invariant) return [];
  return [[
    heading,
    `- ${invariant.statement}`,
    invariant.evidence ? `Evidence: ${invariant.evidence}` : "",
    options.includeVerification !== false && invariant.verificationCommand ? `Verification: ${invariant.verificationCommand}` : ""
  ].filter(Boolean).join("\n")];
}

function formatMinimalInvariantSections(invariants: ContextInvariant[] | undefined, heading: string): string[] {
  const invariant = invariants?.[0];
  if (!invariant) return [];
  return [[heading, `- ${truncateToBudget(invariant.statement, 36)}`].join("\n")];
}

function formatMinimalEditScope(scope: EditScopeDecision | undefined): string[] {
  if (!scope) return [];
  const initial = scope.initialEditFiles.length > 0 ? scope.initialEditFiles.join(", ") : "none yet";
  if (scope.strictBoundary) {
    return [
      "Edit scope:",
      `- Initial edit scope: ${initial}`,
      "- Hard boundary: do not edit outside the initial scope in this turn.",
      "- If another source file seems necessary, leave it read-only and report the missing evidence."
    ];
  }
  const firstTrigger = truncateToBudget(
    scope.allowedExpansionTriggers[0] ?? "a focused check proves another file is required",
    28
  );
  return ["Edit scope:", `- Initial edit scope: ${initial}`, `- Expand only if ${firstTrigger}.`];
}

function formatMinimalReadOnlyScope(scope: EditScopeDecision | undefined): string[] {
  if (!scope?.readOnlyFiles.length) return [];
  return ["Read-only verification:", `- ${scope.readOnlyFiles.slice(0, 2).join(", ")}`];
}

function primaryReasonForFile(context: ContextResponse, filePath: string): string {
  const line = context.content
    .split(/\r?\n/)
    .find((entry) => entry.includes(filePath) && entry.includes(":"));
  if (!line) return `Top Kairn-ranked file for this task: ${filePath}`;
  return truncateToBudget(line.replace(/^[-*\s]+/, ""), 48);
}

function sourceMapReasonForFile(context: ContextResponse, filePath: string): string {
  const ranked = context.rankedFiles?.find((file) => file.path === filePath);
  const rankedReason = ranked?.reasons.find((reason) => !/\b(score|bm25|semantic|keyword)\b/i.test(reason));
  if (rankedReason) return truncateToBudget(rankedReason.replace(/\s+/g, " "), 18);
  const line = context.content
    .split(/\r?\n/)
    .find((entry) => entry.includes(filePath) && entry.includes(":"));
  if (!line) return "Kairn-ranked source for this task.";
  const afterScore = line.includes("):") ? line.split("):").slice(1).join("):") : line.split(":").slice(1).join(":");
  return truncateToBudget(afterScore.replace(/^[-*\s]+/, "").replace(/\s+/g, " ").trim(), 18) || "Kairn-ranked source for this task.";
}

function extractPrimeSymbolHints(content: string): string[] {
  const symbols: string[] = [];
  for (const match of content.matchAll(/\bsymbol match:\s*([A-Za-z_$][\w$]*)/g)) {
    symbols.push(match[1]!);
  }
  for (const match of content.matchAll(/\bsymbol:\s*([A-Za-z_$][\w$]*)/g)) {
    symbols.push(match[1]!);
  }
  return uniqueStrings(symbols);
}

function formatFocusedContextBlock(content: string, budget: number): string {
  const compact = compactPrimeContext(content, budget).trim();
  return compact ? ["Focused context:", compact].join("\n") : "";
}

function compactPrimeContext(content: string, budget: number): string {
  const snippetIndex = content.indexOf("## Matched Snippets");
  const selected = snippetIndex >= 0 ? content.slice(snippetIndex).replace(/^## Matched Snippets\s*/m, "").trim() : content;
  return truncateToBudget(selected, budget);
}
