// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARD_NEGATIVE_REVIEW_QUEUE_SCHEMA = "hard-negative-review-queue.v1" as const;

type JsonRecord = Record<string, unknown>;

export type BuildHardNegativeReviewQueueOptions = {
  trainingRowsPath: string;
  manifestPath: string;
  reportPath: string;
  evaluationPath: string;
  repositoryCacheRoot: string;
  outPath: string;
  perCell?: number;
  maxPerCase?: number;
};

type RankedCandidate = {
  path: string;
  rank: number;
  priority: number;
  rawScore: number;
  label: 0 | 1 | null;
  labelWeight: number | null;
  labelProvenance: string | null;
  baseFeatures: Record<string, number>;
  documentFeatures: Record<string, number>;
  semanticInteraction: JsonRecord | null;
};

type ReviewItem = {
  id: string;
  caseId: string;
  cell: string;
  language: string;
  scenario: string;
  repositoryLineageId: string;
  repositoryUrl: string;
  repositoryRef: string;
  publicSourceUrl: string;
  dataOrigin: string;
  prompt: string;
  querySha256: string;
  candidatePath: string;
  source: { gitBlobOid: string; contentSha256: string; bytes: number };
  ranking: {
    rank: number;
    priority: number;
    rawScore: number;
    outrankedPositiveCount: number;
    worstRequiredSourcePositiveRank: number;
    requiredSourcePositiveMissAt64: boolean;
    worstPositiveRank: number;
    positiveMissAt64: boolean;
    nearestOutrankedPositiveScoreGap: number;
    positiveCandidates: Array<{
      path: string;
      rank: number;
      priority: number;
      rawScore: number;
      labelWeight: number | null;
      labelProvenance: string | null;
    }>;
  };
  evidence: {
    baseFeatures: Record<string, number>;
    documentFeatures: Record<string, number>;
    semanticInteraction: JsonRecord | null;
  };
  decision: { verdict: null; reviewer: null; reviewedAt: null; notes: null };
};

