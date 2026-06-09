import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupCampaign,
  runCampaign,
  runCampaignTaskPool,
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
});

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(dir: string, manifest: CampaignManifest): string {
  const manifestPath = path.join(dir, "campaign.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}
