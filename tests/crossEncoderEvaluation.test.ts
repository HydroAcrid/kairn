// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  appendMissingLabeledCandidates,
  collapseCrossEncoderDocumentScores,
  rankCrossEncoderCandidates,
  repositoryIndexSnapshotCacheKey,
  repositorySnapshotPrefix,
  selectFrozenSnapshot,
  type SnapshotCatalogEntry
} from "../src/bench/crossEncoderEvaluation.js";

describe("cross-encoder frozen-pool evaluation", () => {
  it("preserves frozen order and appends only missing reviewed rows deterministically", () => {
    const first = { path: "src/a.ts" };
    const second = { path: "src/b.ts" };
    const result = appendMissingLabeledCandidates(
      [first, second],
      new Map([
        ["src/z.ts", { path: "src/z.ts" }],
        ["src/a.ts", { path: "src/a.ts" }],
        ["src/c.ts", { path: "src/c.ts" }]
      ])
    );
    expect(result.map((candidate) => candidate.path)).toEqual([
      "src/a.ts", "src/b.ts", "src/c.ts", "src/z.ts"
    ]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  it("maps a repository and ref to exactly one immutable snapshot", () => {
    const expected = entry("expected-key", "/cache/worktrees/one");
    expect(selectFrozenSnapshot({
      catalog: [entry("other-key", "/cache/worktrees/no-match"), expected],
      expectedCacheKey: "expected-key"
    })).toBe(expected);
    expect(() => selectFrozenSnapshot({
      catalog: [expected, entry("expected-key", "/other/duplicate")],
      expectedCacheKey: "expected-key"
    })).toThrow(/exactly one/);
  });

  it("binds a snapshot key to lineage, full ref, model, schema, mode, and implementation", () => {
    const base = {
      repositoryLineageId: "https://example.com/repo",
      repositoryRef: "a".repeat(40),
      modelManifestSha256: "b".repeat(64),
      implementationSha256: "c".repeat(64)
    };
    expect(repositoryIndexSnapshotCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(repositoryIndexSnapshotCacheKey(base)).not.toBe(repositoryIndexSnapshotCacheKey({
      ...base,
      repositoryRef: "d".repeat(40)
    }));
    expect(repositorySnapshotPrefix(base.repositoryLineageId, base.repositoryRef)).toContain("-");
  });

  it("collapses structural documents by maximum score and records provenance", () => {
    expect(collapseCrossEncoderDocumentScores({
      path: "src/auth.ts",
      documents: [{ hash: "b", logit: -1 }, { hash: "a", logit: 2 }],
      fallbackLogit: -10,
      probability: (value) => value,
      exactPath: 0,
      failureReference: 0,
      generatedVendor: 0
    })).toMatchObject({
      logit: 2,
      probability: 2,
      documentCount: 2,
      documentHashes: ["a", "b"],
      documentSource: "semantic_documents_v5",
      selectedDocumentKind: null,
      selectedDocumentSymbol: null,
      semanticSelectorSimilarity: null
    });
  });

  it("preserves hard evidence and uses stable path tie-breaking", () => {
    const base = {
      probability: 0.5,
      documentCount: 1,
      documentHashes: ["hash"],
      documentSource: "semantic_documents_v5" as const,
      selectedDocumentKind: null,
      selectedDocumentSymbol: null,
      semanticSelectorSimilarity: null,
      inFrozenPool: true,
      generatedVendor: 0
    };
    const ranked = rankCrossEncoderCandidates([
      { ...base, path: "z.ts", logit: 10, exactPath: 0, failureReference: 0 },
      { ...base, path: "b.ts", logit: 1, exactPath: 1, failureReference: 0 },
      { ...base, path: "a.ts", logit: 1, exactPath: 1, failureReference: 0 },
      { ...base, path: "failure.ts", logit: -10, exactPath: 0, failureReference: 1 }
    ]);
    expect(ranked.map((item) => item.path)).toEqual(["failure.ts", "a.ts", "b.ts", "z.ts"]);
  });
});

function entry(cacheKey: string, sourceRootPath: string): SnapshotCatalogEntry {
  return {
    databasePath: "/cache/db.sqlite",
    manifestPath: "/cache/db.sqlite.manifest.json",
    cacheKey,
    sourceRootPath,
    databaseSha256: "a".repeat(64)
  };
}
