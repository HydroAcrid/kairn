import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEvidenceRankerArtifact } from "../src/retrieval/evidenceModel.js";
import { EVIDENCE_FEATURE_NAMES } from "../src/types/evidence.js";
import {
  assertSemanticMaterializationReady,
  buildRepositoryIndexSnapshotCacheKey,
  buildSemanticLineageCacheKey,
  buildSemanticSnapshotCacheKey,
  materializeEvidenceCorpus,
  persistRepositoryIndexSnapshot,
  persistSnapshotEmbeddingCache,
  readIsolatedMaterializationProgress,
  restoreRepositoryIndexSnapshot,
  restoreSnapshotEmbeddingCache,
  selectIntakeCases,
  writeIsolatedMaterializationProgress
} from "../scripts/materialize-evidence-corpus.js";
import {
  patchFiles,
  type Language,
  type PublicEvidenceCase
} from "../scripts/build-public-evidence-intake.js";
import {
  buildDetachedHoldoutArtifacts,
  selectDetachedHoldout
} from "../scripts/build-detached-holdout-intake.js";
import { buildCorpusReviewQueue } from "../scripts/build-corpus-review-queue.js";
import { applyCorpusReviewDecisions } from "../scripts/apply-corpus-review-decisions.js";
import { ensureKairnDir } from "../src/config/paths.js";
import { SqliteStore } from "../src/store/sqliteStore.js";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { createFixtureRepo } from "./helpers.js";

function pythonInvocation(): { command: string; prefix: string[] } {
  if (process.env.KAIRN_PYTHON) return { command: process.env.KAIRN_PYTHON, prefix: [] };
  return process.platform === "win32"
    ? { command: "py", prefix: ["-3"] }
    : { command: "python3", prefix: [] };
}

