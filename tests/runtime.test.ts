import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

  it("uses an ultra-minimal one-file guardrail for high-confidence session source fixes", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Debug formatUser. formatUser should trim whitespace before rendering. Fix the production source and do not edit unrelated files.",
      budget: 900
    });

    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.contextDecision?.recommendedDelivery).toBe("one_file_directive");
    expect(prime.files).toEqual(["src/user.ts"]);
    expect(prime.content).toContain("# Kairn Fix Guardrail");
    expect(prime.content).toContain("Do not edit tests, snapshots, docs, examples, generated files, or sibling source files");
    expect(prime.content).not.toContain("Focused context:");
    expect(estimateTokens(prime.content)).toBeLessThan(360);

    runtime.close();
  });

  it("allows a three-file directive when selected failing tests imply three production counterparts", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "qutebrowser/components"), { recursive: true });
    fs.mkdirSync(path.join(root, "qutebrowser/config"), { recursive: true });
    fs.mkdirSync(path.join(root, "qutebrowser/utils"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests/unit/components"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests/unit/config"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests/unit/utils"), { recursive: true });
    fs.writeFileSync(path.join(root, "qutebrowser/components/hostblock.py"), "class HostBlocker:\n    def _is_blocked(self, request_url):\n        return request_url.host() in self._blocked_hosts\n");
    fs.writeFileSync(path.join(root, "qutebrowser/config/configutils.py"), "def _widened_hostnames(hostname):\n    while hostname:\n        yield hostname\n        hostname = hostname.partition('.')[2]\n");
    fs.writeFileSync(path.join(root, "qutebrowser/utils/urlutils.py"), "def widened_hostnames(hostname):\n    while hostname:\n        yield hostname\n        hostname = hostname.partition('.')[2]\n");
    fs.writeFileSync(path.join(root, "tests/unit/components/test_hostblock.py"), "def test_hostblock(): pass\n");
    fs.writeFileSync(path.join(root, "tests/unit/config/test_configutils.py"), "def test_configutils(): pass\n");
    fs.writeFileSync(path.join(root, "tests/unit/utils/test_urlutils.py"), "def test_urlutils(): pass\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Fix host blocking for subdomains in production source.",
          "Selected tests from SWE-Bench Pro metadata: tests/unit/components/test_hostblock.py, tests/unit/utils/test_urlutils.py, tests/unit/config/test_configutils.py",
          "Interface notes: widened_hostnames(hostname: str) -> Iterable[str]. Do not edit tests."
        ].join("\n"),
        budget: 1200
      });

      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.files).toEqual(
        expect.arrayContaining([
          "qutebrowser/components/hostblock.py",
          "qutebrowser/config/configutils.py",
          "qutebrowser/utils/urlutils.py"
        ])
      );
      expect(prime.editScope?.initialEditFiles).toEqual(
        expect.arrayContaining([
          "qutebrowser/components/hostblock.py",
          "qutebrowser/config/configutils.py",
          "qutebrowser/utils/urlutils.py"
        ])
      );
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("invalidates freshness when an already-dirty path changes again", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    await runtime.init();
    expect(runtime.getIndexStatus().freshness?.stale).toBe(false);

    const sourcePath = path.join(root, "src/app.ts");
    const statusBefore = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8"
    });
    const sourceBefore = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(sourcePath, sourceBefore.replace("changed = true", "changed = null"));
    const statusAfter = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8"
    });

    expect(statusAfter).toBe(statusBefore);
    expect(runtime.getIndexStatus().freshness).toEqual(expect.objectContaining({
      stale: true,
      reason: "dirty_state_changed"
    }));

    await runtime.refreshIndexNow();
    expect(runtime.getIndexStatus().freshness?.stale).toBe(false);
    fs.writeFileSync(sourcePath, sourceBefore.replace("changed = true", "changed = void"));
    expect(runtime.getIndexStatus().freshness).toEqual(expect.objectContaining({
      stale: true,
      reason: "dirty_state_changed"
    }));

    runtime.close();
  });

  it("tracks bounded filesystem freshness outside a Git worktree", async () => {
    const root = createFixtureRepo();
    fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
    const runtime = new KairnRuntime(root);

    try {
      await runtime.init();
      expect(runtime.getIndexStatus().freshness).toEqual(expect.objectContaining({
        stale: false,
        reason: "fresh"
      }));

      const sourcePath = path.join(root, "src/app.ts");
      fs.writeFileSync(sourcePath, `${fs.readFileSync(sourcePath, "utf8")}export const nongitChange = true;\n`);
      expect(runtime.getIndexStatus().freshness).toEqual(expect.objectContaining({
        stale: true,
        reason: "dirty_state_changed"
      }));

      await runtime.refreshIndexNow();
      expect(runtime.getIndexStatus().freshness?.stale).toBe(false);
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades a fresh inventory-stage index on the next normal prime", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    try {
      await runtime.initInventory();
      const inventoryStatus = runtime.getIndexStatus();
      expect(inventoryStatus.freshness?.stale).toBe(false);
      expect(inventoryStatus.symbolCount).toBe(0);

      await runtime.primeContext({
        task: "Update the formatUser production function",
        budget: 600
      });

      const fullStatus = runtime.getIndexStatus();
      expect(fullStatus.freshness?.stale).toBe(false);
      expect(fullStatus.symbolCount).toBeGreaterThan(0);
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    expect(verifiedSummary.verificationPasses).toBe(1);
    expect(verifiedSummary.verificationFailures).toBe(0);
    expect(verifiedSummary.latestVerification).toBe("passed");
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

  it("keeps the active session source ahead of fresh one-file production candidates", async () => {
    const root = createFixtureRepo();
    execFileSync("git", ["checkout", "--", "src/app.ts"], { cwd: root, stdio: "ignore" });
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate formatUser whitespace fallback");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Known source invariant",
      metadata: {
        invariant: {
          statement: "formatUser must trim whitespace",
          confidence: 0.9
        }
      }
    });

    const prime = await runtime.primeContext({
      task: "Fix the src/app.ts dashboard formatting regression in the production source.",
      sessionId: session.id,
      budget: 500,
      source: "bench"
    });
    const sessionPolicy = prime.metadata?.sessionPolicy as { reason?: string; files?: string[] } | undefined;

    expect(sessionPolicy?.reason).toBe("active_source_context_shrunk");
    expect(sessionPolicy?.files).toEqual(["src/user.ts"]);
    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.files).toEqual(["src/user.ts"]);
    expect(prime.content).toContain("src/user.ts");
    expect(prime.content).not.toContain("Start file:\n- src/app.ts");

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

  it("emits a scope-drift guardrail instead of suppressing cleanup context", async () => {
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
      kind: "edit_scope_changed",
      source: "runtime",
      summary: "Initial edit scope: src/app.ts",
      metadata: {
        editScope: {
          initialEditFiles: ["src/app.ts"],
          readOnlyFiles: [],
          forbiddenEditPatterns: ["tests/"],
          scopeConfidence: "high",
          scopeSource: "exact_source"
        }
      }
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "verification_passed",
      filePath: "src/app.ts",
      source: "bench",
      summary: "Dashboard verification passed."
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "agent_file_touched",
      filePath: "src/user.ts",
      source: "agent",
      summary: "Agent touched unexpected source."
    });

    const cleanup = await runtime.primeContext({
      task: "Review the final diff and confirm only src/app.ts changed.",
      sessionId: session.id,
      budget: 500,
      source: "codex"
    });
    const cleanupPolicy = cleanup.metadata?.sessionPolicy as { phase?: string; reason?: string; metadata?: Record<string, unknown> } | undefined;

    expect(cleanupPolicy?.phase).toBe("cleanup");
    expect(cleanupPolicy?.reason).toBe("scope_drift_repair");
    expect(cleanup.contextDecision?.action).toBe("shrink");
    expect(cleanup.files).toContain("src/user.ts");
    expect(cleanup.content).toContain("Kairn Scope Drift Guardrail");
    expect(cleanup.content).toContain("Expected edit scope:");
    expect(cleanup.content).toContain("src/app.ts");
    expect(cleanup.content).toContain("Unexpected changed/touched files:");
    expect(cleanup.content).toContain("src/user.ts");

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
