// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RankerReadinessCheckpointOptions = {
  intakePath: string;
  registryPath: string;
  reviewApplicationPath: string;
  reviewDecisionsPath: string;
  manifestPath: string;
  reportPath: string;
  corpusPath: string;
  corpusSummaryPath: string;
  outPath: string;
};

type JoinedCase = {
  id: string;
  split: string;
  language: string;
  scenario: string;
  requiredSourceCount: number;
  recallAt64: number | null;
  missingRequiredSourceFiles: string[];
};

export function buildRankerReadinessCheckpoint(
  options: RankerReadinessCheckpointOptions
): Record<string, unknown> {
  const intake = loadJson(options.intakePath);
  const registry = loadJson(options.registryPath);
  const reviewApplication = loadJson(options.reviewApplicationPath);
  const reviewDecisions = loadJson(options.reviewDecisionsPath);
  const manifest = loadJson(options.manifestPath);
  const report = loadJson(options.reportPath);
  const corpusSummary = loadJson(options.corpusSummaryPath);

  expectValue(intake.schemaVersion, "ranker-corpus-intake.v1", "intake schemaVersion");
  expectValue(registry.schemaVersion, "lineage-registry.v1", "registry schemaVersion");
  expectValue(reviewApplication.schemaVersion, "ranker-corpus-review-application.v1", "review application schemaVersion");
  expectValue(reviewDecisions.schemaVersion, "ranker-corpus-review-decision-checkpoint.v1", "review decisions schemaVersion");
  expectValue(manifest.schemaVersion, "ranker-corpus.v1", "manifest schemaVersion");
  expectValue(report.schemaVersion, "ranker-corpus-materialization-report.v1", "report schemaVersion");
  expectValue(corpusSummary.schemaVersion, "ranker-corpus-summary.v1", "corpus summary schemaVersion");
  if (intake.sealed !== true || reviewApplication.sealed !== true || manifest.sealed !== true || corpusSummary.sealed !== true) {
    throw new Error("readiness checkpoint inputs must be sealed");
  }
  if (intake.sampleOnly === true || manifest.sampleOnly === true || report.sampleOnly === true || corpusSummary.sampleOnly === true) {
    throw new Error("sample artifacts cannot become readiness evidence");
  }
  if (report.caseProcessIsolation !== true || record(manifest.materializer, "manifest.materializer").caseProcessIsolation !== true) {
    throw new Error("readiness evidence requires caseProcessIsolation=true");
  }
  if (report.partial === true) throw new Error("partial materialization reports cannot become readiness evidence");
  expectValue(reviewDecisions.status, "review_complete", "review decisions status");
  expectValue(reviewDecisions.promotionEligible, false, "review decisions promotionEligible");
  expectValue(manifest.status, "materialized", "manifest status");

  const corpusId = string(intake.corpusId, "intake.corpusId");
  for (const [label, artifact] of Object.entries({
    reviewApplication,
    reviewDecisions,
    manifest,
    report,
    corpusSummary
  })) {
    expectValue(artifact.corpusId, corpusId, `${label}.corpusId`);
  }

  const hashes = {
    intake: fileSha256(options.intakePath),
    registry: fileSha256(options.registryPath),
    reviewApplication: fileSha256(options.reviewApplicationPath),
    reviewDecisions: fileSha256(options.reviewDecisionsPath),
    manifest: fileSha256(options.manifestPath),
    report: fileSha256(options.reportPath),
    corpus: fileSha256(options.corpusPath),
    corpusSummary: fileSha256(options.corpusSummaryPath)
  };
  const applicationOutput = record(reviewApplication.output, "reviewApplication.output");
  expectValue(applicationOutput.intakeSha256, hashes.intake, "reviewed intake hash");
  expectValue(applicationOutput.lineageRegistrySha256, hashes.registry, "reviewed registry hash");
  expectValue(path.basename(options.registryPath), intake.lineageRegistry, "intake lineage registry");
  expectValue(path.basename(options.registryPath), manifest.lineageRegistry, "manifest lineage registry");
  const materializer = record(manifest.materializer, "manifest.materializer");
  const materializerCommit = string(materializer.kairnCommit, "manifest.materializer.kairnCommit");
  expectValue(materializer.intakeSha256, hashes.intake, "manifest intake hash");
  expectValue(report.intakeSha256, hashes.intake, "report intake hash");
  expectValue(report.kairnCommit, materializerCommit, "materializer commit");
  expectValue(corpusSummary.manifestSha256, hashes.manifest, "corpus summary manifest hash");
  expectValue(corpusSummary.lineageRegistrySha256, hashes.registry, "corpus summary registry hash");
  expectValue(corpusSummary.corpusSha256, hashes.corpus, "flattened corpus hash");

  const decisionRows = array(reviewDecisions.decisions, "reviewDecisions.decisions")
    .map((value, index) => {
      const row = record(value, `reviewDecisions.decisions[${index}]`);
      return {
        id: string(row.id, `reviewDecisions.decisions[${index}].id`),
        decision: record(row.decision, `reviewDecisions.decisions[${index}].decision`)
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  expectValue(
    reviewApplication.decisionsSha256,
    sha256(JSON.stringify(decisionRows)),
    "review application decisions hash"
  );

  const intakeCases = indexedCases(intake.cases, "intake.cases");
  const manifestCases = indexedCases(manifest.cases, "manifest.cases");
  const reportCases = indexedCases(report.cases, "report.cases");
  const decisionCases = new Map(decisionRows.map((row) => [row.id, row]));
  for (const [label, cases] of Object.entries({ manifestCases, reportCases, decisionCases })) {
    assertSameCaseSet(intakeCases, cases, label);
  }
  const caseCount = intakeCases.size;
  for (const [label, value] of Object.entries({
    "reviewApplication.caseCount": reviewApplication.caseCount,
    "reviewDecisions.caseCount": reviewDecisions.caseCount,
    "reviewDecisions.completedCases": reviewDecisions.completedCases,
    "report.caseCount": report.caseCount,
    "corpusSummary.caseCount": corpusSummary.caseCount
  })) {
    expectValue(value, caseCount, label);
  }
  expectValue(reviewDecisions.pendingCases, 0, "reviewDecisions.pendingCases");

  const joinedCases = [...intakeCases.entries()].map(([id, intakeCase]): JoinedCase => {
    const manifestCase = manifestCases.get(id)!;
    const reportCase = reportCases.get(id)!;
    const requiredSources = pathArray(intakeCase.requiredSourceFiles, `${id}.requiredSourceFiles`);
    const missingRequiredSourceFiles = pathArray(
      reportCase.missingRequiredSourceFiles,
      `${id}.missingRequiredSourceFiles`
    );
    const missingExplicitNoiseFiles = pathArray(
      reportCase.missingExplicitNoiseFiles,
      `${id}.missingExplicitNoiseFiles`
    );
    if (missingExplicitNoiseFiles.length > 0) {
      throw new Error(`${id}: materialization omitted reviewed explicit-noise candidates`);
    }
    expectValue(manifestCase.requiredSourceOracleCount, requiredSources.length, `${id}.requiredSourceOracleCount`);
    expectValue(
      manifestCase.requiredSourceOracleSha256,
      sha256([...requiredSources].map(normalizePath).sort().join("\n")),
      `${id}.requiredSourceOracleSha256`
    );
    const recallAt64 = nullableNumber(reportCase.requiredSourceRecallAt64, `${id}.requiredSourceRecallAt64`);
    if ((requiredSources.length > 0) !== (recallAt64 !== null)) {
      throw new Error(`${id}: required-source oracle and recall eligibility disagree`);
    }
    return {
      id,
      split: string(intakeCase.split, `${id}.split`),
      language: string(intakeCase.language, `${id}.language`),
      scenario: string(intakeCase.scenario, `${id}.scenario`),
      requiredSourceCount: requiredSources.length,
      recallAt64,
      missingRequiredSourceFiles
    };
  });

  const oracleCases = joinedCases.filter((item) => item.recallAt64 !== null);
  const holdoutCases = joinedCases.filter((item) => item.split === "holdout");
  if (holdoutCases.some((item) => item.recallAt64 === null)) {
    throw new Error("every holdout case must have an independently reviewed required-source oracle");
  }
  expectValue(report.candidateRecallEligibleCases, oracleCases.length, "report candidateRecallEligibleCases");
  expectValue(reviewApplication.requiredSourceOracleCases, oracleCases.length, "review application oracle cases");
  expectValue(report.candidateRecallAt64, fullRecallRate(oracleCases), "report candidateRecallAt64");

  const explicitNoiseLabels = [...intakeCases.entries()].reduce(
    (total, [id, item]) => total + pathArray(item.explicitNoiseFiles, `${id}.explicitNoiseFiles`).length,
    0
  );
  expectValue(reviewApplication.explicitNoiseLabels, explicitNoiseLabels, "review application explicit-noise labels");

  const zeroPositiveCases = [...manifestCases.values()].filter((item, caseIndex) =>
    !array(item.candidates, `manifest.cases[${caseIndex}].candidates`).some((candidate, candidateIndex) =>
      record(candidate, `manifest.cases[${caseIndex}].candidates[${candidateIndex}]`).label === 1
    )
  ).length;
  expectValue(corpusSummary.zeroPositiveCases, zeroPositiveCases, "corpus summary zeroPositiveCases");

  const strictReviewedOracles = recallSummary(oracleCases);
  const holdout = recallSummary(holdoutCases);
  const reviewedByLanguage = groupRecall(oracleCases, "language");
  const holdoutByLanguage = groupRecall(holdoutCases, "language");
  const reviewedBySplit = groupRecall(oracleCases, "split");
  const overallGate = strictReviewedOracles.fullRecallRate >= 0.99;
  const perLanguageGate = Object.keys(reviewedByLanguage).length > 0
    && Object.values(reviewedByLanguage).every((value) => value.fullRecallRate >= 0.95);
  const trainingEligible = overallGate && perLanguageGate;
  const misses = oracleCases
    .filter((item) => item.recallAt64 !== 1)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      split: item.split,
      language: item.language,
      scenario: item.scenario,
      requiredSourceCount: item.requiredSourceCount,
      recallAt64: item.recallAt64,
      missingRequiredSourceFiles: item.missingRequiredSourceFiles
    }));

  return {
    schemaVersion: "ranker-corpus-readiness-checkpoint.v1",
    checkpointId: `${corpusId}-${materializerCommit.slice(0, 12)}`,
    corpusId,
    status: trainingEligible ? "ready_for_ranker_training" : "blocked_candidate_recall",
    promotionEligible: false,
    trainingEligible,
    publicDataOnly: true,
    artifacts: {
      reviewedIntake: artifactReference(options.intakePath),
      lineageRegistry: artifactReference(options.registryPath),
      reviewApplication: artifactReference(options.reviewApplicationPath),
      reviewDecisions: artifactReference(options.reviewDecisionsPath),
      sealedManifest: artifactReference(options.manifestPath),
      materializationReport: artifactReference(options.reportPath),
      flattenedCorpus: artifactReference(options.corpusPath),
      corpusSummary: artifactReference(options.corpusSummaryPath)
    },
    review: {
      status: reviewDecisions.status,
      caseCount,
      completedCases: integer(reviewDecisions.completedCases, "reviewDecisions.completedCases"),
      pendingCases: integer(reviewDecisions.pendingCases, "reviewDecisions.pendingCases"),
      reviewers: array(reviewApplication.reviewers, "reviewApplication.reviewers"),
      requiredSourceOracleCases: oracleCases.length,
      explicitNoiseLabels,
      oracleSelectionBySplit: Object.fromEntries(
        Object.entries(reviewedBySplit).map(([key, value]) => [key, value.cases])
      )
    },
    materialization: {
      kairnCommit: materializerCommit,
      candidateLimit: integer(materializer.candidateLimit, "manifest.materializer.candidateLimit"),
      graphHops: integer(materializer.graphHops, "manifest.materializer.graphHops"),
      caseProcessIsolation: true,
      caseCount,
      candidateRows: integer(corpusSummary.candidateRows, "corpusSummary.candidateRows"),
      labeledRows: integer(corpusSummary.labeledRows, "corpusSummary.labeledRows"),
      unlabeledRows: integer(corpusSummary.unlabeledRows, "corpusSummary.unlabeledRows"),
      zeroPositiveCases
    },
    candidateRecall: {
      strictReviewedOracles,
      holdout,
      reviewedByLanguage,
      holdoutByLanguage,
      reviewedBySplit,
      positiveSourceAnyHitRateAt64: number(report.positiveSourceAnyHitRateAt64, "report.positiveSourceAnyHitRateAt64"),
      officialPatchMeanRecallAt64: number(report.officialPatchMeanRecallAt64, "report.officialPatchMeanRecallAt64"),
      officialPatchMeanRecallAt128: number(report.officialPatchMeanRecallAt128, "report.officialPatchMeanRecallAt128"),
      missingRequiredSourceFileCount: misses.reduce(
        (total, item) => total + item.missingRequiredSourceFiles.length,
        0
      ),
      misses
    },
    gates: {
      candidateRecallAt64Overall: {
        threshold: 0.99,
        actual: strictReviewedOracles.fullRecallRate,
        passed: overallGate
      },
      candidateRecallAt64PerLanguage: {
        threshold: 0.95,
        actual: Object.fromEntries(
          Object.entries(reviewedByLanguage).map(([key, value]) => [key, value.fullRecallRate])
        ),
        passed: perLanguageGate
      }
    },
    nextMechanismClasses: [
      "query-term and symbol candidate coverage",
      "direct import/include graph completeness",
      "source/test and failure/source relationships",
      "bounded sibling and companion production-source expansion"
    ],
    disclosures: [
      "The 30 holdout cases all received independent required-source review.",
      "Train and calibration required-source review is miss-enriched, so strict reviewed-oracle recall is not an unbiased all-split estimate.",
      "A calibrated ranker cannot recover a required source file that is absent from candidate@64.",
      "This checkpoint is pre-training readiness evidence, not model-quality, token-efficiency, or live-agent comparison evidence."
    ]
  };
}

