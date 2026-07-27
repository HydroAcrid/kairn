// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildModelCandidateUnion,
  rankEvidenceBackedGraphCandidates,
  reciprocalRankFuse
} from "../src/retrieval/candidateFusion.js";
import { yieldToSemanticCheckpointTimers } from "../src/indexer/indexRepo.js";
import {
  buildSemanticQueryCandidates,
  buildSemanticQueries,
  buildSemanticServingQueries,
  fuseSemanticCandidateRankings,
  scoreSemanticEmbeddingIndex,
  selectSemanticQueryViewIndexes,
  searchSemanticCandidates
} from "../src/retrieval/semanticCandidates.js";
import { buildSemanticDocuments } from "../src/semantic/documents.js";
import {
  getSemanticModelState,
  getSemanticModelsRoot,
  hasSameSemanticModelArtifact,
  installSemanticModel
} from "../src/semantic/modelManager.js";
import {
  getSemanticModelManifest,
  MAX_SEMANTIC_MODEL_BYTES,
  SEMANTIC_MODEL_MANIFESTS,
  semanticModelBytes
} from "../src/semantic/modelRegistry.js";
import {
  quantizeSemanticEmbedding,
  quantizedCosineSimilarity
} from "../src/semantic/modelRuntime.js";
import { SqliteStore } from "../src/store/sqliteStore.js";
import type {
  FileRecord,
  GraphEdgeRecord,
  HybridScoredResult,
  RepoGraph,
  SemanticDocumentRecord,
  SemanticEmbeddingRecord
} from "../src/types.js";

