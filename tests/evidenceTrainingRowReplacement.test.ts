// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceEvidenceTrainingCaseRows } from "../scripts/replace-evidence-training-case-rows.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("evidence training row replacement", () => {
  it("replaces one complete case while preserving order and provenance", () => {
    const fixture = createFixture();
    const summary = replaceEvidenceTrainingCaseRows(fixture.options);
    const rows = readRows(fixture.options.outPath);

    expect(rows.map((row) => `${row.caseGroupId}:${row.candidatePath}`)).toEqual([
      "case-a:a.ts",
      "case-b:new.ts",
      "case-c:c.ts"
    ]);
    expect(summary).toMatchObject({
      promotionEligible: false,
      unchangedCaseCount: 2,
      replacedCaseCount: 1,
      output: { rowCount: 3 }
    });
  });

  it("rejects a replacement whose case identity changed", () => {
    const fixture = createFixture({ replacementSplit: "calibration" });
    expect(() => replaceEvidenceTrainingCaseRows(fixture.options)).toThrow(
      "case-b: replacement case identity changed at split"
    );
  });

  it("rejects replacement cases absent from the base rows", () => {
    const fixture = createFixture({ replacementCaseId: "case-missing" });
    expect(() => replaceEvidenceTrainingCaseRows(fixture.options)).toThrow(
      "replacement case 'case-missing' is absent from the base rows"
    );
  });
});

function createFixture(overrides: { replacementSplit?: string; replacementCaseId?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-row-replacement-"));
  temporaryDirectories.push(root);
  const basePath = path.join(root, "base.jsonl");
  const replacementPath = path.join(root, "replacement.jsonl");
  const outPath = path.join(root, "out.jsonl");
  const summaryPath = path.join(root, "summary.json");
  writeRows(basePath, [row("case-a", "a.ts"), row("case-b", "old.ts"), row("case-c", "c.ts")]);
  writeRows(replacementPath, [
    row(overrides.replacementCaseId ?? "case-b", "new.ts", overrides.replacementSplit ?? "train")
  ]);
  return { options: { basePath, replacementPath, outPath, summaryPath } };
}

function row(caseGroupId: string, candidatePath: string, split = "train"): Record<string, unknown> {
  return {
    featureSchemaVersion: "evidence-features-v4",
    repositoryLineageId: "https://github.com/example/repository",
    caseGroupId,
    split,
    language: "typescript",
    scenario: "source_localization",
    candidatePath,
    isPublic: true,
    publicSourceUrl: "https://example.com/public-case",
    dataOrigin: "public_patch",
    label: candidatePath === "new.ts" ? 0 : 1,
    labelWeight: 1,
    labelProvenance: candidatePath === "new.ts" ? "explicit_noise_or_excluded" : "required_source_oracle",
    features: []
  };
}

function writeRows(target: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(target, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function readRows(target: string): Array<Record<string, unknown>> {
  return fs.readFileSync(target, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
