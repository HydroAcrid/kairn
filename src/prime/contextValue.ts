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
  const multiFileSignal = isMultiFileTask(input.task);
  const wrongContextRisk = Boolean(
    primaryFile &&
      sourceFixSignal &&
      (isNoisyPath(primaryFile.toLowerCase()) || primaryRecord?.kind === "test" || !isPrimarySourcePath(primaryFile))
  );
  const reasons = new Set<string>(input.quality.reasons);
  const primaryReasons = primaryFile ? reasonsForPrimaryFile(input.context, primaryFile) : [];

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
  const exactSourceHit = isExactSourceHit({
    task: input.task,
    primaryFile,
    topScore: input.quality.topScore,
    topGap: input.quality.topGap,
    primaryKind: primaryRecord?.kind,
    sourceFixSignal,
    primaryReasons
  });
  if (exactSourceHit) {
    reasons.add("exact source hit should use focused context");
    if (!multiFileSignal) {
      score -= language === "python" ? 8 : 18;
      reasons.add("single-source fix should not receive broad context expansion");
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
    primarySource: Boolean(primaryFile && isPrimarySourcePath(primaryFile)),
    exactSourceHit,
    multiFileSignal
  });
  const expectedSavingsRisk = action === "emit" ? "low" : action === "shrink" ? "medium" : "high";
  const recommendedDelivery = action === "emit" ? "full_prime" : action === "shrink" ? "one_file_directive" : "none";

  return {
    score,
    action,
    reasons: [...reasons],
    topScore: input.quality.topScore,
    topGap: input.quality.topGap,
    ...(primaryFile ? { primaryFile } : {}),
    language,
    exactPathMentioned: input.quality.exactPathMentioned,
    exactSourceHit,
    recommendedDelivery,
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
  exactSourceHit: boolean;
  multiFileSignal: boolean;
}): ContextValueDecision["action"] {
  if (input.exactPathMentioned) return "suppress";
  if (input.wrongContextRisk && input.score < 72) return "suppress";
  if (input.wrongContextRisk) return "shrink";
  if (input.exactSourceHit && !input.multiFileSignal) return "shrink";
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

export function isExactSourceHit(input: {
  task: string;
  primaryFile?: string | undefined;
  topScore: number;
  topGap: number;
  primaryKind?: FileRecord["kind"] | undefined;
  sourceFixSignal?: boolean | undefined;
  primaryReasons?: string[] | undefined;
}): boolean {
  if (!input.primaryFile) return false;
  const normalized = input.primaryFile.toLowerCase();
  const sourceFixSignal = input.sourceFixSignal ?? isSourceFixTask(input.task);
  return (
    sourceFixSignal &&
    !isMultiFileTask(input.task) &&
    input.primaryKind !== "test" &&
    isPrimarySourcePath(input.primaryFile) &&
    !isNoisyPath(normalized) &&
    hasConcreteExactSourceSignal(input.primaryReasons ?? [], input.primaryFile, input.task) &&
    input.topScore >= 160 &&
    input.topGap >= 20
  );
}

function hasConcreteExactSourceSignal(reasons: string[], filePath: string, task: string): boolean {
  if (
    reasons.some((reason) =>
      /(^|;|\b)(symbol match|behavior symbol match|exact symbol match|precise filename match|precise symbol rescue|utility\/helper source rescue)\b/.test(reason)
    )
  ) {
    return true;
  }
  const basenameTerms = new Set(identifierTerms(filePath.split("/").at(-1) ?? filePath));
  const taskTerms = new Set(identifierTerms(task).filter((term) => !EXACT_SOURCE_TASK_STOP_TERMS.has(term)));
  const hits = [...basenameTerms].filter((term) => taskTerms.has(term) || (term === "url" && taskTerms.has("urls")));
  return hits.length >= 2;
}

function reasonsForPrimaryFile(context: ContextResponse, filePath: string): string[] {
  const line = context.content
    .split(/\r?\n/)
    .find((entry) => entry.includes(filePath) && entry.includes("):"));
  if (!line) return [];
  const reasonText = line.split("):").slice(1).join("):");
  return reasonText
    .split(";")
    .map((reason) => reason.trim())
    .filter(Boolean);
}

const EXACT_SOURCE_TASK_STOP_TERMS = new Set([
  "debug",
  "seeded",
  "regression",
  "fix",
  "production",
  "source",
  "file",
  "files",
  "edit",
  "unrelated",
  "should",
  "treated"
]);

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

function isMultiFileTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(across|multiple|end-to-end|e2e|integration|workflow|flow|refactor|feature|migration|api and ui|frontend and backend|full stack|system|ui|mobile|layout|responsive|drawer|sheet|tabs|dashboard|screen|component|filter|filters|card|cards)\b/.test(normalized);
}

function identifierTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length >= 2)
    )
  ];
}
