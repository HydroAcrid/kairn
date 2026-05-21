import http from "node:http";
import { describe, expect, it } from "vitest";
import { handleHookWithDaemon, startKairnDaemon } from "../src/daemon/server.js";
import { normalizeHookPayload } from "../src/watch/normalizeHook.js";
import { createFixtureRepo } from "./helpers.js";

describe("daemon hook transport", () => {
  it("falls back cleanly when no daemon is available", async () => {
    const root = createFixtureRepo();
    const event = normalizeHookPayload({
      source: "codex",
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-session",
        prompt: "Fix the job tracker mobile layout"
      }
    });

    const result = await handleHookWithDaemon({
      root,
      event,
      hookOutput: "tiny-directive",
      timeoutMs: 50
    });

    expect(result).toBeUndefined();
  });

  it("serves prompt hook context from a warm runtime", async () => {
    const root = createFixtureRepo();
    const daemon = await startKairnDaemon({ root });
    try {
      const event = normalizeHookPayload({
        source: "codex",
        payload: {
          hook_event_name: "UserPromptSubmit",
          session_id: "codex-session",
          turn_id: "turn_1",
          prompt: "Fix the job tracker mobile layout bottom sheet"
        }
      });

      const result = await handleHookWithDaemon({
        root,
        event,
        hookOutput: "tiny-directive",
        primeBudget: 600
      });

      expect(result?.prime?.content).toContain("Kairn Start Points");
      expect(result?.event.metadata.transport).toBe("daemon");
      expect(result?.event.metadata.daemonHit).toBe(true);
      expect(Number(result?.event.metadata.refreshIndexMs)).toBeLessThan(10);
      expect(result?.prime?.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
    } finally {
      await daemon.close();
    }
  });

  it("rejects oversized hook payloads", async () => {
    const root = createFixtureRepo();
    const daemon = await startKairnDaemon({ root });
    try {
      const response = await postJson(daemon.port, "/hook", {
        event: {
          source: "codex",
          eventName: "UserPromptSubmit",
          prompt: "x".repeat(1_100_000),
          files: [],
          metadata: {}
        }
      });

      expect(response.statusCode).toBe(413);
      expect(response.body).toContain("request body too large");
    } finally {
      await daemon.close();
    }
  });
});

function postJson(port: number, path: string, payload: unknown): Promise<{ statusCode: number; body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}