function recallSummary(cases: JoinedCase[]): {
  cases: number;
  fullCases: number;
  partialCases: number;
  zeroCases: number;
  fullRecallRate: number;
  meanFileRecall: number;
} {
  if (cases.length === 0) {
    return { cases: 0, fullCases: 0, partialCases: 0, zeroCases: 0, fullRecallRate: 0, meanFileRecall: 0 };
  }
  const recalls = cases.map((item) => number(item.recallAt64, `${item.id}.recallAt64`));
  return {
    cases: cases.length,
    fullCases: recalls.filter((value) => value === 1).length,
    partialCases: recalls.filter((value) => value > 0 && value < 1).length,
    zeroCases: recalls.filter((value) => value === 0).length,
    fullRecallRate: recalls.filter((value) => value === 1).length / cases.length,
    meanFileRecall: mean(recalls)
  };
}

function fullRecallRate(cases: JoinedCase[]): number {
  return recallSummary(cases).fullRecallRate;
}

function groupRecall(cases: JoinedCase[], dimension: "language" | "split"): Record<string, ReturnType<typeof recallSummary>> {
  const groups = new Map<string, JoinedCase[]>();
  for (const item of cases) groups.set(item[dimension], [...(groups.get(item[dimension]) ?? []), item]);
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, rows]) => [key, recallSummary(rows)])
  );
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
  return {
    fileName: path.basename(resolved),
    sha256: fileSha256(resolved),
    bytes: fs.statSync(resolved).size
  };
}

function fileSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(path.resolve(filePath))).digest("hex");
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function pathArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => normalizePath(string(item, `${label}[${index}]`)));
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function expectValue(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function number(value: unknown, label: string): number {
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

function parseArgs(argv: string[]): RankerReadinessCheckpointOptions {
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
    reviewApplicationPath: required("--review-application"),
    reviewDecisionsPath: required("--review-decisions"),
    manifestPath: required("--manifest"),
    reportPath: required("--report"),
    corpusPath: required("--corpus"),
    corpusSummaryPath: required("--corpus-summary"),
    outPath: required("--out")
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const checkpoint = buildRankerReadinessCheckpoint(options);
    const target = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      out: target,
      checkpointId: checkpoint.checkpointId,
      status: checkpoint.status,
      trainingEligible: checkpoint.trainingEligible
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
