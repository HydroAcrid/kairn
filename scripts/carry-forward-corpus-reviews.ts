// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CarryForwardCorpusReviewsOptions = {
  queuePath: string;
  priorQueuePath: string;
  outPath: string;
  auditOutPath: string;
};

type CarryForwardResult = {
  queue: Record<string, unknown>;
  audit: Record<string, unknown>;
};

const IMMUTABLE_IDENTITY_FIELDS = [
  "split",
  "language",
  "scenario",
  "repositoryLineageId",
  "repositoryRef",
  "publicSourceUrl",
  "prompt",
  "officialPatchSourceFiles"
] as const;

export function carryForwardCorpusReviews(options: CarryForwardCorpusReviewsOptions): CarryForwardResult {
  const queuePath = path.resolve(options.queuePath);
  const priorQueuePath = path.resolve(options.priorQueuePath);
  const queueBytes = fs.readFileSync(queuePath);
  const priorQueueBytes = fs.readFileSync(priorQueuePath);
  const queue = record(JSON.parse(queueBytes.toString("utf8")), "queue");
  const priorQueue = record(JSON.parse(priorQueueBytes.toString("utf8")), "prior queue");
  validateQueue(queue, "queue");
  validateQueue(priorQueue, "prior queue");
  expectValue(queue.corpusId, priorQueue.corpusId, "queue corpusId");

  const currentCases = array(queue.cases, "queue.cases");
  const priorCases = byId(priorQueue.cases, "prior queue.cases");
  if (currentCases.length > priorCases.size) {
    throw new Error("current review queue cannot contain more cases than the prior review queue");
  }

  const sourceQueueSha256 = sha256(priorQueueBytes);
  const targetQueueSha256 = sha256(queueBytes);
  const currentCaseIds = new Set(currentCases.map((value, index) =>
    string(record(value, `queue.cases[${index}]`).id, `queue.cases[${index}].id`)
  ));
  const excludedPriorCaseCount = [...priorCases.keys()].filter((id) => !currentCaseIds.has(id)).length;
  const auditCases: Array<Record<string, unknown>> = [];
  let carriedCaseCount = 0;
  let alreadyCompletedCaseCount = 0;

  const outputCases = currentCases.map((value, index) => {
    const current = record(value, `queue.cases[${index}]`);
    const id = string(current.id, `queue.cases[${index}].id`);
    const prior = priorCases.get(id);
    if (!prior) throw new Error(`prior queue is missing case '${id}'`);
    const currentDecision = reviewDecision(current.decision, `${id}.current decision`);
    if (decisionComplete(currentDecision)) {
      alreadyCompletedCaseCount += 1;
      auditCases.push({
        id,
        status: "already_completed",
        reasons: [],
        currentCandidatePathsSha256: current.candidatePathsSha256
      });
      return current;
    }

    const reasons = carryForwardRejectionReasons(current, prior, id);
    if (reasons.length > 0) {
      auditCases.push({
        id,
        status: "pending_fresh_review",
        reasons,
        priorCandidatePathsSha256: prior.candidatePathsSha256,
        currentCandidatePathsSha256: current.candidatePathsSha256
      });
      return current;
    }

    const priorDecision = reviewDecision(prior.decision, `${id}.prior decision`);
    carriedCaseCount += 1;
    auditCases.push({
      id,
      status: "carried_forward",
      reasons: [],
      reviewer: priorDecision.reviewer,
      reviewedAt: priorDecision.reviewedAt,
      priorCandidatePathsSha256: prior.candidatePathsSha256,
      currentCandidatePathsSha256: current.candidatePathsSha256,
      priorMaterializedCaseSha256: prior.materializedCaseSha256,
      currentMaterializedCaseSha256: current.materializedCaseSha256
    });
    return {
      ...current,
      decision: priorDecision
    };
  });

  const pendingCaseCount = outputCases.filter((value, index) =>
    !decisionComplete(reviewDecision(record(value, `output.cases[${index}]`).decision, `output.cases[${index}].decision`))
  ).length;
  const outputQueue = {
    ...queue,
    reviewCarryForward: {
      schemaVersion: "ranker-corpus-review-carry-forward.v1",
      sourceQueueSha256,
      targetQueueSha256,
      carriedCaseCount,
      alreadyCompletedCaseCount,
      pendingCaseCount,
      policy: {
        immutableTaskIdentityRequired: true,
        currentLabelsMustEqualPriorReviewedDecision: true,
        everyReviewedLabelMustRemainInCurrentCandidateUnion: true,
        candidateAdditionsDoNotInvalidateStillPresentReviewedLabels: true,
        currentQueueMayBeAnExactSubsetOfPriorQueue: true
      }
    },
    cases: outputCases
  };
  const outputBytes = Buffer.from(`${JSON.stringify(outputQueue, null, 2)}\n`, "utf8");
  const audit = {
    schemaVersion: "ranker-corpus-review-carry-forward-audit.v1",
    corpusId: queue.corpusId,
    sourceQueueSha256,
    targetQueueSha256,
    outputQueueSha256: sha256(outputBytes),
    caseCount: outputCases.length,
    priorCaseCount: priorCases.size,
    excludedPriorCaseCount,
    carriedCaseCount,
    alreadyCompletedCaseCount,
    pendingCaseCount,
    cases: auditCases
  };
  return { queue: outputQueue, audit };
}

