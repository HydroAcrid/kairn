import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureIndexFreshnessMetadata,
  evaluateIndexFreshness,
  INDEX_FRESHNESS_SCHEMA_VERSION
} from "../src/indexer/freshness.js";

describe("index pipeline freshness", () => {
  it("invalidates structural index records created by an older pipeline schema", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-index-schema-"));
    try {
      fs.writeFileSync(path.join(rootPath, "source.ts"), "export const value = 1;\n");
      const current = captureIndexFreshnessMetadata({ rootPath, fileCount: 1 });
      const stale = evaluateIndexFreshness({
        rootPath,
        stored: {
          ...current,
          schemaVersion: INDEX_FRESHNESS_SCHEMA_VERSION - 1
        }
      });

      expect(stale).toMatchObject({
        stale: true,
        reason: "index_schema_changed"
      });
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
