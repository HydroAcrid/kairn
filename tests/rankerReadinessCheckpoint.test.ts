import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRankerReadinessCheckpoint } from "../scripts/build-ranker-readiness-checkpoint.js";

describe("ranker readiness checkpoints", () => {
  it("preserves zero-positive misses and blocks training when candidate recall fails", () => {
    const fixture = readinessFixture();
    const checkpoint = buildRankerReadinessCheckpoint(fixture.options);

    expect(checkpoint).toMatchObject({
      status: "blocked_candidate_recall",
      promotionEligible: false,
      trainingEligible: false,
      review: {
        caseCount: 3,
        completedCases: 3,
        pendingCases: 0,
        requiredSourceOracleCases: 3,
        explicitNoiseLabels: 18,
        oracleSelectionBySplit: { holdout: 2, train: 1 }
      },
      materialization: { caseProcessIsolation: true, zeroPositiveCases: 1 },
      candidateRecall: {
        strictReviewedOracles: {
          cases: 3,
          fullCases: 2,
          zeroCases: 1,
          fullRecallRate: 2 / 3
        },
        holdout: {
          cases: 2,
          fullCases: 1,
          zeroCases: 1,
          fullRecallRate: 0.5
        },
        missingRequiredSourceFileCount: 1,
        misses: [{
          id: "holdout-typescript-miss",
          missingRequiredSourceFiles: ["src/required.ts"],
          recallAt64: 0
        }]
      },
      gates: {
        candidateRecallAt64Overall: { threshold: 0.99, passed: false },
        candidateRecallAt64PerLanguage: { threshold: 0.95, passed: false }
      }
    });
  });

  it("rejects a flattened corpus whose bytes do not match its summary", () => {
    const fixture = readinessFixture();
    fs.appendFileSync(fixture.options.corpusPath, "{}\n", "utf8");
    expect(() => buildRankerReadinessCheckpoint(fixture.options)).toThrow("flattened corpus hash mismatch");
  });
});

