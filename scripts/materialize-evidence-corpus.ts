// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { EVIDENCE_FEATURE_SCHEMA_VERSION } from "../src/retrieval/evidenceModel.js";
import type { EvidenceCandidate } from "../src/types.js";

type Split = "train" | "calibration" | "holdout";
type Language = "python" | "typescript" | "go" | "java" | "cpp";
type Scenario = "source_localization" | "failure_first" | "long_session";
type Origin = "public_benchmark" | "public_patch" | "synthetic";

type IntakeCase = {
  id: string;
  split: Split;
  language: Language;
  scenario: Scenario;
  repositoryLineageId: string;
  repositoryUrl: string;
  repositoryRef: string;
  publicSourceUrl: string;
  dataOrigin: Origin;
  prompt: string;
  requiredSourceFiles: string[];
  officialPatchSourceFiles: string[];
  verifiedObservedReadTouchFiles: string[];
  qualityVerified: boolean;
  explicitNoiseFiles: string[];
  syntheticVariantOf?: string;
  syntheticVariantIndex?: 1 | 2;
  localFixtureRoot?: string;
};

type Intake = {
  schemaVersion: "ranker-corpus-intake.v1";
  corpusId: string;
  featureSchemaVersion: string;
  sealed: boolean;
  sampleOnly: boolean;
  lineageRegistry: string;
  cases: IntakeCase[];
};

export type MaterializeOptions = {
  intakePath: string;
  outPath: string;
  reportPath: string;
  cacheDir?: string;
  allowSample?: boolean;
  allowLocalFixture?: boolean;
  draft?: boolean;
  limit?: number;
};

const INTAKE_KEYS = new Set([
  "id", "split", "language", "scenario", "repositoryLineageId", "repositoryUrl",
  "repositoryRef", "publicSourceUrl", "dataOrigin", "prompt", "requiredSourceFiles",
  "officialPatchSourceFiles", "verifiedObservedReadTouchFiles", "qualityVerified",
  "explicitNoiseFiles", "syntheticVariantOf", "syntheticVariantIndex", "localFixtureRoot"
]);