export function buildHardNegativeReviewQueue(
  options: BuildHardNegativeReviewQueueOptions
): Record<string, unknown> {
  const trainingRowsPath = path.resolve(options.trainingRowsPath);
  const manifestPath = path.resolve(options.manifestPath);
  const reportPath = path.resolve(options.reportPath);
  const evaluationPath = path.resolve(options.evaluationPath);
  const repositoryCacheRoot = path.resolve(options.repositoryCacheRoot);
  const perCell = positiveInteger(options.perCell ?? 2, "perCell");
  const maxPerCase = positiveInteger(options.maxPerCase ?? 1, "maxPerCase");

  const trainingBytes = fs.readFileSync(trainingRowsPath);
  const manifestBytes = fs.readFileSync(manifestPath);
  const reportBytes = fs.readFileSync(reportPath);
  const evaluationBytes = fs.readFileSync(evaluationPath);
  const manifest = json(manifestBytes, "manifest");
  const report = json(reportBytes, "report");
  const evaluation = json(evaluationBytes, "evaluation");
  validateRoots(manifest, report, evaluation, {
    trainingRowsSha256: sha256(trainingBytes),
    manifestSha256: sha256(manifestBytes),
    reportSha256: sha256(reportBytes)
  });
  validateTrainingRows(trainingBytes);

  const featureSchema = record(evaluation.featureSchema, "evaluation.featureSchema");
  const baseFeatureNames = stringArray(featureSchema.base, "evaluation.featureSchema.base");
  const documentFeatureNames = stringArray(featureSchema.added, "evaluation.featureSchema.added");
  const expectedDocumentFeatures = [
    "semanticFile", "semanticSymbol", "missingSemanticFile", "missingSemanticSymbol"
  ];
  if (documentFeatureNames.join("\n") !== expectedDocumentFeatures.join("\n")) {
    throw new Error("evaluation document feature schema is unsupported");
  }
  const model = record(evaluation.model, "evaluation.model");
  if (model.kind !== "pairwise_logistic") {
    throw new Error("review queue requires the frozen pairwise logistic evaluation");
  }
  const coefficientRecord = record(model.coefficients, "evaluation.model.coefficients");
  const featureNames = [...baseFeatureNames, ...documentFeatureNames];
  if (new Set(featureNames).size !== featureNames.length) {
    throw new Error("evaluation feature names must be unique");
  }
  const coefficients = Object.fromEntries(featureNames.map((name) => [
    name,
    finite(coefficientRecord[name], `evaluation.model.coefficients.${name}`)
  ]));
  const unknownCoefficients = Object.keys(coefficientRecord).filter((name) => !featureNames.includes(name));
  if (unknownCoefficients.length > 0) {
    throw new Error(`evaluation contains unknown coefficients: ${unknownCoefficients.join(", ")}`);
  }

  const reportCases = byId(report.cases, "report.cases");
  const eligibleByCell = new Map<string, ReviewItem[]>();
  const trainCases = array(manifest.cases, "manifest.cases").filter((value, index) => {
    const item = record(value, `manifest.cases[${index}]`);
    const split = string(item.split, `manifest.cases[${index}].split`);
    if (split === "holdout") throw new Error("hard-negative review may not load holdout cases");
    return split === "train";
  });

  for (const [caseIndex, value] of trainCases.entries()) {
    const item = record(value, `manifest.trainCases[${caseIndex}]`);
    const caseId = string(item.id, `manifest.trainCases[${caseIndex}].id`);
    const language = string(item.language, `${caseId}.language`);
    const scenario = string(item.scenario, `${caseId}.scenario`);
    const cell = `${language}/${scenario}`;
    const reportCase = requiredCase(reportCases, caseId, "report");
    const diagnostics = record(reportCase.candidateDiagnostics, `${caseId}.candidateDiagnostics`);
    const interactions = interactionMap(diagnostics.semanticInteractions, caseId);
    const candidates = array(item.trainingCandidates, `${caseId}.trainingCandidates`).map((raw, candidateIndex) => {
      const row = record(raw, `${caseId}.trainingCandidates[${candidateIndex}]`);
      const candidatePath = repositoryPath(row.path, `${caseId}.trainingCandidates[${candidateIndex}].path`);
      const base = record(row.features, `${caseId}:${candidatePath}.features`);
      const baseFeatures = Object.fromEntries(baseFeatureNames.map((name) => [
        name,
        finite(base[name], `${caseId}:${candidatePath}.features.${name}`)
      ]));
      const semanticInteraction = interactions.get(candidatePath) ?? null;
      const documentFeatures = semanticDocumentFeatures(semanticInteraction);
      const allFeatures = { ...baseFeatures, ...documentFeatures };
      const rawScore = featureNames.reduce(
        (total, name) => total + coefficients[name]! * allFeatures[name]!,
        0
      );
      const label = row.label === 0 ? 0 : row.label === 1 ? 1 : null;
      return {
        path: candidatePath,
        rank: 0,
        priority: baseFeatures.failureReference! > 0 ? 2 : baseFeatures.exactPath! > 0 ? 1 : 0,
        rawScore,
        label,
        labelWeight: typeof row.labelWeight === "number" && Number.isFinite(row.labelWeight)
          ? row.labelWeight
          : null,
        labelProvenance: typeof row.labelProvenance === "string" ? row.labelProvenance : null,
        baseFeatures,
        documentFeatures,
        semanticInteraction
      } satisfies RankedCandidate;
    });
    if (new Set(candidates.map((candidate) => candidate.path)).size !== candidates.length) {
      throw new Error(`${caseId}: duplicate candidate paths`);
    }
    candidates.sort(compareRankedCandidates);
    candidates.forEach((candidate, rank) => { candidate.rank = rank + 1; });
    const positives = candidates.filter((candidate) => candidate.label === 1);
    if (positives.length === 0) continue;
    const repositoryUrl = string(item.repositoryUrl, `${caseId}.repositoryUrl`);
    const repositoryRef = commit(item.repositoryRef, `${caseId}.repositoryRef`);
    const common = {
      caseId,
      cell,
      language,
      scenario,
      repositoryLineageId: string(item.repositoryLineageId, `${caseId}.repositoryLineageId`),
      repositoryUrl,
      repositoryRef,
      publicSourceUrl: string(item.publicSourceUrl, `${caseId}.publicSourceUrl`),
      dataOrigin: string(item.dataOrigin, `${caseId}.dataOrigin`),
      prompt: string(item.prompt, `${caseId}.prompt`),
      querySha256: digestString(item.querySha256, `${caseId}.querySha256`)
    };
    for (const candidate of candidates.filter((row) => row.label === null)) {
      const outranked = positives.filter((positive) => positive.rank > candidate.rank);
      if (outranked.length === 0) continue;
      const positiveCandidates = positives.map((positive) => ({
        path: positive.path,
        rank: positive.rank,
        priority: positive.priority,
        rawScore: positive.rawScore,
        labelWeight: positive.labelWeight,
        labelProvenance: positive.labelProvenance
      }));
      const requiredSourcePositives = positives.filter(
        (positive) => positive.labelProvenance === "required_source_oracle"
      );
      const nearest = [...outranked].sort((left, right) => left.rank - right.rank)[0]!;
      const reviewItem: ReviewItem = {
        id: sha256(`${caseId}\n${candidate.path}`).slice(0, 24),
        ...common,
        candidatePath: candidate.path,
        source: { gitBlobOid: "", contentSha256: "", bytes: 0 },
        ranking: {
          rank: candidate.rank,
          priority: candidate.priority,
          rawScore: candidate.rawScore,
          outrankedPositiveCount: outranked.length,
          worstRequiredSourcePositiveRank: requiredSourcePositives.length > 0
            ? Math.max(...requiredSourcePositives.map((positive) => positive.rank))
            : 0,
          requiredSourcePositiveMissAt64: requiredSourcePositives.some(
            (positive) => positive.rank > 64
          ),
          worstPositiveRank: Math.max(...positives.map((positive) => positive.rank)),
          positiveMissAt64: positives.some((positive) => positive.rank > 64),
          nearestOutrankedPositiveScoreGap: candidate.rawScore - nearest.rawScore,
          positiveCandidates
        },
        evidence: {
          baseFeatures: candidate.baseFeatures,
          documentFeatures: candidate.documentFeatures,
          semanticInteraction: candidate.semanticInteraction
        },
        decision: { verdict: null, reviewer: null, reviewedAt: null, notes: null }
      };
      const rows = eligibleByCell.get(cell) ?? [];
      rows.push(reviewItem);
      eligibleByCell.set(cell, rows);
    }
  }

  const selected: ReviewItem[] = [];
  const cells = [...eligibleByCell.keys()].sort();
  for (const cell of cells) {
    const candidates = eligibleByCell.get(cell)!.sort(compareReviewItems);
    const selectedForCell: ReviewItem[] = [];
    const countsByCase = new Map<string, number>();
    for (const candidate of candidates) {
      if (selectedForCell.length >= perCell) break;
      const count = countsByCase.get(candidate.caseId) ?? 0;
      if (count >= maxPerCase) continue;
      selectedForCell.push(candidate);
      countsByCase.set(candidate.caseId, count + 1);
    }
    for (const candidate of candidates) {
      if (selectedForCell.length >= perCell) break;
      if (selectedForCell.some((item) => item.id === candidate.id)) continue;
      selectedForCell.push(candidate);
    }
    selected.push(...selectedForCell);
  }

  for (const item of selected) {
    const repository = validatedRepository(
      repositoryCacheRoot,
      item.repositoryUrl,
      item.repositoryRef,
      item.caseId
    );
    item.source = sourceDigest(
      repository,
      item.repositoryRef,
      item.candidatePath,
      `${item.caseId}:${item.candidatePath}`
    );
  }

  const cellSummary = cells.map((cell) => ({
    cell,
    eligible: eligibleByCell.get(cell)!.length,
    selected: selected.filter((item) => item.cell === cell).length
  }));
  return {
    schemaVersion: HARD_NEGATIVE_REVIEW_QUEUE_SCHEMA,
    promotionEligible: false,
    trainingOnly: true,
    detachedHoldoutOpened: false,
    decisionsComplete: false,
    inputs: {
      trainingRows: artifactDigest(trainingRowsPath, trainingBytes),
      candidateManifest: artifactDigest(manifestPath, manifestBytes),
      candidateReport: artifactDigest(reportPath, reportBytes),
      rankerEvaluation: artifactDigest(evaluationPath, evaluationBytes)
    },
    policy: {
      purpose: "Review currently unlabeled training candidates that outrank a known positive on the frozen pool.",
      decisionOptions: ["irrelevant", "relevant", "uncertain"],
      irrelevantAddsNegativeLabel: true,
      relevantAndUncertainRemainUnlabeled: true,
      calibrationRowsExcluded: true,
      holdoutRowsExcluded: true,
      automaticLabels: false,
      balancedBy: ["language", "scenario"],
      perCell,
      maxPerCase,
      maxPerCaseIsPreferred: true,
      cellFillMayExceedPreferredCaseLimit: true
    },
    featureSchema: { base: baseFeatureNames, added: documentFeatureNames },
    model: {
      kind: model.kind,
      selectedL2: model.selectedL2,
      coefficientSha256: sha256(JSON.stringify(coefficients))
    },
    population: {
      trainingCases: trainCases.length,
      cells: cells.length,
      eligibleCandidates: [...eligibleByCell.values()].reduce((sum, values) => sum + values.length, 0),
      selectedCandidates: selected.length,
      cellSummary
    },
    items: selected.sort(
      (left, right) => left.cell.localeCompare(right.cell) || compareReviewItems(left, right)
    )
  };
}

