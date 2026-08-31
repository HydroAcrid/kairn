// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type {
  EvidenceFeatureVector,
  EvidenceModelPrediction,
  EvidenceRankerArtifact,
  EvidenceServingFeatureName,
  EvidenceServingFeatureVector
} from "../types.js";
import { EVIDENCE_FEATURE_NAMES, EVIDENCE_FEATURE_NAMES_V5 } from "../types.js";
import { sha256 } from "../utils/hash.js";

export const EVIDENCE_FEATURE_SCHEMA_VERSION = "evidence-features-v4" as const;
export const EVIDENCE_FEATURE_SCHEMA_HASH = sha256(stableStringify({
  version: EVIDENCE_FEATURE_SCHEMA_VERSION,
  features: EVIDENCE_FEATURE_NAMES
}));
export const EVIDENCE_SEMANTIC_FEATURE_SCHEMA_VERSION = "evidence-features-v5" as const;
export const EVIDENCE_SEMANTIC_FEATURE_SCHEMA_HASH = sha256(stableStringify({
  version: EVIDENCE_SEMANTIC_FEATURE_SCHEMA_VERSION,
  features: EVIDENCE_FEATURE_NAMES_V5
}));

type EvidenceArtifactPayload = Omit<EvidenceRankerArtifact, "checksum">;

const BUNDLED_PAYLOAD: EvidenceArtifactPayload = {
  formatVersion: 1,
  modelId: "generic-evidence-v2",
  featureSchemaVersion: EVIDENCE_FEATURE_SCHEMA_VERSION,
  featureSchemaHash: EVIDENCE_FEATURE_SCHEMA_HASH,
  orderedFeatures: [...EVIDENCE_FEATURE_NAMES],
  intercept: -2.2,
  coefficients: [
    4.2,
    2.4,
    3.1,
    1.2,
    0.8,
    0.45,
    0.65,
    3.6,
    0.8,
    -0.9,
    0.55,
    0,
    0,
    0,
    0,
    0,
    1.35,
    0.45,
    -0.15,
    -0.45,
    -4.2,
    1.0,
    0.2,
    -0.35,
    -0.15,
    -0.2
  ],
  calibration: {
    kind: "platt",
    a: 1,
    b: 0
  },
  decisionThresholds: {
    abstain: 0.2,
    pathHint: 0.42,
    content: 0.72
  },
  trainingDataHash: sha256("generic evidence bootstrap: no private or fixture identity data"),
  trainingManifest: "bootstrap-general-signals-v2"
};

/**
 * Bootstrap model for shadow/opt-in operation. It exercises the exact artifact
 * and inference path that an offline-trained artifact uses, but makes no claim
 * to have passed the promotion calibration gates.
 */
export const BUNDLED_EVIDENCE_ARTIFACT: EvidenceRankerArtifact = deepFreeze({
  ...BUNDLED_PAYLOAD,
  checksum: checksumEvidenceArtifact(BUNDLED_PAYLOAD)
});

const BUNDLED_SEMANTIC_RC_PAYLOAD: EvidenceArtifactPayload = {
  formatVersion: 1,
  modelId: "kairn-semantic-rc-v185",
  featureSchemaVersion: EVIDENCE_SEMANTIC_FEATURE_SCHEMA_VERSION,
  featureSchemaHash: EVIDENCE_SEMANTIC_FEATURE_SCHEMA_HASH,
  orderedFeatures: [...EVIDENCE_FEATURE_NAMES_V5],
  intercept: 0,
  coefficients: [
    0.57894291766336,
    0.42145941581431995,
    -0.1427037824930103,
    0.5670670793576064,
    0.3132802182402933,
    0,
    1.8879857078178868,
    0.358282620271499,
    0,
    0,
    0.6901173264588106,
    0.7549948680951271,
    -0.22877528409529765,
    1.1118319757474153,
    1.3135054387636007,
    1.8428570501161907,
    -0.14644960274817242,
    1.2058265143248494,
    -1.165111376788754,
    -0.03834796844319842,
    0,
    1.2058265143248494,
    0.07686611708932847,
    0.9685874317577245,
    0.1716581751804069,
    -0.6036205971256031,
    1.9515580273135158,
    1.5934447932096003,
    -0.15027429343203724,
    0.07493930643734337
  ],
  calibration: {
    kind: "platt",
    a: 1.7411593490520318,
    b: -16.123125497774744
  },
  decisionThresholds: {
    abstain: 0.000620329641,
    pathHint: 0.000620329641,
    content: 0.055608651148
  },
  trainingDataHash: "0d57ad39ce40239e16c7885c677f998c3447a09f4346b0114f9fb6c24e5b09b0",
  trainingManifest: "semantic-document-feature-diagnostic.v185-reviewed-negatives"
};

