// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type VariantOptions = {
  parentsPerCell?: number;
  variantsPerParent?: 1 | 2;
};

type IntakeCase = Record<string, unknown> & {
  id: string;
  split: "train" | "calibration" | "holdout";
  language: string;
  scenario: string;
  dataOrigin: "public_benchmark" | "public_patch" | "synthetic";
  prompt: string;
};

export function buildSyntheticPromptVariants(
  value: unknown,
  options: VariantOptions = {}
): Record<string, unknown> {
  const intake = record(value, "intake");
  if (intake.schemaVersion !== "ranker-corpus-intake.v1") {
    throw new Error("Synthetic prompt variants require ranker-corpus-intake.v1.");
  }
  if (!["evidence-features-v1", "evidence-features-v2", "evidence-features-v3", "evidence-features-v4"]
    .includes(String(intake.featureSchemaVersion))) {
    throw new Error("Synthetic prompt variants require a supported evidence feature schema.");
  }
  const cases = array(intake.cases, "intake.cases").map(parseCase);
  const parentsPerCell = boundedInteger(options.parentsPerCell ?? 0, 0, 100_000, "parentsPerCell");
  const variantsPerParent = options.variantsPerParent ?? 2;
  if (variantsPerParent !== 1 && variantsPerParent !== 2) {
    throw new Error("variantsPerParent must be one or two.");
  }
  const naturalTrain = cases.filter((item) => item.split === "train" && item.dataOrigin !== "synthetic");
  const selectedParents = selectParents(naturalTrain, parentsPerCell);
  const variants = selectedParents.flatMap((parent) =>
    buildPromptViews(parent.prompt).slice(0, variantsPerParent).map((prompt, index) => ({
      ...parent,
      id: `${parent.id}-synthetic-view-${index + 1}`,
      dataOrigin: "synthetic",
      prompt,
      syntheticVariantOf: parent.id,
      syntheticVariantIndex: index + 1
    }))
  );
  const existingIds = new Set(cases.map((item) => item.id));
  for (const variant of variants) {
    if (existingIds.has(variant.id)) throw new Error(`Synthetic variant id already exists: ${variant.id}`);
    existingIds.add(variant.id);
  }
  return {
    ...intake,
    corpusId: `${string(intake.corpusId, "intake.corpusId")}-synthetic-views-v1`,
    sealed: false,
    cases: [...cases, ...variants],
    syntheticVariantPolicy: {
      schemaVersion: "deterministic-prompt-views.v1",
      selectedParents: selectedParents.length,
      generatedVariants: variants.length,
      parentsPerCell,
      variantsPerParent,
      selection: "stable SHA-256 order within language/scenario; train-only natural parents",
      transformation: "bounded headline, narrative, and fenced-evidence views; no generated claims or target paths"
    }
  };
}

export function buildPromptViews(prompt: string): [string, string] {
  const normalized = prompt.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("Synthetic prompt parent must not be empty.");
  const lines = normalized.split("\n");
  const headline = lines.find((line) => line.trim())!.trim().slice(0, 320);
  const { narrative, fences } = partitionPrompt(lines);
  const narrativeText = narrative.join("\n").replace(/\s+/g, " ").trim();
  const synopsis = representativeText(narrativeText, 1_180);
  const evidence = evenlySampleIncludingEndpoints(fences, Math.min(2, fences.length))
    .map((block, index) => `evidence ${index + 1}:\n${representativeText(block, 520)}`)
    .join("\n\n");
  const first = boundedPrompt([
    headline,
    "",
    "Task context:",
    synopsis
  ].filter(Boolean).join("\n"));
  const second = boundedPrompt([
    headline,
    "",
    ...(evidence ? ["Observed technical evidence:", evidence, ""] : []),
    "Repository task context:",
    representativeText(narrativeText, evidence ? 700 : 1_180)
  ].filter(Boolean).join("\n"));
  return first === second
    ? [first, boundedPrompt(`${headline}\n\nRepository task context:\n${representativeText(normalized, 1_300)}`)]
    : [first, second];
}

