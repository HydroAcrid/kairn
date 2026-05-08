import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { createDefaultBenchmarkSuite, loadBenchmarkSuite } from "../src/bench/suite.js";
import { buildBenchmarkReport, compareBenchmarkReports, scoreBenchmarkCase } from "../src/bench/score.js";
import { createFixtureRepo } from "./helpers.js";

const CLI = ["tsx", "src/cli.ts"];

describe("benchmark suite and scoring", () => {
  it("builds an adaptive default suite from inventory-like files", () => {
    const suite = createDefaultBenchmarkSuite([
      record("src/app/private/jobs/JobsApplicationsTable.tsx", "component"),
      record("src/app/private/jobs/JobsDashboardTabs.tsx", "component"),
      record("src/lib/jobs/parser.ts", "source"),
      record("src/lib/jobs/repository.ts", "source"),
      record("src/app.test.ts", "test")
    ]);

    expect(suite.id).toBe("default");
    expect(suite.cases.some((item) => item.id === "ui-layout-context")).toBe(true);
    expect(suite.cases.find((item) => item.id === "ui-layout-context")?.expectedFiles).toContain(
      "src/app/private/jobs/JobsApplicationsTable.tsx"
    );
    expect(suite.cases.find((item) => item.id === "diff-review")?.expectedFiles).toEqual([]);
  });

  it("loads the focused job-tracker benchmark suite example", () => {
    const suite = loadBenchmarkSuite({
      suitePath: path.resolve("examples/bench/job-tracker-focused.json"),
      files: []
    });

    expect(suite.id).toBe("job-tracker-focused");
    expect(suite.cases.find((item) => item.id === "sync-review-queue")?.expectedFiles).toEqual(
      expect.arrayContaining([
        "src/app/private/jobs/JobsReviewPanel.tsx",
        "src/app/api/jobs/sync-attempts/route.ts",
        "src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts"
      ])
    );
  });

  it("loads the light job-tracker live-agent suite example", () => {
    const suite = loadBenchmarkSuite({
      suitePath: path.resolve("examples/bench/job-tracker-agent-light.json"),
      files: []
    });

    expect(suite.id).toBe("job-tracker-agent-light");
    expect(suite.cases).toHaveLength(3);
    expect(suite.cases.every((item) => item.mode === "agent")).toBe(true);
  });

  it("loads seeded agent benchmark case metadata", () => {
    const root = createFixtureRepo();
    const patchPath = path.join(root, "seed.patch");
    const suitePath = path.join(root, "seed-suite.json");
    fs.writeFileSync(patchPath, "");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "seed-suite",
        name: "Seed Suite",
        cases: [
          {
            id: "seeded-debug",
            mode: "agent",
            task: "Debug seeded failure",
            expectedFiles: ["src/app.ts"],
            excludedFiles: [],
            seed: {
              repoUrl: root,
              ref: "HEAD",
              cloneDepth: 1,
              setupCommands: ["node -e \"process.exit(0)\""],
              setupPatchFile: "./seed.patch",
              expectedFailureCommand: "node -e \"process.exit(1)\"",
              testCommand: "node -e \"process.exit(0)\""
            }
          }
        ]
      })
    );

    const suite = loadBenchmarkSuite({ suitePath, files: [] });
    const seed = suite.cases[0]?.seed;

    expect(seed?.repoUrl).toBe(root);
    expect(seed?.ref).toBe("HEAD");
    expect(seed?.setupPatchFile).toBe(patchPath);
    expect(seed?.testCommand).toContain("process.exit(0)");
  });

  it("loads the seeded cross-language proof suite example", () => {
    const suite = loadBenchmarkSuite({
      suitePath: path.resolve("examples/bench/seeded-cross-language.json"),
      files: []
    });

    expect(suite.id).toBe("seeded-cross-language");
    expect(suite.cases.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "typescript-tanstack-hidden-hash",
        "python-click-term-len-ansi",
        "java-commons-lang-isblank",
        "cpp-fmt-starts-with"
      ])
    );
    expect(suite.cases.find((item) => item.id === "python-click-term-len-ansi")?.expectedFiles).toContain(
      "src/click/_compat.py"
    );
    expect(suite.cases.find((item) => item.id === "java-commons-lang-isblank")?.seed?.setupPatchFile).toMatch(
      /commons-lang-isblank-whitespace\.patch$/
    );
  });

  it("scores expected file recall, unexpected drift, and comparisons", () => {
    const before = scoreBenchmarkCase({
      runId: "bench_before",
      benchmarkCase: {
        id: "ui",
        mode: "context",
        task: "Find UI",
        expectedFiles: ["src/ui.tsx"],
        excludedFiles: ["src/parser.ts"]
      },
      actualFiles: ["src/parser.ts"],
      responseTokens: 200,
      summary: "missed"
    });
    const after = scoreBenchmarkCase({
      runId: "bench_after",
      benchmarkCase: {
        id: "ui",
        mode: "context",
        task: "Find UI",
        expectedFiles: ["src/ui.tsx"],
        excludedFiles: ["src/parser.ts"]
      },
      actualFiles: ["src/ui.tsx"],
      responseTokens: 200,
      summary: "hit"
    });
    const comparison = compareBenchmarkReports(
      {
        run: {
          id: "bench_before",
          rootPath: "/repo",
          suiteId: "default",
          suiteName: "default",
          mode: "replay",
          status: "completed",
          startedAt: "now",
          metadata: {}
        },
        results: [{ ...before, id: 1, createdAt: "now" }],
        overallScore: before.score,
        weakestCases: [{ ...before, id: 1, createdAt: "now" }],
        recommendations: before.recommendations
      },
      {
        run: {
          id: "bench_after",
          rootPath: "/repo",
          suiteId: "default",
          suiteName: "default",
          mode: "replay",
          status: "completed",
          startedAt: "now",
          metadata: {}
        },
        results: [{ ...after, id: 2, createdAt: "now" }],
        overallScore: after.score,
        weakestCases: [{ ...after, id: 2, createdAt: "now" }],
        recommendations: after.recommendations
      }
    );

    expect(before.expectedFileRecall).toBe(0);
    expect(before.unexpectedFileRate).toBe(1);
    expect(after.expectedFileRecall).toBe(1);
    expect(comparison.improvedCases).toContain("ui");
  });

  it("scores excluded directory and glob patterns as unexpected drift", () => {
    const result = scoreBenchmarkCase({
      runId: "bench",
      benchmarkCase: {
        id: "seeded",
        mode: "agent",
        task: "Debug seeded failure",
        expectedFiles: ["src/core.ts"],
        excludedFiles: ["docs/", "examples/*.tsx"]
      },
      actualFiles: ["src/core.ts", "docs/guide.md", "examples/demo.tsx"],
      responseTokens: 200,
      summary: "mixed"
    });

    expect(result.expectedFileRecall).toBe(1);
    expect(result.unexpectedFileRate).toBe(0.6667);
    expect(result.recommendations.join("\n")).toContain("docs/guide.md");
  });

  it("aggregates observed Codex token usage in benchmark comparisons", () => {
    const benchmarkCase = {
      id: "agent",
      mode: "agent" as const,
      task: "Run an agent",
      expectedFiles: [],
      excludedFiles: []
    };
    const beforeResult = scoreBenchmarkCase({
      runId: "bench_before",
      benchmarkCase,
      actualFiles: [],
      responseTokens: 20,
      observedCodexTokens: 2000,
      summary: "baseline"
    });
    const afterResult = scoreBenchmarkCase({
      runId: "bench_after",
      benchmarkCase,
      actualFiles: [],
      responseTokens: 20,
      observedCodexTokens: 1200,
      summary: "kairn"
    });
    const before = buildBenchmarkReport({
      run: {
        id: "bench_before",
        rootPath: "/repo",
        suiteId: "default",
        suiteName: "default",
        mode: "agent",
        status: "completed",
        startedAt: "now",
        metadata: {}
      },
      results: [{ ...beforeResult, id: 1, createdAt: "now" }]
    });
    const after = buildBenchmarkReport({
      run: {
        id: "bench_after",
        rootPath: "/repo",
        suiteId: "default",
        suiteName: "default",
        mode: "agent",
        status: "completed",
        startedAt: "now",
        metadata: {}
      },
      results: [{ ...afterResult, id: 2, createdAt: "now" }]
    });

    const comparison = compareBenchmarkReports(before, after);

    expect(before.observed?.codexTokens).toBe(2000);
    expect(after.observed?.codexTokens).toBe(1200);
    expect(comparison.observedTokenDelta).toEqual({
      beforeTokens: 2000,
      afterTokens: 1200,
      savedTokens: 800,
      savingsRate: 0.4
    });
  });
});

