// SPDX-License-Identifier: Apache-2.0

export function sliceLines(content: string, startLine: number, endLine: number): string {
  return content.split(/\r?\n/).slice(startLine - 1, endLine).join("\n");
}