describe("public evidence ranker training", () => {
  let previousCandidateMode: string | undefined;

  beforeEach(() => {
    previousCandidateMode = process.env.KAIRN_CANDIDATE_MODE;
    process.env.KAIRN_CANDIDATE_MODE = "legacy";
  });

  afterEach(() => {
    if (previousCandidateMode === undefined) delete process.env.KAIRN_CANDIDATE_MODE;
    else process.env.KAIRN_CANDIDATE_MODE = previousCandidateMode;
  });

  it("extracts official patch paths without learning fixture identities", () => {
    expect(patchFiles([
      "diff --git a/src/engine.ts b/src/engine.ts",
      "--- a/src/engine.ts",
      "+++ b/src/engine.ts",
      "diff --git a/tests/engine.test.ts b/tests/engine.test.ts"
    ].join("\n"))).toEqual(["src/engine.ts", "tests/engine.test.ts"]);
  });

  it("selects a fresh lineage-disjoint holdout with every language and scenario cell", () => {
    const languages: Language[] = ["python", "typescript", "go", "java", "cpp"];
    const targets: Record<Language, number> = {
      python: 3,
      typescript: 2,
      go: 2,
      java: 2,
      cpp: 1
    };
    const pool: PublicEvidenceCase[] = [];
    for (const language of languages) {
      for (let repositoryIndex = 0; repositoryIndex < targets[language] + 1; repositoryIndex += 1) {
        const repository = `public/${language}-repo-${repositoryIndex}`;
        for (let caseIndex = 0; caseIndex < 6; caseIndex += 1) {
          pool.push({
            sourceId: `${language}:${repositoryIndex}:${caseIndex}`,
            sourceUrl: `https://example.test/${language}/${repositoryIndex}/${caseIndex}`,
            repository,
            repositoryRef: String(repositoryIndex + 1).repeat(40),
            language,
            prompt: `General public task ${caseIndex}`,
            productionPatchFiles: [`src/implementation-${caseIndex}.${language === "python" ? "py" : "txt"}`],
            changedFiles: [`src/implementation-${caseIndex}.txt`, `src/companion-${caseIndex}.txt`],
            failureReferences: [`public failure ${caseIndex}`]
          });
        }
      }
    }
    const excluded = new Set(languages.map((language) =>
      `https://github.com/public/${language}-repo-0`
    ));
    const selected = selectDetachedHoldout(pool, excluded);

    expect(selected.assignments).toHaveLength(30);
    expect(new Set(selected.assignments.map((item) => item.row.sourceId)).size).toBe(30);
    for (const language of languages) {
      expect(selected.repositoriesByLanguage[language]).toHaveLength(targets[language]);
      expect(selected.repositoriesByLanguage[language]).not.toContain(`public/${language}-repo-0`);
      for (const scenario of ["source_localization", "failure_first", "long_session"] as const) {
        expect(selected.assignments.filter((item) =>
          item.row.language === language && item.scenario === scenario
        )).toHaveLength(2);
      }
    }

    const built = buildDetachedHoldoutArtifacts({
      pool,
      existingRegistry: {
        schemaVersion: "lineage-registry.v1",
        lineages: [...excluded].map((id) => ({ id, role: "train" as const }))
      },
      registryFilename: "lineage-registry.detached.json"
    });
    expect(built.intake).toMatchObject({
      sealed: false,
      lineageRegistry: "lineage-registry.detached.json",
      sourcePoolSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      cases: expect.arrayContaining([
        expect.objectContaining({
          split: "holdout",
          requiredSourceFiles: [],
          qualityVerified: false
        })
      ])
    });
    expect(built.registry.lineages).toHaveLength(15);
    expect(built.summary).toMatchObject({
      selectedCases: 30,
      selectedLineages: 10,
      excludedLineages: 5
    });
    expect(() => buildDetachedHoldoutArtifacts({
      pool,
      existingRegistry: {
        schemaVersion: "lineage-registry.v1",
        lineages: [...excluded].map((id) => ({ id, role: "train" as const }))
      },
      registryFilename: "lineage-registry.detached.json",
      expectedPoolSha256: "0".repeat(64)
    })).toThrow("public source pool changed");
  });

  it("fails benchmark materialization when semantic serving falls back", () => {
    expect(() => assertSemanticMaterializationReady({
      requestedMode: "semantic",
      servedMode: "fallback",
      semanticIndexStatus: "unavailable",
      semanticFallbackReason: "model unavailable",
      documentCount: 10,
      embeddingCount: 0
    }, "case-a")).toThrow(
      "case-a: required semantic retrieval is not ready"
    );
    expect(() => assertSemanticMaterializationReady({
      requestedMode: "semantic",
      servedMode: "semantic",
      semanticModelId: "pinned-model",
      semanticIndexStatus: "ready",
      documentCount: 10,
      embeddingCount: 10
    }, "case-a")).not.toThrow();
  });

  it("reuses only immutable semantic embeddings across fresh isolated checkout roots", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-snapshot-cache-"));
    const firstRoot = path.join(temporary, "first");
    const secondRoot = path.join(temporary, "second");
    const cachePath = path.join(temporary, "cache", "snapshot-key.json");
    fs.mkdirSync(firstRoot, { recursive: true });
    fs.mkdirSync(secondRoot, { recursive: true });
    const firstStore = new SqliteStore(ensureKairnDir(firstRoot).databasePath);
    try {
      firstStore.upsertSemanticEmbeddings([{
        rootPath: firstRoot,
        documentId: "sdoc_test",
        documentHash: "content-hash",
        modelId: "pinned-model",
        schemaVersion: "semantic-documents-v5",
        dimensions: 3,
        vector: new Int8Array([127, 0, -127]),
        scale: 0.005
      }]);
    } finally {
      firstStore.close();
    }

    persistSnapshotEmbeddingCache(firstRoot, cachePath);
    const appendedStore = new SqliteStore(ensureKairnDir(firstRoot).databasePath);
    try {
      appendedStore.upsertSemanticEmbeddings([{
        rootPath: firstRoot,
        documentId: "sdoc_second",
        documentHash: "second-content-hash",
        modelId: "pinned-model",
        schemaVersion: "semantic-documents-v5",
        dimensions: 3,
        vector: new Int8Array([0, 127, 0]),
        scale: 0.005
      }]);
    } finally {
      appendedStore.close();
    }
    persistSnapshotEmbeddingCache(firstRoot, cachePath);
    restoreSnapshotEmbeddingCache(secondRoot, cachePath);

    const secondStore = new SqliteStore(ensureKairnDir(secondRoot).databasePath);
    try {
      expect(secondStore.listSemanticEmbeddings(secondRoot)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          rootPath: secondRoot,
          documentId: "sdoc_test",
          documentHash: "content-hash",
          modelId: "pinned-model",
          dimensions: 3,
          scale: 0.005,
          vector: new Int8Array([127, 0, -127])
        }),
        expect.objectContaining({
          rootPath: secondRoot,
          documentId: "sdoc_second",
          documentHash: "second-content-hash",
          modelId: "pinned-model",
          dimensions: 3,
          scale: 0.005,
          vector: new Int8Array([0, 127, 0])
        })
      ]));
      expect(secondStore.listSemanticEmbeddings(secondRoot)).toHaveLength(2);
      expect(secondStore.listSemanticEmbeddings(firstRoot)).toEqual([]);
    } finally {
      secondStore.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("compacts a completed semantic snapshot to current repository embeddings", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-snapshot-compact-"));
    const firstRoot = path.join(temporary, "first");
    const currentRoot = path.join(temporary, "current");
    const restoredRoot = path.join(temporary, "restored");
    const cachePath = path.join(temporary, "cache", "snapshot-key.json");
    for (const root of [firstRoot, currentRoot, restoredRoot]) {
      fs.mkdirSync(root, { recursive: true });
    }
    const writeEmbedding = (
      rootPath: string,
      documentId: string,
      documentHash: string
    ): void => {
      const store = new SqliteStore(ensureKairnDir(rootPath).databasePath);
      try {
        store.upsertSemanticEmbeddings([{
          rootPath,
          documentId,
          documentHash,
          modelId: "pinned-model",
          schemaVersion: "semantic-documents-v5",
          dimensions: 3,
          vector: new Int8Array([127, 0, -127]),
          scale: 0.005
        }]);
      } finally {
        store.close();
      }
    };

    try {
      writeEmbedding(firstRoot, "sdoc_stale", "stale-content-hash");
      persistSnapshotEmbeddingCache(firstRoot, cachePath);
      writeEmbedding(currentRoot, "sdoc_current", "current-content-hash");
      persistSnapshotEmbeddingCache(currentRoot, cachePath, { mergeExisting: false });
      restoreSnapshotEmbeddingCache(restoredRoot, cachePath);

      const restoredStore = new SqliteStore(ensureKairnDir(restoredRoot).databasePath);
      try {
        expect(restoredStore.listSemanticEmbeddings(restoredRoot)).toEqual([
          expect.objectContaining({
            documentId: "sdoc_current",
            documentHash: "current-content-hash"
          })
        ]);
      } finally {
        restoredStore.close();
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("isolates benchmark embedding snapshots by immutable repository ref", () => {
    const base = {
      repositoryLineageId: "https://github.com/example/project",
      repositoryRef: "1".repeat(40),
      modelId: "pinned-model",
      documentEmbeddingManifestSha256: "a".repeat(64),
      documentSchemaVersion: "semantic-documents-v4" as const
    };
    const firstRef = buildSemanticSnapshotCacheKey(base);
    const secondRef = buildSemanticSnapshotCacheKey({ ...base });
    const changedModel = buildSemanticSnapshotCacheKey({
      ...base,
      documentEmbeddingManifestSha256: "b".repeat(64)
    });
    const changedSchema = buildSemanticSnapshotCacheKey({
      ...base,
      documentSchemaVersion: "semantic-documents-v2"
    });
    const changedLineage = buildSemanticSnapshotCacheKey({
      ...base,
      repositoryLineageId: "https://github.com/example/other-project"
    });
    const changedRef = buildSemanticSnapshotCacheKey({
      ...base,
      repositoryRef: "2".repeat(40)
    });

    expect(firstRef).toBe(secondRef);
    expect(changedModel).not.toBe(firstRef);
    expect(changedSchema).not.toBe(firstRef);
    expect(changedLineage).not.toBe(firstRef);
    expect(changedRef).not.toBe(firstRef);
  });

  it("keys repository index snapshots only by immutable parser and model inputs", () => {
    const base = {
      repositoryLineageId: "https://github.com/example/project",
      repositoryRef: "1".repeat(40),
      modelManifestSha256: "a".repeat(64),
      documentSchemaVersion: "semantic-documents-v5",
      candidateGeneratorMode: "semantic" as const,
      implementationSha256: "b".repeat(64)
    };
    const first = buildRepositoryIndexSnapshotCacheKey(base);

    expect(buildRepositoryIndexSnapshotCacheKey({ ...base })).toBe(first);
    expect(buildRepositoryIndexSnapshotCacheKey({
      ...base,
      repositoryRef: "2".repeat(40)
    })).not.toBe(first);
    expect(buildRepositoryIndexSnapshotCacheKey({
      ...base,
      implementationSha256: "c".repeat(64)
    })).not.toBe(first);
    expect(buildRepositoryIndexSnapshotCacheKey({
      ...base,
      candidateGeneratorMode: "legacy"
    })).not.toBe(first);
  });

  it("restores a relocatable repository index without re-indexing", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-index-snapshot-"));
    const sourceRoot = createFixtureRepo();
    const restoredRoot = createFixtureRepo();
    const sourceSnapshotRoot = process.platform === "win32"
      ? sourceRoot
      : path.join(temporary, "source-root-alias");
    const restoredSnapshotRoot = process.platform === "win32"
      ? restoredRoot
      : path.join(temporary, "restored-root-alias");
    if (process.platform !== "win32") {
      fs.symlinkSync(sourceRoot, sourceSnapshotRoot, "dir");
      fs.symlinkSync(restoredRoot, restoredSnapshotRoot, "dir");
    }
    const cachePath = path.join(temporary, "repository-index-snapshots", `${"a".repeat(64)}.sqlite`);
    const sourceRuntime = new KairnRuntime(sourceRoot);
    let sourceFileCount = 0;
    try {
      await sourceRuntime.init();
      sourceFileCount = sourceRuntime.getIndexStatus().fileCount;
    } finally {
      sourceRuntime.close();
    }

    try {
      persistRepositoryIndexSnapshot(sourceSnapshotRoot, cachePath);
      expect(restoreRepositoryIndexSnapshot(restoredSnapshotRoot, cachePath)).toBe(true);

      // A benchmark snapshot represents an immutable checkout. This extra file
      // proves reuse does not silently refresh or mix mutable workspace state.
      fs.writeFileSync(path.join(restoredRoot, "src", "not-indexed.ts"), "export const NotIndexed = true;\n");
      const restoredRuntime = new KairnRuntime(restoredRoot);
      try {
        const inspection = await restoredRuntime.inspectEvidenceCandidates({
          query: "format a user greeting",
          reuseIndex: true
        });
        expect(inspection.enrichedCandidatePaths).toContain("src/user.ts");
        expect(restoredRuntime.getIndexStatus().fileCount).toBe(sourceFileCount);
        expect(inspection.enrichedCandidatePaths).not.toContain("src/not-indexed.ts");
      } finally {
        restoredRuntime.close();
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(restoredRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a repository index snapshot is corrupt", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-corrupt-index-snapshot-"));
    const sourceRoot = createFixtureRepo();
    const restoredRoot = createFixtureRepo();
    const cachePath = path.join(temporary, "repository-index-snapshots", `${"d".repeat(64)}.sqlite`);
    const runtime = new KairnRuntime(sourceRoot);
    try {
      await runtime.init();
    } finally {
      runtime.close();
    }

    try {
      persistRepositoryIndexSnapshot(sourceRoot, cachePath);
      const snapshotManifest = JSON.parse(fs.readFileSync(`${cachePath}.manifest.json`, "utf8"));
      const blobPath = path.resolve(temporary, snapshotManifest.databaseBlobPath);
      fs.appendFileSync(blobPath, "corrupt");
      expect(() => restoreRepositoryIndexSnapshot(restoredRoot, cachePath)).toThrow(
        "repository index snapshot checksum mismatch"
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(restoredRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates byte-identical repository snapshots across cache keys", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-deduplicated-index-snapshot-"));
    const sourceRoot = createFixtureRepo();
    const runtime = new KairnRuntime(sourceRoot);
    try {
      await runtime.init();
    } finally {
      runtime.close();
    }
    const firstPath = path.join(temporary, "repository-index-snapshots", `${"1".repeat(64)}.sqlite`);
    const secondPath = path.join(temporary, "repository-index-snapshots", `${"2".repeat(64)}.sqlite`);
    try {
      persistRepositoryIndexSnapshot(sourceRoot, firstPath);
      persistRepositoryIndexSnapshot(sourceRoot, secondPath);
      const first = JSON.parse(fs.readFileSync(`${firstPath}.manifest.json`, "utf8"));
      const second = JSON.parse(fs.readFileSync(`${secondPath}.manifest.json`, "utf8"));
      expect(first).toMatchObject({ formatVersion: 2 });
      expect(second.databaseBlobPath).toBe(first.databaseBlobPath);
      expect(second.databaseSha256).toBe(first.databaseSha256);
      expect(fs.readdirSync(path.join(temporary, "content-blobs", "sha256")).filter((name) => name.endsWith(".sqlite")))
        .toHaveLength(1);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("shares only content-validated rolling embeddings within one repository lineage", () => {
    const base = {
      repositoryLineageId: "https://github.com/example/project",
      modelId: "pinned-model",
      documentEmbeddingManifestSha256: "a".repeat(64),
      documentSchemaVersion: "semantic-documents-v5" as const
    };
    const first = buildSemanticLineageCacheKey(base);
    expect(buildSemanticLineageCacheKey({ ...base })).toBe(first);
    expect(buildSemanticLineageCacheKey({
      ...base,
      repositoryLineageId: "https://github.com/example/other-project"
    })).not.toBe(first);
    expect(buildSemanticLineageCacheKey({
      ...base,
      documentEmbeddingManifestSha256: "b".repeat(64)
    })).not.toBe(first);
  });

  it("restores an exact snapshot after rolling lineage state", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-lineage-cache-"));
    const lineageRoot = path.join(temporary, "lineage");
    const exactRoot = path.join(temporary, "exact");
    const targetRoot = path.join(temporary, "target");
    const lineagePath = path.join(temporary, "cache", "lineage-key.json");
    const exactPath = path.join(temporary, "cache", "exact-key.json");
    for (const root of [lineageRoot, exactRoot, targetRoot]) fs.mkdirSync(root, { recursive: true });
    const write = (rootPath: string, documentHash: string, value: number): void => {
      const store = new SqliteStore(ensureKairnDir(rootPath).databasePath);
      try {
        store.upsertSemanticEmbeddings([{
          rootPath,
          documentId: "sdoc_shared",
          documentHash,
          modelId: "pinned-model",
          schemaVersion: "semantic-documents-v5",
          dimensions: 3,
          vector: new Int8Array([value, 0, -value]),
          scale: 0.005
        }]);
      } finally {
        store.close();
      }
    };
    try {
      write(lineageRoot, "older-content", 64);
      write(exactRoot, "exact-content", 127);
      persistSnapshotEmbeddingCache(lineageRoot, lineagePath);
      persistSnapshotEmbeddingCache(exactRoot, exactPath);
      restoreSnapshotEmbeddingCache(targetRoot, lineagePath);
      restoreSnapshotEmbeddingCache(targetRoot, exactPath);
      const targetStore = new SqliteStore(ensureKairnDir(targetRoot).databasePath);
      try {
        expect(targetStore.listSemanticEmbeddings(targetRoot)).toEqual([
          expect.objectContaining({
            documentId: "sdoc_shared",
            documentHash: "exact-content",
            vector: new Int8Array([127, 0, -127])
          })
        ]);
      } finally {
        targetStore.close();
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("resumes isolated materialization only for the exact commit, intake, and case order", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-materialization-progress-"));
    const progressPath = path.join(temporary, "oracle.progress.json");
    const identity = {
      kairnCommit: "a".repeat(40),
      intakeSha256: "b".repeat(64),
      selectedCaseIds: ["case-a", "case-b"],
      probeLimit: 512
    };
    try {
      writeIsolatedMaterializationProgress(progressPath, {
        schemaVersion: "ranker-corpus-materialization-progress.v1",
        ...identity,
        complete: false,
        materializedCases: [{ id: "case-a", candidates: [] }],
        reportCases: [{ id: "case-a", requiredSourceRecallAt64: 1 }]
      });

      expect(JSON.parse(fs.readFileSync(progressPath, "utf8"))).toMatchObject({
        schemaVersion: "ranker-corpus-materialization-progress.v2",
        complete: false,
        completedCaseIds: ["case-a"]
      });
      const firstCasePath = path.join(`${progressPath}.cases`, "000000.json");
      fs.appendFileSync(firstCasePath, "\n", "utf8");
      const firstCaseWithSentinel = fs.readFileSync(firstCasePath, "utf8");

      writeIsolatedMaterializationProgress(progressPath, {
        schemaVersion: "ranker-corpus-materialization-progress.v1",
        ...identity,
        complete: true,
        materializedCases: [
          { id: "case-a", candidates: [] },
          { id: "case-b", candidates: [{ path: "src/example.ts" }] }
        ],
        reportCases: [
          { id: "case-a", requiredSourceRecallAt64: 1 },
          { id: "case-b", requiredSourceRecallAt64: 0 }
        ]
      });

      expect(fs.readFileSync(firstCasePath, "utf8")).toBe(firstCaseWithSentinel);
      expect(fs.readdirSync(`${progressPath}.cases`).sort()).toEqual([
        "000000.json",
        "000001.json"
      ]);

      expect(readIsolatedMaterializationProgress(progressPath, identity)).toMatchObject({
        complete: true,
        materializedCases: [
          { id: "case-a", candidates: [] },
          { id: "case-b", candidates: [{ path: "src/example.ts" }] }
        ],
        reportCases: [
          { id: "case-a", requiredSourceRecallAt64: 1 },
          { id: "case-b", requiredSourceRecallAt64: 0 }
        ]
      });
      expect(() => readIsolatedMaterializationProgress(progressPath, {
        ...identity,
        kairnCommit: "c".repeat(40)
      })).toThrow("does not match the current commit");
      expect(() => readIsolatedMaterializationProgress(progressPath, {
        ...identity,
        probeLimit: 256
      })).toThrow("does not match the current commit");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("migrates monolithic materialization progress without losing completed cases", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-materialization-progress-v1-"));
    const progressPath = path.join(temporary, "oracle.progress.json");
    const identity = {
      kairnCommit: "a".repeat(40),
      intakeSha256: "b".repeat(64),
      selectedCaseIds: ["case-a", "case-b"]
    };
    const legacyProgress = {
      schemaVersion: "ranker-corpus-materialization-progress.v1",
      ...identity,
      complete: false,
      materializedCases: [{ id: "case-a", candidates: [] }],
      reportCases: [{ id: "case-a", requiredSourceRecallAt64: 1 }]
    } as const;
    try {
      fs.writeFileSync(progressPath, `${JSON.stringify(legacyProgress)}\n`, "utf8");
      expect(readIsolatedMaterializationProgress(progressPath, identity)).toMatchObject({
        materializedCases: [{ id: "case-a" }]
      });

      writeIsolatedMaterializationProgress(progressPath, {
        ...legacyProgress,
        materializedCases: [
          legacyProgress.materializedCases[0],
          { id: "case-b", candidates: [] }
        ],
        reportCases: [
          legacyProgress.reportCases[0],
          { id: "case-b", requiredSourceRecallAt64: 1 }
        ]
      });

      expect(JSON.parse(fs.readFileSync(progressPath, "utf8"))).toMatchObject({
        schemaVersion: "ranker-corpus-materialization-progress.v2",
        completedCaseIds: ["case-a", "case-b"]
      });
      expect(readIsolatedMaterializationProgress(progressPath, identity)).toMatchObject({
        materializedCases: [{ id: "case-a" }, { id: "case-b" }],
        reportCases: [{ id: "case-a" }, { id: "case-b" }]
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("selects train and calibration splits without opening holdout cases", () => {
    const cases = [
      { id: "holdout-b", split: "holdout" as const },
      { id: "train-b", split: "train" as const },
      { id: "calibration-a", split: "calibration" as const },
      { id: "train-a", split: "train" as const }
    ];

    expect(selectIntakeCases(cases, {
      draft: true,
      splits: ["train", "calibration"]
    })).toEqual([
      { id: "calibration-a", split: "calibration" },
      { id: "train-a", split: "train" },
      { id: "train-b", split: "train" }
    ]);
    expect(() => selectIntakeCases(cases, {
      draft: true,
      limit: 3,
      splits: ["train", "calibration"]
    })).toThrow("--limit, --case-id, and --split are mutually exclusive");
    expect(() => selectIntakeCases(cases, {
      draft: false,
      splits: ["train", "calibration"]
    })).toThrow("partial materialization is allowed only with --draft");
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

    const materializeOptions = {
      intakePath,
      outPath: manifestPath,
      reportPath,
      cacheDir: path.join(temporary, "cache"),
      allowSample: true,
      allowLocalFixture: true,
      draft: true,
      processIsolation: true,
      migrateFeatureSchema: true,
      resume: true,
      probeLimit: 256
    } as const;
    const result = await materializeEvidenceCorpus(materializeOptions);

    expect(result.caseCount).toBe(1);
    const progressPath = `${manifestPath}.progress.json`;
    const completedReceipt = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    expect(completedReceipt).toMatchObject({
      schemaVersion: "ranker-corpus-materialization-receipt.v1",
      complete: true,
      probeLimit: 256,
      selectedCaseIds: ["materialized-train-case"]
    });
    expect(path.isAbsolute(completedReceipt.manifestPath)).toBe(false);
    expect(path.isAbsolute(completedReceipt.reportPath)).toBe(false);
    expect(fs.existsSync(`${progressPath}.cases`)).toBe(false);
    expect(readIsolatedMaterializationProgress(progressPath, {
      kairnCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      intakeSha256: crypto.createHash("sha256").update(fs.readFileSync(intakePath)).digest("hex"),
      selectedCaseIds: ["materialized-train-case"],
      probeLimit: 256
    })).toMatchObject({
      complete: true,
      materializedCases: [expect.objectContaining({ id: "materialized-train-case" })],
      reportCases: [expect.objectContaining({ id: "materialized-train-case" })]
    });
    expect(await materializeEvidenceCorpus(materializeOptions)).toMatchObject({ caseCount: 1 });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.cases[0].candidates.length).toBeGreaterThanOrEqual(7);
    expect(manifest.cases[0].trainingCandidates.length).toBeGreaterThanOrEqual(
      manifest.cases[0].candidates.length
    );
    expect(
      manifest.cases[0].trainingCandidates.slice(0, manifest.cases[0].candidates.length)
    ).toEqual(manifest.cases[0].candidates);
    expect(manifest.materializer.caseProcessIsolation).toBe(true);
    expect(manifest.materializer).toMatchObject({
      candidateLimit: 64,
      enrichedCandidateLimit: 128,
      graphHops: 1,
      migratedFeatureSchemaFrom: "evidence-features-v1"
    });
    expect(manifest.featureSchemaVersion).toBe("evidence-features-v4");
    expect(manifest.cases[0].candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/user.ts",
        label: 1,
        labelWeight: 1,
        labelProvenance: "required_source_oracle"
      })
    ]));
    const materializationReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(materializationReport).toMatchObject({
      candidateRecallAt64: 1,
      candidateRecallAt128: 1,
      positiveSourceAnyHitRateAt128: 1,
      timingSummary: expect.objectContaining({
        measuredCases: 1,
        totalCaseWorkerMs: expect.any(Number),
        phaseTotalsMs: expect.objectContaining({
          checkout: expect.any(Number),
          candidateInspection: expect.any(Number),
          embeddingCacheRestore: expect.any(Number)
        }),
        embeddingReuse: expect.objectContaining({
          reusedEmbeddings: expect.any(Number),
          generatedEmbeddings: expect.any(Number)
        })
      }),
      cases: [expect.objectContaining({
        explicitNegativeCount: 6,
        explicitNegativeCountAt64: 6,
        trainingCandidateCount: expect.any(Number),
        requiredSourceRecallAt64: 1,
        requiredSourceRecallAt128: 1,
        officialPatchSourceRecallAt128: null,
        positiveSourceHitAt128: true,
        missingRequiredSourceFilesAt128: [],
        signals: expect.objectContaining({ explicitPaths: expect.arrayContaining(["src/user.ts"]) }),
        enrichedCandidatePaths: expect.arrayContaining(["src/user.ts"]),
        index: expect.objectContaining({ fileCount: expect.any(Number), symbolCount: expect.any(Number) }),
        timingMs: expect.objectContaining({
          checkout: expect.any(Number),
          candidateInspection: expect.any(Number),
          totalWorker: expect.any(Number)
        }),
        inspectionTimingMs: expect.objectContaining({
          initializeIndex: expect.any(Number),
          candidateRetrieval: expect.any(Number),
          candidateFeatureBuild: expect.any(Number),
          total: expect.any(Number)
        }),
        isolatedProcess: expect.objectContaining({
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          elapsedMs: expect.any(Number)
        }),
        embeddingReuse: expect.objectContaining({
          warmEntriesAvailable: expect.any(Number),
          reusedEmbeddings: expect.any(Number),
          generatedEmbeddings: expect.any(Number)
        })
      })]
    });
    const staleNoiseReportPath = path.join(temporary, "materialization-report-stale-noise.json");
    const staleNoiseQueuePath = path.join(temporary, "review-stale-noise.json");
    const staleNoiseReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    staleNoiseReport.cases[0].candidates = staleNoiseReport.cases[0].candidates.filter(
      (candidate: { path: string }) => candidate.path !== noise[0]
    );
    staleNoiseReport.cases[0].candidatePathsSha256 = crypto
      .createHash("sha256")
      .update(staleNoiseReport.cases[0].candidates.map((candidate: { path: string }) => candidate.path).join("\n"))
      .digest("hex");
    fs.writeFileSync(staleNoiseReportPath, `${JSON.stringify(staleNoiseReport, null, 2)}\n`, "utf8");
    expect(buildCorpusReviewQueue({
      intakePath,
      manifestPath,
      reportPath: staleNoiseReportPath,
      outPath: staleNoiseQueuePath
    })).toMatchObject({
      explicitNoiseReviewCases: 1,
      cases: [expect.objectContaining({
        needsNoiseReview: true,
        explicitNoiseFilesPresent: noise.slice(1),
        explicitNoiseFilesMissing: [noise[0]],
        decision: expect.objectContaining({ explicitNoiseFiles: noise.slice(1) })
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
      readyForSealCases: 1,
      selection: {
        partial: false,
        sourceCaseCount: 1,
        selectedCaseCount: 1
      }
    });
    const partialIntakePath = path.join(temporary, "intake.partial-source.json");
    const partialManifestPath = path.join(temporary, "materialized.partial.json");
    const partialReportPath = path.join(temporary, "materialization-report.partial.json");
    const partialIntake = JSON.parse(fs.readFileSync(intakePath, "utf8"));
    partialIntake.sealed = true;
    partialIntake.cases.push({
      ...partialIntake.cases[0],
      id: "detached-holdout-case",
      split: "holdout",
      repositoryLineageId: "https://github.com/example/detached-holdout-fixture"
    });
    fs.writeFileSync(partialIntakePath, `${JSON.stringify(partialIntake, null, 2)}\n`, "utf8");
    const partialIntakeSha256 = crypto.createHash("sha256")
      .update(fs.readFileSync(partialIntakePath))
      .digest("hex");
    fs.writeFileSync(partialManifestPath, `${JSON.stringify({
      ...manifest,
      materializer: { ...manifest.materializer, intakeSha256: partialIntakeSha256 }
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(partialReportPath, `${JSON.stringify({
      ...materializationReport,
      intakeSha256: partialIntakeSha256,
      partial: true,
      selectedCaseIds: ["materialized-train-case"]
    }, null, 2)}\n`, "utf8");
    const partialReviewPath = path.join(temporary, "review.partial.json");
    const partialReviewQueue = buildCorpusReviewQueue({
      intakePath: partialIntakePath,
      manifestPath: partialManifestPath,
      reportPath: partialReportPath,
      outPath: partialReviewPath
    });
    expect(partialReviewQueue).toMatchObject({
      caseCount: 1,
      selection: {
        partial: true,
        sourceCaseCount: 2,
        selectedCaseCount: 1
      },
      cases: [expect.objectContaining({ id: "materialized-train-case" })]
    });
    const completedPartialReviewQueue: any = JSON.parse(JSON.stringify(partialReviewQueue));
    completedPartialReviewQueue.cases[0].decision.reviewer = "independent-partial-reviewer";
    completedPartialReviewQueue.cases[0].decision.reviewedAt = "2026-08-15T14:00:00.000Z";
    completedPartialReviewQueue.cases[0].decision.notes = "Train-only review leaves the detached holdout untouched.";
    fs.writeFileSync(partialReviewPath, `${JSON.stringify(completedPartialReviewQueue, null, 2)}\n`, "utf8");
    const partialReviewedPath = path.join(temporary, "intake.partial-reviewed.json");
    const partialReviewSummaryPath = path.join(temporary, "review.partial-application.json");
    expect(() => applyCorpusReviewDecisions({
      intakePath: partialIntakePath,
      manifestPath: partialManifestPath,
      reportPath: partialReportPath,
      reviewQueuePath: partialReviewPath,
      outPath: partialReviewedPath,
      summaryOutPath: partialReviewSummaryPath
    })).toThrow("partial materialization reports require --allow-partial");
    expect(applyCorpusReviewDecisions({
      intakePath: partialIntakePath,
      manifestPath: partialManifestPath,
      reportPath: partialReportPath,
      reviewQueuePath: partialReviewPath,
      outPath: partialReviewedPath,
      summaryOutPath: partialReviewSummaryPath,
      allowPartial: true
    })).toMatchObject({
      sealed: false,
      partial: true,
      caseCount: 1,
      sourceCaseCount: 2,
      untouchedCaseCount: 1,
      reviewers: ["independent-partial-reviewer"]
    });
    const partialReviewedIntake = JSON.parse(fs.readFileSync(partialReviewedPath, "utf8"));
    expect(partialReviewedIntake).toMatchObject({
      sealed: false,
      cases: [
        expect.objectContaining({ id: "materialized-train-case", explicitNoiseFiles: noise }),
        expect.objectContaining({ id: "detached-holdout-case" })
      ]
    });
    expect(partialReviewedIntake.cases[1]).toEqual(partialIntake.cases[1]);
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
    const unknownRequiredQueue = JSON.parse(JSON.stringify(reviewedQueue));
    unknownRequiredQueue.cases[0].decision.requiredSourceFiles = ["src/not-a-reviewed-source.ts"];
    fs.writeFileSync(reviewPath, `${JSON.stringify(unknownRequiredQueue, null, 2)}\n`, "utf8");
    expect(() => applyCorpusReviewDecisions({
      intakePath,
      manifestPath,
      reportPath,
      reviewQueuePath: reviewPath,
      outPath: reviewedIntakePath,
      summaryOutPath: reviewSummaryPath
    })).toThrow("absent from reviewed candidates and source oracles");
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
      processIsolation: true,
      migrateFeatureSchema: true
    });
    expect(JSON.parse(fs.readFileSync(sealedManifestPath, "utf8"))).toMatchObject({
      sealed: true,
      status: "materialized",
      materializer: expect.objectContaining({ caseProcessIsolation: true }),
      cases: [expect.objectContaining({
        requiredSourceOracleCount: 1,
        requiredSourceOracleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        requiredSourceExistingCount: 1,
        requiredSourceCreationCount: 0
      })]
    });

    const missedIntakePath = path.join(temporary, "intake.reviewed-miss.json");
    const missedManifestPath = path.join(temporary, "materialized.miss.json");
    const missedReportPath = path.join(temporary, "materialization.miss-report.json");
    const missedIntake = JSON.parse(fs.readFileSync(reviewedIntakePath, "utf8"));
    fs.mkdirSync(path.join(fixture, "src", "retrieval-noise"), { recursive: true });
    fs.mkdirSync(path.join(fixture, "src", "zzzz"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "src", "zzzz", "opaque.ts"),
      "export const verifiedButUnretrieved = true;\n",
      "utf8"
    );
    for (let index = 0; index < 180; index += 1) {
      fs.writeFileSync(
        path.join(fixture, "src", "retrieval-noise", `unrelated-${String(index).padStart(3, "0")}.ts`),
        `export const unrelated${index} = ${index};\n`,
        "utf8"
      );
    }
    execFileSync("git", ["add", "."], { cwd: fixture });
    execFileSync("git", ["commit", "-m", "Add retrieval miss fixture"], {
      cwd: fixture,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Kairn Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Kairn Test",
        GIT_COMMITTER_EMAIL: "test@example.com"
      }
    });
    missedIntake.cases[0].prompt = `Inspect only ${noise.join(", ")}`;
    missedIntake.cases[0].requiredSourceFiles = ["src/zzzz/opaque.ts"];
    missedIntake.cases[0].officialPatchSourceFiles = ["src/zzzz/opaque.ts"];
    missedIntake.cases[0].repositoryRef = execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: fixture, encoding: "utf8" }
    ).trim();
    fs.writeFileSync(missedIntakePath, `${JSON.stringify(missedIntake, null, 2)}\n`, "utf8");

    await materializeEvidenceCorpus({
      intakePath: missedIntakePath,
      outPath: missedManifestPath,
      reportPath: missedReportPath,
      cacheDir: path.join(temporary, "cache"),
      allowSample: true,
      allowLocalFixture: true,
      processIsolation: true,
      migrateFeatureSchema: true
    });
    expect(JSON.parse(fs.readFileSync(missedReportPath, "utf8"))).toMatchObject({
      candidateRecallAt64: 0,
      candidateRecallAt128: 0,
      positiveSourceAnyHitRateAt64: 0,
      positiveSourceAnyHitRateAt128: 0,
      cases: [expect.objectContaining({
        requiredSourceRecallAt64: 0,
        requiredSourceRecallAt128: 0,
        requiredSourceExistingFiles: ["src/zzzz/opaque.ts"],
        requiredSourceCreationFiles: [],
        positiveSourceHitAt64: false,
        positiveSourceHitAt128: false,
        explicitNegativeCount: 6,
        missingRequiredSourceFiles: ["src/zzzz/opaque.ts"],
        missingRequiredSourceFilesAt128: ["src/zzzz/opaque.ts"],
        missingExplicitNoiseFiles: []
      })]
    });

    const missedCorpusPath = path.join(temporary, "missed-corpus.jsonl");
    const missedCorpusSummaryPath = path.join(temporary, "missed-corpus-summary.json");
    const python = pythonInvocation();
    const corpusResult = spawnSync(python.command, [
      ...python.prefix,
      path.resolve("scripts/build-evidence-corpus.py"),
      "--manifest", missedManifestPath,
      "--out", missedCorpusPath,
      "--summary-out", missedCorpusSummaryPath,
      "--allow-sample"
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(corpusResult.status, corpusResult.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(missedCorpusSummaryPath, "utf8"))).toMatchObject({
      caseCount: 1,
      zeroPositiveCases: 1,
      splits: {
        train: expect.objectContaining({ zeroPositiveCases: 1 })
      }
    });

    const creationIntakePath = path.join(temporary, "intake.reviewed-creation.json");
    const creationManifestPath = path.join(temporary, "materialized.creation.json");
    const creationReportPath = path.join(temporary, "materialization.creation-report.json");
    const creationIntake = JSON.parse(fs.readFileSync(missedIntakePath, "utf8"));
    creationIntake.cases[0].requiredSourceFiles = ["src/new-production-file.ts"];
    creationIntake.cases[0].officialPatchSourceFiles = ["src/new-production-file.ts"];
    fs.writeFileSync(creationIntakePath, `${JSON.stringify(creationIntake, null, 2)}\n`, "utf8");
    await materializeEvidenceCorpus({
      intakePath: creationIntakePath,
      outPath: creationManifestPath,
      reportPath: creationReportPath,
      cacheDir: path.join(temporary, "cache"),
      allowSample: true,
      allowLocalFixture: true,
      processIsolation: true,
      migrateFeatureSchema: true
    });
    expect(JSON.parse(fs.readFileSync(creationManifestPath, "utf8"))).toMatchObject({
      cases: [expect.objectContaining({
        requiredSourceOracleCount: 1,
        requiredSourceExistingCount: 0,
        requiredSourceCreationCount: 1
      })]
    });
    expect(JSON.parse(fs.readFileSync(creationReportPath, "utf8"))).toMatchObject({
      candidateRecallEligibleCases: 0,
      candidateRecallAt64: null,
      candidateRecallAt128: null,
      cases: [expect.objectContaining({
        requiredSourceRecallAt64: null,
        requiredSourceRecallAt128: null,
        requiredSourceExistingFiles: [],
        requiredSourceCreationFiles: ["src/new-production-file.ts"],
        missingRequiredSourceFiles: []
      })]
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

  it("exports a runtime-valid pairwise ranker with grouped objective metadata", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-pairwise-ranker-training-"));
    const output = path.join(temporary, "pairwise.json");
    const python = pythonInvocation();
    const result = spawnSync(python.command, [
      ...python.prefix,
      path.resolve("scripts/train-evidence-ranker.py"),
      "--input", path.resolve("benchmarks/evidence-training.sample.jsonl"),
      "--out", output,
      "--model-id", "sample-pairwise-evidence-v1",
      "--objective", "pairwise",
      "--node", process.execPath,
      "--public-data-only"
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(validateEvidenceRankerArtifact(JSON.parse(fs.readFileSync(output, "utf8"))).modelId)
      .toBe("sample-pairwise-evidence-v1");
    const manifest = JSON.parse(fs.readFileSync(
      path.join(temporary, "sample-pairwise-evidence-v1.training-manifest.json"),
      "utf8"
    ));
    expect(manifest).toMatchObject({
      trainingObjective: "pairwise",
      trainingPairs: 2,
      crossValidationGroup: "repositoryLineageId",
      calibration: {
        rows: 4,
        positiveRows: 2,
        expectedCalibrationError: 0
      }
    });
  });

  it("freezes train and calibration data before a detached holdout is opened", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-detached-holdout-"));
    const input = path.join(temporary, "train-calibration.jsonl");
    const output = path.join(temporary, "detached.json");
    const rows = fs.readFileSync(path.resolve("benchmarks/evidence-training.sample.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { split: string })
      .filter((row) => row.split !== "holdout");
    fs.writeFileSync(input, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const python = pythonInvocation();
    const baseArgs = [
      ...python.prefix,
      path.resolve("scripts/train-evidence-ranker.py"),
      "--input", input,
      "--out", output,
      "--model-id", "detached-evidence-v1",
      "--node", process.execPath,
      "--public-data-only"
    ];

    const rejected = spawnSync(python.command, baseArgs, {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("or declare --detached-holdout");

    const result = spawnSync(python.command, [...baseArgs, "--detached-holdout"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status, result.stderr).toBe(0);
    expect(validateEvidenceRankerArtifact(JSON.parse(fs.readFileSync(output, "utf8"))).modelId)
      .toBe("detached-evidence-v1");
    expect(JSON.parse(fs.readFileSync(
      path.join(temporary, "detached-evidence-v1.training-manifest.json"),
      "utf8"
    ))).toMatchObject({
      rows: { train: 4, calibration: 4, holdout: 0 },
      holdout: { rows: 0, status: "detached_pending" }
    });
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
        featureSchemaVersion: "evidence-features-v4",
      sealed: true,
      sampleOnly: true,
      lineageRegistry: "lineages.json",
      cases: cases.map((item) => ({
        ...item,
        trainingCandidates: [
          ...item.candidates,
          {
            path: "src/enriched.ts",
            features: { ...features, productionSource: 1 },
            label: null
          }
        ]
      }))
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
    expect(fs.readFileSync(outputPath, "utf8").trim().split("\n")).toHaveLength(24);
    expect(JSON.parse(fs.readFileSync(summaryPath, "utf8"))).toMatchObject({
      sampleOnly: true,
      caseCount: 3,
      candidateRows: 24,
      labeledRows: 21,
      unlabeledRows: 3,
      zeroPositiveCases: 0,
      requiredSourceCreationCases: 0,
      requiredSourceCreationFiles: 0
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
        featureSchemaVersion: "evidence-features-v4",
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
