// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEvidenceRankerArtifact,
  predictEvidenceRelevance
} from "../src/retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES, type EvidenceFeatureVector } from "../src/types.js";

type Options = {
  modelPath: string;
  trainingRowsPath: string;
  manifestPath: string;
  reportPath: string;
  outPath: string;
  split: "calibration" | "holdout";
};

type RankedCandidate = {
  path: string;
  probability: number;
  hardPriority: number;
  generatedVendor: boolean;
  label: 0 | 1 | null;
};

type CaseResult = {
  id: string;
  language: string;
  scenario: string;
  requiredSourceFiles: string[];
  probeCandidateCount: number;
  availabilityAtProbe: boolean;
  currentFullRecallAt64: boolean;
  currentFullRecallAt128: boolean;
  rankedFullRecallAt64: boolean;
  rankedFullRecallAt128: boolean;
  requiredFileRanks: Record<string, number | null>;
  missingAt64: string[];
  missingAt128: string[];
  generatedVendorTopOne: boolean;
};

const options = parseArgs(process.argv.slice(2));
const model = loadEvidenceRankerArtifact(options.modelPath);
const trainingRowsBytes = fs.readFileSync(options.trainingRowsPath);
if (sha256(trainingRowsBytes) !== model.trainingDataHash) {
  throw new Error("Model trainingDataHash does not match --training-rows.");
}

const manifestBytes = fs.readFileSync(options.manifestPath);
const reportBytes = fs.readFileSync(options.reportPath);
const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "manifest");
const report = record(JSON.parse(reportBytes.toString("utf8")), "report");
validateInputs(manifest, report, options.split);

const reportCases = new Map(
  array(report.cases, "report.cases").map((value, index) => {
    const item = record(value, `report.cases[${index}]`);
    return [string(item.id, `report.cases[${index}].id`), item] as const;
  })
);
const targetCases = array(manifest.cases, "manifest.cases")
  .map((value, index) => record(value, `manifest.cases[${index}]`))
  .filter((item) => item.split === options.split);
if (targetCases.length === 0) {
  throw new Error(`Probe ranker diagnostic requires at least one ${options.split} case.`);
}

const calibrationSamples: Array<{ probability: number; label: 0 | 1 }> = [];
const results: CaseResult[] = [];
for (const corpusCase of targetCases) {
  const caseId = string(corpusCase.id, "case.id");
  const reportCase = reportCases.get(caseId);
  if (!reportCase) throw new Error(`${caseId}: missing from probe report`);
  const requiredSourceFiles = stringArray(
    options.split === "holdout"
      ? reportCase.requiredSourceExistingFiles
      : reportCase.officialPatchSourceExistingFiles,
    options.split === "holdout"
      ? `${caseId}.requiredSourceExistingFiles`
      : `${caseId}.officialPatchSourceExistingFiles`
  );
  if (requiredSourceFiles.length === 0) {
    throw new Error(`${caseId}: diagnostic ${options.split} has no existing source reference`);
  }
  const candidateSource = Array.isArray(reportCase.probeCandidates)
    ? "probeCandidates"
    : "trainingCandidates";
  const diagnosticCandidates = candidateSource === "probeCandidates"
    ? array(reportCase.probeCandidates, `${caseId}.probeCandidates`)
    : array(corpusCase.trainingCandidates, `${caseId}.trainingCandidates`);
  if (diagnosticCandidates.length === 0) {
    throw new Error(`${caseId}: diagnostic candidate set is empty`);
  }
  const ranked = diagnosticCandidates.map((value, candidateIndex): RankedCandidate => {
    const candidate = record(value, `${caseId}.${candidateSource}[${candidateIndex}]`);
    const features = evidenceFeatures(
      record(candidate.features, `${caseId}.${candidateSource}[${candidateIndex}].features`),
      `${caseId}.${candidateSource}[${candidateIndex}].features`
    );
    const probability = predictEvidenceRelevance(model, features).relevanceProbability;
    const label = candidate.label === 0 || candidate.label === 1 ? candidate.label : null;
    if (label !== null) calibrationSamples.push({ probability, label });
    return {
      path: string(candidate.path, `${caseId}.${candidateSource}[${candidateIndex}].path`),
      probability,
      hardPriority: features.failureReference > 0 ? 2 : features.exactPath > 0 ? 1 : 0,
      generatedVendor: features.generatedVendor > 0,
      label
    };
  }).sort((left, right) =>
    right.hardPriority - left.hardPriority ||
    right.probability - left.probability ||
    left.path.localeCompare(right.path)
  );
  const current64 = new Set(stringArray(reportCase.initialCandidatePaths, `${caseId}.initialCandidatePaths`));
  const current128 = new Set(stringArray(reportCase.enrichedCandidatePaths, `${caseId}.enrichedCandidatePaths`));
  const probePaths = new Set(ranked.map((item) => item.path));
  const ranked64 = new Set(ranked.slice(0, 64).map((item) => item.path));
  const ranked128 = new Set(ranked.slice(0, 128).map((item) => item.path));
  const positions = new Map(ranked.map((item, index) => [item.path, index + 1]));
  const missingAt64 = requiredSourceFiles.filter((filePath) => !ranked64.has(filePath));
  const missingAt128 = requiredSourceFiles.filter((filePath) => !ranked128.has(filePath));
  results.push({
    id: caseId,
    language: string(corpusCase.language, `${caseId}.language`),
    scenario: string(corpusCase.scenario, `${caseId}.scenario`),
    requiredSourceFiles,
    probeCandidateCount: ranked.length,
    availabilityAtProbe: requiredSourceFiles.every((filePath) => probePaths.has(filePath)),
    currentFullRecallAt64: requiredSourceFiles.every((filePath) => current64.has(filePath)),
    currentFullRecallAt128: requiredSourceFiles.every((filePath) => current128.has(filePath)),
    rankedFullRecallAt64: missingAt64.length === 0,
    rankedFullRecallAt128: missingAt128.length === 0,
    requiredFileRanks: Object.fromEntries(
      requiredSourceFiles.map((filePath) => [filePath, positions.get(filePath) ?? null])
    ),
    missingAt64,
    missingAt128,
    generatedVendorTopOne: ranked[0]?.generatedVendor ?? false
  });
}

