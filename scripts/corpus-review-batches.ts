// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ExportCorpusReviewBatchesOptions = {
  queuePath: string;
  outDir: string;
  batchSize: number;
  indexOutPath?: string;
  pendingOnly?: boolean;
};

export type MergeCorpusReviewBatchesOptions = {
  queuePath: string;
  batchDir: string;
  outPath: string;
  summaryOutPath: string;
  decisionCheckpointOutPath?: string;
  requireComplete?: boolean;
};

type ReviewDecision = {
  requiredSourceFiles: string[];
  explicitNoiseFiles: string[];
  reviewer: string | null;
  reviewedAt: string | null;
  notes: string | null;
};

export function exportCorpusReviewBatches(options: ExportCorpusReviewBatchesOptions): Record<string, unknown> {
  const queuePath = path.resolve(options.queuePath);
  const outDir = path.resolve(options.outDir);
  const batchSize = options.batchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new Error("batchSize must be an integer between 1 and 50");
  }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`review batch directory is not empty: ${outDir}`);
  }
  const preservedIndexPath = options.indexOutPath ? path.resolve(options.indexOutPath) : undefined;
  if (preservedIndexPath === path.join(outDir, "index.json")) {
    throw new Error("--index-out must differ from the batch-directory index path");
  }
  if (preservedIndexPath && fs.existsSync(preservedIndexPath)) {
    throw new Error(`index output already exists: ${preservedIndexPath}`);
  }

  const queueBytes = fs.readFileSync(queuePath);
  const queue = record(JSON.parse(queueBytes.toString("utf8")), "review queue");
  expectValue(queue.schemaVersion, "ranker-corpus-review-queue.v1", "review queue schemaVersion");
  const queueSha256 = sha256(queueBytes);
  const cases = array(queue.cases, "review queue.cases").map((value, index) => {
    const row = record(value, `review queue.cases[${index}]`);
    string(row.id, `review queue.cases[${index}].id`);
    parseDecision(row.decision, `${String(row.id)}.decision`);
    return row;
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("review queue case ids must be unique");
  expectValue(queue.caseCount, cases.length, "review queue caseCount");
  const initiallyCompletedCases = cases.filter((item) =>
    decisionState(parseDecision(item.decision, `${String(item.id)}.decision`), String(item.id)) === "completed"
  ).length;
  const exportedCases = options.pendingOnly
    ? cases.filter((item) =>
        decisionState(parseDecision(item.decision, `${String(item.id)}.decision`), String(item.id)) === "pending"
      )
    : cases;

  fs.mkdirSync(outDir, { recursive: true });
  const batchCount = Math.ceil(exportedCases.length / batchSize);
  const entries: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < exportedCases.length; offset += batchSize) {
    const batchNumber = Math.floor(offset / batchSize) + 1;
    const batchId = `batch-${String(batchNumber).padStart(3, "0")}-of-${String(batchCount).padStart(3, "0")}`;
    const batchCases = exportedCases.slice(offset, offset + batchSize).map((item) => {
      const { decision, ...context } = item;
      return { context, decision: parseDecision(decision, `${String(item.id)}.decision`) };
    });
    const contexts = batchCases.map((item) => item.context);
    const contextSha256 = canonicalSha256(contexts);
    const batch = {
      schemaVersion: "ranker-corpus-review-batch.v1",
      batchId,
      corpusId: queue.corpusId,
      sourceQueueSha256: queueSha256,
      contextSha256,
      caseCount: batchCases.length,
      instructions: "Edit only each decision object. Leave reviewer and reviewedAt null while a decision is in progress; set both when independently reviewed.",
      cases: batchCases
    };
    const fileName = `${batchId}.json`;
    const batchBytes = `${JSON.stringify(batch, null, 2)}\n`;
    fs.writeFileSync(path.join(outDir, fileName), batchBytes, "utf8");
    const caseIds = contexts.map((item) => string(item.id, `${batchId}.context.id`));
    entries.push({
      batchId,
      fileName,
      caseCount: batchCases.length,
      firstCaseId: caseIds[0],
      lastCaseId: caseIds.at(-1),
      caseIdsSha256: sha256(caseIds.join("\n")),
      contextSha256,
      initialTemplateSha256: sha256(batchBytes)
    });
  }

  const index = {
    schemaVersion: "ranker-corpus-review-batch-index.v1",
    corpusId: queue.corpusId,
    status: initiallyCompletedCases === cases.length ? "review_complete" : "review_pending",
    promotionEligible: false,
    sourceQueue: {
      fileName: path.basename(queuePath),
      sha256: queueSha256,
      intakeSha256: queue.intakeSha256,
      manifestSha256: queue.manifestSha256,
      reportSha256: queue.reportSha256,
      materializerCommit: queue.materializerCommit
    },
    caseCount: cases.length,
    caseSetSha256: sha256(cases.map((item) => string(item.id, "case.id")).sort().join("\n")),
    exportedCaseCount: exportedCases.length,
    exportedCaseSetSha256: sha256(exportedCases.map((item) => string(item.id, "case.id")).sort().join("\n")),
    selection: options.pendingOnly ? "pending_only" : "all",
    batchSize,
    batchCount,
    initialReviewProgress: {
      completedCases: initiallyCompletedCases,
      pendingCases: cases.length - initiallyCompletedCases
    },
    policy: {
      decisionsAreNeverAutoFilled: true,
      immutableContextMustMatchSourceQueue: true,
      exactSelectedCaseCoverageRequired: true,
      sourceQueueCompletedDecisionsPreserved: options.pendingOnly === true,
      partialProgressMayBeMerged: true,
      completeMergeRequiredBeforeSealing: true
    },
    batches: entries
  };
  const indexPath = path.join(outDir, "index.json");
  const indexBytes = `${JSON.stringify(index, null, 2)}\n`;
  fs.writeFileSync(indexPath, indexBytes, "utf8");
  if (preservedIndexPath) {
    fs.mkdirSync(path.dirname(preservedIndexPath), { recursive: true });
    fs.writeFileSync(preservedIndexPath, indexBytes, "utf8");
  }
  return index;
}

