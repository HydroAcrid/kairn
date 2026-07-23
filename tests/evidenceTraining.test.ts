import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateEvidenceRankerArtifact } from "../src/retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES } from "../src/types/evidence.js";
import { materializeEvidenceCorpus } from "../scripts/materialize-evidence-corpus.js";
import { patchFiles } from "../scripts/build-public-evidence-intake.js";
import { buildCorpusReviewQueue } from "../scripts/build-corpus-review-queue.js";
import { applyCorpusReviewDecisions } from "../scripts/apply-corpus-review-decisions.js";
import { createFixtureRepo } from "./helpers.js";

function pythonInvocation(): { command: string; prefix: string[] } {
  if (process.env.KAIRN_PYTHON) return { command: process.env.KAIRN_PYTHON, prefix: [] };
  return process.platform === "win32"
    ? { command: "py", prefix: ["-3"] }
    : { command: "python3", prefix: [] };
}

describe("public evidence ranker training", () => {
  it("extracts official patch paths without learning fixture identities", () => {
    expect(patchFiles([
      "diff --git a/src/engine.ts b/src/engine.ts",
      "--- a/src/engine.ts",
      "+++ b/src/engine.ts",
      "diff --git a/tests/engine.test.ts b/tests/engine.test.ts"
    ].join("\n"))).toEqual(["src/engine.ts", "tests/engine.test.ts"]);
  });

  it("materializes candidate features from the same bounded serving path", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-materialize-"));
    const fixture = createFixtureRepo();
    const repositoryRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
    const repositoryLineageId = "https://github.com/example/evidence-fixture";
    const registryPath = path.join(temporary, "lineages.json");
    const intakePath = path.join(temporary, "intake.json");
    const manifestPath = path.join(temporary, "materialized.json");
    const reportPath = path.join(temporary, "materialization-report.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: "lineage-registry.v1",
      lineages: [{ id: repositoryLineageId, role: "train" }]
    }), "utf8");
    const noise = [
      "src/app.ts", "src/widgets.ts", "src/app.test.ts", "app/dashboard/page.tsx",
      "app/dashboard/DashboardCard.tsx", "src/lib/jobs/types.ts"
    ];
    fs.writeFileSync(intakePath, JSON.stringify({
      schemaVersion: "ranker-corpus-intake.v1",
      corpusId: "materializer-sample",
      featureSchemaVersion: "evidence-features-v1",
      sealed: false,
      sampleOnly: true,
      lineageRegistry: "lineages.json",
      cases: [{
        id: "materialized-train-case",
        split: "train",
        language: "typescript",
        scenario: "source_localization",
        repositoryLineageId,
        repositoryUrl: repositoryLineageId,
        repositoryRef,
        publicSourceUrl: "https://github.com/example/evidence-fixture/issues/1",
        dataOrigin: "public_benchmark",
        prompt: `Fix src/user.ts; inspect ${noise.join(", ")}`,
        requiredSourceFiles: ["src/user.ts"],
        officialPatchSourceFiles: [],
        verifiedObservedReadTouchFiles: [],
        qualityVerified: false,
        explicitNoiseFiles: noise,
        localFixtureRoot: fixture
      }]
    }), "utf8");

    const result = await materializeEvidenceCorpus({
      intakePath,
      outPath: manifestPath,
      reportPath,
      cacheDir: path.join(temporary, "cache"),
      allowSample: true,
      allowLocalFixture: true,
      draft: true,
      processIsolation: true
    });

    expect(result.caseCount).toBe(1);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.cases[0].candidates.length).toBeGreaterThanOrEqual(7);
    expect(manifest.materializer.caseProcessIsolation).toBe(true);
    expect(manifest.cases[0].candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/user.ts",
        label: 1,
        labelWeight: 1,
        labelProvenance: "required_source_oracle"
      })
    ]));
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toMatchObject({
      candidateRecallAt64: 1,
      cases: [expect.objectContaining({
        explicitNegativeCount: 6,
        requiredSourceRecallAt64: 1,
        officialPatchSourceRecallAt128: null,
        signals: expect.objectContaining({ explicitPaths: expect.arrayContaining(["src/user.ts"]) }),
        enrichedCandidatePaths: expect.arrayContaining(["src/user.ts"]),
        index: expect.objectContaining({ fileCount: expect.any(Number), symbolCount: expect.any(Number) })
      })]
    });
    const reviewPath = path.join(temporary, "review.json");
    const reviewQueue = buildCorpusReviewQueue({
      intakePath,
      manifestPath,
      reportPath,
      outPath: reviewPath
    });
    expect(reviewQueue).toMatchObject({
      caseCount: 1,
      requiredSourceReviewCases: 0,
      explicitNoiseReviewCases: 0,
      readyForSealCases: 1
    });
    fs.writeFileSync(reviewPath, `${JSON.stringify(reviewQueue, null, 2)}\n`, "utf8");
    const reviewedIntakePath = path.join(temporary, "intake.reviewed.json");
    const reviewSummaryPath = path.join(temporary, "review-application.json");
    expect(() => applyCorpusReviewDecisions({
      intakePath,
      manifestPath,
      reportPath,
      reviewQueuePath: reviewPath,
      outPath: reviewedIntakePath,
      summaryOutPath: reviewSummaryPath
    })).toThrow("decision.reviewer");

    const reviewedQueue = JSON.parse(JSON.stringify(reviewQueue));
    reviewedQueue.cases[0].decision.reviewer = "independent-reviewer";
    reviewedQueue.cases[0].decision.reviewedAt = "2026-07-22T12:00:00.000Z";
    reviewedQueue.cases[0].decision.notes = "Required source and six task-irrelevant candidates checked against the public fixture.";
    fs.writeFileSync(reviewPath, `${JSON.stringify(reviewedQueue, null, 2)}\n`, "utf8");
    const overlappingQueue = JSON.parse(JSON.stringify(reviewedQueue));
    overlappingQueue.cases[0].decision.explicitNoiseFiles.push("src/user.ts");
    fs.writeFileSync(reviewPath, `${JSON.stringify(overlappingQueue, null, 2)}\n`, "utf8");
    expect(() => applyCorpusReviewDecisions({
      intakePath,
      manifestPath,
      reportPath,
      reviewQueuePath: reviewPath,
      outPath: reviewedIntakePath,
      summaryOutPath: reviewSummaryPath
    })).toThrow("positive and explicit-noise labels overlap");
    fs.writeFileSync(reviewPath, `${JSON.stringify(reviewedQueue, null, 2)}\n`, "utf8");
    expect(applyCorpusReviewDecisions({
      intakePath,
      manifestPath,
      reportPath,
      reviewQueuePath: reviewPath,
      outPath: reviewedIntakePath,
      summaryOutPath: reviewSummaryPath
    })).toMatchObject({
      sealed: true,
      caseCount: 1,
      reviewers: ["independent-reviewer"],
      requiredSourceOracleCases: 1,
      explicitNoiseLabels: 6
    });
    expect(JSON.parse(fs.readFileSync(reviewedIntakePath, "utf8"))).toMatchObject({
      sealed: true,
      lineageRegistry: "lineages.json",
      cases: [expect.objectContaining({ requiredSourceFiles: ["src/user.ts"], explicitNoiseFiles: noise })]
    });

    const sealedManifestPath = path.join(temporary, "materialized.sealed.json");
    await materializeEvidenceCorpus({
      intakePath: reviewedIntakePath,
      outPath: sealedManifestPath,
      reportPath: path.join(temporary, "materialization.sealed-report.json"),
      cacheDir: path.join(temporary, "cache"),
      allowSample: true,
      allowLocalFixture: true,
      processIsolation: true
    });
    expect(JSON.parse(fs.readFileSync(sealedManifestPath, "utf8"))).toMatchObject({
      sealed: true,
      status: "materialized",
      materializer: expect.objectContaining({ caseProcessIsolation: true })
    });
  });

  it("evaluates every v0.3 promotion gate without treating synthetic mechanics as promotion evidence", () => {
    const python = pythonInvocation();
    const result = spawnSync(python.command, [
      ...python.prefix,
      path.resolve("scripts/evaluate-ranker-promotion.py"),
      "--input", path.resolve("benchmarks/evidence-promotion.sample.json"),
      "--allow-sample"
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      gatesPassed: boolean;
      promotionEligible: boolean;
      checks: Record<string, boolean>;
    };
    expect(report.gatesPassed).toBe(true);
    expect(report.promotionEligible).toBe(false);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
  });

  it("exports a runtime-valid, reproducible artifact from the synthetic sample", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-training-"));
    const output = path.join(temporary, "sample.json");
    const python = pythonInvocation();
    const result = spawnSync(python.command, [
      ...python.prefix,
      path.resolve("scripts/train-evidence-ranker.py"),
      "--input", path.resolve("benchmarks/evidence-training.sample.jsonl"),
      "--out", output,
      "--model-id", "sample-evidence-v1",
      "--node", process.execPath,
      "--public-data-only"
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const artifact = validateEvidenceRankerArtifact(JSON.parse(fs.readFileSync(output, "utf8")));
    const manifest = JSON.parse(fs.readFileSync(path.join(temporary, "sample-evidence-v1.training-manifest.json"), "utf8"));
    expect(artifact.modelId).toBe("sample-evidence-v1");
    expect(manifest.publicDataOnly).toBe(true);
    expect(manifest.rows).toEqual({ train: 4, calibration: 4, holdout: 4 });
    expect(manifest.crossValidationGroup).toBe("repositoryLineageId");
    expect(manifest.holdout).toMatchObject({ rows: 4, status: "sealed_not_evaluated" });
  });

  it("constructs a bounded sample corpus only after lineage and label checks pass", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-corpus-"));
    const registryPath = path.join(temporary, "lineages.json");
    const manifestPath = path.join(temporary, "corpus.json");
    const outputPath = path.join(temporary, "corpus.jsonl");
    const summaryPath = path.join(temporary, "summary.json");
    const roles = ["train", "calibration", "holdout"] as const;
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: "lineage-registry.v1",
      lineages: roles.map((role) => ({ id: `synthetic:${role}`, role }))
    }), "utf8");
    const features = Object.fromEntries(EVIDENCE_FEATURE_NAMES.map((name) => [name, 0]));
    const cases = roles.map((split) => ({
      id: `${split}-case`,
      split,
      language: split === "train" ? "python" : split === "calibration" ? "typescript" : "go",
      scenario: "source_localization",
      repositoryLineageId: `synthetic:${split}`,
      publicSourceUrl: "https://github.com/HydroAcrid/kairn/tree/main/benchmarks",
      dataOrigin: "public_benchmark",
      candidates: [
        {
          path: "src/required.ts",
          features: { ...features, exactPath: 1, productionSource: 1 },
          label: 1,
          labelWeight: 1,
          labelProvenance: "required_source_oracle"
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          path: `noise/${index}.md`,
          features: { ...features, docsFile: 1 },
          label: 0,
          labelWeight: 1,
          labelProvenance: "explicit_noise_or_excluded"
        }))
      ]
    }));
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "ranker-corpus.v1",
      corpusId: "sample-corpus",
      featureSchemaVersion: "evidence-features-v1",
      sealed: true,
      sampleOnly: true,
      lineageRegistry: "lineages.json",
      cases
    }), "utf8");

    const python = pythonInvocation();
    const result = spawnSync(python.command, [
      ...python.prefix,
      path.resolve("scripts/build-evidence-corpus.py"),
      "--manifest", manifestPath,
      "--out", outputPath,
      "--summary-out", summaryPath,
      "--allow-sample"
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(outputPath, "utf8").trim().split("\n")).toHaveLength(21);
    expect(JSON.parse(fs.readFileSync(summaryPath, "utf8"))).toMatchObject({
      sampleOnly: true,
      caseCount: 3,
      candidateRows: 21,
      labeledRows: 21
    });
  });

  it("rejects a production corpus that bypasses checkout materialization provenance", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-unmaterialized-"));
    const registryPath = path.join(temporary, "lineages.json");
    const manifestPath = path.join(temporary, "corpus.json");
    fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: "lineage-registry.v1", lineages: [] }), "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: "ranker-corpus.v1",
      corpusId: "unmaterialized-production",
      featureSchemaVersion: "evidence-features-v1",
      sealed: true,
      sampleOnly: false,
      lineageRegistry: "lineages.json",
      cases: []
    }), "utf8");
    const python = pythonInvocation();
    const result = spawnSync(python.command, [
      ...python.prefix,
      path.resolve("scripts/build-evidence-corpus.py"),
      "--manifest", manifestPath,
      "--out", path.join(temporary, "corpus.jsonl"),
      "--summary-out", path.join(temporary, "summary.json")
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("materializer");
  });

  it("rejects a labeled row that is not declared public", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-private-"));
    const input = path.join(temporary, "private.jsonl");
    const sample = fs.readFileSync(path.resolve("benchmarks/evidence-training.sample.jsonl"), "utf8");
    fs.writeFileSync(input, sample.replace('"isPublic":true', '"isPublic":false'), "utf8");
    const python = pythonInvocation();
    const result = spawnSync(python.command, [
      ...python.prefix,
      path.resolve("scripts/train-evidence-ranker.py"),
      "--input", input,
      "--out", path.join(temporary, "rejected.json"),
      "--model-id", "must-not-export",
      "--node", process.execPath,
      "--public-data-only"
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("isPublic=true");
  });
});
