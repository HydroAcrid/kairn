import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { createDefaultBenchmarkSuite, loadBenchmarkSuite } from "../src/bench/suite.js";
import { compareBenchmarkReports, scoreBenchmarkCase } from "../src/bench/score.js";
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
});

describe("benchmark runtime and CLI", () => {
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
