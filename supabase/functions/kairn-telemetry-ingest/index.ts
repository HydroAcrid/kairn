type TelemetryPayload = {
  schemaVersion: 1;
  generatedAt: string;
  installationId: string;
  kairnVersion: string;
  [key: string]: unknown;
};

const unsafeKeys = /prompt|output|diff|sourceCode|source_code|path|filename|repoUrl|repository|branch|cwd/i;
const unsafeString = /https?:\/\/|git@|github\.com[:/]|\/Users\/|\/home\/|[A-Za-z]:\\|\.\/|\.\.\/|\n/;

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let payload: TelemetryPayload;
  try {
    payload = await request.json();
    validatePayload(payload);
  } catch (error) {
    return json({ error: "invalid_payload", detail: error instanceof Error ? error.message : String(error) }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "server_not_configured" }, 500);
  }

  const rateLimited = await isRateLimited({ supabaseUrl, serviceRoleKey, installationId: payload.installationId });
  if (rateLimited) {
    return json({ error: "rate_limited" }, 429);
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/kairn_telemetry_events`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      prefer: "return=minimal"
    },
    body: JSON.stringify({
      installation_id: payload.installationId,
      schema_version: payload.schemaVersion,
      payload
    })
  });

  if (!response.ok) {
    return json({ error: "insert_failed", detail: await response.text() }, 500);
  }

  return json({ ok: true }, 202);
});

async function isRateLimited(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  installationId: string;
}): Promise<boolean> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const url = new URL(`${input.supabaseUrl}/rest/v1/kairn_telemetry_events`);
  url.searchParams.set("installation_id", `eq.${input.installationId}`);
  url.searchParams.set("received_at", `gte.${since}`);
  url.searchParams.set("select", "id");
  url.searchParams.set("limit", "61");
  const response = await fetch(url, {
    headers: {
      apikey: input.serviceRoleKey,
      authorization: `Bearer ${input.serviceRoleKey}`
    }
  });
  if (!response.ok) return false;
  const rows = await response.json() as unknown[];
  return rows.length > 60;
}

function validatePayload(payload: unknown): asserts payload is TelemetryPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload must be an object.");
  }
  const record = payload as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error("Unsupported schemaVersion.");
  if (typeof record.installationId !== "string" || !record.installationId.startsWith("kairn_")) {
    throw new Error("Missing installationId.");
  }
  scan(record, []);
}

function scan(value: unknown, path: string[]): void {
  if (typeof value === "string") {
    if (value.length > 300 || unsafeString.test(value)) {
      throw new Error(`Unsafe string at ${path.join(".") || "<root>"}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, [...path, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (unsafeKeys.test(key) && (typeof item === "string" || Array.isArray(item))) {
        throw new Error(`Unsafe field ${[...path, key].join(".")}`);
      }
      scan(item, [...path, key]);
    }
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
