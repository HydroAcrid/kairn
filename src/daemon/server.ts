import http from "node:http";
import { createHash } from "node:crypto";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { HookHandlingResult, HookOutputProfile, NormalizedHookEvent, PrimeProfile } from "../types.js";
import { resolveRoot } from "../utils/paths.js";

export type KairnDaemon = {
  rootPath: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export async function startKairnDaemon(input: { root?: string | undefined; port?: number | undefined }): Promise<KairnDaemon> {
  const rootPath = resolveRoot(input.root);
  const port = input.port ?? daemonPortForRoot(rootPath);
  const runtime = new KairnRuntime(rootPath);
  await runtime.init();

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true, rootPath, port });
        return;
      }

      if (request.method === "POST" && request.url === "/hook") {
        const body = await readJsonBody(request);
        const event = body.event as NormalizedHookEvent;
        const result = await runtime.handleHookEvent({
          sessionId: optionalString(body.sessionId),
          event,
          primeProfile: optionalPrimeProfile(body.primeProfile),
          primeBudget: optionalNumber(body.primeBudget),
          hookOutput: optionalHookOutput(body.hookOutput),
          transport: "daemon",
          daemonAttempted: true,
          daemonHit: true,
          refreshIndex: event.eventName !== "UserPromptSubmit"
        });
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    rootPath,
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      runtime.close();
    }
  };
}

export async function handleHookWithDaemon(input: {
  root: string;
  sessionId?: string | undefined;
  event: NormalizedHookEvent;
  primeProfile?: PrimeProfile | undefined;
  primeBudget?: number | undefined;
  hookOutput?: HookOutputProfile | undefined;
  timeoutMs?: number | undefined;
}): Promise<HookHandlingResult | undefined> {
  if (process.env.KAIRN_DISABLE_DAEMON === "1") return undefined;
  const rootPath = resolveRoot(input.root);
  const port = daemonPortForRoot(rootPath);
  const body = JSON.stringify({
    sessionId: input.sessionId,
    event: input.event,
    primeProfile: input.primeProfile,
    primeBudget: input.primeBudget,
    hookOutput: input.hookOutput
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: HookHandlingResult | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/hook",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        },
        timeout: input.timeoutMs ?? 8000
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            settle(undefined);
            return;
          }
          try {
            settle(JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookHandlingResult);
          } catch {
            settle(undefined);
          }
        });
      }
    );
    request.on("timeout", () => {
      request.destroy();
      settle(undefined);
    });
    request.on("error", () => settle(undefined));
    request.end(body);
  });
}

export function daemonPortForRoot(root: string): number {
  const hash = createHash("sha256").update(resolveRoot(root)).digest();
  return 43170 + (hash.readUInt16BE(0) % 1000);
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalPrimeProfile(value: unknown): PrimeProfile | undefined {
  return isPrimeProfile(value) ? value : undefined;
}

function optionalHookOutput(value: unknown): HookOutputProfile | undefined {
  return value === "full-prime" || value === "tiny-directive" || value === "failure-only" ? value : undefined;
}

function isPrimeProfile(value: unknown): value is PrimeProfile {
  return value === "auto" || value === "ui" || value === "workflow" || value === "backend" || value === "test" || value === "generic";
}