export function mergeCorpusReviewBatches(options: MergeCorpusReviewBatchesOptions): Record<string, unknown> {
  const queuePath = path.resolve(options.queuePath);
  const batchDir = path.resolve(options.batchDir);
  const outPath = path.resolve(options.outPath);
  const summaryOutPath = path.resolve(options.summaryOutPath);
  const decisionCheckpointOutPath = options.decisionCheckpointOutPath
    ? path.resolve(options.decisionCheckpointOutPath)
    : undefined;
  const outputPaths = [outPath, summaryOutPath, ...(decisionCheckpointOutPath ? [decisionCheckpointOutPath] : [])];
  if (outputPaths.includes(queuePath) || new Set(outputPaths).size !== outputPaths.length) {
    throw new Error("merge outputs must not overwrite the source queue or each other");
  }
  for (const target of outputPaths) {
    if (fs.existsSync(target)) throw new Error(`merge output already exists: ${target}`);
  }

  const queueBytes = fs.readFileSync(queuePath);
  const queue = record(JSON.parse(queueBytes.toString("utf8")), "review queue");
  expectValue(queue.schemaVersion, "ranker-corpus-review-queue.v1", "review queue schemaVersion");
  const queueSha256 = sha256(queueBytes);
  const sourceCases = byId(queue.cases, "review queue.cases");
  expectValue(queue.caseCount, sourceCases.size, "review queue caseCount");

  const index = record(JSON.parse(fs.readFileSync(path.join(batchDir, "index.json"), "utf8")), "batch index");
  expectValue(index.schemaVersion, "ranker-corpus-review-batch-index.v1", "batch index schemaVersion");
  expectValue(index.corpusId, queue.corpusId, "batch index corpusId");
  const sourceQueue = record(index.sourceQueue, "batch index sourceQueue");
  expectValue(sourceQueue.sha256, queueSha256, "batch index source queue hash");
  expectValue(index.caseCount, sourceCases.size, "batch index caseCount");
  const expectedCaseSetSha256 = sha256([...sourceCases.keys()].sort().join("\n"));
  expectValue(index.caseSetSha256, expectedCaseSetSha256, "batch index case set hash");
  const selection = index.selection === undefined ? "all" : string(index.selection, "batch index selection");
  if (selection !== "all" && selection !== "pending_only") {
    throw new Error(`unsupported batch index selection '${selection}'`);
  }
  const selectedSourceCases = [...sourceCases.entries()].filter(([id, item]) =>
    selection === "all" ||
    decisionState(parseDecision(item.decision, `${id}.decision`), id) === "pending"
  );
  expectValue(index.exportedCaseCount ?? sourceCases.size, selectedSourceCases.length, "batch index exportedCaseCount");
  expectValue(
    index.exportedCaseSetSha256 ?? expectedCaseSetSha256,
    sha256(selectedSourceCases.map(([id]) => id).sort().join("\n")),
    "batch index exported case set hash"
  );

  const batchEntries = array(index.batches, "batch index batches").map((value, entryIndex) =>
    record(value, `batch index batches[${entryIndex}]`)
  );
  expectValue(index.batchCount, batchEntries.length, "batch index batchCount");
  const expectedFiles = new Set(batchEntries.map((entry, entryIndex) =>
    string(entry.fileName, `batch index batches[${entryIndex}].fileName`)
  ));
  const actualFiles = fs.readdirSync(batchDir).filter((fileName) => fileName.endsWith(".json") && fileName !== "index.json");
  const missingFiles = [...expectedFiles].filter((fileName) => !actualFiles.includes(fileName));
  const extraFiles = actualFiles.filter((fileName) => !expectedFiles.has(fileName));
  if (missingFiles.length > 0 || extraFiles.length > 0) {
    throw new Error(`review batch file set mismatch; missing=${missingFiles.join(",") || "none"} extra=${extraFiles.join(",") || "none"}`);
  }

  const decisions = new Map<string, ReviewDecision>();
  let completedCases = 0;
  const reviewers = new Set<string>();
  if (selection === "pending_only") {
    for (const [id, sourceCase] of sourceCases) {
      const decision = parseDecision(sourceCase.decision, `${id}.decision`);
      if (decisionState(decision, id) !== "completed") continue;
      const { decision: _sourceDecision, ...sourceContext } = sourceCase;
      validateCompletedDecision(id, sourceContext, decision);
      decisions.set(id, decision);
      completedCases += 1;
      reviewers.add(decision.reviewer!);
    }
  }
  for (const [entryIndex, entry] of batchEntries.entries()) {
    const fileName = string(entry.fileName, `batch index batches[${entryIndex}].fileName`);
    const batch = record(JSON.parse(fs.readFileSync(path.join(batchDir, fileName), "utf8")), fileName);
    expectValue(batch.schemaVersion, "ranker-corpus-review-batch.v1", `${fileName} schemaVersion`);
    expectValue(batch.batchId, entry.batchId, `${fileName} batchId`);
    expectValue(batch.corpusId, queue.corpusId, `${fileName} corpusId`);
    expectValue(batch.sourceQueueSha256, queueSha256, `${fileName} source queue hash`);
    const batchCases = array(batch.cases, `${fileName}.cases`).map((value, caseIndex) =>
      record(value, `${fileName}.cases[${caseIndex}]`)
    );
    expectValue(batch.caseCount, batchCases.length, `${fileName} caseCount`);
    expectValue(entry.caseCount, batchCases.length, `${fileName} indexed caseCount`);
    const contexts = batchCases.map((item, caseIndex) => record(item.context, `${fileName}.cases[${caseIndex}].context`));
    const contextSha256 = canonicalSha256(contexts);
    expectValue(batch.contextSha256, contextSha256, `${fileName} context hash`);
    expectValue(entry.contextSha256, contextSha256, `${fileName} indexed context hash`);
    const caseIds = contexts.map((context, caseIndex) => string(context.id, `${fileName}.cases[${caseIndex}].context.id`));
    expectValue(entry.caseIdsSha256, sha256(caseIds.join("\n")), `${fileName} case id hash`);

    for (let caseIndex = 0; caseIndex < batchCases.length; caseIndex += 1) {
      const id = caseIds[caseIndex]!;
      if (decisions.has(id)) throw new Error(`review batches contain duplicate case '${id}'`);
      const sourceCase = sourceCases.get(id);
      if (!sourceCase) throw new Error(`review batch contains unknown case '${id}'`);
      const { decision: _sourceDecision, ...sourceContext } = sourceCase;
      if (canonicalSha256(contexts[caseIndex]) !== canonicalSha256(sourceContext)) {
        throw new Error(`${id}: immutable review context differs from source queue`);
      }
      const decision = parseDecision(batchCases[caseIndex]!.decision, `${id}.decision`);
      const state = decisionState(decision, id);
      if (state === "completed") {
        validateCompletedDecision(id, contexts[caseIndex]!, decision);
        completedCases += 1;
        reviewers.add(decision.reviewer!);
      }
      decisions.set(id, decision);
    }
  }
  const missingCases = [...sourceCases.keys()].filter((id) => !decisions.has(id));
  if (missingCases.length > 0 || decisions.size !== sourceCases.size) {
    throw new Error(`review batches do not cover the exact source case set; missing=${missingCases.join(",") || "none"}`);
  }
  const pendingCases = sourceCases.size - completedCases;
  if (options.requireComplete && pendingCases > 0) {
    throw new Error(`review batches are incomplete: ${pendingCases} case decision(s) pending`);
  }

  const mergedCases = array(queue.cases, "review queue.cases").map((value, index) => {
    const row = record(value, `review queue.cases[${index}]`);
    const id = string(row.id, `review queue.cases[${index}].id`);
    return { ...row, decision: decisions.get(id)! };
  });
  const mergedQueue = { ...queue, cases: mergedCases };
  const mergedBytes = `${JSON.stringify(mergedQueue, null, 2)}\n`;
  const batchIndexBytes = fs.readFileSync(path.join(batchDir, "index.json"));
  const completedDecisions = array(queue.cases, "review queue.cases").flatMap((value, index) => {
    const item = record(value, `review queue.cases[${index}]`);
    const id = string(item.id, `review queue.cases[${index}].id`);
    const decision = decisions.get(id)!;
    if (decision.reviewer === null) return [];
    return [{
      id,
      materializedCaseSha256: string(item.materializedCaseSha256, `${id}.materializedCaseSha256`),
      candidatePathsSha256: string(item.candidatePathsSha256, `${id}.candidatePathsSha256`),
      decision
    }];
  });
  const decisionCheckpoint = {
    schemaVersion: "ranker-corpus-review-decision-checkpoint.v1",
    corpusId: queue.corpusId,
    status: pendingCases === 0 ? "review_complete" : "review_in_progress",
    promotionEligible: false,
    sourceQueueSha256: queueSha256,
    batchIndexSha256: sha256(batchIndexBytes),
    caseCount: sourceCases.size,
    completedCases,
    pendingCases,
    decisions: completedDecisions
  };
  const decisionCheckpointBytes = `${JSON.stringify(decisionCheckpoint, null, 2)}\n`;
  const summary = {
    schemaVersion: "ranker-corpus-review-batch-merge.v1",
    corpusId: queue.corpusId,
    sourceQueueSha256: queueSha256,
    batchIndexSha256: sha256(batchIndexBytes),
    mergedQueueSha256: sha256(mergedBytes),
    decisionCheckpointSha256: sha256(decisionCheckpointBytes),
    caseCount: sourceCases.size,
    completedCases,
    pendingCases,
    reviewers: [...reviewers].sort(),
    requireComplete: options.requireComplete === true,
    readyForReviewApplication: pendingCases === 0
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryOutPath), { recursive: true });
  fs.writeFileSync(outPath, mergedBytes, "utf8");
  fs.writeFileSync(summaryOutPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (decisionCheckpointOutPath) {
    fs.mkdirSync(path.dirname(decisionCheckpointOutPath), { recursive: true });
    fs.writeFileSync(decisionCheckpointOutPath, decisionCheckpointBytes, "utf8");
  }
  return summary;
}

