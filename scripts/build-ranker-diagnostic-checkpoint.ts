// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RankerDiagnosticCheckpointOptions = {
  intakePath: string;
  registryPath: string;
  baselineReportPath: string;
  manifestPath: string;
  reportPath: string;
  reviewQueuePath: string;
  snapshotDir: string;
  outPath: string;
};

export function buildRankerDiagnosticCheckpoint(options: RankerDiagnosticCheckpointOptions): Record<string, unknown> {
  const inputs = {
    intake: loadJson(options.intakePath),
    registry: loadJson(options.registryPath),
    baselineReport: loadJson(options.baselineReportPath),
    manifest: loadJson(options.manifestPath),
    report: loadJson(options.reportPath),
    reviewQueue: loadJson(options.reviewQueuePath)
  };
  const { intake, registry, baselineReport, manifest, report, reviewQueue } = inputs;
  expectValue(intake.schemaVersion, "ranker-corpus-intake.v1", "intake schemaVersion");
  expectValue(registry.schemaVersion, "lineage-registry.v1", "registry schemaVersion");
  expectValue(baselineReport.schemaVersion, "ranker-corpus-materialization-report.v1", "baseline report schemaVersion");
  expectValue(manifest.schemaVersion, "ranker-corpus.v1", "manifest schemaVersion");
  expectValue(report.schemaVersion, "ranker-corpus-materialization-report.v1", "report schemaVersion");
  expectValue(reviewQueue.schemaVersion, "ranker-corpus-review-queue.v1", "review queue schemaVersion");
  if (intake.sealed !== false || manifest.sealed !== false) throw new Error("checkpoint inputs must remain unsealed drafts");
  if (baselineReport.partial === true || report.partial === true) throw new Error("checkpoint reports must be complete");
  if (baselineReport.caseProcessIsolation !== true || report.caseProcessIsolation !== true) {
    throw new Error("checkpoint reports must prove case process isolation");
  }

  const corpusId = string(intake.corpusId, "intake.corpusId");
  for (const [label, artifact] of Object.entries({ baselineReport, manifest, report, reviewQueue })) {
    expectValue(artifact.corpusId, corpusId, `${label}.corpusId`);
  }
  const intakeSha256 = fileSha256(options.intakePath);
  const manifestSha256 = fileSha256(options.manifestPath);
  const reportSha256 = fileSha256(options.reportPath);
  expectValue(baselineReport.intakeSha256, intakeSha256, "baseline report intake hash");
  expectValue(report.intakeSha256, intakeSha256, "report intake hash");
  expectValue(reviewQueue.intakeSha256, intakeSha256, "review queue intake hash");
  expectValue(reviewQueue.manifestSha256, manifestSha256, "review queue manifest hash");
  expectValue(reviewQueue.reportSha256, reportSha256, "review queue report hash");

  const materializer = record(manifest.materializer, "manifest.materializer");
  const currentCommit = string(materializer.kairnCommit, "manifest.materializer.kairnCommit");
  expectValue(materializer.intakeSha256, intakeSha256, "manifest materializer intake hash");
  expectValue(materializer.caseProcessIsolation, true, "manifest case process isolation");
  expectValue(report.kairnCommit, currentCommit, "report kairn commit");
  expectValue(reviewQueue.materializerCommit, currentCommit, "review queue materializer commit");

  const intakeCases = indexedCases(intake.cases, "intake.cases");
  const baselineCases = indexedCases(baselineReport.cases, "baselineReport.cases");
  const manifestCases = indexedCases(manifest.cases, "manifest.cases");
  const reportCases = indexedCases(report.cases, "report.cases");
  const reviewCases = indexedCases(reviewQueue.cases, "reviewQueue.cases");
  for (const [label, cases] of Object.entries({ baselineCases, manifestCases, reportCases, reviewCases })) {
    assertSameCaseSet(intakeCases, cases, label);
  }
  expectValue(report.caseCount, intakeCases.size, "report.caseCount");
  expectValue(baselineReport.caseCount, intakeCases.size, "baselineReport.caseCount");
  expectValue(reviewQueue.caseCount, intakeCases.size, "reviewQueue.caseCount");

  const lineageRole = new Map(
    array(registry.lineages, "registry.lineages").map((value, index) => {
      const row = record(value, `registry.lineages[${index}]`);
      return [string(row.id, `registry.lineages[${index}].id`), string(row.role, `registry.lineages[${index}].role`)] as const;
    })
  );
  for (const [id, item] of intakeCases) {
    const lineageId = string(item.repositoryLineageId, `${id}.repositoryLineageId`);
    expectValue(lineageRole.get(lineageId), item.split, `${id} lineage role`);
  }
  expectValue(path.basename(options.registryPath), intake.lineageRegistry, "intake lineage registry basename");

  for (const [id, item] of reviewCases) {
    const decision = record(item.decision, `${id}.decision`);
    if (decision.reviewer !== null || decision.reviewedAt !== null) {
      throw new Error(`${id}: diagnostic checkpoint cannot contain completed review decisions`);
    }
  }

  const baseline = summarizeReport(baselineReport, baselineCases, intakeCases);
  const current = summarizeReport(report, reportCases, intakeCases);
  const changedCases = [...intakeCases.keys()].sort().flatMap((id) => {
    const before = nullableNumber(baselineCases.get(id)!.officialPatchSourceRecallAt64, `${id} baseline recall@64`);
    const after = nullableNumber(reportCases.get(id)!.officialPatchSourceRecallAt64, `${id} current recall@64`);
    if (before === after || before === null || after === null) return [];
    return [{
      id,
      baselineOfficialPatchRecallAt64: before,
      currentOfficialPatchRecallAt64: after,
      delta: after - before,
      outcome: after > before ? "improved" : "regressed"
    }];
  });
  const snapshotDir = path.resolve(options.snapshotDir);
  const snapshotIntakePath = path.join(snapshotDir, path.basename(options.intakePath));
  const snapshotRegistryPath = path.join(snapshotDir, path.basename(options.registryPath));

  return {
    schemaVersion: "ranker-corpus-diagnostic-checkpoint.v1",
    checkpointId: `${corpusId}-${currentCommit.slice(0, 12)}`,
    corpusId,
    status: "draft_diagnostic_not_promotion_evidence",
    promotionEligible: false,
    publicDataOnly: true,
    trackedSnapshots: {
      intakePath: repoRelative(snapshotIntakePath),
      intakeSha256,
      registryPath: repoRelative(snapshotRegistryPath),
      registrySha256: fileSha256(options.registryPath)
    },
    rawArtifacts: {
      baselineReport: artifactReference(options.baselineReportPath),
      manifest: artifactReference(options.manifestPath),
      report: artifactReference(options.reportPath),
      reviewQueue: artifactReference(options.reviewQueuePath)
    },
    baseline,
    current,
    delta: {
      positiveSourceAnyHitRateAt64: number(current.positiveSourceAnyHitRateAt64) - number(baseline.positiveSourceAnyHitRateAt64),
      officialPatchMeanRecallAt64: number(current.officialPatchMeanRecallAt64) - number(baseline.officialPatchMeanRecallAt64),
      changedCases,
      regressionCount: changedCases.filter((item) => item.outcome === "regressed").length
    },
    curation: {
      requiredSourceReviewCases: integer(reviewQueue.requiredSourceReviewCases, "reviewQueue.requiredSourceReviewCases"),
      explicitNoiseReviewCases: integer(reviewQueue.explicitNoiseReviewCases, "reviewQueue.explicitNoiseReviewCases"),
      readyForSealCases: integer(reviewQueue.readyForSealCases, "reviewQueue.readyForSealCases"),
      decisionsCompleted: 0
    },
    unavailableGates: [
      "candidateRecallAt64",
      "requiredSourceRecallAt5",
      "recallAt1",
      "mrr",
      "calibrationError",
      "verificationAndSourceInvariantNonRegression"
    ],
    disclosure: "Official patch files are weak positives. These diagnostics do not establish required-source recall, calibration quality, verification quality, or token savings."
  };
}

