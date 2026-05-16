import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { createDefaultBenchmarkSuite, loadBenchmarkSuite } from "../src/bench/suite.js";
import { buildBenchmarkReport, compareBenchmarkReports, scoreBenchmarkCase } from "../src/bench/score.js";
import {
  effectiveMatrixMinExpectedHits,
  effectiveMatrixRequiredCompanionHits,
  loadBenchmarkRepoMatrix,
  runBenchmarkRepoMatrix
} from "../src/bench/matrix.js";
import { loadBenchmarkEnduranceSuite } from "../src/bench/enduranceSuite.js";
import { enduranceInvariantForPrompt, runBenchmarkEndurance, runBenchmarkEnduranceRepeats } from "../src/bench/endurance.js";
import { runAgentBenchmarkCase } from "../src/bench/agent.js";
import { classifyAssistance } from "../src/bench/assistClassification.js";
import { buildSweBenchProPilot, loadSweBenchProRows, writeSweBenchProPilot } from "../src/bench/sweBenchPro.js";
import { buildSweAtlasQnaPilot, loadSweAtlasQnaRows, writeSweAtlasQnaPilot } from "../src/bench/sweAtlasQna.js";
import { buildSweContextBenchPilot, loadSweContextBenchRows, writeSweContextBenchPilot } from "../src/bench/sweContextBench.js";
import { buildSweProOfficialEvalReport } from "../src/bench/sweProOfficial.js";
import {
  aggregatePublicationRows,
  loadPublicationPlan,
  runPublicationCampaign,
  validatePublicationPlan,
  type PublicationResultRow
} from "../src/bench/publication.js";
import { evaluateDiffScopes, evaluateSourceInvariants } from "../src/bench/sourceValidation.js";
import { evaluateContextValue } from "../src/prime/contextValue.js";
import {
  applyContextGovernor,
  classifyFileRoleV2,
  classifyTaskFrameFromTask,
  linearModelPrediction,
  buildDecisionFeatures
} from "../src/prime/contextGovernor.js";
import { formatShrunkPrimeContext } from "../src/prime/formatPrime.js";
import { evaluatePrimeQuality, resolvePrimeProfile } from "../src/prime/quality.js";
import { hybridSearch } from "../src/retrieval/hybridRetrieval.js";
import { findCompanionCandidates } from "../src/retrieval/companions.js";
import { createFixtureRepo } from "./helpers.js";
import type { FileRecord, HybridScoredResult, SemanticChunkRecord } from "../src/types.js";

