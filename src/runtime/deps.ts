// SPDX-License-Identifier: Apache-2.0

import type { SqliteStore } from "../store/sqliteStore.js";
import type { SemanticRetrieverConfig } from "../types.js";

export type RuntimeDeps = {
  rootPath: string;
  store: SqliteStore;
  semanticConfig?: SemanticRetrieverConfig;
};