function validateCompletedDecision(id: string, context: Record<string, unknown>, decision: ReviewDecision): void {
  const candidatePaths = new Set(array(context.candidates, `${id}.candidates`).map((value, index) => {
    const candidate = record(value, `${id}.candidates[${index}]`);
    return normalizeRepoPath(candidate.path, `${id}.candidates[${index}].path`);
  }));
  const reviewedSourcePaths = new Set([
    ...candidatePaths,
    ...pathArray(context.requiredSourceFiles, `${id}.requiredSourceFiles`),
    ...pathArray(context.officialPatchSourceFiles, `${id}.officialPatchSourceFiles`)
  ]);
  for (const [label, values] of Object.entries({
    requiredSourceFiles: decision.requiredSourceFiles,
    explicitNoiseFiles: decision.explicitNoiseFiles
  })) {
    if (new Set(values).size !== values.length) throw new Error(`${id}.${label} must not contain duplicates`);
  }
  const unknownRequiredSources = decision.requiredSourceFiles.filter((filePath) => !reviewedSourcePaths.has(filePath));
  if (unknownRequiredSources.length > 0) {
    throw new Error(`${id}.requiredSourceFiles contains paths absent from reviewed candidates and source oracles: ${unknownRequiredSources.join(", ")}`);
  }
  const absentNoise = decision.explicitNoiseFiles.filter((filePath) => !candidatePaths.has(filePath));
  if (absentNoise.length > 0) {
    throw new Error(`${id}.explicitNoiseFiles contains paths absent from candidate@64: ${absentNoise.join(", ")}`);
  }
  if (decision.explicitNoiseFiles.length < 6) throw new Error(`${id}: completed decisions require at least six explicit noise files`);
  if (context.needsRequiredSourceReview === true && decision.requiredSourceFiles.length === 0) {
    throw new Error(`${id}: required-source review is incomplete`);
  }
  const officialPatchSources = pathArray(context.officialPatchSourceFiles, `${id}.officialPatchSourceFiles`);
  const positives = new Set([...officialPatchSources, ...decision.requiredSourceFiles]);
  const conflicts = decision.explicitNoiseFiles.filter((filePath) => positives.has(filePath));
  if (conflicts.length > 0) throw new Error(`${id}: positive and explicit-noise labels overlap: ${conflicts.join(", ")}`);
}

