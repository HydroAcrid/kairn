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
  companionCount?: number | undefined;
  companionTopScore?: number | undefined;
  companionSpecific?: boolean | undefined;
}): ContextValueDecision {
  const primaryFile = input.context.suggestedNextContext[0] ?? input.context.files[0];
  const primaryRecord = input.knownFiles.find((file) => file.path === primaryFile);
  const language = inferLanguage(primaryFile);
  const debugSignal = input.profile === "failure_debug" || isFailureDebugTask(input.task);
  const structuredDebugSignal = isStructuredDebugTask(input.task);
  const sourceFixSignal = isSourceFixTask(input.task);
  const easyTaskSignal = isEasyTask(input.task);
  const vagueImprovementSignal = isVagueImprovementTask(input.task);
  const multiFileSignal = isMultiFileTask(input.task);
  const companionSignal = Boolean(input.companionCount && input.companionCount > 0 && (multiFileSignal || (input.companionTopScore ?? 0) >= 360));
  const companionSpecific = Boolean(input.companionSpecific);
  const wrongContextRisk = Boolean(
    primaryFile &&
      sourceFixSignal &&
      (isNoisyPath(primaryFile.toLowerCase()) || primaryRecord?.kind === "test" || !isPrimarySourcePath(primaryFile))
  );
  const reasons = new Set<string>(input.quality.reasons);
  const primaryReasons = primaryFile ? reasonsForPrimaryFile(input.context, primaryFile) : [];
  const sourceRescue = hasSourceRescueSignal(primaryReasons);
  const canonicalSourceHit = hasCanonicalSourceSignal(primaryReasons);

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
    if (sourceRescue) {
      reasons.add("source-rescue signal supports an active one-file guardrail");
    }
    if (canonicalSourceHit) {
      reasons.add("canonical source routing supports focused context");
    }
    if (!multiFileSignal) {
      score -= language === "python" ? 8 : 18;
      reasons.add("single-source fix should not receive broad context expansion");
    }
  }
  const structuredCompanionAllowed =
    debugSignal &&
    companionSignal &&
    Boolean(primaryFile && isPrimarySourcePath(primaryFile)) &&
    input.context.files.length > 1 &&
    (structuredDebugSignal || multiFileSignal || (companionSpecific && (input.companionTopScore ?? 0) >= 650) || input.context.files.length > 1);
  const effectiveCompanionSignal = companionSignal && (!exactSourceHit || structuredCompanionAllowed);
  if (effectiveCompanionSignal) {
    score += Math.min(18, Math.max(8, Math.floor((input.companionTopScore ?? 0) / 120)));
    reasons.add("query-local companion evidence supports multi-surface context");
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
  const cheapSingleSource = isCheapSingleSourceTask({
    task: input.task,
    debugSignal,
    sourceFixSignal,
    primaryFile,
    primaryKind: primaryRecord?.kind,
    topScore: input.quality.topScore,
    topGap: input.quality.topGap,
    companionSignal: effectiveCompanionSignal,
    companionSpecific,
    multiFileSignal,
    contextFileCount: input.context.files.length
  });
  if (cheapSingleSource) {
    score -= 18;
    reasons.add("cheap single-source task should use a minimal guardrail");
  }
  const cheapExactSource = isCheapExactSourceTask({
    task: input.task,
    language,
    exactSourceHit,
    debugSignal,
    multiFileSignal,
    companionSignal: effectiveCompanionSignal,
    companionTopScore: input.companionTopScore ?? 0,
    topScore: input.quality.topScore,
    topGap: input.quality.topGap,
    sourceRescue
  });
  if (cheapExactSource) {
    score -= 12;
    reasons.add("cheap exact-source task should use an ultra-minimal automatic guardrail");
  }

  score = Math.round(Math.max(0, Math.min(100, score)));
  let action = chooseAction({
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
    cheapSingleSource,
    structuredDebugSignal,
    multiFileSignal,
    companionSignal: effectiveCompanionSignal,
    companionTopScore: input.companionTopScore
  });
  const structuredMultiFileDirectiveSignal =
    debugSignal &&
    structuredDebugSignal &&
    Boolean(primaryFile && isPrimarySourcePath(primaryFile)) &&
    !wrongContextRisk &&
    effectiveCompanionSignal &&
    (multiFileSignal || (input.companionTopScore ?? 0) >= 520 || input.context.files.length > 1);
  const focusedDebugCompanionSignal =
    debugSignal &&
    Boolean(primaryFile && isPrimarySourcePath(primaryFile)) &&
    !wrongContextRisk &&
    effectiveCompanionSignal &&
    (multiFileSignal || companionSpecific || (input.companionTopScore ?? 0) < 1_100);
  if (action === "emit" && (structuredMultiFileDirectiveSignal || focusedDebugCompanionSignal)) {
    action = "shrink";
    reasons.add("debug companion context should stay directive instead of full-prime");
  }
  const expectedSavingsRisk = action === "emit" ? "low" : action === "shrink" ? "medium" : "high";
  const multiFileDirective =
    action === "shrink" &&
    debugSignal &&
    !cheapSingleSource &&
    Boolean(primaryFile && isPrimarySourcePath(primaryFile)) &&
    !wrongContextRisk &&
    effectiveCompanionSignal &&
    (structuredDebugSignal || multiFileSignal || (input.companionTopScore ?? 0) >= 520);
  const recommendedDelivery = action === "emit"
    ? "full_prime"
    : action === "shrink"
      ? multiFileDirective ? "multi_file_directive" : "one_file_directive"
    : "none";

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
    sourceRescue,
    canonicalSourceHit,
    cheapSingleSource,
    cheapExactSource,
    companionSpecific,
    multiSurfaceSignal: multiFileSignal || effectiveCompanionSignal,
    companionCount: input.companionCount ?? 0,
    companionTopScore: input.companionTopScore ?? 0,
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
  cheapSingleSource: boolean;
  structuredDebugSignal: boolean;
  multiFileSignal: boolean;
  companionSignal: boolean;
  companionTopScore?: number | undefined;
}): ContextValueDecision["action"] {
  if (input.exactPathMentioned) {
    return input.debugSignal && input.primarySource && (input.multiFileSignal || input.structuredDebugSignal) ? "shrink" : "suppress";
  }
  if (input.cheapSingleSource) return "shrink";
  if (input.wrongContextRisk && input.companionSignal && (input.companionTopScore ?? 0) >= 420) return "shrink";
  if (input.wrongContextRisk && input.score < 72) return "suppress";
  if (input.wrongContextRisk) return "shrink";
  if (input.companionSignal && input.primarySource && input.topScore >= 80) {
    return input.score >= 74 && (input.companionTopScore ?? 0) >= 520 ? "emit" : "shrink";
  }
  if (input.exactSourceHit && !input.multiFileSignal) return "shrink";
  if (input.vagueImprovementSignal && !input.debugSignal) return input.score >= 88 && input.topGap >= 80 ? "shrink" : "suppress";
  if (input.topScore <= 0) {
    return input.debugSignal && input.primarySource && (input.companionSignal || input.score >= 45) ? "shrink" : "suppress";
  }
  if (input.score < 38) return "suppress";
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
  if (/\.go$/.test(normalized)) return "go";
  if (/\.rb$/.test(normalized)) return "ruby";
  return "unknown";
}

function isPrimarySourcePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (isNoisyPath(normalized)) return false;
  return (
    normalized.startsWith("src/") ||
    normalized.startsWith("lib/") ||
    normalized.startsWith("app/") ||
    normalized.startsWith("packages/") ||
    normalized.startsWith("include/") ||
    (/\.pyi?$/.test(normalized) && !/(^|\/)(tests?|docs?|examples)\//.test(normalized)) ||
    (/\.go$/.test(normalized) && !/(^|\/)(vendor|testdata|tests?|examples|docs?)\//.test(normalized)) ||
    (/\.rb$/.test(normalized) && /(^|\/)(app|lib)\//.test(normalized)) ||
    normalized.includes("/src/") ||
    normalized.includes("/lib/") ||
    normalized.includes("/app/") ||
    normalized.includes("/include/") ||
    normalized.includes("/src/main/java/")
  );
}

function isProductionSourcePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (isNoisyPath(normalized)) return false;
  if (/(^|\/)(tests?|testing|__tests__|spec|specs|fixtures?|examples?|docs?)\//.test(normalized)) return false;
  return /\.(?:[cm]?[jt]sx?|pyi?|go|java|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)$/.test(normalized);
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
      /(^|;|\b)(symbol match|behavior symbol match|exact symbol match|precise filename match|precise symbol rescue|utility\/helper source rescue|canonical source route|monolithic public API source|changed source target|changed exact-symbol source target)\b/.test(reason)
    )
  ) {
    return true;
  }
  const basenameTerms = new Set(identifierTerms(filePath.split("/").at(-1) ?? filePath));
  const taskTerms = new Set(identifierTerms(task).filter((term) => !EXACT_SOURCE_TASK_STOP_TERMS.has(term)));
  const hits = [...basenameTerms].filter((term) => taskTerms.has(term) || (term === "url" && taskTerms.has("urls")));
  return hits.length >= 2;
}

function hasSourceRescueSignal(reasons: string[]): boolean {
  return reasons.some((reason) =>
    /\b(precise source path match|precise filename match|precise symbol rescue|utility\/helper source rescue|monolithic public API source|changed source target|changed exact-symbol source target)\b/i.test(reason)
  );
}

function hasCanonicalSourceSignal(reasons: string[]): boolean {
  return reasons.some((reason) => /\b(canonical source route|canonical module source|primary source path|monolithic public API source)\b/i.test(reason));
}

