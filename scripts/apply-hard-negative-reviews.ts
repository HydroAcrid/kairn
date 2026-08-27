// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_NEGATIVE_REVIEW_QUEUE_SCHEMA } from "./build-hard-negative-review-queue.js";

export const HARD_NEGATIVE_REVIEW_DECISIONS_SCHEMA = "hard-negative-review-decisions.v1" as const;
export const HARD_NEGATIVE_REVIEW_APPLICATION_SCHEMA = "hard-negative-review-application.v1" as const;

type JsonRecord = Record<string, unknown>;
type Verdict = "irrelevant" | "relevant" | "uncertain";

export type ApplyHardNegativeReviewsOptions = {
  trainingRowsPath: string;
  reviewQueuePath: string;
  decisionsPath: string;
  outPath: string;
  summaryOutPath: string;
};

export function applyHardNegativeReviews(
  options: ApplyHardNegativeReviewsOptions
): Record<string, unknown> {
  const trainingRowsPath = path.resolve(options.trainingRowsPath);
  const reviewQueuePath = path.resolve(options.reviewQueuePath);
  const decisionsPath = path.resolve(options.decisionsPath);
  const outPath = path.resolve(options.outPath);
  const summaryOutPath = path.resolve(options.summaryOutPath);
  const sources = new Set([trainingRowsPath, reviewQueuePath, decisionsPath]);
  if (sources.has(outPath) || sources.has(summaryOutPath) || outPath === summaryOutPath) {
    throw new Error("review application outputs must not overwrite source artifacts");
  }

  const trainingBytes = fs.readFileSync(trainingRowsPath);
  const queueBytes = fs.readFileSync(reviewQueuePath);
  const decisionsBytes = fs.readFileSync(decisionsPath);
  const queue = json(queueBytes, "review queue");
  const decisions = json(decisionsBytes, "review decisions");
  if (queue.schemaVersion !== HARD_NEGATIVE_REVIEW_QUEUE_SCHEMA) {
    throw new Error("review queue schemaVersion mismatch");
  }
  if (queue.trainingOnly !== true || queue.detachedHoldoutOpened !== false) {
    throw new Error("review queue must be training-only with detached holdout closed");
  }
  if (decisions.schemaVersion !== HARD_NEGATIVE_REVIEW_DECISIONS_SCHEMA) {
    throw new Error("review decisions schemaVersion mismatch");
  }
  const queueSha256 = sha256(queueBytes);
  if (decisions.reviewQueueSha256 !== queueSha256) {
    throw new Error("review decisions are stale for this queue");
  }
  const queueInputs = record(queue.inputs, "review queue.inputs");
  const queueTraining = record(queueInputs.trainingRows, "review queue.inputs.trainingRows");
  if (queueTraining.sha256 !== sha256(trainingBytes)) {
    throw new Error("review queue is stale for these training rows");
  }

  const sourceRows = parseTrainingRows(trainingBytes);
  const existing = new Set(sourceRows.map((row) => row.key));
  const schemaVersions = new Set(sourceRows.map((row) => string(row.value.featureSchemaVersion, "training row featureSchemaVersion")));
  if (schemaVersions.size !== 1) throw new Error("training rows must use one feature schemaVersion");
  const featureSchemaVersion = [...schemaVersions][0]!;
  const featureSchema = record(queue.featureSchema, "review queue.featureSchema");
  const baseFeatures = stringArray(featureSchema.base, "review queue.featureSchema.base");

  const items = byId(queue.items, "review queue.items");
  const decisionRows = byId(decisions.decisions, "review decisions.decisions");
  if (items.size !== decisionRows.size || [...items.keys()].some((id) => !decisionRows.has(id))) {
    throw new Error("every queued review item requires exactly one decision");
  }
  const reviewer = string(decisions.reviewer, "review decisions.reviewer");
  const reviewedAt = timestamp(decisions.reviewedAt, "review decisions.reviewedAt");
  const additions: JsonRecord[] = [];
  const verdictCounts: Record<Verdict, number> = { irrelevant: 0, relevant: 0, uncertain: 0 };
  const cellCounts = new Map<string, Record<Verdict, number>>();

  for (const id of [...items.keys()].sort()) {
    const item = items.get(id)!;
    const decision = decisionRows.get(id)!;
    const verdict = oneOf(decision.verdict, ["irrelevant", "relevant", "uncertain"] as const, `${id}.verdict`);
    const notes = string(decision.notes, `${id}.notes`);
    const source = record(item.source, `${id}.source`);
    const sourceContentSha256 = digest(decision.sourceContentSha256, `${id}.sourceContentSha256`);
    if (source.contentSha256 !== sourceContentSha256) {
      throw new Error(`${id}: review decision source hash is stale`);
    }
    verdictCounts[verdict] += 1;
    const cell = string(item.cell, `${id}.cell`);
    const counts = cellCounts.get(cell) ?? { irrelevant: 0, relevant: 0, uncertain: 0 };
    counts[verdict] += 1;
    cellCounts.set(cell, counts);
    if (verdict !== "irrelevant") continue;

    const caseId = string(item.caseId, `${id}.caseId`);
    const candidatePath = repositoryPath(item.candidatePath, `${id}.candidatePath`);
    const key = `${caseId}\n${candidatePath}`;
    if (existing.has(key)) throw new Error(`${id}: reviewed candidate already exists in training rows`);
    const evidence = record(item.evidence, `${id}.evidence`);
    const values = record(evidence.baseFeatures, `${id}.evidence.baseFeatures`);
    additions.push({
      featureSchemaVersion,
      repositoryLineageId: string(item.repositoryLineageId, `${id}.repositoryLineageId`),
      caseGroupId: caseId,
      split: "train",
      language: string(item.language, `${id}.language`),
      scenario: string(item.scenario, `${id}.scenario`),
      candidatePath,
      isPublic: true,
      publicSourceUrl: string(item.publicSourceUrl, `${id}.publicSourceUrl`),
      dataOrigin: string(item.dataOrigin, `${id}.dataOrigin`),
      label: 0,
      labelWeight: 1,
      labelProvenance: "explicit_noise_or_excluded",
      features: baseFeatures.map((name) => finite(values[name], `${id}.evidence.baseFeatures.${name}`)),
      diagnosticProbe: true,
      hardNegativeReview: {
        queueSha256,
        decisionId: id,
        sourceContentSha256,
        reviewer,
        reviewedAt,
        notes
      }
    });
    existing.add(key);
  }

  additions.sort((left, right) =>
    string(left.caseGroupId, "addition.caseGroupId").localeCompare(string(right.caseGroupId, "addition.caseGroupId"))
    || string(left.candidatePath, "addition.candidatePath").localeCompare(string(right.candidatePath, "addition.candidatePath"))
  );
  const original = trainingBytes.toString("utf8").replace(/\s*$/, "\n");
  const appended = additions.map((row) => JSON.stringify(row)).join("\n");
  const output = Buffer.from(`${original}${appended}${appended ? "\n" : ""}`, "utf8");
  const summary = {
    schemaVersion: HARD_NEGATIVE_REVIEW_APPLICATION_SCHEMA,
    promotionEligible: false,
    trainingOnly: true,
    detachedHoldoutOpened: false,
    inputs: {
      trainingRowsSha256: sha256(trainingBytes),
      reviewQueueSha256: queueSha256,
      decisionsSha256: sha256(decisionsBytes)
    },
    reviewer,
    reviewedAt,
    reviewedItems: items.size,
    verdictCounts,
    addedNegativeRows: additions.length,
    unchangedUnlabeledRows: verdictCounts.relevant + verdictCounts.uncertain,
    cellCounts: [...cellCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([cell, counts]) => ({ cell, ...counts })),
    output: { sha256: sha256(output), bytes: output.length, rowCount: sourceRows.length + additions.length }
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryOutPath), { recursive: true });
  fs.writeFileSync(outPath, output);
  fs.writeFileSync(summaryOutPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

function parseTrainingRows(bytes: Buffer): Array<{ key: string; value: JsonRecord }> {
  const result: Array<{ key: string; value: JsonRecord }> = [];
  const seen = new Set<string>();
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const row = record(JSON.parse(line) as unknown, `trainingRows[${index}]`);
    if (row.split === "holdout") throw new Error("training rows may not contain holdout data");
    const key = `${string(row.caseGroupId, `trainingRows[${index}].caseGroupId`)}\n${repositoryPath(row.candidatePath, `trainingRows[${index}].candidatePath`)}`;
    if (seen.has(key)) throw new Error(`duplicate training row ${key.replace("\n", ":")}`);
    seen.add(key);
    result.push({ key, value: row });
  }
  return result;
}

