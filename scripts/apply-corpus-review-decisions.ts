// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ApplyCorpusReviewDecisionsOptions = {
  intakePath: string;
  manifestPath: string;
  reportPath: string;
  reviewQueuePath: string;
  outPath: string;
  registryOutPath?: string;
  summaryOutPath: string;
  allowPartial?: boolean;
};

type ReviewDecision = {
  requiredSourceFiles: string[];
  explicitNoiseFiles: string[];
  reviewer: string;
  reviewedAt: string;
  notes: string | null;
};

export function applyCorpusReviewDecisions(options: ApplyCorpusReviewDecisionsOptions): Record<string, unknown> {
  const intakePath = path.resolve(options.intakePath);
  const manifestPath = path.resolve(options.manifestPath);
  const reportPath = path.resolve(options.reportPath);
  const reviewQueuePath = path.resolve(options.reviewQueuePath);
  const outPath = path.resolve(options.outPath);
  const summaryOutPath = path.resolve(options.summaryOutPath);
  const sourcePaths = new Set([intakePath, manifestPath, reportPath, reviewQueuePath]);
  if (sourcePaths.has(outPath) || sourcePaths.has(summaryOutPath)) {
    throw new Error("review outputs must not overwrite source artifacts");
  }
  if (outPath === summaryOutPath) throw new Error("--out and --summary-out must be different files");

  const intakeBytes = fs.readFileSync(intakePath);
  const manifestBytes = fs.readFileSync(manifestPath);
  const reportBytes = fs.readFileSync(reportPath);
  const queueBytes = fs.readFileSync(reviewQueuePath);
  const intake = record(JSON.parse(intakeBytes.toString("utf8")), "intake");
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "manifest");
  const report = record(JSON.parse(reportBytes.toString("utf8")), "report");
  const queue = record(JSON.parse(queueBytes.toString("utf8")), "review queue");

  validateRoots(intake, manifest, report, queue, {
    intakeSha256: sha256(intakeBytes),
    manifestSha256: sha256(manifestBytes),
    reportSha256: sha256(reportBytes)
  }, options.allowPartial === true);

  const intakeCases = byId(intake.cases, "intake.cases");
  const manifestCases = byId(manifest.cases, "manifest.cases");
  const reportCases = byId(report.cases, "report.cases");
  const queueCases = byId(queue.cases, "review queue.cases");
  const partial = report.partial === true;
  const selectedCaseIds = partial
    ? stringArray(report.selectedCaseIds, "report.selectedCaseIds")
    : [...intakeCases.keys()];
  requireUnique(selectedCaseIds, "report.selectedCaseIds");
  const selectedCaseIdSet = new Set(selectedCaseIds);
  if ([manifestCases, reportCases, queueCases].some((rows) => rows.size !== selectedCaseIdSet.size)) {
    throw new Error("selected intake, manifest, report, and review queue case sets must match exactly");
  }
  for (const id of selectedCaseIds) {
    if (!intakeCases.has(id)) throw new Error(`selected review case '${id}' is absent from the intake`);
    if (!manifestCases.has(id) || !reportCases.has(id) || !queueCases.has(id)) {
      throw new Error(`review artifacts are missing case '${id}'`);
    }
  }
  for (const rows of [manifestCases, reportCases, queueCases]) {
    const unexpected = [...rows.keys()].filter((id) => !selectedCaseIdSet.has(id));
    if (unexpected.length > 0) throw new Error(`review artifacts contain unselected case '${unexpected[0]}'`);
  }
  validateSelection(queue, partial, intakeCases.size, selectedCaseIds);

  const reviewedCases: Array<Record<string, unknown>> = array(intake.cases, "intake.cases").map((value, index) => {
    const intakeCase = record(value, `intake.cases[${index}]`);
    const id = nonEmptyString(intakeCase.id, `intake.cases[${index}].id`);
    if (!selectedCaseIdSet.has(id)) return intakeCase;
    const manifestCase = manifestCases.get(id)!;
    const reportCase = reportCases.get(id)!;
    const queueCase = queueCases.get(id)!;
    validateCaseBindings(id, manifestCase, reportCase, queueCase);

    const candidatePaths = candidatePathSet(reportCase, id);
    const decision = parseDecision(queueCase.decision, id);
    const originalRequiredSources = pathArray(intakeCase.requiredSourceFiles, `${id}.originalRequiredSourceFiles`);
    const officialPatchSources = pathArray(intakeCase.officialPatchSourceFiles, `${id}.officialPatchSourceFiles`);
    const observedSources = pathArray(intakeCase.verifiedObservedReadTouchFiles, `${id}.verifiedObservedReadTouchFiles`);
    const reviewedSourcePaths = new Set([
      ...candidatePaths,
      ...originalRequiredSources,
      ...officialPatchSources,
      ...observedSources
    ]);
    const requiredSourceFiles = decision.requiredSourceFiles.map((filePath) =>
      approvedRequiredSource(filePath, reviewedSourcePaths, `${id}.requiredSourceFiles`)
    );
    const explicitNoiseFiles = decision.explicitNoiseFiles.map((filePath) =>
      approvedCandidate(filePath, candidatePaths, `${id}.explicitNoiseFiles`)
    );
    const expectedRequiredSourceReview = intakeCase.split === "holdout"
      || (originalRequiredSources.length === 0 && !officialPatchSources.some((filePath) => candidatePaths.has(filePath)));
    const expectedNoiseReview = pathArray(intakeCase.explicitNoiseFiles, `${id}.originalExplicitNoiseFiles`)
      .filter((filePath) => candidatePaths.has(filePath)).length < 6;
    if (queueCase.needsRequiredSourceReview !== expectedRequiredSourceReview || queueCase.needsNoiseReview !== expectedNoiseReview) {
      throw new Error(`${id}: review requirements differ from the bound intake and candidates`);
    }
    requireUnique(requiredSourceFiles, `${id}.requiredSourceFiles`);
    requireUnique(explicitNoiseFiles, `${id}.explicitNoiseFiles`);
    if (explicitNoiseFiles.length < 6) throw new Error(`${id}: at least six explicit noise files must be reviewed`);
    if (intakeCase.split === "holdout" && requiredSourceFiles.length === 0) {
      throw new Error(`${id}: holdout cases require at least one independently reviewed required-source oracle`);
    }
    if (expectedRequiredSourceReview && requiredSourceFiles.length === 0) {
      throw new Error(`${id}: required-source review is incomplete`);
    }

    const positivePaths = new Set([
      ...requiredSourceFiles,
      ...officialPatchSources,
      ...observedSources
    ]);
    const conflicts = explicitNoiseFiles.filter((filePath) => positivePaths.has(filePath));
    if (conflicts.length > 0) throw new Error(`${id}: positive and explicit-noise labels overlap: ${conflicts.join(", ")}`);

    return {
      ...intakeCase,
      requiredSourceFiles,
      explicitNoiseFiles
    };
  });
  const reviewedSelectedCases = reviewedCases.filter((item) =>
    selectedCaseIdSet.has(nonEmptyString(item.id, "reviewed case id"))
  );

  const sourceRegistryRef = nonEmptyString(intake.lineageRegistry, "intake.lineageRegistry");
  const sourceRegistryPath = path.resolve(path.dirname(intakePath), sourceRegistryRef);
  assertWithin(path.dirname(intakePath), sourceRegistryPath, "intake.lineageRegistry");
  const registryBytes = fs.readFileSync(sourceRegistryPath);
  const registryOutPath = path.resolve(options.registryOutPath ?? path.join(path.dirname(outPath), path.basename(sourceRegistryPath)));
  assertWithin(path.dirname(outPath), registryOutPath, "--registry-out");
  if (registryOutPath === outPath || registryOutPath === summaryOutPath || sourcePaths.has(registryOutPath) && registryOutPath !== sourceRegistryPath) {
    throw new Error("--registry-out must not collide with another review artifact");
  }
  const reviewedIntake = {
    ...intake,
    sealed: !partial,
    lineageRegistry: normalizePath(path.relative(path.dirname(outPath), registryOutPath)),
    cases: reviewedCases
  };
  const decisionRows = [...queueCases.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, item]) => ({
    id,
    decision: item.decision
  }));
  const reviewers = [...new Set(decisionRows.map((row) => nonEmptyString(record(row.decision, `${row.id}.decision`).reviewer, `${row.id}.decision.reviewer`)))].sort();
  const summary = {
    schemaVersion: "ranker-corpus-review-application.v1",
    corpusId: intake.corpusId,
    sealed: !partial,
    partial,
    caseCount: reviewedSelectedCases.length,
    sourceCaseCount: reviewedCases.length,
    untouchedCaseCount: reviewedCases.length - reviewedSelectedCases.length,
    selectedCaseIdsSha256: sha256([...selectedCaseIds].sort().join("\n")),
    reviewers,
    requiredSourceOracleCases: reviewedSelectedCases.filter((item) => pathArray(item.requiredSourceFiles, `${String(item.id)}.requiredSourceFiles`).length > 0).length,
    explicitNoiseLabels: reviewedSelectedCases.reduce((total, item) => total + pathArray(item.explicitNoiseFiles, `${String(item.id)}.explicitNoiseFiles`).length, 0),
    source: {
      intakeSha256: sha256(intakeBytes),
      manifestSha256: sha256(manifestBytes),
      reportSha256: sha256(reportBytes),
      reviewQueueSha256: sha256(queueBytes),
      lineageRegistrySha256: sha256(registryBytes),
      materializerCommit: record(manifest.materializer, "manifest.materializer").kairnCommit
    },
    decisionsSha256: sha256(JSON.stringify(decisionRows)),
    output: {
      intakeSha256: sha256(`${JSON.stringify(reviewedIntake, null, 2)}\n`),
      lineageRegistrySha256: sha256(registryBytes)
    }
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(registryOutPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryOutPath), { recursive: true });
  if (registryOutPath !== sourceRegistryPath) fs.copyFileSync(sourceRegistryPath, registryOutPath);
  fs.writeFileSync(outPath, `${JSON.stringify(reviewedIntake, null, 2)}\n`, "utf8");
  fs.writeFileSync(summaryOutPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

function validateRoots(
  intake: Record<string, unknown>,
  manifest: Record<string, unknown>,
  report: Record<string, unknown>,
  queue: Record<string, unknown>,
  hashes: { intakeSha256: string; manifestSha256: string; reportSha256: string },
  allowPartial: boolean
): void {
  if (intake.schemaVersion !== "ranker-corpus-intake.v1") {
    throw new Error("intake must be a ranker-corpus-intake.v1 artifact");
  }
  if (report.partial === true && !allowPartial) {
    throw new Error("partial materialization reports require --allow-partial and cannot be sealed");
  }
  if (allowPartial && report.partial !== true) {
    throw new Error("--allow-partial requires a partial materialization report");
  }
  if (!allowPartial && intake.sealed !== false) {
    throw new Error("full review application requires an unsealed intake");
  }
  if (allowPartial && intake.sealed !== true && intake.sealed !== false) {
    throw new Error("partial review application requires an intake with explicit sealed state");
  }
  if (manifest.schemaVersion !== "ranker-corpus.v1" || manifest.sealed !== false) {
    throw new Error("manifest must be an unsealed ranker-corpus.v1 draft");
  }
  if (report.schemaVersion !== "ranker-corpus-materialization-report.v1") throw new Error("report schemaVersion mismatch");
  if (queue.schemaVersion !== "ranker-corpus-review-queue.v1") throw new Error("review queue schemaVersion mismatch");
  if (new Set([intake.corpusId, manifest.corpusId, report.corpusId, queue.corpusId]).size !== 1) throw new Error("corpusId mismatch");
  if (queue.intakeSha256 !== hashes.intakeSha256) throw new Error("review queue intake hash is stale");
  if (queue.manifestSha256 !== hashes.manifestSha256) throw new Error("review queue manifest hash is stale");
  if (queue.reportSha256 !== hashes.reportSha256) throw new Error("review queue report hash is stale");
  const materializer = record(manifest.materializer, "manifest.materializer");
  if (materializer.intakeSha256 !== hashes.intakeSha256 || report.intakeSha256 !== hashes.intakeSha256) {
    throw new Error("materialization artifacts are not bound to this intake");
  }
  if (materializer.caseProcessIsolation !== true || report.caseProcessIsolation !== true) {
    throw new Error("review application requires caseProcessIsolation=true");
  }
  if (queue.materializerCommit !== materializer.kairnCommit || report.kairnCommit !== materializer.kairnCommit) {
    throw new Error("materializer commit mismatch");
  }
}

function validateSelection(
  queue: Record<string, unknown>,
  partial: boolean,
  sourceCaseCount: number,
  selectedCaseIds: string[]
): void {
  if (!partial) return;
  const selection = record(queue.selection, "review queue.selection");
  if (selection.partial !== true) throw new Error("partial review queue selection must declare partial=true");
  if (selection.sourceCaseCount !== sourceCaseCount || selection.selectedCaseCount !== selectedCaseIds.length) {
    throw new Error("partial review queue selection counts are stale");
  }
  const expectedDigest = sha256([...selectedCaseIds].sort().join("\n"));
  if (selection.selectedCaseIdsSha256 !== expectedDigest) {
    throw new Error("partial review queue selected-case digest is stale");
  }
}

function validateCaseBindings(
  id: string,
  manifestCase: Record<string, unknown>,
  reportCase: Record<string, unknown>,
  queueCase: Record<string, unknown>
): void {
  const candidates = array(reportCase.candidates, `${id}.report.candidates`).map((value, index) => {
    const candidate = record(value, `${id}.report.candidates[${index}]`);
    return normalizeCandidatePath(candidate.path, `${id}.report.candidates[${index}].path`);
  });
  const candidatePathsSha256 = sha256(candidates.join("\n"));
  if (reportCase.candidatePathsSha256 !== candidatePathsSha256 || queueCase.candidatePathsSha256 !== candidatePathsSha256) {
    throw new Error(`${id}: candidate path binding is stale`);
  }
  if (queueCase.materializedCaseSha256 !== sha256(JSON.stringify(manifestCase))) {
    throw new Error(`${id}: materialized case binding is stale`);
  }
  const queuedCandidates = array(queueCase.candidates, `${id}.review.candidates`).map((value, index) => {
    const candidate = record(value, `${id}.review.candidates[${index}]`);
    return normalizeCandidatePath(candidate.path, `${id}.review.candidates[${index}].path`);
  });
  if (queuedCandidates.join("\n") !== candidates.join("\n")) throw new Error(`${id}: review candidates differ from the materialization report`);
}

function candidatePathSet(reportCase: Record<string, unknown>, id: string): Set<string> {
  return new Set(array(reportCase.candidates, `${id}.candidates`).map((value, index) => {
    const candidate = record(value, `${id}.candidates[${index}]`);
    return normalizeCandidatePath(candidate.path, `${id}.candidates[${index}].path`);
  }));
}

function parseDecision(value: unknown, id: string): ReviewDecision {
  const decision = record(value, `${id}.decision`);
  const allowed = new Set(["requiredSourceFiles", "explicitNoiseFiles", "reviewer", "reviewedAt", "notes"]);
  const unknown = Object.keys(decision).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${id}.decision contains unknown fields: ${unknown.join(", ")}`);
  const reviewer = nonEmptyString(decision.reviewer, `${id}.decision.reviewer`);
  const reviewedAt = nonEmptyString(decision.reviewedAt, `${id}.decision.reviewedAt`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(reviewedAt) || Number.isNaN(Date.parse(reviewedAt))) {
    throw new Error(`${id}.decision.reviewedAt must be an ISO-8601 timestamp`);
  }
  const notes = decision.notes;
  if (notes !== null && (typeof notes !== "string" || !notes.trim())) throw new Error(`${id}.decision.notes must be null or a non-empty string`);
  return {
    requiredSourceFiles: pathArray(decision.requiredSourceFiles, `${id}.decision.requiredSourceFiles`),
    explicitNoiseFiles: pathArray(decision.explicitNoiseFiles, `${id}.decision.explicitNoiseFiles`),
    reviewer,
    reviewedAt,
    notes: notes as string | null
  };
}

function approvedCandidate(value: string, candidates: Set<string>, label: string): string {
  const normalized = normalizeCandidatePath(value, label);
  if (!candidates.has(normalized)) {
    throw new Error(`${label} contains '${normalized}', which is absent from the reviewed candidate union`);
  }
  return normalized;
}

function approvedRequiredSource(value: string, reviewedSources: Set<string>, label: string): string {
  const normalized = normalizeCandidatePath(value, label);
  if (!reviewedSources.has(normalized)) {
    throw new Error(`${label} contains '${normalized}', which is absent from reviewed candidates and source oracles`);
  }
  return normalized;
}

function pathArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => normalizeCandidatePath(item, `${label}[${index}]`));
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function normalizeCandidatePath(value: unknown, label: string): string {
  const raw = nonEmptyString(value, label).replace(/\\/g, "/");
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be repository-relative`);
  }
  return normalized;
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
}

