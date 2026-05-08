import type { FileRecord } from "../types.js";

export function estimateFileBaselineTokens(files: Pick<FileRecord, "size">[]): number {
  return files.reduce((total, file) => total + Math.ceil(file.size / 4), 0);
}
