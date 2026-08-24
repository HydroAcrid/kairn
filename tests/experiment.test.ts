import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { ExperimentAttemptResult, ExperimentTask, ExperimentTraceEvent } from "../src/types.js";
import {
  buildExecutionEnvironmentFingerprint,
  evaluateWorkspaceTreeParity,
  parseDockerImageInspect,
  parseDockerRuntimeVersion,
  runExperiment
} from "../src/bench/experiment.js";
import { deriveExperimentMetrics, validateExperimentTrace } from "../src/bench/experimentMetrics.js";
import { buildExperimentSchedule, loadExperimentPlan } from "../src/bench/experimentPlan.js";
import { buildPairComparisons, buildPublicEvidence, emptyAttemptMetrics } from "../src/bench/experimentReport.js";
import { runSeedVerification } from "../src/bench/agent.js";

describe("controlled experiment protocol", () => {
  it.skipIf(process.platform === "win32")("creates and reuses a real Kairn session from the controlled host", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-host-session-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "host-session-fixture", private: true }));
    fs.writeFileSync(path.join(root, "src", "parser.ts"), "export function parse(value: string) { return value.trim(); }\n");
    const hostPath = path.resolve("benchmarks/anthropic_messages_host.py");
    const command = [
      process.execPath,
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("src/cli.ts")
    ].map((part) => JSON.stringify(part)).join(" ");
    const program = [
      "import importlib.util, json, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('kairn_host', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "provider = module.KairnProvider(sys.argv[2], pathlib.Path(sys.argv[3]), 'attempt-session-test')",
      "provider.guidance('Locate the production parser source.')",
      "first = provider.session",
      "provider.guidance('Locate the production parser source again.')",
      "assert provider.session == first and isinstance(first, str) and first.startswith('task_')",
      "print(json.dumps({'session': first}))"
    ].join("; ");

    const output = execFileSync("python3", ["-c", program, hostPath, command, root], {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 30_000
    });
    expect(JSON.parse(output)).toMatchObject({ session: expect.stringMatching(/^task_/) });
  }, 40_000);

  it.skipIf(process.platform === "win32")("derives ReasonBlocks protocol evidence from the live session object", () => {
    const hostPath = path.resolve("benchmarks/anthropic_messages_host.py");
    const program = [
      "import importlib.util, json, sys",
      "spec = importlib.util.spec_from_file_location('kairn_host', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "MonitorSteeringInjection = type('MonitorSteeringInjection', (), {})",
      "ETracePatternInjection = type('ETracePatternInjection', (), {})",
      "Session = type('Session', (), {'injections': [MonitorSteeringInjection(), ETracePatternInjection()], 'model_routing': {}, 'state_manager': object()})",
      "print(json.dumps(module.reasonblocks_effective_protocol(Session())))"
    ].join("; ");

    const output = execFileSync("python3", ["-c", program, hostPath], {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 30_000
    });
    expect(JSON.parse(output)).toMatchObject({
      inspection: "installed_session_object",
      modelRoutingConfigured: false,
      stateManagerPresent: true,
      injectionCount: 2,
      monitorSteeringPresent: true,
      eTraceInjectionPresent: true
    });
  });

  it("builds a deterministic balanced four-arm order", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-plan-"));
    const planPath = writePlan(root);
    const plan = loadExperimentPlan(planPath);
    const first = buildExperimentSchedule({ plan, seed: 20260722, repeats: 2 });
    const second = buildExperimentSchedule({ plan, seed: 20260722, repeats: 2 });

    expect(first).toEqual(second);
    expect(first).toHaveLength(8);
    for (const repeat of [1, 2]) {
      expect(first.filter((item) => item.repeat === repeat).map((item) => item.condition).sort()).toEqual([
        "kairn",
        "kairn_reasonblocks",
        "reasonblocks",
        "vanilla"
      ]);
    }
  });

  it("requires every controlled task to pin its sandbox image by digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-sandbox-plan-"));
    const planPath = writePlan(root);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as { tasks: Array<Record<string, unknown>> };
    delete plan.tasks[0]!.sandboxImage;
    fs.writeFileSync(planPath, JSON.stringify(plan));
    expect(() => loadExperimentPlan(planPath)).toThrow("sandboxImage must be a container image pinned by sha256 digest");

    plan.tasks[0]!.sandboxImage = "ghcr.io/example/kairn-bench:latest";
    fs.writeFileSync(planPath, JSON.stringify(plan));
    expect(() => loadExperimentPlan(planPath)).toThrow("sandboxImage must be a container image pinned by sha256 digest");
  });

  it("parses and gates immutable Docker image and runtime provenance", () => {
    const requestedImage = `ghcr.io/example/kairn-bench@sha256:${"a".repeat(64)}`;
    const provenance = parseDockerImageInspect(requestedImage, JSON.stringify([{
      Id: `sha256:${"b".repeat(64)}`,
      RepoDigests: [
        `ghcr.io/example/kairn-bench@sha256:${"c".repeat(64)}`,
        requestedImage
      ],
      Os: "linux",
      Architecture: "amd64",
      Config: {}
    }]));
    expect(provenance).toEqual({
      requestedImage,
      id: `sha256:${"b".repeat(64)}`,
      repoDigests: [requestedImage, `ghcr.io/example/kairn-bench@sha256:${"c".repeat(64)}`],
      os: "linux",
      architecture: "amd64"
    });
    expect(parseDockerRuntimeVersion(JSON.stringify({
      Client: { Version: "28.0.1" },
      Server: { Version: "28.0.1", Os: "linux", Arch: "amd64" }
    }))).toEqual({
      clientVersion: "28.0.1",
      serverVersion: "28.0.1",
      serverOs: "linux",
      serverArchitecture: "amd64"
    });
    expect(() => parseDockerImageInspect(requestedImage, JSON.stringify([{
      Id: `sha256:${"b".repeat(64)}`,
      RepoDigests: [`ghcr.io/example/other@sha256:${"a".repeat(64)}`],
      Os: "linux",
      Architecture: "amd64"
    }]))).toThrow("RepoDigests do not contain the requested pin");
    expect(() => parseDockerImageInspect(requestedImage, JSON.stringify([{
      Id: `sha256:${"b".repeat(64)}`,
      RepoDigests: [requestedImage],
      Os: "linux",
      Architecture: "amd64",
      Config: { Volumes: { "/data": {} } }
    }]))).toThrow("declares writable VOLUME paths");
  });

  it("fingerprints the sanitized host/runtime and resolved images deterministically", () => {
    const host = {
      nodeVersion: "v24.0.0",
      v8Version: "13.6",
      platform: "linux",
      architecture: "x64",
      osType: "Linux",
      osRelease: "6.8.0",
      endianness: "LE",
      cpuModel: "Generic CPU",
      logicalCpuCount: 8,
      pythonVersion: "Python 3.12.3",
      dockerClientVersion: "28.0.1",
      dockerServerVersion: "28.0.1",
      dockerServerOs: "linux",
      dockerServerArchitecture: "amd64"
    };
    const firstImage = {
      requestedImage: `ghcr.io/example/a@sha256:${"a".repeat(64)}`,
      id: `sha256:${"b".repeat(64)}`,
      repoDigests: [`ghcr.io/example/a@sha256:${"a".repeat(64)}`],
      os: "linux",
      architecture: "amd64"
    };
    const secondImage = {
      requestedImage: `ghcr.io/example/b@sha256:${"c".repeat(64)}`,
      id: `sha256:${"d".repeat(64)}`,
      repoDigests: [`ghcr.io/example/b@sha256:${"c".repeat(64)}`],
      os: "linux",
      architecture: "amd64"
    };
    const first = buildExecutionEnvironmentFingerprint(host, [secondImage, firstImage], true);
    const second = buildExecutionEnvironmentFingerprint(host, [firstImage, secondImage], true);
    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildExecutionEnvironmentFingerprint({ ...host, nodeVersion: "v24.0.1" }, [firstImage, secondImage], true).hash)
      .not.toBe(first.hash);
  });

  it("requires identical post-failure workspace trees across every four-arm block", () => {
    const digest = "a".repeat(64);
    const attempts = (["vanilla", "reasonblocks", "kairn", "kairn_reasonblocks"] as const).map((condition) => {
      const result = attemptResult("block-a", condition, "passed", 10);
      result.workspaceTreeDigest = digest;
      return result;
    });
    expect(evaluateWorkspaceTreeParity(attempts)).toMatchObject({
      consistent: true,
      blocks: [{ blockId: "block-a", consistent: true, digest }]
    });
    attempts[3]!.workspaceTreeDigest = "b".repeat(64);
    const mismatch = evaluateWorkspaceTreeParity(attempts);
    expect(mismatch.consistent).toBe(false);
    expect(mismatch.blocks[0]?.reasons).toContain("workspace digests differ across arms");
    const missingArm = evaluateWorkspaceTreeParity(attempts.slice(0, 3));
    expect(missingArm.consistent).toBe(false);
    expect(missingArm.blocks[0]?.missingConditions).toEqual(["kairn_reasonblocks"]);
  });

  it.skipIf(process.platform === "win32")("computes a deterministic post-failure workspace digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-workspace-tree-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "parser.ts"), "export const parser = true;\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    execFileSync("git", ["add", "."], { cwd: root });
    const hostPath = path.resolve("benchmarks/anthropic_messages_host.py");
    const program = [
      "import importlib.util, json, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('kairn_host', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(json.dumps(module.workspace_tree_fingerprint(pathlib.Path(sys.argv[2]))))"
    ].join("; ");
    const fingerprint = () => JSON.parse(execFileSync("python3", ["-c", program, hostPath, root], {
      cwd: path.resolve("."),
      encoding: "utf8"
    })) as { digest: string; fileCount: number; bytes: number; scope: string };
    const first = fingerprint();
    const now = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(root, "src", "parser.ts"), now, now);
    expect(fingerprint()).toEqual(first);
    fs.writeFileSync(path.join(root, "src", "parser.ts"), "export const parser = false;\n");
    expect(fingerprint().digest).not.toBe(first.digest);
    expect(first.scope).toBe("git-tracked-and-unignored-v1");
  });

  it.skipIf(process.platform === "win32")("runs the redundant verifier through the locked-down Docker boundary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-sandbox-run-"));
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "workspace");
    const argsLog = path.join(root, "docker-args.txt");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const docker = path.join(bin, "docker");
    fs.writeFileSync(
      docker,
      "#!/bin/sh\n[ -z \"$ANTHROPIC_API_KEY\" ] || exit 99\nprintf '%s\\n' \"$@\" > \"$DOCKER_ARGS_LOG\"\n",
      { mode: 0o755 }
    );
    const image = `ghcr.io/example/kairn-bench@sha256:${"a".repeat(64)}`;
    const result = runSeedVerification({
      workspacePath: workspace,
      benchmarkCase: {
        id: "sandbox",
        task: "verify",
        mode: "agent",
        expectedFiles: [],
        excludedFiles: [],
        seed: { repoUrl: "https://github.com/example/public.git", sandboxImage: image, testCommand: "npm test" }
      },
      environment: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOCKER_ARGS_LOG: argsLog,
        ANTHROPIC_API_KEY: "must-not-enter-container"
      }
    });
    const args = fs.readFileSync(argsLog, "utf8").trim().split(/\r?\n/);

    expect(result.failed).toBe(false);
    expect(args).toContain("--pull=never");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--user");
    expect(args).toContain("/tmp:rw,nosuid,nodev,size=1g,mode=1777");
    expect(args).toContain(`type=bind,source=${workspace},target=/workspace`);
    expect(args).toContain(`type=bind,source=${path.join(workspace, ".git")},target=/workspace/.git,readonly`);
    expect(args).toContain("--entrypoint");
    expect(args).toContain("/bin/sh");
    expect(args).toContain(image);
    expect(args).toContain("npm test");
    expect(args.join("\n")).not.toContain("must-not-enter-container");
  });

  it("derives first-source, explicit-noise, emission, and unchanged reread metrics", () => {
    const task: ExperimentTask = {
      id: "trace-metrics",
      repoUrl: "https://github.com/example/public.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
      publicRepo: true,
      language: "typescript",
      taskClass: "long_session",
      prompt: "Fix the production parser.",
      turns: [
        { id: "locate", prompt: "Locate it.", assistanceExpectation: "abstain" },
        { id: "verify", prompt: "Verify it.", assistanceExpectation: "optional" }
      ],
      requiredSourceFiles: ["src/parser.ts"],
      allowedSupportFiles: ["src/types.ts"],
      explicitNoisePatterns: ["docs/**"],
      verificationCommand: "npm test"
    };
    const events: ExperimentTraceEvent[] = [
      event(0, "attempt_start", 0, 0),
      event(1, "assistance_start", 0, 0),
      event(2, "turn_start", 0, 0),
      { ...event(3, "provider_injection", 0, 2), modelStep: 0, provider: "kairn", action: "emit", tokenEstimate: 50 },
      { ...event(4, "model_request", 0, 3), modelStep: 0 },
      {
        ...event(5, "model_response", 0, 4),
        modelStep: 0,
        inputTokens: 100,
        cachedInputTokens: 40,
        cacheCreationInputTokens: 0,
        outputTokens: 20
      },
      { ...event(6, "tool_call", 0, 5), modelStep: 0, tool: "search_repo" },
      {
        ...event(7, "tool_result", 0, 100),
        modelStep: 0,
        tool: "search_repo",
        tokenEstimate: 30,
        files: [{ path: "src/parser.ts", delivery: "content", contentHash: "a".repeat(64), tokenEstimate: 30, startLine: 1, endLine: 20 }]
      },
      { ...event(8, "tool_call", 0, 105), modelStep: 0, tool: "read_file" },
      {
        ...event(9, "tool_result", 0, 110),
        modelStep: 0,
        tool: "read_file",
        tokenEstimate: 10,
        files: [{ path: "docs/design.md", delivery: "content", contentHash: "b".repeat(64), tokenEstimate: 10 }]
      },
      event(10, "turn_end", 0, 120),
      event(11, "turn_start", 1, 130),
      { ...event(12, "model_request", 1, 132), modelStep: 1 },
      {
        ...event(13, "model_response", 1, 135),
        modelStep: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0
      },
      { ...event(14, "tool_call", 1, 140), modelStep: 1, tool: "read_file" },
      {
        ...event(15, "tool_result", 1, 150),
        modelStep: 1,
        tool: "read_file",
        tokenEstimate: 25,
        files: [{ path: "src/parser.ts", delivery: "content", contentHash: "a".repeat(64), tokenEstimate: 25, startLine: 1, endLine: 20 }]
      },
      { ...event(16, "verification", 1, 180), passed: true },
      event(17, "turn_end", 1, 190),
      { ...event(18, "attempt_end", 1, 200), passed: true }
    ];

    expect(validateExperimentTrace({ attemptId: "attempt", events })).toEqual([]);
    const metrics = deriveExperimentMetrics({
      task,
      events,
      externalQualityGatePassed: true,
      externalFinalVerifierPassed: true
    });

    expect(metrics.timeToFirstRequiredContentMs).toBe(100);
    expect(metrics.modelTokensBeforeFirstRequiredContent).toBe(120);
    expect(metrics.requiredSourceContentRecall).toBe(1);
    expect(metrics.requiredSourceToolReadRecall).toBe(1);
    expect(metrics.explicitNoiseFilesOpened).toBe(1);
    expect(metrics.extraneousFilesOpened).toBe(1);
    expect(metrics.estimatedToolResultTokens).toBe(65);
    expect(metrics.estimatedUnnecessaryEmissionTokens).toBe(50);
    expect(metrics.crossTurnRepeatReadEvents).toBe(1);
    expect(metrics.avoidableCrossTurnRepeatReadEvents).toBe(1);
    expect(metrics.estimatedAvoidableRepeatReadTokens).toBe(25);
  });

  it("counts required source as found only when every preregistered source file is delivered", () => {
    const task: ExperimentTask = {
      id: "complete-recall",
      repoUrl: "https://github.com/example/public.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
      publicRepo: true,
      language: "typescript",
      taskClass: "source_localization",
      prompt: "Locate both production files.",
      requiredSourceFiles: ["src/parser.ts", "src/tokenizer.ts"],
      verificationCommand: "npm test"
    };
    const events: ExperimentTraceEvent[] = [
      event(0, "attempt_start", 0, 0),
      event(1, "assistance_start", 0, 0),
      event(2, "turn_start", 0, 1),
      {
        ...event(3, "provider_injection", 0, 2),
        provider: "kairn",
        action: "emit",
        tokenEstimate: 5,
        files: [{ path: "src/parser.ts", delivery: "content", contentHash: "a".repeat(64), tokenEstimate: 5 }]
      },
      event(4, "turn_end", 0, 3),
      event(5, "attempt_end", 0, 4)
    ];

    const metrics = deriveExperimentMetrics({
      task,
      events,
      externalQualityGatePassed: false,
      externalFinalVerifierPassed: false
    });

    expect(metrics.requiredSourceContentRecall).toBe(0.5);
    expect(metrics.requiredSourceFound).toBe(false);
    expect(metrics.requiredSourceMissRate).toBe(0.5);
  });

  it("rejects traces that omit provider token usage or tool-result pairing", () => {
    const events: ExperimentTraceEvent[] = [
      event(0, "attempt_start", 0, 0),
      event(1, "turn_start", 0, 1),
      { ...event(2, "model_request", 0, 2), modelStep: 0 },
      { ...event(3, "model_response", 0, 3), modelStep: 0, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 },
      { ...event(4, "tool_result", 0, 4), modelStep: 0, tool: "read_file", tokenEstimate: 2 },
      event(5, "turn_end", 0, 5),
      event(6, "attempt_end", 0, 6)
    ];
    const reasons = validateExperimentTrace({ attemptId: "attempt", events });
    expect(reasons).toContain("cacheCreationInputTokens is missing or invalid at sequence 3");
    expect(reasons).toContain("tool_result has no matching tool_call for 0:0:read_file");
  });

  it("computes signed paired deltas only for pass/pass quality pairs", () => {
    const baseline = attemptResult("block-a", "vanilla", "passed", 100);
    const treatment = attemptResult("block-a", "kairn", "passed", 70);
    baseline.metrics.modelTokensBeforeFirstRequiredPathHint = 40;
    treatment.metrics.modelTokensBeforeFirstRequiredPathHint = 10;
    baseline.metrics.timeToFirstRequiredContentMs = 900;
    treatment.metrics.timeToFirstRequiredContentMs = 300;
    baseline.metrics.explicitNoiseFilesOpened = 2;
    treatment.metrics.explicitNoiseFilesOpened = 0;
    baseline.metrics.requiredSourceContentRecall = 0.8;
    treatment.metrics.requiredSourceContentRecall = 1;
    baseline.metrics.estimatedProviderInjectionTokens = 0;
    treatment.metrics.estimatedProviderInjectionTokens = 25;
    const attempts = [
      baseline,
      treatment,
      attemptResult("block-b", "vanilla", "passed", 80),
      attemptResult("block-b", "kairn", "failed", 20, false)
    ];
    const comparison = buildPairComparisons(attempts, 7).find((item) => item.id === "kairn_vs_vanilla");
    expect(comparison).toMatchObject({
      scheduledBlocks: 2,
      protocolValidPairs: 2,
      qualityEligiblePairs: 1,
      qualityIneligiblePairs: 1,
      medianSignedTotalTokenDelta: -30,
      medianTokenReductionPercent: 30,
      improvements: 1,
      regressions: 0
    });
    expect(comparison?.metricEffects.modelTokensBeforeFirstRequiredPathHint).toEqual({
      pairCount: 1,
      medianSignedDelta: -30
    });
    expect(comparison?.metricEffects.timeToFirstRequiredContentMs).toEqual({
      pairCount: 1,
      medianSignedDelta: -600
    });
    expect(comparison?.metricEffects.explicitNoiseFilesOpened).toEqual({ pairCount: 1, medianSignedDelta: -2 });
    expect(comparison?.metricEffects.requiredSourceContentRecall).toEqual({ pairCount: 1, medianSignedDelta: 0.2 });
    expect(comparison?.metricEffects.estimatedProviderInjectionTokens).toEqual({ pairCount: 1, medianSignedDelta: 25 });
  });

  it("invalidates an uninstrumented repository read", () => {
    const events: ExperimentTraceEvent[] = [
      event(0, "attempt_start", 0, 0),
      { ...event(1, "tool_call", 0, 1), tool: "shell" },
      event(2, "attempt_end", 0, 2)
    ];
    expect(validateExperimentTrace({ attemptId: "attempt", events })).toContain("uninstrumented tool call 'shell' at sequence 1");
  });

  it("publishes quality failures and errors as explicit exclusions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-quality-"));
    const plan = loadExperimentPlan(writePlan(root));
    const failed = attemptResult("typescript-source", "kairn", "failed", 70, false);
    failed.metrics.requiredSourceFound = false;
    failed.metrics.requiredSourceMissRate = 1;
    failed.metrics.finalVerifierPassed = false;
    failed.metrics.excludedFilesTouched = 1;
    failed.error = "verification exited with status 1";
    const evidence = buildPublicEvidence({
      report: {
        schemaVersion: 1,
        id: "comparison-test",
        name: "Comparison Test",
        generatedAt: "2026-07-22T00:00:00.000Z",
        planHash: "plan-hash",
        runId: "run",
        seed: 1,
        dryRun: false,
        externalTrajectoryAllowed: false,
        model: "claude-sonnet-4-6",
        conditions: ["kairn"],
        attempts: [failed],
        aggregates: [],
        strata: [],
        comparisons: [],
        expectedAttemptCount: 1,
        protocolComplete: true
      },
      plan,
      kairnPackageVersion: "0.3.0",
      harnessHash: "harness-hash",
      toolSchemaHash: "tool-schema-hash"
    });

    expect(evidence.attempts[0]?.qualityFailures).toEqual([
      "final_verification_failed",
      "required_touch_failed",
      "source_invariant_failed",
      "diff_scope_failed",
      "required_source_incomplete",
      "excluded_file_touched",
      "external_quality_gate_failed",
      "attempt_status_failed"
    ]);
    expect(evidence.attempts[0]?.error).toBe("failed_error");
    expect(evidence.exclusions[0]?.reasons).toContain("required_source_incomplete");
    expect(evidence.exclusions[0]?.reasons).toContain("attempt_error");
  });

  it("writes a methodology-only dry-run artifact without provider credentials", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-dry-"));
    const outDir = path.join(root, "out");
    const report = await runExperiment({
      planPath: writePlan(root),
      outDir,
      seed: 20260722,
      repeat: 1,
      dryRun: true,
      allowExternalTrajectory: false
    });

    expect(report.attempts).toHaveLength(4);
    expect(report.attempts.every((item) => item.status === "planned")).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(report.outputs.publicEvidencePath, "utf8")) as {
      campaign: { status: string };
      provenance: { executionEnvironmentHash?: string; hostRuntime?: { platform?: string } };
      checksum: string;
    };
    expect(evidence.campaign.status).toBe("methodology_only");
    expect(evidence.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(report.executionEnvironment?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.executionEnvironment?.verified).toBe(false);
    expect(evidence.provenance.executionEnvironmentHash).toBe(report.executionEnvironment?.hash);
    expect(evidence.provenance.hostRuntime?.platform).toBe(process.platform);
    const manifest = JSON.parse(fs.readFileSync(report.outputs.manifestPath, "utf8")) as {
      executionEnvironment?: { hash?: string };
      campaignFingerprint?: { executionEnvironment?: { hash?: string } };
    };
    expect(manifest.executionEnvironment?.hash).toBe(report.executionEnvironment?.hash);
    expect(manifest.campaignFingerprint?.executionEnvironment?.hash).toBe(report.executionEnvironment?.hash);
    expect(fs.existsSync(report.outputs.manifestPath)).toBe(true);
    const csvHeader = fs.readFileSync(report.outputs.resultsCsvPath, "utf8").split("\n", 1)[0] ?? "";
    expect(csvHeader).toContain("uncached_input_tokens");
    expect(csvHeader).toContain("time_to_first_required_path_hint_ms");
    expect(csvHeader).toContain("required_source_tool_read_recall");
    expect(csvHeader).toContain("avoidable_cross_turn_repeat_read_events");
    expect(csvHeader).toContain("host_peak_rss_bytes");
    expect(csvHeader).toContain("required_touched_passed");
    expect(csvHeader).toContain("source_invariant_passed");
    expect(csvHeader).toContain("diff_scope_passed");
  });

  it("refuses to resume into an output directory with a changed campaign seed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-resume-"));
    const outDir = path.join(root, "out");
    const planPath = writePlan(root);
    await runExperiment({ planPath, outDir, seed: 1, dryRun: true });
    await expect(runExperiment({ planPath, outDir, seed: 2, dryRun: true, resume: true }))
      .rejects.toThrow("Experiment resume state mismatch for seed");
  });

  it("binds resume state to the resolved execution environment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-execution-resume-"));
    const outDir = path.join(root, "out");
    const planPath = writePlan(root);
    await runExperiment({ planPath, outDir, seed: 1, dryRun: true });
    const statePath = path.join(outDir, "run-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { executionEnvironmentHash: string };
    state.executionEnvironmentHash = "f".repeat(64);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    await expect(runExperiment({ planPath, outDir, seed: 1, dryRun: true, resume: true }))
      .rejects.toThrow("Experiment resume state mismatch for executionEnvironmentHash");
  });

  it("refuses to resume when the configured ranker identity changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-fingerprint-"));
    const outDir = path.join(root, "out");
    const planPath = writePlan(root);
    const priorModelId = process.env.KAIRN_RANKER_MODEL_ID;
    try {
      process.env.KAIRN_RANKER_MODEL_ID = "ranker-a";
      await runExperiment({ planPath, outDir, seed: 1, dryRun: true });
      process.env.KAIRN_RANKER_MODEL_ID = "ranker-b";
      await expect(runExperiment({ planPath, outDir, seed: 1, dryRun: true, resume: true }))
        .rejects.toThrow("Experiment resume state mismatch for campaignFingerprintHash");
    } finally {
      if (priorModelId === undefined) delete process.env.KAIRN_RANKER_MODEL_ID;
      else process.env.KAIRN_RANKER_MODEL_ID = priorModelId;
    }
  });

  it("rejects public repository URLs with an explicit port, query, or fragment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-experiment-url-"));
    const planPath = writePlan(root);
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as { tasks: Array<{ repoUrl: string }> };
    plan.tasks[0]!.repoUrl = "https://github.com:443/example/public.git?ref=main#source";
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    await expect(runExperiment({ planPath, outDir: path.join(root, "out"), seed: 1, dryRun: true }))
      .rejects.toThrow("must not contain credentials, a port, query, or fragment");
  });
});

