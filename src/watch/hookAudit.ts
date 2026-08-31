// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../utils/hash.js";
import { estimateTokens } from "../utils/tokens.js";
import type { WatchEventSource } from "../types.js";

export type HookAuditRecord = {
  schemaVersion: "kairn-hook-audit.v1";
  source: WatchEventSource;
  eventName: string;
  emitted: boolean;
  estimatedPayloadTokens: number;
  payloadSha256: string;
};

/**
 * Benchmark-only hook receipt. It deliberately stores no prompt, repository
 * content, or emitted context. The opt-in environment variable is set by the
 * live pilot so the harness can prove that Codex actually invoked Kairn.
 */
export function writeHookAuditRecord(input: {
  source: WatchEventSource;
  eventName: string;
  content?: string | undefined;
}): void {
  const target = process.env.KAIRN_HOOK_AUDIT_PATH?.trim();
  if (!target) return;
  const content = input.content ?? "";
  const record: HookAuditRecord = {
    schemaVersion: "kairn-hook-audit.v1",
    source: input.source,
    eventName: input.eventName,
    emitted: Boolean(content.trim()),
    estimatedPayloadTokens: estimateTokens(content),
    payloadSha256: sha256(content)
  };
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
