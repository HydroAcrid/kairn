// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import type { IndexingConfig } from "../types.js";
import { getKairnPaths } from "./paths.js";

export const DEFAULT_INDEXING_CONFIG: IndexingConfig = {
  maxStateMb: 250,
  hardMaxStateMb: 1000,
  maxGraphEdges: 250_000,
  maxSemanticChunks: 7_500,
  maxHotFiles: 3_000
};

export function loadIndexingConfig(rootPath: string): IndexingConfig {
  const { configPath } = getKairnPaths(rootPath);
  if (!fs.existsSync(configPath)) return DEFAULT_INDEXING_CONFIG;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      indexing?: Partial<IndexingConfig>;
    };
    return {
      ...DEFAULT_INDEXING_CONFIG,
      ...(parsed.indexing ?? {})
    };
  } catch {
    return DEFAULT_INDEXING_CONFIG;
  }
}

export function stateLimitBytes(config: Pick<IndexingConfig, "maxStateMb" | "hardMaxStateMb">) {
  return {
    maxStateBytes: config.maxStateMb * 1024 * 1024,
    hardMaxStateBytes: config.hardMaxStateMb * 1024 * 1024
  };
}
