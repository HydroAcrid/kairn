import { describe, expect, it } from "vitest";
import { hybridSearch } from "../src/retrieval/hybridRetrieval.js";
import { decideResponse } from "../src/retrieval/responseRouter.js";
import { embedText, cosineSimilarity } from "../src/semantic/vector.js";
import { indexRepo } from "../src/indexer/indexRepo.js";
import type { FileRecord, GraphEdgeRecord, SemanticChunkRecord, SemanticVectorRecord, SymbolRecord } from "../src/types.js";
import { createFixtureRepo } from "./helpers.js";

describe("semantic indexing", () => {
  it("creates symbol-aware chunks and file summary chunks", async () => {
    const root = createFixtureRepo();
    const index = await indexRepo(root);

    expect(index.semanticChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/app.ts",
          kind: "symbol",
          symbol: "renderDashboard"
        }),
        expect.objectContaining({
          filePath: "app/dashboard/DashboardCard.tsx",
          kind: "symbol",
          symbol: "DashboardCard"
        }),
        expect.objectContaining({
          filePath: "package.json",
          kind: "file_summary"
        })
      ])
    );
    expect(index.semanticChunks.every((chunk) => chunk.tokenEstimate <= 2100)).toBe(true);
    expect(index.semanticVectors).toHaveLength(index.semanticChunks.length);
  });
});

describe("lexical vectors", () => {
  it("produces deterministic vectors and matches camelCase terms", () => {
    const first = embedText("DashboardMetrics renders pipeline health");
    const second = embedText("DashboardMetrics renders pipeline health");
    const related = embedText("dashboard metrics pipeline");
    const unrelated = embedText("oauth token storage");

    expect(first).toEqual(second);
    expect(cosineSimilarity(first, related)).toBeGreaterThan(cosineSimilarity(first, unrelated));
  });

  it("handles empty queries", () => {
    expect(embedText("")).toEqual(Array.from({ length: 256 }, () => 0));
  });
});

describe("hybridSearch", () => {
  it("finds semantically relevant files even when the path and symbols do not match the query", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/view.ts", "source"),
      file(rootPath, "src/oauth.ts", "source")
    ];
    const chunks = [
      chunk(rootPath, "src/view.ts", "BillingPortal", "export function BillingPortal() { return 'payment invoices receipts'; }"),
      chunk(rootPath, "src/oauth.ts", "TokenStore", "export function TokenStore() { return 'refresh token oauth'; }")
    ];
    const vectors = chunks.map((record) => vector(rootPath, record));
    const results = hybridSearch({
      files,
      query: "payment invoices",
      symbols: [],
      chunks,
      vectors,
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("src/view.ts");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["semantic match: BillingPortal"]));
  });

  it("adds graph and git reasons when nearby files are relevant", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/app.ts", "source"),
      file(rootPath, "src/app.test.ts", "test")
    ];
    const symbols = [symbol(rootPath, "src/app.ts", "renderDashboard")];
    const edges: GraphEdgeRecord[] = [
      {
        rootPath,
        fromFile: "src/app.ts",
        toFile: "src/app.test.ts",
        type: "tested_by",
        metadata: {}
      }
    ];
    const results = hybridSearch({
      files,
      query: "render dashboard tests",
      symbols,
      chunks: [],
      vectors: [],
      edges,
      changedFiles: new Set(["src/app.test.ts"])
    });

    const testResult = results.find((result) => result.path === "src/app.test.ts");
    expect(testResult?.reasons).toEqual(expect.arrayContaining(["graph neighbor", "changed in diff"]));
  });
});

describe("decideResponse", () => {
  it("routes explicit and discovery requests", () => {
    expect(decideResponse({ requestType: "file" }).mode).toBe("exact_code");
    expect(decideResponse({ requestType: "find_context", explicitMode: "summary" }).mode).toBe(
      "compressed_summary"
    );
    expect(decideResponse({ requestType: "find_context", query: "auth", budget: 600 }).mode).toBe("snippets");
  });

  it("warns for repeated and low-confidence context", () => {
    const decision = decideResponse({
      requestType: "find_context",
      query: "unknown",
      topScore: 4,
      repeatedFiles: 1,
      graphAvailable: false
    });

    expect(decision.warnings).toEqual(
      expect.arrayContaining([
        "Some top results were already shown in this session.",
        "No graph edges are available yet; related context is using lexical retrieval only.",
        "Retrieval confidence is low. Use a more specific file, symbol, or task query."
      ])
    );
  });
});

function file(rootPath: string, filePath: string, kind: FileRecord["kind"]): FileRecord {
  return {
    rootPath,
    path: filePath,
    language: "typescript",
    kind,
    size: 100,
    hash: filePath,
    importance: 4,
    updatedAt: "2026-05-05T00:00:00.000Z"
  };
}

function symbol(rootPath: string, filePath: string, name: string): SymbolRecord {
  return {
    rootPath,
    filePath,
    name,
    kind: "function",
    exported: true,
    startLine: 1,
    endLine: 3,
    signature: `export function ${name}()`
  };
}

function chunk(rootPath: string, filePath: string, symbolName: string, text: string): SemanticChunkRecord {
  return {
    rootPath,
    id: `${filePath}:${symbolName}`,
    filePath,
    kind: "symbol",
    symbol: symbolName,
    startLine: 1,
    endLine: 1,
    text: [`file: ${filePath}`, `symbol: ${symbolName}`, text].join("\n"),
    hash: `${filePath}:${symbolName}`,
    tokenEstimate: 20
  };
}

function vector(rootPath: string, record: SemanticChunkRecord): SemanticVectorRecord {
  return {
    rootPath,
    chunkId: record.id,
    dimensions: 256,
    vector: embedText(record.text)
  };
}
