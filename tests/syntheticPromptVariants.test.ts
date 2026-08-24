import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPromptViews,
  buildSyntheticPromptVariants
} from "../scripts/build-synthetic-prompt-variants.js";
import { EVIDENCE_FEATURE_NAMES } from "../src/types/evidence.js";

describe("synthetic prompt variants", () => {
  it("creates deterministic train-only views without copying target paths into prompts", () => {
    const intake = {
      schemaVersion: "ranker-corpus-intake.v1",
      corpusId: "public-corpus",
      featureSchemaVersion: "evidence-features-v4",
      sealed: true,
      sampleOnly: false,
      lineageRegistry: "lineages.json",
      cases: [
        intakeCase("train-python-a", "train", "python", "source_localization"),
        intakeCase("train-python-b", "train", "python", "source_localization"),
        intakeCase("train-go-a", "train", "go", "failure_first"),
        intakeCase("calibration-a", "calibration", "typescript", "source_localization"),
        intakeCase("holdout-a", "holdout", "java", "long_session")
      ]
    };
    const first = buildSyntheticPromptVariants(intake, {
      parentsPerCell: 1,
      variantsPerParent: 2
    });
    const second = buildSyntheticPromptVariants(intake, {
      parentsPerCell: 1,
      variantsPerParent: 2
    });
    expect(second).toEqual(first);
    const cases = first.cases as Array<Record<string, unknown>>;
    const variants = cases.filter((item) => item.dataOrigin === "synthetic");
    expect(variants).toHaveLength(4);
    expect(variants.every((item) => item.split === "train")).toBe(true);
    expect(new Set(variants.map((item) => item.syntheticVariantOf)).size).toBe(2);
    expect(variants.map((item) => item.syntheticVariantIndex).sort()).toEqual([1, 1, 2, 2]);
    expect(variants.every((item) =>
      typeof item.prompt === "string" &&
      item.prompt.length <= 1_600 &&
      !item.prompt.includes("src/private-target.ts")
    )).toBe(true);
    expect(first).toMatchObject({
      sealed: false,
      syntheticVariantPolicy: {
        selectedParents: 2,
        generatedVariants: 4,
        parentsPerCell: 1,
        variantsPerParent: 2
      }
    });
  });

  it("preserves bounded narrative and endpoint evidence without inventing a paraphrase", () => {
    const prompt = [
      "Cache entries survive after their lease expires",
      "",
      "The cleanup worker observes stale state after a renewal race.",
      "```text",
      "LeaseExpired: expected generation 8 but found 7",
      "```",
      "Additional reproduction details follow.",
      "```python",
      "await cache.renew(key)",
      "await cache.sweep()",
      "```"
    ].join("\n");
    const [synopsis, evidence] = buildPromptViews(prompt);
    expect(synopsis).toContain("cleanup worker observes stale state");
    expect(evidence).toContain("LeaseExpired");
    expect(evidence).toContain("await cache.sweep()");
    expect(synopsis.length).toBeLessThanOrEqual(1_600);
    expect(evidence.length).toBeLessThanOrEqual(1_600);
  });

  it("keeps the fixed natural production matrix while admitting train-only variants", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-synthetic-production-"));
    const manifestPath = path.join(temporary, "corpus.json");
    const registryPath = path.join(temporary, "lineages.json");
    const outputPath = path.join(temporary, "rows.jsonl");
    const summaryPath = path.join(temporary, "summary.json");
    const { cases, lineages } = productionCases();
    const parent = cases.find((item) => item.split === "train")!;
    const variant = {
      ...parent,
      id: `${parent.id}-synthetic-view-1`,
      prompt: `${parent.prompt} deterministic view`,
      querySha256: sha256(`${parent.prompt} deterministic view`),
      dataOrigin: "synthetic",
      syntheticVariantOf: parent.id,
      syntheticVariantIndex: 1
    };
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: "lineage-registry.v1",
      lineages
    }), "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "ranker-corpus.v1",
      corpusId: "production-with-synthetic-view",
      featureSchemaVersion: "evidence-features-v4",
      sealed: true,
      sampleOnly: false,
      lineageRegistry: "lineages.json",
      materializer: {
        schemaVersion: "ranker-corpus-materializer.v1",
        kairnCommit: "a".repeat(40),
        intakeSha256: "b".repeat(64),
        candidateLimit: 64,
        enrichedCandidateLimit: 128,
        graphHops: 1,
        caseProcessIsolation: true
      },
      cases: [...cases, variant]
    }), "utf8");
    const python = process.env.KAIRN_PYTHON ?? (process.platform === "win32" ? "py" : "python3");
    const prefix = process.env.KAIRN_PYTHON || process.platform !== "win32" ? [] : ["-3"];
    const result = spawnSync(python, [
      ...prefix,
      path.resolve("scripts/build-evidence-corpus.py"),
      "--manifest", manifestPath,
      "--out", outputPath,
      "--summary-out", summaryPath
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(summaryPath, "utf8"))).toMatchObject({
      caseCount: 166,
      naturalCaseCount: 165,
      syntheticVariantCases: 1,
      splits: { train: { cases: 91 } }
    });
    fs.rmSync(temporary, { recursive: true, force: true });
  });
});

