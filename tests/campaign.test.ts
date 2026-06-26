import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupCampaign,
  runCampaign,
  runCampaignTaskPool,
  summarizeCampaign,
  validateCampaignManifest,
  type CampaignManifest
} from "../src/bench/campaign.js";
import { createFixtureRepo } from "./helpers.js";

describe("benchmark campaign harness", () => {
  it("rejects duplicate entry ids and unsupported modes", () => {
    expect(() =>
      validateCampaignManifest({
        id: "bad",
        name: "Bad",
        entries: [
          { id: "same", kind: "proxy", task: "Find src/app.ts" },
          { id: "same", kind: "proxy", task: "Find src/user.ts" }
        ]
      })
    ).toThrow(/Duplicate campaign entry id/);

    expect(() =>
      validateCampaignManifest({
        id: "bad-mode",
        name: "Bad Mode",
        entries: [
          {
            id: "bad-mode-entry",
            kind: "proof",
            suite: "suite.json",
            modes: ["baseline", "not_a_mode"] as unknown as CampaignManifest["entries"][number]["modes"]
          }
        ]
      })
    ).toThrow(/unsupported campaign mode/);
  });

  it("writes dry-run artifacts without executing entries", async () => {
    const root = createFixtureRepo();
    const dir = tempDir("kairn-campaign-dry-");
    const manifestPath = writeManifest(dir, {
      id: "dry",
      name: "Dry Campaign",
      entries: [
        {
          id: "dry-proxy",
          kind: "proxy",
          root,
          task: "Fix src/app.ts without broad context.",
          budget: 700
        },
        {
          id: "dry-live-control",
          kind: "control",
          root,
          suite: "examples/bench/campaign-fixtures/mock-suite.json",
          modes: ["baseline", "kairn_codex_session"]
        }
      ]
    });

    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "proxy",
      dryRun: true
    });

    expect(report.dryRun).toBe(true);
    expect(report.artifacts).toHaveLength(1);
    expect(report.artifacts[0]?.entryId).toBe("dry-proxy");
    expect(report.artifacts[0]?.status).toBe("planned");
    expect(fs.existsSync(report.outputs.summaryPath)).toBe(true);
    expect(fs.existsSync(report.outputs.resultsCsvPath)).toBe(true);
    expect(fs.existsSync(report.outputs.proxyResultsCsvPath)).toBe(true);

    const summaryText = fs.readFileSync(report.outputs.summaryPath, "utf8");
    const summary = JSON.parse(summaryText) as typeof report;
    expect(summaryText).not.toContain("/Users/");
    expect(summary.artifacts[0]?.commands).toEqual([]);
    expect(summary.artifacts[0]).not.toHaveProperty("report");
    expect(summary.outputs.summaryPath).toBe("campaign-summary.json");
  });

  it("runs proxy entries and resumes completed proxy artifacts", async () => {
    const root = createFixtureRepo();
    const dir = tempDir("kairn-campaign-proxy-");
    const outDir = path.join(dir, "out");
    const manifestPath = writeManifest(dir, {
      id: "proxy",
      name: "Proxy Campaign",
      entries: [
        {
          id: "proxy-app",
          kind: "proxy",
          root,
          task: "Fix src/app.ts dashboard rendering without touching tests.",
          budget: 700
        }
      ]
    });

    const first = await runCampaign({ manifestPath, outDir, stage: "proxy" });
    expect(first.artifacts[0]?.status).toBe("passed");
    expect(first.artifacts[0]?.classifications.length).toBeGreaterThan(0);

    const second = await runCampaign({ manifestPath, outDir, stage: "proxy", resume: true });
    expect(second.artifacts[0]?.status).toBe("passed");
    expect(second.rows[0]?.entryId).toBe("proxy-app");
  });

  it("serializes proxy-only campaigns because proxy runtime work is CPU-bound in-process", async () => {
    const root = createFixtureRepo();
    const dir = tempDir("kairn-campaign-proxy-parallel-");
    const manifestPath = writeManifest(dir, {
      id: "proxy-parallel",
      name: "Proxy Parallel Campaign",
      entries: [
        {
          id: "proxy-app",
          kind: "proxy",
          root,
          task: "Fix src/app.ts dashboard rendering without touching tests.",
          budget: 700
        },
        {
          id: "proxy-user",
          kind: "proxy",
          root,
          task: "Fix src/user.ts parsing without touching tests.",
          budget: 700
        }
      ]
    });

    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "proxy",
      parallel: 3,
      dryRun: true
    });

    expect(report.parallel).toBe(1);
    expect(report.artifacts).toHaveLength(2);
  });

  it("runs the mock live fixture campaign and records clean savings rows", async () => {
    const dir = tempDir("kairn-campaign-live-");
    const manifestPath = path.resolve("examples/bench/campaign-fixtures/mock-live-campaign.json");
    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "live",
      parallel: 3
    });

    expect(report.artifacts).toHaveLength(3);
    expect(report.aggregate.failedEntries).toBe(0);
    expect(report.aggregate.cleanPassPassRows).toBeGreaterThanOrEqual(1);
    expect(report.aggregate.medianSavedTokens).toBeGreaterThan(0);
    expect(report.artifacts.every((artifact) => artifact.workspacePaths.length > 0)).toBe(true);
    expect(report.artifacts.flatMap((artifact) => artifact.workspacePaths).every((workspace) => !fs.existsSync(workspace))).toBe(true);
    const rawFiles = fs.readdirSync(path.join(dir, "out", "raw"));
    expect(rawFiles.some((file) => file.endsWith(".partial.json"))).toBe(false);
  });

  it("runs SWE-style proof campaigns with MCP modes and records useful attribution", async () => {
    const dir = tempDir("kairn-campaign-swe-mcp-");
    const root = createFixtureRepo();
    const suitePath = path.join(dir, "swe-mcp-suite.json");
    const baselineScriptPath = path.join(dir, "baseline-agent.cjs");
    const mcpScriptPath = path.join(dir, "mcp-agent.cjs");
    fs.writeFileSync(
      suitePath,
      `${JSON.stringify(
        {
          id: "swe-mcp-suite",
          name: "SWE MCP Suite",
          cases: [
            {
              id: "swe-mcp-row",
              mode: "agent",
              task: "Fix the SWE-style source row in src/app.ts.",
              agentPrompt: "Fix the SWE-style source row in src/app.ts.",
              expectedFiles: ["src/app.ts"],
              requiredTouchedFiles: ["src/app.ts"],
              excludedFiles: [],
              allowedDiffScopes: [{ file: "src/app.ts", allowWholeFile: true }],
              seed: {
                repoUrl: root,
                ref: "HEAD"
              }
            }
          ]
        },
        null,
        2
      )}\n`
    );
    fs.writeFileSync(
      baselineScriptPath,
      [
        "const fs = require('fs');",
        "fs.appendFileSync('src/app.ts', '\\nexport const sweBaseline = true;\\n');",
        "console.log('src/app.ts');",
        "console.log('tokens used 1000');"
      ].join("\n")
    );
    fs.writeFileSync(
      mcpScriptPath,
      [
        "const fs = require('fs');",
        "const Database = require('better-sqlite3');",
        "const tokens = process.argv[2] || '650';",
        "fs.mkdirSync('.kairn', { recursive: true });",
        "const db = new Database('.kairn/kairn.sqlite');",
        "db.exec(`create table if not exists metrics_events (id integer primary key autoincrement, session_id text not null, root_path text not null, event_kind text not null, event_name text not null, source text not null, response_mode text, baseline_tokens integer not null, output_tokens integer not null, saved_tokens integer not null, files_json text not null, metadata_json text not null default '{}', created_at text not null)`);",
        "db.prepare(`insert into metrics_events (session_id, root_path, event_kind, event_name, source, response_mode, baseline_tokens, output_tokens, saved_tokens, files_json, metadata_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('task_swe_mcp', process.cwd(), 'mcp_tool_call', 'kairn_prepare_task', 'mcp', null, 100, 25, 75, JSON.stringify(['src/app.ts']), JSON.stringify({ toolName: 'kairn_prepare_task' }), new Date().toISOString());",
        "db.close();",
        "fs.appendFileSync('src/app.ts', '\\nexport const sweMcp = true;\\n');",
        "console.log('src/app.ts');",
        "console.log(`tokens used ${tokens}`);"
      ].join("\n")
    );
    const manifestPath = writeManifest(dir, {
      id: "swe-mcp-campaign",
      name: "SWE MCP Campaign",
      defaults: {
        agentTimeoutMs: 10000,
        cleanup: "always",
        commands: {
          baseline: `node ${quoteShell(baselineScriptPath)}`,
          real_mcp_first: `NODE_PATH=${quoteShell(path.resolve("node_modules"))} node ${quoteShell(mcpScriptPath)} 650`,
          hybrid_mcp_brief: `NODE_PATH=${quoteShell(path.resolve("node_modules"))} node ${quoteShell(mcpScriptPath)} 700`
        }
      },
      entries: [
        {
          id: "swe-mcp-row",
          kind: "proof",
          tags: ["swe-pro", "mcp", "harness-control"],
          root,
          suite: suitePath,
          modes: ["baseline", "real_mcp_first", "hybrid_mcp_brief"],
          repeat: 1
        }
      ]
    });

    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "live",
      parallel: 1
    });

    const row = report.rows[0];
    expect(report.aggregate.failedEntries).toBe(0);
    expect(row?.qualityPassed).toBe(true);
    expect(row?.mcpCalls).toBeGreaterThanOrEqual(2);
    expect(row?.mcpUsefulAttribution).toBeGreaterThanOrEqual(2);
    expect(row?.classifications).toContain("mcp_useful_attribution");
    expect(report.artifacts[0]?.officialPatchPaths?.real_mcp_first).toBeTruthy();
    expect(report.artifacts[0]?.officialPatchPaths?.hybrid_mcp_brief).toBeTruthy();

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("carries proof diff-scope violations into campaign summary metrics", async () => {
    const dir = tempDir("kairn-campaign-proof-scope-");
    const root = createFixtureRepo();
    const suitePath = path.join(dir, "suite.json");
    fs.writeFileSync(
      suitePath,
      `${JSON.stringify(
        {
          id: "scope-suite",
          name: "Scope Suite",
          cases: [
            {
              id: "scope-row",
              mode: "agent",
              task: "Edit only src/app.ts.",
              expectedFiles: ["src/app.ts"],
              requiredTouchedFiles: ["src/app.ts"],
              excludedFiles: [],
              allowedDiffScopes: [{ file: "src/app.ts", allowWholeFile: true }],
              seed: {
                repoUrl: root,
                ref: "HEAD"
              }
            }
          ]
        },
        null,
        2
      )}\n`
    );
    const manifestPath = writeManifest(dir, {
      id: "proof-scope-summary",
      name: "Proof Scope Summary",
      defaults: {
        agentTimeoutMs: 10000,
        cleanup: "always",
        commands: {
          baseline:
            "node -e \"const fs=require('fs'); fs.appendFileSync('src/app.ts', '\\nexport const ok = true;\\n'); console.log('src/app.ts'); console.log('tokens used 1000')\"",
          kairn_codex_session:
            "node -e \"const fs=require('fs'); fs.appendFileSync('src/app.ts', '\\nexport const ok = true;\\n'); fs.writeFileSync('src/user.ts', 'export const drift = true;\\n'); console.log('src/app.ts'); console.log('src/user.ts'); console.log('tokens used 700')\""
        }
      },
      entries: [
        {
          id: "scope-row",
          kind: "proof",
          root,
          suite: suitePath,
          modes: ["baseline", "kairn_codex_session"],
          repeat: 1
        }
      ]
    });

    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "live",
      parallel: 1
    });

    expect(report.rows[0]?.scopeViolations).toBeGreaterThan(0);
    expect(report.rows[0]?.classifications).toContain("scope_violation");
    expect(report.aggregate.scopeViolations).toBeGreaterThan(0);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reuses cached baseline reports for Kairn-only live reruns", async () => {
    const dir = tempDir("kairn-campaign-baseline-cache-");
    const markerPath = path.join(dir, "baseline-runs.txt");
    const outDir = path.join(dir, "out");
    const baselineCommand = [
      "node -e",
      quoteShell(`require("fs").appendFileSync(${JSON.stringify(markerPath)}, "x"); console.log("src/app.ts"); console.log("tokens used 1000");`)
    ].join(" ");
    const manifestPath = writeManifest(dir, {
      id: "baseline-cache",
      name: "Baseline Cache",
      defaults: {
        agentTimeoutMs: 10000,
        cleanup: "always",
        commands: {
          baseline: baselineCommand,
          kairn_codex_session: 'node -e "console.log(\'src/app.ts\'); console.log(\'tokens used 700\')"'
        }
      },
      entries: [
        {
          id: "cache-row",
          kind: "proof",
          root: "examples/bench/campaign-fixtures/mock-repo",
          suite: "examples/bench/campaign-fixtures/mock-suite.json",
          modes: ["baseline", "kairn_codex_session"],
          repeat: 1
        }
      ]
    });

    const first = await runCampaign({ manifestPath, outDir, stage: "live" });
    expect(first.aggregate.failedEntries).toBe(0);
    expect(fs.readFileSync(markerPath, "utf8")).toBe("x");
    expect(fs.readdirSync(first.outputs.baselineCacheDir).some((file) => file.endsWith(".baseline.json"))).toBe(true);

    const second = await runCampaign({
      manifestPath,
      outDir,
      stage: "live",
      kairnOnlyAgainstBaseline: true
    });

    expect(second.aggregate.failedEntries).toBe(0);
    expect(fs.readFileSync(markerPath, "utf8")).toBe("x");
    expect(second.artifacts[0]?.classifications).toContain("clean_passpass");
  });

  it("fails fast when Kairn-only live reruns do not have cached baselines", async () => {
    const dir = tempDir("kairn-campaign-missing-baseline-cache-");
    const manifestPath = writeManifest(dir, {
      id: "missing-baseline-cache",
      name: "Missing Baseline Cache",
      defaults: {
        agentTimeoutMs: 10000,
        cleanup: "always",
        commands: {
          baseline: 'node -e "console.log(\'src/app.ts\'); console.log(\'tokens used 1000\')"',
          kairn_codex_session: 'node -e "console.log(\'src/app.ts\'); console.log(\'tokens used 700\')"'
        }
      },
      entries: [
        {
          id: "cache-row",
          kind: "proof",
          root: "examples/bench/campaign-fixtures/mock-repo",
          suite: "examples/bench/campaign-fixtures/mock-suite.json",
          modes: ["baseline", "kairn_codex_session"],
          repeat: 1
        }
      ]
    });

    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "live",
      kairnOnlyAgainstBaseline: true
    });

    expect(report.aggregate.failedEntries).toBe(1);
    expect(report.artifacts[0]?.error).toMatch(/missing cached baseline artifact/);
  });

  it("flags passing proof rows with missing comparable token data", async () => {
    const dir = tempDir("kairn-campaign-token-unavailable-");
    const manifestPath = writeManifest(dir, {
      id: "token-unavailable",
      name: "Token Unavailable",
      defaults: {
        agentTimeoutMs: 10000,
        cleanup: "always",
        commands: {
          baseline: 'node -e "console.log(\'src/app.ts\')"',
          kairn_codex_session: 'node -e "console.log(\'src/app.ts\'); console.log(\'tokens used 700\')"'
        }
      },
      entries: [
        {
          id: "token-row",
          kind: "proof",
          root: "examples/bench/campaign-fixtures/mock-repo",
          suite: "examples/bench/campaign-fixtures/mock-suite.json",
          modes: ["baseline", "kairn_codex_session"],
          repeat: 1
        }
      ]
    });

    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "live",
      parallel: 1
    });

    expect(report.rows[0]?.qualityPassed).toBe(true);
    expect(report.rows[0]?.classifications).toContain("official_pass_token_unavailable");
    expect(fs.readFileSync(report.outputs.failuresCsvPath, "utf8")).toContain("official_pass_token_unavailable");
  });

  it("records timeout-estimated token accounting separately from observed token data", async () => {
    const dir = tempDir("kairn-campaign-timeout-estimated-");
    const timeoutCommand = [
      "node -e",
      quoteShell(
        "const fs=require('fs'); fs.appendFileSync('src/app.ts', '\\nexport const timeoutEstimate = true;\\n'); console.log('src/app.ts'); setTimeout(()=>{}, 5000);"
      )
    ].join(" ");
    const manifestPath = writeManifest(dir, {
      id: "timeout-estimated",
      name: "Timeout Estimated",
      defaults: {
        agentTimeoutMs: 80,
        cleanup: "always",
        commands: {
          baseline: timeoutCommand,
          kairn_codex_session: timeoutCommand
        }
      },
      entries: [
        {
          id: "timeout-row",
          kind: "proof",
          root: "examples/bench/campaign-fixtures/mock-repo",
          suite: "examples/bench/campaign-fixtures/mock-suite.json",
          modes: ["baseline", "kairn_codex_session"],
          repeat: 1
        }
      ]
    });

    const report = await runCampaign({
      manifestPath,
      outDir: path.join(dir, "out"),
      stage: "live",
      parallel: 1
    });

    const row = report.rows[0];
    expect(row?.qualityPassed).toBe(true);
    expect(row?.classifications).toContain("timeout_pass_estimated_tokens");
    expect(row?.classifications).not.toContain("official_pass_token_unavailable");
    expect(row?.tokenAccounting).toBe("timeout_estimate");
    expect(row?.observedTokens).toBeUndefined();
    expect(row?.baselineTokens).toBeUndefined();
    expect(row?.estimatedObservedTokens).toBeGreaterThan(0);
    expect(row?.estimatedBaselineTokens).toBeGreaterThan(0);
    expect(report.aggregate.medianSavedTokens).toBe(0);
    expect(fs.readFileSync(report.outputs.failuresCsvPath, "utf8")).toContain("timeout_pass_estimated_tokens");
  });

  it("limits campaign worker concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 6 }, (_, index) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return index;
    });

    const startedAt = Date.now();
    const result = await runCampaignTaskPool(tasks, 3);

    expect(result).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(Date.now() - startedAt).toBeLessThan(220);
  });

  it("cleans only campaign-created disposable workspaces", () => {
    const dir = tempDir("kairn-campaign-cleanup-");
    const workDir = path.join(dir, "work");
    const campaignWorkspace = path.join(workDir, "campaign-one");
    const unrelatedWorkspace = path.join(workDir, "other");
    fs.mkdirSync(campaignWorkspace, { recursive: true });
    fs.mkdirSync(unrelatedWorkspace, { recursive: true });

    const dryRun = cleanupCampaign(dir, { dryRun: true });
    expect(dryRun.removed).toEqual([campaignWorkspace]);
    expect(fs.existsSync(campaignWorkspace)).toBe(true);

    const cleaned = cleanupCampaign(dir);
    expect(cleaned.removed).toEqual([campaignWorkspace]);
    expect(fs.existsSync(campaignWorkspace)).toBe(false);
    expect(fs.existsSync(unrelatedWorkspace)).toBe(true);
  });

  it("does not pause on repeated quality rescues", () => {
    const dir = tempDir("kairn-campaign-quality-rescue-");
    const outDir = path.join(dir, "out");
    const rawDir = path.join(outDir, "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "campaign-manifest.json"),
      `${JSON.stringify(
        {
          id: "quality-rescue",
          name: "Quality Rescue",
          pauseRules: {
            maxRepeatedFailureClass: 1,
            maxTokenRegressionClass: 0
          },
          entries: [
            { id: "rescue-a", kind: "proof", suite: "suite-a.json" },
            { id: "rescue-b", kind: "proof", suite: "suite-b.json" }
          ]
        },
        null,
        2
      )}\n`
    );

    for (const entryId of ["rescue-a", "rescue-b"]) {
      writeRawArtifact(rawDir, entryId, {
        qualityPassed: true,
        qualityRescue: true,
        baselineTokens: 100,
        observedTokens: 150,
        savedTokens: -50,
        savingsRate: -0.5
      });
    }

    const report = summarizeCampaign(outDir);

    expect(report.aggregate.qualityRescueRows).toBe(2);
    expect(report.aggregate.tokenRegressionRows).toBe(0);
    expect(report.aggregate.repeatedFailureClasses).toEqual([]);
    expect(report.paused).toBe(false);
    expect(report.pauseReasons).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(dir: string, manifest: CampaignManifest): string {
  const manifestPath = path.join(dir, "campaign.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeRawArtifact(
  rawDir: string,
  entryId: string,
  metrics: Partial<{
    qualityPassed: boolean;
    cleanPassPass: boolean;
    tokenRegression: boolean;
    qualityDrop: boolean;
    qualityRescue: boolean;
    harmfulAssist: boolean;
    scopeViolations: number;
    mcpCalls: number;
    mcpUsefulAttribution: number;
    elapsedMs: number;
    observedTokens: number;
    baselineTokens: number;
    savedTokens: number;
    savingsRate: number;
  }>
): void {
  const fullMetrics = {
    qualityPassed: false,
    cleanPassPass: false,
    tokenRegression: false,
    qualityDrop: false,
    qualityRescue: false,
    harmfulAssist: false,
    scopeViolations: 0,
    mcpCalls: 0,
    mcpUsefulAttribution: 0,
    elapsedMs: 1,
    ...metrics
  };
  const classifications = [
    fullMetrics.cleanPassPass ? "clean_passpass" : undefined,
    fullMetrics.tokenRegression ? "official_token_regression" : undefined,
    fullMetrics.qualityDrop ? "quality_drop" : undefined,
    fullMetrics.qualityRescue ? "quality_rescue" : undefined,
    fullMetrics.harmfulAssist ? "harmful_invalid_assist" : undefined,
    fullMetrics.scopeViolations > 0 ? "scope_violation" : undefined,
    !fullMetrics.qualityPassed ? "quality_incomplete" : undefined
  ].filter(Boolean);

  fs.writeFileSync(
    path.join(rawDir, `${entryId}.json`),
    `${JSON.stringify(
      {
        entryId,
        kind: "proof",
        stage: "live",
        status: "passed",
        tags: [],
        startedAt: new Date(0).toISOString(),
        endedAt: new Date(0).toISOString(),
        artifactPath: path.join(rawDir, `${entryId}.json`),
        commands: [],
        classifications,
        workspacePaths: [],
        metrics: fullMetrics
      },
      null,
      2
    )}\n`
  );
}