function event(sequence: number, kind: ExperimentTraceEvent["kind"], turn: number, monotonicMs: number): ExperimentTraceEvent {
  return { schemaVersion: 1, attemptId: "attempt", sequence, monotonicMs, turn, kind };
}

function attemptResult(
  blockId: string,
  condition: ExperimentAttemptResult["attempt"]["condition"],
  status: ExperimentAttemptResult["status"],
  totalModelTokens: number,
  qualityGatePassed = true
): ExperimentAttemptResult {
  return {
    attempt: {
      id: `${blockId}-${condition}`,
      campaignId: "campaign",
      taskId: blockId,
      condition,
      repeat: 1,
      order: 1,
      blockId
    },
    task: {
      id: blockId,
      language: "typescript",
      taskClass: "source_localization",
      repoUrl: "https://github.com/example/public.git",
      ref: "0123456789abcdef0123456789abcdef01234567"
    },
    runId: "run",
    status,
    startedAt: "2026-07-22T00:00:00.000Z",
    endedAt: "2026-07-22T00:00:01.000Z",
    workspaceSetupMs: 1,
    providerSetupMs: 1,
    onlineMs: 1,
    totalMs: 3,
    traceValid: true,
    invalidReasons: [],
    metrics: {
      ...emptyAttemptMetrics(),
      totalModelTokens,
      finalVerifierPassed: qualityGatePassed,
      requiredTouchedPassed: qualityGatePassed,
      sourceInvariantPassed: qualityGatePassed,
      diffScopePassed: qualityGatePassed,
      qualityGatePassed
    }
  };
}

function writePlan(root: string): string {
  const target = path.join(root, "comparison.json");
  fs.writeFileSync(target, JSON.stringify({
    schemaVersion: 1,
    id: "comparison-test",
    name: "Comparison Test",
    repeats: 1,
    tasks: [{
      id: "typescript-source",
      repoUrl: "https://github.com/example/public.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
      publicRepo: true,
      language: "typescript",
      taskClass: "source_localization",
      prompt: "Find and fix the parser.",
      requiredSourceFiles: ["src/parser.ts"],
      allowedSupportFiles: ["src/types.ts"],
      explicitNoisePatterns: ["docs/**"],
      requiredTouchedFiles: ["src/parser.ts"],
      sandboxImage: `ghcr.io/example/kairn-bench@sha256:${"a".repeat(64)}`,
      assistanceExpectation: "required",
      verificationCommand: "npm test"
    }]
  }, null, 2));
  return target;
}
