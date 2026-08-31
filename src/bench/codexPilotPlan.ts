// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type {
  CodexPilotAttemptPlan,
  CodexPilotCondition,
  CodexPilotKairnPin,
  CodexPilotPlan,
  CodexPilotProfile,
  CodexPilotStage,
  ExperimentLanguage,
  ExperimentPlan,
  ExperimentTaskClass
} from "../types.js";
import { parseExperimentTask, validateExperimentPlan } from "./experimentPlan.js";
import { BUNDLED_SEMANTIC_RC_EVIDENCE_ARTIFACT } from "../retrieval/evidenceModel.js";
import { DEFAULT_SEMANTIC_MODEL_ID, getSemanticModelManifest } from "../semantic/modelRegistry.js";
import { semanticModelManifestSha256 } from "../semantic/modelManager.js";

export const CODEX_PILOT_CONDITIONS: CodexPilotCondition[] = ["vanilla_codex", "codex_kairn"];
export const CODEX_PILOT_PIN = Object.freeze({
  package: "@openai/codex" as const,
  version: "0.145.0" as const,
  integrity: "sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ==" as const,
  model: "gpt-5.6" as const,
  reasoningEffort: "medium" as const,
  serviceTier: "standard" as const,
  fastMode: false as const
});
export const CODEX_PILOT_SEMANTIC_RC_PIN: CodexPilotKairnPin = Object.freeze({
  candidateMode: "semantic",
  semanticModelId: DEFAULT_SEMANTIC_MODEL_ID,
  semanticModelManifestSha256: semanticModelManifestSha256(
    getSemanticModelManifest(DEFAULT_SEMANTIC_MODEL_ID)
  ),
  rankerMode: "calibrated",
  rankerModelId: "kairn-semantic-rc-v185",
  rankerArtifactChecksum: BUNDLED_SEMANTIC_RC_EVIDENCE_ARTIFACT.checksum,
  featureSchemaVersion: "evidence-features-v5"
});

const LANGUAGES: ExperimentLanguage[] = ["python", "typescript", "go", "java", "cpp"];
const TASK_CLASSES: ExperimentTaskClass[] = ["source_localization", "failure_first", "long_session"];

export function loadCodexPilotPlan(planPath: string): CodexPilotPlan {
  const resolved = path.resolve(planPath);
  const root = asRecord(JSON.parse(fs.readFileSync(resolved, "utf8")), "Codex pilot plan");
  const schemaVersion = stringValue(root.schemaVersion, "schemaVersion");
  if (schemaVersion !== "codex-pilot.v1" && schemaVersion !== "codex-pilot.v2") {
    throw new Error("schemaVersion must be codex-pilot.v1 or codex-pilot.v2");
  }
  requireExactKeys(root, [
    "schemaVersion", "id", "name", "sealed", "profile", "lineageRegistry", "conditions",
    "codex", ...(schemaVersion === "codex-pilot.v2" ? ["kairn"] : []), "repeats", "timeoutMs", "tasks"
  ], "Codex pilot plan");
  if (root.sealed !== true) throw new Error("Codex pilot plan must declare sealed=true");
  const profile = stringValue(root.profile, "profile") as CodexPilotProfile;
  if (profile !== "smoke" && profile !== "pilot") throw new Error(`unsupported Codex pilot profile '${profile}'`);
  const conditions = stringArray(root.conditions, "conditions") as CodexPilotCondition[];
  if (
    conditions.length !== CODEX_PILOT_CONDITIONS.length ||
    CODEX_PILOT_CONDITIONS.some((condition) => !conditions.includes(condition)) ||
    new Set(conditions).size !== conditions.length
  ) {
    throw new Error(`conditions must contain exactly: ${CODEX_PILOT_CONDITIONS.join(", ")}`);
  }
  const codex = asRecord(root.codex, "codex");
  requireExactKeys(codex, ["package", "version", "integrity", "model", "reasoningEffort", "serviceTier", "fastMode"], "codex");
  for (const [key, expected] of Object.entries(CODEX_PILOT_PIN)) {
    if (codex[key] !== expected) throw new Error(`codex.${key} must be pinned to ${String(expected)}`);
  }
  let kairn: CodexPilotKairnPin | undefined;
  if (schemaVersion === "codex-pilot.v2") {
    const candidate = asRecord(root.kairn, "kairn");
    requireExactKeys(candidate, Object.keys(CODEX_PILOT_SEMANTIC_RC_PIN), "kairn");
    for (const [key, expected] of Object.entries(CODEX_PILOT_SEMANTIC_RC_PIN)) {
      if (candidate[key] !== expected) throw new Error(`kairn.${key} must be pinned to ${String(expected)}`);
    }
    kairn = CODEX_PILOT_SEMANTIC_RC_PIN;
  }
  const repeats = integerValue(root.repeats, "repeats");
  const timeoutMs = integerValue(root.timeoutMs, "timeoutMs");
  const planDir = path.dirname(resolved);
  const tasks = arrayValue(root.tasks, "tasks").map((task, index) => parseExperimentTask(task, planDir, index));
  const generalPlan: ExperimentPlan = {
    schemaVersion: 1,
    id: stringValue(root.id, "id"),
    name: stringValue(root.name, "name"),
    repeats,
    timeoutMs,
    tasks
  };
  const generalErrors = validateExperimentPlan(generalPlan);
  if (generalErrors.length > 0) throw new Error(`Invalid Codex pilot tasks:\n- ${generalErrors.join("\n- ")}`);
  const lineageRegistry = stringValue(root.lineageRegistry, "lineageRegistry");
  const registryPath = path.resolve(planDir, lineageRegistry);
  if (!isWithinDirectory(planDir, registryPath)) throw new Error("lineageRegistry must stay inside the plan directory");
  validateCodexProfile({ profile, repeats, tasks });
  validateLineages(registryPath, profile, tasks.map((task) => task.repoUrl));
  return {
    schemaVersion,
    id: generalPlan.id,
    name: generalPlan.name,
    sealed: true,
    profile,
    lineageRegistry: registryPath,
    conditions,
    codex: CODEX_PILOT_PIN,
    ...(kairn ? { kairn } : {}),
    repeats,
    timeoutMs,
    tasks
  };
}