/**
 * Opt-in semantic release-candidate ranker. It is bundled so an installed
 * Kairn can be tested fully offline after the embedding model is installed.
 * It is not the default until live quality and token gates pass.
 */
export const BUNDLED_SEMANTIC_RC_EVIDENCE_ARTIFACT: EvidenceRankerArtifact = deepFreeze({
  ...BUNDLED_SEMANTIC_RC_PAYLOAD,
  checksum: checksumEvidenceArtifact(BUNDLED_SEMANTIC_RC_PAYLOAD)
});

export function checksumEvidenceArtifact(artifact: EvidenceArtifactPayload): string {
  return sha256(stableStringify(artifact));
}

export function loadEvidenceRankerArtifact(modelPath: string): EvidenceRankerArtifact {
  if (!modelPath.trim()) {
    throw new Error("Evidence ranker model path is empty.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(modelPath)) {
    throw new Error("Evidence ranker modelPath must be a local filesystem path.");
  }

  const resolved = path.resolve(modelPath);
  const parsed: unknown = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return validateEvidenceRankerArtifact(parsed);
}

export function validateEvidenceRankerArtifact(value: unknown): EvidenceRankerArtifact {
  const artifact = requireRecord(value, "artifact");
  requireExactKeys(artifact, [
    "formatVersion",
    "modelId",
    "featureSchemaVersion",
    "featureSchemaHash",
    "orderedFeatures",
    "intercept",
    "coefficients",
    "calibration",
    "decisionThresholds",
    "trainingDataHash",
    "trainingManifest",
    "checksum"
  ], "artifact");

  if (artifact.formatVersion !== 1) {
    throw new Error(`Unsupported evidence ranker artifact formatVersion: ${String(artifact.formatVersion)}`);
  }
  if (
    artifact.featureSchemaVersion !== EVIDENCE_FEATURE_SCHEMA_VERSION &&
    artifact.featureSchemaVersion !== EVIDENCE_SEMANTIC_FEATURE_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported evidence feature schema: ${String(artifact.featureSchemaVersion)}`);
  }
  const featureSchemaVersion = artifact.featureSchemaVersion;
  const expectedFeatures = featureSchemaVersion === EVIDENCE_SEMANTIC_FEATURE_SCHEMA_VERSION
    ? EVIDENCE_FEATURE_NAMES_V5
    : EVIDENCE_FEATURE_NAMES;
  const expectedSchemaHash = featureSchemaVersion === EVIDENCE_SEMANTIC_FEATURE_SCHEMA_VERSION
    ? EVIDENCE_SEMANTIC_FEATURE_SCHEMA_HASH
    : EVIDENCE_FEATURE_SCHEMA_HASH;
  if (artifact.featureSchemaHash !== expectedSchemaHash) {
    throw new Error("Evidence ranker feature schema hash does not match this runtime.");
  }

  const modelId = requireNonEmptyString(artifact.modelId, "modelId");
  const orderedFeatures = requireStringArray(artifact.orderedFeatures, "orderedFeatures");
  if (
    orderedFeatures.length !== expectedFeatures.length ||
    orderedFeatures.some((feature, index) => feature !== expectedFeatures[index])
  ) {
    throw new Error("Evidence ranker orderedFeatures must exactly match the runtime feature schema.");
  }

  const coefficients = requireFiniteNumberArray(artifact.coefficients, "coefficients");
  if (coefficients.length !== expectedFeatures.length) {
    throw new Error("Evidence ranker coefficient count does not match orderedFeatures.");
  }

  const calibration = requireRecord(artifact.calibration, "calibration");
  requireExactKeys(calibration, ["kind", "a", "b"], "calibration");
  if (calibration.kind !== "platt") {
    throw new Error(`Unsupported evidence calibration kind: ${String(calibration.kind)}`);
  }

  const thresholds = requireRecord(artifact.decisionThresholds, "decisionThresholds");
  requireExactKeys(thresholds, ["abstain", "pathHint", "content"], "decisionThresholds");
  const abstain = requireProbability(thresholds.abstain, "decisionThresholds.abstain");
  const pathHint = requireProbability(thresholds.pathHint, "decisionThresholds.pathHint");
  const content = requireProbability(thresholds.content, "decisionThresholds.content");
  if (!(abstain <= pathHint && pathHint <= content)) {
    throw new Error("Evidence ranker thresholds must satisfy abstain <= pathHint <= content.");
  }

  const candidate: EvidenceRankerArtifact = {
    formatVersion: 1,
    modelId,
    featureSchemaVersion,
    featureSchemaHash: expectedSchemaHash,
    orderedFeatures: [...expectedFeatures],
    intercept: requireFiniteNumber(artifact.intercept, "intercept"),
    coefficients,
    calibration: {
      kind: "platt",
      a: requireFiniteNumber(calibration.a, "calibration.a"),
      b: requireFiniteNumber(calibration.b, "calibration.b")
    },
    decisionThresholds: { abstain, pathHint, content },
    trainingDataHash: requireNonEmptyString(artifact.trainingDataHash, "trainingDataHash"),
    trainingManifest: requireNonEmptyString(artifact.trainingManifest, "trainingManifest"),
    checksum: requireSha256(artifact.checksum, "checksum")
  };

  const { checksum, ...payload } = candidate;
  const expectedChecksum = checksumEvidenceArtifact(payload);
  if (checksum !== expectedChecksum) {
    throw new Error(`Evidence ranker checksum mismatch: expected ${expectedChecksum}, received ${checksum}.`);
  }
  return candidate;
}

export function predictEvidenceRelevance(
  artifact: EvidenceRankerArtifact,
  features: EvidenceFeatureVector | EvidenceServingFeatureVector
): EvidenceModelPrediction {
  let rawScore = artifact.intercept;
  for (let index = 0; index < artifact.orderedFeatures.length; index += 1) {
    const feature = artifact.orderedFeatures[index]!;
    const coefficient = artifact.coefficients[index]!;
    const value = (features as Partial<Record<EvidenceServingFeatureName, number>>)[feature];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Evidence feature ${feature} must be finite.`);
    }
    rawScore += coefficient * value;
  }

  return {
    rawScore,
    uncalibratedProbability: sigmoid(rawScore),
    relevanceProbability: sigmoid(artifact.calibration.a * rawScore + artifact.calibration.b)
  };
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Evidence ranker ${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], name: string): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !(key in record));
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Evidence ranker ${name} keys are invalid (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`
    );
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Evidence ranker ${name} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Evidence ranker ${name} must be a string array.`);
  }
  return [...value] as string[];
}

function requireFiniteNumberArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`Evidence ranker ${name} must be a finite number array.`);
  }
  return [...value] as number[];
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Evidence ranker ${name} must be finite.`);
  }
  return value;
}

function requireProbability(value: unknown, name: string): number {
  const number = requireFiniteNumber(value, name);
  if (number < 0 || number > 1) {
    throw new Error(`Evidence ranker ${name} must be between 0 and 1.`);
  }
  return number;
}

function requireSha256(value: unknown, name: string): string {
  const string = requireNonEmptyString(value, name);
  if (!/^[a-f0-9]{64}$/i.test(string)) {
    throw new Error(`Evidence ranker ${name} must be a SHA-256 digest.`);
  }
  return string.toLowerCase();
}