function readinessFixture(): { options: Parameters<typeof buildRankerReadinessCheckpoint>[0] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-readiness-"));
  const paths = {
    intake: path.join(root, "reviewed-intake.json"),
    registry: path.join(root, "reviewed-registry.json"),
    application: path.join(root, "review-application.json"),
    decisions: path.join(root, "review-decisions.json"),
    manifest: path.join(root, "sealed-manifest.json"),
    report: path.join(root, "materialization-report.json"),
    corpus: path.join(root, "corpus.jsonl"),
    summary: path.join(root, "corpus-summary.json"),
    out: path.join(root, "readiness.json")
  };
  const corpusId = "readiness-fixture";
  const definitions = [
    {
      id: "holdout-typescript-miss",
      split: "holdout",
      language: "typescript",
      required: "src/required.ts",
      recall: 0,
      missing: ["src/required.ts"]
    },
    {
      id: "holdout-go-hit",
      split: "holdout",
      language: "go",
      required: "internal/required.go",
      recall: 1,
      missing: []
    },
    {
      id: "train-typescript-hit",
      split: "train",
      language: "typescript",
      required: "src/training.ts",
      recall: 1,
      missing: []
    }
  ];
  const noisePaths = Array.from({ length: 6 }, (_, index) => `noise/file-${index}.txt`);
  const intakeCases = definitions.map((item) => ({
    id: item.id,
    split: item.split,
    language: item.language,
    scenario: "source_localization",
    repositoryLineageId: `https://github.com/example/${item.id}`,
    requiredSourceFiles: [item.required],
    explicitNoiseFiles: noisePaths
  }));
  writeJson(paths.registry, {
    schemaVersion: "lineage-registry.v1",
    lineages: intakeCases.map((item) => ({ id: item.repositoryLineageId, role: item.split }))
  });
  writeJson(paths.intake, {
    schemaVersion: "ranker-corpus-intake.v1",
    corpusId,
    sealed: true,
    sampleOnly: false,
    lineageRegistry: path.basename(paths.registry),
    cases: intakeCases
  });

  const decisions = definitions.map((item) => ({
    id: item.id,
    materializedCaseSha256: "a".repeat(64),
    candidatePathsSha256: "b".repeat(64),
    decision: {
      requiredSourceFiles: [item.required],
      explicitNoiseFiles: noisePaths,
      reviewer: "independent reviewer",
      reviewedAt: "2026-07-23T12:00:00.000Z",
      notes: null
    }
  }));
  writeJson(paths.decisions, {
    schemaVersion: "ranker-corpus-review-decision-checkpoint.v1",
    corpusId,
    status: "review_complete",
    promotionEligible: false,
    caseCount: definitions.length,
    completedCases: definitions.length,
    pendingCases: 0,
    decisions
  });

  const manifestCases = definitions.map((item) => {
    const candidates = [
      ...(item.recall === 1 ? [{ path: item.required, label: 1 }] : []),
      ...noisePaths.map((candidatePath) => ({ path: candidatePath, label: 0 }))
    ];
    return {
      id: item.id,
      requiredSourceOracleCount: 1,
      requiredSourceOracleSha256: digest(item.required),
      requiredSourceExistingCount: 1,
      requiredSourceExistingSha256: digest(item.required),
      requiredSourceCreationCount: 0,
      requiredSourceCreationSha256: digest(""),
      candidates
    };
  });
  const intakeSha256 = fileDigest(paths.intake);
  writeJson(paths.manifest, {
    schemaVersion: "ranker-corpus.v1",
    corpusId,
    sealed: true,
    sampleOnly: false,
    status: "materialized",
    lineageRegistry: path.basename(paths.registry),
    materializer: {
      kairnCommit: "c".repeat(40),
      intakeSha256,
      candidateLimit: 64,
      graphHops: 1,
      caseProcessIsolation: true
    },
    cases: manifestCases
  });
  writeJson(paths.report, {
    schemaVersion: "ranker-corpus-materialization-report.v1",
    corpusId,
    sampleOnly: false,
    kairnCommit: "c".repeat(40),
    intakeSha256,
    caseProcessIsolation: true,
    caseCount: definitions.length,
    candidateRecallEligibleCases: definitions.length,
    candidateRecallAt64: 2 / 3,
    positiveSourceAnyHitRateAt64: 2 / 3,
    officialPatchMeanRecallAt64: 2 / 3,
    officialPatchMeanRecallAt128: 2 / 3,
    cases: definitions.map((item) => ({
      id: item.id,
      requiredSourceRecallAt64: item.recall,
      requiredSourceExistingFiles: [item.required],
      requiredSourceCreationFiles: [],
      missingRequiredSourceFiles: item.missing,
      missingExplicitNoiseFiles: []
    }))
  });
  writeJson(paths.application, {
    schemaVersion: "ranker-corpus-review-application.v1",
    corpusId,
    sealed: true,
    caseCount: definitions.length,
    reviewers: ["independent reviewer"],
    requiredSourceOracleCases: definitions.length,
    explicitNoiseLabels: definitions.length * noisePaths.length,
    decisionsSha256: digest(JSON.stringify(
      decisions.map(({ id, decision }) => ({ id, decision })).sort((left, right) => left.id.localeCompare(right.id))
    )),
    output: {
      intakeSha256,
      lineageRegistrySha256: fileDigest(paths.registry)
    }
  });
  fs.writeFileSync(paths.corpus, definitions.map((item) => JSON.stringify({ caseId: item.id })).join("\n") + "\n", "utf8");
  writeJson(paths.summary, {
    schemaVersion: "ranker-corpus-summary.v1",
    corpusId,
    sealed: true,
    sampleOnly: false,
    caseCount: definitions.length,
    candidateRows: manifestCases.reduce((total, item) => total + item.candidates.length, 0),
    labeledRows: manifestCases.reduce((total, item) => total + item.candidates.length, 0),
    unlabeledRows: 0,
    zeroPositiveCases: 1,
    requiredSourceCreationCases: 0,
    requiredSourceCreationFiles: 0,
    manifestSha256: fileDigest(paths.manifest),
    lineageRegistrySha256: fileDigest(paths.registry),
    corpusSha256: fileDigest(paths.corpus)
  });

  return {
    options: {
      intakePath: paths.intake,
      registryPath: paths.registry,
      reviewApplicationPath: paths.application,
      reviewDecisionsPath: paths.decisions,
      manifestPath: paths.manifest,
      reportPath: paths.report,
      corpusPath: paths.corpus,
      corpusSummaryPath: paths.summary,
      outPath: paths.out
    }
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileDigest(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
