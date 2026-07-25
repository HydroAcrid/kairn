// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildModelCandidateUnion,
  reciprocalRankFuse
} from "../src/retrieval/candidateFusion.js";
import { yieldToSemanticCheckpointTimers } from "../src/indexer/indexRepo.js";
import {
  buildSemanticQueries,
  fuseSemanticCandidateRankings,
  scoreSemanticEmbeddingIndex,
  searchSemanticCandidates
} from "../src/retrieval/semanticCandidates.js";
import { buildSemanticDocuments } from "../src/semantic/documents.js";
import {
  getSemanticModelState,
  getSemanticModelsRoot,
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
    expect(SEMANTIC_MODEL_MANIFESTS).toHaveLength(2);
    for (const manifest of SEMANTIC_MODEL_MANIFESTS) {
      expect(manifest.upstreamRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(manifest.runtime).toEqual({
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
    expect(result.initialPaths).toContain(required.path);
    expect(result.initialPaths).not.toContain(arbitraryNeighbor.path);
    expect(result.candidateResults.find((candidate) => candidate.path === required.path))
      .toMatchObject({
        graphScore: 1,
        reasons: expect.arrayContaining(["direct graph neighbor"])
      });
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

    expect(result.initialPaths).toContain(productionSource.path);
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
    expect(queries.length).toBeLessThanOrEqual(2);
    expect(queries.some((query) => query.includes("explicitly empty value remains empty"))).toBe(true);
    expect(queries.every((query) => query.length <= 1_600)).toBe(true);
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
      expect(fileDocument.text.length).toBeLessThanOrEqual(768);
      expect(fileDocument.text).toContain("operation0");
      expect(fileDocument.text).toContain("operation19");
      expect(fileDocument.text).toContain("package-0");
      expect(fileDocument.text).toContain("package-19");
      expect(fileDocument.text).toContain("region_0_sentinel");
      expect(fileDocument.text).toContain("region_4_sentinel");
      expect(fileDocument.text).toContain("[…]");
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
    schemaVersion: "semantic-documents-v4"
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
    schemaVersion: "semantic-documents-v4",
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
