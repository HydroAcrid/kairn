import type { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { TelemetryFlushResult } from "../types.js";
import { ensureTelemetryIdentity, loadTelemetryConfig } from "./config.js";
import { buildTelemetryPayload } from "./payload.js";
import { enqueueTelemetryPayload, flushTelemetryQueue } from "./queue.js";

export async function queueAndFlushTelemetrySnapshot(input: {
  rootPath: string;
  runtime: KairnRuntime;
  sessionId?: string | undefined;
  endpoint?: string | undefined;
}): Promise<TelemetryFlushResult | undefined> {
  const config = loadTelemetryConfig(input.rootPath);
  if (!config.enabled) {
    return undefined;
  }
  const endpoint = input.endpoint ?? config.endpoint ?? process.env.KAIRN_TELEMETRY_ENDPOINT;
  if (!endpoint) {
    return undefined;
  }

  const identity = ensureTelemetryIdentity(input.rootPath);
  const payload = buildTelemetryPayload({
    runtime: input.runtime,
    installationId: identity.installationId!,
    repoSalt: identity.repoSalt!,
    sessionId: input.sessionId
  });
  enqueueTelemetryPayload({ rootPath: input.rootPath, payload });
  return await flushTelemetryQueue({
    rootPath: input.rootPath,
    endpoint
  });
}
