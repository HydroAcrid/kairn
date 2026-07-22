// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type {
  ExperimentAttemptPlan,
  ExperimentCondition,
  ExperimentLanguage,
  ExperimentPlan,
  ExperimentProfile,
  ExperimentTask,
  ExperimentTaskClass
} from "../types.js";

export const EXPERIMENT_CONDITIONS: ExperimentCondition[] = [
  "vanilla",
  "reasonblocks",
  "kairn",
  "kairn_reasonblocks"
];

const LANGUAGES = new Set<ExperimentLanguage>(["python", "typescript", "go", "java", "cpp"]);
const TASK_CLASSES = new Set<ExperimentTaskClass>(["source_localization", "failure_first", "long_session"]);

export function loadExperimentPlan(planPath: string): ExperimentPlan {
  const resolved = path.resolve(planPath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  const plan = parseExperimentPlan(raw, path.dirname(resolved));
  const errors = validateExperimentPlan(plan);
  if (errors.length > 0) throw new Error(`Invalid experiment plan:\n- ${errors.join("\n- ")}`);
  return plan;
}

export function validateExperimentPlan(plan: ExperimentPlan): string[] {
  const errors: string[] = [];
  if (plan.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!plan.id.trim()) errors.push("id is required");
  if (!plan.name.trim()) errors.push("name is required");
  if (plan.profile && !new Set<ExperimentProfile>(["smoke", "pilot", "publication"]).has(plan.profile)) {
    errors.push(`unsupported experiment profile '${String(plan.profile)}'`);
  }
  if (plan.tasks.length === 0) errors.push("at least one task is required");
  const conditions = plan.conditions ?? EXPERIMENT_CONDITIONS;
  if (conditions.length !== EXPERIMENT_CONDITIONS.length || EXPERIMENT_CONDITIONS.some((item) => !conditions.includes(item))) {
    errors.push(`conditions must contain exactly: ${EXPERIMENT_CONDITIONS.join(", ")}`);
  }
  if (new Set(conditions).size !== conditions.length) errors.push("conditions contain duplicates");
  if (!Number.isInteger(plan.repeats ?? 3) || (plan.repeats ?? 3) < 1) errors.push("repeats must be a positive integer");
  if (!Number.isInteger(plan.maxSteps ?? 40) || (plan.maxSteps ?? 40) < 1) errors.push("maxSteps must be a positive integer");
  if (!Number.isInteger(plan.maxTokensPerResponse ?? 4096) || (plan.maxTokensPerResponse ?? 4096) < 1) {
    errors.push("maxTokensPerResponse must be a positive integer");
  }
  if (!Number.isInteger(plan.timeoutMs ?? 1_800_000) || (plan.timeoutMs ?? 1_800_000) < 1) errors.push("timeoutMs must be a positive integer");
  if ((plan.temperature ?? 0) < 0 || (plan.temperature ?? 0) > 1) errors.push("temperature must be between 0 and 1");

  const ids = new Set<string>();
  const sanitizedIds = new Map<string, string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate task id '${task.id}'`);
    ids.add(task.id);
    const sanitized = sanitizeId(task.id);
    const colliding = sanitizedIds.get(sanitized);
    if (colliding && colliding !== task.id) errors.push(`task ids '${colliding}' and '${task.id}' collapse to the same attempt id`);
    sanitizedIds.set(sanitized, task.id);
    if (!task.id.trim()) errors.push("task id is required");
    if (!task.publicRepo) errors.push(`${task.id}: publicRepo must be true for the ReasonBlocks comparison`);
    const repositoryUrlPolicyViolation = publicRepositoryUrlPolicyViolation(task.repoUrl);
    if (repositoryUrlPolicyViolation) {
      errors.push(`${task.id}: repoUrl ${repositoryUrlPolicyViolation}`);
    } else if (!isExplicitPublicRepositoryUrl(task.repoUrl)) {
      errors.push(`${task.id}: repoUrl must identify an explicit public HTTPS/GitHub repository`);
    }
    if (!task.ref.trim() || /^(HEAD|main|master|latest)$/i.test(task.ref.trim())) {
      errors.push(`${task.id}: ref must be a pinned immutable commit or tag, not '${task.ref}'`);
    }
    if (!LANGUAGES.has(task.language)) errors.push(`${task.id}: unsupported language '${String(task.language)}'`);
    if (!TASK_CLASSES.has(task.taskClass)) errors.push(`${task.id}: unsupported taskClass '${String(task.taskClass)}'`);
    if (!task.prompt.trim()) errors.push(`${task.id}: prompt is required`);
    if (!task.verificationCommand.trim()) errors.push(`${task.id}: verificationCommand is required`);
    if (!/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/i.test(task.sandboxImage ?? "")) {
      errors.push(`${task.id}: sandboxImage must be a container image pinned by sha256 digest`);
    }
    if (task.requiredSourceFiles.length === 0) errors.push(`${task.id}: requiredSourceFiles must not be empty`);
    for (const [field, values] of [
      ["requiredSourceFiles", task.requiredSourceFiles],
      ["allowedSupportFiles", task.allowedSupportFiles ?? []],
      ["requiredTouchedFiles", task.requiredTouchedFiles ?? []]
    ] as const) {
      if (new Set(values.map(normalizePlanPath)).size !== values.length) errors.push(`${task.id}: ${field} contains duplicates`);
    }
    if (task.taskClass === "failure_first" && !task.initialFailureCommand?.trim()) {
      errors.push(`${task.id}: failure_first tasks require initialFailureCommand`);
    }
    if (task.taskClass === "long_session" && (task.turns?.length ?? 0) < 2) {
      errors.push(`${task.id}: long_session tasks require at least two turns`);
    }
    const turnIds = task.turns?.map((turn) => turn.id) ?? [];
    if (new Set(turnIds).size !== turnIds.length) errors.push(`${task.id}: turn ids must be unique`);
    for (const file of [
      ...task.requiredSourceFiles,
      ...(task.allowedSupportFiles ?? []),
      ...(task.requiredTouchedFiles ?? [])
    ]) {
      if (!isSafeRelativePath(file)) errors.push(`${task.id}: unsafe repository path '${file}'`);
    }
    for (const pattern of task.explicitNoisePatterns ?? []) {
      if (!isSafeRelativePattern(pattern)) errors.push(`${task.id}: unsafe noise pattern '${pattern}'`);
    }
    for (const invariant of task.sourceInvariants ?? []) {
      if (!isSafeRelativePath(invariant.file)) errors.push(`${task.id}: unsafe invariant path '${invariant.file}'`);
    }
    for (const scope of task.allowedDiffScopes ?? []) {
      if (!isSafeRelativePath(scope.file)) errors.push(`${task.id}: unsafe diff-scope path '${scope.file}'`);
    }
    const scopes = new Set((task.allowedDiffScopes ?? []).map((scope) => normalizePlanPath(scope.file)));
    for (const required of task.requiredTouchedFiles ?? []) {
      if (task.allowedDiffScopes && !scopes.has(normalizePlanPath(required))) {
        errors.push(`${task.id}: required touched file '${required}' is missing from allowedDiffScopes`);
      }
    }
  }
  if (plan.profile === "smoke") validateSmokeProfile(plan, errors);
  if (plan.profile === "pilot") validatePilotProfile(plan, errors);
  if (plan.profile === "publication") validatePublicationProfile(plan, errors);
  return errors;
}

export function buildExperimentSchedule(input: {
  plan: ExperimentPlan;
  seed: number;
  repeats?: number | undefined;
}): ExperimentAttemptPlan[] {
  const repeats = input.repeats ?? input.plan.repeats ?? 3;
  const rows: ExperimentCondition[][] = [
    ["vanilla", "reasonblocks", "kairn", "kairn_reasonblocks"],
    ["reasonblocks", "kairn_reasonblocks", "vanilla", "kairn"],
    ["kairn", "vanilla", "kairn_reasonblocks", "reasonblocks"],
    ["kairn_reasonblocks", "kairn", "reasonblocks", "vanilla"]
  ];
  const attempts: ExperimentAttemptPlan[] = [];
  for (const [taskIndex, task] of input.plan.tasks.entries()) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const row = rows[positiveMod(input.seed + taskIndex + repeat, rows.length)] ?? rows[0]!;
      const blockId = `${task.id}:r${repeat + 1}`;
      row.forEach((condition, order) => {
        attempts.push({
          id: `${sanitizeId(task.id)}__r${repeat + 1}__${condition}`,
          campaignId: input.plan.id,
          taskId: task.id,
          condition,
          repeat: repeat + 1,
          order: order + 1,
          blockId
        });
      });
    }
  }
  return attempts;
}

function parseExperimentPlan(value: unknown, planDir: string): ExperimentPlan {
  const record = asRecord(value, "experiment plan");
  requireExactKeys(record, [
    "schemaVersion", "id", "name", "description", "profile", "conditions", "model", "temperature",
    "maxSteps", "maxTokensPerResponse", "timeoutMs", "repeats", "pythonCommand", "kairnCommand", "tasks"
  ], "experiment plan");
  const tasks = arrayValue(record.tasks, "tasks").map((item, index) => parseExperimentTask(item, planDir, index));
  const conditions = record.conditions === undefined
    ? undefined
    : arrayValue(record.conditions, "conditions").map((item) => stringValue(item, "condition") as ExperimentCondition);
  return {
    schemaVersion: numberValue(record.schemaVersion, "schemaVersion") as 1,
    id: stringValue(record.id, "id"),
    name: stringValue(record.name, "name"),
    ...(optionalString(record.description) ? { description: optionalString(record.description) } : {}),
    ...(optionalString(record.profile) ? { profile: optionalString(record.profile) as ExperimentProfile } : {}),
    ...(conditions ? { conditions } : {}),
    ...(optionalString(record.model) ? { model: optionalString(record.model) } : {}),
    ...(optionalNumber(record.temperature) !== undefined ? { temperature: optionalNumber(record.temperature) } : {}),
    ...(optionalNumber(record.maxSteps) !== undefined ? { maxSteps: optionalNumber(record.maxSteps) } : {}),
    ...(optionalNumber(record.maxTokensPerResponse) !== undefined ? { maxTokensPerResponse: optionalNumber(record.maxTokensPerResponse) } : {}),
    ...(optionalNumber(record.timeoutMs) !== undefined ? { timeoutMs: optionalNumber(record.timeoutMs) } : {}),
    ...(optionalNumber(record.repeats) !== undefined ? { repeats: optionalNumber(record.repeats) } : {}),
    ...(optionalString(record.pythonCommand) ? { pythonCommand: optionalString(record.pythonCommand) } : {}),
    ...(optionalString(record.kairnCommand) ? { kairnCommand: optionalString(record.kairnCommand) } : {}),
    tasks
  };
}

export function parseExperimentTask(value: unknown, planDir: string, index: number): ExperimentTask {
  const record = asRecord(value, `tasks[${index}]`);
  requireExactKeys(record, [
    "id", "repoUrl", "ref", "publicRepo", "language", "taskClass", "prompt", "turns",
    "requiredSourceFiles", "allowedSupportFiles", "explicitNoisePatterns", "requiredTouchedFiles",
    "sourceInvariants", "allowedDiffScopes", "assistanceExpectation", "setupCommands", "setupPatch",
    "setupPatchFile", "sandboxImage", "initialFailureCommand", "verificationCommand"
  ], `tasks[${index}]`);
  if (record.publicRepo !== true) throw new Error(`tasks[${index}].publicRepo must be true`);
  const turns = record.turns === undefined
    ? undefined
    : arrayValue(record.turns, `tasks[${index}].turns`).map((item, turnIndex) => {
        const turn = asRecord(item, `tasks[${index}].turns[${turnIndex}]`);
        requireExactKeys(turn, ["id", "prompt", "assistanceExpectation"], `tasks[${index}].turns[${turnIndex}]`);
        const expectation = optionalString(turn.assistanceExpectation);
        if (expectation && !isAssistanceExpectation(expectation)) {
          throw new Error(`tasks[${index}].turns[${turnIndex}].assistanceExpectation is invalid`);
        }
        return {
          id: stringValue(turn.id, `tasks[${index}].turns[${turnIndex}].id`),
          prompt: stringValue(turn.prompt, `tasks[${index}].turns[${turnIndex}].prompt`),
          ...(expectation ? { assistanceExpectation: expectation as ExperimentTask["assistanceExpectation"] } : {})
        };
      });
  const setupPatchFile = optionalString(record.setupPatchFile);
  const sandboxImage = optionalString(record.sandboxImage);
  const resolvedSetupPatchFile = setupPatchFile ? path.resolve(planDir, setupPatchFile) : undefined;
  if (resolvedSetupPatchFile && !isWithinDirectory(planDir, resolvedSetupPatchFile)) {
    throw new Error(`tasks[${index}].setupPatchFile must stay inside the plan directory`);
  }
  const assistanceExpectation = optionalString(record.assistanceExpectation);
  if (assistanceExpectation && !isAssistanceExpectation(assistanceExpectation)) {
    throw new Error(`tasks[${index}].assistanceExpectation is invalid`);
  }
  return {
    id: stringValue(record.id, `tasks[${index}].id`),
    repoUrl: stringValue(record.repoUrl, `tasks[${index}].repoUrl`),
    ref: stringValue(record.ref, `tasks[${index}].ref`),
    publicRepo: true,
    language: stringValue(record.language, `tasks[${index}].language`) as ExperimentLanguage,
    taskClass: stringValue(record.taskClass, `tasks[${index}].taskClass`) as ExperimentTaskClass,
    prompt: stringValue(record.prompt, `tasks[${index}].prompt`),
    ...(turns ? { turns } : {}),
    requiredSourceFiles: stringArray(record.requiredSourceFiles, `tasks[${index}].requiredSourceFiles`),
    ...(record.allowedSupportFiles !== undefined ? { allowedSupportFiles: stringArray(record.allowedSupportFiles, `tasks[${index}].allowedSupportFiles`) } : {}),
    ...(record.explicitNoisePatterns !== undefined ? { explicitNoisePatterns: stringArray(record.explicitNoisePatterns, `tasks[${index}].explicitNoisePatterns`) } : {}),
    ...(record.requiredTouchedFiles !== undefined ? { requiredTouchedFiles: stringArray(record.requiredTouchedFiles, `tasks[${index}].requiredTouchedFiles`) } : {}),
    ...(record.sourceInvariants !== undefined
      ? { sourceInvariants: arrayValue(record.sourceInvariants, `tasks[${index}].sourceInvariants`).map((item, invariantIndex) => parseSourceInvariant(item, `tasks[${index}].sourceInvariants[${invariantIndex}]`)) }
      : {}),
    ...(record.allowedDiffScopes !== undefined
      ? { allowedDiffScopes: arrayValue(record.allowedDiffScopes, `tasks[${index}].allowedDiffScopes`).map((item, scopeIndex) => parseDiffScope(item, `tasks[${index}].allowedDiffScopes[${scopeIndex}]`)) }
      : {}),
    ...(assistanceExpectation ? { assistanceExpectation: assistanceExpectation as ExperimentTask["assistanceExpectation"] } : {}),
    ...(record.setupCommands !== undefined ? { setupCommands: stringArray(record.setupCommands, `tasks[${index}].setupCommands`) } : {}),
    ...(optionalString(record.setupPatch) ? { setupPatch: optionalString(record.setupPatch) } : {}),
    ...(resolvedSetupPatchFile ? { setupPatchFile: resolvedSetupPatchFile } : {}),
    ...(sandboxImage ? { sandboxImage } : {}),
    ...(optionalString(record.initialFailureCommand) ? { initialFailureCommand: optionalString(record.initialFailureCommand) } : {}),
    verificationCommand: stringValue(record.verificationCommand, `tasks[${index}].verificationCommand`)
  };
}

function parseSourceInvariant(value: unknown, label: string): NonNullable<ExperimentTask["sourceInvariants"]>[number] {
  const record = asRecord(value, label);
  requireExactKeys(record, [
    "id", "file", "description", "requiredPresent", "requiredAbsent", "requiredRegex", "requiredAny", "requiredAnyRegex"
  ], label);
  const id = optionalString(record.id);
  const description = optionalString(record.description);
  return {
    ...(id ? { id } : {}),
    file: stringValue(record.file, `${label}.file`),
    ...(description ? { description } : {}),
    ...(record.requiredPresent !== undefined ? { requiredPresent: stringArray(record.requiredPresent, `${label}.requiredPresent`) } : {}),
    ...(record.requiredAbsent !== undefined ? { requiredAbsent: stringArray(record.requiredAbsent, `${label}.requiredAbsent`) } : {}),
    ...(record.requiredRegex !== undefined ? { requiredRegex: stringArray(record.requiredRegex, `${label}.requiredRegex`) } : {}),
    ...(record.requiredAny !== undefined ? { requiredAny: stringArray(record.requiredAny, `${label}.requiredAny`) } : {}),
    ...(record.requiredAnyRegex !== undefined ? { requiredAnyRegex: stringArray(record.requiredAnyRegex, `${label}.requiredAnyRegex`) } : {})
  };
}

function parseDiffScope(value: unknown, label: string): NonNullable<ExperimentTask["allowedDiffScopes"]>[number] {
  const record = asRecord(value, label);
  requireExactKeys(record, ["file", "symbols", "allowWholeFile"], label);
  if (record.allowWholeFile !== undefined && typeof record.allowWholeFile !== "boolean") {
    throw new Error(`${label}.allowWholeFile must be boolean`);
  }
  return {
    file: stringValue(record.file, `${label}.file`),
    ...(record.symbols !== undefined ? { symbols: stringArray(record.symbols, `${label}.symbols`) } : {}),
    ...(typeof record.allowWholeFile === "boolean" ? { allowWholeFile: record.allowWholeFile } : {})
  };
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return Boolean(normalized) &&
    !path.posix.isAbsolute(normalized) &&
    !/^[a-z]:\//i.test(normalized) &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../");
}

function isSafeRelativePattern(value: string): boolean {
  // Runtime matchers intentionally implement only `*`/`**`. Reject richer
  // glob syntax instead of silently accepting a pattern the quality gate
  // would interpret differently.
  if (/[!?{}\[\]]/.test(value)) return false;
  const withoutGlobs = value.replace(/\*/g, "x");
  return isSafeRelativePath(withoutGlobs);
}

function normalizePlanPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isExplicitPublicRepositoryUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      parsed.search || parsed.hash
    ) return false;
    const host = parsed.hostname.toLowerCase();
    if (!new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"]).has(host)) return false;
    return /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function publicRepositoryUrlPolicyViolation(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const rawAuthority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
    // WHATWG URL parsing normalizes an explicit default port (for example
    // `:443`) away. Compare the original authority as well so publication
    // manifests cannot smuggle a port past the parsed `port` property.
    if (
      parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
      !rawAuthority || rawAuthority.toLowerCase() !== parsed.hostname.toLowerCase()
    ) {
      return "must not contain credentials, a port, query, or fragment";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAssistanceExpectation(value: string): value is NonNullable<ExperimentTask["assistanceExpectation"]> {
  return value === "required" || value === "optional" || value === "abstain";
}

function validatePublicationProfile(plan: ExperimentPlan, errors: string[]): void {
  if (plan.model !== "claude-sonnet-4-6") {
    errors.push("publication profile must use claude-sonnet-4-6");
  }
  if (plan.temperature !== 0) errors.push("publication profile must explicitly use temperature 0");
  if (plan.repeats !== 5) errors.push("publication profile must explicitly use exactly five repeats");
  if (!plan.conditions) errors.push("publication profile must explicitly pin all four conditions");
  if (plan.tasks.length !== 30) errors.push("publication profile must contain exactly 30 tasks");
  if (plan.maxSteps === undefined || plan.maxTokensPerResponse === undefined || plan.timeoutMs === undefined) {
    errors.push("publication profile must explicitly pin maxSteps, maxTokensPerResponse, and timeoutMs");
  }
  for (const language of LANGUAGES) {
    for (const taskClass of TASK_CLASSES) {
      const count = plan.tasks.filter((task) => task.language === language && task.taskClass === taskClass).length;
      if (count !== 2) errors.push(`publication profile needs exactly two ${language}/${taskClass} tasks (found ${count})`);
    }
  }
  for (const task of plan.tasks) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(task.ref)) {
      errors.push(`${task.id}: publication ref must be a full immutable commit hash`);
    }
    if ((task.requiredTouchedFiles?.length ?? 0) === 0) {
      errors.push(`${task.id}: publication tasks must preregister requiredTouchedFiles`);
    }
    if ((task.allowedDiffScopes?.length ?? 0) === 0) {
      errors.push(`${task.id}: publication tasks must preregister allowedDiffScopes`);
    }
    if ((task.sourceInvariants?.length ?? 0) === 0) {
      errors.push(`${task.id}: publication tasks must preregister sourceInvariants`);
    }
    if ((task.explicitNoisePatterns?.length ?? 0) === 0) {
      errors.push(`${task.id}: publication tasks must preregister at least one explicit noise pattern`);
    }
  }
}

function validateSmokeProfile(plan: ExperimentPlan, errors: string[]): void {
  if (plan.tasks.length !== 1 || plan.repeats !== 1) {
    errors.push("smoke profile must contain one task with one repeat (one four-arm block)");
  }
}

function validatePilotProfile(plan: ExperimentPlan, errors: string[]): void {
  if (plan.model !== "claude-sonnet-4-6") errors.push("pilot profile must explicitly use claude-sonnet-4-6");
  if (plan.temperature !== 0) errors.push("pilot profile must explicitly use temperature 0");
  if (plan.repeats !== 3) errors.push("pilot profile must use exactly three repeats");
  if (plan.tasks.length !== 15) errors.push("pilot profile must contain exactly 15 tasks (180 attempts)");
  if (plan.maxSteps === undefined || plan.maxTokensPerResponse === undefined || plan.timeoutMs === undefined) {
    errors.push("pilot profile must explicitly pin maxSteps, maxTokensPerResponse, and timeoutMs");
  }
  for (const language of LANGUAGES) {
    for (const taskClass of TASK_CLASSES) {
      const count = plan.tasks.filter((task) => task.language === language && task.taskClass === taskClass).length;
      if (count !== 1) errors.push(`pilot profile needs exactly one ${language}/${taskClass} task (found ${count})`);
    }
  }
  const repositories = plan.tasks.map((task) => task.repoUrl.replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase());
  if (new Set(repositories).size !== repositories.length) {
    errors.push("pilot profile must use one unique repository lineage per language/scenario cell");
  }
  for (const task of plan.tasks) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(task.ref)) {
      errors.push(`${task.id}: pilot ref must be a full immutable commit hash`);
    }
    if ((task.requiredTouchedFiles?.length ?? 0) === 0) {
      errors.push(`${task.id}: pilot tasks must preregister requiredTouchedFiles`);
    }
    if ((task.allowedDiffScopes?.length ?? 0) === 0) {
      errors.push(`${task.id}: pilot tasks must preregister allowedDiffScopes`);
    }
    if ((task.sourceInvariants?.length ?? 0) === 0) {
      errors.push(`${task.id}: pilot tasks must preregister sourceInvariants`);
    }
    if ((task.explicitNoisePatterns?.length ?? 0) === 0) {
      errors.push(`${task.id}: pilot tasks must preregister at least one explicit noise pattern`);
    }
    if (task.taskClass === "long_session" && task.turns?.length !== 3) {
      errors.push(`${task.id}: pilot long_session tasks must contain exactly three turns`);
    }
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function positiveMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !accepted.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item, index) => stringValue(item, `${label}[${index}]`));
}
