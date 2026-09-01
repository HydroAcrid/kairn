// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_FEATURE_NAMES } from "../src/types/evidence.js";

type Options = {
  manifestPath: string;
  reportPath: string;
  outPath: string;
  summaryPath: string;
  baseRowsPath?: string;
  priorBaseRowsPath?: string;
  priorReviewedRowsPath?: string;
  dropZeroPositiveSynthetic: boolean;
};

const options = parseArgs(process.argv.slice(2));
const manifestBytes = fs.readFileSync(options.manifestPath);
const reportBytes = fs.readFileSync(options.reportPath);
const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "manifest");
const report = record(JSON.parse(reportBytes.toString("utf8")), "report");

if (
  manifest.schemaVersion !== "ranker-corpus.v1" ||
  manifest.sealed !== false ||
  manifest.status !== "draft_for_label_review"
) {
  throw new Error("Probe diagnostics require an explicitly unsealed draft corpus manifest.");
}
if (report.schemaVersion !== "ranker-corpus-materialization-report.v1") {
  throw new Error("Probe diagnostics require a ranker materialization report.");
}
if (manifest.featureSchemaVersion !== "evidence-features-v4") {
  throw new Error("Probe diagnostics require evidence-features-v4.");
}
const materializer = record(manifest.materializer, "manifest.materializer");
if (
  report.kairnCommit !== materializer.kairnCommit ||
  report.intakeSha256 !== materializer.intakeSha256
) {
  throw new Error("Probe report provenance does not match the draft manifest.");
}

const manifestCases = array(manifest.cases, "manifest.cases");
const reportCases = new Map(
  array(report.cases, "report.cases").map((value, index) => {
    const item = record(value, `report.cases[${index}]`);
    return [string(item.id, `report.cases[${index}].id`), item] as const;
  })
);
if (manifestCases.length !== reportCases.size) {
  throw new Error("Probe manifest/report case counts differ.");
}

const baseRowsBytes = options.baseRowsPath ? fs.readFileSync(options.baseRowsPath) : undefined;
const baseRows = baseRowsBytes ? parseBaseRows(baseRowsBytes) : [];
const priorBaseRowsBytes = options.priorBaseRowsPath
  ? fs.readFileSync(options.priorBaseRowsPath)
  : undefined;
const priorReviewedRowsBytes = options.priorReviewedRowsPath
  ? fs.readFileSync(options.priorReviewedRowsPath)
  : undefined;
if (Boolean(priorBaseRowsBytes) !== Boolean(priorReviewedRowsBytes)) {
  throw new Error("--prior-base-rows and --prior-reviewed-rows must be supplied together");
}
const carriedNegativeLabels = priorBaseRowsBytes && priorReviewedRowsBytes
  ? reviewedNegativeDelta(
      parseBaseRows(priorBaseRowsBytes),
      parseBaseRows(priorReviewedRowsBytes)
    )
  : new Map<string, Record<string, unknown>>();