function carryForwardRejectionReasons(
  current: Record<string, unknown>,
  prior: Record<string, unknown>,
  id: string
): string[] {
  const reasons: string[] = [];
  for (const field of IMMUTABLE_IDENTITY_FIELDS) {
    if (!equalJson(current[field], prior[field])) reasons.push(`identity_changed:${field}`);
  }
  const priorDecision = reviewDecision(prior.decision, `${id}.prior decision`);
  if (!decisionComplete(priorDecision)) reasons.push("prior_decision_incomplete");
  if (!equalJson(current.requiredSourceFiles, priorDecision.requiredSourceFiles)) {
    reasons.push("required_source_labels_changed");
  }
  if (!equalJson(current.explicitNoiseFiles, priorDecision.explicitNoiseFiles)) {
    reasons.push("explicit_noise_labels_changed");
  }

  const candidatePaths = new Set(
    array(current.candidates, `${id}.candidates`).map((value, index) =>
      string(record(value, `${id}.candidates[${index}]`).path, `${id}.candidates[${index}].path`)
    )
  );
  const requiredSourceCreationFiles = new Set(
    current.requiredSourceCreationFiles === undefined
      ? []
      : stringArray(current.requiredSourceCreationFiles, `${id}.requiredSourceCreationFiles`)
  );
  const missingRequired = priorDecision.requiredSourceFiles.filter((filePath) =>
    !candidatePaths.has(filePath) && !requiredSourceCreationFiles.has(filePath)
  );
  const missingNoise = priorDecision.explicitNoiseFiles.filter((filePath) => !candidatePaths.has(filePath));
  if (missingRequired.length > 0) reasons.push("reviewed_required_source_missing");
  if (missingNoise.length > 0) reasons.push("reviewed_explicit_noise_missing");
  return reasons;
}

function reviewDecision(value: unknown, label: string): {
  requiredSourceFiles: string[];
  explicitNoiseFiles: string[];
  reviewer: string | null;
  reviewedAt: string | null;
  notes: string | null;
} {
  const decision = record(value, label);
  const reviewer = nullableString(decision.reviewer, `${label}.reviewer`);
  const reviewedAt = nullableString(decision.reviewedAt, `${label}.reviewedAt`);
  if ((reviewer === null) !== (reviewedAt === null)) {
    throw new Error(`${label}: reviewer and reviewedAt must be set together`);
  }
  return {
    requiredSourceFiles: stringArray(decision.requiredSourceFiles, `${label}.requiredSourceFiles`),
    explicitNoiseFiles: stringArray(decision.explicitNoiseFiles, `${label}.explicitNoiseFiles`),
    reviewer,
    reviewedAt,
    notes: nullableString(decision.notes, `${label}.notes`)
  };
}

function decisionComplete(decision: ReturnType<typeof reviewDecision>): boolean {
  return decision.reviewer !== null;
}

function validateQueue(queue: Record<string, unknown>, label: string): void {
  expectValue(queue.schemaVersion, "ranker-corpus-review-queue.v1", `${label} schemaVersion`);
  const cases = byId(queue.cases, `${label}.cases`);
  expectValue(queue.caseCount, cases.size, `${label} caseCount`);
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

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectValue(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): CarryForwardCorpusReviewsOptions {
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
    queuePath: required("--queue"),
    priorQueuePath: required("--prior-queue"),
    outPath: required("--out"),
    auditOutPath: required("--audit-out")
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = carryForwardCorpusReviews(options);
    const outPath = path.resolve(options.outPath);
    const auditOutPath = path.resolve(options.auditOutPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.mkdirSync(path.dirname(auditOutPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(result.queue, null, 2)}\n`, "utf8");
    fs.writeFileSync(auditOutPath, `${JSON.stringify(result.audit, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      out: outPath,
      auditOut: auditOutPath,
      caseCount: result.audit.caseCount,
      carriedCaseCount: result.audit.carriedCaseCount,
      alreadyCompletedCaseCount: result.audit.alreadyCompletedCaseCount,
      pendingCaseCount: result.audit.pendingCaseCount
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
