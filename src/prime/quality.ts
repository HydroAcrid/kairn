import type { ContextResponse, FileRecord, PrimeProfile, PrimeQuality } from "../types.js";
import { classifyQueryIntent } from "../retrieval/queryIntent.js";

export type ResolvedPrimeProfile = Exclude<PrimeProfile, "auto">;

export type PrimeProfileLimits = {
  topFiles: number;
  relatedFiles: number;
  testFiles: number;
  contextRatio: number;
  snippetBudget: number;
  includeCommands: boolean;
};

export function evaluatePrimeQuality(input: {
  task: string;
  context: ContextResponse;
  knownFiles: FileRecord[];
}): PrimeQuality {
  const scores = extractRankedScores(input.context.content);
  const topScore = scores[0] ?? 0;
  const secondScore = scores[1] ?? 0;
  const topGap = Number(Math.max(0, topScore - secondScore).toFixed(3));
  const normalizedTask = input.task.toLowerCase();
  const exactPathMentioned = input.knownFiles.some((file) => normalizedTask.includes(file.path.toLowerCase()));
  const reasons: string[] = [];

  if (exactPathMentioned) reasons.push("prompt already names an exact indexed file");
  if (topScore >= 250) reasons.push("high-confidence top retrieval score");
  if (topGap >= 80) reasons.push("top result is clearly separated");
  if (topScore > 0 && topScore < 90) reasons.push("low top retrieval score");
  if (topScore > 0 && topGap < 20) reasons.push("top results are tightly clustered");
  if (input.context.files.length === 0) reasons.push("no retrieved files");

  let score = 42;
  score += Math.min(34, topScore / 24);
  score += Math.min(18, topGap / 12);
  if (exactPathMentioned) score -= 44;
  if (input.context.files.length === 0) score -= 45;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const action = exactPathMentioned || score < 42
    ? "suppress"
    : score < 68 || topGap < 20
      ? "shrink"
      : "emit";
  const expectedSavingsRisk = action === "suppress" ? "high" : action === "shrink" ? "medium" : "low";

  return {
    score,
    action,
    reasons: reasons.length > 0 ? reasons : ["retrieval confidence is acceptable"],
    topScore,
    topGap,
    exactPathMentioned,
    expectedSavingsRisk
  };
}

export function resolvePrimeProfile(profile: PrimeProfile, task: string): ResolvedPrimeProfile {
  if (profile !== "auto") return profile;
  if (isFailureDebugTask(task)) return "failure_debug";
  const intent = classifyQueryIntent(task).primary;
  if (intent === "ui" || intent === "workflow" || intent === "test") return intent;
  if (intent === "backend" || intent === "data" || intent === "auth") return "backend";
  return "generic";
}

export function defaultPrimeBudget(profile: ResolvedPrimeProfile, task = ""): number {
  switch (profile) {
    case "ui":
      return 700;
    case "workflow":
      return 900;
    case "backend":
      return 1100;
    case "failure_debug":
      return languageDebugBudget(task);
    case "test":
      return 900;
    case "generic":
      return 800;
  }
}

export function primeProfileLimits(profile: ResolvedPrimeProfile): PrimeProfileLimits {
  switch (profile) {
    case "ui":
      return { topFiles: 3, relatedFiles: 2, testFiles: 2, contextRatio: 0.5, snippetBudget: 330, includeCommands: false };
    case "workflow":
      return { topFiles: 4, relatedFiles: 3, testFiles: 2, contextRatio: 0.55, snippetBudget: 430, includeCommands: false };
    case "backend":
      return { topFiles: 4, relatedFiles: 3, testFiles: 3, contextRatio: 0.62, snippetBudget: 560, includeCommands: true };
    case "failure_debug":
      return { topFiles: 1, relatedFiles: 0, testFiles: 1, contextRatio: 0.72, snippetBudget: 430, includeCommands: false };
    case "test":
      return { topFiles: 4, relatedFiles: 2, testFiles: 4, contextRatio: 0.56, snippetBudget: 430, includeCommands: true };
    case "generic":
      return { topFiles: 3, relatedFiles: 2, testFiles: 2, contextRatio: 0.5, snippetBudget: 360, includeCommands: false };
  }
}

export function isFailureDebugTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const debugTerms = ["debug", "failing", "failure", "regression", "broken", "incorrect", "fix"];
  const verificationTerms = ["test", "check", "assert", "verification", "seeded"];
  return debugTerms.some((term) => normalized.includes(term)) &&
    verificationTerms.some((term) => normalized.includes(term));
}

function languageDebugBudget(task: string): number {
  const normalized = task.toLowerCase();
  if (/\b(c\+\+|cpp|header|\.hpp|\.h|\.cc|\.cpp|fmt|string_view)\b/.test(normalized)) return 550;
  if (/\bpython|\.py|ansi|click\b/.test(normalized)) return 650;
  if (/\bjava|maven|mvn|\.java\b/.test(normalized)) return 750;
  if (/\btypescript|javascript|tsx|jsx|tanstack|query\b/.test(normalized)) return 900;
  return 800;
}

function extractRankedScores(content: string): number[] {
  const scores: number[] = [];
  const pattern = /score\s+([\d.]+)/g;
  for (const match of content.matchAll(pattern)) {
    const score = Number(match[1]);
    if (Number.isFinite(score)) scores.push(score);
  }
  return scores;
}
