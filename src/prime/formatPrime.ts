import type { ContextPrime, ContextResponse, PrimeQuality } from "../types.js";
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
}): string {
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
    "Instruction: call `kairn_prepare_task` with this session id before broad scans, then use `kairn_get_next_context` for the next smallest read.",
    `Suggested MCP call: kairn_prepare_task({ "task": ${JSON.stringify(input.task)}, "sessionId": ${JSON.stringify(input.sessionId)}, "detail": "compact" })`,
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

export function formatShrunkPrimeContext(input: {
  task: string;
  sessionId: string;
  profile: ResolvedPrimeProfile;
  quality: PrimeQuality;
  context: ContextResponse;
  budget: number;
}): string {
  const topFiles = input.context.suggestedNextContext.slice(0, 3);
  const sections = [
    "# Kairn Compact Prime",
    "",
    `Task: ${input.task}`,
    `Kairn session: ${input.sessionId}`,
    `Prime profile: ${input.profile}`,
    `Quality score: ${input.quality.score} (${input.quality.action})`,
    "",
    "## Start Here",
    topFiles.length > 0 ? topFiles.map((file) => `- ${file}`).join("\n") : "- No high-confidence files found.",
    "",
    "## Targeted Context",
    compactPrimeContext(input.context.content, Math.max(160, Math.floor(input.budget * 0.42))),
    "",
    "## Agent Guidance",
    "- Use this only as a starting point; avoid broad scans if these files fit the task."
  ];
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
    `Task: ${input.prime.task}`,
    `Session: ${input.prime.session.id}`,
    "",
    "Start here:",
    files.length > 0
      ? files.map((file, index) => `${index + 1}. ${file}`).join("\n")
      : "No high-confidence start file found.",
    symbols.length > 0 ? `Symbols: ${symbols.join(", ")}` : "",
    likelyTest ? `Likely test: ${likelyTest}` : "",
    "",
    "Instruction: inspect the start files first; only use broad search if these are insufficient."
  ].filter(Boolean);

  return fitSectionsToBudget(lines, input.budget);
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

function compactPrimeContext(content: string, budget: number): string {
  const snippetIndex = content.indexOf("## Matched Snippets");
  const selected = snippetIndex >= 0 ? content.slice(snippetIndex).replace(/^## Matched Snippets\s*/m, "").trim() : content;
  return truncateToBudget(selected, budget);
}
