// SPDX-License-Identifier: Apache-2.0

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

type SqliteOptions = Database.Options;
export type SqliteDatabase = Database.Database;

export function openSqliteDatabase(filename: string, options: SqliteOptions = {}): SqliteDatabase {
  const nativeBinding = resolveSqliteNativeBinding();
  return new Database(filename, nativeBinding ? { ...options, nativeBinding } : options);
}

function resolveSqliteNativeBinding(): string | undefined {
  for (const root of runtimeAssetRoots()) {
    const candidate = path.join(root, "better-sqlite3", "better_sqlite3.node");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function runtimeAssetRoots(): string[] {
  const roots: string[] = [];
  if (process.env.KAIRN_ASSET_DIR) roots.push(process.env.KAIRN_ASSET_DIR);
  if (isPkgRuntime()) roots.push(path.join(path.dirname(process.execPath), "assets"));
  const entry = process.argv[1];
  if (entry) roots.push(path.join(path.dirname(entry), "assets"));
  return roots;
}

function isPkgRuntime(): boolean {
  return Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
}
