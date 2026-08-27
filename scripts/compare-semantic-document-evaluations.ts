// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SEMANTIC_EVALUATION_COMPARISON_SCHEMA = "semantic-document-evaluation-comparison.v1" as const;

type JsonRecord = Record<string, unknown>;
type CaseRow = { id: string; language: string; scenario: string; ranks: Record<string, number | null> };

export type CompareSemanticEvaluationsOptions = {
  baselinePath: string;
  candidatePath: string;
  outPath: string;
  bootstrapSamples?: number;
  bootstrapSeed?: number;
};

export function compareSemanticDocumentEvaluations(
  options: CompareSemanticEvaluationsOptions
): Record<string, unknown> {
  const baselinePath = path.resolve(options.baselinePath);
  const candidatePath = path.resolve(options.candidatePath);
  const baselineBytes = fs.readFileSync(baselinePath);
  const candidateBytes = fs.readFileSync(candidatePath);
  const baseline = json(baselineBytes, "baseline");
  const candidate = json(candidateBytes, "candidate");
  validateEvaluation(baseline, "baseline");
  validateEvaluation(candidate, "candidate");
  validateSamePool(baseline, candidate);
  const bootstrapSamples = positiveInteger(options.bootstrapSamples ?? 10_000, "bootstrapSamples");
  const bootstrapSeed = nonNegativeInteger(options.bootstrapSeed ?? 20260827, "bootstrapSeed");

  const weakPatch = compareCohort(
    record(baseline.weakPatchCalibration, "baseline.weakPatchCalibration"),
    record(candidate.weakPatchCalibration, "candidate.weakPatchCalibration"),
    bootstrapSamples,
    bootstrapSeed
  );
  const requiredSource = compareCohort(
    record(baseline.requiredSourceDiagnostic, "baseline.requiredSourceDiagnostic"),
    record(candidate.requiredSourceDiagnostic, "candidate.requiredSourceDiagnostic"),
    bootstrapSamples,
    bootstrapSeed + 1
  );
  const candidateRequired = record(candidate.requiredSourceDiagnostic, "candidate.requiredSourceDiagnostic");
  const candidateCalibration = record(candidate.weakPatchCalibration, "candidate.weakPatchCalibration");
  const ece = finite(candidate.calibrationEce, "candidate.calibrationEce");
  const hardGates = {
    requiredSourceRecallAt64: {
      value: finite(candidateRequired.recallAt64, "candidate.requiredSourceDiagnostic.recallAt64"),
      minimum: 0.99
    },
    calibrationEce: { value: ece, maximum: 0.05 },
    generatedVendorTopOneViolations: {
      value: array(candidateRequired.generatedVendorTopOneViolations, "candidate.requiredSourceDiagnostic.generatedVendorTopOneViolations").length
        + array(candidateCalibration.generatedVendorTopOneViolations, "candidate.weakPatchCalibration.generatedVendorTopOneViolations").length,
      maximum: 0
    }
  };
  const hardGatesPass = hardGates.requiredSourceRecallAt64.value >= hardGates.requiredSourceRecallAt64.minimum
    && hardGates.calibrationEce.value <= hardGates.calibrationEce.maximum
    && hardGates.generatedVendorTopOneViolations.value <= hardGates.generatedVendorTopOneViolations.maximum;
  const recallAt5Delta = metricDelta(weakPatch, "recallAt5");
  const mrrDelta = metricDelta(weakPatch, "mrr");
  const noninferior = recallAt5Delta >= -0.02 && mrrDelta >= -0.02;
  const primaryPositive = [weakPatch, requiredSource].some((cohort) =>
    ["recallAt5", "mrr", "recallAt64"].some((metric) =>
      (record(record(cohort.metrics, "cohort.metrics")[metric], `cohort.metrics.${metric}`).paired95Ci as number[])[0]! > 0
    )
  );
  const classification = !hardGatesPass || !noninferior
    ? "completed_negative"
    : primaryPositive
      ? "completed_positive"
      : "completed_noninferior";

  return {
    schemaVersion: SEMANTIC_EVALUATION_COMPARISON_SCHEMA,
    promotionEligible: false,
    detachedHoldoutOpened: false,
    samePoolVerified: true,
    classification,
    inputs: {
      baseline: artifactDigest(baselinePath, baselineBytes),
      candidate: artifactDigest(candidatePath, candidateBytes)
    },
    bootstrap: { unit: "case", samples: bootstrapSamples, seed: bootstrapSeed },
    gates: { hardGatesPass, noninferiorityMargin: 0.02, noninferior, ...hardGates },
    calibration: {
      baselineEce: finite(baseline.calibrationEce, "baseline.calibrationEce"),
      candidateEce: ece,
      delta: ece - finite(baseline.calibrationEce, "baseline.calibrationEce")
    },
    weakPatchCalibration: weakPatch,
    requiredSourceDiagnostic: requiredSource
  };
}