function summarizeReport(
  report: Record<string, unknown>,
  cases: Map<string, Record<string, unknown>>,
  intakeCases: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const rows = [...cases.values()];
  const recalls64 = rows.map((item, index) => nullableNumber(item.officialPatchSourceRecallAt64, `case ${index} recall@64`));
  const recalls128 = rows.map((item, index) => nullableNumber(item.officialPatchSourceRecallAt128, `case ${index} recall@128`));
  const stats = (values: Array<number | null>): Record<string, number | null> => {
    const present = values.filter((value): value is number => value !== null);
    return {
      mean: present.length > 0 ? mean(present) : null,
      full: present.filter((value) => value === 1).length,
      partial: present.filter((value) => value > 0 && value < 1).length,
      zero: present.filter((value) => value === 0).length
    };
  };
  return {
    kairnCommit: string(report.kairnCommit, "report.kairnCommit"),
    caseCount: integer(report.caseCount, "report.caseCount"),
    caseProcessIsolation: report.caseProcessIsolation,
    candidateRecallEligibleCases: integer(report.candidateRecallEligibleCases, "report.candidateRecallEligibleCases"),
    candidateRecallAt64: report.candidateRecallAt64 ?? null,
    positiveSourceAnyHitRateAt64: number(report.positiveSourceAnyHitRateAt64, "report.positiveSourceAnyHitRateAt64"),
    officialPatchMeanRecallAt64: number(report.officialPatchMeanRecallAt64, "report.officialPatchMeanRecallAt64"),
    officialPatchMeanRecallAt128: nullableNumber(report.officialPatchMeanRecallAt128, "report.officialPatchMeanRecallAt128"),
    officialPatchRecallAt64: stats(recalls64),
    officialPatchRecallAt128: stats(recalls128),
    byLanguage: groupedMetrics("language", cases, intakeCases),
    byScenario: groupedMetrics("scenario", cases, intakeCases),
    bySplit: groupedMetrics("split", cases, intakeCases)
  };
}

