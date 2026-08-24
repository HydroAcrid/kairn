// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store/sqliteStore.js";

describe("query-local index storage", () => {
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