export async function materializeEvidenceCorpus(options: MaterializeOptions): Promise<{
  manifestPath: string;
  reportPath: string;
  caseCount: number;
}> {
  const intakePath = path.resolve(options.intakePath);
  const outPath = path.resolve(options.outPath);
  const reportPath = path.resolve(options.reportPath);
  const intake = parseIntake(JSON.parse(fs.readFileSync(intakePath, "utf8")), {
    allowSample: options.allowSample === true,
    allowLocalFixture: options.allowLocalFixture === true,
    draft: options.draft === true
  });
  const intakeDir = path.dirname(intakePath);
  const registryPath = path.resolve(intakeDir, intake.lineageRegistry);
  assertWithin(intakeDir, registryPath, "lineageRegistry");
  validateLineageAssignments(registryPath, intake.cases);

  const kairnRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const kairnCommit = git(["rev-parse", "HEAD"], kairnRoot);
  if (!intake.sampleOnly && git(["status", "--porcelain"], kairnRoot)) {
    throw new Error("production corpus materialization requires a clean Kairn checkout");
  }
  const cacheDir = path.resolve(options.cacheDir ?? path.join(kairnRoot, "artifacts", "ranker-checkouts"));
  fs.mkdirSync(cacheDir, { recursive: true });

  const materializedCases: Array<Record<string, unknown>> = [];
  const reportCases: Array<Record<string, unknown>> = [];
  const orderedCases = [...intake.cases].sort((left, right) => left.id.localeCompare(right.id));
  const selectedCases = options.limit ? orderedCases.slice(0, options.limit) : orderedCases;
  if (options.limit && !options.draft) throw new Error("--limit is allowed only with --draft");
  for (const intakeCase of selectedCases) {
    const checkout = resolveCheckout(intakeCase, cacheDir, {
      allowLocalFixture: options.allowLocalFixture === true,
      sampleOnly: intake.sampleOnly
    });
    const runtime = new KairnRuntime(checkout.root);
    try {
      const inspection = await runtime.inspectEvidenceCandidates({ query: intakeCase.prompt, limit: 64 });
      if (!options.draft && inspection.candidates.length < 7) {
        throw new Error(`${intakeCase.id}: candidate generator returned fewer than seven candidates`);
      }
      const labels = buildLabels(intakeCase);
      const candidatePaths = new Set(inspection.candidates.map((candidate) => normalizePath(candidate.path)));
      const missingLabels = [...labels.keys()].filter((candidatePath) => !candidatePaths.has(candidatePath));
      const hardLabelPaths = new Set([
        ...intakeCase.requiredSourceFiles,
        ...intakeCase.explicitNoiseFiles
      ].map(normalizePath));
      const missingHardLabels = missingLabels.filter((candidatePath) => hardLabelPaths.has(candidatePath));
      if (!options.draft && missingHardLabels.length > 0) {
        throw new Error(`${intakeCase.id}: required/noise files missed the candidate@64 boundary: ${missingHardLabels.join(", ")}`);
      }
      const requiredRecall = intakeCase.requiredSourceFiles.length > 0
        ? fractionRecalled(intakeCase.requiredSourceFiles, candidatePaths)
        : null;
      const patchRecall = intakeCase.officialPatchSourceFiles.length > 0
        ? fractionRecalled(intakeCase.officialPatchSourceFiles, candidatePaths)
        : null;
      if (!options.draft && requiredRecall !== null && requiredRecall !== 1) {
        throw new Error(`${intakeCase.id}: required-source candidate recall@64 is ${requiredRecall}`);
      }
      const candidates = inspection.candidates.map((candidate) => labeledCandidate(candidate, labels));
      const explicitNegatives = candidates.filter((candidate) => candidate.labelProvenance === "explicit_noise_or_excluded").length;
      const positiveCandidates = candidates.filter((candidate) => candidate.label === 1).length;
      if (!options.draft && positiveCandidates === 0) {
        throw new Error(`${intakeCase.id}: no approved positive source is present in candidate@64`);
      }
      if (!options.draft && explicitNegatives < 6) {
        throw new Error(`${intakeCase.id}: at least six generated candidates must be curated as explicit noise`);
      }
      const resolvedRef = intakeCase.localFixtureRoot
        ? git(["rev-parse", "HEAD"], checkout.root)
        : intakeCase.repositoryRef;
      materializedCases.push({
        id: intakeCase.id,
        split: intakeCase.split,
        language: intakeCase.language,
        scenario: intakeCase.scenario,
        repositoryLineageId: intakeCase.repositoryLineageId,
        repositoryUrl: intakeCase.repositoryUrl,
        repositoryRef: resolvedRef,
        publicSourceUrl: intakeCase.publicSourceUrl,
        dataOrigin: intakeCase.dataOrigin,
        prompt: intakeCase.prompt,
        querySha256: sha256(intakeCase.prompt),
        ...(intakeCase.syntheticVariantOf ? {
          syntheticVariantOf: intakeCase.syntheticVariantOf,
          syntheticVariantIndex: intakeCase.syntheticVariantIndex
        } : {}),
        candidates
      });
      reportCases.push({
        id: intakeCase.id,
        repositoryRef: resolvedRef,
        initialCandidateCount: inspection.initialCandidateCount,
        enrichedCandidateCount: inspection.enrichedCandidateCount,
        exportedCandidateCount: candidates.length,
        requiredSourceRecallAt64: requiredRecall,
        officialPatchSourceRecallAt64: patchRecall,
        positiveSourceHitAt64: positiveCandidates > 0,
        explicitNegativeCount: explicitNegatives,
        missingLabeledFiles: missingLabels,
        missingRequiredOrNoiseFiles: missingHardLabels,
        candidatePathsSha256: sha256(candidates.map((candidate) => candidate.path).join("\n")),
        ...(options.draft ? {
          candidates: inspection.candidates.map((candidate) => ({ path: candidate.path, reasons: candidate.reasons }))
        } : {})
      });
    } finally {
      runtime.close();
      checkout.cleanup();
    }
  }

  const relativeRegistry = normalizePath(path.relative(path.dirname(outPath), registryPath));
  const manifest = {
    schemaVersion: "ranker-corpus.v1",
    corpusId: intake.corpusId,
    featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
    sealed: options.draft !== true,
    sampleOnly: intake.sampleOnly,
    status: options.draft ? "draft_for_label_review" : "materialized",
    lineageRegistry: relativeRegistry,
    materializer: {
      schemaVersion: "ranker-corpus-materializer.v1",
      kairnCommit,
      intakeSha256: sha256(fs.readFileSync(intakePath)),
      candidateLimit: 64,
      graphHops: 1
    },
    cases: materializedCases
  };
  const report = {
    schemaVersion: "ranker-corpus-materialization-report.v1",
    corpusId: intake.corpusId,
    sampleOnly: intake.sampleOnly,
    kairnCommit,
    intakeSha256: sha256(fs.readFileSync(intakePath)),
    caseCount: materializedCases.length,
    candidateRecallEligibleCases: reportCases.filter((row) => row.requiredSourceRecallAt64 !== null).length,
    candidateRecallAt64: fullRecallRate(reportCases, "requiredSourceRecallAt64"),
    positiveSourceAnyHitRateAt64: booleanRate(reportCases, "positiveSourceHitAt64"),
    officialPatchMeanRecallAt64: meanNullable(reportCases, "officialPatchSourceRecallAt64"),
    cases: reportCases
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { manifestPath: outPath, reportPath, caseCount: materializedCases.length };
}

function parseIntake(value: unknown, options: { allowSample: boolean; allowLocalFixture: boolean; draft: boolean }): Intake {
  const root = record(value, "intake");
  if (root.schemaVersion !== "ranker-corpus-intake.v1") throw new Error("intake schemaVersion must be ranker-corpus-intake.v1");
  if (root.featureSchemaVersion !== EVIDENCE_FEATURE_SCHEMA_VERSION) {
    throw new Error(`featureSchemaVersion must be ${EVIDENCE_FEATURE_SCHEMA_VERSION}`);
  }
  if (root.sealed !== true && !options.draft) throw new Error("corpus intake must be sealed before materialization");
  if (root.sealed !== true && root.sealed !== false) throw new Error("sealed must be a boolean");
  if (typeof root.sampleOnly !== "boolean") throw new Error("sampleOnly must be a boolean");
  if (root.sampleOnly && !options.allowSample) throw new Error("sample-only intake requires --allow-sample");
  const cases = array(root.cases, "cases").map((item, index) => parseCase(item, index, root.sampleOnly as boolean, options));
  if (cases.length === 0) throw new Error("cases must not be empty");
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("case ids must be unique");
  return {
    schemaVersion: "ranker-corpus-intake.v1",
    corpusId: string(root.corpusId, "corpusId"),
    featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
    sealed: root.sealed as boolean,
    sampleOnly: root.sampleOnly as boolean,
    lineageRegistry: string(root.lineageRegistry, "lineageRegistry"),
    cases
  };
}

function parseCase(
  value: unknown,
  index: number,
  sampleOnly: boolean,
  options: { allowLocalFixture: boolean }
): IntakeCase {
  const label = `cases[${index}]`;
  const row = record(value, label);
  const unknown = Object.keys(row).filter((key) => !INTAKE_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  const split = oneOf(row.split, ["train", "calibration", "holdout"] as const, `${label}.split`);
  const language = oneOf(row.language, ["python", "typescript", "go", "java", "cpp"] as const, `${label}.language`);
  const scenario = oneOf(row.scenario, ["source_localization", "failure_first", "long_session"] as const, `${label}.scenario`);
  const dataOrigin = oneOf(row.dataOrigin, ["public_benchmark", "public_patch", "synthetic"] as const, `${label}.dataOrigin`);
  const repositoryUrl = publicHttps(row.repositoryUrl, `${label}.repositoryUrl`);
  const repositoryLineageId = publicHttps(row.repositoryLineageId, `${label}.repositoryLineageId`).replace(/\/$/, "");
  if (repositoryLineageId !== repositoryUrl.replace(/\.git$/i, "").replace(/\/$/, "")) {
    throw new Error(`${label}: repositoryLineageId must be the canonical repositoryUrl without .git`);
  }
  const repositoryRef = string(row.repositoryRef, `${label}.repositoryRef`);
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(repositoryRef)) {
    throw new Error(`${label}.repositoryRef must be a full immutable commit hash`);
  }
  const localFixtureRoot = optionalString(row.localFixtureRoot, `${label}.localFixtureRoot`);
  if (localFixtureRoot && (!sampleOnly || !options.allowLocalFixture)) {
    throw new Error(`${label}.localFixtureRoot is allowed only for an explicitly enabled sample intake`);
  }
  const qualityVerified = row.qualityVerified;
  if (typeof qualityVerified !== "boolean") throw new Error(`${label}.qualityVerified must be a boolean`);
  const verifiedObservedReadTouchFiles = pathArray(row.verifiedObservedReadTouchFiles, `${label}.verifiedObservedReadTouchFiles`);
  if (verifiedObservedReadTouchFiles.length > 0 && !qualityVerified) {
    throw new Error(`${label}: observed read/touch labels require qualityVerified=true`);
  }
  const syntheticVariantOf = optionalString(row.syntheticVariantOf, `${label}.syntheticVariantOf`);
  const syntheticVariantIndex = row.syntheticVariantIndex;
  if (dataOrigin === "synthetic") {
    if (split !== "train" || !syntheticVariantOf || (syntheticVariantIndex !== 1 && syntheticVariantIndex !== 2)) {
      throw new Error(`${label}: synthetic cases require train split, parent id, and variant index 1 or 2`);
    }
  } else if (syntheticVariantOf !== undefined || syntheticVariantIndex !== undefined) {
    throw new Error(`${label}: natural cases must omit synthetic variant fields`);
  }
  const requiredSourceFiles = pathArray(row.requiredSourceFiles, `${label}.requiredSourceFiles`);
  const officialPatchSourceFiles = pathArray(row.officialPatchSourceFiles, `${label}.officialPatchSourceFiles`);
  if (requiredSourceFiles.length === 0 && officialPatchSourceFiles.length === 0 && verifiedObservedReadTouchFiles.length === 0) {
    throw new Error(`${label}: at least one source-positive label is required`);
  }
  return {
    id: string(row.id, `${label}.id`), split, language, scenario, repositoryLineageId,
    repositoryUrl, repositoryRef,
    publicSourceUrl: publicHttps(row.publicSourceUrl, `${label}.publicSourceUrl`, { allowQuery: true }),
    dataOrigin,
    prompt: string(row.prompt, `${label}.prompt`),
    requiredSourceFiles,
    officialPatchSourceFiles,
    verifiedObservedReadTouchFiles,
    qualityVerified,
    explicitNoiseFiles: pathArray(row.explicitNoiseFiles, `${label}.explicitNoiseFiles`),
    ...(syntheticVariantOf ? { syntheticVariantOf, syntheticVariantIndex: syntheticVariantIndex as 1 | 2 } : {}),
    ...(localFixtureRoot ? { localFixtureRoot: path.resolve(localFixtureRoot) } : {})
  };
}

function resolveCheckout(
  intakeCase: IntakeCase,
  cacheDir: string,
  options: { allowLocalFixture: boolean; sampleOnly: boolean }
): { root: string; cleanup: () => void } {
  if (intakeCase.localFixtureRoot) {
    if (!options.allowLocalFixture || !options.sampleOnly) throw new Error("local fixture checkout is not authorized");
    const root = path.resolve(intakeCase.localFixtureRoot);
    if (git(["rev-parse", "HEAD"], root) !== intakeCase.repositoryRef) {
      throw new Error(`${intakeCase.id}: local fixture HEAD does not match repositoryRef`);
    }
    return { root, cleanup: () => undefined };
  }
  const repositoryKey = sha256(intakeCase.repositoryUrl).slice(0, 24);
  const repositoriesDir = path.join(cacheDir, "repositories");
  const worktreesDir = path.join(cacheDir, "worktrees");
  fs.mkdirSync(repositoriesDir, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  const repositoryCache = path.join(repositoriesDir, `${repositoryKey}.git`);
  if (!fs.existsSync(repositoryCache)) {
    const temporary = path.join(repositoriesDir, `${repositoryKey}.tmp-${crypto.randomUUID()}.git`);
    try {
      git(["clone", "--quiet", "--filter=blob:none", "--bare", intakeCase.repositoryUrl, temporary], repositoriesDir);
      fs.renameSync(temporary, repositoryCache);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  const remote = git(["remote", "get-url", "origin"], repositoryCache).replace(/\.git$/i, "").replace(/\/$/, "");
  const expected = intakeCase.repositoryUrl.replace(/\.git$/i, "").replace(/\/$/, "");
  if (remote !== expected) throw new Error(`${intakeCase.id}: cached checkout remote mismatch`);
  git(["fetch", "--quiet", "--depth=1", "origin", intakeCase.repositoryRef], repositoryCache);
  const checkout = path.join(worktreesDir, `${repositoryKey}-${intakeCase.repositoryRef.slice(0, 12)}-${crypto.randomUUID()}`);
  git(["worktree", "add", "--quiet", "--detach", checkout, intakeCase.repositoryRef], repositoryCache);
  if (git(["rev-parse", "HEAD"], checkout) !== intakeCase.repositoryRef) throw new Error(`${intakeCase.id}: worktree commit mismatch`);
  return {
    root: checkout,
    cleanup: () => {
      const statePath = path.join(checkout, ".kairn");
      if (fs.existsSync(statePath)) fs.rmSync(statePath, { recursive: true, force: true });
      if (fs.existsSync(checkout)) git(["worktree", "remove", checkout], repositoryCache);
    }
  };
}

function buildLabels(intakeCase: IntakeCase): Map<string, { label: 0 | 1; weight: number; provenance: string }> {
  const labels = new Map<string, { label: 0 | 1; weight: number; provenance: string }>();
  const assign = (filePath: string, label: 0 | 1, weight: number, provenance: string): void => {
    const normalized = normalizePath(filePath);
    const current = labels.get(normalized);
    if (current && current.label !== label) throw new Error(`${intakeCase.id}: conflicting labels for ${normalized}`);
    if (!current || weight > current.weight) labels.set(normalized, { label, weight, provenance });
  };
  intakeCase.verifiedObservedReadTouchFiles.forEach((filePath) => assign(filePath, 1, 0.25, "quality_passing_observed_read_touch"));
  intakeCase.officialPatchSourceFiles.forEach((filePath) => assign(filePath, 1, 0.75, "verified_official_patch_source"));
  intakeCase.requiredSourceFiles.forEach((filePath) => assign(filePath, 1, 1, "required_source_oracle"));
  intakeCase.explicitNoiseFiles.forEach((filePath) => assign(filePath, 0, 1, "explicit_noise_or_excluded"));
  return labels;
}

function labeledCandidate(
  candidate: EvidenceCandidate,
  labels: Map<string, { label: 0 | 1; weight: number; provenance: string }>
): Record<string, unknown> {
  const curated = labels.get(normalizePath(candidate.path));
  return {
    path: normalizePath(candidate.path),
    features: candidate.features,
    ...(curated ? {
      label: curated.label,
      labelWeight: curated.weight,
      labelProvenance: curated.provenance
    } : { label: null })
  };
}

function validateLineageAssignments(registryPath: string, cases: IntakeCase[]): void {
  const root = record(JSON.parse(fs.readFileSync(registryPath, "utf8")), "lineage registry");
  if (root.schemaVersion !== "lineage-registry.v1") throw new Error("lineage registry schemaVersion must be lineage-registry.v1");
  const roles = new Map(array(root.lineages, "lineages").map((value, index) => {
    const row = record(value, `lineages[${index}]`);
    return [publicHttps(row.id, `lineages[${index}].id`).replace(/\/$/, ""), string(row.role, `lineages[${index}].role`)] as const;
  }));
  for (const item of cases) {
    if (roles.get(item.repositoryLineageId) !== item.split) {
      throw new Error(`${item.id}: lineage registry role must match split ${item.split}`);
    }
  }
}

function fractionRecalled(required: string[], candidates: Set<string>): number {
  return required.filter((filePath) => candidates.has(normalizePath(filePath))).length / required.length;
}

function fullRecallRate(rows: Array<Record<string, unknown>>, field: string): number | null {
  const values = rows.map((row) => row[field]).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.filter((value) => value === 1).length / values.length : null;
}

function meanNullable(rows: Array<Record<string, unknown>>, field: string): number | null {
  const values = rows.map((row) => row[field]).filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function booleanRate(rows: Array<Record<string, unknown>>, field: string): number | null {
  const values = rows.map((row) => row[field]).filter((value): value is boolean => typeof value === "boolean");
  return values.length > 0 ? values.filter(Boolean).length / values.length : null;
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

function publicHttps(value: unknown, label: string, options?: { allowQuery?: boolean }): string {
  const result = string(value, label);
  const parsed = new URL(result);
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    (!options?.allowQuery && parsed.search) || parsed.hash
  ) {
    throw new Error(`${label} must be a credential-free public HTTPS URL`);
  }
  return result;
}

function pathArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => normalizePath(string(item, `${label}[${index}]`)));
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`invalid repository-relative path '${value}'`);
  }
  return normalized;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay beside the intake manifest`);
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  const result = string(value, label);
  if (!values.includes(result)) throw new Error(`${label} must be one of ${values.join(", ")}`);
  return result as T[number];
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
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

function parseArgs(argv: string[]): MaterializeOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const args = argv.filter((token) => token !== "--");
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--allow-sample" || token === "--allow-local-fixture" || token === "--draft") {
      flags.add(token);
      continue;
    }
    const next = args[index + 1];
    if (!token.startsWith("--") || !next || next.startsWith("--")) throw new Error(`invalid argument '${token}'`);
    values.set(token, next);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  return {
    intakePath: required("--intake"),
    outPath: required("--out"),
    reportPath: required("--report-out"),
    ...(values.get("--cache") ? { cacheDir: values.get("--cache")! } : {}),
    allowSample: flags.has("--allow-sample"),
    allowLocalFixture: flags.has("--allow-local-fixture"),
    draft: flags.has("--draft"),
    ...(values.get("--limit") ? { limit: positiveInteger(values.get("--limit")!, "--limit") } : {})
  };
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  materializeEvidenceCorpus(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
