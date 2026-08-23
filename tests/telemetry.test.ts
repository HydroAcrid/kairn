import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { queueAndFlushTelemetrySnapshot } from "../src/telemetry/autoFlush.js";
import { buildDiagnosticExport, writeDiagnosticExport } from "../src/telemetry/diagnostics.js";
import { disableTelemetry, enableTelemetry, ensureTelemetryIdentity, getTelemetryStatus } from "../src/telemetry/config.js";
import { buildTelemetryPayload } from "../src/telemetry/payload.js";
import { enqueueTelemetryPayload, flushTelemetryQueue, readTelemetryQueue } from "../src/telemetry/queue.js";
import { buildBetaReport } from "../src/telemetry/report.js";
import { buildPrivateBetaTelemetrySummary, formatPrivateBetaTelemetrySummary } from "../src/telemetry/summary.js";
import { formatShareableBetaReport } from "../src/cli/commands/beta.js";
import { assertSafeTelemetryPayload, hashFileId } from "../src/telemetry/sanitize.js";
import type { TelemetryPayload } from "../src/types.js";
import { createFixtureRepo } from "./helpers.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("telemetry", () => {
  it("does not present missing report data as zero-percent savings", () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const output = formatShareableBetaReport(buildBetaReport({ runtime }));

    expect(output).toContain("Estimated context saved: not enough data");
    expect(output).toContain("no savings claim");
    expect(output).not.toContain("0.0% (0 tokens)");
    expect(output).not.toContain(root);
    runtime.close();
  });

  it("builds sanitized aggregate payloads without raw paths", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");
    await runtime.primeContext({ task: "Fix dashboard rendering in src/app.ts", sessionId: session.id, source: "codex" });
    const identity = ensureTelemetryIdentity(root);

    const payload = buildTelemetryPayload({
      runtime,
      installationId: identity.installationId!,
      repoSalt: identity.repoSalt!
    });

    expect(() => assertSafeTelemetryPayload(payload)).not.toThrow();
    expect(JSON.stringify(payload)).not.toContain("src/app.ts");
    expect(payload.fileSignals.hashedFileIds.length).toBeGreaterThan(0);
    expect(payload.impact.countersVersion).toBe(1);
    expect(payload.impact.events).toBeGreaterThan(0);

    runtime.close();
  });

  it("rejects unsafe telemetry strings and keeps file hashes salted", () => {
    const safeId = hashFileId({ repoSalt: "salt-a", filePath: "src/app.ts" });
    const differentSaltId = hashFileId({ repoSalt: "salt-b", filePath: "src/app.ts" });
    expect(safeId).not.toBe(differentSaltId);

    const payload = minimalPayload();
    expect(() => assertSafeTelemetryPayload(payload)).not.toThrow();
    expect(() => assertSafeTelemetryPayload({
      ...payload,
      repo: {
        ...payload.repo,
        languageMix: { "/Users/kevin/private.ts": 1 }
      }
    })).toThrow(/Unsafe telemetry/);
  });

  it("enables, queues, dry-runs, and flushes telemetry to a fake ingest endpoint", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");
    await runtime.primeContext({ task: "Update dashboard rendering", sessionId: session.id, source: "codex" });
    const received: unknown[] = [];
    const endpoint = await startIngestServer(received);
    const config = enableTelemetry({ rootPath: root, destination: "supabase", endpoint });
    const payload = buildTelemetryPayload({
      runtime,
      installationId: config.installationId!,
      repoSalt: config.repoSalt!
    });
    enqueueTelemetryPayload({ rootPath: root, payload });

    const dryRun = await flushTelemetryQueue({ rootPath: root, dryRun: true });
    expect(dryRun.attempted).toBe(1);
    expect(readTelemetryQueue(root)).toHaveLength(1);

    const flushed = await flushTelemetryQueue({ rootPath: root });
    expect(flushed.sent).toBe(1);
    expect(readTelemetryQueue(root)).toHaveLength(0);
    expect(received).toHaveLength(1);

    const disabled = disableTelemetry(root);
    expect(disabled.enabled).toBe(false);
    expect(getTelemetryStatus(root).enabled).toBe(false);

    runtime.close();
  });

  it("automatically flushes enabled telemetry to the configured endpoint", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");
    await runtime.primeContext({ task: "Update dashboard rendering", sessionId: session.id, source: "codex" });

    const received: unknown[] = [];
    const endpoint = await startIngestServer(received);
    enableTelemetry({ rootPath: root, destination: "supabase", endpoint });
    const flushed = await queueAndFlushTelemetrySnapshot({ rootPath: root, runtime, sessionId: session.id });
    expect(flushed?.sent).toBe(1);
    expect(readTelemetryQueue(root)).toHaveLength(0);
    expect(received).toHaveLength(1);

    runtime.close();
  });

  it("exports redacted diagnostics", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    await runtime.startTask("Update dashboard rendering");
    const identity = ensureTelemetryIdentity(root);
    const diagnostics = buildDiagnosticExport({
      runtime,
      rootPath: root,
      installationId: identity.installationId!,
      repoSalt: identity.repoSalt!
    });

    expect(diagnostics.root.redacted).toBe(true);
    expect(diagnostics.telemetry.queuePath).toBe("<redacted>/.kairn/telemetry-queue.jsonl");
    expect(JSON.stringify(diagnostics)).not.toContain(root);

    runtime.close();
  });

  it("redacts doctor paths from diagnostics and creates output directories", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    await runtime.startTask("Update dashboard rendering");
    const identity = ensureTelemetryIdentity(root);
    const previousCwd = process.cwd();
    let diagnostics: ReturnType<typeof buildDiagnosticExport>;
    try {
      process.chdir(root);
      diagnostics = buildDiagnosticExport({
        runtime,
        rootPath: ".",
        installationId: identity.installationId!,
        repoSalt: identity.repoSalt!,
        doctor: {
          rootPath: root,
          checks: [
            {
              id: "kairn_state",
              status: "ok",
              summary: `State path: ${path.join(root, ".kairn")}`,
              fix: `Check ${path.join(root, ".kairn", "config.json")}`
            }
          ]
        }
      });
    } finally {
      process.chdir(previousCwd);
    }
    const outputPath = path.join(root, "nested", "diagnostics.json");

    writeDiagnosticExport({ outPath: outputPath, exportData: diagnostics });

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(root);
    expect(serialized).toContain("<redacted-root>");
    expect(fs.existsSync(outputPath)).toBe(true);

    runtime.close();
  });

  it("formats private beta telemetry summaries without raw repo details", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");
    await runtime.primeContext({ task: "Fix dashboard rendering in src/app.ts", sessionId: session.id, source: "codex" });
    const identity = ensureTelemetryIdentity(root);

    const summary = buildPrivateBetaTelemetrySummary({
      runtime,
      installationId: identity.installationId!,
      repoSalt: identity.repoSalt!,
      sessionId: session.id
    });
    const markdown = formatPrivateBetaTelemetrySummary(summary);

    expect(markdown).toContain("Private Beta Telemetry Summary");
    expect(markdown).not.toContain(root);
    expect(markdown).not.toContain("src/app.ts");

    runtime.close();
  });

  it("does not report silent-only sessions as active beta savings", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    await runtime.startTask("Document current behavior");

    const report = buildBetaReport({ runtime });

    expect(report.status.helped).toBe(0);
    expect(report.status.silent).toBeGreaterThan(0);
    expect(report.tokens.activeEstimatedSaved).toBe(0);
    expect(report.verdict).not.toBe("beta_positive");
    expect(report.summary.join(" ")).toContain("passive evidence");

    runtime.close();
  });

  it("puts quality-gated percentage savings and recommendation follow-through in the report", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Fix dashboard rendering");
    await runtime.primeContext({ task: "Fix dashboard rendering", sessionId: session.id, source: "codex" });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Recommended dashboard source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "agent_file_touched",
      filePath: "src/app.ts",
      source: "agent",
      summary: "Agent modified dashboard source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "verification_passed",
      source: "bench",
      summary: "Verification passed"
    });

    const report = buildBetaReport({ runtime, sessionId: session.id });

    expect(report.schemaVersion).toBe(2);
    expect(report.headline.basis).toBe("quality_gated_estimate");
    expect(report.headline.estimatedContextSavingsRate).toBe(report.tokens.qualityGatedEstimatedSavingsRate);
    expect(report.quality.sessionsPassingVerification).toBe(1);
    expect(report.quality.recommendationsLaterTouched).toBeGreaterThan(0);
    expect(report.quality.recommendationTouchRate).toBeGreaterThan(0);

    runtime.close();
  });

  it("defaults user reports to the latest twelve sessions", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    for (let index = 0; index < 15; index += 1) {
      await runtime.startTask(`Session ${index + 1}`);
    }

    const report = buildBetaReport({ runtime });

    expect(report.sessions).toBe(12);
    expect(report.window).toEqual({ requested: 12, sampled: 12, available: 15 });

    runtime.close();
  });
});

