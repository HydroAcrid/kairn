// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { carryForwardCorpusReviews } from "../scripts/carry-forward-corpus-reviews.js";

describe("corpus review carry-forward", () => {
  it("reuses only completed decisions whose task, labels, and candidate membership are unchanged", () => {
    const fixture = carryForwardFixture();
    const result = carryForwardCorpusReviews(fixture.options);
    const cases = result.queue.cases as Array<any>;

    expect(result.audit).toMatchObject({
      schemaVersion: "ranker-corpus-review-carry-forward-audit.v1",
      caseCount: 3,
      carriedCaseCount: 1,
      alreadyCompletedCaseCount: 0,
      pendingCaseCount: 2
    });
    expect(cases[0].decision).toMatchObject({
      reviewer: "independent-reviewer",
      reviewedAt: "2026-07-23T12:00:00.000Z"
    });
    expect(cases[1].decision.reviewer).toBeNull();
    expect(cases[2].decision.reviewer).toBeNull();
    expect((result.audit.cases as Array<any>)[1]).toMatchObject({
      status: "pending_fresh_review",
      reasons: ["reviewed_explicit_noise_missing"]
    });
    expect((result.audit.cases as Array<any>)[2]).toMatchObject({
      status: "pending_fresh_review",
      reasons: ["identity_changed:prompt"]
    });
  });

  it("does not overwrite review work already completed in the current queue", () => {
    const fixture = carryForwardFixture();
    const queue = readJson(fixture.options.queuePath);
    queue.cases[0].decision = {
      ...queue.cases[0].decision,
      reviewer: "current-reviewer",
      reviewedAt: "2026-07-23T18:00:00.000Z",
      notes: "Current review wins."
    };
    writeJson(fixture.options.queuePath, queue);

    const result = carryForwardCorpusReviews(fixture.options);
    const first = (result.queue.cases as Array<any>)[0];
    expect(first.decision.reviewer).toBe("current-reviewer");
    expect(result.audit).toMatchObject({
      carriedCaseCount: 0,
      alreadyCompletedCaseCount: 1,
      pendingCaseCount: 2
    });
  });

  it("carries a current subset after holdout cases move to a detached corpus", () => {
    const fixture = carryForwardFixture();
    const queue = readJson(fixture.options.queuePath);
    queue.cases = queue.cases.slice(0, 2);
    queue.caseCount = queue.cases.length;
    writeJson(fixture.options.queuePath, queue);

    const result = carryForwardCorpusReviews(fixture.options);

    expect(result.audit).toMatchObject({
      caseCount: 2,
      priorCaseCount: 3,
      excludedPriorCaseCount: 1,
      carriedCaseCount: 1,
      pendingCaseCount: 1
    });
    expect((result.queue.cases as Array<any>).map((item) => item.id)).toEqual([
      "stable",
      "missing-noise"
    ]);
  });

  it("does not reject reviewed creation paths that cannot exist in the candidate union", () => {
    const fixture = carryForwardFixture();
    const prior = readJson(fixture.options.priorQueuePath);
    const queue = readJson(fixture.options.queuePath);
    const creationPath = prior.cases[0].requiredSourceFiles[0];
    prior.cases[0].candidates = prior.cases[0].candidates.filter(
      (candidate: { path: string }) => candidate.path !== creationPath
    );
    queue.cases[0].candidates = queue.cases[0].candidates.filter(
      (candidate: { path: string }) => candidate.path !== creationPath
    );
    queue.cases[0].requiredSourceCreationFiles = [creationPath];
    writeJson(fixture.options.priorQueuePath, prior);
    writeJson(fixture.options.queuePath, queue);

    const result = carryForwardCorpusReviews(fixture.options);

    expect((result.queue.cases as Array<any>)[0].decision.reviewer).toBe("independent-reviewer");
    expect((result.audit.cases as Array<any>)[0]).toMatchObject({ status: "carried_forward" });
  });

  it("rejects a prior queue from a different corpus", () => {
    const fixture = carryForwardFixture();
    const prior = readJson(fixture.options.priorQueuePath);
    prior.corpusId = "different-corpus";
    writeJson(fixture.options.priorQueuePath, prior);

    expect(() => carryForwardCorpusReviews(fixture.options)).toThrow("queue corpusId mismatch");
  });
});

function carryForwardFixture(): {
  options: {
    queuePath: string;
    priorQueuePath: string;
    outPath: string;
    auditOutPath: string;
  };
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-carry-reviews-"));
  const priorQueuePath = path.join(root, "prior.json");
  const queuePath = path.join(root, "current.json");
  const baseCases = [
    reviewCase("stable", "Repair stable behavior"),
    reviewCase("missing-noise", "Repair missing noise behavior"),
    reviewCase("changed-prompt", "Repair original behavior")
  ];
  const priorCases = baseCases.map((item) => ({
    ...item,
    decision: {
      requiredSourceFiles: item.requiredSourceFiles,
      explicitNoiseFiles: item.explicitNoiseFiles,
      reviewer: "independent-reviewer",
      reviewedAt: "2026-07-23T12:00:00.000Z",
      notes: "Reviewed against the public task."
    }
  }));
  const currentCases = baseCases.map((item) => ({
    ...item,
    decision: {
      requiredSourceFiles: item.requiredSourceFiles,
      explicitNoiseFiles: item.explicitNoiseFiles,
      reviewer: null,
      reviewedAt: null,
      notes: null
    }
  }));
  currentCases[1].candidates = currentCases[1].candidates.filter(
    (candidate: { path: string }) => candidate.path !== currentCases[1].explicitNoiseFiles[0]
  );
  currentCases[2].prompt = "Repair changed behavior";
  writeJson(priorQueuePath, reviewQueue(priorCases));
  writeJson(queuePath, reviewQueue(currentCases));
  return {
    options: {
      queuePath,
      priorQueuePath,
      outPath: path.join(root, "out.json"),
      auditOutPath: path.join(root, "audit.json")
    }
  };
}

function reviewCase(id: string, prompt: string): any {
  const requiredSourceFiles = [`src/${id}.ts`];
  const explicitNoiseFiles = Array.from({ length: 6 }, (_, index) => `noise/${id}-${index}.md`);
  return {
    id,
    split: "train",
    language: "typescript",
    scenario: "source_localization",
    repositoryLineageId: "https://example.test/repository",
    repositoryRef: "a".repeat(40),
    publicSourceUrl: "https://example.test/task",
    prompt,
    candidatePathsSha256: id.padEnd(64, "0"),
    requiredSourceFiles,
    officialPatchSourceFiles: requiredSourceFiles,
    explicitNoiseFiles,
    candidates: [...requiredSourceFiles, ...explicitNoiseFiles].map((candidatePath) => ({
      path: candidatePath,
      reasons: ["lexical"]
    })),
    materializedCaseSha256: id.padEnd(64, "1"),
    decision: {
      requiredSourceFiles,
      explicitNoiseFiles,
      reviewer: null,
      reviewedAt: null,
      notes: null
    }
  };
}

function reviewQueue(cases: any[]): any {
  return {
    schemaVersion: "ranker-corpus-review-queue.v1",
    corpusId: "carry-forward-fixture",
    caseCount: cases.length,
    cases
  };
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
