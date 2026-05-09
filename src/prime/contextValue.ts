import type { ContextResponse, ContextValueDecision, FileRecord, PrimeQuality } from "../types.js";
import type { ResolvedPrimeProfile } from "./quality.js";
import { isFailureDebugTask } from "./quality.js";

export function evaluateContextValue(input: {
  task: string;
  profile: ResolvedPrimeProfile;
  context: ContextResponse;
  quality: PrimeQuality;
  knownFiles: FileRecord[];
  repoFileCount: number;
  estimatedContextCost: number;
}): ContextValueDecision {
  const primaryFile = input.context.suggestedNextContext[0] ?? input.context.files[0];
  const primaryRecord = input.knownFiles.find((file) => file.path === primaryFile);
  const language = inferLanguage(primaryFile);
  const debugSignal = input.profile === "failure_debug" || isFailureDebugTask(input.task);
  const sourceFixSignal = isSourceFixTask(input.task);
  const easyTaskSignal = isEasyTask(input.task);
  const vagueImprovementSignal = isVagueImprovementTask(input.task);
  const wrongContextRisk = Boolean(
    primaryFile &&
      sourceFixSignal &&
      (isNoisyPath(primaryFile.toLowerCase()) || primaryRecord?.kind === "test" || !isPrimarySourcePath(primaryFile))
  );
  const reasons = new Set<string>(input.quality.reasons);

  let score = input.quality.score;
  if (debugSignal) {
    score += 12;
    reasons.add("debug/failure task can benefit from targeted context");
  }
  if (primaryFile && isPrimarySourcePath(primaryFile)) {
    score += 8;
    reasons.add("top result is a production source file");
    if (input.quality.topScore >= 160 && input.quality.topGap >= 20) {
      reasons.add("high-confidence exact source target supports compact context");
    }
  }
  if (wrongContextRisk) {
    score -= input.repoFileCount >= 1500 ? 58 : 38;
    reasons.add("top result is risky for a production-source fix");
  }
  if (debugSignal && primaryRecord?.kind === "test" && !hasExplicitTestPathSignal(input.task)) {
    score -= 34;
    reasons.add("top result is a test but the prompt does not name a failing test file");
  }
  if (input.repoFileCount >= 1500) {
    score += 6;
    reasons.add("large repo increases value of targeted context");
  }
  if (input.quality.exactPathMentioned) {
    score -= 32;
    reasons.add("prompt already names an exact indexed file");
  }
  if (easyTaskSignal && !debugSignal) {
    score -= 16;
    reasons.add("task appears simple enough that broad priming may not repay its cost");
  }
  if (vagueImprovementSignal && !debugSignal) {
    score -= input.repoFileCount >= 1500 ? 42 : 28;
    reasons.add("task is broad and lacks a concrete source target");
  }
  if (input.quality.topGap < 20) {
    score -= 12;
    reasons.add("top retrieval candidates are not well separated");
  }
  if (input.quality.topScore < 90) {
    score -= 18;
    reasons.add("top retrieval score is low");
  }
  if (input.estimatedContextCost > 900 && language === "cpp") {
    score -= 10;
    reasons.add("C/C++ context is conservative until compile-aware indexing exists");
  }
  if (language === "cpp" && input.quality.topScore < 230) {
    score -= 16;
    reasons.add("C++ top result is not strong enough for a full prime");
  }
  if (input.context.files.length === 0) {
    score -= 45;
    reasons.add("no retrieved files");
  }

  score = Math.round(Math.max(0, Math.min(100, score)));
  const action = chooseAction({
    score,
    debugSignal,
    easyTaskSignal,
    vagueImprovementSignal,
    exactPathMentioned: input.quality.exactPathMentioned,
    topScore: input.quality.topScore,
    topGap: input.quality.topGap,
    language,
    wrongContextRisk,
    primarySource: Boolean(primaryFile && isPrimarySourcePath(primaryFile))
  });
  const expectedSavingsRisk = action === "emit" ? "low" : action === "shrink" ? "medium" : "high";

  return {
    score,
    action,
    reasons: [...reasons],
    topScore: input.quality.topScore,
    topGap: input.quality.topGap,
    ...(primaryFile ? { primaryFile } : {}),
    language,
    exactPathMentioned: input.quality.exactPathMentioned,
    estimatedContextCost: input.estimatedContextCost,
    expectedSavingsRisk,
    debugSignal,
    easyTaskSignal,
    wrongContextRisk
  };
}