function decisionState(decision: ReviewDecision, id: string): "pending" | "completed" {
  const hasReviewer = decision.reviewer !== null;
  const hasTimestamp = decision.reviewedAt !== null;
  if (hasReviewer !== hasTimestamp) throw new Error(`${id}: reviewer and reviewedAt must be set together`);
  if (decision.reviewedAt !== null && (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(decision.reviewedAt)
    || Number.isNaN(Date.parse(decision.reviewedAt))
  )) {
    throw new Error(`${id}: reviewedAt must be an ISO-8601 timestamp`);
  }
  return hasReviewer ? "completed" : "pending";
}

function parseDecision(value: unknown, label: string): ReviewDecision {
  const decision = record(value, label);
  const allowed = new Set(["requiredSourceFiles", "explicitNoiseFiles", "reviewer", "reviewedAt", "notes"]);
  const unknown = Object.keys(decision).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  const nullableString = (field: "reviewer" | "reviewedAt" | "notes"): string | null => {
    const fieldValue = decision[field];
    if (fieldValue === null) return null;
    return string(fieldValue, `${label}.${field}`);
  };
  return {
    requiredSourceFiles: pathArray(decision.requiredSourceFiles, `${label}.requiredSourceFiles`),
    explicitNoiseFiles: pathArray(decision.explicitNoiseFiles, `${label}.explicitNoiseFiles`),
    reviewer: nullableString("reviewer"),
    reviewedAt: nullableString("reviewedAt"),
    notes: nullableString("notes")
  };
}

function pathArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => normalizeRepoPath(item, `${label}[${index}]`));
}

function normalizeRepoPath(value: unknown, label: string): string {
  const raw = string(value, label).replace(/\\/g, "/");
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be repository-relative`);
  }
  return normalized;
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

function canonicalSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function expectValue(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function string(value: unknown, label: string): string {
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

function parseValues(args: string[], flags: Set<string>): { values: Map<string, string>; enabledFlags: Set<string> } {
  const values = new Map<string, string>();
  const enabledFlags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (flags.has(key)) {
      enabledFlags.add(key);
      continue;
    }
    const value = args[index + 1];
    if (!key.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument '${key}'`);
    values.set(key, value);
    index += 1;
  }
  return { values, enabledFlags };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const args = process.argv.slice(2).filter((token) => token !== "--");
    const command = args.shift();
    const { values, enabledFlags } = parseValues(args, new Set(["--require-complete", "--pending-only"]));
    const required = (key: string): string => {
      const value = values.get(key);
      if (!value) throw new Error(`${key} is required`);
      return value;
    };
    if (command === "export") {
      const result = exportCorpusReviewBatches({
        queuePath: required("--queue"),
        outDir: required("--out-dir"),
        batchSize: Number(values.get("--batch-size") ?? "10"),
        pendingOnly: enabledFlags.has("--pending-only"),
        ...(values.has("--index-out") ? { indexOutPath: values.get("--index-out")! } : {})
      });
      process.stdout.write(`${JSON.stringify({ outDir: path.resolve(required("--out-dir")), ...result }, null, 2)}\n`);
    } else if (command === "merge") {
      const options: MergeCorpusReviewBatchesOptions = {
        queuePath: required("--queue"),
        batchDir: required("--batch-dir"),
        outPath: required("--out"),
        summaryOutPath: required("--summary-out"),
        ...(values.has("--checkpoint-out") ? { decisionCheckpointOutPath: values.get("--checkpoint-out")! } : {}),
        requireComplete: enabledFlags.has("--require-complete")
      };
      const result = mergeCorpusReviewBatches(options);
      process.stdout.write(`${JSON.stringify({
        out: path.resolve(options.outPath),
        summary: path.resolve(options.summaryOutPath),
        ...(options.decisionCheckpointOutPath
          ? { checkpoint: path.resolve(options.decisionCheckpointOutPath) }
          : {}),
        ...result
      }, null, 2)}\n`);
    } else {
      throw new Error("first argument must be 'export' or 'merge'");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