function validateRoots(
  manifest: JsonRecord,
  report: JsonRecord,
  evaluation: JsonRecord,
  hashes: { trainingRowsSha256: string; manifestSha256: string; reportSha256: string }
): void {
  if (manifest.schemaVersion !== "ranker-corpus.v1") throw new Error("manifest schemaVersion mismatch");
  if (report.schemaVersion !== "ranker-corpus-materialization-report.v1") {
    throw new Error("report schemaVersion mismatch");
  }
  if (evaluation.schemaVersion !== "semantic-document-feature-diagnostic.v1") {
    throw new Error("evaluation schemaVersion mismatch");
  }
  if (evaluation.samePoolVerified !== true || evaluation.promotionEligible !== false) {
    throw new Error("evaluation must be a same-pool, non-promotion diagnostic");
  }
  const materializer = record(manifest.materializer, "manifest.materializer");
  if (report.kairnCommit !== materializer.kairnCommit || report.intakeSha256 !== materializer.intakeSha256) {
    throw new Error("manifest/report provenance mismatch");
  }
  const inputs = record(evaluation.inputs, "evaluation.inputs");
  const expected = {
    trainingRowsSha256: hashes.trainingRowsSha256,
    candidateManifestSha256: hashes.manifestSha256,
    candidateReportSha256: hashes.reportSha256
  };
  for (const [key, value] of Object.entries(expected)) {
    if (inputs[key] !== value) throw new Error(`evaluation ${key} does not match the frozen input`);
  }
}

