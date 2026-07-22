// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexPilot } from "../src/bench/codexPilot.js";
import { buildCodexPilotSchedule, CODEX_PILOT_PIN, loadCodexPilotPlan } from "../src/bench/codexPilotPlan.js";
import { codexThreadId, observedCodexUsage, parseCodexJsonl } from "../src/bench/codexPilotUsage.js";

describe("ecological Codex pilot", () => {
  it("keeps the checked-in 5x3 task-curation registry parseable and complete", () => {
    const registry = JSON.parse(fs.readFileSync(
      path.resolve("benchmarks/plans/codex-v02c.task-curation.json"),
      "utf8"
    )) as {
      schemaVersion: string;
      status: string;
      smoke: Array<{ status: string }>;
      pilot: Array<{ language: string; scenario: string; status: string }>;
    };

    expect(registry).toMatchObject({
      schemaVersion: "codex-pilot-task-curation.v1",
      status: "curation"
    });
    expect(registry.smoke).toHaveLength(1);
    expect(registry.smoke.every((task) => task.status === "unsealed")).toBe(true);
    expect(registry.pilot).toHaveLength(15);
    expect(new Set(registry.pilot.map((task) => `${task.language}/${task.scenario}`)).size).toBe(15);
  });

  it("parses only completed-turn observed usage and preserves reasoning tokens", () => {
    const events = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", usage: { input_tokens: 999, output_tokens: 999 } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 30, reasoning_tokens: 12, total_tokens: 150 }
      })
    ].join("\n"), 1);

    expect(codexThreadId(events)).toBe("thread-1");
    expect(observedCodexUsage(events)).toEqual({
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 12,
      totalTokens: 150
    });
  });

  it("runs the sealed two-arm smoke protocol through a deterministic no-provider fixture", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-codex-pilot-"));
    const planPath = writeSmokePlan(temporary);
    const plan = loadCodexPilotPlan(planPath);
    const schedule = buildCodexPilotSchedule({ plan, seed: 20260722, stage: "smoke" });
    expect(schedule.map((attempt) => attempt.condition)).toEqual(["vanilla_codex", "codex_kairn"]);
    const fixturePath = path.join(temporary, "fake.json");
    fs.writeFileSync(fixturePath, JSON.stringify({
      schemaVersion: "codex-pilot-fake.v1",
      attempts: schedule.map((attempt, index) => ({
        id: attempt.id,
        traceValid: true,
        qualityGatePassed: true,
        requiredSourcePathSeen: true,
        requiredSourceContentAccessed: true,
        requiredSourceAccessRecall: 1,
        verificationPassed: true,
        requiredTouchedPassed: true,
        sourceInvariantPassed: true,
        diffScopePassed: true,
        usage: {
          inputTokens: 100 - index * 10,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningTokens: 5,
          totalTokens: 120 - index * 10
        }
      }))
    }), "utf8");
    const output = path.join(temporary, "out");

    const report = await runCodexPilot({
      planPath,
      outDir: output,
      seed: 20260722,
      stage: "smoke",
      fakeCodexFixture: fixturePath
    });

    expect(report.protocolComplete).toBe(true);
    expect(report.validAttemptCount).toBe(2);
    expect(report.attempts.every((attempt) => attempt.qualityGatePassed)).toBe(true);
    expect(JSON.parse(fs.readFileSync(report.outputs.publicEvidencePath, "utf8"))).toMatchObject({
      schemaVersion: "public-codex-pilot-evidence.v1",
      controlledFourArmEvidence: false,
      qualityEligiblePairs: 1,
      positiveTokenPairs: 1,
      reasonBlocksComparisonPublished: false
    });
  });

  it("rejects smoke tasks that are not isolated in the live_smoke lineage role", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-codex-lineage-"));
    const planPath = writeSmokePlan(temporary, "pilot");
    expect(() => loadCodexPilotPlan(planPath)).toThrow(/role must be live_smoke/);
  });
});

function writeSmokePlan(directory: string, lineageRole = "live_smoke"): string {
  const repoUrl = "https://github.com/example/public-python-repo";
  fs.writeFileSync(path.join(directory, "lineages.json"), JSON.stringify({
    schemaVersion: "lineage-registry.v1",
    lineages: [{ id: repoUrl, role: lineageRole }]
  }), "utf8");
  const planPath = path.join(directory, "smoke.json");
  fs.writeFileSync(planPath, JSON.stringify({
    schemaVersion: "codex-pilot.v1",
    id: "codex-v02c-smoke",
    name: "Kairn v0.2C Codex smoke",
    sealed: true,
    profile: "smoke",
    lineageRegistry: "lineages.json",
    conditions: ["vanilla_codex", "codex_kairn"],
    codex: CODEX_PILOT_PIN,
    repeats: 1,
    timeoutMs: 300000,
    tasks: [{
      id: "smoke-python-source",
      repoUrl,
      ref: "0".repeat(40),
      publicRepo: true,
      language: "python",
      taskClass: "source_localization",
      prompt: "Repair the production parser and verify the change.",
      requiredSourceFiles: ["src/parser.py"],
      allowedSupportFiles: ["tests/test_parser.py"],
      explicitNoisePatterns: ["docs/**"],
      requiredTouchedFiles: ["src/parser.py"],
      sourceInvariants: [{ file: "src/parser.py", requiredPresent: ["parse"] }],
      allowedDiffScopes: [{ file: "src/parser.py", allowWholeFile: true }],
      sandboxImage: `python@sha256:${"1".repeat(64)}`,
      verificationCommand: "python -m pytest"
    }]
  }), "utf8");
  return planPath;
}
