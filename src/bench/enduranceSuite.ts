import fs from "node:fs";
import path from "node:path";
import type { BenchmarkEnduranceSuite, BenchmarkEnduranceTurn, BenchmarkSeedSpec } from "../types.js";
import { normalizeRelativePath } from "../utils/paths.js";

export function loadBenchmarkEnduranceSuite(input: { suitePath: string }): BenchmarkEnduranceSuite {
  const absolute = path.resolve(input.suitePath);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
  return normalizeEnduranceSuite(parsed, path.dirname(absolute));
}

function normalizeEnduranceSuite(input: unknown, suiteDir: string): BenchmarkEnduranceSuite {
  if (!isRecord(input)) throw new Error("Endurance benchmark suite must be a JSON object.");
  const id = stringValue(input.id) ?? "endurance";
  const name = stringValue(input.name) ?? id;
  const task = stringValue(input.task) ?? name;
  const turns = Array.isArray(input.turns) ? input.turns.map(normalizeTurn) : [];
  if (turns.length === 0) throw new Error("Endurance benchmark suite must include at least one turn.");
  const seed = normalizeSeed(input.seed, suiteDir);
  const finalVerificationCommand = stringValue(input.finalVerificationCommand);
  return {
    id,
    name,
    task,
    ...(seed ? { seed } : {}),
    turns,
    ...(finalVerificationCommand ? { finalVerificationCommand } : {})
  };
}

function normalizeTurn(input: unknown): BenchmarkEnduranceTurn {
  if (!isRecord(input)) throw new Error("Endurance turn must be a JSON object.");
  const id = requireString(input.id, "turn.id");
  const task = stringValue(input.task) ?? stringValue(input.agentPrompt) ?? id;
  const agentPrompt = stringValue(input.agentPrompt);
  const verificationCommand = stringValue(input.verificationCommand);
  const budget = numberValue(input.budget);
  return {
    id,
    task,
    ...(agentPrompt ? { agentPrompt } : {}),
    expectedFiles: normalizeFiles(input.expectedFiles),
    requiredTouchedFiles: normalizeFiles(input.requiredTouchedFiles),
    excludedFiles: normalizeFiles(input.excludedFiles),
    ...(verificationCommand ? { verificationCommand } : {}),
    ...(budget ? { budget } : {})
  };
}

function normalizeSeed(value: unknown, suiteDir: string): BenchmarkSeedSpec | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Endurance suite seed must be a JSON object.");
  const repoUrl = requireString(value.repoUrl, "seed.repoUrl");
  const ref = stringValue(value.ref);
  const cloneDepth = numberValue(value.cloneDepth);
  const setupPatch = stringValue(value.setupPatch);
  const setupPatchFile = resolveSuitePath(stringValue(value.setupPatchFile), suiteDir);
  const expectedFailureCommand = stringValue(value.expectedFailureCommand);
  const testCommand = stringValue(value.testCommand);
  const setupCommands = stringList(value.setupCommands);
  return {
    repoUrl,
    ...(ref ? { ref } : {}),
    ...(cloneDepth ? { cloneDepth } : {}),
    ...(setupCommands.length > 0 ? { setupCommands } : {}),
    ...(setupPatch ? { setupPatch } : {}),
    ...(setupPatchFile ? { setupPatchFile } : {}),
    ...(expectedFailureCommand ? { expectedFailureCommand } : {}),
    ...(testCommand ? { testCommand } : {})
  };
}

function resolveSuitePath(value: string | undefined, suiteDir: string): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  return path.resolve(suiteDir, value);
}

function normalizeFiles(value: unknown): string[] {
  return stringList(value).map(normalizeRelativePath);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireString(value: unknown, label: string): string {
  const string = stringValue(value);
  if (!string) throw new Error(`Missing required ${label}.`);
  return string;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
