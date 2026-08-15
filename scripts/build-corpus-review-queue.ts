// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CorpusReviewQueueOptions = {
  intakePath: string;
  manifestPath: string;
  reportPath: string;
  outPath: string;
};

export function buildCorpusReviewQueue(options: CorpusReviewQueueOptions): Record<string, unknown> {
  const intakePath = path.resolve(options.intakePath);
  const manifestPath = path.resolve(options.manifestPath);
  const reportPath = path.resolve(options.reportPath);
  const intake = record(JSON.parse(fs.readFileSync(intakePath, "utf8")), "intake");
  const manifest = record(JSON.parse(fs.readFileSync(manifestPath, "utf8")), "manifest");
  const report = record(JSON.parse(fs.readFileSync(reportPath, "utf8")), "report");
  if (intake.schemaVersion !== "ranker-corpus-intake.v1") throw new Error("intake schemaVersion mismatch");
  if (manifest.schemaVersion !== "ranker-corpus.v1" || manifest.sealed !== false) throw new Error("manifest must be an unsealed ranker-corpus.v1 draft");
  if (report.schemaVersion !== "ranker-corpus-materialization-report.v1") throw new Error("report schemaVersion mismatch");
  if (intake.corpusId !== manifest.corpusId || intake.corpusId !== report.corpusId) throw new Error("corpusId mismatch");
  const intakeSha256 = sha256(fs.readFileSync(intakePath));
  const materializer = record(manifest.materializer, "manifest.materializer");
  if (materializer.intakeSha256 !== intakeSha256 || report.intakeSha256 !== intakeSha256) {
    throw new Error("draft artifacts are not bound to this intake hash");
  }

  const intakeCases = array(intake.cases, "intake.cases");
  const intakeCasesById = byId(intakeCases, "intake.cases");
  const manifestCases = byId(manifest.cases, "manifest.cases");
  const reportCases = byId(report.cases, "report.cases");
  const partial = report.partial === true;
  const selectedCaseIds = partial
    ? stringArray(report.selectedCaseIds, "report.selectedCaseIds")
    : [...intakeCasesById.keys()];
  if (new Set(selectedCaseIds).size !== selectedCaseIds.length) {
    throw new Error("report selectedCaseIds must be unique");
  }
  const selectedCaseIdSet = new Set(selectedCaseIds);
  const missingIntakeCases = selectedCaseIds.filter((id) => !intakeCasesById.has(id));
  const missingManifestCases = selectedCaseIds.filter((id) => !manifestCases.has(id));
  const missingReportCases = selectedCaseIds.filter((id) => !reportCases.has(id));
  const unexpectedManifestCases = [...manifestCases.keys()].filter((id) => !selectedCaseIdSet.has(id));
  const unexpectedReportCases = [...reportCases.keys()].filter((id) => !selectedCaseIdSet.has(id));
  if (
    missingIntakeCases.length > 0 ||
    missingManifestCases.length > 0 ||
    missingReportCases.length > 0 ||
    unexpectedManifestCases.length > 0 ||
    unexpectedReportCases.length > 0
  ) {
    throw new Error(
      "selected intake, manifest, and report case sets must match exactly; " +
      `missingIntake=${missingIntakeCases.join(",") || "none"} ` +
      `missingManifest=${missingManifestCases.join(",") || "none"} ` +
      `missingReport=${missingReportCases.join(",") || "none"} ` +
      `unexpectedManifest=${unexpectedManifestCases.join(",") || "none"} ` +
      `unexpectedReport=${unexpectedReportCases.join(",") || "none"}`
    );
  }
  const selectedIntakeCases = intakeCases.filter((value, index) => {
    const item = record(value, `intake.cases[${index}]`);
    return selectedCaseIdSet.has(string(item.id, `intake.cases[${index}].id`));
  });
  const rows = selectedIntakeCases.map((value, index) => {
    const item = record(value, `intake.cases[${index}]`);
    const id = string(item.id, `intake.cases[${index}].id`);
    const materialized = requiredCase(manifestCases, id, "manifest");
    const observed = requiredCase(reportCases, id, "report");
    const candidates = array(observed.candidates, `${id}.candidates`).map((candidate, candidateIndex) => {
      const row = record(candidate, `${id}.candidates[${candidateIndex}]`);
      return {
        path: string(row.path, `${id}.candidates[${candidateIndex}].path`),
        reasons: array(row.reasons, `${id}.candidates[${candidateIndex}].reasons`).map(String)
      };
    });
    const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
    const requiredSources = stringArray(item.requiredSourceFiles, `${id}.requiredSourceFiles`);
    const requiredSourceCreationFiles = stringArray(
      observed.requiredSourceCreationFiles,
      `${id}.requiredSourceCreationFiles`
    );
    const officialPatchSources = stringArray(item.officialPatchSourceFiles, `${id}.officialPatchSourceFiles`);
    const explicitNoise = stringArray(item.explicitNoiseFiles, `${id}.explicitNoiseFiles`);
    const patchSourcesPresent = officialPatchSources.filter((filePath) => candidatePaths.has(filePath));
    const requiredSourcesPresent = requiredSources.filter((filePath) => candidatePaths.has(filePath));
    const explicitNoisePresent = explicitNoise.filter((filePath) => candidatePaths.has(filePath));
    const explicitNoiseMissing = explicitNoise.filter((filePath) => !candidatePaths.has(filePath));
    const split = string(item.split, `${id}.split`);
    const needsRequiredSourceReview = split === "holdout" || (requiredSources.length === 0 && patchSourcesPresent.length === 0);
    const needsNoiseReview = explicitNoisePresent.length < 6;
    return {
      id,
      split,
      language: item.language,
      scenario: item.scenario,
      repositoryLineageId: item.repositoryLineageId,
      repositoryRef: item.repositoryRef,
      publicSourceUrl: item.publicSourceUrl,
      prompt: item.prompt,
      candidatePathsSha256: observed.candidatePathsSha256,
      candidateCount: candidates.length,
      requiredSourceFiles: requiredSources,
      requiredSourceFilesPresent: requiredSourcesPresent,
      requiredSourceCreationFiles,
      officialPatchSourceFiles: officialPatchSources,
      officialPatchSourceFilesPresent: patchSourcesPresent,
      officialPatchSourceFilesMissing: officialPatchSources.filter((filePath) => !candidatePaths.has(filePath)),
      explicitNoiseFiles: explicitNoise,
      explicitNoiseFilesPresent: explicitNoisePresent,
      explicitNoiseFilesMissing: explicitNoiseMissing,
      needsRequiredSourceReview,
      needsNoiseReview,
      reviewStatus: needsRequiredSourceReview || needsNoiseReview ? "needs_review" : "ready_for_seal",
      decision: {
        requiredSourceFiles: requiredSources,
        explicitNoiseFiles: explicitNoisePresent,
        reviewer: null,
        reviewedAt: null,
        notes: null
      },
      candidates,
      materializedCaseSha256: sha256(JSON.stringify(materialized))
    };
  });
  return {
    schemaVersion: "ranker-corpus-review-queue.v1",
    corpusId: intake.corpusId,
    intakeSha256,
    materializerCommit: materializer.kairnCommit,
    manifestSha256: sha256(fs.readFileSync(manifestPath)),
    reportSha256: sha256(fs.readFileSync(reportPath)),
    caseCount: rows.length,
    selection: {
      partial,
      sourceCaseCount: intakeCases.length,
      selectedCaseCount: rows.length,
      selectedCaseIdsSha256: sha256([...selectedCaseIds].sort().join("\n"))
    },
    requiredSourceReviewCases: rows.filter((row) => row.needsRequiredSourceReview).length,
    explicitNoiseReviewCases: rows.filter((row) => row.needsNoiseReview).length,
    readyForSealCases: rows.filter((row) => row.reviewStatus === "ready_for_seal").length,
    policy: {
      holdoutRequiredSourceOracleMandatory: true,
      minimumExplicitNoiseFiles: 6,
      staleExplicitNoiseLabelsAreNotCarriedForward: true,
      decisionsAreNeverAutoFilled: true
    },
    cases: rows
  };
}

function byId(value: unknown, label: string): Map<string, Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  array(value, label).forEach((item, index) => {
    const row = record(item, `${label}[${index}]`);
    const id = string(row.id, `${label}[${index}].id`);
    if (output.has(id)) throw new Error(`${label} contains duplicate id '${id}'`);
    output.set(id, row);
  });
  return output;
}

function requiredCase(values: Map<string, Record<string, unknown>>, id: string, label: string): Record<string, unknown> {
  const value = values.get(id);
  if (!value) throw new Error(`${label} is missing case '${id}'`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): CorpusReviewQueueOptions {
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
    intakePath: required("--intake"),
    manifestPath: required("--manifest"),
    reportPath: required("--report"),
    outPath: required("--out")
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const queue = buildCorpusReviewQueue(options);
    const target = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      out: target,
      caseCount: queue.caseCount,
      requiredSourceReviewCases: queue.requiredSourceReviewCases,
      explicitNoiseReviewCases: queue.explicitNoiseReviewCases,
      readyForSealCases: queue.readyForSealCases
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
