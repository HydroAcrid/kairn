import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateEvidenceRankerArtifact } from "../src/retrieval/evidenceModel.js";

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
    expect(manifest.holdout.expectedCalibrationError).toBeTypeOf("number");
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
