// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReplaceEvidenceTrainingCaseRowsOptions = {
  basePath: string;
  replacementPath: string;
  outPath: string;
  summaryPath: string;
};

const CASE_IDENTITY_FIELDS = [
  "featureSchemaVersion",
  "repositoryLineageId",
  "split",
  "language",
  "scenario",
  "publicSourceUrl",
  "dataOrigin"
] as const;

export function replaceEvidenceTrainingCaseRows(
  options: ReplaceEvidenceTrainingCaseRowsOptions
): Record<string, unknown> {
  const basePath = path.resolve(options.basePath);
  const replacementPath = path.resolve(options.replacementPath);
  const outPath = path.resolve(options.outPath);
  const summaryPath = path.resolve(options.summaryPath);
  if (new Set([basePath, replacementPath, outPath, summaryPath]).size !== 4) {
    throw new Error("base, replacement, output, and summary paths must be distinct");
  }

  const baseBytes = fs.readFileSync(basePath);
  const replacementBytes = fs.readFileSync(replacementPath);
  const baseRows = parseRows(baseBytes, "base rows");
  const replacementRows = parseRows(replacementBytes, "replacement rows");
  const baseCases = groupByCase(baseRows, "base rows");
  const replacementCases = groupByCase(replacementRows, "replacement rows");
  if (replacementCases.size === 0) throw new Error("replacement rows contain no cases");

  for (const [caseId, rows] of replacementCases) {
    const prior = baseCases.get(caseId);
    if (!prior) throw new Error(`replacement case '${caseId}' is absent from the base rows`);
    for (const field of CASE_IDENTITY_FIELDS) {
      if (!equalJson(prior[0]![field], rows[0]![field])) {
        throw new Error(`${caseId}: replacement case identity changed at ${field}`);
      }
    }
  }

  const emitted = new Set<string>();
  const outputRows: Record<string, unknown>[] = [];
  for (const row of baseRows) {
    const caseId = string(row.caseGroupId, "base row caseGroupId");
    const replacement = replacementCases.get(caseId);
    if (!replacement) {
      outputRows.push(row);
      continue;
    }
    if (!emitted.has(caseId)) {
      outputRows.push(...replacement);
      emitted.add(caseId);
    }
  }
  if (emitted.size !== replacementCases.size) {
    throw new Error("not every replacement case was emitted");
  }
  assertUniqueRows(outputRows, "output rows");

  const outputBytes = Buffer.from(
    outputRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );
  const replacedCaseIds = [...replacementCases.keys()].sort();
  const summary = {
    schemaVersion: "evidence-training-case-row-replacement.v1",
    promotionEligible: false,
    base: { path: relative(basePath), sha256: sha256(baseBytes), rowCount: baseRows.length },
    replacement: {
      path: relative(replacementPath),
      sha256: sha256(replacementBytes),
      rowCount: replacementRows.length,
      caseIds: replacedCaseIds
    },
    output: { path: relative(outPath), sha256: sha256(outputBytes), rowCount: outputRows.length },
    unchangedCaseCount: baseCases.size - replacementCases.size,
    replacedCaseCount: replacementCases.size
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(outPath, outputBytes);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

function parseRows(bytes: Buffer, label: string): Record<string, unknown>[] {
  const rows = bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
    const value = JSON.parse(line) as unknown;
    return record(value, `${label}[${index}]`);
  });
  if (rows.length === 0) throw new Error(`${label} are empty`);
  assertUniqueRows(rows, label);
  return rows;
}

function groupByCase(rows: Record<string, unknown>[], label: string): Map<string, Record<string, unknown>[]> {
  const output = new Map<string, Record<string, unknown>[]>();
  for (const [index, row] of rows.entries()) {
    const caseId = string(row.caseGroupId, `${label}[${index}].caseGroupId`);
    const grouped = output.get(caseId) ?? [];
    grouped.push(row);
    output.set(caseId, grouped);
  }
  return output;
}

function assertUniqueRows(rows: Record<string, unknown>[], label: string): void {
  const identities = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const identity = [
      string(row.caseGroupId, `${label}[${index}].caseGroupId`),
      string(row.candidatePath, `${label}[${index}].candidatePath`)
    ].join("\0");
    if (identities.has(identity)) throw new Error(`${label} contain duplicate candidate identity ${identity}`);
    identities.add(identity);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function relative(target: string): string {
  return path.relative(process.cwd(), target).replace(/\\/g, "/");
}

function parseArgs(argv: string[]): ReplaceEvidenceTrainingCaseRowsOptions {
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
    basePath: required("--base"),
    replacementPath: required("--replacement"),
    outPath: required("--out"),
    summaryPath: required("--summary-out")
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const summary = replaceEvidenceTrainingCaseRows(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
