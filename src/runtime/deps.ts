// SPDX-License-Identifier: Apache-2.0

import type { SqliteStore } from "../store/sqliteStore.js";

export type RuntimeDeps = {
  rootPath: string;
  store: SqliteStore;
};
