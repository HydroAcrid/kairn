// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeHookAuditRecord } from "../src/watch/hookAudit.js";

describe("hook audit receipt", () => {
  const previous = process.env.KAIRN_HOOK_AUDIT_PATH;

  afterEach(() => {
    if (previous === undefined) delete process.env.KAIRN_HOOK_AUDIT_PATH;
    else process.env.KAIRN_HOOK_AUDIT_PATH = previous;
  });

  it("records proof and payload size without storing emitted repository context", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-hook-audit-"));
    const target = path.join(temporary, "audit.jsonl");
    const sensitive = "Read src/private-production-source.ts next";
    process.env.KAIRN_HOOK_AUDIT_PATH = target;

    writeHookAuditRecord({ source: "codex", eventName: "UserPromptSubmit", content: sensitive });

    const raw = fs.readFileSync(target, "utf8");
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(raw).not.toContain(sensitive);
    expect(record).toMatchObject({
      schemaVersion: "kairn-hook-audit.v1",
      source: "codex",
      eventName: "UserPromptSubmit",
      emitted: true
    });
    expect(record.estimatedPayloadTokens).toEqual(expect.any(Number));
    expect(record.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