function byId(value: unknown, label: string): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>();
  for (const [index, raw] of array(value, label).entries()) {
    const item = record(raw, `${label}[${index}]`);
    const id = string(item.id, `${label}[${index}].id`);
    if (result.has(id)) throw new Error(`${label} contains duplicate id ${id}`);
    result.set(id, item);
  }
  return result;
}

function repositoryPath(value: unknown, label: string): string {
  const normalized = path.posix.normalize(string(value, label).replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be repository-relative`);
  }
  return normalized;
}

function timestamp(value: unknown, label: string): string {
  const output = string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(output) || Number.isNaN(Date.parse(output))) {
    throw new Error(`${label} must be a UTC ISO-8601 timestamp`);
  }
  return output;
}

function digest(value: unknown, label: string): string {
  const output = string(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(output)) throw new Error(`${label} must be a SHA-256 digest`);
  return output;
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} must be one of ${values.join(", ")}`);
  }
  return value as T[number];
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

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): ApplyHardNegativeReviewsOptions {
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
    trainingRowsPath: required("--training-rows"),
    reviewQueuePath: required("--review-queue"),
    decisionsPath: required("--decisions"),
    outPath: required("--out"),
    summaryOutPath: required("--summary-out")
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = applyHardNegativeReviews(options);
    process.stdout.write(`${JSON.stringify({
      out: path.resolve(options.outPath),
      summary: path.resolve(options.summaryOutPath),
      ...summary
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