function chooseAction(input: {
  score: number;
  debugSignal: boolean;
  easyTaskSignal: boolean;
  vagueImprovementSignal: boolean;
  exactPathMentioned: boolean;
  topScore: number;
  topGap: number;
  language: ContextValueDecision["language"];
  wrongContextRisk: boolean;
  primarySource: boolean;
}): ContextValueDecision["action"] {
  if (input.exactPathMentioned) return "suppress";
  if (input.wrongContextRisk && input.score < 72) return "suppress";
  if (input.wrongContextRisk) return "shrink";
  if (input.vagueImprovementSignal && !input.debugSignal) return input.score >= 88 && input.topGap >= 80 ? "shrink" : "suppress";
  if (input.topScore <= 0 || input.score < 38) return "suppress";
  if (input.language === "cpp" && input.score < 78) return "shrink";
  if (input.easyTaskSignal && !input.debugSignal && input.score < 82) {
    return input.primarySource && input.topScore >= 160 && input.topGap >= 20 ? "shrink" : "suppress";
  }
  if (input.score < 68 || input.topGap < 20) return "shrink";
  return "emit";
}

function inferLanguage(filePath: string | undefined): ContextValueDecision["language"] {
  const normalized = (filePath ?? "").toLowerCase();
  if (/\.(ts|tsx)$/.test(normalized)) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(normalized)) return "javascript";
  if (/\.pyi?$/.test(normalized)) return "python";
  if (/\.java$/.test(normalized)) return "java";
  if (/^include\/.*\.(h|hpp|hh|hxx)$/.test(normalized) || normalized.includes("/include/")) return "cpp";
  if (/\.(cc|cpp|cxx|hpp|hh|hxx)$/.test(normalized)) return "cpp";
  if (/\.(c|h)$/.test(normalized)) return "c";
  return "unknown";
}

function isPrimarySourcePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (isNoisyPath(normalized)) return false;
  return (
    normalized.startsWith("src/") ||
    normalized.startsWith("packages/") ||
    normalized.startsWith("include/") ||
    (/\.pyi?$/.test(normalized) && !/(^|\/)(tests?|docs?|examples)\//.test(normalized)) ||
    normalized.includes("/src/") ||
    normalized.includes("/include/") ||
    normalized.includes("/src/main/java/")
  );
}

function isNoisyPath(normalizedPath: string): boolean {
  return (
    normalizedPath.startsWith("docs/") ||
    normalizedPath.startsWith("doc/") ||
    normalizedPath.startsWith("examples/") ||
    normalizedPath.includes("/docs/") ||
    normalizedPath.includes("/doc/") ||
    normalizedPath.includes("/examples/") ||
    normalizedPath.includes("codemod") ||
    normalizedPath.includes("devtools")
  );
}

function isSourceFixTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(fix|debug|regression|bug|broken|production source|source)\b/.test(normalized);
}

function hasExplicitTestPathSignal(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(test|tests|spec|pytest|vitest|jest)\b/.test(normalized) && /(\.|\/)(test|spec)|test_|\btests?\//.test(normalized);
}

function isEasyTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (isFailureDebugTask(task)) return false;
  return (
    /\b(read|open|show|find|where is|what file|explain)\b/.test(normalized) ||
    /\btypo|rename|format|comment\b/.test(normalized)
  );
}

function isVagueImprovementTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const vagueTerms = ["better", "improve", "improvement", "clean up", "cleanup", "stuff", "things", "quality"];
  const concreteTerms = [
    "debug",
    "failing",
    "failure",
    "regression",
    "test",
    "error",
    "stack",
    "file",
    "function",
    "class",
    "api",
    "ui",
    "mobile",
    "layout",
    "parser",
    "auth",
    "database",
    "performance"
  ];
  return vagueTerms.some((term) => normalized.includes(term)) && !concreteTerms.some((term) => normalized.includes(term));
}