function minimalPayload(): TelemetryPayload {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-12T00:00:00.000Z",
    installationId: "kairn_test",
    kairnVersion: "0.1.0",
    repo: {
      fileCountBucket: "lt_250",
      stateSizeBucket: "lt_25mb",
      languageMix: { ".ts": 2 },
      extensionCounts: { ".ts": 2 },
      roleCounts: { source: 2 }
    },
    sessions: { count: 1, sampled: 1 },
    decisions: { emit: 0, shrink: 1, suppress: 1, requestEvidence: 0 },
    governor: { requestEvidence: 0, taskFrames: {}, fileRoles: {} },
    assistance: { active: 1, passiveSuppressed: 0, none: 0, validAssist: 0, overAssist: 0, missedOpportunity: 0, harmfulAssist: 0 },
    tokens: { estimatedBaseline: 100, estimatedOutput: 30, estimatedSaved: 70, activeEstimatedSaved: 70, passiveEstimatedSaved: 0 },
    impact: {
      countersVersion: 1,
      estimatedBaselineTokens: 100,
      estimatedOutputTokens: 30,
      estimatedActiveSavedTokens: 70,
      estimatedPassiveSavedTokens: 0,
      estimatedTotalSavedTokens: 70,
      repeatedFilesAvoided: 0,
      repeatedSnippetsAvoided: 0,
      quietDecisions: 1,
      evidenceRequests: 0,
      usefulMcpCalls: 0,
      hookInvocations: 1,
      hookFailures: 0,
      scopeViolations: 0,
      overAssistEvents: 0,
      missedOpportunityEvents: 0,
      harmfulAssistEvents: 0,
      sessions: 1,
      events: 1
    },
    hooks: { invocations: 1, failures: 0, daemonHits: 0, daemonMisses: 0 },
    mcp: { calls: 0, returnedSourceFiles: 0, returnedTestFiles: 0, returnedNoiseFiles: 0 },
    ledger: { events: 1, repeatedFilesAvoided: 0, repeatedSnippetsAvoided: 0, unresolvedFailures: 0 },
    quality: { benchmarkPasses: 0, benchmarkFailures: 0 },
    scope: { decisions: 0, violations: 0, failedDiscipline: 0, testEdits: 0, expansions: 0 },
    fileSignals: { hashedFileIds: ["abc123"] }
  };
}

async function startIngestServer(received: unknown[]): Promise<string> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    request.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address");
  return `http://127.0.0.1:${address.port}/ingest`;
}
