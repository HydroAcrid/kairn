import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { createDefaultBenchmarkSuite, loadBenchmarkSuite } from "../src/bench/suite.js";
import { buildBenchmarkReport, compareBenchmarkReports, scoreBenchmarkCase } from "../src/bench/score.js";
import { loadBenchmarkRepoMatrix, runBenchmarkRepoMatrix } from "../src/bench/matrix.js";
import { loadBenchmarkEnduranceSuite } from "../src/bench/enduranceSuite.js";
import { runBenchmarkEndurance } from "../src/bench/endurance.js";
import { runAgentBenchmarkCase } from "../src/bench/agent.js";
import { evaluateContextValue } from "../src/prime/contextValue.js";
import { resolvePrimeProfile } from "../src/prime/quality.js";
import { createFixtureRepo } from "./helpers.js";

const CLI = ["tsx", "src/cli.ts"];

describe("benchmark suite and scoring", () => {
  it("routes explicit debug/regression prompts to the failure-debug prime profile", () => {
    expect(resolvePrimeProfile("auto", "Debug StringUtils.isBlank whitespace behavior")).toBe("failure_debug");
    expect(resolvePrimeProfile("auto", "Debug local URL handling in the router utility")).toBe("failure_debug");
    expect(resolvePrimeProfile("auto", "Fix mobile layout spacing")).not.toBe("failure_debug");
  });

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
    expect(suite.cases.find((item) => item.id === "python-click-term-len-ansi")?.seed?.testCommand).toContain("python3");
    expect(suite.cases.find((item) => item.id === "typescript-tanstack-hidden-hash")?.seed?.testCommand).toContain(".sort()");
    expect(suite.cases.find((item) => item.id === "typescript-tanstack-hidden-hash")?.seed?.testCommand).not.toContain("pnpm test");
    expect(suite.cases.find((item) => item.id === "cpp-fmt-starts-with")?.requiredTouchedFiles).toEqual([
      "include/fmt/base.h"
    ]);
  });

  it("loads endurance benchmark suite examples", () => {
    const axios = loadBenchmarkEnduranceSuite({
      suitePath: path.resolve("examples/bench/endurance-axios.json")
    });
    const flask = loadBenchmarkEnduranceSuite({
      suitePath: path.resolve("examples/bench/endurance-flask.json")
    });
    const commons = loadBenchmarkEnduranceSuite({
      suitePath: path.resolve("examples/bench/endurance-commons-io.json")
    });

    expect(axios.turns.map((turn) => turn.id)).toEqual(["diagnose", "fix", "verify", "cleanup"]);
    expect(flask.seed?.setupPatchFile).toMatch(/flask-dispatch-request-view\.patch$/);
    expect(commons.turns.find((turn) => turn.id === "fix")?.requiredTouchedFiles).toContain(
      "src/main/java/org/apache/commons/io/FilenameUtils.java"
    );
  });

  it("loads the broad repo-matrix preflight example", () => {
    const matrix = loadBenchmarkRepoMatrix({
      matrixPath: path.resolve("examples/bench/repo-matrix.json")
    });

    expect(matrix.id).toBe("broad-repo-matrix");
    expect(matrix.repos.map((repo) => repo.id)).toEqual(
      expect.arrayContaining(["tanstack-query", "click", "commons-lang", "fmt", "weak-signal-control"])
    );
    expect(matrix.repos.find((repo) => repo.id === "click")?.cases[0]?.expectedFiles).toContain("src/click/_compat.py");
  });

  it("loads the companion generalization repo-matrix example", () => {
    const matrix = loadBenchmarkRepoMatrix({
      matrixPath: path.resolve("examples/bench/repo-matrix-generalization.json")
    });

    expect(matrix.id).toBe("repo-matrix-generalization");
    expect(matrix.repos.map((repo) => repo.id)).toEqual(
      expect.arrayContaining(["fastapi", "pytest", "axios", "vue-core", "gin", "go-chi", "flask", "nestjs", "commons-io"])
    );
    expect(matrix.repos.find((repo) => repo.id === "gin")?.cases[0]?.expectedFiles).toEqual(
      expect.arrayContaining(["routergroup.go", "gin.go", "context.go"])
    );
    expect(matrix.repos.find((repo) => repo.id === "nestjs")?.cases[0]?.expectedFiles).toContain(
      "packages/core/router/router-execution-context.ts"
    );
  });

  it("runs repo-matrix preflight against local fixture repos", async () => {
    const root = createFixtureRepo();
    const matrixPath = path.join(root, "matrix.json");
    fs.writeFileSync(
      matrixPath,
      JSON.stringify({
        id: "local-matrix",
        name: "Local Matrix",
        gates: {
          maxStateMb: 100,
          maxPrimeLatencyMs: 10000,
          expectedTopK: 5,
          requireSuppressionForWeakCases: false
        },
        repos: [
          {
            id: "fixture",
            localPath: root,
            cases: [
              {
                id: "mobile-layout",
                mode: "context",
                task: "job tracker mobile layout drawer tabs cards",
                expectedFiles: ["src/app/private/jobs/JobsApplicationsTable.tsx"],
                excludedFiles: ["docs/"],
                budget: 900
              }
            ]
          }
        ]
      })
    );

    const report = await runBenchmarkRepoMatrix({ matrixPath });

    expect(report.totals.repos).toBe(1);
    expect(report.totals.cases).toBe(1);
    expect(report.repos[0]?.stateWithinLimit).toBe(true);
    expect(report.repos[0]?.cases[0]?.expectedTopKPassed).toBe(true);
    expect(report.repos[0]?.cases[0]?.excludedFilesAvoided).toBe(true);
    expect(report.repos[0]?.cases[0]?.sourceVsTestDecision).not.toBe("test_first");
  });

  it("runs a fake-agent endurance suite in one workspace and reports ledger savings signals", async () => {
    const root = createFixtureRepo();
    const suitePath = path.join(root, "endurance-suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "fixture-endurance",
        name: "Fixture Endurance",
        task: "Keep src/user.ts context focused across turns.",
        seed: {
          repoUrl: root,
          ref: "HEAD",
          cloneDepth: 1
        },
        turns: [
          {
            id: "diagnose",
            task: "Inspect src/user.ts formatting behavior.",
            agentPrompt: "Inspect src/user.ts formatting behavior.",
            expectedFiles: ["src/user.ts"],
            requiredTouchedFiles: [],
            excludedFiles: [],
            budget: 500
          },
          {
            id: "fix",
            task: "Update src/user.ts formatting behavior.",
            agentPrompt: "Update src/user.ts formatting behavior.",
            expectedFiles: ["src/user.ts"],
            requiredTouchedFiles: ["src/user.ts"],
            excludedFiles: [],
            verificationCommand: "node -e \"const fs=require('fs'); process.exit(fs.readFileSync('src/user.ts','utf8').includes('enduranceFix') ? 0 : 1)\"",
            budget: 500
          }
        ]
      })
    );
    const fakeCommand = [
      "node -e \"",
      "const fs=require('fs');",
      "fs.appendFileSync('src/user.ts','\\nexport const enduranceFix = true;\\n');",
      "console.log('src/user.ts');",
      "console.log('Token usage: total=120 input=100 output=20');",
      "\""
    ].join("");

    const report = await runBenchmarkEndurance({
      rootPath: root,
      suitePath,
      baselineCommand: fakeCommand,
      kairnCommand: fakeCommand,
      turnTimeoutMs: 30000
    });

    expect(report.reports.map((item) => item.mode)).toEqual(["baseline", "kairn"]);
    expect(report.reports.every((item) => item.qualityGatePassed)).toBe(true);
    expect(report.reports.find((item) => item.mode === "kairn")?.sessionId).toMatch(/^task_/);
    expect(report.reports.find((item) => item.mode === "kairn")?.ledger?.events).toBeGreaterThan(0);
    expect(report.deltas.kairn?.baselineTokens).toBe(240);
  });

  it("treats excluded directory prefixes as noisy matrix hits", async () => {
    const root = createFixtureRepo();
    const matrixPath = path.join(root, "prefix-matrix.json");
    fs.writeFileSync(
      matrixPath,
      JSON.stringify({
        id: "prefix-matrix",
        name: "Prefix Matrix",
        gates: {
          maxStateMb: 100,
          maxPrimeLatencyMs: 10000,
          expectedTopK: 5,
          requireSuppressionForWeakCases: false
        },
        repos: [
          {
            id: "fixture",
            localPath: root,
            cases: [
              {
                id: "prefix-noise",
                mode: "context",
                task: "job tracker mobile layout drawer tabs cards",
                expectedFiles: ["src/app/private/jobs/JobsApplicationsTable.tsx"],
                excludedFiles: ["src/"],
                budget: 900
              }
            ]
          }
        ]
      })
    );

    const report = await runBenchmarkRepoMatrix({ matrixPath });
    const result = report.repos[0]?.cases[0];

    expect(result?.excludedFilesAvoided).toBe(false);
    expect(result?.excludedHits.some((filePath) => filePath.startsWith("src/"))).toBe(true);
  });

  it("does not count seed-patch dirtiness as agent-touched files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-seed-score-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/app.ts"), "export const value = 1;\n");
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Kairn Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Kairn Test",
          GIT_COMMITTER_EMAIL: "test@example.com"
        }
      });
      const patchPath = path.join(root, "seed.patch");
      fs.writeFileSync(
        patchPath,
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 2368447..e2403dd 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
          ""
        ].join("\n")
      );

      const result = await runAgentBenchmarkCase({
        rootPath: root,
        benchmarkCase: {
          id: "seeded",
          mode: "agent",
          task: "Do nothing",
          expectedFiles: ["src/app.ts"],
          excludedFiles: [],
          seed: {
            repoUrl: root,
            ref: "HEAD",
            setupPatchFile: patchPath,
            testCommand: "node -e \"process.exit(0)\""
          }
        },
        agentCommand: "node -e \"console.log('no relevant file mentioned')\" {prompt}"
      });

      expect(result.outcome).toBe("pass");
      expect(result.metadata.seedPatchFiles).toEqual(["src/app.ts"]);
      expect(result.metadata.seedPatchFileHashes).toBeDefined();
      expect(result.metadata.agentChangedFiles).toEqual([]);
      expect(result.actualFiles).not.toContain("src/app.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts seeded files as agent-touched when content changes after seeding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-seed-agent-touch-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/app.ts"), "export const value = 1;\n");
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Kairn Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Kairn Test",
          GIT_COMMITTER_EMAIL: "test@example.com"
        }
      });
      const patchPath = path.join(root, "seed.patch");
      fs.writeFileSync(
        patchPath,
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 2368447..e2403dd 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
          ""
        ].join("\n")
      );

      const result = await runAgentBenchmarkCase({
        rootPath: root,
        benchmarkCase: {
          id: "seeded",
          mode: "agent",
          task: "Fix source",
          expectedFiles: ["src/app.ts"],
          requiredTouchedFiles: ["src/app.ts"],
          excludedFiles: [],
          seed: {
            repoUrl: root,
            ref: "HEAD",
            setupPatchFile: patchPath,
            testCommand: "node -e \"process.exit(0)\""
          }
        },
        agentCommand: "node -e \"require('fs').writeFileSync('src/app.ts', 'export const value = 3;\\\\n')\" {prompt}"
      });

      expect(result.outcome).toBe("pass");
      expect(result.metadata.agentChangedFiles).toEqual(["src/app.ts"]);
      expect(result.metadata.requiredTouchedSatisfied).toBe(true);
      expect(result.actualFiles).toContain("src/app.ts");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts seeded files as agent-touched when the fix restores clean committed content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-seed-clean-restore-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/app.ts"), "export const value = 1;\n");
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Kairn Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Kairn Test",
          GIT_COMMITTER_EMAIL: "test@example.com"
        }
      });
      const patchPath = path.join(root, "seed.patch");
      fs.writeFileSync(
        patchPath,
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 2368447..e2403dd 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-export const value = 1;",
          "+export const value = 2;",
          ""
        ].join("\n")
      );

      const result = await runAgentBenchmarkCase({
        rootPath: root,
        benchmarkCase: {
          id: "seeded-clean-restore",
          mode: "agent",
          task: "Fix source",
          expectedFiles: ["src/app.ts"],
          requiredTouchedFiles: ["src/app.ts"],
          excludedFiles: [],
          seed: {
            repoUrl: root,
            ref: "HEAD",
            setupPatchFile: patchPath,
            testCommand: "node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.ts','utf8').includes('value = 1')) process.exit(1)\""
          }
        },
        agentCommand: "node -e \"require('fs').writeFileSync('src/app.ts', 'export const value = 1;\\\\n')\" {prompt}"
      });

      expect(result.outcome).toBe("pass");
      expect(result.metadata.changedFiles).toEqual([]);
      expect(result.metadata.agentChangedFiles).toEqual(["src/app.ts"]);
      expect(result.metadata.requiredTouchedSatisfied).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("times benchmark setup separately from the live-agent command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-agent-setup-timing-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{\"type\":\"module\"}\n");
      const result = await runAgentBenchmarkCase({
        rootPath: root,
        benchmarkCase: {
          id: "setup-timing",
          mode: "agent",
          task: "Use preconfigured setup state",
          expectedFiles: [],
          excludedFiles: [],
          budget: 1200
        },
        setupCommand: "node -e \"require('fs').writeFileSync('setup-ready.txt','ok')\"",
        agentCommand:
          "node -e \"const fs=require('fs'); if(!fs.existsSync('setup-ready.txt')) process.exit(2); console.error('Token usage: total=123 input=100 output=23')\" {prompt}"
      });

      expect(result.outcome).toBe("pass");
      expect(result.observedCodexTokens).toBe(123);
      expect(result.metadata.setupCommandExitCode).toBe(0);
      expect(result.metadata.assistanceSetupMs).toEqual(expect.any(Number));
      expect(result.metadata.agentElapsedMs).toEqual(expect.any(Number));
      expect(result.metadata.codexElapsedMs).toBe(result.metadata.agentElapsedMs);
      expect(result.metadata.verificationElapsedMs).toEqual(expect.any(Number));
      expect(result.metadata.elapsedMs as number).toBeGreaterThanOrEqual(result.metadata.agentElapsedMs as number);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks seeded fixes partial when required production files are not touched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-required-touch-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/app.ts"), "export const value = 1;\n");
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Kairn Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Kairn Test",
          GIT_COMMITTER_EMAIL: "test@example.com"
        }
      });

      const result = await runAgentBenchmarkCase({
        rootPath: root,
        benchmarkCase: {
          id: "required",
          mode: "agent",
          task: "Pass verification without touching source",
          expectedFiles: ["src/app.ts"],
          requiredTouchedFiles: ["src/app.ts"],
          excludedFiles: [],
          seed: {
            repoUrl: root,
            ref: "HEAD",
            testCommand: "node -e \"process.exit(0)\""
          }
        },
        agentCommand: "node -e \"console.log('src/app.ts')\" {prompt}"
      });

      expect(result.outcome).toBe("partial");
      expect(result.metadata.requiredTouchedSatisfied).toBe(false);
      expect(result.metadata.missingRequiredTouchedFiles).toEqual(["src/app.ts"]);

      const scored = scoreBenchmarkCase({
        runId: "bench_required",
        benchmarkCase: {
          id: "required",
          mode: "agent",
          task: "Required source touch",
          expectedFiles: ["src/app.ts"],
          requiredTouchedFiles: ["src/app.ts"],
          excludedFiles: []
        },
        actualFiles: result.actualFiles,
        responseTokens: result.responseTokens,
        taskOutcome: result.outcome,
        summary: result.summary,
        metadata: result.metadata
      });
      expect(scored.taskOutcome).toBe("partial");
      expect(scored.metadata.qualityGatePassed).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("shrinks low-value C++ context instead of emitting a full prime", () => {
    const decision = evaluateContextValue({
      task: "Debug the seeded failing C++ check. basic_string_view::starts_with should return true for an equal-length identical prefix.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- include/fmt/base.h (source, score 120): symbol match starts_with\n- test/core-test.cc (test, score 112): graph neighbor",
        files: ["include/fmt/base.h", "test/core-test.cc"],
        symbols: ["starts_with"],
        related: [],
        warnings: [],
        suggestedNextContext: ["include/fmt/base.h"],
        tokenEstimate: 420
      },
      quality: {
        score: 62,
        action: "shrink",
        reasons: ["top results are tightly clustered"],
        topScore: 120,
        topGap: 8,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [
        {
          rootPath: "/repo",
          path: "include/fmt/base.h",
          language: "cpp",
          kind: "source",
          size: 1200,
          hash: "hash",
          importance: 1,
          updatedAt: new Date(0).toISOString()
        }
      ],
      repoFileCount: 2400,
      estimatedContextCost: 900
    });

    expect(decision.action).toBe("shrink");
    expect(decision.language).toBe("cpp");
    expect(decision.expectedSavingsRisk).toBe("medium");
  });

  it("shrinks high-confidence exact source hits instead of broad full-prime delivery", () => {
    const decision = evaluateContextValue({
      task: "Debug a seeded failing C++ check. basic_string_view::starts_with should return true. Fix the production header.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- include/fmt/base.h (source, score 260): symbol match starts_with\n- test/base-test.cc (test, score 190): graph neighbor",
        files: ["include/fmt/base.h", "test/base-test.cc"],
        symbols: ["starts_with"],
        related: [],
        warnings: [],
        suggestedNextContext: ["include/fmt/base.h"],
        tokenEstimate: 420
      },
      quality: {
        score: 92,
        action: "emit",
        reasons: ["high-confidence top retrieval score"],
        topScore: 260,
        topGap: 70,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      knownFiles: [
        {
          rootPath: "/repo",
          path: "include/fmt/base.h",
          language: "cpp",
          kind: "source",
          size: 1200,
          hash: "hash",
          importance: 1,
          updatedAt: new Date(0).toISOString()
        }
      ],
      repoFileCount: 2400,
      estimatedContextCost: 900
    });

    expect(decision.action).toBe("shrink");
    expect(decision.exactSourceHit).toBe(true);
    expect(decision.recommendedDelivery).toBe("one_file_directive");
  });

  it("shrinks Java exact source hits to avoid neighboring utility fanout", () => {
    const decision = evaluateContextValue({
      task: "Debug a seeded failing Java test. StringUtils.isBlank should use Java whitespace semantics. Fix the production source.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- src/main/java/org/apache/commons/lang3/StringUtils.java (source, score 300): exact StringUtils isBlank match\n- src/main/java/org/apache/commons/lang3/Validate.java (source, score 210): package neighbor",
        files: [
          "src/main/java/org/apache/commons/lang3/StringUtils.java",
          "src/main/java/org/apache/commons/lang3/Validate.java"
        ],
        symbols: ["isBlank"],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/main/java/org/apache/commons/lang3/StringUtils.java"],
        tokenEstimate: 360
      },
      quality: {
        score: 94,
        action: "emit",
        reasons: ["high-confidence top retrieval score"],
        topScore: 300,
        topGap: 90,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      knownFiles: [
        {
          rootPath: "/repo",
          path: "src/main/java/org/apache/commons/lang3/StringUtils.java",
          language: "java",
          kind: "source",
          size: 2000,
          hash: "hash",
          importance: 1,
          updatedAt: new Date(0).toISOString()
        }
      ],
      repoFileCount: 1800,
      estimatedContextCost: 900
    });

    expect(decision.action).toBe("shrink");
    expect(decision.exactSourceHit).toBe(true);
    expect(decision.recommendedDelivery).toBe("one_file_directive");
  });

  it("suppresses exact-path prompts that do not need proactive context", () => {
    const decision = evaluateContextValue({
      task: "Open src/app.ts and explain what it does",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- src/app.ts (source, score 300): path match",
        files: ["src/app.ts"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/app.ts"],
        tokenEstimate: 120
      },
      quality: {
        score: 90,
        action: "suppress",
        reasons: ["prompt already names an exact indexed file"],
        topScore: 300,
        topGap: 200,
        exactPathMentioned: true,
        expectedSavingsRisk: "high"
      },
      knownFiles: [
        {
          rootPath: "/repo",
          path: "src/app.ts",
          language: "typescript",
          kind: "source",
          size: 200,
          hash: "hash",
          importance: 1,
          updatedAt: new Date(0).toISOString()
        }
      ],
      repoFileCount: 20,
      estimatedContextCost: 800
    });

    expect(decision.action).toBe("suppress");
    expect(decision.exactPathMentioned).toBe(true);
  });

  it("shrinks high-confidence exact source hits for easy find-style prompts", () => {
    const decision = evaluateContextValue({
      task: "Find the router utility source for local URL handling",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- packages/next/src/shared/lib/router/utils/is-local-url.ts (source, score 220): exact local url utility match\n- packages/next/src/shared/lib/router/router.ts (source, score 160): router match",
        files: [
          "packages/next/src/shared/lib/router/utils/is-local-url.ts",
          "packages/next/src/shared/lib/router/router.ts"
        ],
        symbols: ["isLocalURL"],
        related: [],
        warnings: [],
        suggestedNextContext: ["packages/next/src/shared/lib/router/utils/is-local-url.ts"],
        tokenEstimate: 260
      },
      quality: {
        score: 80,
        action: "emit",
        reasons: ["high-confidence top retrieval score"],
        topScore: 220,
        topGap: 60,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      knownFiles: [
        {
          rootPath: "/repo",
          path: "packages/next/src/shared/lib/router/utils/is-local-url.ts",
          language: "typescript",
          kind: "source",
          size: 400,
          hash: "hash",
          importance: 1,
          updatedAt: new Date(0).toISOString()
        }
      ],
      repoFileCount: 27000,
      estimatedContextCost: 800
    });

    expect(decision.action).toBe("shrink");
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["high-confidence exact source target supports compact context"])
    );
  });

  it("suppresses risky test-first context for production-source fixes", () => {
    const decision = evaluateContextValue({
      task: "Debug a seeded regression in Django slugify. Fix the production source.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- tests/modeladmin/test_checks.py (test, score 900): behavior symbol match CheckTestCase",
        files: ["tests/modeladmin/test_checks.py"],
        symbols: ["CheckTestCase"],
        related: [],
        warnings: [],
        suggestedNextContext: ["tests/modeladmin/test_checks.py"],
        tokenEstimate: 400
      },
      quality: {
        score: 96,
        action: "emit",
        reasons: ["high-confidence top retrieval score"],
        topScore: 900,
        topGap: 300,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      knownFiles: [
        {
          rootPath: "/repo",
          path: "tests/modeladmin/test_checks.py",
          language: "python",
          kind: "test",
          size: 1000,
          hash: "hash",
          importance: 1,
          updatedAt: new Date(0).toISOString()
        }
      ],
      repoFileCount: 7000,
      estimatedContextCost: 700
    });

    expect(decision.action).toBe("suppress");
    expect(decision.wrongContextRisk).toBe(true);
    expect(decision.reasons).toEqual(expect.arrayContaining(["top result is risky for a production-source fix"]));
  });

  it("marks MCP benchmark modes partial when no actual MCP call is recorded", () => {
    const scored = scoreBenchmarkCase({
      runId: "bench_mcp",
      benchmarkCase: {
        id: "mcp",
        mode: "agent",
        task: "Use MCP",
        expectedFiles: ["src/app.ts"],
        excludedFiles: []
      },
      actualFiles: ["src/app.ts"],
      responseTokens: 200,
      taskOutcome: "pass",
      summary: "Agent mentioned MCP tool names.",
      metadata: {
        assistanceMode: "real_mcp_first",
        actualMcpToolCalls: 0
      }
    });

    expect(scored.taskOutcome).toBe("partial");
    expect(scored.metadata.mcpSuccess).toBe(false);
    expect(scored.metadata.qualityGatePassed).toBe(false);
  });

  it("counts actual MCP tool calls from workspace Kairn metrics", async () => {
    const root = createFixtureRepo();
    fs.writeFileSync(
      path.join(root, "write-mcp-metric.cjs"),
      [
        "const fs = require('fs');",
        "const Database = require('better-sqlite3');",
        "fs.mkdirSync('.kairn', { recursive: true });",
        "const db = new Database('.kairn/kairn.sqlite');",
        "db.exec(`create table if not exists metrics_events (id integer primary key autoincrement, session_id text not null, root_path text not null, event_kind text not null, event_name text not null, source text not null, response_mode text, baseline_tokens integer not null, output_tokens integer not null, saved_tokens integer not null, files_json text not null, metadata_json text not null default '{}', created_at text not null)`);",
        "db.prepare(`insert into metrics_events (session_id, root_path, event_kind, event_name, source, response_mode, baseline_tokens, output_tokens, saved_tokens, files_json, metadata_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('task_test', process.cwd(), 'mcp_tool_call', 'kairn_prepare_task', 'mcp', null, 100, 25, 75, JSON.stringify(['src/app.ts', 'test/app.test.ts', 'docs/readme.md']), JSON.stringify({ toolName: 'kairn_prepare_task' }), new Date().toISOString());",
        "db.close();",
        "console.log('Token usage: total=100 input=80 output=20');"
      ].join("\n")
    );

    const result = await runAgentBenchmarkCase({
      rootPath: root,
      benchmarkCase: {
        id: "mcp-metrics",
        mode: "agent",
        task: "Use Kairn MCP",
        expectedFiles: ["src/app.ts"],
        excludedFiles: ["docs/"]
      },
      agentCommand: `NODE_PATH=${JSON.stringify(path.resolve("node_modules"))} node write-mcp-metric.cjs`
    });

    expect(result.outcome).toBe("pass");
    expect(result.metadata.actualMcpToolCalls).toBe(1);
    expect(result.metadata.actualMcpToolCallSource).toBe("workspace_metrics");
    expect(result.metadata.actualMcpToolNames).toEqual(["kairn_prepare_task"]);
    expect(result.metadata.actualMcpFiles).toEqual(["src/app.ts", "test/app.test.ts", "docs/readme.md"]);
    expect(result.metadata.mcpReturnedFileCount).toBe(3);
    expect(result.metadata.mcpReturnedExpectedFileCount).toBe(1);
    expect(result.metadata.mcpReturnedNoiseFileCount).toBe(1);
    expect(result.metadata.mcpReturnedTestFanoutCount).toBe(1);
    expect(result.metadata.mcpContextEfficiency).toBeCloseTo(1 / 3, 4);
  });

  it("adds recommendations for broad MCP fanout even when quality passes", () => {
    const scored = scoreBenchmarkCase({
      runId: "bench_mcp_fanout",
      benchmarkCase: {
        id: "mcp-fanout",
        mode: "agent",
        task: "Use Kairn MCP",
        expectedFiles: ["src/app.ts"],
        excludedFiles: []
      },
      actualFiles: ["src/app.ts"],
      responseTokens: 200,
      taskOutcome: "pass",
      summary: "Agent used MCP.",
      metadata: {
        assistanceMode: "real_mcp_first",
        actualMcpToolCalls: 2,
        mcpReturnedFileCount: 12,
        mcpReturnedExpectedFileCount: 1,
        mcpReturnedNoiseFileCount: 0,
        mcpReturnedTestFanoutCount: 7,
        mcpContextEfficiency: 0.2
      }
    });

    expect(scored.metadata.qualityGatePassed).toBe(true);
    expect(scored.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("MCP returned too many test files"),
        expect.stringContaining("MCP returned broad low-efficiency context")
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
    expect(comparison.observedTokenDelta).toMatchObject({
      beforeTokens: 2000,
      afterTokens: 1200,
      savedTokens: 800,
      savingsRate: 0.4,
      qualityGatePassed: true,
      validSavings: 800,
      invalidSavings: 0
    });
  });

  it("marks lower token usage as invalid savings when quality gates fail", () => {
    const beforeResult = scoreBenchmarkCase({
      runId: "bench_before",
      benchmarkCase: {
        id: "next-local-url",
        mode: "agent",
        task: "Fix local URL regression",
        expectedFiles: ["packages/next/src/shared/lib/router/utils/is-local-url.ts"],
        requiredTouchedFiles: ["packages/next/src/shared/lib/router/utils/is-local-url.ts"],
        excludedFiles: []
      },
      actualFiles: ["packages/next/src/shared/lib/router/utils/is-local-url.ts"],
      responseTokens: 100,
      observedCodexTokens: 8000,
      taskOutcome: "pass",
      summary: "baseline",
      metadata: { agentChangedFiles: ["packages/next/src/shared/lib/router/utils/is-local-url.ts"] }
    });
    const afterResult = scoreBenchmarkCase({
      runId: "bench_after",
      benchmarkCase: {
        id: "next-local-url",
        mode: "agent",
        task: "Fix local URL regression",
        expectedFiles: ["packages/next/src/shared/lib/router/utils/is-local-url.ts"],
        requiredTouchedFiles: ["packages/next/src/shared/lib/router/utils/is-local-url.ts"],
        excludedFiles: []
      },
      actualFiles: ["packages/next/src/shared/lib/router/router.ts"],
      responseTokens: 100,
      observedCodexTokens: 4000,
      taskOutcome: "fail",
      summary: "failed"
    });
    const before = buildBenchmarkReport({
      run: { id: "before", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [{ ...beforeResult, id: 1, createdAt: "now" }]
    });
    const after = buildBenchmarkReport({
      run: { id: "after", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [{ ...afterResult, id: 2, createdAt: "now" }]
    });
    const comparison = compareBenchmarkReports(before, after);

    expect(afterResult.metadata.qualityGatePassed).toBe(false);
    expect(comparison.observedTokenDelta).toMatchObject({
      savedTokens: 4000,
      qualityGatePassed: false,
      validSavings: 0,
      invalidSavings: 4000
    });
    expect(comparison.recommendations).toEqual(
      expect.arrayContaining(["After-run has quality-gate failures; any lower observed token usage is negative evidence, not valid savings."])
    );
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

  it("selects failure-debug primes for seeded debugging prompts", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "src/click"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/click/_compat.py"),
      [
        "def strip_ansi(value):",
        "    return value",
        "",
        "def term_len(value):",
        "    return len(strip_ansi(value))",
        ""
      ].join("\n")
    );
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/utils.md"), "ANSI terminal visible length examples\n");
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Debug the seeded failing Python check. ANSI-colored terminal text should have visible length 3 for red.",
      budget: 900
    });

    expect(prime.profile).toBe("failure_debug");
    expect(prime.content).toContain("Kairn Focused Start");
    expect(prime.quality?.action).toBe("shrink");
    expect(prime.contextDecision?.exactSourceHit).toBe(true);
    expect(prime.files[0]).toBe("src/click/_compat.py");
    expect(prime.invariants?.[0]?.statement).toContain("ANSI escape sequences");
    expect(prime.content).toContain("Invariant to preserve");
    expect(prime.content).toContain("visible terminal text length");
    expect(prime.content).toContain("Stop condition");
    expect(prime.tokenEstimate).toBeLessThanOrEqual(900);

    runtime.close();
  });

  it("adds invariant guidance for exact-source URL helper primes", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "packages/next/src/shared/lib/router/utils"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages/next/src/shared/lib/router/utils/is-local-url.ts"),
      [
        "import { isAbsoluteUrl, getLocationOrigin } from '../../utils'",
        "",
        "export function isLocalURL(url: string): boolean {",
        "  if (!isAbsoluteUrl(url)) return true",
        "  const locationOrigin = getLocationOrigin()",
        "  const resolved = new URL(url, locationOrigin)",
        "  return resolved.origin === locationOrigin",
        "}",
        ""
      ].join("\n")
    );
    fs.mkdirSync(path.join(root, "packages/next/src/shared/lib/router"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/next/src/shared/lib/router/router.ts"), "export const router = {}\n");
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Debug the seeded Next.js regression. Relative URLs should be treated as local URLs. Fix the production source and do not edit unrelated files.",
      budget: 900
    });

    expect(prime.contextDecision?.exactSourceHit).toBe(true);
    expect(prime.files).toEqual(["packages/next/src/shared/lib/router/utils/is-local-url.ts"]);
    expect(prime.invariants?.[0]?.statement).toContain("Relative or non-absolute URLs");
    expect(prime.content).toContain("Invariant to preserve");
    expect(prime.content).toContain("Relative or non-absolute URLs");
    expect(prime.content).toContain("Stop condition");
    expect(prime.content).not.toContain("router.ts");

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
            task: "Improve job tracker mobile layout bottom sheet behavior in the applications table.",
            agentPrompt: "Improve job tracker mobile layout bottom sheet behavior in the applications table.",
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
        [...CLI.slice(1), "codex", "Improve job tracker mobile layout bottom sheet behavior", "--root", root, "--dry-run", "--json"],
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
