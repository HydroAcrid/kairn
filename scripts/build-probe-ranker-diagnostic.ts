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
if (manifest.featureSchemaVersion !== "evidence-features-v5") {
  throw new Error("Probe diagnostics require evidence-features-v5.");
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

const rows: Record<string, unknown>[] = [];
const splitCounts = new Map<string, number>();
const labelCounts = new Map<string, number>();
const probeCounts: number[] = [];
let expandedProbeCases = 0;
for (let caseIndex = 0; caseIndex < manifestCases.length; caseIndex += 1) {
  const corpusCase = record(manifestCases[caseIndex], `manifest.cases[${caseIndex}]`);
  const caseId = string(corpusCase.id, `manifest.cases[${caseIndex}].id`);
  const reportCase = reportCases.get(caseId);
  if (!reportCase) throw new Error(`${caseId}: missing from probe report`);
  const probeLimit = integer(reportCase.probeLimit, `${caseId}.probeLimit`);
  if (probeLimit <= 128 || probeLimit > 512) {
    throw new Error(`${caseId}: probeLimit must be between 129 and 512`);
  }
  const probeCandidates = array(reportCase.probeCandidates, `${caseId}.probeCandidates`);
  if (probeCandidates.length === 0 || probeCandidates.length > probeLimit) {
    throw new Error(`${caseId}: probe candidate count must be positive and at most probeLimit`);
  }
  if (probeCandidates.length > 128) expandedProbeCases += 1;
  probeCounts.push(probeCandidates.length);
  const split = string(corpusCase.split, `${caseId}.split`);
  splitCounts.set(split, (splitCounts.get(split) ?? 0) + 1);
  for (let candidateIndex = 0; candidateIndex < probeCandidates.length; candidateIndex += 1) {
    const candidate = record(
      probeCandidates[candidateIndex],
      `${caseId}.probeCandidates[${candidateIndex}]`
    );
    if (candidate.label !== 0 && candidate.label !== 1) continue;
    const provenance = string(
      candidate.labelProvenance,
      `${caseId}.probeCandidates[${candidateIndex}].labelProvenance`
    );
    labelCounts.set(provenance, (labelCounts.get(provenance) ?? 0) + 1);
    const features = record(
      candidate.features,
      `${caseId}.probeCandidates[${candidateIndex}].features`
    );
    rows.push({
      featureSchemaVersion: "evidence-features-v5",
      repositoryLineageId: string(corpusCase.repositoryLineageId, `${caseId}.repositoryLineageId`),
      caseGroupId: caseId,
      split,
      language: string(corpusCase.language, `${caseId}.language`),
      scenario: string(corpusCase.scenario, `${caseId}.scenario`),
      candidatePath: string(candidate.path, `${caseId}.candidatePath`),
      isPublic: true,
      publicSourceUrl: string(corpusCase.publicSourceUrl, `${caseId}.publicSourceUrl`),
      dataOrigin: string(corpusCase.dataOrigin, `${caseId}.dataOrigin`),
      label: candidate.label,
      labelWeight: finite(candidate.labelWeight, `${caseId}.labelWeight`),
      labelProvenance: provenance,
      features: EVIDENCE_FEATURE_NAMES.map((feature) =>
        finite(features[feature], `${caseId}.features.${feature}`)
      ),
      diagnosticProbe: true
    });
  }
}
if (rows.length === 0) throw new Error("Probe diagnostic contains no labeled rows.");
if (expandedProbeCases === 0) {
  throw new Error("Probe diagnostic must contain at least one case expanded beyond 128 candidates.");
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
  reason: "Raw probe rows are diagnostic-only and do not satisfy the sealed 165-case corpus contract.",
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
  caseCount: manifestCases.length,
  labeledRowCount: rows.length,
  splitCaseCounts: Object.fromEntries([...splitCounts].sort()),
  labelProvenanceCounts: Object.fromEntries([...labelCounts].sort()),
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
    summaryPath: required("--summary-out")
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