const usedCarriedNegativeLabels = new Set<string>();
const rows: Record<string, unknown>[] = [...baseRows];
const baseCaseIds = new Set(baseRows.map((row) => string(row.caseGroupId, "base row caseGroupId")));
const splitCounts = new Map<string, number>();
const labelCounts = new Map<string, number>();
const probeCounts: number[] = [];
const candidateSourceCounts = new Map<string, number>();
const excludedSyntheticCases: string[] = [];
let expandedProbeCases = 0;
let retainedCaseCount = 0;
for (let caseIndex = 0; caseIndex < manifestCases.length; caseIndex += 1) {
  const corpusCase = record(manifestCases[caseIndex], `manifest.cases[${caseIndex}]`);
  const caseId = string(corpusCase.id, `manifest.cases[${caseIndex}].id`);
  const reportCase = reportCases.get(caseId);
  if (!reportCase) throw new Error(`${caseId}: missing from probe report`);
  const hasProbeCandidates = Array.isArray(reportCase.probeCandidates);
  const diagnosticCandidates = hasProbeCandidates
    ? array(reportCase.probeCandidates, `${caseId}.probeCandidates`)
    : array(corpusCase.trainingCandidates, `${caseId}.trainingCandidates`);
  const candidateSource = hasProbeCandidates ? "expanded_probe" : "training_candidates";
  if (hasProbeCandidates) {
    const probeLimit = integer(reportCase.probeLimit, `${caseId}.probeLimit`);
    if (probeLimit <= 128 || probeLimit > 512) {
      throw new Error(`${caseId}: probeLimit must be between 129 and 512`);
    }
    if (diagnosticCandidates.length === 0 || diagnosticCandidates.length > probeLimit) {
      throw new Error(`${caseId}: probe candidate count must be positive and at most probeLimit`);
    }
  } else if (diagnosticCandidates.length === 0 || diagnosticCandidates.length > 128) {
    throw new Error(`${caseId}: training candidate count must be positive and at most 128`);
  }
  const split = string(corpusCase.split, `${caseId}.split`);
  const caseRows: Record<string, unknown>[] = [];
  for (let candidateIndex = 0; candidateIndex < diagnosticCandidates.length; candidateIndex += 1) {
    const candidate = record(
      diagnosticCandidates[candidateIndex],
      `${caseId}.${candidateSource}[${candidateIndex}]`
    );
    const candidatePath = string(candidate.path, `${caseId}.candidatePath`);
    const carryIdentity = `${caseId}\0${candidatePath}`;
    const carriedNegative = carriedNegativeLabels.get(carryIdentity);
    if (
      carriedNegative &&
      candidate.label === 1
    ) {
      throw new Error(`${caseId}:${candidatePath}: reviewed negative conflicts with a positive label`);
    }
    const label = candidate.label === 0 || candidate.label === 1
      ? candidate.label
      : carriedNegative
        ? 0
        : undefined;
    if (label === undefined) continue;
    const provenance = carriedNegative && candidate.label !== 0
      ? "explicit_noise_or_excluded"
      : string(
          candidate.labelProvenance,
          `${caseId}.probeCandidates[${candidateIndex}].labelProvenance`
        );
    if (carriedNegative) {
      if (split !== "train") {
        throw new Error(`${caseId}:${candidatePath}: reviewed negatives are training-only`);
      }
      const priorLineage = string(carriedNegative.repositoryLineageId, "reviewed negative lineage");
      const currentLineage = string(corpusCase.repositoryLineageId, `${caseId}.repositoryLineageId`);
      if (priorLineage !== currentLineage) {
        throw new Error(`${caseId}:${candidatePath}: reviewed negative lineage changed`);
      }
      usedCarriedNegativeLabels.add(carryIdentity);
    }
    const features = record(
      candidate.features,
      `${caseId}.probeCandidates[${candidateIndex}].features`
    );
    caseRows.push({
      featureSchemaVersion: "evidence-features-v4",
      repositoryLineageId: string(corpusCase.repositoryLineageId, `${caseId}.repositoryLineageId`),
      caseGroupId: caseId,
      split,
      language: string(corpusCase.language, `${caseId}.language`),
      scenario: string(corpusCase.scenario, `${caseId}.scenario`),
      candidatePath,
      isPublic: true,
      publicSourceUrl: string(corpusCase.publicSourceUrl, `${caseId}.publicSourceUrl`),
      dataOrigin: string(corpusCase.dataOrigin, `${caseId}.dataOrigin`),
      label,
      labelWeight: carriedNegative && candidate.label !== 0
        ? 1
        : finite(candidate.labelWeight, `${caseId}.labelWeight`),
      labelProvenance: provenance,
      features: EVIDENCE_FEATURE_NAMES.map((feature) =>
        finite(features[feature], `${caseId}.features.${feature}`)
      ),
      diagnosticProbe: true
    });
  }
  if (
    options.dropZeroPositiveSynthetic &&
    corpusCase.dataOrigin === "synthetic" &&
    !caseRows.some((row) => row.label === 1)
  ) {
    excludedSyntheticCases.push(caseId);
    continue;
  }
  if (baseCaseIds.has(caseId)) throw new Error(`${caseId}: base rows already contain this case group.`);
  if (diagnosticCandidates.length > 128) expandedProbeCases += 1;
  probeCounts.push(diagnosticCandidates.length);
  candidateSourceCounts.set(candidateSource, (candidateSourceCounts.get(candidateSource) ?? 0) + 1);
  splitCounts.set(split, (splitCounts.get(split) ?? 0) + 1);
  retainedCaseCount += 1;
  rows.push(...caseRows);
}
if (rows.length === 0) throw new Error("Probe diagnostic contains no labeled rows.");
for (const [index, row] of rows.entries()) {
  const provenance = string(row.labelProvenance, `rows[${index}].labelProvenance`);
  labelCounts.set(provenance, (labelCounts.get(provenance) ?? 0) + 1);
}

fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
fs.writeFileSync(
  options.outPath,
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  "utf8"
);
const summary = {
  schemaVersion: "ranker-probe-diagnostic.v1",
  promotionEligible: false,
  reason: "Raw candidate rows are diagnostic-only and do not satisfy the sealed 165-case corpus contract.",
  kairnCommit: materializer.kairnCommit,
  manifest: {
    path: path.relative(process.cwd(), options.manifestPath).replace(/\\/g, "/"),
    sha256: sha256(manifestBytes)
  },
  report: {
    path: path.relative(process.cwd(), options.reportPath).replace(/\\/g, "/"),
    sha256: sha256(reportBytes)
  },
  output: {
    path: path.relative(process.cwd(), options.outPath).replace(/\\/g, "/"),
    sha256: sha256(fs.readFileSync(options.outPath))
  },
  inputCaseCount: manifestCases.length,
  caseCount: retainedCaseCount,
  excludedSyntheticCases,
  baseRows: options.baseRowsPath && baseRowsBytes ? {
    path: path.relative(process.cwd(), options.baseRowsPath).replace(/\\/g, "/"),
    sha256: sha256(baseRowsBytes),
    rowCount: baseRows.length,
    caseCount: baseCaseIds.size
  } : undefined,
  carriedReviewedNegatives: priorBaseRowsBytes && priorReviewedRowsBytes ? {
    priorBaseRows: {
      path: path.relative(process.cwd(), options.priorBaseRowsPath!).replace(/\\/g, "/"),
      sha256: sha256(priorBaseRowsBytes)
    },
    priorReviewedRows: {
      path: path.relative(process.cwd(), options.priorReviewedRowsPath!).replace(/\\/g, "/"),
      sha256: sha256(priorReviewedRowsBytes)
    },
    discovered: carriedNegativeLabels.size,
    applied: usedCarriedNegativeLabels.size,
    unavailable: [...carriedNegativeLabels.keys()]
      .filter((identity) => !usedCarriedNegativeLabels.has(identity))
      .map((identity) => {
        const [caseId, candidatePath] = identity.split("\0");
        return { caseId, candidatePath };
      })
  } : undefined,
  labeledRowCount: rows.length,
  splitCaseCounts: Object.fromEntries([...splitCounts].sort()),
  labelProvenanceCounts: Object.fromEntries([...labelCounts].sort()),
  candidateSourceCounts: Object.fromEntries([...candidateSourceCounts].sort()),
  probeCandidateCounts: {
    minimum: Math.min(...probeCounts),
    maximum: Math.max(...probeCounts),
    expandedCases: expandedProbeCases
  }
};
fs.writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  const normalizedArgs = args.filter((value) => value !== "--");
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid probe diagnostic argument near ${key ?? "<end>"}.`);
    }
    values.set(key, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return path.resolve(value);
  };
  return {
    manifestPath: required("--manifest"),
    reportPath: required("--report"),
    outPath: required("--out"),
    summaryPath: required("--summary-out"),
    ...(values.get("--base-rows") ? { baseRowsPath: path.resolve(values.get("--base-rows")!) } : {}),
    ...(values.get("--prior-base-rows")
      ? { priorBaseRowsPath: path.resolve(values.get("--prior-base-rows")!) }
      : {}),
    ...(values.get("--prior-reviewed-rows")
      ? { priorReviewedRowsPath: path.resolve(values.get("--prior-reviewed-rows")!) }
      : {}),
    dropZeroPositiveSynthetic: values.get("--drop-zero-positive-synthetic") === "true"
  };
}

function reviewedNegativeDelta(
  priorBaseRows: Record<string, unknown>[],
  priorReviewedRows: Record<string, unknown>[]
): Map<string, Record<string, unknown>> {
  const baseIdentities = new Set(priorBaseRows.map((row) => [
    string(row.caseGroupId, "prior base caseGroupId"),
    string(row.candidatePath, "prior base candidatePath")
  ].join("\0")));
  const delta = new Map<string, Record<string, unknown>>();
  for (const row of priorReviewedRows) {
    const identity = [
      string(row.caseGroupId, "prior reviewed caseGroupId"),
      string(row.candidatePath, "prior reviewed candidatePath")
    ].join("\0");
    if (baseIdentities.has(identity)) continue;
    if (
      row.label !== 0 ||
      row.labelWeight !== 1 ||
      row.labelProvenance !== "explicit_noise_or_excluded" ||
      row.split !== "train"
    ) {
      throw new Error(`${identity.replace("\0", ":")}: carried review is not a training negative`);
    }
    if (delta.has(identity)) throw new Error(`duplicate carried review ${identity.replace("\0", ":")}`);
    delta.set(identity, row);
  }
  if (delta.size === 0) throw new Error("prior reviewed rows contain no added training negatives");
  return delta;
}

function parseBaseRows(bytes: Buffer): Record<string, unknown>[] {
  const rows = bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line, index) =>
    record(JSON.parse(line), `base rows[${index}]`)
  );
  const identities = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.featureSchemaVersion !== "evidence-features-v4") {
      throw new Error(`base rows[${index}] has an incompatible feature schema.`);
    }
    const split = string(row.split, `base rows[${index}].split`);
    if (split !== "train" && split !== "calibration") {
      throw new Error(`base rows[${index}] must be train or calibration.`);
    }
    if (row.isPublic !== true) throw new Error(`base rows[${index}] must declare isPublic=true.`);
    const identity = [
      string(row.caseGroupId, `base rows[${index}].caseGroupId`),
      string(row.candidatePath, `base rows[${index}].candidatePath`)
    ].join("\0");
    if (identities.has(identity)) throw new Error(`base rows contain duplicate candidate identity ${identity}.`);
    identities.add(identity);
  }
  return rows;
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

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) {
  throw new Error("Probe diagnostic script must be executed directly.");
}