function intakeCase(
  id: string,
  split: "train" | "calibration" | "holdout",
  language: string,
  scenario: string
): Record<string, unknown> {
  return {
    id,
    split,
    language,
    scenario,
    repositoryLineageId: `https://github.com/public/${language}`,
    repositoryUrl: `https://github.com/public/${language}`,
    repositoryRef: "a".repeat(40),
    publicSourceUrl: "https://example.test/public-task",
    dataOrigin: "public_patch",
    prompt: "A background worker returns stale state after a concurrent update.\n```text\nObserved generation mismatch\n```",
    requiredSourceFiles: ["src/private-target.ts"],
    officialPatchSourceFiles: ["src/private-target.ts"],
    verifiedObservedReadTouchFiles: [],
    qualityVerified: true,
    explicitNoiseFiles: []
  };
}

function productionCases(): {
  cases: Array<Record<string, unknown>>;
  lineages: Array<{ id: string; role: string }>;
} {
  const languages = ["python", "typescript", "go", "java", "cpp"];
  const scenarios = ["source_localization", "failure_first", "long_session"];
  const definitions = {
    train: { perCell: 6, lineagesPerLanguage: 4 },
    calibration: { perCell: 3, lineagesPerLanguage: 2 },
    holdout: { perCell: 2, lineagesPerLanguage: 2 }
  } as const;
  const features = Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name) => [name, 0]));
  const cases: Array<Record<string, unknown>> = [];
  const lineages = new Map<string, { id: string; role: string }>();
  for (const [split, definition] of Object.entries(definitions)) {
    for (const [languageIndex, language] of languages.entries()) {
      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        for (let index = 0; index < definition.perCell; index += 1) {
          const lineageIndex = languageIndex * definition.lineagesPerLanguage +
            ((scenarioIndex * definition.perCell + index) % definition.lineagesPerLanguage);
          const lineage = `https://github.com/public/${split}-${lineageIndex}`;
          lineages.set(lineage, { id: lineage, role: split });
          const id = `${split}-${language}-${scenario}-${index}`;
          const prompt = `Public ${language} ${scenario} task ${index}`;
          const required = `src/${id}.txt`;
          const candidates = [
            {
              path: required,
              features: { ...features, productionSource: 1 },
              label: 1,
              labelWeight: 1,
              labelProvenance: "required_source_oracle"
            },
            ...Array.from({ length: 6 }, (_, noiseIndex) => ({
              path: `noise/${id}-${noiseIndex}.md`,
              features: { ...features, docsFile: 1 },
              label: 0,
              labelWeight: 1,
              labelProvenance: "explicit_noise_or_excluded"
            }))
          ];
          cases.push({
            id,
            split,
            language,
            scenario,
            repositoryLineageId: lineage,
            repositoryUrl: lineage,
            repositoryRef: "c".repeat(40),
            publicSourceUrl: "https://example.test/public-task",
            dataOrigin: "public_patch",
            prompt,
            querySha256: sha256(prompt),
            requiredSourceOracleCount: 1,
            requiredSourceOracleSha256: sha256(required),
            requiredSourceExistingCount: 1,
            requiredSourceExistingSha256: sha256(required),
            requiredSourceCreationCount: 0,
            requiredSourceCreationSha256: sha256(""),
            candidates,
            trainingCandidates: candidates
          });
        }
      }
    }
  }
  return { cases, lineages: [...lineages.values()] };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