function validateTrainingRows(bytes: Buffer): void {
  const seen = new Set<string>();
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const row = record(JSON.parse(line) as unknown, `trainingRows[${index}]`);
    if (row.split === "holdout") throw new Error("hard-negative review may not load holdout rows");
    const key = `${string(row.caseGroupId, `trainingRows[${index}].caseGroupId`)}\n${repositoryPath(row.candidatePath, `trainingRows[${index}].candidatePath`)}`;
    if (seen.has(key)) {
      throw new Error(`training rows contain duplicate candidate ${key.replace("\n", ":")}`);
    }
    seen.add(key);
  }
}

function interactionMap(value: unknown, caseId: string): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>();
  for (const [index, raw] of array(value, `${caseId}.semanticInteractions`).entries()) {
    const item = record(raw, `${caseId}.semanticInteractions[${index}]`);
    const itemPath = repositoryPath(item.path, `${caseId}.semanticInteractions[${index}].path`);
    if (result.has(itemPath)) throw new Error(`${caseId}: duplicate semantic interaction for ${itemPath}`);
    result.set(itemPath, item);
  }
  return result;
}

function semanticDocumentFeatures(interaction: JsonRecord | null): Record<string, number> {
  const file = interaction?.fileSimilarity;
  const symbol = interaction?.symbolSimilarity;
  const hasFile = typeof file === "number" && Number.isFinite(file);
  const hasSymbol = typeof symbol === "number" && Number.isFinite(symbol);
  return {
    semanticFile: hasFile ? clamp01(file) : 0,
    semanticSymbol: hasSymbol ? clamp01(symbol) : 0,
    missingSemanticFile: hasFile ? 0 : 1,
    missingSemanticSymbol: hasSymbol ? 0 : 1
  };
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return right.priority - left.priority || right.rawScore - left.rawScore || left.path.localeCompare(right.path);
}