function compareCohort(
  baseline: JsonRecord,
  candidate: JsonRecord,
  samples: number,
  seed: number
): Record<string, unknown> {
  const baselineRows = caseRows(baseline.caseRows, "baseline.caseRows");
  const candidateRows = caseRows(candidate.caseRows, "candidate.caseRows");
  const baselineById = new Map(baselineRows.map((row) => [row.id, row]));
  const candidateById = new Map(candidateRows.map((row) => [row.id, row]));
  if (baselineById.size !== candidateById.size || [...baselineById.keys()].some((id) => !candidateById.has(id))) {
    throw new Error("paired evaluation case populations differ");
  }
  const ids = [...baselineById.keys()].sort();
  for (const id of ids) {
    const left = baselineById.get(id)!;
    const right = candidateById.get(id)!;
    if (Object.keys(left.ranks).sort().join("\n") !== Object.keys(right.ranks).sort().join("\n")) {
      throw new Error(`${id}: paired required-file populations differ`);
    }
    if (left.language !== right.language || left.scenario !== right.scenario) {
      throw new Error(`${id}: paired strata differ`);
    }
  }
  const metrics = Object.fromEntries(["recallAt1", "recallAt5", "recallAt64", "mrr", "strictFullRecallAt64"].map((metric) => {
    const baselineValue = metricValue(ids.map((id) => baselineById.get(id)!), metric);
    const candidateValue = metricValue(ids.map((id) => candidateById.get(id)!), metric);
    const random = mulberry32(seed + metric.length);
    const deltas: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const selected = ids.map(() => ids[Math.floor(random() * ids.length)]!);
      deltas.push(
        metricValue(selected.map((id) => candidateById.get(id)!), metric)
        - metricValue(selected.map((id) => baselineById.get(id)!), metric)
      );
    }
    deltas.sort((left, right) => left - right);
    return [metric, {
      baseline: baselineValue,
      candidate: candidateValue,
      delta: candidateValue - baselineValue,
      paired95Ci: [deltas[Math.floor(samples * 0.025)]!, deltas[Math.min(samples - 1, Math.floor(samples * 0.975))]!]
    }];
  }));
  const movements = ids.flatMap((id) => {
    const left = baselineById.get(id)!;
    const right = candidateById.get(id)!;
    return Object.keys(left.ranks).sort().flatMap((filePath) => {
      const baselineRank = left.ranks[filePath] ?? null;
      const candidateRank = right.ranks[filePath] ?? null;
      if (baselineRank === candidateRank) return [];
      return [{
        id,
        language: left.language,
        scenario: left.scenario,
        path: filePath,
        baselineRank,
        candidateRank,
        delta: candidateRank === null || baselineRank === null ? null : candidateRank - baselineRank
      }];
    });
  });
  const requiredFiles = baselineRows.reduce((total, row) => total + Object.keys(row.ranks).length, 0);
  return {
    cases: ids.length,
    requiredFiles,
    metrics,
    improvedRanks: movements.filter((item) => item.delta !== null && item.delta < 0),
    regressedRanks: movements.filter((item) => item.delta === null || item.delta > 0)
  };
}

