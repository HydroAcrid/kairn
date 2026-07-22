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

  const manifestCases = byId(manifest.cases, "manifest.cases");
  const reportCases = byId(report.cases, "report.cases");
  const rows = array(intake.cases, "intake.cases").map((value, index) => {
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
    const officialPatchSources = stringArray(item.officialPatchSourceFiles, `${id}.officialPatchSourceFiles`);
    const explicitNoise = stringArray(item.explicitNoiseFiles, `${id}.explicitNoiseFiles`);
    const patchSourcesPresent = officialPatchSources.filter((filePath) => candidatePaths.has(filePath));
    const requiredSourcesPresent = requiredSources.filter((filePath) => candidatePaths.has(filePath));
    const split = string(item.split, `${id}.split`);
    const needsRequiredSourceReview = split === "holdout" || (requiredSources.length === 0 && patchSourcesPresent.length === 0);
    const needsNoiseReview = explicitNoise.length < 6;
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
      officialPatchSourceFiles: officialPatchSources,
      officialPatchSourceFilesPresent: patchSourcesPresent,
      officialPatchSourceFilesMissing: officialPatchSources.filter((filePath) => !candidatePaths.has(filePath)),
      explicitNoiseFiles: explicitNoise,
      needsRequiredSourceReview,
      needsNoiseReview,
      reviewStatus: needsRequiredSourceReview || needsNoiseReview ? "needs_review" : "ready_for_seal",
      decision: {
        requiredSourceFiles: requiredSources,
        explicitNoiseFiles: explicitNoise,
        reviewer: null,
        reviewedAt: null,
        notes: null
      },
      candidates,
      materializedCaseSha256: sha256(JSON.stringify(materialized))
    };
  });
  if (manifestCases.size !== rows.length || reportCases.size !== rows.length) {
    throw new Error("intake, manifest, and report case sets must match exactly");
  }
  return {
    schemaVersion: "ranker-corpus-review-queue.v1",
    corpusId: intake.corpusId,
    intakeSha256,
    materializerCommit: materializer.kairnCommit,
    manifestSha256: sha256(fs.readFileSync(manifestPath)),
    reportSha256: sha256(fs.readFileSync(reportPath)),
    caseCount: rows.length,
    requiredSourceReviewCases: rows.filter((row) => row.needsRequiredSourceReview).length,
    explicitNoiseReviewCases: rows.filter((row) => row.needsNoiseReview).length,
    readyForSealCases: rows.filter((row) => row.reviewStatus === "ready_for_seal").length,
    policy: {
      holdoutRequiredSourceOracleMandatory: true,
      minimumExplicitNoiseFiles: 6,
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