function isCheapSingleSourceTask(input: {
  task: string;
  debugSignal: boolean;
  sourceFixSignal: boolean;
  primaryFile?: string | undefined;
  primaryKind?: FileRecord["kind"] | undefined;
  topScore: number;
  topGap: number;
  companionSignal: boolean;
  companionSpecific: boolean;
  multiFileSignal: boolean;
  contextFileCount: number;
}): boolean {
  if (!input.primaryFile) return false;
  if (!input.debugSignal || !input.sourceFixSignal) return false;
  if (input.primaryKind === "test" || !isProductionSourcePath(input.primaryFile)) return false;
  if (hasStrongMultiSurfaceLanguage(input.task)) return false;
  if (input.topScore < 420 || input.topGap < 220) return false;
  if (input.companionSpecific) return false;
  if (input.multiFileSignal && input.contextFileCount > 1 && input.topGap < 420) return false;
  return !input.companionSignal || input.topGap >= 420 || input.contextFileCount <= 1;
}

function isCheapExactSourceTask(input: {
  task: string;
  language: ContextValueDecision["language"];
  exactSourceHit: boolean;
  debugSignal: boolean;
  multiFileSignal: boolean;
  companionSignal: boolean;
  companionTopScore: number;
  topScore: number;
  topGap: number;
  sourceRescue: boolean;
}): boolean {
  if (!input.exactSourceHit || !input.debugSignal) return false;
  if (input.sourceRescue && input.topScore < 1_700 && input.topGap < 1_000) return false;
  if (input.multiFileSignal || input.companionSignal) return false;
  if (!isDynamicSingleSourceLanguage(input.language)) return false;
  if (input.topScore < 900 || input.topGap < 600) return false;
  if (input.companionTopScore >= 620) return false;
  if (hasStrongMultiSurfaceLanguage(input.task)) return false;
  return hasDirectInvariantLanguage(input.task);
}

function isDynamicSingleSourceLanguage(language: ContextValueDecision["language"]): boolean {
  return language === "python" || language === "javascript" || language === "typescript" || language === "ruby";
}

function hasDirectInvariantLanguage(task: string): boolean {
  const normalized = task.toLowerCase();
  return /\b(no longer|expected behavior|actual behavior|should|must|restore|preserve|regression|now returns|now fails|fails to|does not|doesn't)\b/.test(normalized);
}

function hasStrongMultiSurfaceLanguage(task: string): boolean {
  const normalized = task.toLowerCase();
  return (
    /\b(end-to-end|e2e|integration|workflow|flow|pipeline|frontend and backend|api and ui|full stack|system)\b/.test(normalized) ||
    /\b(coordinate|coordinates|coordinated|interact|interacts|interaction)\b.*\bacross\b/.test(normalized) ||
    /\bacross\s+(files?|modules?|components?|surfaces?|packages?|services?|layers?)\b/.test(normalized) ||
    /\bmultiple\s+(files?|modules?|components?|surfaces?|packages?|services?|layers?)\b/.test(normalized) ||
    /\b(move|moved|relocat(?:e|ed|ion)|split|centraliz(?:e|ed)|shared|public api|new public interfaces?)\b/.test(normalized) ||
    /\b(router|routing|route handler|route matching)\b.*\b(dependency|dependencies|converter|convertor|controller|handler)\b/.test(normalized) ||
    /\b(controller|repository|model|scheduler|renderer|interceptor|dispatch|adapter|validation|callback)\b.*\b(controller|repository|model|scheduler|renderer|interceptor|dispatch|adapter|validation|callback)\b/.test(normalized)
  );
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

function isStructuredDebugTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return task.length > 500 ||
    normalized.includes("selected tests") ||
    normalized.includes("requirements:") ||
    normalized.includes("actual behavior") ||
    normalized.includes("expected behavior") ||
    normalized.includes("stack trace") ||
    normalized.includes("internal server error") ||
    normalized.includes("swe-bench");
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
  return /\b(end-to-end|e2e|integration|workflow|flow|pipeline|refactor|feature|migration|api and ui|frontend and backend|full stack|system|ui|mobile|layout|responsive|drawer|sheet|tabs|dashboard|screen|component|filter|filters|card|cards|routing|dependency|dependencies|route handler|route matching|mcp|tool|tools|runtime|follow-up|next context|proxy|response controller|interceptor|interceptors|guard|guards|pipe|pipes|case sensitivity|extension matching|move|moved|relocate|relocated|relocation|centralize|centralized|shared)\b/.test(normalized) ||
    /\b(coordinate|coordinates|coordinated|interact|interacts|interaction)\b.*\bacross\b/.test(normalized) ||
    /\bacross\s+(files?|modules?|components?|surfaces?|packages?|services?|layers?)\b/.test(normalized) ||
    /\bmultiple\s+(files?|modules?|components?|surfaces?|packages?|services?|layers?)\b/.test(normalized);
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