export function buildCodexPilotSchedule(input: {
  plan: CodexPilotPlan;
  seed: number;
  stage: CodexPilotStage;
}): CodexPilotAttemptPlan[] {
  if (input.plan.profile === "smoke" && input.stage !== "smoke") {
    throw new Error("smoke plans require --stage smoke");
  }
  if (input.plan.profile === "pilot" && input.stage === "smoke") {
    throw new Error("pilot plans require --stage first_repeat or complete");
  }
  const repeats = input.stage === "first_repeat" || input.stage === "smoke" ? 1 : input.plan.repeats;
  const attempts: CodexPilotAttemptPlan[] = [];
  for (const [taskIndex, task] of input.plan.tasks.entries()) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const order = positiveMod(input.seed + taskIndex + repeat - 1, 2) === 0
        ? CODEX_PILOT_CONDITIONS
        : [...CODEX_PILOT_CONDITIONS].reverse();
      const blockId = `${task.id}:r${repeat}`;
      order.forEach((condition, index) => attempts.push({
        id: `${sanitizeId(task.id)}__r${repeat}__${condition}`,
        campaignId: input.plan.id,
        taskId: task.id,
        condition,
        repeat,
        order: index + 1,
        blockId
      }));
    }
  }
  return attempts;
}

function validateCodexProfile(input: {
  profile: CodexPilotProfile;
  repeats: number;
  tasks: CodexPilotPlan["tasks"];
}): void {
  const errors: string[] = [];
  const expectedTasks = input.profile === "smoke" ? 1 : 15;
  const expectedRepeats = input.profile === "smoke" ? 1 : 3;
  if (input.tasks.length !== expectedTasks) errors.push(`${input.profile} profile requires exactly ${expectedTasks} task(s)`);
  if (input.repeats !== expectedRepeats) errors.push(`${input.profile} profile requires exactly ${expectedRepeats} repeat(s)`);
  const lineages = input.tasks.map((task) => normalizeRepository(task.repoUrl));
  if (new Set(lineages).size !== lineages.length) errors.push("every task must use a unique repository lineage");
  if (input.profile === "pilot") {
    for (const language of LANGUAGES) {
      for (const taskClass of TASK_CLASSES) {
        const count = input.tasks.filter((task) => task.language === language && task.taskClass === taskClass).length;
        if (count !== 1) errors.push(`pilot needs exactly one ${language}/${taskClass} task (found ${count})`);
      }
    }
  }
  for (const task of input.tasks) {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(task.ref)) errors.push(`${task.id}: ref must be a full immutable commit hash`);
    if (!task.sandboxImage) errors.push(`${task.id}: sandboxImage is required`);
    if (task.requiredSourceFiles.length === 0) errors.push(`${task.id}: requiredSourceFiles is required`);
    if ((task.requiredTouchedFiles?.length ?? 0) === 0) errors.push(`${task.id}: requiredTouchedFiles is required`);
    if ((task.allowedDiffScopes?.length ?? 0) === 0) errors.push(`${task.id}: allowedDiffScopes is required`);
    if ((task.sourceInvariants?.length ?? 0) === 0) errors.push(`${task.id}: sourceInvariants is required`);
    if ((task.explicitNoisePatterns?.length ?? 0) === 0) errors.push(`${task.id}: explicitNoisePatterns is required`);
    if (task.taskClass === "long_session" && task.turns?.length !== 3) {
      errors.push(`${task.id}: long_session tasks require exactly three turns`);
    }
  }
  if (errors.length > 0) throw new Error(`Invalid ${input.profile} Codex pilot plan:\n- ${errors.join("\n- ")}`);
}

function validateLineages(registryPath: string, profile: CodexPilotProfile, repositories: string[]): void {
  const root = asRecord(JSON.parse(fs.readFileSync(registryPath, "utf8")), "lineage registry");
  if (root.schemaVersion !== "lineage-registry.v1") throw new Error("lineage registry schemaVersion must be lineage-registry.v1");
  const roles = new Map<string, string>();
  for (const [index, value] of arrayValue(root.lineages, "lineages").entries()) {
    const row = asRecord(value, `lineages[${index}]`);
    const id = normalizeRepository(stringValue(row.id, `lineages[${index}].id`));
    const role = stringValue(row.role, `lineages[${index}].role`);
    if (roles.has(id)) throw new Error(`duplicate lineage id '${id}'`);
    roles.set(id, role);
  }
  const expectedRole = profile === "smoke" ? "live_smoke" : "pilot";
  for (const repository of repositories) {
    const normalized = normalizeRepository(repository);
    if (roles.get(normalized) !== expectedRole) {
      throw new Error(`${repository}: lineage registry role must be ${expectedRole}`);
    }
  }
}

function normalizeRepository(value: string): string {
  return value.replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
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

function stringArray(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item, index) => stringValue(item, `${label}[${index}]`));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function positiveMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