function selectParents(cases: IntakeCase[], parentsPerCell: number): IntakeCase[] {
  const groups = new Map<string, IntakeCase[]>();
  for (const item of cases) {
    const key = `${item.language}\0${item.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, items]) => items
      .sort((left, right) => stableOrder(left.id) - stableOrder(right.id) || left.id.localeCompare(right.id))
      .slice(0, parentsPerCell > 0 ? parentsPerCell : items.length));
}

function stableOrder(value: string): number {
  return Number.parseInt(crypto.createHash("sha256").update(value).digest("hex").slice(0, 12), 16);
}

function partitionPrompt(lines: string[]): { narrative: string[]; fences: string[] } {
  const narrative: string[] = [];
  const fences: string[] = [];
  let active: string[] | undefined;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (active) {
        const block = active.join("\n").trim();
        if (block) fences.push(block);
        active = undefined;
      } else {
        active = [];
      }
      continue;
    }
    if (active) active.push(line);
    else narrative.push(line);
  }
  if (active?.length) fences.push(active.join("\n").trim());
  return { narrative, fences };
}

function representativeText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const separator = " […] ";
  const sectionSize = Math.max(1, Math.floor((maxChars - separator.length * 2) / 3));
  const starts = [
    0,
    Math.max(0, Math.floor((normalized.length - sectionSize) / 2)),
    Math.max(0, normalized.length - sectionSize)
  ];
  return starts.map((start) => normalized.slice(start, start + sectionSize)).join(separator);
}

function boundedPrompt(value: string): string {
  return value.length <= 1_600 ? value : representativeText(value, 1_600);
}

function evenlySampleIncludingEndpoints<T>(values: T[], count: number): T[] {
  if (count <= 0) return [];
  if (count >= values.length) return [...values];
  if (count === 1) return [values[0]!];
  return Array.from({ length: count }, (_, index) =>
    values[Math.round((index * (values.length - 1)) / (count - 1))]!
  );
}

function parseCase(value: unknown, index: number): IntakeCase {
  const item = record(value, `intake.cases[${index}]`);
  const split = string(item.split, `intake.cases[${index}].split`);
  const dataOrigin = string(item.dataOrigin, `intake.cases[${index}].dataOrigin`);
  if (!(["train", "calibration", "holdout"] as string[]).includes(split)) {
    throw new Error(`intake.cases[${index}].split is invalid.`);
  }
  if (!(["public_benchmark", "public_patch", "synthetic"] as string[]).includes(dataOrigin)) {
    throw new Error(`intake.cases[${index}].dataOrigin is invalid.`);
  }
  return {
    ...item,
    id: string(item.id, `intake.cases[${index}].id`),
    split: split as IntakeCase["split"],
    language: string(item.language, `intake.cases[${index}].language`),
    scenario: string(item.scenario, `intake.cases[${index}].scenario`),
    dataOrigin: dataOrigin as IntakeCase["dataOrigin"],
    prompt: string(item.prompt, `intake.cases[${index}].prompt`)
  };
}

function parseArgs(args: string[]): {
  intakePath: string;
  outPath: string;
  parentsPerCell: number;
  variantsPerParent: 1 | 2;
} {
  const values = new Map<string, string>();
  const normalized = args.filter((value) => value !== "--");
  for (let index = 0; index < normalized.length; index += 2) {
    const key = normalized[index];
    const value = normalized[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    values.set(key, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required.`);
    return path.resolve(value);
  };
  const parentsPerCell = Number(values.get("--parents-per-cell") ?? "0");
  const variantsPerParent = Number(values.get("--variants-per-parent") ?? "2");
  return {
    intakePath: required("--intake"),
    outPath: required("--out"),
    parentsPerCell: boundedInteger(parentsPerCell, 0, 100_000, "--parents-per-cell"),
    variantsPerParent: boundedInteger(variantsPerParent, 1, 2, "--variants-per-parent") as 1 | 2
  };
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function runCli(): void {
  const options = parseArgs(process.argv.slice(2));
  const source = JSON.parse(fs.readFileSync(options.intakePath, "utf8"));
  const output = buildSyntheticPromptVariants(source, options);
  const lineageRegistry = string(record(source, "intake").lineageRegistry, "intake.lineageRegistry");
  output.lineageRegistry = path.relative(
    path.dirname(options.outPath),
    path.resolve(path.dirname(options.intakePath), lineageRegistry)
  ).replace(/\\/g, "/");
  fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
  fs.writeFileSync(options.outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    out: path.relative(process.cwd(), options.outPath).replace(/\\/g, "/"),
    ...record(output.syntheticVariantPolicy, "syntheticVariantPolicy")
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