describe("model-based semantic candidates", () => {
  it("yields between embedding batches so background snapshot timers can run", async () => {
    let checkpointTimerRan = false;
    const timer = setTimeout(() => {
      checkpointTimerRan = true;
    }, 0);
    await yieldToSemanticCheckpointTimers();
    clearTimeout(timer);
    expect(checkpointTimerRan).toBe(true);
  });

  it("pins immutable, checksummed CPU-only model manifests below the footprint gate", () => {
    expect(SEMANTIC_MODEL_MANIFESTS).toHaveLength(3);
    for (const manifest of SEMANTIC_MODEL_MANIFESTS) {
      expect(manifest.upstreamRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(manifest.runtime).toMatchObject({
        library: "kairn-onnx-wasm-v1",
        modelFilePath: "onnx/model.onnx"
      });
      expect(semanticModelBytes(manifest)).toBeLessThanOrEqual(MAX_SEMANTIC_MODEL_BYTES);
      expect(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    }
    expect(SEMANTIC_MODEL_MANIFESTS.find((model) => model.modelId.includes("jina"))?.pooling)
      .toBe("mean");
    expect(SEMANTIC_MODEL_MANIFESTS.find((model) => model.modelId.includes("bge"))?.pooling)
      .toBe("cls");
    expect(SEMANTIC_MODEL_MANIFESTS.find((model) => model.modelId.includes("coderank"))?.runtime.outputName)
      .toBe("token_embeddings");
    expect(SEMANTIC_MODEL_MANIFESTS.find((model) => model.modelId.includes("coderank"))?.modelId)
      .toContain("maskmean");
  });

  it("seals lineage-disjoint selection and holdout cases across all language/scenario cells", () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.resolve("benchmarks/semantic/model-selection-v6.json"),
      "utf8"
    )) as {
      sealed: boolean;
      documentSchemaVersion: string;
      cases: Array<{
        lineageId: string;
        language: string;
        scenario: string;
        split: string;
        query: string;
        targetText: string;
      }>;
    };
    const priorManifest = JSON.parse(fs.readFileSync(
      path.resolve("benchmarks/semantic/model-selection-v4.json"),
      "utf8"
    )) as {
      cases: Array<{ split: string; query: string; targetText: string }>;
    };
    expect(manifest.sealed).toBe(true);
    expect(manifest.documentSchemaVersion).toBe("semantic-documents-v4");
    expect(manifest.cases).toHaveLength(15);
    expect(new Set(manifest.cases.map((item) => item.lineageId)).size).toBe(15);
    expect(new Set(manifest.cases.map((item) => `${item.language}:${item.scenario}`)).size).toBe(15);
    const holdout = manifest.cases.filter((item) => item.split === "holdout");
    expect(holdout).toHaveLength(5);
    const priorHoldoutContent = new Set(priorManifest.cases
      .filter((item) => item.split === "holdout")
      .map((item) => `${item.query}\0${item.targetText}`));
    expect(holdout.every((item) => !priorHoldoutContent.has(`${item.query}\0${item.targetText}`)))
      .toBe(true);
  });

  it("reruns model selection on the v5 document schema without changing selection content", () => {
    const previous = JSON.parse(fs.readFileSync(
      path.resolve("benchmarks/semantic/model-selection-v6.json"),
      "utf8"
    )) as {
      documentSchemaVersion: string;
      cases: unknown[];
    };
    const current = JSON.parse(fs.readFileSync(
      path.resolve("benchmarks/semantic/model-selection-v7.json"),
      "utf8"
    )) as {
      sealed: boolean;
      documentSchemaVersion: string;
      cases: unknown[];
    };

    expect(current.sealed).toBe(true);
    expect(current.documentSchemaVersion).toBe("semantic-documents-v5");
    expect(current.cases).toEqual(previous.cases);
  });

  it("freezes the reviewed 38-case semantic oracle to its exact labeled intake", () => {
    const oracle = JSON.parse(fs.readFileSync(
      path.resolve("benchmarks/semantic/oracle38-cases-v1.json"),
      "utf8"
    )) as {
      sourceIntakePath: string;
      sourceIntakeSha256: string;
      caseIds: string[];
    };
    const intakeBytes = fs.readFileSync(path.resolve(oracle.sourceIntakePath));
    const intake = JSON.parse(intakeBytes.toString("utf8")) as {
      cases: Array<{
        id: string;
        language: string;
        scenario: string;
        requiredSourceFiles: string[];
      }>;
    };
    const byId = new Map(intake.cases.map((item) => [item.id, item]));

    expect(createHash("sha256").update(intakeBytes).digest("hex")).toBe(
      oracle.sourceIntakeSha256
    );
    expect(oracle.caseIds).toHaveLength(38);
    expect(new Set(oracle.caseIds).size).toBe(38);
    expect(oracle.caseIds.every((id) => (byId.get(id)?.requiredSourceFiles.length ?? 0) > 0))
      .toBe(true);
    expect(new Set(oracle.caseIds.map((id) => byId.get(id)?.language))).toEqual(
      new Set(["python", "typescript", "go", "java", "cpp"])
    );
    expect(new Set(oracle.caseIds.map((id) => byId.get(id)?.scenario))).toEqual(
      new Set(["source_localization", "failure_first", "long_session"])
    );
  });

  it("collapses global symbol documents to files using maximum cosine similarity", () => {
    const rootPath = "/repo";
    const documents = [
      document(rootPath, "a-file", "src/renewal.ts", "file", "a-file-hash"),
      document(rootPath, "a-symbol", "src/renewal.ts", "symbol", "a-symbol-hash"),
      document(rootPath, "b-file", "src/audit.ts", "file", "b-file-hash")
    ];
    const embeddings = [
      embedding(rootPath, documents[0]!, new Float32Array([0.2, 0.8])),
      embedding(rootPath, documents[1]!, new Float32Array([1, 0])),
      embedding(rootPath, documents[2]!, new Float32Array([0, 1]))
    ];

    const hits = scoreSemanticEmbeddingIndex({
      queryVector: new Float32Array([1, 0]),
      documents,
      embeddings,
      limit: 2
    });

    expect(hits.map((hit) => hit.path)).toEqual(["src/renewal.ts", "src/audit.ts"]);
    expect(hits[0]?.similarity).toBeGreaterThan(0.99);
    expect(quantizedCosineSimilarity(new Float32Array([1, 0]), embeddings[1]!)).toBeGreaterThan(0.99);
  });

  it("admits a semantic-only production file outside the lexical union without admitting tier-zero noise", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/session/renewal.ts"),
      file(rootPath, "vendor/generated/client.ts", "tier0")
    ];
    const result = buildModelCandidateUnion({
      files,
      query: "Repair the workflow that restores access after authorization expires.",
      symbols: [],
      bm25Results: [],
      semanticHits: [
        { path: "vendor/generated/client.ts", similarity: 0.99, documentIds: ["vendor"] },
        { path: "src/session/renewal.ts", similarity: 0.91, documentIds: ["renewal"] }
      ],
      semanticStatus: readyStatus(2),
      edges: []
    });

    expect(result.initialPaths).toContain("src/session/renewal.ts");
    expect(result.initialPaths).not.toContain("vendor/generated/client.ts");
    expect(result.candidateResults.find((candidate) => candidate.path === "src/session/renewal.ts"))
      .toMatchObject({
        semanticSimilarity: 0.91,
        semanticScore: 0.91,
        behaviorScore: 0,
        intentScore: 0
      });
  });

  it("applies source intent before a broad model lane can crowd out production", () => {
    const rootPath = "/repo";
    const production = file(rootPath, "src/runtime/restore.ts");
    const testFiles = Array.from({ length: 80 }, (_, index) => ({
      ...file(rootPath, `tests/case-${String(index).padStart(2, "0")}.test.ts`),
      kind: "test" as const
    }));
    const semanticHits = [
      ...testFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 0.95 - index / 1_000,
        documentIds: [`test-${index}`]
      })),
      {
        path: production.path,
        similarity: 0.7,
        documentIds: ["production"]
      }
    ];

    const result = buildModelCandidateUnion({
      files: [...testFiles, production],
      query: "Debug the production regression that loses restored state.",
      symbols: [],
      bm25Results: [],
      semanticHits,
      semanticStatus: readyStatus(semanticHits.length),
      edges: []
    });

    expect(result.initialPaths[0]).toBe(production.path);
    expect(result.initialPaths).toContain(testFiles[0]!.path);
  });

  it("applies source intent inside model views before bounded semantic fusion", () => {
    const rootPath = "/repo";
    const production = file(rootPath, "src/runtime/restore.ts");
    const testFiles = Array.from({ length: 80 }, (_, index) => ({
      ...file(rootPath, `tests/case-${String(index).padStart(2, "0")}.test.ts`),
      kind: "test" as const
    }));
    const rawView = [
      ...testFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 0.95 - index / 1_000,
        documentIds: [`test-${index}`]
      })),
      {
        path: production.path,
        similarity: 0.7,
        documentIds: ["production"]
      }
    ];

    const result = buildModelCandidateUnion({
      files: [...testFiles, production],
      query: "Debug the production regression that loses restored state.",
      symbols: [],
      bm25Results: [],
      // Simulate the raw bounded fusion having already dropped the source.
      semanticHits: rawView.slice(0, 64),
      semanticQueryRankings: [rawView],
      semanticStatus: readyStatus(rawView.length),
      edges: []
    });

    expect(result.semanticPaths[0]).toBe(production.path);
    expect(result.semanticEvidencePaths[0]).toBe(production.path);
    expect(result.initialPaths[0]).toBe(production.path);
    expect(result.candidateResults.find((candidate) => candidate.path === production.path))
      .toMatchObject({
        semanticSimilarity: 0.7,
        semanticScore: 0.7
      });
  });

  it("preserves a bounded model-only slice when independent lexical results compete", () => {
    const rootPath = "/repo";
    const semanticFiles = Array.from({ length: 80 }, (_, index) =>
      file(rootPath, `src/semantic-${String(index).padStart(2, "0")}.ts`)
    );
    const lexicalFiles = Array.from({ length: 80 }, (_, index) =>
      file(rootPath, `src/lexical-${String(index).padStart(2, "0")}.ts`)
    );
    const semanticHits = semanticFiles.map((candidate, index) => ({
      path: candidate.path,
      similarity: 0.95 - index / 1_000,
      documentIds: [`semantic-${index}`]
    }));

    const result = buildModelCandidateUnion({
      files: [...semanticFiles, ...lexicalFiles],
      query: "Debug the production behavior described by the model.",
      symbols: [],
      bm25Results: lexicalFiles.map((candidate, index) =>
        scored(candidate, 1 - index / 1_000)
      ),
      semanticHits,
      semanticStatus: readyStatus(semanticHits.length),
      edges: []
    });

    expect(result.initialPaths).toContain(semanticFiles[39]!.path);
    expect(result.initialPaths).toContain(lexicalFiles[0]!.path);
    expect(result.initialPaths).toHaveLength(64);
  });

  it("pins precise failure paths ahead of a full 64-file semantic lane", () => {
    const rootPath = "/repo";
    const required = file(rootPath, "src/required.ts");
    const distractors = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/noise-${String(index).padStart(2, "0")}.ts`)
    );
    const result = buildModelCandidateUnion({
      files: [required, ...distractors],
      query: "Compiler failure at /workspace/project/src/required.ts:42:7",
      symbols: [],
      bm25Results: [],
      semanticHits: distractors.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`noise-${index}`]
      })),
      semanticStatus: readyStatus(distractors.length),
      edges: []
    });

    expect(result.initialPaths).toHaveLength(64);
    expect(result.initialPaths[0]).toBe("src/required.ts");
  });

  it("fuses an independently supported import neighbor without promoting arbitrary fan-out", () => {
    const rootPath = "/repo";
    const seed = file(rootPath, "src/workflow/entry.ts");
    const required = file(rootPath, "src/workflow/implementation.ts");
    const arbitraryNeighbor = file(rootPath, "src/workflow/incidental.ts");
    const distractors = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/noise-${String(index).padStart(2, "0")}.ts`)
    );
    const rankedFiles = [seed, ...distractors];
    const result = buildModelCandidateUnion({
      files: [seed, required, arbitraryNeighbor, ...distractors],
      query: "Repair the production workflow after its state transition fails.",
      symbols: [],
      bm25Results: [
        ...rankedFiles.map((candidate, index) => scored(candidate, 1 - index / 100)),
        scored(required, 0.01)
      ],
      semanticHits: rankedFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`rank-${index}`]
      })),
      semanticStatus: readyStatus(rankedFiles.length),
      edges: [
        edge(rootPath, seed.path, required.path, "imports"),
        edge(rootPath, seed.path, arbitraryNeighbor.path, "imports")
      ]
    });

    expect(result.initialPaths).toHaveLength(64);
    expect(result.enrichedPaths).toContain(required.path);
    expect(result.initialPaths).not.toContain(arbitraryNeighbor.path);
    expect(result.candidateResults.find((candidate) => candidate.path === required.path))
      .toMatchObject({
        graphScore: 1,
        reasons: expect.arrayContaining(["direct graph neighbor"])
      });
  });

  it("uses broader model evidence to validate a precise graph neighbor without widening the bounded lane", () => {
    const rootPath = "/repo";
    const seed = file(rootPath, "src/public-api.ts");
    const implementation = file(rootPath, "src/internal/implementation.ts");
    const unrelated = file(rootPath, "src/internal/unrelated.ts");
    const distractors = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/noise-${String(index).padStart(2, "0")}.ts`)
    );
    const rankedFiles = [seed, ...distractors];
    const result = buildModelCandidateUnion({
      files: [seed, implementation, unrelated, ...distractors],
      query: "Repair the production behavior exposed by the public API.",
      symbols: [],
      bm25Results: rankedFiles.map((candidate, index) => scored(candidate, 1 - index / 100)),
      semanticHits: rankedFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`rank-${index}`]
      })),
      semanticEvidencePaths: [
        ...rankedFiles.map((candidate) => candidate.path),
        implementation.path
      ],
      semanticStatus: readyStatus(rankedFiles.length),
      edges: [
        edge(rootPath, seed.path, implementation.path, "imports"),
        edge(rootPath, seed.path, unrelated.path, "imports")
      ]
    });

    expect(result.initialPaths).not.toContain(implementation.path);
    expect(result.enrichedPaths).toContain(implementation.path);
    expect(result.enrichedPaths).not.toContain(unrelated.path);
  });

  it("allows a precise source-test graph relation to enter without lexical support", () => {
    const rootPath = "/repo";
    const testSeed = file(rootPath, "tests/payment.test.ts");
    const productionSource = file(rootPath, "src/payment.ts");
    const distractors = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/noise-${String(index).padStart(2, "0")}.ts`)
    );
    const rankedFiles = [testSeed, ...distractors];
    const result = buildModelCandidateUnion({
      files: [testSeed, productionSource, ...distractors],
      query: "Debug the failing payment integration check.",
      symbols: [],
      bm25Results: rankedFiles.map((candidate, index) => scored(candidate, 1 - index / 100)),
      semanticHits: rankedFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`rank-${index}`]
      })),
      semanticStatus: readyStatus(rankedFiles.length),
      edges: [edge(rootPath, testSeed.path, productionSource.path, "test_for")]
    });

    expect(result.enrichedPaths).toContain(productionSource.path);
  });

  it("allows a parser-observed type reference to enter without lexical support", () => {
    const rootPath = "/repo";
    const facade = file(rootPath, "src/workflow/ResolverFacade.java");
    const implementation = file(rootPath, "src/workflow/TypeExtractor.java");
    const distractors = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/noise-${String(index).padStart(2, "0")}.java`)
    );
    const rankedFiles = [facade, ...distractors];
    const result = buildModelCandidateUnion({
      files: [facade, implementation, ...distractors],
      query: "Support a new expression form during method resolution.",
      symbols: [],
      bm25Results: rankedFiles.map((candidate, index) => scored(candidate, 1 - index / 100)),
      semanticHits: rankedFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`rank-${index}`]
      })),
      semanticStatus: readyStatus(rankedFiles.length),
      edges: [edge(rootPath, facade.path, implementation.path, "type_reference")]
    });

    expect(result.enrichedPaths).toContain(implementation.path);
  });

  it("uses broad semantic test probes only for precise source relationships", () => {
    const rootPath = "/repo";
    const testProbe = {
      ...file(rootPath, "internal/runtime/marks_test.go"),
      kind: "test" as const
    };
    const declaration = file(rootPath, "internal/runtime/marks.go");
    const planCaller = file(rootPath, "internal/runtime/plan.go");
    const applyCaller = file(rootPath, "internal/runtime/apply.go");
    const distractors = Array.from({ length: 80 }, (_, index) =>
      file(rootPath, `src/noise-${String(index).padStart(2, "0")}.go`)
    );
    const semanticLeaders = distractors.slice(0, 64);
    const semanticEvidencePaths = [
      ...semanticLeaders.map((candidate) => candidate.path),
      testProbe.path,
      planCaller.path,
      applyCaller.path
    ];
    const result = buildModelCandidateUnion({
      files: [testProbe, declaration, planCaller, applyCaller, ...distractors],
      query: "Debug a production planning regression involving sensitive state.",
      symbols: [],
      bm25Results: [
        ...semanticLeaders.map((candidate, index) => scored(candidate, 1 - index / 100)),
        scored(planCaller, 0.01),
        scored(applyCaller, 0.009)
      ],
      semanticHits: semanticLeaders.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`rank-${index}`]
      })),
      semanticEvidencePaths,
      semanticStatus: readyStatus(semanticLeaders.length),
      edges: [
        edge(rootPath, testProbe.path, declaration.path, "test_for"),
        edge(rootPath, testProbe.path, planCaller.path, "shared_call_target"),
        edge(rootPath, testProbe.path, applyCaller.path, "shared_call_target")
      ]
    });

    expect(result.initialPaths).not.toContain(testProbe.path);
    expect(result.graphSeedPaths).toContain(testProbe.path);
    expect(result.enrichedPaths).toEqual(expect.arrayContaining([
      declaration.path,
      planCaller.path,
      applyCaller.path
    ]));
  });

  it("uses model-backed production probes only through precise parser relationships", () => {
    const rootPath = "/repo";
    const leaders = Array.from({ length: 64 }, (_, index) =>
      file(rootPath, `src/leader-${String(index).padStart(2, "0")}.go`)
    );
    const productionProbe = file(rootPath, "internal/runtime/operation.go");
    const calledSource = file(rootPath, "internal/runtime/state.go");
    const importNoise = file(rootPath, "internal/runtime/format.go");
    const lexicalOnly = file(rootPath, "internal/runtime/report.go");
    const lexicalNeighbor = file(rootPath, "internal/runtime/render.go");
    const viewSpecificProbe = file(rootPath, "internal/runtime/evaluate.go");
    const viewSpecificNeighbor = file(rootPath, "internal/runtime/value.go");
    const rankedFiles = [...leaders, productionProbe, calledSource, importNoise];
    const result = buildModelCandidateUnion({
      files: [
        ...rankedFiles,
        lexicalOnly,
        lexicalNeighbor,
        viewSpecificProbe,
        viewSpecificNeighbor
      ],
      query: "Repair the production state transition workflow.",
      symbols: [],
      bm25Results: [...rankedFiles, lexicalOnly, lexicalNeighbor]
        .map((candidate, index) => scored(candidate, 1 - index / 200)),
      semanticHits: rankedFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 200,
        documentIds: [`rank-${index}`]
      })),
      semanticEvidencePaths: [
        ...rankedFiles.map((candidate) => candidate.path),
        viewSpecificProbe.path
      ],
      semanticStatus: readyStatus(rankedFiles.length),
      edges: [
        edge(rootPath, leaders[0]!.path, productionProbe.path, "shared_call_target"),
        edge(rootPath, productionProbe.path, calledSource.path, "call"),
        edge(rootPath, productionProbe.path, importNoise.path, "imports"),
        edge(rootPath, lexicalOnly.path, lexicalNeighbor.path, "call"),
        edge(rootPath, viewSpecificProbe.path, viewSpecificNeighbor.path, "call")
      ]
    });

    expect(result.initialPaths).not.toContain(productionProbe.path);
    expect(result.graphSeedPaths).toContain(productionProbe.path);
    expect(result.graphSeedPaths).not.toContain(lexicalOnly.path);
    expect(result.graphSeedPaths).toContain(viewSpecificProbe.path);
    expect(result.graphPaths).toEqual(expect.arrayContaining([
      productionProbe.path,
      calledSource.path,
      viewSpecificNeighbor.path
    ]));
    expect(result.graphPaths).not.toContain(importNoise.path);
    expect(result.graphPaths).not.toContain(lexicalNeighbor.path);
  });

  it("spends source-intent graph enrichment capacity on production before companions", () => {
    const rootPath = "/repo";
    const seed = file(rootPath, "src/facade.go");
    const initialNoise = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/seed-${String(index).padStart(2, "0")}.go`)
    );
    const target = file(rootPath, "src/zz-target.go");
    const testNeighbors = Array.from({ length: 70 }, (_, index) => ({
      ...file(rootPath, `tests/aa-neighbor-${String(index).padStart(2, "0")}_test.go`),
      kind: "test" as const
    }));
    const rankedFiles = [seed, ...initialNoise];
    const result = buildModelCandidateUnion({
      files: [target, ...testNeighbors, ...rankedFiles],
      query: "Debug the production source behavior.",
      symbols: [],
      bm25Results: rankedFiles.map((candidate, index) => scored(candidate, 1 - index / 100)),
      semanticHits: rankedFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`rank-${index}`]
      })),
      semanticStatus: readyStatus(rankedFiles.length),
      edges: [
        ...testNeighbors.map((neighbor) =>
          edge(rootPath, seed.path, neighbor.path, "type_reference")
        ),
        edge(rootPath, seed.path, target.path, "type_reference")
      ]
    });

    expect(result.graphPaths[0]).toBe(target.path);
    expect(result.enrichedPaths).toContain(target.path);
  });

  it("ranks a unique parser-observed type reference ahead of loose implementation peers", () => {
    const rootPath = "/repo";
    const seed = file(rootPath, "src/workflow/ResolverFacade.java");
    const declaration = file(rootPath, "src/workflow/TypeExtractor.java");
    const peers = Array.from({ length: 8 }, (_, index) =>
      file(rootPath, `src/workflow/peer-${index}.java`)
    );
    const filesByPath = new Map(
      [seed, declaration, ...peers].map((candidate) => [candidate.path, candidate])
    );
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: [seed.path],
      edges: [
        edge(rootPath, seed.path, declaration.path, "type_reference"),
        ...peers.map((peer) => edge(rootPath, seed.path, peer.path, "implementation"))
      ],
      filesByPath,
      evidenceRankings: []
    });

    expect(ranked[0]).toBe(declaration.path);
  });

  it("ranks a uniquely resolved local call ahead of a type reference", () => {
    const rootPath = "/repo";
    const seed = file(rootPath, "src/workflow/runner.go");
    const callTarget = file(rootPath, "src/workflow/state.go");
    const typeTarget = file(rootPath, "src/workflow/config.go");
    const filesByPath = new Map(
      [seed, callTarget, typeTarget].map((candidate) => [candidate.path, candidate])
    );
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: [seed.path],
      edges: [
        edge(rootPath, seed.path, typeTarget.path, "type_reference"),
        edge(rootPath, seed.path, callTarget.path, "call")
      ],
      filesByPath,
      evidenceRankings: []
    });

    expect(ranked.slice(0, 2)).toEqual([callTarget.path, typeTarget.path]);
  });

  it("does not borrow an early weak seed rank for a later precise relationship", () => {
    const rootPath = "/repo";
    const seeds = Array.from({ length: 4 }, (_, index) =>
      file(rootPath, `src/seed-${index}.go`)
    );
    const cleanCall = file(rootPath, "src/clean-call.go");
    const mixedEvidence = file(rootPath, "src/mixed-evidence.go");
    const filesByPath = new Map(
      [...seeds, cleanCall, mixedEvidence].map((candidate) => [candidate.path, candidate])
    );
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: seeds.map((seed) => seed.path),
      edges: [
        edge(rootPath, seeds[0]!.path, mixedEvidence.path, "imports"),
        edge(rootPath, seeds[3]!.path, mixedEvidence.path, "call"),
        edge(rootPath, seeds[1]!.path, cleanCall.path, "call")
      ],
      filesByPath,
      evidenceRankings: [{
        channel: "semantic",
        paths: [cleanCall.path, mixedEvidence.path]
      }]
    });

    expect(ranked.slice(0, 2)).toEqual([cleanCall.path, mixedEvidence.path]);
  });

  it("prefers an exact graph relation from the strongest seed before lower-ranked consensus", () => {
    const rootPath = "/repo";
    const seeds = Array.from({ length: 8 }, (_, index) =>
      file(rootPath, `src/api/seed-${index}.java`)
    );
    const closeDeclaration = file(rootPath, "src/model/CloseType.java");
    const consensusDeclaration = file(rootPath, "src/model/ConsensusType.java");
    const filesByPath = new Map(
      [...seeds, closeDeclaration, consensusDeclaration]
        .map((candidate) => [candidate.path, candidate])
    );
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: seeds.map((seed) => seed.path),
      edges: [
        edge(rootPath, seeds[0]!.path, closeDeclaration.path, "type_reference"),
        ...seeds.slice(3).map((seed) =>
          edge(rootPath, seed.path, consensusDeclaration.path, "type_reference")
        )
      ],
      filesByPath,
      evidenceRankings: []
    });

    expect(ranked.slice(0, 2)).toEqual([
      closeDeclaration.path,
      consensusDeclaration.path
    ]);
  });

  it("lets multiple strong independent type references outrank weaker call consensus", () => {
    const rootPath = "/repo";
    const seeds = Array.from({ length: 8 }, (_, index) =>
      file(rootPath, `src/api/seed-${index}.go`)
    );
    const stronglySupportedType = file(rootPath, "src/runtime/configuration.go");
    const weaklySupportedCall = file(rootPath, "src/runtime/helper.go");
    const filesByPath = new Map(
      [...seeds, stronglySupportedType, weaklySupportedCall]
        .map((candidate) => [candidate.path, candidate])
    );
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: seeds.map((seed) => seed.path),
      edges: [
        ...seeds.slice(0, 3).map((seed) =>
          edge(rootPath, seed.path, stronglySupportedType.path, "type_reference")
        ),
        ...seeds.slice(6).map((seed) =>
          edge(rootPath, seed.path, weaklySupportedCall.path, "call")
        )
      ],
      filesByPath,
      evidenceRankings: [],
      minimumSeedSupport: 2,
      ordering: "support"
    });

    expect(ranked.slice(0, 2)).toEqual([
      stronglySupportedType.path,
      weaklySupportedCall.path
    ]);
  });

  it("saturates graph consensus so broad weak fan-in cannot beat strong independent seeds", () => {
    const rootPath = "/repo";
    const seeds = Array.from({ length: 12 }, (_, index) =>
      file(rootPath, `src/api/seed-${index}.go`)
    );
    const stronglySupported = file(rootPath, "src/runtime/strong.go");
    const broadWeakHub = file(rootPath, "src/runtime/hub.go");
    const filesByPath = new Map(
      [...seeds, stronglySupported, broadWeakHub]
        .map((candidate) => [candidate.path, candidate])
    );
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: seeds.map((seed) => seed.path),
      edges: [
        ...seeds.slice(0, 3).map((seed) =>
          edge(rootPath, seed.path, stronglySupported.path, "type_reference")
        ),
        ...seeds.slice(4).map((seed) =>
          edge(rootPath, seed.path, broadWeakHub.path, "type_reference")
        )
      ],
      filesByPath,
      evidenceRankings: [],
      minimumSeedSupport: 2,
      ordering: "support"
    });

    expect(ranked.slice(0, 2)).toEqual([
      stronglySupported.path,
      broadWeakHub.path
    ]);
  });

  it("credits graph consensus from multiple independently retrieved seeds", () => {
    const rootPath = "/repo";
    const sharedImplementation = file(rootPath, "src/workflow/public-api.ts");
    const seeds = Array.from({ length: 6 }, (_, index) =>
      file(rootPath, `src/workflow/feature-${index}.ts`)
    );
    const singleSeedNeighbors = Array.from({ length: 20 }, (_, index) =>
      file(rootPath, `src/workflow/single-${index}.ts`)
    );
    const distractors = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/noise-${String(index).padStart(2, "0")}.ts`)
    );
    const rankedFiles = [...seeds, ...distractors];
    const result = buildModelCandidateUnion({
      files: [sharedImplementation, ...singleSeedNeighbors, ...rankedFiles],
      query: "Repair the shared workflow behavior used by the related feature implementations.",
      symbols: [],
      bm25Results: [
        ...rankedFiles.map((candidate, index) => scored(candidate, 1 - index / 100)),
        ...singleSeedNeighbors.map((candidate, index) => scored(candidate, 0.02 - index / 10_000)),
        scored(sharedImplementation, 0.001)
      ],
      semanticHits: rankedFiles.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`rank-${index}`]
      })),
      semanticStatus: readyStatus(rankedFiles.length),
      edges: [
        ...seeds.map((seed) => edge(rootPath, sharedImplementation.path, seed.path, "imports")),
        ...singleSeedNeighbors.map((neighbor, index) =>
          edge(rootPath, seeds[index % seeds.length]!.path, neighbor.path, "imports")
        )
      ]
    });

    expect(result.enrichedPaths).toContain(sharedImplementation.path);
    expect(result.candidateResults.find((candidate) => candidate.path === sharedImplementation.path))
      .toMatchObject({ graphScore: 1 });
  });

  it("records graph facts for retrieved seeds without returning them as graph additions", () => {
    const rootPath = "/repo";
    const firstSeed = file(rootPath, "src/workflow/entry.ts");
    const secondSeed = file(rootPath, "src/workflow/state.ts");
    const addedNeighbor = file(rootPath, "src/workflow/transition.ts");
    const filesByPath = new Map(
      [firstSeed, secondSeed, addedNeighbor].map((candidate) => [candidate.path, candidate])
    );
    const graphEvidenceByPath = new Map();
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: [firstSeed.path, secondSeed.path],
      edges: [
        edge(rootPath, firstSeed.path, secondSeed.path, "call"),
        edge(rootPath, firstSeed.path, addedNeighbor.path, "type_reference")
      ],
      filesByPath,
      evidenceRankings: [],
      graphEvidenceByPath
    });

    expect(ranked).toContain(addedNeighbor.path);
    expect(ranked).not.toContain(secondSeed.path);
    expect(graphEvidenceByPath.get(secondSeed.path)).toMatchObject({
      precision: 1,
      supportingSeedCount: 1
    });
  });

  it("keeps the consensus lane effective when single-seed graph candidates fill the budget", () => {
    const rootPath = "/repo";
    const seeds = Array.from({ length: 64 }, (_, index) =>
      file(rootPath, `src/workflow/seed-${String(index).padStart(2, "0")}.go`)
    );
    const singleSeedNeighbors = Array.from({ length: 70 }, (_, index) =>
      file(rootPath, `src/workflow/call-${String(index).padStart(2, "0")}.go`)
    );
    const consensusSource = file(rootPath, "src/workflow/shared-state.go");
    const result = buildModelCandidateUnion({
      files: [...seeds, ...singleSeedNeighbors, consensusSource],
      query: "Repair the production workflow state transition.",
      symbols: [],
      bm25Results: seeds.map((candidate, index) => scored(candidate, 1 - index / 100)),
      semanticHits: seeds.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 100,
        documentIds: [`seed-${index}`]
      })),
      semanticStatus: readyStatus(seeds.length),
      edges: [
        ...singleSeedNeighbors.map((neighbor) =>
          edge(rootPath, seeds[0]!.path, neighbor.path, "call")
        ),
        edge(rootPath, seeds[62]!.path, consensusSource.path, "type_reference"),
        edge(rootPath, seeds[63]!.path, consensusSource.path, "type_reference")
      ]
    });

    expect(result.graphPaths.indexOf(consensusSource.path)).toBeGreaterThanOrEqual(64);
    expect(result.graphConsensusPaths).toContain(consensusSource.path);
    expect(result.enrichedPaths).toContain(consensusSource.path);
    expect(result.graphEvidenceByPath.get(consensusSource.path)).toMatchObject({
      precision: 0.8,
      supportingSeedCount: 2,
      independentEvidence: 0,
      sourceTestPair: false
    });
    expect(result.graphEvidenceByPath.get(consensusSource.path)?.seedStrength).toBeGreaterThan(0);
    expect(result.graphEvidenceByPath.get(consensusSource.path)?.seedStrength).toBeLessThan(1);
  });

  it("balances parser-proven installation candidates across module families", () => {
    const rootPath = "/repo";
    const seeds = [
      file(rootPath, "src/api/account.ts"),
      file(rootPath, "src/api/search.ts"),
      file(rootPath, "src/api/admin.ts")
    ];
    const familyA = Array.from({ length: 8 }, (_, index) =>
      file(rootPath, `src/adapters/a/part-${index}.ts`)
    );
    const familyB = [file(rootPath, "src/adapters/b/core.ts")];
    const familyC = [file(rootPath, "src/adapters/c/core.ts")];
    const filesByPath = new Map(
      [...seeds, ...familyA, ...familyB, ...familyC].map((candidate) => [candidate.path, candidate])
    );
    const installation = (
      seed: FileRecord,
      target: FileRecord,
      through: string
    ): GraphEdgeRecord => ({
      ...edge(rootPath, seed.path, target.path, "module_installation"),
      metadata: {
        reason: "imported module installs a concrete implementation",
        through
      }
    });
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: seeds.map((seed) => seed.path),
      edges: [
        ...familyA.flatMap((target) => seeds.map((seed) =>
          installation(seed, target, "src/adapters/a/index.ts")
        )),
        installation(seeds[0]!, familyB[0]!, "src/adapters/b/index.ts"),
        installation(seeds[1]!, familyC[0]!, "src/adapters/c/index.ts")
      ],
      filesByPath,
      evidenceRankings: []
    });

    expect(new Set(ranked.slice(0, 3))).toEqual(new Set([
      familyA[0]!.path,
      familyB[0]!.path,
      familyC[0]!.path
    ]));
  });

  it("diversifies installation families without moving them ahead of stronger relation slots", () => {
    const rootPath = "/repo";
    const seed = file(rootPath, "src/api/account.ts");
    const callTarget = file(rootPath, "src/runtime/call-target.ts");
    const familyA = [
      file(rootPath, "src/adapters/a/first.ts"),
      file(rootPath, "src/adapters/a/second.ts")
    ];
    const familyB = file(rootPath, "src/adapters/b/core.ts");
    const filesByPath = new Map(
      [seed, callTarget, ...familyA, familyB]
        .map((candidate) => [candidate.path, candidate])
    );
    const installation = (
      target: FileRecord,
      through: string
    ): GraphEdgeRecord => ({
      ...edge(rootPath, seed.path, target.path, "module_installation"),
      metadata: { through }
    });
    const ranked = rankEvidenceBackedGraphCandidates({
      seedPaths: [seed.path],
      edges: [
        edge(rootPath, seed.path, callTarget.path, "call"),
        installation(familyA[0]!, "src/adapters/a/index.ts"),
        installation(familyA[1]!, "src/adapters/a/index.ts"),
        installation(familyB, "src/adapters/b/index.ts")
      ],
      filesByPath,
      evidenceRankings: []
    });

    expect(ranked[0]).toBe(callTarget.path);
    expect(new Set(ranked.slice(1, 3))).toEqual(new Set([
      familyA[0]!.path,
      familyB.path
    ]));
  });

  it("fuses independent ranks without path-name or task-word bonuses", () => {
    expect(reciprocalRankFuse({
      hardPaths: [],
      rankings: [
        { channel: "semantic", paths: ["z/unrelated-name.ts", "a/task-words.ts"] },
        { channel: "bm25", paths: ["z/unrelated-name.ts", "a/task-words.ts"] }
      ],
      limit: 2,
      rankConstant: 10
    })).toEqual(["z/unrelated-name.ts", "a/task-words.ts"]);
  });

  it("retains the base retrieval tail in the enriched union", () => {
    const rootPath = "/repo";
    const files = Array.from({ length: 100 }, (_, index) =>
      file(rootPath, `src/module-${String(index).padStart(2, "0")}.ts`)
    );
    const result = buildModelCandidateUnion({
      files,
      query: "Locate the production behavior across the repository.",
      symbols: [],
      bm25Results: files.map((candidate, index) => scored(candidate, 1 - index / 200)),
      semanticHits: files.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 200,
        documentIds: [`rank-${index}`]
      })),
      semanticStatus: readyStatus(files.length),
      edges: []
    });

    expect(result.initialPaths).toHaveLength(64);
    expect(result.enrichedPaths).toHaveLength(100);
    expect(result.enrichedPaths).toContain("src/module-99.ts");
  });

  it("does not let graph enrichment evict the initial retrieval lane", () => {
    const rootPath = "/repo";
    const retrieved = Array.from({ length: 80 }, (_, index) =>
      file(rootPath, `src/retrieved-${String(index).padStart(2, "0")}.ts`)
    );
    const graphNeighbors = Array.from({ length: 64 }, (_, index) =>
      file(rootPath, `src/neighbor-${String(index).padStart(2, "0")}.ts`)
    );
    const result = buildModelCandidateUnion({
      files: [...retrieved, ...graphNeighbors],
      query: "Locate the production behavior across the repository.",
      symbols: [],
      bm25Results: retrieved.map((candidate, index) => scored(candidate, 1 - index / 200)),
      semanticHits: retrieved.map((candidate, index) => ({
        path: candidate.path,
        similarity: 1 - index / 200,
        documentIds: [`rank-${index}`]
      })),
      semanticStatus: readyStatus(retrieved.length),
      edges: graphNeighbors.map((neighbor, index) =>
        edge(rootPath, retrieved[index]!.path, neighbor.path, "implementation")
      )
    });

    expect(result.initialPaths).toHaveLength(64);
    expect(result.initialPaths).toContain("src/retrieved-63.ts");
    expect(result.initialPaths.some((filePath) => filePath.includes("/neighbor-"))).toBe(false);
    expect(result.enrichedPaths.some((filePath) => filePath.includes("/neighbor-"))).toBe(true);
  });

  it("keeps the task narrative in semantic queries when a broad failure inventory comes first", () => {
    const broadFailures = Array.from(
      { length: 120 },
      (_, index) => `- module.feature.Component${index}Test`
    ).join("\n");
    const queries = buildSemanticQueries([
      "Initial failing checks:",
      broadFailures,
      "",
      "Repair parameter parsing so an explicitly empty value remains empty."
    ].join("\n"));

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(18);
    expect(queries.some((query) => query.includes("explicitly empty value remains empty"))).toBe(true);
    expect(queries.every((query) => query.length <= 1_600)).toBe(true);
  });

  it("gives separated issue facets bounded independent semantic views", () => {
    const queries = buildSemanticQueries([
      "Authorization cleanup leaves stale records.",
      "",
      `The first subsystem keeps expired session state. ${"early context ".repeat(45)}`,
      "",
      `A separate persistence layer must remove the associated lease. ${"middle context ".repeat(45)}`,
      "",
      `The final adapter should report the invalid credential consistently. ${"late context ".repeat(45)}`
    ].join("\n"));

    expect(queries.length).toBeLessThanOrEqual(18);
    expect(queries.some((query) => query.includes("expired session state"))).toBe(true);
    expect(queries.some((query) => query.includes("associated lease"))).toBe(true);
    expect(queries.some((query) => query.includes("invalid credential"))).toBe(true);
  });

  it("serves an independent headline and bounded late-narrative synopsis", () => {
    const queries = buildSemanticServingQueries([
      "Authorization cleanup leaves stale records.",
      "",
      `The first subsystem keeps expired session state. ${"early context ".repeat(45)}`,
      "",
      `A separate persistence layer must remove the associated lease. ${"middle context ".repeat(45)}`,
      "",
      `The final adapter should report the invalid credential consistently. ${"late context ".repeat(45)}`
    ].join("\n"));

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("Authorization cleanup leaves stale records");
    expect(queries[1]).toContain("Authorization cleanup leaves stale records");
    expect(queries[1]).toContain("invalid credential");
    expect(queries[1]).not.toContain("associated lease");
    expect(queries.every((query) => query.length <= 1_600)).toBe(true);
  });

  it("does not duplicate a concise task when its headline and narrative are identical", () => {
    const queries = buildSemanticServingQueries(
      "Locate the implementation that renews an expired authorization session."
    );

    expect(queries).toEqual([
      "Locate the implementation that renews an expired authorization session."
    ]);
  });

  it("preserves bounded fenced evidence for model-based failure retrieval", () => {
    const queries = buildSemanticServingQueries([
      "Multiline values fail during type resolution.",
      "",
      "The normal single-line form resolves correctly.",
      "",
      "```java",
      "String value = \"working\";",
      "```",
      "",
      "Additional narrative explains the observed failure.",
      "",
      "```text",
      "UnsupportedOperationException: TextBlockLiteralExpr",
      "```"
    ].join("\n"));

    expect(queries).toHaveLength(3);
    expect(queries[2]).toContain("String value");
    expect(queries[2]).toContain("UnsupportedOperationException");
    expect(queries[2]).toContain("TextBlockLiteralExpr");
    expect(queries.every((query) => query.length <= 1_600)).toBe(true);
  });

  it("gives the model a bounded candidate pool spanning structured fenced evidence", () => {
    const candidates = buildSemanticQueryCandidates([
      "Persisted records lose ownership metadata after a round trip.",
      "",
      "```shell",
      "tool run",
      "```",
      "",
      "```json",
      JSON.stringify({
        record: {
          ownership: [{ generation: 42, writer: "worker-a" }],
          payload: "preserved"
        }
      }, null, 2),
      "```",
      "",
      "```typescript",
      [
        "export function restoreRecord(serialized: string): RecordState {",
        "  const decoded = JSON.parse(serialized);",
        "  return { ...decoded, ownership: normalizeOwnership(decoded.ownership) };",
        "}"
      ].join("\n"),
      "```"
    ].join("\n"));

    expect(candidates.length).toBeGreaterThanOrEqual(4);
    expect(candidates.length).toBeLessThanOrEqual(18);
    expect(candidates.some((candidate) =>
      candidate.kind === "fence" &&
      candidate.text.includes("language: shell") &&
      candidate.text.includes("tool run")
    )).toBe(true);
    expect(candidates.some((candidate) =>
      candidate.kind === "fence" &&
      candidate.text.includes("language: json") &&
      candidate.text.includes("ownership") &&
      candidate.text.includes("generation")
    )).toBe(true);
    expect(candidates.some((candidate) =>
      candidate.kind === "fence" &&
      candidate.text.includes("language: typescript") &&
      candidate.text.includes("normalizeOwnership")
    )).toBe(true);
    expect(candidates.every((candidate) => candidate.text.length <= 1_600)).toBe(true);
  });

  it("uses embedding agreement rather than fence size or position to select structured query evidence", () => {
    const candidates = [
      {
        kind: "headline" as const,
        text: "Removed module configuration does not execute its cleanup action.",
        structuralIndex: 0
      },
      {
        kind: "narrative" as const,
        text: "The cleanup declared for a removed module must still run.",
        structuralIndex: 0
      },
      {
        kind: "fence" as const,
        text: "removed { from = module.old lifecycle { destroy = true } }",
        structuralIndex: 1
      },
      {
        kind: "fence" as const,
        text: "apply output\n".repeat(500),
        structuralIndex: 9
      },
      {
        kind: "fence" as const,
        text: "unrelated diagnostic output",
        structuralIndex: 2
      }
    ];
    const vectors = [
      Float32Array.from([1, 0]),
      Float32Array.from([0.98, 0.02]),
      Float32Array.from([0.99, 0.01]),
      Float32Array.from([0, 1]),
      Float32Array.from([0.2, 0.8])
    ];

    const selected = selectSemanticQueryViewIndexes(candidates, vectors, 3, 1);

    expect(selected).toContain(2);
    expect(selected).not.toContain(3);
  });

  it("fuses semantic query views by rank instead of a noisy maximum-similarity winner", () => {
    const hits = fuseSemanticCandidateRankings([
      [
        { path: "src/shared.ts", similarity: 0.61, documentIds: ["shared-a"] },
        { path: "src/prefix-only.ts", similarity: 0.99, documentIds: ["prefix"] }
      ],
      [
        { path: "src/shared.ts", similarity: 0.62, documentIds: ["shared-b"] },
        { path: "src/narrative-only.ts", similarity: 0.98, documentIds: ["narrative"] }
      ]
    ], 3, 10);

    expect(hits[0]?.path).toBe("src/shared.ts");
    expect(new Set(hits.slice(1).map((hit) => hit.path))).toEqual(new Set([
      "src/narrative-only.ts",
      "src/prefix-only.ts"
    ]));
    expect(hits[0]).toMatchObject({
      similarity: 0.62,
      documentIds: ["shared-a", "shared-b"]
    });
  });

  it("continues semantic lane interleaving after duplicate shared ranks", () => {
    const shared = { path: "src/shared.ts", similarity: 0.9, documentIds: ["shared"] };
    const hits = fuseSemanticCandidateRankings([
      [
        shared,
        { path: "src/view-a.ts", similarity: 0.8, documentIds: ["a"] }
      ],
      [
        shared,
        { path: "src/view-b.ts", similarity: 0.8, documentIds: ["b"] }
      ]
    ], 3);

    expect(hits.map((hit) => hit.path)).toEqual([
      "src/shared.ts",
      "src/view-a.ts",
      "src/view-b.ts"
    ]);
  });

  it("preserves equal-depth candidates from each semantic query view", () => {
    const hits = fuseSemanticCandidateRankings([
      [
        { path: "src/shared-a.ts", similarity: 0.72, documentIds: ["shared-a-1"] },
        { path: "src/facet-a.ts", similarity: 0.71, documentIds: ["facet-a"] },
        { path: "src/shared-b.ts", similarity: 0.70, documentIds: ["shared-b-1"] }
      ],
      [
        { path: "src/shared-a.ts", similarity: 0.73, documentIds: ["shared-a-2"] },
        { path: "src/facet-b.ts", similarity: 0.72, documentIds: ["facet-b"] },
        { path: "src/shared-b.ts", similarity: 0.71, documentIds: ["shared-b-2"] }
      ]
    ], 3, 10);

    expect(hits.map((hit) => hit.path)).toEqual([
      "src/shared-a.ts",
      "src/facet-a.ts",
      "src/facet-b.ts"
    ]);
  });

  it("reserves semantic capacity for agreement across independent query views", () => {
    const singleView = (view: string) => Array.from({ length: 5 }, (_, index) => ({
      path: `src/${view}-${index}.ts`,
      similarity: 0.9 - index / 100,
      documentIds: [`${view}-${index}`]
    }));
    const left = singleView("left");
    const right = singleView("right");
    left.splice(3, 0, {
      path: "src/cross-view-consensus.ts",
      similarity: 0.84,
      documentIds: ["consensus-left"]
    });
    right.splice(3, 0, {
      path: "src/cross-view-consensus.ts",
      similarity: 0.83,
      documentIds: ["consensus-right"]
    });

    const hits = fuseSemanticCandidateRankings([left, right], 6);

    expect(hits[0]).toMatchObject({
      path: "src/cross-view-consensus.ts",
      similarity: 0.84,
      documentIds: ["consensus-left", "consensus-right"]
    });
    expect(hits.some((hit) => hit.path === "src/left-0.ts")).toBe(true);
    expect(hits.some((hit) => hit.path === "src/right-0.ts")).toBe(true);
  });

  it("does not let a large consensus pool crowd out a strong independent model facet", () => {
    const shared = Array.from({ length: 16 }, (_, index) => ({
      path: `src/shared-${index}.ts`,
      similarity: 0.99 - index / 100,
      documentIds: [`shared-${index}`]
    }));
    const left = [
      ...shared,
      ...Array.from({ length: 48 }, (_, index) => ({
        path: index === 3 ? "src/facet-target.ts" : `src/left-${index}.ts`,
        similarity: 0.8 - index / 100,
        documentIds: [`left-${index}`]
      }))
    ];
    const right = [
      ...shared,
      ...Array.from({ length: 48 }, (_, index) => ({
        path: `src/right-${index}.ts`,
        similarity: 0.8 - index / 100,
        documentIds: [`right-${index}`]
      }))
    ];

    const hits = fuseSemanticCandidateRankings([left, right], 64);

    expect(hits.findIndex((hit) => hit.path === "src/facet-target.ts") + 1)
      .toBeLessThanOrEqual(32);
    expect(hits.slice(0, 16).every((hit) => hit.path.startsWith("src/shared-")))
      .toBe(true);
  });

  it("reports explicit fallback when a local model is unavailable and performs no download", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-missing-"));
    try {
      const modelPath = path.join(temporary, "missing-model");
      expect(getSemanticModelState({ modelPath, modelId: "jina-code-v2-q8" }).status).toBe("unavailable");
      const result = await searchSemanticCandidates({
        query: "behavioral description",
        config: { mode: "semantic", modelId: "jina-code-v2-q8", modelPath },
        documents: [],
        embeddings: []
      });
      expect(result.status).toMatchObject({
        servedMode: "fallback",
        semanticModelId: "jina-code-v2-q8",
        semanticIndexStatus: "unavailable"
      });
      expect(fs.existsSync(modelPath)).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects installed artifacts that no longer match the pinned model manifest", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-manifest-"));
    const modelPath = path.join(temporary, "model");
    try {
      fs.mkdirSync(modelPath);
      const manifest = {
        ...getSemanticModelManifest("jina-code-v2-q8"),
        queryPrefix: "mutated artifact identity"
      };
      const manifestSha256 = createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex");
      fs.writeFileSync(path.join(modelPath, "kairn-model.json"), `${JSON.stringify({
        formatVersion: 1,
        installedAt: "2026-07-24T00:00:00.000Z",
        manifest,
        manifestSha256
      })}\n`);

      expect(getSemanticModelState({
        modelId: "jina-code-v2-q8",
        modelPath
      })).toMatchObject({
        status: "incompatible",
        error: expect.stringContaining("pinned artifact manifest")
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("distinguishes a document-profile migration from a model artifact change", () => {
    const current = getSemanticModelManifest("jina-code-v2-q8");
    expect(hasSameSemanticModelArtifact(
      {
        ...current,
        documentSchemaVersion: "semantic-documents-v4"
      },
      current
    )).toBe(true);
    expect(hasSameSemanticModelArtifact(
      {
        ...current,
        queryPrefix: "changed model input"
      },
      current
    )).toBe(false);
  });

  it("enforces the 200MB cap across the complete user model cache", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-cache-cap-"));
    let fetched = false;
    try {
      const occupied = path.join(getSemanticModelsRoot(temporary), "another-model");
      fs.mkdirSync(occupied, { recursive: true });
      const occupiedWeights = path.join(occupied, "weights.bin");
      fs.writeFileSync(occupiedWeights, "");
      fs.truncateSync(occupiedWeights, 50 * 1024 * 1024);

      await expect(installSemanticModel({
        modelId: "jina-code-v2-q8",
        homeDir: temporary,
        fetchImpl: (async () => {
          fetched = true;
          throw new Error("fetch must not run when the cache gate fails");
        }) as typeof fetch
      })).rejects.toThrow("200MB semantic model cache limit");
      expect(fetched).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("builds objective file and symbol documents across the five pilot languages", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-docs-"));
    const definitions = [
      ["src/renew.py", "python", "def renew_access(value):\n    return value\n"],
      ["src/renew.ts", "typescript", "export function renewAccess(value: string) { return value; }\n"],
      ["src/renew.go", "go", "package access\nfunc RenewAccess(value string) string { return value }\n"],
      ["src/RenewAccess.java", "java", "class RenewAccess { String run(String value) { return value; } }\n"],
      ["src/renew_access.cpp", "cpp", "std::string renew_access(std::string value) { return value; }\n"]
    ] as const;
    try {
      const files = definitions.map(([filePath, language, content]) => {
        const absolute = path.join(rootPath, filePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
        return file(rootPath, filePath, "tier3", language);
      });
      const generatedPath = path.join(rootPath, "vendor/generated.ts");
      fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
      fs.writeFileSync(generatedPath, "export const generated = true;\n");
      const generated = file(rootPath, "vendor/generated.ts", "tier0", "typescript");
      const graph: RepoGraph = {
        rootPath,
        files: [...files, generated],
        parsedFiles: files.map((record) => ({
          rootPath,
          filePath: record.path,
          language: record.language,
          imports: [],
          hasErrors: false,
          symbols: [{
            rootPath,
            filePath: record.path,
            name: "renewAccess",
            kind: "function",
            exported: true,
            startLine: 1,
            endLine: 1,
            signature: "renewAccess(value)"
          }]
        })),
        symbols: files.flatMap((record) => {
          const symbol = {
            rootPath,
            filePath: record.path,
            name: "renewAccess",
            kind: "function" as const,
            exported: true,
            startLine: 1,
            endLine: 1,
            signature: "renewAccess(value)"
          };
          // Some real parsers report the same declaration through multiple
          // syntax paths. The semantic document store must remain unique.
          return [symbol, { ...symbol }];
        }),
        edges: []
      };

      const documents = buildSemanticDocuments({ rootPath, graph, maxDocuments: 20 });
      for (const [filePath, language] of definitions) {
        expect(documents).toEqual(expect.arrayContaining([
          expect.objectContaining({ filePath, kind: "file" })
        ]));
        expect(documents.find((item) => item.filePath === filePath)?.text).toContain(`language: ${language}`);
      }
      expect(documents.some((item) => item.filePath === generated.path)).toBe(false);
      expect(documents.some((item) => item.kind === "symbol")).toBe(true);
      expect(new Set(documents.map((item) => item.id)).size).toBe(documents.length);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("allocates bounded symbol documents across large files without first-symbol bias", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-symbol-budget-"));
    try {
      const largePath = "src/large-parser.ts";
      const largeLines = Array.from(
        { length: 40 },
        (_, index) => `method${index + 1}() { return ${index + 1}; }`
      );
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, largePath), `${largeLines.join("\n")}\n`);
      const smallFiles = Array.from({ length: 10 }, (_, index) => `src/small-${index}.ts`);
      for (const filePath of smallFiles) fs.writeFileSync(path.join(rootPath, filePath), "export const value = 1;\n");
      const files = [
        file(rootPath, largePath),
        ...smallFiles.map((filePath) => file(rootPath, filePath))
      ];
      const largeSymbols = largeLines.map((_, index) => ({
        rootPath,
        filePath: largePath,
        name: `method${index + 1}`,
        kind: "function" as const,
        exported: false,
        startLine: index + 1,
        endLine: index + 1,
        signature: `method${index + 1}()`
      }));
      const smallSymbols = smallFiles.map((filePath) => ({
        rootPath,
        filePath,
        name: "value",
        kind: "const" as const,
        exported: true,
        startLine: 1,
        endLine: 1,
        signature: "export const value = 1"
      }));
      const symbols = [...largeSymbols, ...smallSymbols];
      const graph: RepoGraph = {
        rootPath,
        files,
        parsedFiles: files.map((record) => ({
          rootPath,
          filePath: record.path,
          language: record.language,
          imports: [],
          hasErrors: false,
          symbols: symbols.filter((symbol) => symbol.filePath === record.path)
        })),
        symbols,
        edges: []
      };

      const documents = buildSemanticDocuments({
        rootPath,
        graph,
        maxDocuments: files.length + 12
      });
      const largeSymbolDocuments = documents.filter(
        (document) => document.filePath === largePath && document.kind === "symbol"
      );
      expect(largeSymbolDocuments.length).toBeGreaterThanOrEqual(4);
      expect(largeSymbolDocuments.some((document) => /method(?:3[0-9]|40)/.test(document.symbol ?? ""))).toBe(true);
      expect(documents.length).toBeLessThanOrEqual(files.length + 12);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("preserves structurally sampled declarations and source regions within the model document budget", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-representative-"));
    try {
      const filePath = "src/large-service.ts";
      const sourceRegions = Array.from(
        { length: 5 },
        (_, index) => `${`region_${index}_sentinel `.repeat(90)}\n`
      );
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, filePath), sourceRegions.join(""));
      const symbols = Array.from({ length: 20 }, (_, index) => ({
        rootPath,
        filePath,
        name: `operation${index}`,
        kind: "function" as const,
        exported: index % 2 === 0,
        startLine: index + 1,
        endLine: index + 1,
        signature: `operation${index}(value: string)`
      }));
      const graph: RepoGraph = {
        rootPath,
        files: [file(rootPath, filePath)],
        parsedFiles: [{
          rootPath,
          filePath,
          language: "typescript",
          imports: Array.from({ length: 20 }, (_, index) => `package-${index}`),
          hasErrors: false,
          symbols
        }],
        symbols,
        edges: []
      };

      const fileDocument = buildSemanticDocuments({
        rootPath,
        graph,
        maxDocuments: 1
      })[0]!;
      expect(fileDocument.text.length).toBeLessThanOrEqual(1_500);
      expect(fileDocument.text).toContain("operation0");
      expect(fileDocument.text).toContain("operation19");
      expect(fileDocument.text).toContain("callable surface:");
      expect(fileDocument.text).toContain("operation11");
      expect(fileDocument.text).toContain("package-0");
      expect(fileDocument.text).toContain("package-19");
      expect(fileDocument.text).toContain("region_0_sentinel");
      expect(fileDocument.text).toContain("region_4_sentinel");
      expect(fileDocument.text).toContain("[…]");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("includes documentation structurally attached to declarations in bounded file documents", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-documentation-"));
    try {
      const filePath = "src/attach_config.go";
      const content = [
        "package service",
        "",
        "// AttachConfig connects removed configuration blocks to graph nodes.",
        "// The caller supplies either an active resource or a removed resource.",
        "type AttachConfig interface {",
        "  Attach(*Resource, *Removed)",
        "}",
        "",
        "func unrelated() {}"
      ].join("\n");
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, filePath), content);
      const symbols = [{
        rootPath,
        filePath,
        name: "AttachConfig",
        kind: "interface" as const,
        exported: true,
        startLine: 5,
        endLine: 7,
        signature: "type AttachConfig interface"
      }];
      const graph: RepoGraph = {
        rootPath,
        files: [file(rootPath, filePath)],
        parsedFiles: [{
          rootPath,
          filePath,
          language: "go",
          imports: [],
          hasErrors: false,
          symbols
        }],
        symbols,
        edges: []
      };

      const fileDocument = buildSemanticDocuments({
        rootPath,
        graph,
        maxDocuments: 1
      })[0]!;
      expect(fileDocument.text.length).toBeLessThanOrEqual(1_500);
      expect(fileDocument.text).toContain(
        "AttachConfig connects removed configuration blocks to graph nodes"
      );
      expect(fileDocument.text).toContain(
        "caller supplies either an active resource or a removed resource"
      );
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("retains bounded behavioral symbol coverage when file documents exceed the nominal budget", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-large-repo-budget-"));
    try {
      const files = Array.from({ length: 20 }, (_, index) => {
        const filePath = `src/module-${index}.ts`;
        fs.mkdirSync(path.dirname(path.join(rootPath, filePath)), { recursive: true });
        fs.writeFileSync(
          path.join(rootPath, filePath),
          Array.from({ length: 8 }, (__, symbolIndex) =>
            `function operation${index}_${symbolIndex}() { return ${symbolIndex}; }`
          ).join("\n")
        );
        return file(rootPath, filePath);
      });
      const symbols = files.flatMap((record, fileIndex) =>
        Array.from({ length: 8 }, (__, symbolIndex) => ({
          rootPath,
          filePath: record.path,
          name: `operation${fileIndex}_${symbolIndex}`,
          kind: "function" as const,
          exported: false,
          startLine: symbolIndex + 1,
          endLine: symbolIndex + 1,
          signature: `operation${fileIndex}_${symbolIndex}()`
        }))
      );
      const graph: RepoGraph = {
        rootPath,
        files,
        parsedFiles: files.map((record) => ({
          rootPath,
          filePath: record.path,
          language: record.language,
          imports: [],
          hasErrors: false,
          symbols: symbols.filter((symbol) => symbol.filePath === record.path)
        })),
        symbols,
        edges: []
      };

      const documents = buildSemanticDocuments({
        rootPath,
        graph,
        maxDocuments: 10
      });
      expect(documents.filter((document) => document.kind === "file")).toHaveLength(20);
      expect(documents.filter((document) => document.kind === "symbol")).toHaveLength(5);
      expect(documents).toHaveLength(25);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("reserves bounded symbol coverage for large behavioral bodies", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-symbol-span-"));
    try {
      const filePath = "src/workflow.ts";
      const content = Array.from(
        { length: 40 },
        (_, index) => `const line${index + 1} = ${index + 1};`
      ).join("\n");
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, filePath), content);
      const symbols = [
        {
          rootPath,
          filePath,
          name: "smallStart",
          kind: "function" as const,
          exported: false,
          startLine: 1,
          endLine: 2,
          signature: "smallStart()"
        },
        {
          rootPath,
          filePath,
          name: "coreWorkflow",
          kind: "function" as const,
          exported: false,
          startLine: 5,
          endLine: 32,
          signature: "coreWorkflow()"
        },
        {
          rootPath,
          filePath,
          name: "smallEnd",
          kind: "function" as const,
          exported: false,
          startLine: 39,
          endLine: 40,
          signature: "smallEnd()"
        }
      ];
      const documents = buildSemanticDocuments({
        rootPath,
        graph: {
          rootPath,
          files: [file(rootPath, filePath)],
          parsedFiles: [{
            rootPath,
            filePath,
            language: "typescript",
            imports: [],
            hasErrors: false,
            symbols
          }],
          symbols,
          edges: []
        },
        maxDocuments: 3
      });

      expect(
        documents
          .filter((candidate) => candidate.kind === "symbol")
          .map((candidate) => candidate.symbol)
      ).toContain("coreWorkflow");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("stores compact embeddings incrementally by model and replaces them only after success", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-store-"));
    const store = new SqliteStore(path.join(temporary, "kairn.sqlite"));
    const rootPath = "/repo";
    const semanticDocument = document(rootPath, "doc", "src/source.ts", "file", "hash");
    const first = embedding(rootPath, semanticDocument, new Float32Array([1, 0]), "model-a");
    const second = embedding(rootPath, semanticDocument, new Float32Array([0, 1]), "model-b");
    try {
      store.upsertSemanticEmbeddings([first]);
      store.upsertSemanticEmbeddings([second]);
      expect(store.listSemanticEmbeddings(rootPath).map((item) => item.modelId))
        .toEqual(["model-a", "model-b"]);
      expect(store.listSemanticEmbeddings(rootPath)[0]?.vector).toBeInstanceOf(Int8Array);

      store.replaceIndex({
        rootPath,
        files: [],
        symbols: [],
        edges: [],
        semanticDocuments: [semanticDocument],
        semanticEmbeddings: [second]
      });
      expect(store.listSemanticEmbeddings(rootPath).map((item) => item.modelId)).toEqual(["model-b"]);
      expect(store.listSemanticDocuments(rootPath)).toHaveLength(1);
    } finally {
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("enforces the no-heuristic semantic serving boundary", () => {
    expect(() => execFileSync(
      process.execPath,
      [path.resolve("scripts/check-semantic-architecture.mjs")],
      { cwd: process.cwd(), encoding: "utf8" }
    )).not.toThrow();
  });
});

function file(
  rootPath: string,
  filePath: string,
  indexTier: FileRecord["indexTier"] = "tier3",
  language = "typescript"
): FileRecord {
  return {
    rootPath,
    path: filePath,
    language,
    kind: "source",
    size: 100,
    hash: `hash-${filePath}`,
    importance: 0.5,
    indexTier,
    tierScore: 0.5,
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}

function scored(record: FileRecord, bm25Score: number): HybridScoredResult {
  return {
    ...record,
    score: bm25Score * 100,
    reasons: ["BM25 candidate"],
    semanticScore: 0,
    keywordScore: 0,
    bm25Score,
    behaviorScore: 0,
    graphScore: 0,
    intentScore: 0,
    sessionScore: 0,
    importanceScore: record.importance,
    gitScore: 0,
    chunks: []
  };
}

function edge(
  rootPath: string,
  fromFile: string,
  toFile: string,
  type: GraphEdgeRecord["type"]
): GraphEdgeRecord {
  return { rootPath, fromFile, toFile, type, metadata: {} };
}

function document(
  rootPath: string,
  id: string,
  filePath: string,
  kind: SemanticDocumentRecord["kind"],
  hash: string
): SemanticDocumentRecord {
  return {
    rootPath,
    id,
    filePath,
    kind,
    text: `${filePath} implementation behavior`,
    hash,
    tokenEstimate: 8,
    schemaVersion: "semantic-documents-v5"
  };
}

function embedding(
  rootPath: string,
  semanticDocument: SemanticDocumentRecord,
  vector: Float32Array,
  modelId = "test-model"
): SemanticEmbeddingRecord {
  return quantizeSemanticEmbedding({
    rootPath,
    documentId: semanticDocument.id,
    documentHash: semanticDocument.hash,
    modelId,
    schemaVersion: "semantic-documents-v5",
    vector
  });
}

function readyStatus(count: number) {
  return {
    requestedMode: "semantic" as const,
    servedMode: "semantic" as const,
    semanticModelId: "test-model",
    semanticIndexStatus: "ready" as const,
    documentCount: count,
    embeddingCount: count
  };
}
