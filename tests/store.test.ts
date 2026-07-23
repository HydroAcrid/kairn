// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store/sqliteStore.js";

describe("query-local index storage", () => {
  it("allocates bounded semantic chunks fairly across requested files", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-semantic-fairness-"));
    const store = new SqliteStore(path.join(temporary, "kairn.sqlite"));
    const rootPath = "/repo";
    try {
      store.replaceIndex({
        rootPath,
        files: [],
        symbols: [],
        edges: [],
        semanticChunks: [
          ...Array.from({ length: 20 }, (_, index) => ({
            rootPath,
            id: `src/alpha.ts:chunk:${String(index).padStart(2, "0")}`,
            filePath: "src/alpha.ts",
            kind: "symbol" as const,
            text: `alpha ${index}`,
            hash: `alpha-${index}`,
            tokenEstimate: 2
          })),
          {
            rootPath,
            id: "src/zeta.ts:chunk:00",
            filePath: "src/zeta.ts",
            kind: "symbol" as const,
            text: "zeta",
            hash: "zeta",
            tokenEstimate: 1
          }
        ]
      });

      const chunks = store.listSemanticChunksForFilesFair(
        rootPath,
        ["src/alpha.ts", "src/zeta.ts"],
        2
      );
      expect(chunks.map((chunk) => chunk.filePath)).toEqual([
        "src/alpha.ts",
        "src/alpha.ts",
        "src/zeta.ts"
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
});
