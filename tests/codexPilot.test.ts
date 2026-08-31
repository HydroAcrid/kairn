// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexPilotCommonArgs,
  codexPilotProjectTrustConfig,
  inspectCodexPilotHookEvidence,
  runCodexPilot
} from "../src/bench/codexPilot.js";
import {
  buildCodexPilotSchedule,
  CODEX_PILOT_PIN,
  CODEX_PILOT_SEMANTIC_RC_PIN,
  loadCodexPilotPlan
} from "../src/bench/codexPilotPlan.js";
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
    expect(registry.smoke[0]?.status).toBe("sealed");
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

  it("loads only the exact pilot checkout while retaining project hook discovery", () => {
    const workspace = path.resolve("/tmp/kairn pilot checkout");
    const args = buildCodexPilotCommonArgs();

    expect(args).not.toContain("--ignore-user-config");
    expect(args).toContain("--dangerously-bypass-hook-trust");
    expect(codexPilotProjectTrustConfig(workspace)).toBe(
      `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`
    );
  });

  it("proves Kairn hook execution from both syscall and content-free audit receipts", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-hook-proof-"));
    const raw = path.join(temporary, "raw");
    const audit = path.join(raw, "kairn-hook-audit.jsonl");
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(raw, "strace.t1.123"), [
      '1.0 execve("/usr/bin/node", ["node", "/opt/kairn/dist/cli.js", "hook", "--source", "codex"], 0x0) = 0',
      '2.0 openat(AT_FDCWD, "/tmp/projects/kairn/artifacts/not-hook.txt", O_RDONLY) = 3'
    ].join("\n"));
    fs.writeFileSync(audit, `${JSON.stringify({
      schemaVersion: "kairn-hook-audit.v1",
      source: "codex",
      eventName: "UserPromptSubmit",
      emitted: true,
      estimatedPayloadTokens: 42,
      payloadSha256: "a".repeat(64)
    })}\n`);

    expect(inspectCodexPilotHookEvidence(raw, audit)).toEqual({
      traceInvocationCount: 1,
      auditRecordCount: 1,
      auditRecordsValid: true,
      estimatedPayloadTokens: 42
    });
  });

  it("rejects malformed Kairn hook audit receipts", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-hook-proof-invalid-"));
    const audit = path.join(temporary, "audit.jsonl");
    fs.writeFileSync(audit, '{"schemaVersion":"wrong"}\n');

    expect(inspectCodexPilotHookEvidence(temporary, audit)).toMatchObject({
      traceInvocationCount: 0,
      auditRecordCount: 0,
      auditRecordsValid: false,
      estimatedPayloadTokens: 0
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

  it("pins the complete semantic serving identity in v2 plans", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-codex-semantic-plan-"));
    const plan = loadCodexPilotPlan(writeSmokePlan(temporary, "live_smoke", true));

    expect(plan.schemaVersion).toBe("codex-pilot.v2");
    expect(plan.kairn).toEqual(CODEX_PILOT_SEMANTIC_RC_PIN);

    const planPath = path.join(temporary, "smoke.json");
    const tampered = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
      kairn: { rankerArtifactChecksum: string };
    };
    tampered.kairn.rankerArtifactChecksum = "0".repeat(64);
    fs.writeFileSync(planPath, JSON.stringify(tampered), "utf8");
    expect(() => loadCodexPilotPlan(planPath)).toThrow(/rankerArtifactChecksum must be pinned/);
  });

  it("keeps the checked-in semantic smoke candidate as an unsealed curation record", () => {
    const candidate = JSON.parse(fs.readFileSync(
      path.resolve("benchmarks/plans/codex-v02c.semantic-rc.smoke.candidate.json"),
      "utf8"
    )) as Record<string, unknown> & { sealed: boolean; lineageRegistry: string };
    expect(candidate).toMatchObject({
      schemaVersion: "codex-pilot.v2",
      sealed: false,
      kairn: CODEX_PILOT_SEMANTIC_RC_PIN
    });

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-codex-checked-in-candidate-"));
    fs.writeFileSync(path.join(temporary, "lineages.json"), JSON.stringify({
      schemaVersion: "lineage-registry.v1",
      lineages: [{ id: "https://github.com/sindresorhus/p-map", role: "live_smoke" }]
    }), "utf8");
    fs.writeFileSync(path.join(temporary, "sealed.json"), JSON.stringify({
      ...candidate,
      sealed: true,
      lineageRegistry: "lineages.json"
    }), "utf8");

    expect(loadCodexPilotPlan(path.join(temporary, "sealed.json"))).toMatchObject({
      schemaVersion: "codex-pilot.v2",
      sealed: true,
      kairn: CODEX_PILOT_SEMANTIC_RC_PIN
    });
  });

  it("loads the Docker-verified semantic smoke plan with its sealed identity", () => {
    expect(loadCodexPilotPlan(path.resolve(
      "benchmarks/plans/codex-v02c.semantic-rc.smoke.sealed.json"
    ))).toMatchObject({
      schemaVersion: "codex-pilot.v2",
      sealed: true,
      kairn: CODEX_PILOT_SEMANTIC_RC_PIN,
      tasks: [{
        id: "typescript-p-map-already-aborted-signal",
        sandboxImage: "docker.io/library/node@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059"
      }]
    });
  });
});

function writeSmokePlan(directory: string, lineageRole = "live_smoke", semantic = false): string {
  const repoUrl = "https://github.com/example/public-python-repo";
  fs.writeFileSync(path.join(directory, "lineages.json"), JSON.stringify({
    schemaVersion: "lineage-registry.v1",
    lineages: [{ id: repoUrl, role: lineageRole }]
  }), "utf8");
  const planPath = path.join(directory, "smoke.json");
  fs.writeFileSync(planPath, JSON.stringify({
    schemaVersion: semantic ? "codex-pilot.v2" : "codex-pilot.v1",
    id: "codex-v02c-smoke",
    name: "Kairn v0.2C Codex smoke",
    sealed: true,
    profile: "smoke",
    lineageRegistry: "lineages.json",
    conditions: ["vanilla_codex", "codex_kairn"],
    codex: CODEX_PILOT_PIN,
    ...(semantic ? { kairn: CODEX_PILOT_SEMANTIC_RC_PIN } : {}),
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