function byId(value: unknown, label: string): Map<string, Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  array(value, label).forEach((item, index) => {
    const row = record(item, `${label}[${index}]`);
    const id = nonEmptyString(row.id, `${label}[${index}].id`);
    if (output.has(id)) throw new Error(`${label} contains duplicate id '${id}'`);
    output.set(id, row);
  });
  return output;
}

function assertWithin(parent: string, candidate: string, label: string): void {
  const relative = path.relative(parent, candidate);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} must stay inside ${parent}`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
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

function parseArgs(argv: string[]): ApplyCorpusReviewDecisionsOptions {
  const args = argv.filter((token) => token !== "--");
  const values = new Map<string, string>();
  let allowPartial = false;
  for (let index = 0; index < args.length;) {
    const key = args[index];
    if (key === "--allow-partial") {
      allowPartial = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument '${key ?? ""}'`);
    values.set(key, value);
    index += 2;
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
    reviewQueuePath: required("--review-queue"),
    outPath: required("--out"),
    ...(values.has("--registry-out") ? { registryOutPath: values.get("--registry-out")! } : {}),
    summaryOutPath: required("--summary-out"),
    ...(allowPartial ? { allowPartial: true } : {})
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = applyCorpusReviewDecisions(options);
    process.stdout.write(`${JSON.stringify({ out: path.resolve(options.outPath), summary: path.resolve(options.summaryOutPath), ...summary }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
