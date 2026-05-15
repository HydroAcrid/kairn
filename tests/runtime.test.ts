import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionWorkingSet } from "../src/ledger/workingSet.js";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import type { SessionLedgerEvent } from "../src/types.js";
import { estimateTokens } from "../src/utils/tokens.js";
import { createFixtureRepo } from "./helpers.js";

describe("KairnRuntime", () => {
  it("initializes state and starts a task session", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const init = await runtime.init();
    const started = await runtime.startTask("Update dashboard rendering");

    expect(init.scan.files.length).toBeGreaterThan(0);
    expect(started.session.id).toMatch(/^task_/);
    expect(started.response.files).toContain("src/app.ts");

    runtime.close();
  });

  it("records and summarizes durable session ledger events", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Recommended app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "agent_file_touched",
      filePath: "src/app.ts",
      source: "agent",
      summary: "Agent touched app source"
    });

    const events = runtime.getSessionLedger(session.id);
    const summary = runtime.summarizeSessionLedger(session.id);

    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["context_recommended", "agent_file_touched"]));
    expect(summary.recommendedFilesUsed).toContain("src/app.ts");
    expect(summary.currentPhase).toBe("implementation");
    expect(summary.workingSet.activeFiles).toContain("src/app.ts");
    expect(summary.workingSet.recentlyTouchedFiles).toContain("src/app.ts");

    runtime.close();
  });

  it("suppresses duplicate automatic prime context in the same session", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update job tracker mobile layout");

    const first = await runtime.primeContext({
      task: "Update job tracker mobile layout",
      sessionId: session.id,
      budget: 700
    });
    const second = await runtime.primeContext({
      task: "Update job tracker mobile layout",
      sessionId: session.id,
      budget: 700
    });
    const ledger = runtime.summarizeSessionLedger(session.id);

    expect(first.files.length).toBeGreaterThan(0);
    expect(second.contextDecision?.action).toBe("suppress");
    expect(ledger.repeatedFilesAvoided).toBeGreaterThanOrEqual(1);
    expect(ledger.workingSet.shownFiles.length).toBeGreaterThan(0);

    runtime.close();
  });

  it("requests runtime evidence before expensive source retrieval for procedural QnA", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Run the dashboard import command twice and tell me what log output appears.",
      budget: 900
    });

    expect(prime.contextDecision?.action).toBe("request_evidence");
    expect(prime.contextDecision?.taskFrame).toBe("runtime_procedural");
    expect(prime.contextDecision?.evidenceRequest?.kind).toBe("runtime_scope");
    expect(prime.files).toEqual([]);
    expect(prime.timings?.findContextMs).toBeUndefined();
    expect(prime.content).toContain("Kairn Needs One More Signal");

    runtime.close();
  });

  it("keeps a tiny edit-scope guardrail for automatic production-source-only tasks", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Debug the greeting helper. Names with whitespace should be trimmed before rendering. Fix the production source and do not edit unrelated files.",
      budget: 900,
      source: "codex"
    });

    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.contextDecision?.recommendedDelivery).toBe("one_file_directive");
    expect(prime.content).toContain("Edit scope");
    expect(prime.content).toContain("Initial edit scope");
    expect(prime.files.length).toBeGreaterThanOrEqual(1);

    runtime.close();
  });

  it("tracks index freshness across repo changes and refreshes", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    await runtime.init();
    expect(runtime.getIndexStatus().freshness?.stale).toBe(false);

    fs.writeFileSync(path.join(root, "src/new-source.ts"), "export const newSource = true;\n");
    const stale = runtime.getIndexStatus().freshness;
    expect(stale?.stale).toBe(true);
    expect(stale?.reason).toBe("dirty_state_changed");

    const refreshed = await runtime.refreshIndexNow();
    expect(refreshed.freshness?.stale).toBe(false);

    runtime.close();
  });

  it("builds a working-set next read from ignored recommendations", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Recommended app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Showed app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Recommended user formatting source"
    });

    const summary = runtime.summarizeSessionLedger(session.id);

    expect(summary.workingSet.ignoredRecommendedFiles).toContain("src/user.ts");
    expect(summary.workingSet.nextSmallestUsefulRead?.filePath).toBe("src/user.ts");
    expect(summary.workingSet.nextSmallestUsefulRead?.source).toBe("ignored_recommendation");

    runtime.close();
  });

  it("does not suggest ignored recommendations after suppress-only context or passing verification", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Recommended user formatting source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      source: "runtime",
      summary: "Kairn suppressed low-value context",
      metadata: { policyReason: "repeated_context_suppressed" }
    });

    const suppressedSummary = runtime.summarizeSessionLedger(session.id);
    expect(suppressedSummary.workingSet.ignoredRecommendedFiles).toContain("src/user.ts");
    expect(suppressedSummary.workingSet.nextSmallestUsefulRead).toBeUndefined();

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Showed app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "verification_passed",
      source: "bench",
      summary: "Final verification passed."
    });

    const verifiedSummary = runtime.summarizeSessionLedger(session.id);
    expect(verifiedSummary.workingSet.nextSmallestUsefulRead).toBeUndefined();
    expect(verifiedSummary.workingSet.openRisks).not.toEqual(
      expect.arrayContaining([expect.stringContaining("recommended file")])
    );

    runtime.close();
  });

  it("clears changed-file stale risk after a later passing verification", () => {
    const events: SessionLedgerEvent[] = [
      ledgerEvent("context_shown", "src/app.ts", "2026-05-12T10:00:00.000Z"),
      ledgerEvent("agent_file_touched", "src/app.ts", "2026-05-12T10:01:00.000Z")
    ];
    const stale = buildSessionWorkingSet({ sessionId: "task_test", events, currentPhase: "implementation" });

    expect(stale.staleFiles).toContain("src/app.ts");
    expect(stale.nextSmallestUsefulRead?.source).toBe("changed_file");

    const verified = buildSessionWorkingSet({
      sessionId: "task_test",
      events: [
        ...events,
        ledgerEvent("verification_passed", "src/app.ts", "2026-05-12T10:02:00.000Z")
      ],
      currentPhase: "verification"
    });

    expect(verified.staleFiles).not.toContain("src/app.ts");
    expect(verified.nextSmallestUsefulRead?.source).not.toBe("changed_file");
    expect(verified.openRisks).not.toEqual(expect.arrayContaining([expect.stringContaining("changed after being shown")]));
  });

  it("shrinks post-diagnose context to the active source instead of resurfacing companions", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Earlier companion context"
    });

    const prime = await runtime.primeContext({
      task: "Fix the dashboard formatting regression in the production source.",
      sessionId: session.id,
      budget: 500,
      source: "bench"
    });
    const sessionPolicy = prime.metadata?.sessionPolicy as { reason?: string } | undefined;

    expect(sessionPolicy?.reason).toBe("active_source_context_shrunk");
    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.files).toEqual(["src/app.ts"]);
    expect(prime.content).toContain("src/app.ts");
    expect(prime.content).not.toContain("src/user.ts");
    expect(prime.content).toContain("Kairn Fix Guardrail");
    expect(prime.content).not.toContain("Quality score");

    runtime.close();
  });

  it("suppresses automatic verification and cleanup context after a passing check", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Earlier focused source context"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "verification_passed",
      filePath: "src/app.ts",
      source: "bench",
      summary: "Dashboard verification passed."
    });

    const prime = await runtime.primeContext({
      task: "Verify the src/app.ts dashboard rendering fix after the passing check.",
      sessionId: session.id,
      budget: 500,
      source: "codex"
    });
    const sessionPolicy = prime.metadata?.sessionPolicy as { reason?: string } | undefined;

    expect(sessionPolicy?.reason).toBe("verified_context_suppressed");
    expect(prime.contextDecision?.action).toBe("suppress");
    expect(prime.files).toEqual([]);

    const cleanup = await runtime.primeContext({
      task: "Review the final diff and confirm only src/app.ts changed.",
      sessionId: session.id,
      budget: 500,
      source: "codex"
    });
    const cleanupPolicy = cleanup.metadata?.sessionPolicy as { phase?: string; reason?: string } | undefined;

    expect(cleanupPolicy?.phase).toBe("cleanup");
    expect(cleanupPolicy?.reason).toBe("verified_context_suppressed");
    expect(cleanup.contextDecision?.action).toBe("suppress");

    runtime.close();
  });

  it("reads files, symbols, related files, tests, diff, and compressed output", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");

    const file = await runtime.readFile({ sessionId: session.id, target: "src/app.ts" });
    const symbol = await runtime.readSymbol({
      sessionId: session.id,
      target: "src/app.ts",
      symbol: "renderDashboard"
    });
    const related = await runtime.getRelatedFiles({ sessionId: session.id, target: "src/app.ts" });
    const tests = await runtime.findTests({ sessionId: session.id, target: "src/app.ts" });
    const symbolContext = await runtime.findContext({ sessionId: session.id, query: "DashboardMetrics" });
    const diff = await runtime.reviewDiff({ sessionId: session.id });
    const compressed = runtime.compressOutput({
      sessionId: session.id,
      type: "test",
      output: ["FAIL src/app.test.ts", "Expected true to be false", ...Array.from({ length: 800 }, (_, index) => `trace line ${index}`)].join("\n")
    });
    const metrics = runtime.getMetrics(session.id);

    expect(file.mode).toBe("exact_code");
    expect(symbol.symbols).toEqual(["renderDashboard"]);
    expect(related.related).toContain("src/user.ts");
    expect(related.content).toMatch(/imports target|imported by target|target imports file/);
    expect(tests.files).toContain("src/app.test.ts");
    expect(symbolContext.files).toContain("src/widgets.ts");
    expect(symbolContext.content).toContain("Response Mode");
    expect(symbolContext.content).toMatch(/semantic match|symbol match/);
    expect(diff.files).toContain("src/app.ts");
    expect(compressed.content).toContain("Expected true");
    expect(metrics.totals.events).toBeGreaterThanOrEqual(7);
    expect(metrics.totals.savedTokens).toBeGreaterThan(0);
    expect(metrics.byKind.compression?.savedTokens).toBeGreaterThan(0);

    runtime.close();
  });

  it("uses graph edges for parent route relationships", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard card");

    const related = await runtime.getRelatedFiles({
      sessionId: session.id,
      target: "app/dashboard/DashboardCard.tsx"
    });

    expect(related.related).toContain("app/dashboard/page.tsx");
    expect(related.content).toContain("parent route");

    runtime.close();
  });

  it("routes vague context queries to snippets when requested", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard card");

    const response = await runtime.findContext({
      sessionId: session.id,
      query: "metrics",
      mode: "snippets",
      budget: 800
    });

    expect(response.mode).toBe("snippets");
    expect(response.content).toContain("## Matched Snippets");
    expect(estimateTokens(response.content)).toBeLessThanOrEqual(800);

    runtime.close();
  });

  it("prioritizes job tracker UI files for mobile layout queries", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update job tracker mobile layout");

    const response = await runtime.findContext({
      sessionId: session.id,
      query: "job tracker mobile layout",
      mode: "snippets",
      budget: 1200
    });

    expect(response.files.slice(0, 3)).toEqual(
      expect.arrayContaining([
        "src/app/private/jobs/JobsApplicationsTable.tsx",
        "src/app/private/jobs/JobsDashboardTabs.tsx"
      ])
    );
    expect(response.content).toContain("Detected Intent: ui");
    const uiIndex = response.files.indexOf("src/app/private/jobs/JobsApplicationsTable.tsx");
    const parserIndex = response.files.indexOf("src/lib/jobs/parser.ts");
    expect(parserIndex === -1 || uiIndex < parserIndex).toBe(true);

    runtime.close();
  });

  it("suppresses low-value exact-path prime briefs", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Fix src/app.ts by checking renderDashboard",
      budget: 900
    });

    expect(prime.quality?.action).toBe("suppress");
    expect(prime.quality?.exactPathMentioned).toBe(true);
    expect(prime.content).toContain("Kairn Prime Suppressed");

    runtime.close();
  });

  it("builds failure-first context from failing test output", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Debug dashboard test failure");

    const context = await runtime.getFailureContext({
      sessionId: session.id,
      type: "test",
      command: "pnpm test",
      output: "FAIL src/app.test.ts\nsrc/app.test.ts:4:10 Expected true to be false"
    });

    expect(context.failureFiles).toContain("src/app.test.ts");
    expect(context.files).toContain("src/app.ts");
    expect(context.content).toContain("Kairn Failure Context");
    expect(context.content).toContain("Likely tests");

    runtime.close();
  });
});

function ledgerEvent(kind: SessionLedgerEvent["kind"], filePath: string, createdAt: string): SessionLedgerEvent {
  return {
    sessionId: "task_test",
    kind,
    filePath,
    contentHash: `${kind}:${filePath}:${createdAt}`,
    tokenEstimate: 1,
    source: "bench",
    summary: `${kind} ${filePath}`,
    metadata: {},
    createdAt
  };
}
