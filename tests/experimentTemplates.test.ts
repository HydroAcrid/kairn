import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildExperimentSchedule, loadExperimentPlan } from "../src/bench/experimentPlan.js";

const smokePlanPath = path.resolve("benchmarks/plans/comparison-v1.smoke.json");

describe("comparison-v1 benchmark deliverables", () => {
  it("ships a schema-valid deterministic four-arm smoke plan", () => {
    const plan = loadExperimentPlan(smokePlanPath);
    const schedule = buildExperimentSchedule({ plan, seed: 20260722 });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      id: "comparison-v1-smoke",
      profile: "smoke",
      model: "claude-sonnet-4-6",
      repeats: 1
    });
    expect(schedule.map((attempt) => attempt.condition)).toEqual([
      "kairn",
      "vanilla",
      "kairn_reasonblocks",
      "reasonblocks"
    ]);
  });

  it.each(["pilot", "publication"])("keeps the unresolved %s descriptor non-runnable", (profile) => {
    const target = path.resolve(`benchmarks/plans/comparison-v1.${profile}.template.json`);
    const descriptor = JSON.parse(fs.readFileSync(target, "utf8")) as {
      runnable?: unknown;
      unresolvedTaskManifest?: unknown;
    };

    expect(descriptor.runnable).toBe(false);
    expect(descriptor.unresolvedTaskManifest).toBeNull();
    expect(() => loadExperimentPlan(target)).toThrow();
  });

  it("runs the fake-agent trace validator without provider credentials", () => {
    const environment = { ...process.env };
    delete environment.ANTHROPIC_API_KEY;
    delete environment.REASONBLOCKS_API_KEY;
    const output = execFileSync(
      process.execPath,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/verify-comparison-smoke.ts")],
      { cwd: path.resolve("."), encoding: "utf8", env: environment, timeout: 30_000 }
    );
    const result = JSON.parse(output) as Record<string, unknown>;

    expect(result).toMatchObject({
      schemaVersion: "comparison-fake-agent.v1",
      status: "passed",
      fixtureNotEvidence: true,
      providerCalls: 0,
      networkRequired: false,
      attemptsValidated: 4
    });
  });
});
