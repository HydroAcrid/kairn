import type { ContextInvariant, ContextPrime, ContextResponse, EditScopeDecision, EvidenceRequest, PrimeQuality } from "../types.js";
import { editScopeBlock, editScopeLine } from "../scope/editScope.js";
import { estimateTokens, truncateToBudget } from "../utils/tokens.js";
import { uniquePaths, uniqueStrings } from "../utils/collections.js";
import type { PrimeProfileLimits, ResolvedPrimeProfile } from "./quality.js";

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
  const topFiles = uniquePaths(
    input.files && input.files.length > 0
      ? input.files
      : input.context.suggestedNextContext.length > 0
        ? input.context.suggestedNextContext
        : input.context.files
  ).slice(0, input.files && input.files.length > 1 ? 2 : 1);
  const symbolHints = extractPrimeSymbolHints(input.context.content).slice(0, 2);
  const multiFileDirective = topFiles.length > 1;
  const focusedContext = input.includeSnippet === false
    ? ""
    : formatFocusedContextBlock(input.context.content, Math.max(100, Math.floor(input.budget * 0.24)));
  if (input.minimal) {
    const sections = [
      "# Kairn Fix Guardrail",
      "",
      "Start file:",
      topFiles.length > 0 ? `- ${topFiles[0]}` : "- No high-confidence source file found.",
      "",
      ...formatMinimalInvariantSections(input.invariants, "Invariant to preserve:"),
      "",
      "Edit boundary: make the smallest production-source edit. Do not edit tests, snapshots, docs, examples, generated files, or sibling source files unless a focused failure proves expansion.",
      "Verification hint: use the narrowest relevant check.",
      "Stop condition: stop after the start-file edit unless a failure names another source file.",
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
    symbolHints.length > 0 ? `Symbols: ${symbolHints.join(", ")}` : "",
    "",
    ...formatInvariantSections(input.invariants, "Invariant to preserve:", { includeVerification: input.includeVerification ?? multiFileDirective }),
    "",
    multiFileDirective
      ? "Stop condition: inspect only these source files first; avoid broad related-file/test scans unless neither file can satisfy the invariant or a failure names another file."
      : "Stop condition: preserve the invariant in the start file first; avoid broad related-file/test scans unless this file cannot satisfy the invariant or a failure names another file.",
    "",
    ...(input.editScope ? editScopeBlock(input.editScope, "Edit scope:", { includeReadOnly: multiFileDirective }) : []),
    focusedContext ? "" : "",
    focusedContext
  ].filter(Boolean);
  return fitSectionsToBudget(sections, input.budget);
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

function compactTaskLine(task: string): string {
  return truncateToBudget(task.replace(/\s+/g, " ").trim(), 72);
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
  const firstTrigger = truncateToBudget(
    scope.allowedExpansionTriggers[0] ?? "a focused check proves another file is required",
    28
  );
  return ["Edit scope:", `- Initial edit scope: ${initial}`, `- Expand only if ${firstTrigger}.`];
}

function primaryReasonForFile(context: ContextResponse, filePath: string): string {
  const line = context.content
    .split(/\r?\n/)
    .find((entry) => entry.includes(filePath) && entry.includes(":"));
  if (!line) return `Top Kairn-ranked file for this task: ${filePath}`;
  return truncateToBudget(line.replace(/^[-*\s]+/, ""), 48);
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