function groupedMetrics(
  dimension: string,
  cases: Map<string, Record<string, unknown>>,
  intakeCases: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const [id, item] of cases) {
    const value = string(intakeCases.get(id)![dimension], `${id}.${dimension}`);
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, rows]) => {
    const recalls = rows.map((item) => number(item.officialPatchSourceRecallAt64, `${key} recall@64`));
    return [key, {
      cases: rows.length,
      positiveSourceAnyHitRateAt64: rows.filter((item) => item.positiveSourceHitAt64 === true).length / rows.length,
      officialPatchMeanRecallAt64: mean(recalls)
    }];
  }));
}

function indexedCases(value: unknown, label: string): Map<string, Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  array(value, label).forEach((item, index) => {
    const row = record(item, `${label}[${index}]`);
    const id = string(row.id, `${label}[${index}].id`);
    if (output.has(id)) throw new Error(`${label} contains duplicate case '${id}'`);
    output.set(id, row);
  });
  return output;
}

function assertSameCaseSet(expected: Map<string, unknown>, actual: Map<string, unknown>, label: string): void {
  const missing = [...expected.keys()].filter((id) => !actual.has(id));
  const extra = [...actual.keys()].filter((id) => !expected.has(id));
  if (missing.length > 0 || extra.length > 0) throw new Error(`${label} case set mismatch`);
}

function loadJson(filePath: string): Record<string, unknown> {
  return record(JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")), filePath);
}

function artifactReference(filePath: string): Record<string, unknown> {
  const resolved = path.resolve(filePath);
  return { fileName: path.basename(resolved), sha256: fileSha256(resolved), bytes: fs.statSync(resolved).size };
}

function repoRelative(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join("/");
}

function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(path.resolve(filePath))).digest("hex");
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function expectValue(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function number(value: unknown, label = "value"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : number(value, label);
}

function integer(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseArgs(argv: string[]): RankerDiagnosticCheckpointOptions {
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
    registryPath: required("--registry"),
    baselineReportPath: required("--baseline-report"),
    manifestPath: required("--manifest"),
    reportPath: required("--report"),
    reviewQueuePath: required("--review-queue"),
    snapshotDir: required("--snapshot-dir"),
    outPath: required("--out")
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const checkpoint = buildRankerDiagnosticCheckpoint(options);
    const snapshotDir = path.resolve(options.snapshotDir);
    const target = path.resolve(options.outPath);
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(options.intakePath), path.join(snapshotDir, path.basename(options.intakePath)));
    fs.copyFileSync(path.resolve(options.registryPath), path.join(snapshotDir, path.basename(options.registryPath)));
    fs.writeFileSync(target, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ out: target, checkpointId: checkpoint.checkpointId, status: checkpoint.status }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