function compareReviewItems(left: ReviewItem, right: ReviewItem): number {
  return Number(right.ranking.requiredSourcePositiveMissAt64)
    - Number(left.ranking.requiredSourcePositiveMissAt64)
    || right.ranking.worstRequiredSourcePositiveRank - left.ranking.worstRequiredSourcePositiveRank
    || Number(right.ranking.positiveMissAt64) - Number(left.ranking.positiveMissAt64)
    || right.ranking.worstPositiveRank - left.ranking.worstPositiveRank
    || right.ranking.outrankedPositiveCount - left.ranking.outrankedPositiveCount
    || left.ranking.rank - right.ranking.rank
    || right.ranking.nearestOutrankedPositiveScoreGap - left.ranking.nearestOutrankedPositiveScoreGap
    || left.caseId.localeCompare(right.caseId)
    || left.candidatePath.localeCompare(right.candidatePath);
}

function validatedRepository(cacheRoot: string, repositoryUrl: string, repositoryRef: string, caseId: string): string {
  const repository = path.resolve(cacheRoot, "repositories", `${sha256(repositoryUrl).slice(0, 24)}.git`);
  assertWithin(cacheRoot, repository, `${caseId}.repositoryCache`);
  if (!fs.existsSync(repository)) throw new Error(`${caseId}: immutable repository cache is missing`);
  try {
    execFileSync("git", ["cat-file", "-e", `${repositoryRef}^{commit}`], {
      cwd: repository,
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch {
    throw new Error(`${caseId}: repository ref is missing from the immutable cache`);
  }
  return repository;
}

function sourceDigest(
  repository: string,
  repositoryRef: string,
  filePath: string,
  label: string
): ReviewItem["source"] {
  try {
    const oid = execFileSync("git", ["rev-parse", `${repositoryRef}:${filePath}`], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("invalid blob oid");
    const bytes = execFileSync("git", ["show", `${repositoryRef}:${filePath}`], {
      cwd: repository,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return { gitBlobOid: oid, contentSha256: sha256(bytes), bytes: bytes.length };
  } catch {
    throw new Error(`${label}: source is unavailable at the immutable repository ref`);
  }
}

function artifactDigest(filePath: string, bytes: Buffer): Record<string, unknown> {
  const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
  return {
    path: relative.startsWith("../") ? `external-frozen-source/${path.basename(filePath)}` : relative,
    sha256: sha256(bytes),
    bytes: bytes.length
  };
}

function json(bytes: Buffer, label: string): JsonRecord {
  return record(JSON.parse(bytes.toString("utf8")) as unknown, label);
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

function requiredCase(values: Map<string, JsonRecord>, id: string, label: string): JsonRecord {
  const value = values.get(id);
  if (!value) throw new Error(`${label} is missing case ${id}`);
  return value;
}

function repositoryPath(value: unknown, label: string): string {
  const raw = string(value, label).replace(/\\/g, "/");
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be repository-relative`);
  }
  return normalized;
}

function commit(value: unknown, label: string): string {
  const output = string(value, label).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(output)) throw new Error(`${label} must be an immutable commit`);
  return output;
}

function digestString(value: unknown, label: string): string {
  const output = string(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(output)) throw new Error(`${label} must be a SHA-256 digest`);
  return output;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function assertWithin(parent: string, candidate: string, label: string): void {
  const relative = path.relative(parent, candidate);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} must stay inside ${parent}`);
}

function parseArgs(argv: string[]): BuildHardNegativeReviewQueueOptions {
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
    manifestPath: required("--manifest"),
    reportPath: required("--report"),
    evaluationPath: required("--evaluation"),
    repositoryCacheRoot: required("--repository-cache-root"),
    outPath: required("--out"),
    ...(values.has("--per-cell") ? { perCell: Number(values.get("--per-cell")) } : {}),
    ...(values.has("--max-per-case") ? { maxPerCase: Number(values.get("--max-per-case")) } : {})
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const queue = buildHardNegativeReviewQueue(options);
    const target = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
    const population = record(queue.population, "queue.population");
    process.stdout.write(`${JSON.stringify({
      out: target,
      trainingCases: population.trainingCases,
      cells: population.cells,
      eligibleCandidates: population.eligibleCandidates,
      selectedCandidates: population.selectedCandidates
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
