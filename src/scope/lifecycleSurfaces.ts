const SOURCE_EXT = "(py|ts|tsx|js|jsx|mjs|cjs|go|rb|rs|cs|java|kt|c|cc|cpp|cxx|h|hh|hpp|hxx)";

export function isUnrelatedDeprecationLifecyclePath(filePath: string, task: string, sourceText = ""): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedTask = normalizeText(task);
  const normalizedSource = normalizeText(sourceText);
  if (!isDeprecationLifecycleTask(normalizedTask)) return false;
  if (taskMentionsPathOrBasename(normalizedTask, normalizedPath)) return false;
  if (isGenericDateUrlHelperPath(normalizedPath) && !taskRequestsDateUrlHelper(normalizedTask)) return true;
  if (isFactsHelperPath(normalizedPath) && !/\bfacts?\b/.test(normalizedTask)) return true;
  if (isLeafModulePath(normalizedPath) && !isLifecyclePolicySurface(normalizedPath, normalizedSource)) return true;
  return false;
}

export function scoreDeprecationLifecyclePath(input: {
  filePath: string;
  query: string;
  sourceText?: string | undefined;
}): number {
  const normalizedPath = normalizePath(input.filePath);
  const normalizedQuery = normalizeText(input.query);
  const normalizedSource = normalizeText(`${input.filePath} ${input.sourceText ?? ""}`);
  if (!isDeprecationLifecycleTask(normalizedQuery)) return 0;

  let score = 0;
  if (isParameterValidationPath(normalizedPath)) score += 600;
  if (isModuleRuntimePolicyPath(normalizedPath, normalizedSource)) score += 560;
  if (isWarningPolicyPath(normalizedPath)) score += 520;
  if (isDisplayPolicyPath(normalizedPath)) score += displayRequired(normalizedQuery) ? 540 : 420;
  if (isRuntimeMirrorPath(normalizedPath, normalizedSource)) score += 500;

  if (/(^|\/)(common|core|shared|policy|policies|schema|schemas|validation|validators?|runtime|module_utils?)\//.test(normalizedPath)) {
    score += 90;
  }
  if (/\b(deprecat\w*|deprecated_aliases|removed_in_version|removed_at_date|removed at date|removed in version|warning|warnings?|display|validate|validation|parameter|parameters?|aliases?)\b/.test(normalizedSource)) {
    score += 120;
  }
  if (isGenericDateUrlHelperPath(normalizedPath) && !taskRequestsDateUrlHelper(normalizedQuery)) score -= 1000;
  if (isFactsHelperPath(normalizedPath) && !/\bfacts?\b/.test(normalizedQuery)) score -= 1000;
  if (isLeafModulePath(normalizedPath) && !isLifecyclePolicySurface(normalizedPath, normalizedSource)) score -= 1000;
  return score;
}

function isDeprecationLifecycleTask(task: string): boolean {
  return /\b(deprecat\w*|deprecated aliases?|removed at date|removed in version|removed_at_date|removed_in_version)\b/.test(task) &&
    /\b(date|version|module|modules|parameter|parameters|alias|aliases|warning|warnings|display|validate|validation)\b/.test(task);
}

function isParameterValidationPath(path: string): boolean {
  return new RegExp(`(^|/)(common/)?(parameters?|params|arguments?|argument_spec|argspec|validation|validators?|schema|schemas)\\.${SOURCE_EXT}$`).test(path);
}

function isModuleRuntimePolicyPath(path: string, sourceText: string): boolean {
  return (
    new RegExp(`(^|/)(module|module_utils|modules?|runtime|core|shared)[^/]*(/|$).*?basic\\.${SOURCE_EXT}$`).test(path) ||
    (new RegExp(`(^|/)basic\\.${SOURCE_EXT}$`).test(path) && /\b(argument spec|argumentspec|deprecated|deprecation|deprecated_aliases|removed_in_version|removed_at_date)\b/.test(sourceText))
  );
}

function isWarningPolicyPath(path: string): boolean {
  return new RegExp(`(^|/)(common/)?(warnings?|deprecations?|notices?)\\.${SOURCE_EXT}$`).test(path);
}

function isDisplayPolicyPath(path: string): boolean {
  return new RegExp(`(^|/)(utils?/)?(display|output|messages?)\\.${SOURCE_EXT}$`).test(path);
}

function isRuntimeMirrorPath(path: string, sourceText: string): boolean {
  return new RegExp(`(^|/)[a-z0-9_.-]*basic\\.(cs|ts|js)$`).test(path) &&
    /\b(validateargumentspec|deprecated_aliases|removed_in_version|removed_at_date|deprecation)\b/.test(sourceText);
}

function isLifecyclePolicySurface(path: string, sourceText: string): boolean {
  return isParameterValidationPath(path) ||
    isModuleRuntimePolicyPath(path, sourceText) ||
    isWarningPolicyPath(path) ||
    isDisplayPolicyPath(path) ||
    isRuntimeMirrorPath(path, sourceText) ||
    /\b(deprecat\w*|deprecated_aliases|removed_in_version|removed_at_date|warning|warnings?|validate|validation)\b/.test(sourceText);
}

function isGenericDateUrlHelperPath(path: string): boolean {
  return new RegExp(`(^|/)(date_time|datetime|urls?|urlutils)\\.${SOURCE_EXT}$`).test(path);
}

function taskRequestsDateUrlHelper(task: string): boolean {
  return /\b(date parser|parse date|date helper|datetime helper|url helper|parse url|url|urls|uri|http|request|fetch)\b/.test(task);
}

function isFactsHelperPath(path: string): boolean {
  return /(^|\/)facts?\//.test(path) || new RegExp(`(^|/)(facts?|fact_utils?|factutils)\\.${SOURCE_EXT}$`).test(path);
}

function isLeafModulePath(path: string): boolean {
  return new RegExp(`(^|/)modules?/[^/]+\\.${SOURCE_EXT}$`).test(path);
}

function displayRequired(task: string): boolean {
  return /\b(display|warning systems?|warnings?|output\['deprecations'\]|deprecations?\s+(?:list|output|entry|entries|message|messages))\b/.test(task);
}

function taskMentionsPathOrBasename(task: string, filePath: string): boolean {
  if (task.includes(filePath)) return true;
  const basename = filePath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "";
  if (isGenericBasename(basename)) return false;
  return basename.length >= 3 && new RegExp(`\\b${escapeRegex(basename)}\\b`).test(task);
}

function isGenericBasename(value: string): boolean {
  return /^(common|helper|helpers|index|main|util|utils|_utils)$/.test(value);
}

function normalizePath(value: string): string {
  return value.toLowerCase().replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