function metricValue(rows: CaseRow[], metric: string): number {
  if (metric === "strictFullRecallAt64") {
    return rows.filter((row) => Object.values(row.ranks).every((rank) => rank !== null && rank <= 64)).length / rows.length;
  }
  const ranks = rows.flatMap((row) => Object.values(row.ranks));
  if (metric === "mrr") {
    return ranks.reduce<number>((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length;
  }
  const limit = metric === "recallAt1" ? 1 : metric === "recallAt5" ? 5 : 64;
  return ranks.filter((rank) => rank !== null && rank <= limit).length / ranks.length;
}

function caseRows(value: unknown, label: string): CaseRow[] {
  return array(value, label).map((raw, index) => {
    const item = record(raw, `${label}[${index}]`);
    const sourceRanks = record(item.ranks, `${label}[${index}].ranks`);
    return {
      id: string(item.id, `${label}[${index}].id`),
      language: string(item.language, `${label}[${index}].language`),
      scenario: string(item.scenario, `${label}[${index}].scenario`),
      ranks: Object.fromEntries(Object.entries(sourceRanks).map(([filePath, rank]) => [
        filePath,
        rank === null ? null : positiveInteger(rank, `${label}[${index}].ranks.${filePath}`)
      ]))
    };
  });
}

function validateEvaluation(value: JsonRecord, label: string): void {
  if (value.schemaVersion !== "semantic-document-feature-diagnostic.v1") throw new Error(`${label} schemaVersion mismatch`);
  if (value.samePoolVerified !== true || value.promotionEligible !== false) {
    throw new Error(`${label} must be a same-pool non-promotion diagnostic`);
  }
}

function validateSamePool(baseline: JsonRecord, candidate: JsonRecord): void {
  const left = record(baseline.inputs, "baseline.inputs");
  const right = record(candidate.inputs, "candidate.inputs");
  for (const key of ["baselineManifestSha256", "candidateManifestSha256", "candidateReportSha256"]) {
    if (left[key] !== right[key]) throw new Error(`evaluation ${key} differs; percentages are not comparable`);
  }
  validateFeatureExperiment(baseline, candidate);
}

function validateFeatureExperiment(baseline: JsonRecord, candidate: JsonRecord): void {
  if (JSON.stringify(baseline.featureSchema) === JSON.stringify(candidate.featureSchema)) return;
  const baselineSchema = record(baseline.featureSchema, "baseline.featureSchema");
  const candidateSchema = record(candidate.featureSchema, "candidate.featureSchema");
  const baselineBase = stringArray(baselineSchema.base, "baseline.featureSchema.base");
  const candidateBase = stringArray(candidateSchema.base, "candidate.featureSchema.base");
  if (JSON.stringify(baselineBase) !== JSON.stringify(candidateBase)) {
    throw new Error("controlled feature experiment cannot change base features");
  }
  const baselineAdded = stringArray(baselineSchema.added, "baseline.featureSchema.added");
  const candidateAdded = stringArray(candidateSchema.added, "candidate.featureSchema.added");
  if (JSON.stringify(candidateAdded.slice(0, baselineAdded.length)) !== JSON.stringify(baselineAdded)) {
    throw new Error("controlled feature experiment must preserve baseline added features in order");
  }
  const newFeatures = candidateAdded.slice(baselineAdded.length);
  if (newFeatures.length === 0) throw new Error("evaluation feature schemas differ");
  const contract = record(candidate.controlledFeatureExperiment, "candidate.controlledFeatureExperiment");
  if (contract.unchangedFrozenInputs !== true) {
    throw new Error("controlled feature experiment must preserve frozen inputs");
  }
  const expectedSchemaHash = sha256(Buffer.from(canonicalJson(baselineSchema)));
  if (contract.baselineFeatureSchemaSha256 !== expectedSchemaHash) {
    throw new Error("controlled feature experiment baseline schema hash differs");
  }
  if (JSON.stringify(stringArray(contract.addedFeatures, "candidate.controlledFeatureExperiment.addedFeatures")) !== JSON.stringify(newFeatures)) {
    throw new Error("controlled feature experiment added-feature declaration differs");
  }
}

function metricDelta(cohort: Record<string, unknown>, metric: string): number {
  return finite(record(record(cohort.metrics, "cohort.metrics")[metric], `cohort.metrics.${metric}`).delta, `cohort.metrics.${metric}.delta`);
}

function artifactDigest(filePath: string, bytes: Buffer): Record<string, unknown> {
  const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
  return { path: relative, sha256: sha256(bytes), bytes: bytes.length };
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let output = value;
    output = Math.imul(output ^ (output >>> 15), output | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4294967296;
  };
}

function json(bytes: Buffer, label: string): JsonRecord {
  return record(JSON.parse(bytes.toString("utf8")) as unknown, label);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): CompareSemanticEvaluationsOptions {
  const args = argv.filter((token) => token !== "--");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument '${key ?? ""}'`);
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`${key} is required`);
    return value;
  };
  return {
    baselinePath: required("--baseline"),
    candidatePath: required("--candidate"),
    outPath: required("--out"),
    ...(values.has("--bootstrap-samples") ? { bootstrapSamples: Number(values.get("--bootstrap-samples")) } : {}),
    ...(values.has("--bootstrap-seed") ? { bootstrapSeed: Number(values.get("--bootstrap-seed")) } : {})
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const comparison = compareSemanticDocumentEvaluations(options);
    const target = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ out: target, ...comparison }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