const summary = {
  schemaVersion: "probe-ranker-evaluation.v1",
  promotionEligible: false,
  reason: options.split === "holdout"
    ? "This is a single-use diagnostic holdout over an unsealed probe corpus, not the 165-case promotion campaign."
    : "This calibration-split diagnostic uses weak official-patch references and in-sample Platt calibration; it is not holdout or promotion evidence.",
  evaluationSplit: options.split,
  referenceKind: options.split === "holdout"
    ? "required_source_oracle"
    : "verified_official_patch_source",
  model: {
    id: model.modelId,
    checksum: model.checksum,
    featureSchemaVersion: model.featureSchemaVersion,
    trainingDataHash: model.trainingDataHash
  },
  inputs: {
    trainingRows: inputDigest(options.trainingRowsPath, trainingRowsBytes),
    manifest: inputDigest(options.manifestPath, manifestBytes),
    report: inputDigest(options.reportPath, reportBytes)
  },
  targetCaseCount: results.length,
  holdoutCaseCount: options.split === "holdout" ? results.length : 0,
  calibrationCaseCount: options.split === "calibration" ? results.length : 0,
  labeledTargetRows: calibrationSamples.length,
  labeledHoldoutRows: options.split === "holdout" ? calibrationSamples.length : 0,
  metrics: {
    probeAvailabilityFullRecall: fraction(results, (item) => item.availabilityAtProbe),
    currentStrictFullRecallAt64: fraction(results, (item) => item.currentFullRecallAt64),
    currentStrictFullRecallAt128: fraction(results, (item) => item.currentFullRecallAt128),
    rankedStrictFullRecallAt64: fraction(results, (item) => item.rankedFullRecallAt64),
    rankedStrictFullRecallAt128: fraction(results, (item) => item.rankedFullRecallAt128),
    rankedRequiredFileRecallAt1: requiredFileRecall(results, 1),
    rankedRequiredFileRecallAt5: requiredFileRecall(results, 5),
    rankedRequiredFileRecallAt64: requiredFileRecall(results, 64),
    rankedRequiredFileRecallAt128: requiredFileRecall(results, 128),
    rankedRequiredFileMrr: requiredFileMrr(results),
    expectedCalibrationError: expectedCalibrationError(calibrationSamples),
    generatedVendorTopOneViolations: results.filter((item) => item.generatedVendorTopOne).map((item) => item.id)
  },
  perLanguage: groupedMetrics(results, (item) => item.language),
  perScenario: groupedMetrics(results, (item) => item.scenario),
  missesAt64: results.filter((item) => !item.rankedFullRecallAt64).map((item) => ({
    id: item.id,
    missing: item.missingAt64,
    requiredFileRanks: item.requiredFileRanks
  })),
  missesAt128: results.filter((item) => !item.rankedFullRecallAt128).map((item) => ({
    id: item.id,
    missing: item.missingAt128,
    requiredFileRanks: item.requiredFileRanks
  })),
  cases: results
};

fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
fs.writeFileSync(options.outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function validateInputs(
  manifest: Record<string, unknown>,
  report: Record<string, unknown>,
  split: "calibration" | "holdout"
): void {
  if (
    manifest.schemaVersion !== "ranker-corpus.v1" ||
    manifest.sealed !== false ||
    manifest.status !== "draft_for_label_review"
  ) {
    throw new Error("Probe ranker evaluation requires an explicitly unsealed draft corpus.");
  }
  if (manifest.featureSchemaVersion !== model.featureSchemaVersion) {
    throw new Error("Probe corpus feature schema does not match the model.");
  }
  if (report.schemaVersion !== "ranker-corpus-materialization-report.v1") {
    throw new Error("Probe ranker evaluation requires a materialization report.");
  }
  const materializer = record(manifest.materializer, "manifest.materializer");
  if (
    report.kairnCommit !== materializer.kairnCommit ||
    report.intakeSha256 !== materializer.intakeSha256
  ) {
    throw new Error("Probe report provenance does not match the draft manifest.");
  }
  const reportCaseCount = array(report.cases, "report.cases").length;
  const manifestCases = array(manifest.cases, "manifest.cases");
  if (manifestCases.length !== reportCaseCount) {
    throw new Error("Probe manifest/report case counts differ.");
  }
  if (
    split === "calibration" &&
    manifestCases.some((value, index) =>
      record(value, `manifest.cases[${index}]`).split === "holdout"
    )
  ) {
    throw new Error("Calibration diagnostics refuse manifests containing holdout cases.");
  }
}

function groupedMetrics(
  rows: CaseResult[],
  key: (item: CaseResult) => string
): Record<string, { cases: number; fullRecallAt64: number; fullRecallAt128: number }> {
  const groups = new Map<string, CaseResult[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([name, items]) => [
    name,
    {
      cases: items.length,
      fullRecallAt64: fraction(items, (item) => item.rankedFullRecallAt64),
      fullRecallAt128: fraction(items, (item) => item.rankedFullRecallAt128)
    }
  ]));
}

function requiredFileRecall(rows: CaseResult[], limit: number): number {
  let hits = 0;
  let total = 0;
  for (const row of rows) {
    for (const rank of Object.values(row.requiredFileRanks)) {
      hits += rank !== null && rank <= limit ? 1 : 0;
      total += 1;
    }
  }
  return ratio(hits, total);
}

function requiredFileMrr(rows: CaseResult[]): number {
  const ranks = rows.flatMap((item) => Object.values(item.requiredFileRanks));
  return round(ranks.reduce((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / Math.max(1, ranks.length));
}

function fraction(rows: CaseResult[], predicate: (item: CaseResult) => boolean): number {
  return ratio(rows.filter(predicate).length, rows.length);
}

function expectedCalibrationError(
  samples: Array<{ probability: number; label: 0 | 1 }>,
  bins = 10
): number {
  if (samples.length === 0) return 0;
  let error = 0;
  for (let index = 0; index < bins; index += 1) {
    const lower = index / bins;
    const upper = (index + 1) / bins;
    const members = samples.filter((item) =>
      (item.probability >= lower && item.probability < upper) ||
      (index === bins - 1 && item.probability === 1)
    );
    if (members.length === 0) continue;
    const accuracy = members.reduce((sum, item) => sum + item.label, 0) / members.length;
    const confidence = members.reduce((sum, item) => sum + item.probability, 0) / members.length;
    error += members.length / samples.length * Math.abs(accuracy - confidence);
  }
  return round(error);
}

function evidenceFeatures(value: Record<string, unknown>, label: string): EvidenceFeatureVector {
  const features = {} as EvidenceFeatureVector;
  for (const feature of EVIDENCE_FEATURE_NAMES) {
    const item = finite(value[feature], `${label}.${feature}`);
    if (item < 0 || item > 1) throw new Error(`${label}.${feature} must be between zero and one`);
    features[feature] = item;
  }
  return features;
}

function inputDigest(target: string, bytes: Buffer): { path: string; sha256: string } {
  return {
    path: path.relative(process.cwd(), target).replace(/\\/g, "/"),
    sha256: sha256(bytes)
  };
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  const normalizedArgs = args.filter((value) => value !== "--");
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid probe ranker argument near ${key ?? "<end>"}.`);
    }
    values.set(key, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return path.resolve(value);
  };
  const split = values.get("--split") ?? "holdout";
  if (split !== "calibration" && split !== "holdout") {
    throw new Error("--split must be calibration or holdout");
  }
  return {
    modelPath: required("--model"),
    trainingRowsPath: required("--training-rows"),
    manifestPath: required("--manifest"),
    reportPath: required("--report"),
    outPath: required("--out"),
    split
  };
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  const items = array(value, label);
  if (items.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  return [...items] as string[];
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return round(numerator / Math.max(1, denominator));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
  throw new Error("Probe ranker diagnostic script must be executed directly.");
}