const CLI = ["tsx", "src/cli.ts"];
const requireFromTest = createRequire(import.meta.url);

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

  it("loads the seeded holdout light live-agent suite example", () => {
    const suite = loadBenchmarkSuite({
      suitePath: path.resolve("examples/bench/seeded-holdout-live-light.json"),
      files: []
    });

    expect(suite.id).toBe("seeded-holdout-live-light");
    expect(suite.cases.map((item) => item.id)).toEqual(
      expect.arrayContaining(["js-express-layer-fast-star", "python-requests-redirects"])
    );
    expect(suite.cases.find((item) => item.id === "js-express-layer-fast-star")?.requiredTouchedFiles).toEqual([
      "lib/router/layer.js"
    ]);
    expect(suite.cases.find((item) => item.id === "python-requests-redirects")?.seed?.setupPatchFile).toMatch(
      /requests-disable-redirects\.patch$/
    );
  });

  it("loads the fresh holdout live-agent suite example", () => {
    const suite = loadBenchmarkSuite({
      suitePath: path.resolve("examples/bench/seeded-fresh-holdout-20260510.json"),
      files: []
    });

    expect(suite.id).toBe("seeded-fresh-holdout-20260510");
    expect(suite.cases.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "js-lodash-isstring-primitive",
        "python-httpx-absolute-url",
        "java-guava-is-null-or-empty",
        "go-cobra-traverse-children"
      ])
    );
    expect(suite.cases.find((item) => item.id === "python-httpx-absolute-url")?.requiredTouchedFiles).toEqual([
      "httpx/_urls.py"
    ]);
    expect(suite.cases.find((item) => item.id === "go-cobra-traverse-children")?.seed?.setupPatchFile).toMatch(
      /cobra-traverse-children\.patch$/
    );
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

  it("loads benchmark context behavior targets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-suite-behavior-"));
    const suitePath = path.join(root, "suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "behavior-suite",
        name: "Behavior Suite",
        cases: [
          {
            id: "cheap",
            mode: "agent",
            task: "Fix obvious parser file",
            contextBehavior: "cheap_single_source",
            expectedFiles: ["src/parser.ts"],
            excludedFiles: []
          }
        ]
      })
    );

    const suite = loadBenchmarkSuite({ suitePath, files: [] });

    expect(suite.cases[0]?.contextBehavior).toBe("cheap_single_source");
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

  it("builds SWE-Bench Pro pilot suite and matrix files from exported rows", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-swe-pro-pilot-"));
    try {
      const rowsPath = path.join(root, "rows.json");
      fs.writeFileSync(
        rowsPath,
        JSON.stringify({
          rows: [
            {
              row: {
                repo: "pallets/flask",
                instance_id: "instance_pallets__flask-demo",
                base_commit: "0123456789012345678901234567890123456789",
                patch: [
                  "diff --git a/src/flask/app.py b/src/flask/app.py",
                  "--- a/src/flask/app.py",
                  "+++ b/src/flask/app.py",
                  "@@ -1 +1 @@",
                  "-return None",
                  "+return self.ensure_sync(view_func)(**view_args)"
                ].join("\n"),
                test_patch: [
                  "diff --git a/tests/test_app.py b/tests/test_app.py",
                  "--- a/tests/test_app.py",
                  "+++ b/tests/test_app.py",
                  "@@ -1 +1 @@",
                  "+def test_dispatch(): pass"
                ].join("\n"),
                problem_statement: "# Dispatch request returns None\n\nFix dispatch behavior.",
                requirements: "Use existing dispatch API.",
                interface: "",
                repo_language: "python",
                fail_to_pass: "['tests/test_app.py::test_dispatch']",
                pass_to_pass: "[]",
                issue_specificity: "['major_bug']",
                issue_categories: "['back_end_knowledge']",
                before_repo_set_cmd: [
                  "git reset --hard 0123456789012345678901234567890123456789",
                  "git clean -fd",
                  "git checkout fedcba9876543210fedcba9876543210fedcba98 -- tests/test_app.py"
                ].join("\n"),
                selected_test_files_to_run: "[\"tests/test_app.py\"]",
                dockerhub_tag: "example/flask:latest"
              }
            }
          ]
        })
      );

      const rows = loadSweBenchProRows(rowsPath);
      const pilot = buildSweBenchProPilot({ rows, limit: 1 });
      const outputs = writeSweBenchProPilot({ pilot, outDir: path.join(root, "out") });

      expect(pilot.suite.cases[0]?.expectedFiles).toEqual(["src/flask/app.py"]);
      expect(pilot.suite.cases[0]?.contextBehavior).toBe("source_rescue");
      expect(pilot.suite.cases[0]?.officialEvaluation?.source).toBe("swe_bench_pro");
      expect(pilot.suite.cases[0]?.officialEvaluation?.evaluator).toBe("patch_verification");
      expect(pilot.suite.cases[0]?.officialEvaluation?.kairnMetricEligible).toBe(true);
      expect(pilot.summary.evaluators.patch_verification).toBe(1);
      expect(pilot.suite.cases[0]?.agentPrompt).not.toContain("src/flask/app.py");
      expect(pilot.suite.cases[0]?.seed?.setupPatch).toBeUndefined();
      expect(pilot.suite.cases[0]?.seed?.setupCommands?.[0]).toContain("git fetch origin");
      expect(pilot.suite.cases[0]?.seed?.setupCommands?.at(-1)).toContain("kairn-seed-tests");
      expect(pilot.suite.cases[0]?.seed?.testCommand).toBeUndefined();
      expect(pilot.matrix.repos[0]?.cases[0]?.mode).toBe("context");
      expect(pilot.matrix.repos[0]?.cases[0]?.contextBehavior).toBe("source_rescue");
      expect(pilot.matrix.repos[0]?.cases[0]?.query).toContain("dispatch");
      expect(pilot.matrix.repos[0]?.cases[0]?.query).toContain("Likely production basename hints");
      expect(pilot.matrix.repos[0]?.cases[0]?.query).not.toContain("src/flask/app.py");
      expect(pilot.matrix.repos[0]?.cases[0]?.seed).toBeUndefined();
      expect(fs.existsSync(outputs.suitePath)).toBe(true);
      expect(fs.existsSync(outputs.matrixPath)).toBe(true);
      expect(fs.existsSync(outputs.rawRowsPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("plans SWE-Pro official evaluator evidence without counting unverified savings", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-swe-pro-official-"));
    try {
      const rowsPath = path.join(root, "rows.json");
      fs.writeFileSync(rowsPath, JSON.stringify({ rows: [{
        row: {
          repo: "pallets/flask",
          instance_id: "instance_pallets__flask-demo",
          base_commit: "0123456789012345678901234567890123456789",
          patch: "diff --git a/src/flask/app.py b/src/flask/app.py\n--- a/src/flask/app.py\n+++ b/src/flask/app.py",
          test_patch: "diff --git a/tests/test_app.py b/tests/test_app.py\n--- a/tests/test_app.py\n+++ b/tests/test_app.py",
          problem_statement: "Fix dispatch behavior.",
          repo_language: "python"
        }
      }] }));

      const report = buildSweProOfficialEvalReport({
        rowsPath,
        rowIds: ["instance_pallets__flask-demo"],
        limit: 1
      });

      expect(report.status).toBe("planned");
      expect(report.rowIds).toEqual(["instance_pallets__flask-demo"]);
      expect(report.officialEvaluatorPassed).toBe(false);
      expect(report.warnings.join(" ")).toContain("savings must remain invalid");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds SWE-ContextBench pilot pairs and repo-matrix files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-swe-contextbench-"));
    try {
      const rowsPath = path.join(root, "rows.jsonl");
      fs.writeFileSync(rowsPath, [
        JSON.stringify({
          task_id: "vite-base",
          group_id: "vite-plugin-flow",
          prompt: "Find Vite plugin resolve source.",
          repository_url: "https://github.com/vitejs/vite.git",
          repository_base_commit: "main",
          language: "typescript",
          expected_files: ["packages/vite/src/node/server/pluginContainer.ts"]
        }),
        JSON.stringify({
          task_id: "vite-related",
          group_id: "vite-plugin-flow",
          base_task_id: "vite-base",
          prompt: "Reuse prior Vite context only if it helps import analysis.",
          repository_url: "https://github.com/vitejs/vite.git",
          repository_base_commit: "main",
          language: "typescript",
          expected_files: ["packages/vite/src/node/server/pluginContainer.ts", "packages/vite/src/node/plugins/importAnalysis.ts"]
        })
      ].join("\n") + "\n");

      const rows = loadSweContextBenchRows(rowsPath);
      const pilot = buildSweContextBenchPilot({ rows, limit: 2 });
      const outputs = writeSweContextBenchPilot({ pilot, outDir: path.join(root, "out") });

      expect(pilot.rows).toBe(2);
      expect(pilot.pairs[0]?.relatedTaskIds).toEqual(["vite-related"]);
      expect(pilot.matrix.repos[0]?.cases).toHaveLength(2);
      expect(pilot.suite.cases[1]?.contextBehavior).toBe("multi_file_debug");
      expect(fs.existsSync(outputs.suitePath)).toBe(true);
      expect(fs.existsSync(outputs.matrixPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds SWE-Atlas QnA pilot suite and matrix files without leaking reference answers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-swe-atlas-qna-pilot-"));
    try {
      const rowsPath = path.join(root, "rows.json");
      fs.writeFileSync(
        rowsPath,
        JSON.stringify({
          rows: [
            {
              row: {
                task_id: "qna-kitty-remote",
                prompt: [
                  "Trace how kitten @ ls reaches the running terminal.",
                  "Where is the socket path generated and where does the ls handler live?"
                ].join("\n"),
                reference_answer: [
                  "The client path is in `/app/kitty/remote_control.py`.",
                  "Socket path expansion is in `kitty/main.py`.",
                  "The handler dispatch enters `kitty/boss.py` and reaches `kitty/rc/ls.py`.",
                  "Tests in `kitty_tests/remote_control.py` are not the production source target."
                ].join("\n"),
                repository_url: "https://github.com/kovidgoyal/kitty.git",
                repository_base_commit: "0123456789012345678901234567890123456789",
                language: "python",
                category: "code_understanding",
                rubric: "Answer with source references.",
                docker_image: "example/kitty:latest"
              }
            }
          ]
        })
      );

      const rows = loadSweAtlasQnaRows(rowsPath);
      const pilot = buildSweAtlasQnaPilot({ rows, limit: 1 });
      const outputs = writeSweAtlasQnaPilot({ pilot, outDir: path.join(root, "out") });

      expect(pilot.suite.cases[0]?.expectedFiles).toEqual(
        expect.arrayContaining([
          "kitty/remote_control.py",
          "kitty/main.py",
          "kitty/boss.py",
          "kitty/rc/ls.py"
        ])
      );
      expect(pilot.suite.cases[0]?.contextBehavior).toBe("multi_file_debug");
      expect(pilot.suite.cases[0]?.officialEvaluation?.taskClass).toBe("multi_file_debug");
      expect(pilot.suite.cases[0]?.officialEvaluation?.evaluator).toBe("source_grounded_answer");
      expect(pilot.suite.cases[0]?.officialEvaluation?.kairnMetricEligible).toBe(true);
      expect(pilot.summary.taskClasses.multi_file_debug).toBe(1);
      expect(pilot.summary.evaluators.source_grounded_answer).toBe(1);
      expect(pilot.suite.cases[0]?.agentPrompt).toContain("Trace how kitten @ ls");
      expect(pilot.suite.cases[0]?.agentPrompt).not.toContain("kitty/remote_control.py");
      expect(pilot.matrix.repos[0]?.repoUrl).toBe("https://github.com/kovidgoyal/kitty.git");
      expect(pilot.matrix.repos[0]?.cases[0]?.mode).toBe("context");
      expect(pilot.matrix.repos[0]?.cases[0]?.query).toContain("socket");
      expect(pilot.matrix.repos[0]?.cases[0]?.query).not.toContain("kitty/remote_control.py");
      expect(fs.existsSync(outputs.suitePath)).toBe(true);
      expect(fs.existsSync(outputs.matrixPath)).toBe(true);
      expect(fs.existsSync(outputs.rawRowsPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies runtime-heavy SWE-Atlas QnA separately from source-grounded Kairn metrics", () => {
    const row = {
      task_id: "qna-runtime-minio",
      prompt: [
        "When MinIO is running in distributed mode, start it and observe what happens when a disk becomes inaccessible.",
        "Use logs, health endpoints, and write attempts to explain runtime behavior."
      ].join("\n"),
      reference_answer: "The quorum code is in `cmd/erasure.go` and live repair is observed through runtime logs.",
      repository_url: "https://github.com/minio/minio.git",
      repository_base_commit: "0123456789012345678901234567890123456789",
      language: "go",
      category: "Root-cause analysis",
      rubric: "Answer with source references and runtime observations."
    };
    const pilot = buildSweAtlasQnaPilot({ rows: [row], limit: 1 });
    const official = pilot.suite.cases[0]?.officialEvaluation;

    expect(official?.taskClass).toBe("runtime_procedural");
    expect(official?.evaluator).toBe("runtime_procedural_answer");
    expect(official?.kairnMetricEligible).toBe(false);
    expect(official?.liveRisk).toBe("high");
    expect(pilot.summary.taskClasses.runtime_procedural).toBe(1);
  });

  it("validates publication plans and excludes passive savings from active claims", () => {
    expect(() =>
      validatePublicationPlan({
        plan: {
          id: "bad",
          name: "Bad",
          entries: [
            {
              id: "missing-matrix",
              kind: "matrix"
            }
          ]
        }
      })
    ).toThrow(/requires matrix/);

    const aggregate = aggregatePublicationRows([
      publicationRow({
        mode: "baseline",
        qualityPassed: true,
        observedTokens: 1000,
        assistanceStatus: "none",
        active: false
      }),
      publicationRow({
        mode: "kairn_codex_session",
        qualityPassed: true,
        baselineTokens: 1000,
        observedTokens: 750,
        savedTokens: 250,
        savingsRate: 0.25,
        validSavings: 250,
        assistanceStatus: "active",
        active: true,
        claimEligible: true
      }),
      publicationRow({
        mode: "real_mcp_first",
        qualityPassed: true,
        baselineTokens: 1000,
        observedTokens: 800,
        savedTokens: 200,
        savingsRate: 0.2,
        passiveSavings: 200,
        assistanceStatus: "passive_suppressed",
        active: false,
        claimEligible: false,
        correctAbstention: true
      }),
      publicationRow({
        mode: "hook_full_prime",
        qualityPassed: false,
        baselineTokens: 1000,
        observedTokens: 600,
        savedTokens: 400,
        savingsRate: 0.4,
        invalidSavings: 400,
        assistanceStatus: "active",
        active: true,
        claimEligible: false,
        harmfulAssist: true,
        failurePattern: "quality gate failed"
      })
    ]);

    expect(aggregate.medianValidSavingsRate).toBe(0.25);
    expect(aggregate.modes.kairn_codex_session?.validSavings).toBe(250);
    expect(aggregate.modes.real_mcp_first?.passiveSavings).toBe(200);
    expect(aggregate.modes.hook_full_prime?.invalidSavings).toBe(400);
    expect(aggregate.failurePatterns[0]?.pattern).toBe("quality gate failed");
  });

  it("runs publication campaign dry-run and writes reproducibility artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-publication-dry-run-"));
    try {
      const planPath = path.join(root, "publication-plan.json");
      const outDir = path.join(root, "out");
      fs.writeFileSync(
        planPath,
        JSON.stringify({
          id: "publication-test",
          name: "Publication Test",
          defaults: {
            model: "gpt-test",
            repeat: 2
          },
          entries: [
            {
              id: "mcp-smoke",
              kind: "mcp_smoke",
              root,
              task: "Find src/user.ts",
              repoId: "fixture",
              language: "typescript",
              taskClass: "mcp_delivery"
            },
            {
              id: "matrix",
              kind: "matrix",
              matrix: "examples/bench/repo-matrix.json",
              repoId: "fixture",
              language: "mixed",
              taskClass: "preflight"
            }
          ]
        })
      );

      const plan = loadPublicationPlan(planPath);
      expect(plan.entries).toHaveLength(2);

      const report = await runPublicationCampaign({
        planPath,
        outDir,
        dryRun: true,
        only: "mcp-smoke"
      });

      expect(report.dryRun).toBe(true);
      expect(report.artifacts).toHaveLength(1);
      expect(report.artifacts[0]?.status).toBe("planned");
      expect(report.artifacts[0]?.commands[0]).toContain("kairn bench mcp-smoke");
      expect(report.rows).toEqual([]);
      expect(fs.existsSync(report.outputs.markdownPath)).toBe(true);
      expect(fs.existsSync(report.outputs.resultsCsvPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(report.outputs.manifestPath, "utf8")) as {
        packageVersion?: string;
        nodeVersion?: string;
        artifacts: Array<{ entryId: string; commands: string[] }>;
      };
      expect(manifest.artifacts[0]?.entryId).toBe("mcp-smoke");
      expect(manifest.artifacts[0]?.commands[0]).toContain("Find src/user.ts");
      expect(manifest.packageVersion).toBeTruthy();
      expect(manifest.nodeVersion).toMatch(/^v/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts publication v2 official and context-pilot entries in dry-run mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-publication-v2-dry-run-"));
    try {
      const planPath = path.join(root, "publication-plan.json");
      const outDir = path.join(root, "out");
      fs.writeFileSync(
        planPath,
        JSON.stringify({
          id: "publication-v2-test",
          name: "Publication V2 Test",
          reportDate: "2026-05-15",
          entries: [
            {
              id: "swe-pro-official",
              kind: "swe_pro_official_eval",
              input: "examples/bench/swe-pro-publication/swe-pro-pilot-raw.jsonl",
              rowIds: ["instance_demo"],
              repoId: "swe-pro",
              taskClass: "official_patch",
              officialEvaluationRequired: true
            },
            {
              id: "swe-context",
              kind: "swe_context_pilot",
              input: "examples/bench/swe-contextbench-pilot-sample.jsonl",
              repoId: "swe-contextbench",
              taskClass: "related_context_reuse"
            }
          ]
        })
      );

      const report = await runPublicationCampaign({ planPath, outDir, dryRun: true });

      expect(report.artifacts.map((artifact) => artifact.kind)).toEqual(["swe_pro_official_eval", "swe_context_pilot"]);
      expect(report.artifacts[0]?.commands.join(" ")).toContain("official Docker evaluator");
      expect(report.artifacts[1]?.commands[0]).toContain("swe-context-pilot");
      expect(report.outputs.markdownPath).toMatch(/2026-05-15\.md$/);
      expect(fs.existsSync(report.outputs.markdownPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports publication CLI dry-run JSON output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-publication-cli-"));
    try {
      const planPath = path.join(root, "publication-plan.json");
      const outDir = path.join(root, "out");
      fs.writeFileSync(
        planPath,
        JSON.stringify({
          id: "publication-cli-test",
          name: "Publication CLI Test",
          entries: [
            {
              id: "mcp-smoke",
              kind: "mcp_smoke",
              root,
              task: "Find src/user.ts",
              repoId: "fixture",
              language: "typescript",
              taskClass: "mcp_delivery"
            }
          ]
        })
      );

      const output = execFileSync(
        CLI[0]!,
        [...CLI.slice(1), "bench", "publication", "--plan", planPath, "--out-dir", outDir, "--dry-run", "--json"],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      const report = JSON.parse(output) as { dryRun: boolean; artifacts: Array<{ status: string }>; outputs: { markdownPath: string } };

      expect(report.dryRun).toBe(true);
      expect(report.artifacts[0]?.status).toBe("planned");
      expect(fs.existsSync(report.outputs.markdownPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    const fastapi = loadBenchmarkEnduranceSuite({
      suitePath: path.resolve("examples/bench/endurance-fastapi.json")
    });
    const fastify = loadBenchmarkEnduranceSuite({
      suitePath: path.resolve("examples/bench/endurance-fastify.json")
    });
    const gin = loadBenchmarkEnduranceSuite({
      suitePath: path.resolve("examples/bench/endurance-gin.json")
    });
    const requestsLong = loadBenchmarkEnduranceSuite({
      suitePath: path.resolve("examples/bench/endurance-requests-10turn.json")
    });

    expect(axios.turns.map((turn) => turn.id)).toEqual(["diagnose", "fix", "verify", "cleanup"]);
    expect(flask.seed?.setupPatchFile).toMatch(/flask-dispatch-request-view\.patch$/);
    expect(flask.finalSourceInvariants?.[0]?.requiredAnyRegex?.length).toBeGreaterThan(0);
    expect(flask.allowedDiffScopes?.[0]?.symbols).toEqual(["dispatch_request"]);
    expect(commons.turns.find((turn) => turn.id === "fix")?.requiredTouchedFiles).toContain(
      "src/main/java/org/apache/commons/io/FilenameUtils.java"
    );
    expect(fastapi.finalSourceInvariants?.[0]?.requiredPresent).toContain("else functools.partial(run_in_threadpool, func)");
    expect(fastify.finalSourceInvariants?.[0]?.requiredPresent).toContain("? [...onSendHandlers, headRouteOnSendHandler]");
    expect(gin.finalSourceInvariants?.[0]?.requiredPresent).toContain("Handlers: group.combineHandlers(handlers),");
    expect(requestsLong.turns).toHaveLength(10);
    expect(requestsLong.turns.map((turn) => turn.id)).toContain("repeat-context-check");
  });

  it("cleans weak ledger invariants for endurance MCP guidance", () => {
    expect(
      enduranceInvariantForPrompt(
        ", fix, verify, and preserve a Requests allow_redirects regression across ten turns.",
        "Before editing, state the exact production source path and invariant. The invariant is that Session.send must call resolve_redirects when allow_redirects is true."
      )
    ).toBe("Session.send must call resolve_redirects when allow_redirects is true.");

    expect(
      enduranceInvariantForPrompt(
        "Session.send must call resolve_redirects when allow_redirects is true.",
        "Continue from the known source."
      )
    ).toBe("Session.send must call resolve_redirects when allow_redirects is true.");
  });

  it("validates equivalent semantic source repairs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-source-invariant-"));
    try {
      fs.mkdirSync(path.join(root, "src/flask"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "src/flask/app.py"),
        [
          "def dispatch_request(self):",
          "    view_args = req.view_args",
          "    view_func = self.view_functions[rule.endpoint]",
          "    return self.ensure_sync(view_func)(**view_args)",
          ""
        ].join("\n")
      );

      const result = evaluateSourceInvariants({
        rootPath: root,
        invariants: [
          {
            file: "src/flask/app.py",
            requiredAbsent: ["return None"],
            requiredAnyRegex: [
              "return\\s+self\\.ensure_sync\\(self\\.view_functions\\[rule\\.endpoint\\]\\)\\(\\*\\*view_args\\)",
              "([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*self\\.view_functions\\[rule\\.endpoint\\][\\s\\S]*return\\s+self\\.ensure_sync\\(\\1\\)\\(\\*\\*view_args\\)"
            ]
          }
        ]
      });

      expect(result.passed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects unrelated same-file hunks outside allowed symbols", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-diff-scope-"));
    try {
      fs.mkdirSync(path.join(root, "src/flask"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "src/flask/app.py"),
        [
          "class Flask:",
          "    def dispatch_request(self):",
          "        return None",
          "",
          "    def ensure_sync(self, func):",
          "        return func",
          ""
        ].join("\n")
      );
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
      fs.writeFileSync(
        path.join(root, "src/flask/app.py"),
        [
          "class Flask:",
          "    def dispatch_request(self):",
          "        return self.ensure_sync(self.view_functions[rule.endpoint])(**view_args)",
          "",
          "    def ensure_sync(self, func):",
          "        return lambda *args, **kwargs: func(*args, **kwargs)",
          ""
        ].join("\n")
      );

      const result = await evaluateDiffScopes({
        rootPath: root,
        scopes: [{ file: "src/flask/app.py", symbols: ["dispatch_request"] }]
      });

      expect(result.passed).toBe(false);
      expect(result.violations.join("\n")).toContain("outside allowed symbols");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("loads the fresh holdout repo-matrix example", () => {
    const matrix = loadBenchmarkRepoMatrix({
      matrixPath: path.resolve("examples/bench/repo-matrix-holdout.json")
    });

    expect(matrix.id).toBe("repo-matrix-holdout");
    expect(matrix.repos.map((repo) => repo.id)).toEqual(
      expect.arrayContaining(["werkzeug", "requests", "express", "gorilla-mux", "guava", "redis", "react"])
    );
    expect(matrix.repos.find((repo) => repo.id === "requests")?.cases[0]?.expectedFiles).toEqual(
      expect.arrayContaining(["src/requests/sessions.py", "src/requests/adapters.py", "src/requests/models.py"])
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

  it("does not count absent expected files as retrieval misses in repo-matrix preflight", async () => {
    const root = createFixtureRepo();
    const matrixPath = path.join(root, "matrix-absent.json");
    fs.writeFileSync(
      matrixPath,
      JSON.stringify({
        id: "local-matrix-absent",
        name: "Local Matrix Absent",
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
                id: "new-file",
                mode: "context",
                task: "Create a new keyboard shortcuts defaults file.",
                expectedFiles: ["src/NewKeyboardDefaults.ts"],
                excludedFiles: [],
                budget: 900
              }
            ]
          }
        ]
      })
    );

    const report = await runBenchmarkRepoMatrix({ matrixPath });
    const result = report.repos[0]?.cases[0];

    expect(result?.absentExpectedFiles).toEqual(["src/NewKeyboardDefaults.ts"]);
    expect(result?.missingExpectedFiles).toEqual([]);
    expect(result?.expectedTopKPassed).toBe(true);
    expect(result?.recommendations).toEqual(
      expect.arrayContaining(["Expected files absent from base checkout and not scored for retrieval: src/NewKeyboardDefaults.ts"])
    );
  });

  it("scores multi-file debug preflight as primary plus one companion by default", () => {
    const benchmarkCase = {
      id: "router-context-tree",
      mode: "context" as const,
      contextBehavior: "multi_file_debug" as const,
      task: "Debug router route context behavior when middleware and route patterns dispatch through the router.",
      expectedFiles: ["src/router.ts", "src/context.ts", "src/tree.ts"],
      excludedFiles: [],
      budget: 700
    };

    const minExpectedHits = effectiveMatrixMinExpectedHits(benchmarkCase, benchmarkCase.expectedFiles.length);
    const requiredCompanionHits = effectiveMatrixRequiredCompanionHits(benchmarkCase, benchmarkCase.expectedFiles.length - 1, minExpectedHits);

    expect(minExpectedHits).toBe(2);
    expect(requiredCompanionHits).toBe(1);
  });

  it("prefers named source companions over generic role paths", () => {
    const files = [
      sourceRecord("core/agents/listenbrainz/client.go", "go"),
      sourceRecord("core/agents/lastfm/client.go", "go"),
      sourceRecord("core/agents/spotify/client.go", "go"),
      sourceRecord("model/request/request.go", "go")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query:
        "Repository language: go. Improve encapsulation for LastFM, ListenBrainz, and Spotify client packages. Low-level request response methods should be package-private.",
      symbols: [],
      chunks: [],
      edges: [],
      limit: 2
    }).map((candidate) => candidate.file.path);

    expect(companions).toContain("core/agents/lastfm/client.go");
    expect(companions).not.toContain("model/request/request.go");
  });

  it("prefers user/email companions over generic database main files", () => {
    const files = [
      sourceRecord("src/controllers/admin/users.js", "javascript"),
      sourceRecord("src/user/email.js", "javascript"),
      sourceRecord("src/database/mongo/main.js", "javascript"),
      sourceRecord("src/database/redis/main.js", "javascript")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query:
        "Repository language: js. Fix ACP email validation status and confirmation logic. loadUserInfo should attach email pending and expired flags, validate email, and send validation email. db.mget main.js is mentioned as interface metadata, not necessarily edit target.",
      symbols: [],
      chunks: [],
      edges: [],
      limit: 2
    }).map((candidate) => candidate.file.path);

    expect(companions[0]).toBe("src/user/email.js");
    expect(companions).not.toContain("src/database/mongo/main.js");
  });

  it("prefers kubernetes service companions over generic service request files", () => {
    const files = [
      sourceRecord("lib/kube/proxy/forwarder.go", "go"),
      sourceRecord("lib/service/kubernetes.go", "go"),
      sourceRecord("lib/services/access_request.go", "go"),
      sourceRecord("lib/services/local/session.go", "go")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query:
        "Repository language: go. Debug kubectl exec interactive sessions where Kubernetes service uploader initialization is missing in the kube proxy Forwarder.",
      symbols: [],
      chunks: [],
      edges: [],
      limit: 2
    }).map((candidate) => candidate.file.path);

    expect(companions[0]).toBe("lib/service/kubernetes.go");
    expect(companions).not.toContain("lib/services/access_request.go");
  });

  it("adds request session/adapter/model companions for multi-surface request flow prompts", () => {
    const files = [
      sourceRecord("src/requests/sessions.py", "python"),
      sourceRecord("src/requests/adapters.py", "python"),
      sourceRecord("src/requests/models.py", "python"),
      sourceRecord("tests/test_sessions.py", "python")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query: "Debug request session send behavior through mounted adapters, redirect handling, and prepared request state.",
      symbols: [],
      chunks: [],
      edges: [],
      limit: 3
    }).map((candidate) => candidate.file.path);

    expect(companions).toEqual(expect.arrayContaining(["src/requests/adapters.py", "src/requests/models.py"]));
    expect(companions).not.toContain("tests/test_sessions.py");
  });

  it("adds router route/layer companions for mounted router dispatch prompts", () => {
    const files = [
      sourceRecord("lib/router/index.js", "javascript"),
      sourceRecord("lib/router/layer.js", "javascript"),
      sourceRecord("lib/router/route.js", "javascript"),
      sourceRecord("test/router.js", "javascript")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query: "Debug Express router middleware dispatch when route layers handle params and mounted routers continue through next.",
      symbols: [],
      chunks: [],
      edges: [],
      limit: 3
    }).map((candidate) => candidate.file.path);

    expect(companions).toEqual(expect.arrayContaining(["lib/router/layer.js", "lib/router/route.js"]));
    expect(companions).not.toContain("test/router.js");
  });

  it("adds fiber hooks/workloop companions ahead of generic component surfaces", () => {
    const files = [
      sourceRecord("packages/react-reconciler/src/ReactFiberWorkLoop.js", "javascript"),
      sourceRecord("packages/react-reconciler/src/ReactFiberHooks.js", "javascript"),
      sourceRecord("packages/react-reconciler/src/ReactFiberCacheComponent.js", "javascript")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query: "Debug React fiber hook update scheduling and work loop behavior when component effects are flushed.",
      symbols: [],
      chunks: [],
      edges: [],
      limit: 1
    }).map((candidate) => candidate.file.path);

    expect(companions[0]).toBe("packages/react-reconciler/src/ReactFiberHooks.js");
  });

  it("does not treat URL example literals as source-file companions", () => {
    const files = [
      sourceRecord("packages/vite/src/client/client.ts", "typescript"),
      sourceRecord("packages/vite/src/shared/utils.ts", "typescript"),
      sourceRecord("packages/vite/src/node/utils.ts", "typescript"),
      sourceRecord("packages/create-vite/template-vanilla-ts/src/main.ts", "typescript")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query:
        "Debug injectQuery handling. Relative URLs like ./dep.js and absolute URLs like /src/main.ts must receive the query while external URLs are skipped.",
      symbols: [],
      chunks: [],
      edges: [],
      limit: 2
    }).map((candidate) => candidate.file.path);

    expect(companions[0]).toBe("packages/vite/src/shared/utils.ts");
    expect(companions).not.toContain("packages/vite/src/node/utils.ts");
    expect(companions).not.toContain("packages/create-vite/template-vanilla-ts/src/main.ts");
  });

  it("prefers qualified symbol owner files over generic method providers", () => {
    const files = [
      sourceRecord("level.go", "go"),
      sourceRecord("zapcore/level.go", "go")
    ];
    const ranked = hybridSearch({
      files,
      query: "Debug a seeded Zap regression: AtomicLevel.Enabled inverted the level comparison. Fix production source only.",
      symbols: [],
      chunks: [
        chunkRecord("level.go", "file", "type AtomicLevel struct {}\nfunc (lvl AtomicLevel) Enabled(l Level) bool { return lvl.Level().Enabled(l) }"),
        chunkRecord("zapcore/level.go", "file", "type Level int8\nfunc (l Level) Enabled(lvl Level) bool { return lvl >= l }")
      ],
      vectors: [],
      edges: []
    });

    expect(ranked[0]?.path).toBe("level.go");
    expect(ranked[0]?.reasons).toEqual(expect.arrayContaining([expect.stringContaining("qualified symbol owner match")]));
  });

  it("uses explicit dataset language labels to prefer matching implementation sources", () => {
    const files = [
      sourceRecord("kitty/key_encoding.c", "c"),
      sourceRecord("kitty/rc/get_text.py", "python"),
      sourceRecord("kitty/client.py", "python")
    ];
    const ranked = hybridSearch({
      files,
      query:
        "Answer SWE-Atlas/QnA repository question: keyboard protocol stack behavior during alternating screen buffer switches.\nDataset language label: c. Prefer production source over tests/docs/examples unless the prompt explicitly asks for them.",
      symbols: [],
      chunks: [
        chunkRecord("kitty/key_encoding.c", "encode_key", "keyboard protocol flags alternate screen buffer"),
        chunkRecord("kitty/rc/get_text.py", "get_text", "keyboard protocol text command"),
        chunkRecord("kitty/client.py", "main", "client command keyboard")
      ],
      vectors: [],
      edges: []
    });

    expect(ranked[0]?.path).toBe("kitty/key_encoding.c");
    expect(ranked[0]?.reasons).toEqual(expect.arrayContaining([expect.stringContaining("expected language")]));
  });

  it("downranks generated filename surfaces even outside generated directories", () => {
    const files = [
      sourceRecord("packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts", "typescript"),
      sourceRecord("packages/grafana-data/src/types/transformations.ts", "typescript"),
      sourceRecord("packages/grafana-schema/src/raw/dashboard/x/dashboard_types.gen.ts", "typescript")
    ];
    const ranked = hybridSearch({
      files,
      query:
        "Answer SWE-Atlas/QnA repository question: Grafana Grouping to matrix transformation sparse rows and columns.\nDataset language label: ts. Prefer production source over tests/docs/examples unless the prompt explicitly asks for them.",
      symbols: [],
      chunks: [
        chunkRecord("packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts", "groupingToMatrix", "sparse rows columns matrix transform"),
        chunkRecord("packages/grafana-data/src/types/transformations.ts", "TransformerRegistryItem", "grouping matrix transformation options"),
        chunkRecord("packages/grafana-schema/src/raw/dashboard/x/dashboard_types.gen.ts", "Dashboard", "matrix panel dashboard generated schema")
      ],
      vectors: [],
      edges: []
    });

    expect(ranked[0]?.path).toBe("packages/grafana-data/src/transformations/transformers/groupingToMatrix.ts");
    expect(ranked.map((item) => item.path).slice(0, 2)).not.toContain("packages/grafana-schema/src/raw/dashboard/x/dashboard_types.gen.ts");
  });

  it("prefers same-package text utility companions with delimiter behavior", () => {
    const files = [
      sourceRecord("src/main/java/org/apache/commons/text/CaseUtils.java", "java"),
      sourceRecord("src/main/java/org/apache/commons/text/WordUtils.java", "java"),
      sourceRecord("src/main/java/org/apache/commons/text/StringEscapeUtils.java", "java")
    ];
    const chunks = [
      chunkRecord("src/main/java/org/apache/commons/text/CaseUtils.java", "toCamelCase", "camel case delimiter"),
      chunkRecord("src/main/java/org/apache/commons/text/WordUtils.java", "capitalize", "delimiter whitespace capitalize words"),
      chunkRecord("src/main/java/org/apache/commons/text/StringEscapeUtils.java", "escape", "escape string html xml")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query: "Debug CaseUtils.toCamelCase default delimiter behavior for whitespace and space characters.",
      symbols: [],
      chunks,
      edges: [],
      limit: 2
    }).map((candidate) => candidate.file.path);

    expect(companions[0]).toBe("src/main/java/org/apache/commons/text/WordUtils.java");
  });

  it("prefers public API inline header companions for C++ header fixes", () => {
    const files = [
      sourceRecord("include/spdlog/logger.h", "cpp"),
      sourceRecord("include/spdlog/spdlog-inl.h", "cpp"),
      sourceRecord("include/spdlog/details/log_msg.h", "cpp")
    ];
    const chunks = [
      chunkRecord("include/spdlog/logger.h", "should_log", "logger should_log level threshold"),
      chunkRecord("include/spdlog/spdlog-inl.h", "should_log", "spdlog should_log default logger level"),
      chunkRecord("include/spdlog/details/log_msg.h", "log_msg", "message level payload")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query: "Debug spdlog logger::should_log level threshold behavior in the production header.",
      symbols: [],
      chunks,
      edges: [],
      limit: 2
    }).map((candidate) => candidate.file.path);

    expect(companions[0]).toBe("include/spdlog/spdlog-inl.h");
  });

  it("prefers transform/import-analysis companions over plain resolvers for plugin transform flows", () => {
    const files = [
      sourceRecord("packages/vite/src/node/server/pluginContainer.ts", "typescript"),
      sourceRecord("packages/vite/src/node/plugins/resolve.ts", "typescript"),
      sourceRecord("packages/vite/src/node/plugins/importAnalysis.ts", "typescript")
    ];
    const companions = findCompanionCandidates({
      files,
      ranked: [scoredRecord(files[0]!)],
      query: "Debug Vite plugin container module resolution when resolveId and load hooks coordinate across dev server transforms.",
      symbols: [],
      chunks: [
        chunkRecord("packages/vite/src/node/server/pluginContainer.ts", "PluginContainer", "resolveId load transform plugin hooks"),
        chunkRecord("packages/vite/src/node/plugins/resolve.ts", "resolvePlugin", "resolve id resolver module resolution"),
        chunkRecord("packages/vite/src/node/plugins/importAnalysis.ts", "importAnalysisPlugin", "import analysis transform dev server module graph")
      ],
      edges: [],
      limit: 2
    }).map((candidate) => candidate.file.path);

    expect(companions[0]).toBe("packages/vite/src/node/plugins/importAnalysis.ts");
  });

  it("routes Go logging pipelines to core entry encoder before field helpers", () => {
    const files = [
      sourceRecord("zapcore/core.go", "go"),
      sourceRecord("zapcore/entry.go", "go"),
      sourceRecord("zapcore/encoder.go", "go"),
      sourceRecord("zapcore/field.go", "go"),
      sourceRecord("field.go", "go")
    ];
    const ranked = hybridSearch({
      files,
      query: "Debug zap core entry writing when checked entries dispatch fields to the underlying core and encoder.",
      symbols: [],
      chunks: [
        chunkRecord("zapcore/core.go", "Core", "core write entry checked entry dispatch to underlying core"),
        chunkRecord("zapcore/entry.go", "CheckedEntry", "checked entry write dispatch fields"),
        chunkRecord("zapcore/encoder.go", "Encoder", "encoder encodes entry fields"),
        chunkRecord("zapcore/field.go", "Field", "field metadata helpers"),
        chunkRecord("field.go", "Field", "top-level logger field helpers")
      ],
      vectors: [],
      edges: []
    });
    const topThree = ranked.slice(0, 3).map((item) => item.path);

    expect(topThree).toEqual(expect.arrayContaining(["zapcore/core.go", "zapcore/entry.go", "zapcore/encoder.go"]));
    expect(ranked.findIndex((item) => item.path === "field.go")).toBeGreaterThan(2);
  });

  it("does not treat cleanup of test artifacts as explicit test-source intent", () => {
    const files = [
      { ...sourceRecord("src/documents/tests/test_api.py", "python"), kind: "test" as const },
      sourceRecord("src/documents/tasks.py", "python"),
      sourceRecord("src/documents/management/commands/document_index.py", "python")
    ];
    const ranked = hybridSearch({
      files,
      query:
        "Answer SWE-Atlas/QnA repository question: what periodic tasks are registered with the scheduler and where is index optimization defined? Dataset language label: python. Prefer production source over tests/docs/examples unless the prompt explicitly asks for them. Don't modify source code; observing system behavior is fine, clean up any test artifacts when done.",
      symbols: [],
      chunks: [
        chunkRecord("src/documents/tests/test_api.py", "DocumentApiTests", "test api document scheduled task"),
        chunkRecord("src/documents/tasks.py", "index_optimize", "periodic task index optimize background task schedule"),
        chunkRecord("src/documents/management/commands/document_index.py", "Command", "document index optimization command")
      ],
      vectors: [],
      edges: []
    });
    const topTwo = ranked.slice(0, 2).map((item) => item.path);

    expect(topTwo).toEqual(expect.arrayContaining(["src/documents/tasks.py", "src/documents/management/commands/document_index.py"]));
    expect(ranked[0]?.path).not.toBe("src/documents/tests/test_api.py");
  });

  it("routes modifier address tracking questions to metadata and modifier interfaces", () => {
    const files = [
      sourceRecord("internal/module/modifier.go", "go"),
      sourceRecord("internal/module/msgmetadata.go", "go"),
      sourceRecord("internal/modify/alias_file.go", "go"),
      sourceRecord("internal/dsn/dsn.go", "go")
    ];
    const ranked = hybridSearch({
      files,
      query:
        "Trace how recipient address transformations are tracked when aliases rewrite addresses. Find the mapping direction each modifier builds and how bounces use it.",
      symbols: [],
      chunks: [
        chunkRecord("internal/module/modifier.go", "ModifierState", "RewriteRcpt modifiers run in order and mutate recipient values"),
        chunkRecord("internal/module/msgmetadata.go", "MsgMetadata", "OriginalRcpts mapping final recipient to original recipient used for DSN bounces"),
        chunkRecord("internal/modify/alias_file.go", "RewriteRcpt", "alias file rewrite recipient address aliases map"),
        chunkRecord("internal/dsn/dsn.go", "Format", "delivery status notification bounce recipient")
      ],
      vectors: [],
      edges: []
    });
    const topTwo = ranked.slice(0, 2).map((item) => item.path);

    expect(topTwo).toEqual(expect.arrayContaining(["internal/module/modifier.go", "internal/module/msgmetadata.go"]));
  });

  it("routes account email confirmation flows to user email modules over creation helpers", () => {
    const files = [
      sourceRecord("src/controllers/admin/users.js", "javascript"),
      sourceRecord("src/user/email.js", "javascript"),
      sourceRecord("src/user/create.js", "javascript")
    ];
    const ranked = hybridSearch({
      files,
      query:
        "Debug admin user email validation and confirmation resend behavior when expired keys prevent locating the user email.",
      symbols: [],
      chunks: [
        chunkRecord("src/controllers/admin/users.js", "validateEmail", "admin validate user email status"),
        chunkRecord("src/user/email.js", "sendValidationEmail", "email confirmation validation expiry key resend user email"),
        chunkRecord("src/user/create.js", "create", "create user account")
      ],
      vectors: [],
      edges: []
    });

    expect(ranked.slice(0, 2).map((item) => item.path)).toEqual(
      expect.arrayContaining(["src/controllers/admin/users.js", "src/user/email.js"])
    );
    expect(ranked.findIndex((item) => item.path === "src/user/create.js")).toBeGreaterThan(1);
  });

  it("routes URI authorization and netrc issues to URL request utilities over generic utils", () => {
    const files = [
      sourceRecord("lib/ansible/modules/get_url.py", "python"),
      sourceRecord("lib/ansible/module_utils/urls.py", "python"),
      sourceRecord("lib/ansible/module_utils/facts/utils.py", "python"),
      sourceRecord("lib/ansible/module_utils/common/_utils.py", "python")
    ];
    const ranked = hybridSearch({
      files,
      query:
        "Debug uri module .netrc credentials overriding an explicit Authorization header with Bearer auth in HTTP requests.",
      symbols: [],
      chunks: [
        chunkRecord("lib/ansible/modules/get_url.py", "main", "module uses url request helper"),
        chunkRecord("lib/ansible/module_utils/urls.py", "open_url", "uri url request headers authorization netrc bearer basic auth"),
        chunkRecord("lib/ansible/module_utils/facts/utils.py", "get_file_content", "facts generic utils"),
        chunkRecord("lib/ansible/module_utils/common/_utils.py", "get_all_subclasses", "common generic utils")
      ],
      vectors: [],
      edges: []
    });

    expect(ranked.slice(0, 2).map((item) => item.path)).toEqual(
      expect.arrayContaining(["lib/ansible/modules/get_url.py", "lib/ansible/module_utils/urls.py"])
    );
    const genericUtilityIndex = ranked.findIndex((item) => item.path === "lib/ansible/module_utils/facts/utils.py");
    expect(genericUtilityIndex === -1 || genericUtilityIndex > 1).toBe(true);
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
      mcpCommand: fakeCommand,
      hookFullPrimeCommand: fakeCommand,
      hookFullPrimeSetupCommand: "node -e \"console.log('hook setup')\"",
      kairnCodexSessionCommand: fakeCommand,
      kairnCodexSessionSetupCommand: "node -e \"console.log('session setup')\"",
      realMcpFirstCommand: fakeCommand,
      realMcpFirstSetupCommand: "node -e \"console.log('mcp setup')\"",
      hybridMcpBriefCommand: fakeCommand,
      hybridMcpBriefSetupCommand: "node -e \"console.log('hybrid setup')\"",
      turnTimeoutMs: 30000
    });

    expect(report.reports.map((item) => item.mode)).toEqual([
      "baseline",
      "kairn",
      "mcp",
      "hook_full_prime",
      "kairn_codex_session",
      "real_mcp_first",
      "hybrid_mcp_brief"
    ]);
    expect(report.reports.every((item) => item.qualityGatePassed)).toBe(true);
    expect(report.reports.find((item) => item.mode === "kairn")?.sessionId).toMatch(/^task_/);
    expect(report.reports.find((item) => item.mode === "kairn")?.ledger?.events).toBeGreaterThan(0);
    expect(report.reports.find((item) => item.mode === "kairn")?.ledger?.workingSet.activeFiles).toContain("src/user.ts");
    expect(report.reports.find((item) => item.mode === "hook_full_prime")?.metadata?.setupExitCode).toBe(0);
    expect(report.reports.find((item) => item.mode === "kairn_codex_session")?.metadata?.setupExitCode).toBe(0);
    expect(report.reports.find((item) => item.mode === "kairn_codex_session")?.sessionId).toMatch(/^task_/);
    expect(report.deltas.kairn?.baselineTokens).toBe(240);
  });

  it("does not count MCP savings as valid when MCP returns no useful source files", async () => {
    const root = createFixtureRepo();
    const suitePath = path.join(root, "endurance-mcp-usefulness-suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "fixture-endurance-mcp-usefulness",
        name: "Fixture Endurance MCP Usefulness",
        task: "Keep src/user.ts context focused.",
        seed: {
          repoUrl: root,
          ref: "HEAD",
          cloneDepth: 1
        },
        turns: [
          {
            id: "diagnose",
            task: "Find src/user.ts behavior.",
            agentPrompt: "Find src/user.ts behavior.",
            expectedFiles: ["src/user.ts"],
            requiredTouchedFiles: [],
            excludedFiles: [],
            budget: 500
          }
        ]
      })
    );
    const sqliteModule = requireFromTest.resolve("better-sqlite3");
    const baselineCommand = "node -e \"console.log('src/user.ts'); console.log('Token usage: total=1000 input=900 output=100')\"";
    const insertMetricSql = "insert into metrics_events (session_id, root_path, event_kind, event_name, source, response_mode, baseline_tokens, output_tokens, saved_tokens, files_json, metadata_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const realMcpCommand = [
      "node -e \"",
      `const Database=require(${JSON.stringify(sqliteModule)});`,
      "const db=new Database('.kairn/kairn.sqlite');",
      `db.prepare(${JSON.stringify(insertMetricSql)}).run('task_mcp', process.cwd(), 'mcp_tool_call', 'kairn_prepare_task', 'mcp', null, 100, 25, 75, JSON.stringify(['src/wrong.ts']), JSON.stringify({ toolName: 'kairn_prepare_task' }), new Date().toISOString());`,
      "db.close();",
      "console.log('src/user.ts');",
      "console.log('Token usage: total=100 input=80 output=20');",
      "\""
    ].join("");

    const report = await runBenchmarkEndurance({
      rootPath: root,
      suitePath,
      baselineCommand,
      realMcpFirstCommand: realMcpCommand,
      turnTimeoutMs: 30000
    });

    expect(report.deltas.real_mcp_first).toMatchObject({
      savedTokens: 900,
      assistanceEligible: false,
      invalidSavings: 900
    });
    expect(report.deltas.real_mcp_first?.validSavings).toBeUndefined();
    expect(report.deltas.real_mcp_first?.negativeEvidenceReason).toBeTruthy();
  });

  it("aggregates repeated endurance runs by median savings and classifications", async () => {
    const root = createFixtureRepo();
    const suitePath = path.join(root, "endurance-repeat-suite.json");
    fs.writeFileSync(
      suitePath,
      JSON.stringify({
        id: "fixture-endurance-repeat",
        name: "Fixture Endurance Repeat",
        task: "Keep src/user.ts context focused across repeated runs.",
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
          }
        ]
      })
    );
    const baselineCommand = "node -e \"console.log('src/user.ts'); console.log('Token usage: total=300 input=250 output=50')\"";
    const kairnCommand = "node -e \"console.log('src/user.ts'); console.log('Token usage: total=180 input=150 output=30')\"";

    const report = await runBenchmarkEnduranceRepeats({
      rootPath: root,
      suitePath,
      baselineCommand,
      kairnCommand,
      repeat: 2,
      turnTimeoutMs: 30000
    });

    expect(report.repeat).toBe(2);
    expect(report.runs).toHaveLength(2);
    expect(report.aggregate.baseline?.medianObservedCodexTokens).toBe(300);
    expect(report.aggregate.kairn).toMatchObject({
      repeats: 2,
      qualityPasses: 2,
      validSavingsRuns: 0,
      passiveSuppressedRuns: 2,
      verdict: "passive_only"
    });
    expect(report.aggregate.kairn?.medianSavedTokens).toBe(120);
  });

  it("applies source invariants and hunk-level diff scopes in endurance quality gates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-endurance-source-scope-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "src/app.ts"),
        [
          "export function target() { return 1; }",
          "export function other() { return 1; }",
          ""
        ].join("\n")
      );
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
          "index 6d3bb07..3c66ff5 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,2 +1,2 @@",
          "-export function target() { return 1; }",
          "+export function target() { return 0; }",
          " export function other() { return 1; }",
          ""
        ].join("\n")
      );
      const suitePath = path.join(root, "endurance-suite.json");
      fs.writeFileSync(
        suitePath,
        JSON.stringify({
          id: "source-scope",
          name: "Source Scope",
          task: "Fix target without touching other.",
          seed: {
            repoUrl: root,
            ref: "HEAD",
            setupPatchFile: patchPath
          },
          turns: [
            {
              id: "fix",
              task: "Fix target",
              expectedFiles: ["src/app.ts"],
              requiredTouchedFiles: ["src/app.ts"],
              excludedFiles: [],
              sourceInvariants: [
                {
                  file: "src/app.ts",
                  requiredPresent: ["target() { return 2; }"]
                }
              ],
              allowedDiffScopes: [
                {
                  file: "src/app.ts",
                  symbols: ["target"]
                }
              ]
            }
          ]
        })
      );
      const command = [
        "node -e \"",
        "const fs=require('fs');",
        "fs.writeFileSync('src/app.ts','export function target() { return 2; }\\nexport function other() { return 9; }\\n');",
        "console.log('Token usage: total=120 input=100 output=20');",
        "\""
      ].join("");

      const report = await runBenchmarkEndurance({
        rootPath: root,
        suitePath,
        baselineCommand: command,
        kairnCommand: command,
        turnTimeoutMs: 30000
      });
      const kairnTurn = report.reports.find((item) => item.mode === "kairn")?.turns[0];

      expect(kairnTurn?.metadata.sourceInvariantPassed).toBe(true);
      expect(kairnTurn?.metadata.diffScopePassed).toBe(false);
      expect(kairnTurn?.qualityGatePassed).toBe(false);
      expect(kairnTurn?.summary).toContain("outside allowed diff scope");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("fails live-agent one-shot cases when edits escape allowed diff scopes", async () => {
    const root = createFixtureRepo();
    const result = await runAgentBenchmarkCase({
      rootPath: root,
      benchmarkCase: {
        id: "diff-scope-one-shot",
        mode: "agent",
        task: "Edit only the allowed source file.",
        expectedFiles: [],
        excludedFiles: [],
        allowedDiffScopes: [{ file: "src/app.ts", allowWholeFile: true }],
        seed: {
          repoUrl: root,
          ref: "HEAD"
        }
      },
      agentCommand: "node -e \"require('fs').appendFileSync('src/user.ts', '\\nexport const drift = true;\\n'); console.error('Token usage: total=100 input=80 output=20')\""
    });

    expect(result.outcome).toBe("fail");
    expect(result.metadata.diffScopePassed).toBe(false);
    expect(result.metadata.diffScopeViolations).toEqual(expect.arrayContaining([expect.stringContaining("src/user.ts")]));
  });

  it("fails production-source-only benchmark scoring when tests are edited without an explicit test scope", () => {
    const scored = scoreBenchmarkCase({
      runId: "bench_prod_only_tests",
      benchmarkCase: {
        id: "prod-only",
        mode: "agent",
        task: "Fix the production source only and do not edit unrelated files.",
        agentPrompt: "Fix production source only. Do not inspect or edit tests.",
        expectedFiles: ["context.go"],
        requiredTouchedFiles: ["context.go"],
        excludedFiles: [],
        successCriteria: ["Verification passes.", "Tests are not touched."]
      },
      actualFiles: ["context.go", "context_test.go"],
      responseTokens: 500,
      taskOutcome: "pass",
      summary: "Agent edited source and a test.",
      metadata: {
        agentChangedFiles: ["context.go", "context_test.go"],
        testsEdited: ["context_test.go"],
        diffScopePassed: true,
        scopeViolations: []
      }
    });

    expect(scored.taskOutcome).toBe("partial");
    expect(scored.metadata.qualityGatePassed).toBe(false);
    expect(scored.metadata.productionOnlyScopeExpected).toBe(true);
    expect(scored.metadata.testEditViolationFiles).toEqual(["context_test.go"]);
    expect(scored.metadata.extraProductionEditViolationFiles).toEqual(["context_test.go"]);
    expect(scored.metadata.sourceScopeDiscipline).toBe("failed");
    expect(scored.recommendations).toEqual(expect.arrayContaining([expect.stringContaining("test edit in production-source-only task")]));
  });

  it("fails production-source-only benchmark scoring when extra production files are edited outside required scope", () => {
    const scored = scoreBenchmarkCase({
      runId: "bench_prod_only_extra_source",
      benchmarkCase: {
        id: "prod-only-extra-source",
        mode: "agent",
        task: "Fix the production source and do not edit unrelated files.",
        expectedFiles: ["src/client.ts", "src/utils.ts"],
        requiredTouchedFiles: ["src/client.ts"],
        excludedFiles: []
      },
      actualFiles: ["src/client.ts", "src/utils.ts"],
      responseTokens: 500,
      taskOutcome: "pass",
      summary: "Agent edited source and an extra source file.",
      metadata: {
        agentChangedFiles: ["src/client.ts", "src/utils.ts"],
        testsEdited: [],
        diffScopePassed: true,
        scopeViolations: []
      }
    });

    expect(scored.taskOutcome).toBe("partial");
    expect(scored.metadata.qualityGatePassed).toBe(false);
    expect(scored.metadata.extraProductionEditViolationFiles).toEqual(["src/utils.ts"]);
    expect(scored.recommendations).toEqual(expect.arrayContaining([expect.stringContaining("outside required production source scope")]));
  });

  it("allows one-file production-source-only shrink scoring when required scope is satisfied", () => {
    const scored = scoreBenchmarkCase({
      runId: "bench_prod_only_one_file",
      benchmarkCase: {
        id: "prod-only-one-file",
        mode: "agent",
        task: "Fix the production source and do not edit unrelated files.",
        expectedFiles: ["context.go", "mux.go", "tree.go"],
        requiredTouchedFiles: ["context.go"],
        excludedFiles: []
      },
      actualFiles: ["context.go"],
      responseTokens: 500,
      taskOutcome: "pass",
      summary: "Kairn emitted the required production source only.",
      metadata: {
        agentChangedFiles: ["context.go"],
        testsEdited: [],
        diffScopePassed: true,
        scopeViolations: []
      }
    });

    expect(scored.taskOutcome).toBe("pass");
    expect(scored.metadata.qualityGatePassed).toBe(true);
    expect(scored.metadata.sourceScopeCoverageOverride).toBe(true);
    expect(scored.metadata.expectedCoverageSatisfied).toBe(true);
    expect(scored.metadata.rawExpectedCoverageSatisfied).toBe(false);
    expect(scored.recommendations).not.toEqual(expect.arrayContaining([expect.stringContaining("Expected files missed")]));
  });

  it("applies production-only scope accounting to production header fixes", () => {
    const scored = scoreBenchmarkCase({
      runId: "bench_prod_header",
      benchmarkCase: {
        id: "prod-header",
        mode: "agent",
        task: "Fix the production header and do not edit unrelated files.",
        expectedFiles: ["include/fmt/base.h", "include/fmt/format-inl.h"],
        requiredTouchedFiles: ["include/fmt/base.h"],
        excludedFiles: []
      },
      actualFiles: ["include/fmt/base.h"],
      responseTokens: 500,
      taskOutcome: "pass",
      summary: "Kairn kept the header edit scoped.",
      metadata: {
        agentChangedFiles: ["include/fmt/base.h"],
        diffScopePassed: true,
        scopeViolations: []
      }
    });

    expect(scored.taskOutcome).toBe("pass");
    expect(scored.metadata.productionOnlyScopeExpected).toBe(true);
    expect(scored.metadata.sourceScopeCoverageOverride).toBe(true);
  });

  it("scores QnA grounding by minimum source mentions instead of requiring every reference file", () => {
    const scored = scoreBenchmarkCase({
      runId: "qna_grounded",
      benchmarkCase: {
        id: "qna",
        mode: "agent",
        task: "Explain how the request lifecycle chooses the handler.",
        expectedFiles: ["src/router.py", "src/dispatch.py", "src/runtime.py"],
        minExpectedHits: 1,
        excludedFiles: [],
        qnaEvaluation: {
          minSourceMentions: 1,
          requireNoRepoChanges: true
        }
      },
      actualFiles: ["src/router.py"],
      responseTokens: 500,
      taskOutcome: "pass",
      summary: "Answer cited src/router.py as the source grounding.",
      metadata: { agentChangedFiles: [] }
    });

    expect(scored.taskOutcome).toBe("pass");
    expect(scored.metadata.qualityGatePassed).toBe(true);
    expect(scored.metadata.qnaGroundingPassed).toBe(true);
    expect(scored.metadata.effectiveExpectedFileRecall).toBe(1);
  });

  it("fails QnA grounding when answer tasks modify repository files", () => {
    const scored = scoreBenchmarkCase({
      runId: "qna_changed_repo",
      benchmarkCase: {
        id: "qna",
        mode: "agent",
        task: "Explain how the request lifecycle chooses the handler.",
        expectedFiles: ["src/router.py"],
        minExpectedHits: 1,
        excludedFiles: [],
        qnaEvaluation: {
          minSourceMentions: 1,
          requireNoRepoChanges: true
        }
      },
      actualFiles: ["src/router.py"],
      responseTokens: 500,
      taskOutcome: "pass",
      summary: "Answer cited src/router.py but edited it.",
      metadata: { agentChangedFiles: ["src/router.py"] }
    });

    expect(scored.taskOutcome).toBe("partial");
    expect(scored.metadata.qualityGatePassed).toBe(false);
    expect(scored.metadata.qnaNoRepoChangesPassed).toBe(false);
    expect(scored.metadata.negativeEvidenceReason).toBe("QnA task modified repository files");
  });

  it("aggregates official benchmark results by task class and evaluator", () => {
    const result = scoreBenchmarkCase({
      runId: "official_summary",
      benchmarkCase: {
        id: "qna-source",
        mode: "agent",
        task: "Explain source behavior.",
        expectedFiles: ["src/router.py"],
        minExpectedHits: 1,
        excludedFiles: [],
        qnaEvaluation: { minSourceMentions: 1, requireNoRepoChanges: true },
        officialEvaluation: {
          source: "swe_atlas_qna",
          taskClass: "source_grounded_explanation",
          evaluator: "source_grounded_answer",
          kairnApplicability: "strong",
          kairnMetricEligible: true,
          liveRisk: "low",
          reasons: ["source-grounded answer"]
        }
      },
      actualFiles: ["src/router.py"],
      responseTokens: 300,
      observedCodexTokens: 1200,
      taskOutcome: "pass",
      summary: "grounded answer",
      metadata: { agentChangedFiles: [] }
    });
    const report = buildBenchmarkReport({
      run: {
        id: "run",
        rootPath: "/repo",
        suiteId: "suite",
        suiteName: "suite",
        mode: "agent",
        status: "completed",
        startedAt: "now",
        metadata: {}
      },
      results: [{ ...result, id: 1, createdAt: "now" }]
    });

    expect(report.officialEvaluationSummary?.totalCases).toBe(1);
    expect(report.officialEvaluationSummary?.kairnMetricEligibleCases).toBe(1);
    expect(report.officialEvaluationSummary?.byTaskClass.source_grounded_explanation?.qualityPasses).toBe(1);
    expect(report.officialEvaluationSummary?.byEvaluator.source_grounded_answer?.observedTokens).toBe(1200);
  });

  it("treats directory exclusions as nested path segments in repo matrices", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-matrix-nested-tests-"));
    const matrixPath = path.join(root, "matrix.json");
    const repo = path.join(root, "repo");
    try {
      fs.mkdirSync(path.join(repo, "src/documents/tests"), { recursive: true });
      fs.writeFileSync(path.join(repo, "src/documents/tests/test_api.py"), "def test_api(): pass\n");
      fs.writeFileSync(path.join(repo, "src/documents/views.py"), "def api_view(): pass\n");
      fs.writeFileSync(
        matrixPath,
        JSON.stringify({
          id: "nested-tests",
          name: "Nested Test Exclusion",
          gates: { expectedTopK: 5, maxPrimeLatencyMs: 10000 },
          repos: [
            {
              id: "fixture",
              localPath: repo,
              cases: [
                {
                  id: "nested",
                  mode: "context",
                  task: "Inspect src/documents/tests/test_api.py and explain API view routing",
                  query: "Inspect src/documents/tests/test_api.py and explain API view routing",
                  expectedFiles: ["src/documents/views.py"],
                  excludedFiles: ["tests/"]
                }
              ]
            }
          ]
        })
      );

      const report = await runBenchmarkRepoMatrix({ matrixPath });
      const result = report.repos[0]?.cases[0];

      expect(result?.returnedFiles).toContain("src/documents/tests/test_api.py");
      expect(result?.excludedHits).toContain("src/documents/tests/test_api.py");
      expect(result?.excludedFilesAvoided).toBe(false);
      expect(result?.qualityGatePassed).toBe(false);
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

  it("classifies generated, vendor, test, docs, route, and UI roles without repo-specific path checks", () => {
    expect(classifyFileRoleV2("src/api/user.gen.ts", "source")).toBe("generated");
    expect(classifyFileRoleV2("third_party/codec/parser.cc", "source")).toBe("vendor_dep");
    expect(classifyFileRoleV2("tests/test_parser.py", "test")).toBe("test");
    expect(classifyFileRoleV2("docs/architecture.md", "doc")).toBe("docs");
    expect(classifyFileRoleV2("app/users/[id]/route.ts", "route")).toBe("route");
    expect(classifyFileRoleV2("src/components/UserPanel.tsx", "component")).toBe("ui_surface");
  });

  it("requests evidence for low-confidence runtime procedural questions instead of guessing source context", () => {
    const decision = evaluateContextValue({
      task: "How many rows does the CLI print after running the import command with the default fixture?",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- docs/import.md (doc, score 80): import mention\n- scripts/import.ts (source, score 72): weak command mention",
        files: ["docs/import.md", "scripts/import.ts"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["docs/import.md"],
        rankedFiles: [
          { path: "docs/import.md", kind: "doc", score: 80, reasons: ["weak import mention"] },
          { path: "scripts/import.ts", kind: "source", score: 72, reasons: ["weak command mention"] }
        ],
        tokenEstimate: 240
      },
      quality: {
        score: 58,
        action: "shrink",
        reasons: ["top retrieval candidates are not well separated"],
        topScore: 80,
        topGap: 8,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [
        record("docs/import.md", "source"),
        record("scripts/import.ts", "source")
      ],
      repoFileCount: 1800,
      estimatedContextCost: 900
    });

    expect(decision.action).toBe("request_evidence");
    expect(decision.recommendedDelivery).toBe("evidence_request");
    expect(decision.evidenceRequest?.kind).toBe("runtime_scope");
    expect(decision.featureSummary?.taskFrame).toBe("runtime_procedural");
  });

  it("requests evidence for QnA prompts that require logs or runtime measurement", () => {
    const decision = evaluateContextValue({
      task: "Build it from source and run a basic scan. What initialization messages appear about which detectors get registered?",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- pkg/detectors/azure/repository.go (source, score 420): detector mention\n- pkg/tui/form.go (source, score 390): startup mention",
        files: ["pkg/detectors/azure/repository.go", "pkg/tui/form.go"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["pkg/detectors/azure/repository.go"],
        rankedFiles: [
          { path: "pkg/detectors/azure/repository.go", kind: "source", score: 420, reasons: ["detector mention"] },
          { path: "pkg/tui/form.go", kind: "source", score: 390, reasons: ["startup mention"] }
        ],
        tokenEstimate: 260
      },
      quality: {
        score: 88,
        action: "emit",
        reasons: ["high-confidence top retrieval score"],
        topScore: 420,
        topGap: 30,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      knownFiles: [
        record("pkg/detectors/azure/repository.go", "source"),
        record("pkg/tui/form.go", "source")
      ],
      repoFileCount: 3200,
      estimatedContextCost: 900
    });

    expect(decision.action).toBe("request_evidence");
    expect(decision.evidenceRequest?.kind).toBe("runtime_scope");
    expect(decision.featureSummary?.taskFrame).toBe("runtime_procedural");
  });

  it("distinguishes autonomous repo-grounded QnA from runtime measurement prompts", () => {
    expect(classifyTaskFrameFromTask(
      "Trace how recipient address tracking actually works. Answer using the checked-out repository as ground truth. Do not modify repository files.",
      "generic"
    )).toBe("qna_source_grounded");
    expect(classifyTaskFrameFromTask(
      "Build it from source and run a basic scan. What initialization messages appear about which detectors get registered?",
      "generic"
    )).toBe("runtime_procedural");
    expect(classifyTaskFrameFromTask(
      "Using the secdev/scapy repository, create a few packets in memory and convert them to raw bytes. Answer using the checked-out repository as ground truth. Do not modify repository files.",
      "generic"
    )).toBe("runtime_procedural");
  });

  it("keeps autonomous repo-grounded QnA from downgrading to a runtime evidence request", () => {
    const decision = evaluateContextValue({
      task: "Trace how recipient address tracking actually works, find tests that verify it, run them, and show me the actual data structure. Answer using the checked-out repository as ground truth. Do not modify repository files.",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- internal/module/modifier.go (source, score 440): address modifier\n- internal/module/msgmetadata.go (source, score 410): metadata tracking",
        files: ["internal/module/modifier.go", "internal/module/msgmetadata.go"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["internal/module/modifier.go"],
        rankedFiles: [
          { path: "internal/module/modifier.go", kind: "source", score: 440, reasons: ["address modifier"] },
          { path: "internal/module/msgmetadata.go", kind: "source", score: 410, reasons: ["metadata tracking"] }
        ],
        tokenEstimate: 260
      },
      quality: {
        score: 86,
        action: "shrink",
        reasons: ["source-grounded answer with concrete source candidates"],
        topScore: 440,
        topGap: 30,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [
        record("internal/module/modifier.go", "source"),
        record("internal/module/msgmetadata.go", "source")
      ],
      repoFileCount: 2100,
      estimatedContextCost: 900
    });

    expect(decision.action).not.toBe("request_evidence");
    expect(decision.featureSummary?.taskFrame).toBe("qna_source_grounded");
  });

  it("treats product-data edits and background-worker observation as runtime evidence requests", () => {
    const decision = evaluateContextValue({
      task: "With the full environment running, what actually happens at runtime when a document gets modified through the API, and does a background worker pick up a job in response to the edit?",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- src/documents/tests/test_api.py (test, score 280): API edit mention\n- src/documents/tasks.py (source, score 210): worker mention",
        files: ["src/documents/tests/test_api.py", "src/documents/tasks.py"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/documents/tests/test_api.py"],
        rankedFiles: [
          { path: "src/documents/tests/test_api.py", kind: "test", score: 280, reasons: ["API edit mention"] },
          { path: "src/documents/tasks.py", kind: "source", score: 210, reasons: ["worker mention"] }
        ],
        tokenEstimate: 220
      },
      quality: {
        score: 72,
        action: "shrink",
        reasons: ["runtime source ambiguity"],
        topScore: 280,
        topGap: 70,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [
        record("src/documents/tests/test_api.py", "test"),
        record("src/documents/tasks.py", "source")
      ],
      repoFileCount: 2500,
      estimatedContextCost: 800
    });

    expect(decision.action).toBe("request_evidence");
    expect(decision.evidenceRequest?.kind).toBe("runtime_scope");
    expect(decision.featureSummary?.taskFrame).toBe("runtime_procedural");
  });

  it("keeps source-grounded explain prompts eligible for read-only test context", () => {
    const decision = evaluateContextValue({
      task: "Inspect src/documents/tests/test_api.py and explain API view routing.",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- src/documents/tests/test_api.py (test, score 300): exact test path match",
        files: ["src/documents/tests/test_api.py"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/documents/tests/test_api.py"],
        rankedFiles: [{ path: "src/documents/tests/test_api.py", kind: "test", score: 300, reasons: ["exact test path match"] }],
        tokenEstimate: 120
      },
      quality: {
        score: 74,
        action: "shrink",
        reasons: ["source-grounded explanation"],
        topScore: 300,
        topGap: 200,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [record("src/documents/tests/test_api.py", "test")],
      repoFileCount: 80,
      estimatedContextCost: 700
    });

    expect(decision.action).not.toBe("request_evidence");
    expect(decision.featureSummary?.taskFrame).toBe("qna_source_grounded");
  });

  it("requests production source evidence when generated files dominate retrieval", () => {
    const decision = evaluateContextValue({
      task: "Fix the API client status handling bug in production source.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- src/api/client.gen.ts (source, score 420): generated client match\n- src/api/client.ts (source, score 130): source fallback",
        files: ["src/api/client.gen.ts", "src/api/client.ts"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/api/client.gen.ts"],
        rankedFiles: [
          { path: "src/api/client.gen.ts", kind: "source", score: 420, reasons: ["generated client match"] },
          { path: "src/api/client.ts", kind: "source", score: 130, reasons: ["source fallback"] }
        ],
        tokenEstimate: 240
      },
      quality: {
        score: 82,
        action: "emit",
        reasons: ["high-confidence top retrieval score"],
        topScore: 420,
        topGap: 290,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      knownFiles: [
        record("src/api/client.gen.ts", "source"),
        record("src/api/client.ts", "source")
      ],
      repoFileCount: 900,
      estimatedContextCost: 900
    });

    expect(decision.action).toBe("request_evidence");
    expect(decision.evidenceRequest?.kind).toBe("exact_source");
    expect(decision.featureSummary?.topRole).toBe("generated");
  });

  it("allows a calibrated model seam to downgrade but not broaden deterministic decisions", () => {
    const baseInput = {
      task: "Debug a source rescue issue in the parser.",
      profile: "failure_debug" as const,
      context: {
        mode: "snippets" as const,
        content: "- src/parser.ts (source, score 500): exact parser match",
        files: ["src/parser.ts"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/parser.ts"],
        rankedFiles: [{ path: "src/parser.ts", kind: "source" as const, score: 500, reasons: ["exact parser match"] }],
        tokenEstimate: 180
      },
      quality: {
        score: 85,
        action: "shrink" as const,
        reasons: ["high-confidence top retrieval score"],
        topScore: 500,
        topGap: 300,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium" as const
      },
      knownFiles: [record("src/parser.ts", "source")],
      repoFileCount: 1200,
      estimatedContextCost: 900,
      baseDecision: {
        score: 85,
        action: "suppress" as const,
        reasons: ["deterministic safety"],
        topScore: 500,
        topGap: 300,
        primaryFile: "src/parser.ts",
        language: "typescript" as const,
        exactPathMentioned: false,
        exactSourceHit: true,
        recommendedDelivery: "none" as const,
        estimatedContextCost: 900,
        expectedSavingsRisk: "high" as const,
        debugSignal: true,
        easyTaskSignal: false
      }
    };
    const features = buildDecisionFeatures(baseInput);
    const prediction = linearModelPrediction(features, {
      bias: 10,
      harmBias: -10,
      evidenceBias: -10,
      weights: { topScore: 1 }
    });

    expect(prediction.suggestedAction).toBe("shrink");
    expect(prediction.pUseful).toBeGreaterThan(0.9);
  });

  it("turns production-source-only suppression into a tiny edit-scope guardrail", () => {
    const decision = applyContextGovernor({
      task: "Fix the production source and do not edit tests or unrelated files.",
      profile: "generic",
      context: {
        mode: "snippets",
        content: "- context.go (source, score 210): canonical source routing",
        files: ["context.go"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["context.go"],
        rankedFiles: [{ path: "context.go", kind: "source", score: 210, reasons: ["canonical source routing"] }],
        tokenEstimate: 120
      },
      quality: {
        score: 60,
        action: "suppress",
        reasons: ["cheap exact source"],
        topScore: 210,
        topGap: 35,
        exactPathMentioned: false,
        expectedSavingsRisk: "high"
      },
      baseDecision: {
        score: 48,
        action: "suppress",
        reasons: ["cheap exact source"],
        topScore: 210,
        topGap: 35,
        primaryFile: "context.go",
        language: "go",
        exactPathMentioned: false,
        exactSourceHit: true,
        sourceRescue: true,
        recommendedDelivery: "none",
        estimatedContextCost: 120,
        expectedSavingsRisk: "high",
        debugSignal: false,
        easyTaskSignal: true
      },
      knownFiles: [sourceRecord("context.go", "go")],
      repoFileCount: 120,
      estimatedContextCost: 120
    });

    expect(decision.action).toBe("shrink");
    expect(decision.recommendedDelivery).toBe("one_file_directive");
    expect(decision.reasons).toEqual(expect.arrayContaining(["production-source-only task needs a tiny edit-scope guardrail"]));
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

  it("does not treat selected test paths as exact source mentions", () => {
    const context = {
      mode: "snippets" as const,
      content: "- src/flask/app.py (source): dispatch request match",
      files: ["src/flask/app.py"],
      symbols: [],
      related: [],
      warnings: [],
      suggestedNextContext: ["src/flask/app.py"],
      rankedFiles: [
        {
          path: "src/flask/app.py",
          kind: "source" as const,
          score: 240,
          reasons: ["structured source match"]
        }
      ],
      tokenEstimate: 200
    };
    const quality = evaluatePrimeQuality({
      task: [
        "Fix the failing dispatch behavior.",
        "Selected tests from SWE-Bench Pro metadata: tests/test_app.py",
        "Expected behavior: dispatch should call the selected view function."
      ].join("\n"),
      context,
      knownFiles: [
        record("src/flask/app.py", "source"),
        record("tests/test_app.py", "test")
      ]
    });

    expect(quality.exactPathMentioned).toBe(false);
    expect(quality.action).not.toBe("suppress");
    expect(quality.topScore).toBe(240);
  });

  it("does not treat reproduction artifacts like Dockerfile as exact source mentions", () => {
    const quality = evaluatePrimeQuality({
      task: [
        "Debug the failing Trivy conversion.",
        "Steps to reproduce: create a Dockerfile, run trivy -f json, and inspect parse.json.",
        "Expected behavior: cveContents should not contain duplicate Debian severity records."
      ].join("\n"),
      context: {
        mode: "snippets",
        content: "- contrib/trivy/pkg/converter.go (source): exact converter behavior match",
        files: ["contrib/trivy/pkg/converter.go"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["contrib/trivy/pkg/converter.go"],
        rankedFiles: [
          {
            path: "contrib/trivy/pkg/converter.go",
            kind: "source",
            score: 280,
            reasons: ["exact converter behavior match"]
          }
        ],
        tokenEstimate: 180
      },
      knownFiles: [
        record("Dockerfile", "source"),
        record("contrib/trivy/pkg/converter.go", "source")
      ]
    });

    expect(quality.exactPathMentioned).toBe(false);
    expect(quality.action).not.toBe("suppress");
  });

  it("uses structured ranked scores when markdown has no score text", () => {
    const quality = evaluatePrimeQuality({
      task: "Debug a structured production failure with selected tests.",
      context: {
        mode: "snippets",
        content: "OpenLibrary list parsing context without markdown score text.",
        files: ["openlibrary/plugins/upstream/utils.py"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["openlibrary/plugins/upstream/utils.py"],
        rankedFiles: [
          {
            path: "openlibrary/plugins/upstream/utils.py",
            kind: "source",
            score: 310,
            reasons: ["source match"]
          },
          {
            path: "openlibrary/plugins/openlibrary/lists.py",
            kind: "source",
            score: 260,
            reasons: ["companion source"]
          }
        ],
        tokenEstimate: 200
      },
      knownFiles: [
        record("openlibrary/plugins/upstream/utils.py", "source"),
        record("openlibrary/plugins/openlibrary/lists.py", "source")
      ]
    });

    expect(quality.topScore).toBe(310);
    expect(quality.topGap).toBe(50);
    expect(quality.action).not.toBe("suppress");
  });

  it("classifies dominant generic-companion debug hits as cheap single-source", () => {
    const decision = evaluateContextValue({
      task: [
        "Debug a failing converter issue.",
        "Steps to reproduce: create a Dockerfile and run a generated JSON through the CLI.",
        "Expected behavior: duplicate CVE content entries with multiple severities should be merged deterministically."
      ].join("\n"),
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- contrib/trivy/pkg/converter.go (source, score 2080): exact converter behavior match",
        files: ["contrib/trivy/pkg/converter.go"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["contrib/trivy/pkg/converter.go"],
        tokenEstimate: 180
      },
      quality: {
        score: 79,
        action: "shrink",
        reasons: ["high-confidence top retrieval score", "top result is clearly separated"],
        topScore: 2080,
        topGap: 740,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [record("contrib/trivy/pkg/converter.go", "source")],
      repoFileCount: 2200,
      estimatedContextCost: 900,
      companionCount: 2,
      companionTopScore: 1300,
      companionSpecific: false
    });

    expect(decision.action).toBe("shrink");
    expect(decision.cheapSingleSource).toBe(true);
    expect(decision.recommendedDelivery).toBe("one_file_directive");
  });

  it("marks obvious dynamic-language exact source fixes for ultra-minimal automatic guardrails", () => {
    const decision = evaluateContextValue({
      task: "Debug the seeded failing Python check. Flask dispatch_request should call the matched endpoint view function with view_args, but the seeded regression returns None. Fix the production source and do not edit unrelated files.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- src/flask/app.py (source, score 3298): symbol match dispatch_request; exact source behavior match",
        files: ["src/flask/app.py"],
        symbols: ["dispatch_request"],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/flask/app.py"],
        tokenEstimate: 274
      },
      quality: {
        score: 86,
        action: "shrink",
        reasons: ["high-confidence top retrieval score", "top result is clearly separated"],
        topScore: 3298,
        topGap: 1396,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [record("src/flask/app.py", "source")],
      repoFileCount: 900,
      estimatedContextCost: 900,
      companionCount: 2,
      companionTopScore: 488,
      companionSpecific: true
    });

    expect(decision.exactSourceHit).toBe(true);
    expect(decision.cheapExactSource).toBe(true);
    expect(decision.recommendedDelivery).toBe("one_file_directive");
  });

  it("keeps source-rescue Python exact hits active as one-file guardrails", () => {
    const decision = evaluateContextValue({
      task: "Debug HTTPX absolute URL host regression: URL('https://example.com/path') should preserve the host and scheme. Fix production source and do not edit unrelated files.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- httpx/_urls.py (source, score 1410): precise filename match: url; precise symbol rescue: URL; canonical source route",
        files: ["httpx/_urls.py"],
        symbols: ["URL"],
        related: [],
        warnings: [],
        suggestedNextContext: ["httpx/_urls.py"],
        tokenEstimate: 220
      },
      quality: {
        score: 88,
        action: "shrink",
        reasons: ["high-confidence top retrieval score", "top result is clearly separated"],
        topScore: 1410,
        topGap: 760,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [record("httpx/_urls.py", "source")],
      repoFileCount: 1400,
      estimatedContextCost: 900,
      companionCount: 0,
      companionTopScore: 0,
      companionSpecific: false
    });

    expect(decision.exactSourceHit).toBe(true);
    expect(decision.sourceRescue).toBe(true);
    expect(decision.cheapExactSource).toBe(false);
    expect(decision.action).toBe("shrink");
    expect(decision.recommendedDelivery).toBe("one_file_directive");
  });

  it("does not mark Java exact source fixes as cheap exact-source abstentions", () => {
    const decision = evaluateContextValue({
      task: "Debug a seeded Commons IO regression: FilenameUtils.equals ignores the requested IOCase comparison mode. Fix the production source.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- src/main/java/org/apache/commons/io/FilenameUtils.java (source, score 4011): symbol match FilenameUtils; exact source behavior match",
        files: ["src/main/java/org/apache/commons/io/FilenameUtils.java"],
        symbols: ["FilenameUtils"],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/main/java/org/apache/commons/io/FilenameUtils.java"],
        tokenEstimate: 250
      },
      quality: {
        score: 90,
        action: "shrink",
        reasons: ["high-confidence top retrieval score", "top result is clearly separated"],
        topScore: 4011,
        topGap: 657,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [record("src/main/java/org/apache/commons/io/FilenameUtils.java", "source")],
      repoFileCount: 1800,
      estimatedContextCost: 900,
      companionCount: 1,
      companionTopScore: 1082,
      companionSpecific: true
    });

    expect(decision.exactSourceHit).toBe(true);
    expect(decision.cheapExactSource).toBe(false);
    expect(decision.recommendedDelivery).toBe("one_file_directive");
  });

  it("uses a scope-only guardrail for low-cost non-canonical exact source-rescue tasks", () => {
    const decision = evaluateContextValue({
      task: "Debug the seeded failing Java check. Apache Commons Text CaseUtils.toCamelCase should treat a space character as the default delimiter when no delimiter characters are supplied. Fix the production source and do not edit unrelated files.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: "- src/main/java/org/apache/commons/text/CaseUtils.java (source, score 9732): symbol match CaseUtils; exact source behavior match",
        files: ["src/main/java/org/apache/commons/text/CaseUtils.java"],
        symbols: ["CaseUtils"],
        related: [],
        warnings: [],
        suggestedNextContext: ["src/main/java/org/apache/commons/text/CaseUtils.java"],
        tokenEstimate: 260,
        rankedFiles: [
          {
            path: "src/main/java/org/apache/commons/text/CaseUtils.java",
            kind: "source",
            score: 9732,
            reasons: ["symbol match CaseUtils", "exact source behavior match"],
            scores: { bm25: 7200, keyword: 1200 }
          }
        ]
      },
      quality: {
        score: 92,
        action: "shrink",
        reasons: ["high-confidence top retrieval score", "top result is clearly separated"],
        topScore: 9732,
        topGap: 5614,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [record("src/main/java/org/apache/commons/text/CaseUtils.java", "source")],
      repoFileCount: 260,
      estimatedContextCost: 900,
      companionCount: 0,
      companionTopScore: 0,
      companionSpecific: false
    });

    expect(decision.action).toBe("shrink");
    expect(decision.recommendedDelivery).toBe("one_file_directive");
    expect(decision.cheapSingleSource).toBe(true);
  });

  it("does not classify relocation-style two-source debug tasks as cheap single-source", () => {
    const decision = evaluateContextValue({
      task: [
        "Qt warning filtering tests moved to appropriate module.",
        "The hide_qt_warning function moved from log.py to qtlog.py.",
        "Expected behavior: filtering should work identically after the relocation."
      ].join("\n"),
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: [
          "- qutebrowser/utils/log.py (source, score 520): source relocation origin",
          "- qutebrowser/utils/qtlog.py (source, score 470): direct role basename anchor"
        ].join("\n"),
        files: ["qutebrowser/utils/log.py", "qutebrowser/utils/qtlog.py"],
        symbols: ["hide_qt_warning"],
        related: [],
        warnings: [],
        suggestedNextContext: ["qutebrowser/utils/log.py", "qutebrowser/utils/qtlog.py"],
        tokenEstimate: 260
      },
      quality: {
        score: 76,
        action: "shrink",
        reasons: ["high-confidence top retrieval score"],
        topScore: 520,
        topGap: 50,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [
        record("qutebrowser/utils/log.py", "source"),
        record("qutebrowser/utils/qtlog.py", "source")
      ],
      repoFileCount: 1800,
      estimatedContextCost: 900,
      companionCount: 1,
      companionTopScore: 470,
      companionSpecific: true
    });

    expect(decision.cheapSingleSource).toBe(false);
    expect(decision.recommendedDelivery).toBe("multi_file_directive");
  });

  it("keeps focused debug companion tasks directive instead of full-prime", () => {
    const decision = evaluateContextValue({
      task: "Debug a seeded Axios regression: request interceptors now run in the wrong order before dispatch. Fix the production source only.",
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: [
          "- lib/core/Axios.js (source, score 2612): interceptor order source",
          "- lib/core/dispatchRequest.js (source, score 714): interceptor/dispatch companion",
          "- lib/core/InterceptorManager.js (source, score 700): interceptor companion"
        ].join("\n"),
        files: ["lib/core/Axios.js", "lib/core/dispatchRequest.js", "lib/core/InterceptorManager.js"],
        symbols: [],
        related: ["lib/core/dispatchRequest.js", "lib/core/InterceptorManager.js"],
        warnings: [],
        suggestedNextContext: ["lib/core/Axios.js", "lib/core/dispatchRequest.js", "lib/core/InterceptorManager.js"],
        tokenEstimate: 572
      },
      quality: {
        score: 92,
        action: "emit",
        reasons: ["high-confidence top retrieval score", "top result is clearly separated"],
        topScore: 2612,
        topGap: 86,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      knownFiles: [
        record("lib/core/Axios.js", "source"),
        record("lib/core/dispatchRequest.js", "source"),
        record("lib/core/InterceptorManager.js", "source")
      ],
      repoFileCount: 900,
      estimatedContextCost: 900,
      companionCount: 2,
      companionTopScore: 714,
      companionSpecific: true
    });

    expect(decision.action).toBe("shrink");
    expect(decision.recommendedDelivery).toBe("multi_file_directive");
  });

  it("chooses multi-file directive for structured debug prompts with companion evidence", () => {
    const decision = evaluateContextValue({
      task: [
        "# /lists/add returns 500 error when POST data conflicts with query parameters",
        "Requirements:",
        "- When body data is present, do not pre-populate parent keys before unflatten.",
        "Selected tests from SWE-Bench Pro metadata: openlibrary/plugins/openlibrary/tests/test_lists.py",
        "Expected behavior: body data should populate key, name, description, and seeds."
      ].join("\n\n"),
      profile: "failure_debug",
      context: {
        mode: "snippets",
        content: [
          "- openlibrary/plugins/upstream/utils.py (source, score 310): source match",
          "- openlibrary/plugins/openlibrary/lists.py (source, score 260): companion source"
        ].join("\n"),
        files: ["openlibrary/plugins/upstream/utils.py", "openlibrary/plugins/openlibrary/lists.py"],
        symbols: [],
        related: ["openlibrary/plugins/openlibrary/lists.py"],
        warnings: [],
        suggestedNextContext: ["openlibrary/plugins/upstream/utils.py", "openlibrary/plugins/openlibrary/lists.py"],
        rankedFiles: [
          {
            path: "openlibrary/plugins/upstream/utils.py",
            kind: "source",
            score: 310,
            reasons: ["source match"]
          },
          {
            path: "openlibrary/plugins/openlibrary/lists.py",
            kind: "source",
            score: 260,
            reasons: ["companion source"]
          }
        ],
        tokenEstimate: 360
      },
      quality: {
        score: 68,
        action: "shrink",
        reasons: ["structured debug context"],
        topScore: 310,
        topGap: 50,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      knownFiles: [
        record("openlibrary/plugins/upstream/utils.py", "source"),
        record("openlibrary/plugins/openlibrary/lists.py", "source")
      ],
      repoFileCount: 6000,
      estimatedContextCost: 900,
      companionCount: 1,
      companionTopScore: 650
    });

    expect(decision.action).toBe("shrink");
    expect(decision.recommendedDelivery).toBe("multi_file_directive");
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

  it("treats hybrid MCP abstention as neutral instead of a quality failure", () => {
    const scored = scoreBenchmarkCase({
      runId: "bench_hybrid_abstain",
      benchmarkCase: {
        id: "hybrid-abstain",
        mode: "agent",
        task: "Small exact source fix",
        expectedFiles: ["src/app.ts"],
        excludedFiles: []
      },
      actualFiles: ["src/app.ts"],
      responseTokens: 200,
      taskOutcome: "pass",
      summary: "Hybrid setup was available, but Kairn returned no MCP context.",
      metadata: {
        assistanceMode: "hybrid_mcp_brief",
        actualMcpToolCalls: 0,
        mcpReturnedFileCount: 0
      }
    });

    expect(scored.taskOutcome).toBe("pass");
    expect(scored.metadata.mcpRequired).toBe(false);
    expect(scored.metadata.mcpSuccess).toBe(true);
    expect(scored.metadata.qualityGatePassed).toBe(true);
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
      validSavings: 0,
      invalidSavings: 0,
      assistanceStatus: "none",
      assistanceEligible: false,
      assistClassification: "neutral"
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

  it("counts active savings when Kairn passes quality even if baseline failed quality", () => {
    const benchmarkCase = {
      id: "quality-rescue",
      mode: "agent" as const,
      task: "Fix source",
      expectedFiles: ["src/app.ts"],
      requiredTouchedFiles: ["src/app.ts"],
      excludedFiles: []
    };
    const before = buildBenchmarkReport({
      run: { id: "before", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [{
        ...scoreBenchmarkCase({
          runId: "before",
          benchmarkCase,
          actualFiles: ["src/app.ts"],
          responseTokens: 100,
          observedCodexTokens: 2000,
          taskOutcome: "pass",
          summary: "baseline missed required edit",
          metadata: { agentChangedFiles: [] }
        }),
        id: 1,
        createdAt: "now"
      }]
    });
    const after = buildBenchmarkReport({
      run: { id: "after", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [{
        ...scoreBenchmarkCase({
          runId: "after",
          benchmarkCase,
          actualFiles: ["src/app.ts"],
          responseTokens: 100,
          observedCodexTokens: 1200,
          taskOutcome: "pass",
          summary: "active source rescue",
          metadata: { agentChangedFiles: ["src/app.ts"], primeEmitted: 1 }
        }),
        id: 2,
        createdAt: "now"
      }]
    });

    expect(compareBenchmarkReports(before, after).observedTokenDelta).toMatchObject({
      qualityGatePassed: true,
      assistanceStatus: "active",
      assistClassification: "quality_rescue",
      validSavings: 800,
      invalidSavings: 0
    });
  });

  it("classifies assist, over-assist, and abstention outcomes", () => {
    expect(
      classifyAssistance({
        assistanceStatus: "active",
        qualityGatePassed: true,
        savedTokens: 800,
        baselineTokens: 2000,
        baselineQualityGatePassed: true,
        turnCount: 1
      }).assistClassification
    ).toBe("valid_assist");
    expect(
      classifyAssistance({
        assistanceStatus: "active",
        qualityGatePassed: true,
        savedTokens: -200,
        baselineTokens: 2000,
        baselineQualityGatePassed: false,
        turnCount: 1
      })
    ).toMatchObject({ assistClassification: "quality_rescue", overAssist: false, harmfulAssist: false });
    expect(
      classifyAssistance({
        assistanceStatus: "active",
        qualityGatePassed: true,
        savedTokens: -200,
        baselineTokens: 2000,
        baselineQualityGatePassed: true,
        turnCount: 1
      })
    ).toMatchObject({ assistClassification: "over_assist", overAssist: true });
    expect(
      classifyAssistance({
        assistanceStatus: "active",
        qualityGatePassed: false,
        savedTokens: 500,
        baselineTokens: 2000,
        baselineQualityGatePassed: true,
        turnCount: 1
      })
    ).toMatchObject({ assistClassification: "harmful_invalid_assist", harmfulAssist: true });
    expect(
      classifyAssistance({
        assistanceStatus: "passive_suppressed",
        qualityGatePassed: true,
        savedTokens: 100,
        baselineTokens: 2000,
        baselineQualityGatePassed: true,
        turnCount: 1
      }).assistClassification
    ).toBe("correct_abstention");
    expect(
      classifyAssistance({
        assistanceStatus: "passive_suppressed",
        qualityGatePassed: true,
        savedTokens: 100,
        baselineTokens: 80_000,
        baselineQualityGatePassed: true,
        turnCount: 4
      })
    ).toMatchObject({
      assistClassification: "missed_savings_opportunity",
      abstentionOutcome: "missed_savings_opportunity",
      missedOpportunity: true
    });
    expect(
      classifyAssistance({
        assistanceStatus: "passive_suppressed",
        qualityGatePassed: true,
        savedTokens: -100,
        baselineTokens: 80_000,
        baselineQualityGatePassed: true,
        turnCount: 4
      })
    ).toMatchObject({
      assistClassification: "passive_token_regression",
      abstentionOutcome: "passive_token_regression",
      overAssist: true
    });
  });

  it("scores behavior targets for cheap abstention and source rescue", () => {
    const cheapCase = {
      id: "cheap",
      mode: "agent" as const,
      task: "Fix obvious parser file",
      contextBehavior: "cheap_single_source" as const,
      expectedFiles: ["src/parser.ts"],
      excludedFiles: []
    };
    const rescueCase = {
      id: "rescue",
      mode: "agent" as const,
      task: "Debug hidden source routing",
      contextBehavior: "source_rescue" as const,
      expectedFiles: ["src/router.ts"],
      excludedFiles: []
    };
    const before = buildBenchmarkReport({
      run: { id: "before", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [
        {
          ...scoreBenchmarkCase({
            runId: "before",
            benchmarkCase: cheapCase,
            actualFiles: ["src/parser.ts"],
            responseTokens: 100,
            observedCodexTokens: 2000,
            taskOutcome: "pass",
            summary: "baseline cheap"
          }),
          id: 1,
          createdAt: "now"
        },
        {
          ...scoreBenchmarkCase({
            runId: "before",
            benchmarkCase: rescueCase,
            actualFiles: ["src/router.ts"],
            responseTokens: 100,
            observedCodexTokens: 60_000,
            taskOutcome: "pass",
            summary: "baseline rescue"
          }),
          id: 2,
          createdAt: "now"
        }
      ]
    });
    const after = buildBenchmarkReport({
      run: { id: "after", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [
        {
          ...scoreBenchmarkCase({
            runId: "after",
            benchmarkCase: cheapCase,
            actualFiles: ["src/parser.ts"],
            responseTokens: 100,
            observedCodexTokens: 1900,
            taskOutcome: "pass",
            summary: "suppressed cheap",
            metadata: { primeSuppressed: 1 }
          }),
          id: 3,
          createdAt: "now"
        },
        {
          ...scoreBenchmarkCase({
            runId: "after",
            benchmarkCase: rescueCase,
            actualFiles: ["src/router.ts"],
            responseTokens: 100,
            observedCodexTokens: 48_000,
            taskOutcome: "pass",
            summary: "active rescue",
            metadata: { primeEmitted: 1 }
          }),
          id: 4,
          createdAt: "now"
        }
      ]
    });

    const comparison = compareBenchmarkReports(before, after);

    expect(comparison.behaviorTargetSummary).toMatchObject({
      cheap_single_source: { cases: 1, met: 1, missed: 0 },
      source_rescue: { cases: 1, met: 1, missed: 0 }
    });
    expect(comparison.caseBehaviorOutcomes?.map((item) => [item.caseId, item.outcome])).toEqual([
      ["cheap", "met"],
      ["rescue", "met"]
    ]);
  });

  it("marks weak-signal emission and under-saving source rescue as missed behavior targets", () => {
    const weakCase = {
      id: "weak",
      mode: "agent" as const,
      task: "Improve stuff",
      contextBehavior: "weak_signal" as const,
      expectedFiles: [],
      excludedFiles: []
    };
    const rescueCase = {
      id: "rescue-low",
      mode: "agent" as const,
      task: "Debug hidden source routing",
      contextBehavior: "source_rescue" as const,
      expectedFiles: ["src/router.ts"],
      excludedFiles: []
    };
    const before = buildBenchmarkReport({
      run: { id: "before", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [
        { ...scoreBenchmarkCase({ runId: "before", benchmarkCase: weakCase, actualFiles: [], responseTokens: 100, observedCodexTokens: 2000, taskOutcome: "pass", summary: "baseline weak" }), id: 1, createdAt: "now" },
        { ...scoreBenchmarkCase({ runId: "before", benchmarkCase: rescueCase, actualFiles: ["src/router.ts"], responseTokens: 100, observedCodexTokens: 60_000, taskOutcome: "pass", summary: "baseline rescue" }), id: 2, createdAt: "now" }
      ]
    });
    const after = buildBenchmarkReport({
      run: { id: "after", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [
        { ...scoreBenchmarkCase({ runId: "after", benchmarkCase: weakCase, actualFiles: [], responseTokens: 100, observedCodexTokens: 2100, taskOutcome: "pass", summary: "active weak", metadata: { primeEmitted: 1 } }), id: 3, createdAt: "now" },
        { ...scoreBenchmarkCase({ runId: "after", benchmarkCase: rescueCase, actualFiles: ["src/router.ts"], responseTokens: 100, observedCodexTokens: 56_000, taskOutcome: "pass", summary: "under-saving rescue", metadata: { primeEmitted: 1 } }), id: 4, createdAt: "now" }
      ]
    });

    const comparison = compareBenchmarkReports(before, after);

    expect(comparison.behaviorTargetSummary).toMatchObject({
      weak_signal: { cases: 1, met: 0, missed: 1 },
      source_rescue: { cases: 1, met: 0, missed: 1 }
    });
    expect(comparison.recommendations).toEqual(
      expect.arrayContaining([
        "weak: weak_signal target missed - Kairn emitted context for a weak-signal case that should usually stay silent.",
        "rescue-low: source_rescue target missed - Kairn did not meet the 15% source rescue savings target."
      ])
    );
  });

  it("treats numeric prime metrics as active assistance", () => {
    const benchmarkCase = {
      id: "numeric-prime",
      mode: "agent" as const,
      task: "Fix bug",
      expectedFiles: ["src/app.ts"],
      excludedFiles: []
    };
    const beforeResult = scoreBenchmarkCase({
      runId: "before",
      benchmarkCase,
      actualFiles: ["src/app.ts"],
      responseTokens: 100,
      observedCodexTokens: 2000,
      taskOutcome: "pass",
      summary: "baseline"
    });
    const afterResult = scoreBenchmarkCase({
      runId: "after",
      benchmarkCase,
      actualFiles: ["src/app.ts"],
      responseTokens: 100,
      observedCodexTokens: 1500,
      taskOutcome: "pass",
      summary: "hook",
      metadata: { primeEmitted: 1 }
    });
    const before = buildBenchmarkReport({
      run: { id: "before", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [{ ...beforeResult, id: 1, createdAt: "now" }]
    });
    const after = buildBenchmarkReport({
      run: { id: "after", rootPath: "/repo", suiteId: "suite", suiteName: "suite", mode: "agent", status: "completed", startedAt: "now", metadata: {} },
      results: [{ ...afterResult, id: 2, createdAt: "now" }]
    });

    expect(compareBenchmarkReports(before, after).observedTokenDelta).toMatchObject({
      assistanceStatus: "active",
      assistanceEligible: true,
      validSavings: 500
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
    expect(prime.content).toContain("Edit scope");
    expect(prime.editScope?.initialEditFiles).toEqual(["src/click/_compat.py"]);
    expect(prime.content).toContain("visible terminal text length");
    expect(prime.content).toContain("Stop condition");
    expect(prime.tokenEstimate).toBeLessThanOrEqual(900);

    runtime.close();
  });

  it("caps structured debug multi-file primes at two production files", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "qutebrowser/utils"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "qutebrowser/utils/log.py"),
      [
        "from contextlib import contextmanager",
        "",
        "@contextmanager",
        "def hide_qt_warning(pattern, logger='qt'):",
        "    yield",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "qutebrowser/utils/qtlog.py"),
      [
        "import logging",
        "",
        "class QtWarningFilter(logging.Filter):",
        "    def filter(self, record):",
        "        return True",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "qutebrowser/utils/utils.py"),
      [
        "def message_filter_warning_helper(value):",
        "    return value.strip()",
        ""
      ].join("\n")
    );
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: [
        "# Qt warning filtering tests moved to appropriate module",
        "Requirements:",
        "- The hide_qt_warning context manager should continue to operate with identical filtering behavior after relocation from log.py to qtlog.py.",
        "- QtWarningFilter should suppress matching warnings without changing unrelated log behavior.",
        "Selected tests from SWE-Bench Pro metadata: tests/unit/utils/test_log.py, tests/unit/utils/test_qtlog.py",
        "Fix the issue in production source. Do not edit unrelated files. Avoid broad scans once the relevant source surface is known."
      ].join("\n"),
      profile: "failure_debug",
      budget: 900
    });

    expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
    expect(prime.files).toHaveLength(2);
    expect(prime.files).toEqual(expect.arrayContaining(["qutebrowser/utils/log.py", "qutebrowser/utils/qtlog.py"]));
    expect(prime.files).not.toContain("qutebrowser/utils/utils.py");
    expect(prime.editScope?.initialEditFiles).toEqual(expect.arrayContaining(["qutebrowser/utils/log.py", "qutebrowser/utils/qtlog.py"]));

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

  it("prefers current source invariant metadata over stale session task text in exact-source primes", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "src/requests"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/requests/sessions.py"),
      [
        "class Session:",
        "    def send(self, request, **kwargs):",
        "        allow_redirects = kwargs.pop('allow_redirects', True)",
        "        if allow_redirects:",
        "            return self.resolve_redirects(request)",
        "        return request",
        ""
      ].join("\n")
    );
    const runtime = new KairnRuntime(root);
    await runtime.init();
    const session = (await runtime.startTask("Debug, fix, verify, and preserve a Requests allow_redirects regression across ten turns.")).session;

    const prime = await runtime.primeContext({
      sessionId: session.id,
      task: "Fix the seeded Requests redirect regression in production source only. Keep edits inside src/requests/sessions.py.",
      budget: 900,
      editScopeHints: {
        sourceInvariants: [
          {
            id: "session-send-honors-allow-redirects",
            file: "src/requests/sessions.py",
            description: "Session.send must resolve redirects when allow_redirects is true.",
            requiredPresent: ["if allow_redirects:"],
            requiredAbsent: ["if False and allow_redirects:"]
          }
        ]
      }
    });

    expect(prime.contextDecision?.exactSourceHit).toBe(true);
    expect(prime.invariants?.[0]?.statement).toBe("Session.send must resolve redirects when allow_redirects is true.");
    expect(prime.content).toContain("Session.send must resolve redirects when allow_redirects is true.");
    expect(prime.content).not.toContain("Debug, fix, verify");

    runtime.close();
  });

  it("keeps invariant and scope guidance ahead of optional snippets in compact multi-file primes", () => {
    const clientFile = "packages/vite/src/client/client.ts";
    const helperFile = "packages/vite/src/shared/utils.ts";
    const content = formatShrunkPrimeContext({
      task: "Debug injectQuery URL handling. External URLs should be skipped, but ./dep.js and /src/main.ts must receive the injected query.",
      sessionId: "task_test",
      profile: "failure_debug",
      quality: {
        score: 91,
        action: "shrink",
        reasons: ["strong source and companion evidence"],
        topScore: 1800,
        topGap: 70,
        exactPathMentioned: false,
        expectedSavingsRisk: "low"
      },
      context: {
        mode: "snippets",
        files: [clientFile, helperFile],
        suggestedNextContext: [clientFile, helperFile],
        related: [helperFile],
        symbols: [],
        warnings: [],
        rankedFiles: [],
        tokenEstimate: 1000,
        content: [
          "## Matched Snippets",
          `- ${clientFile} (source, score 1800): injectQuery URL handling`,
          `- ${helperFile} (source, score 1100): URL helper companion`,
          "const repeated = 'focused snippet that is intentionally long enough to be optional';".repeat(20)
        ].join("\n")
      },
      files: [clientFile, helperFile],
      budget: 260,
      invariants: [
        {
          file: clientFile,
          statement: "External URLs must be skipped, but relative and absolute local URLs must receive the injected query.",
          confidence: 86,
          source: "seed"
        }
      ],
      editScope: {
        initialEditFiles: [clientFile, helperFile],
        readOnlyFiles: [],
        allowedExpansionTriggers: ["verification names another production file"],
        forbiddenEditPatterns: ["tests", "docs", "generated", "vendor"],
        scopeConfidence: "high",
        scopeSource: "multi_file_debug",
        reason: "Two production files carry the source and helper behavior.",
        dynamic: true
      }
    });

    expect(content).toContain("Invariant to preserve:");
    expect(content).toContain("- External URLs must be skipped");
    expect(content).toContain("Stop condition:");
    expect(content).toContain("Edit scope:");
    const snippetIndex = content.indexOf("Focused context:");
    if (snippetIndex >= 0) {
      expect(content.indexOf("Invariant to preserve:")).toBeLessThan(snippetIndex);
    }
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
          "--no-progress",
          "--json"
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as {
      observedTokenDeltas: { proactiveVsBaseline?: { beforeTokens: number; afterTokens: number; savedTokens: number } };
      aggregate?: { repeat: number; deltas: { manualPrimeVsBaseline?: { savedTokens?: number; savingsRate?: number } } };
      caseRepeatClassifications?: Array<{
        mode: string;
        caseId: string;
        repeats: number;
        verdict: string;
        medianSavedTokens?: number;
      }>;
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
    expect(proof.hybridMcpBrief?.results[0]?.metadata.mcpFirstInstructionsPrepended).toBe(false);
    expect(proof.hybridMcpBrief?.results[0]?.metadata.hybridMcpInstructionsConditional).toBe(true);
    expect(proof.hybridMcpBrief?.results[0]?.observedCodexTokens).toBe(3000);
    expect(proof.aggregate?.repeat).toBe(2);
    expect(proof.aggregate?.deltas.manualPrimeVsBaseline?.savedTokens).toBe(2000);
    expect(proof.caseRepeatClassifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: "manual_prime",
          caseId: "agent-mobile",
          repeats: 2,
          verdict: "consistent_win",
          medianSavedTokens: 2000
        })
      ])
    );
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
    ) as { args: string[]; prompt: string; prime: { files: string[] }; sessionId: string };
    const boundDryRun = JSON.parse(
      execFileSync(
        CLI[0]!,
        [
          ...CLI.slice(1),
          "codex",
          "Improve job tracker mobile layout bottom sheet behavior",
          "--root",
          root,
          "--session",
          dryRun.sessionId,
          "--bind-hooks",
          "--dry-run",
          "--json"
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as { args: string[]; prompt: string; sessionId: string; hookBinding: { dryRun: boolean; sessionId: string; mode: string } };
    const interactiveDryRun = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "codex", "--root", root, "--dry-run", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { args: string[]; mode: string; prompt?: string; sessionId: string; hookBinding: { dryRun: boolean; sessionId: string } };

    expect(instructions).toContain("# Existing Instructions");
    expect(instructions.match(/kairn:mcp-first:start/g)?.length).toBe(1);
    expect(dryRun.args[0]).toBe("exec");
    expect(dryRun.args).toContain("--disable");
    expect(dryRun.args).toContain("hooks");
    expect(dryRun.args).not.toContain("--enable");
    expect(dryRun.prompt).toContain("Kairn Proactive Context");
    expect(dryRun.prompt).toContain("User task:");
    expect(dryRun.prime.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
    expect(boundDryRun.sessionId).toBe(dryRun.sessionId);
    expect(boundDryRun.args).toContain("--enable");
    expect(boundDryRun.args).toContain("hooks");
    expect(boundDryRun.prompt).toContain(`Kairn conversation session: ${dryRun.sessionId}`);
    expect(boundDryRun.hookBinding.dryRun).toBe(true);
    expect(boundDryRun.hookBinding.sessionId).toBe(dryRun.sessionId);
    expect(interactiveDryRun.mode).toBe("interactive");
    expect(interactiveDryRun.args).not.toContain("exec");
    expect(interactiveDryRun.args).toContain("--enable");
    expect(interactiveDryRun.args).toContain("hooks");
    expect(interactiveDryRun.args).toContain("--cd");
    expect(interactiveDryRun.prompt).toBeUndefined();
    expect(interactiveDryRun.hookBinding.sessionId).toBe(interactiveDryRun.sessionId);

    const codexDir = path.join(root, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "config.toml"), "[features]\ncodex_hooks = false\n");
    fs.writeFileSync(path.join(codexDir, "hooks.json"), "{\"hooks\":{}}\n");
    execFileSync(
      CLI[0]!,
      [
        ...CLI.slice(1),
        "codex",
        "Improve job tracker mobile layout bottom sheet behavior",
        "--root",
        root,
        "--bind-hooks",
        "--codex-command",
        "true"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8")).toBe("[features]\ncodex_hooks = false\n");
    expect(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8")).toBe("{\"hooks\":{}}\n");
  });
});

function publicationRow(overrides: Partial<PublicationResultRow>): PublicationResultRow {
  return {
    entryId: "entry",
    kind: "proof",
    repoId: "fixture",
    language: "typescript",
    sizeClass: "small",
    taskClass: "source_rescue",
    behavior: "source_rescue",
    mode: "baseline",
    qualityPassed: true,
    validSavings: 0,
    passiveSavings: 0,
    invalidSavings: 0,
    active: false,
    claimEligible: false,
    mcpCalls: 0,
    repeatedFilesAvoided: 0,
    repeatedSnippetsAvoided: 0,
    scopeViolations: 0,
    overAssist: false,
    harmfulAssist: false,
    missedOpportunity: false,
    correctAbstention: false,
    requestEvidence: false,
    ...overrides
  };
}

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

function sourceRecord(path: string, language: string): FileRecord {
  return {
    rootPath: "/repo",
    path,
    language,
    kind: "source",
    size: 100,
    hash: path,
    importance: 1,
    updatedAt: "now"
  };
}

function scoredRecord(file: FileRecord): HybridScoredResult {
  return {
    ...file,
    score: 1000,
    reasons: ["seed"],
    semanticScore: 0,
    keywordScore: 0,
    bm25Score: 0,
    behaviorScore: 0,
    graphScore: 0,
    intentScore: 0,
    sessionScore: 0,
    importanceScore: file.importance,
    gitScore: 0,
    chunks: []
  };
}

function chunkRecord(filePath: string, symbolName: string, text: string): SemanticChunkRecord {
  return {
    rootPath: "/repo",
    id: `${filePath}:${symbolName}`,
    filePath,
    kind: "symbol",
    symbol: symbolName,
    startLine: 1,
    endLine: 5,
    text,
    tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
    hash: `${filePath}:${symbolName}`
  };
}