describe("benchmark runtime and CLI", () => {
  it("generates proactive prime context and records prime metrics", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "job tracker mobile layout bottom sheet",
      budget: 1200
    });
    const metrics = runtime.getMetrics(prime.session.id);

    expect(prime.content).toContain("Kairn Proactive Context");
    expect(prime.content).toContain("broad repository scans");
    expect(prime.content).not.toContain(root);
    expect(prime.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
    expect(prime.tokenEstimate).toBeLessThanOrEqual(1200);
    expect(metrics.byKind.prime_context?.events).toBe(1);

    runtime.close();
  });

  it("selects compact prime profiles and default budgets by intent", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const uiPrime = await runtime.primeContext({
      task: "job tracker mobile layout bottom sheet"
    });
    const backendPrime = await runtime.primeContext({
      task: "gmail parser rental application persist parsed job events"
    });

    expect(uiPrime.profile).toBe("ui");
    expect(uiPrime.tokenEstimate).toBeLessThanOrEqual(700);
    expect(uiPrime.content).not.toContain("## More Context");
    expect(backendPrime.profile).toBe("backend");
    expect(backendPrime.tokenEstimate).toBeLessThanOrEqual(1100);
    expect(backendPrime.content).toContain("## More Context");

    runtime.close();
  });

  it("generates parser/backend prime context for Gmail parsing tasks", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "gmail parser rental application persist parsed job events",
      budget: 1200
    });

    expect(prime.files).toEqual(expect.arrayContaining(["src/lib/jobs/parser.ts", "src/lib/jobs/repository.ts"]));
    expect(prime.content).not.toContain("node_modules");

    runtime.close();
  });

  it("supports prime CLI JSON output", () => {
    const root = createFixtureRepo();
    const prime = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "prime", "job tracker mobile layout", "--root", root, "--budget", "1200", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { content: string; tokenEstimate: number; files: string[] };

    expect(prime.content).toContain("Kairn Proactive Context");
    expect(prime.tokenEstimate).toBeLessThanOrEqual(1200);
    expect(prime.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
  });

  it("runs replay benchmarks and reports results", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({ mode: "replay" });
    const fetched = runtime.getBenchmarkReport({ runId: report.run.id });

    expect(report.run.id).toMatch(/^bench_/);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.some((result) => result.caseId === "ui-layout-context")).toBe(true);
    expect("run" in fetched && fetched.overallScore).toBeGreaterThanOrEqual(0);

    runtime.close();
  });

  it("runs agent-mode benchmarks with a fake command in a disposable workspace", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({
      mode: "agent",
      agentCommand: "printf 'agent ok'"
    });

    expect(report.results.length).toBe(1);
    expect(report.results[0]?.caseMode).toBe("agent");
    expect(report.results[0]?.taskOutcome).toBe("pass");
    expect(String(report.results[0]?.metadata.workspacePath)).toContain("kairn-bench-agent-");

    runtime.close();
  });

  it("scores expected files mentioned by read-only agent output", async () => {
    const root = createFixtureRepo();
    const suitePath = path.join(root, "mentions-suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "mentions",
        name: "Mentions",
        cases: [
          {
            id: "mentions-app",
            mode: "agent",
            task: "Find app file",
            agentPrompt: "Find app file",
            expectedFiles: ["src/app.ts"],
            excludedFiles: [],
            budget: 1200
          }
        ]
      })
    );
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({
      suitePath,
      mode: "agent",
      agentCommand: "printf 'primary file: src/app.ts'"
    });

    expect(report.results[0]?.actualFiles).toContain("src/app.ts");
    expect(report.results[0]?.expectedFileRecall).toBe(1);
    expect(report.results[0]?.metadata.expectedFileMentions).toEqual(["src/app.ts"]);

    runtime.close();
  });

  it("runs seeded agent benchmarks in a disposable cloned workspace and verifies test command", async () => {
    const root = createFixtureRepo();
    const suitePath = path.join(root, "seeded-agent-suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "seeded-agent",
        name: "Seeded Agent",
        cases: [
          {
            id: "seeded-debug",
            mode: "agent",
            task: "Debug seeded failure",
            agentPrompt: "Debug seeded failure",
            expectedFiles: ["src/app.ts"],
            excludedFiles: [],
            budget: 1200,
            seed: {
              repoUrl: root,
              ref: "HEAD",
              cloneDepth: 1,
              setupCommands: ["node -e \"require('fs').writeFileSync('seed-setup.txt','ok')\""],
              expectedFailureCommand: "node -e \"process.exit(1)\"",
              testCommand: "node -e \"const fs=require('fs'); process.exit(fs.existsSync('src/app.ts') && fs.existsSync('seed-setup.txt') ? 0 : 1)\""
            }
          }
        ]
      })
    );
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({
      suitePath,
      mode: "agent",
      agentCommand: "printf 'inspected src/app.ts\\nToken usage: total=1,111 input=1,000 output=111'"
    });

    expect(report.results[0]?.taskOutcome).toBe("pass");
    expect(report.results[0]?.actualFiles).toContain("src/app.ts");
    expect(report.results[0]?.observedCodexTokens).toBe(1111);
    expect(report.results[0]?.metadata.seedConfigured).toBe(true);
    expect(report.results[0]?.metadata.seedSetupCommandCount).toBe(1);
    expect(report.results[0]?.metadata.seedExpectedFailurePassed).toBe(true);
    expect(report.results[0]?.metadata.seedTestExitCode).toBe(0);
    expect(String(report.results[0]?.metadata.workspacePath)).toContain("kairn-bench-seed-");

    runtime.close();
  });

  it("marks seeded agent runs failed when verification command fails", async () => {
    const root = createFixtureRepo();
    const suitePath = path.join(root, "seeded-failing-suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "seeded-failing",
        name: "Seeded Failing",
        cases: [
          {
            id: "seeded-debug",
            mode: "agent",
            task: "Debug seeded failure",
            expectedFiles: [],
            excludedFiles: [],
            seed: {
              repoUrl: root,
              ref: "HEAD",
              cloneDepth: 1,
              testCommand: "node -e \"process.exit(2)\""
            }
          }
        ]
      })
    );
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({
      suitePath,
      mode: "agent",
      agentCommand: "printf 'agent says done'"
    });

    expect(report.results[0]?.taskOutcome).toBe("fail");
    expect(report.results[0]?.summary).toContain("seeded verification failed");
    expect(report.results[0]?.metadata.seedTestExitCode).toBe(2);

    runtime.close();
  });

  it("parses Codex token footers from live-agent benchmark output", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({
      mode: "agent",
      agentCommand: "printf 'Token usage: total=1,500 input=1,200 (+ 300 cached) output=300'"
    });

    expect(report.observed).toEqual({
      codexTokens: 1500,
      codexCaseCount: 1
    });
    expect(report.results[0]?.observedCodexTokens).toBe(1500);
    expect(report.results[0]?.metadata.codexUsage).toMatchObject({
      totalTokens: 1500,
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 300,
      source: "footer"
    });

    runtime.close();
  });

  it("parses Codex token footers from failed live-agent benchmark output", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({
      mode: "agent",
      agentCommand: "printf 'Token usage: total=900 input=800 output=100'; exit 2"
    });

    expect(report.results[0]?.taskOutcome).toBe("fail");
    expect(report.results[0]?.observedCodexTokens).toBe(900);

    runtime.close();
  });

  it("captures Codex stderr footers and hook markers from live-agent benchmark output", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const report = await runtime.runBenchmark({
      mode: "agent",
      agentCommand: "printf 'hook: PostToolUse Completed\\ntokens used\\n1,234\\n' >&2"
    });

    expect(report.results[0]?.observedCodexTokens).toBe(1234);
    expect(report.results[0]?.metadata.hookCompleted).toBe(1);

    runtime.close();
  });

  it("supports bench run, report, compare, and export CLI commands", () => {
    const root = createFixtureRepo();
    const first = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "bench", "run", "--root", root, "--mode", "replay", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { run: { id: string }; overallScore: number };
    const second = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "bench", "run", "--root", root, "--mode", "replay", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { run: { id: string }; overallScore: number };
    const report = execFileSync(CLI[0]!, [...CLI.slice(1), "bench", "report", "--root", root, "--run", first.run.id], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const comparison = JSON.parse(
      execFileSync(
        CLI[0]!,
        [...CLI.slice(1), "bench", "compare", "--root", root, "--before", first.run.id, "--after", second.run.id, "--json"],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as { scoreDelta: number };
    const exported = execFileSync(CLI[0]!, [...CLI.slice(1), "bench", "export", "--root", root, "--run", first.run.id], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(first.overallScore).toBeGreaterThanOrEqual(0);
    expect(report).toContain("Kairn benchmark report");
    expect(comparison.scoreDelta).toBeDefined();
    expect(exported).toContain("# Kairn Benchmark Run");
  });

  it("supports bench ab CLI with observed Codex token deltas", () => {
    const root = createFixtureRepo();
    const comparison = JSON.parse(
      execFileSync(
        CLI[0]!,
        [
          ...CLI.slice(1),
          "bench",
          "ab",
          "--root",
          root,
          "--baseline-command",
          "printf 'Token usage: total=2,000 input=1,700 output=300'",
          "--kairn-command",
          "printf 'Token usage: total=1,250 input=1,000 (+ 100 cached) output=250'",
          "--json"
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as { observedTokenDelta?: { beforeTokens: number; afterTokens: number; savedTokens: number } };

    expect(comparison.observedTokenDelta).toMatchObject({
      beforeTokens: 2000,
      afterTokens: 1250,
      savedTokens: 750
    });
  });

  it("supports bench prove CLI and prepends proactive prime context", () => {
    const root = createFixtureRepo();
    const suitePath = path.join(root, "agent-suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "agent-one",
        name: "Agent One",
        cases: [
          {
            id: "agent-mobile",
            mode: "agent",
            task: "Find job tracker mobile layout files. Do not edit files.",
            agentPrompt: "Find job tracker mobile layout files. Do not edit files.",
            expectedFiles: [],
            excludedFiles: [],
            budget: 1200
          }
        ]
      })
    );
    const commandForTokens =
      "node -e \"const p=process.argv[1]||''; console.error('tokens used'); console.error(p.includes('Kairn Proactive Context') ? '1,000' : p.includes('kairn_prepare_task') ? '1,500' : '3,000')\" {prompt}";
    const proof = JSON.parse(
      execFileSync(
        CLI[0]!,
        [
          ...CLI.slice(1),
          "bench",
          "prove",
          "--root",
          root,
          "--suite",
          suitePath,
          "--baseline-command",
          commandForTokens,
          "--prompt-only-command",
          commandForTokens,
          "--manual-prime-command",
          commandForTokens,
          "--mcp-first-command",
          commandForTokens,
          "--real-mcp-first-command",
          commandForTokens,
          "--mcp-first-plus-hook-full-prime-command",
          commandForTokens,
          "--hybrid-mcp-brief-command",
          commandForTokens,
          "--repeat",
          "2",
          "--shuffle-order",
          "--json"
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as {
      observedTokenDeltas: { proactiveVsBaseline?: { beforeTokens: number; afterTokens: number; savedTokens: number } };
      aggregate?: { repeat: number; deltas: { manualPrimeVsBaseline?: { savedTokens?: number; savingsRate?: number } } };
      proactive: { results: Array<{ metadata: Record<string, unknown> }> };
      mcpFirst?: { results: Array<{ metadata: Record<string, unknown>; observedCodexTokens?: number }> };
      realMcpFirst?: { results: Array<{ metadata: Record<string, unknown>; observedCodexTokens?: number }> };
      mcpFirstPlusHookFullPrime?: { results: Array<{ metadata: Record<string, unknown>; observedCodexTokens?: number }> };
      hybridMcpBrief?: { results: Array<{ metadata: Record<string, unknown>; observedCodexTokens?: number }> };
    };

    expect(proof.observedTokenDeltas.proactiveVsBaseline).toMatchObject({
      beforeTokens: 3000,
      afterTokens: 1000,
      savedTokens: 2000
    });
    expect(proof.proactive.results[0]?.metadata.assistanceMode).toBe("manual_prime");
    expect(proof.proactive.results[0]?.metadata.primeTokenEstimate).toBeGreaterThan(0);
    expect(proof.mcpFirst?.results[0]?.metadata.mcpFirstInstructionsPrepended).toBe(true);
    expect(proof.mcpFirst?.results[0]?.observedCodexTokens).toBe(1500);
    expect(proof.realMcpFirst?.results[0]?.metadata.mcpFirstInstructionsPrepended).toBe(true);
    expect(proof.realMcpFirst?.results[0]?.observedCodexTokens).toBe(1500);
    expect(proof.mcpFirstPlusHookFullPrime?.results[0]?.metadata.mcpFirstInstructionsPrepended).toBe(true);
    expect(proof.mcpFirstPlusHookFullPrime?.results[0]?.observedCodexTokens).toBe(1500);
    expect(proof.hybridMcpBrief?.results[0]?.metadata.mcpFirstInstructionsPrepended).toBe(true);
    expect(proof.hybridMcpBrief?.results[0]?.observedCodexTokens).toBe(1500);
    expect(proof.aggregate?.repeat).toBe(2);
    expect(proof.aggregate?.deltas.manualPrimeVsBaseline?.savedTokens).toBe(2000);
  });

  it("supports kairn codex dry-run and MCP instruction setup", () => {
    const root = createFixtureRepo();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Existing Instructions\n");
    const setup = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp-instructions", "--root", root, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { instructionsPath: string };
    execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "mcp-instructions", "--root", root], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const instructions = fs.readFileSync(setup.instructionsPath, "utf8");
    const dryRun = JSON.parse(
      execFileSync(
        CLI[0]!,
        [...CLI.slice(1), "codex", "Find job tracker mobile layout files", "--root", root, "--dry-run", "--json"],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as { args: string[]; prompt: string; prime: { files: string[] } };

    expect(instructions).toContain("# Existing Instructions");
    expect(instructions.match(/kairn:mcp-first:start/g)?.length).toBe(1);
    expect(dryRun.args[0]).toBe("exec");
    expect(dryRun.prompt).toContain("Kairn Proactive Context");
    expect(dryRun.prompt).toContain("User task:");
    expect(dryRun.prime.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
  });
});

function record(path: string, kind: "source" | "component" | "test") {
  return {
    rootPath: "/repo",
    path,
    language: "typescript",
    kind,
    size: 100,
    hash: path,
    importance: 1,
    updatedAt: "now"
  };
}
