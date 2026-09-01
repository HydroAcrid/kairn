// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store/sqliteStore.js";

describe("query-local index storage", () => {
  it("migrates legacy embeddings to an explicit runtime identity", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-cache-migration-"));
    const databasePath = path.join(temporary, "kairn.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      create table semantic_embeddings (
        root_path text not null,
        document_id text not null,
        document_hash text not null,
        model_id text not null,
        schema_version text not null,
        dimensions integer not null,
        vector_blob blob not null,
        scale real not null,
        primary key (root_path, document_id, model_id)
      )
    `);
    legacy.prepare(`
      insert into semantic_embeddings values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "/repo", "doc", "hash", "model", "semantic-documents-v5", 2,
      Buffer.from(new Int8Array([127, 0]).buffer), 0.005
    );
    legacy.close();

    const store = new SqliteStore(databasePath);
    try {
      expect(store.listSemanticEmbeddings("/repo")).toEqual([
        expect.objectContaining({
          runtimeBackend: "wasm",
          runtimeId: "onnxruntime-web@1.27.0"
        })
      ]);
    } finally {
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("gives every requested lexical term a fair first document before repeats", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-lexical-fairness-"));
    const store = new SqliteStore(path.join(temporary, "kairn.sqlite"));
    const rootPath = "/repo";
    const queryTerms = ["target", "alpha", "beta"];
    try {
      store.replaceIndex({
        rootPath,
        files: [],
        symbols: [],
        edges: [],
        lexicalTerms: queryTerms.flatMap((term) =>
          Array.from({ length: 20 }, (_, index) => ({
            rootPath,
            term,
            documentId: `${term}-${String(index).padStart(2, "0")}`,
            filePath: `src/${term}-${String(index).padStart(2, "0")}.ts`,
            frequency: 1
          }))
        )
      });

      expect(store.listLexicalTermsForTerms(rootPath, queryTerms, 3).map((row) => row.term))
        .toEqual(queryTerms);
    } finally {
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("gives every requested graph seed a fair edge before path-ordered backfill", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-graph-fairness-"));
    const store = new SqliteStore(path.join(temporary, "kairn.sqlite"));
    const rootPath = "/repo";
    try {
      store.replaceIndex({
        rootPath,
        files: [],
        symbols: [],
        edges: [
          ...Array.from({ length: 40 }, (_, index) => ({
            rootPath,
            fromFile: "src/a-high-degree.ts",
            toFile: `src/a-neighbor-${String(index).padStart(2, "0")}.ts`,
            type: "implementation" as const,
            metadata: {}
          })),
          {
            rootPath,
            fromFile: "src/z-late-seed.ts",
            toFile: "src/required-implementation.ts",
            type: "implementation" as const,
            metadata: {}
          }
        ],
        lexicalTerms: []
      });

      const edges = store.listGraphEdgesForFiles(
        rootPath,
        ["src/a-high-degree.ts", "src/z-late-seed.ts"],
        10
      );
      expect(edges).toContainEqual(expect.objectContaining({
        fromFile: "src/z-late-seed.ts",
        toFile: "src/required-implementation.ts",
        type: "implementation"
      }));
      expect(edges).toHaveLength(10);
    } finally {
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
