import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateEvidenceRankerArtifact } from "../src/retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES } from "../src/types/evidence.js";

function pythonInvocation(): { command: string; prefix: string[] } {
  if (process.env.KAIRN_PYTHON) return { command: process.env.KAIRN_PYTHON, prefix: [] };
  return process.platform === "win32"
    ? { command: "py", prefix: ["-3"] }
    : { command: "python3", prefix: [] };
}

describe("public evidence ranker training", () => {
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
