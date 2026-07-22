// SPDX-License-Identifier: Apache-2.0

import { normalizeRelativePath } from "./paths.js";

export function uniquePaths(files: string[]): string[] {
  return [...new Set(files.map((file) => normalizeRelativePath(file).replace(/^\.\//, "")).filter(Boolean))];
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
