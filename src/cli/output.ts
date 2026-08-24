// SPDX-License-Identifier: Apache-2.0

import type { ContextResponse } from "../types.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printContextResponse(response: ContextResponse, asJson = false): void {
  if (asJson) {
    printJson(response);
    return;
  }

  process.stdout.write(`${response.content}\n`);

  if (response.warnings.length > 0) {
    process.stdout.write(`\n## Warnings\n${response.warnings.map((warning) => `- ${warning}`).join("\n")}\n`);
  }
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}
