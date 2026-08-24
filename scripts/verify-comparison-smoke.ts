// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ExperimentAttemptPlan,
  ExperimentCondition,
  ExperimentTask,
  ExperimentTraceEvent
} from "../src/types.js";
import { deriveExperimentMetrics, validateExperimentTrace } from "../src/bench/experimentMetrics.js";
import { buildExperimentSchedule, loadExperimentPlan } from "../src/bench/experimentPlan.js";

type GuidanceFixture = {
  provider: "kairn" | "reasonblocks";
  action: "emit";
  tokenEstimate: number;
};

type ArmFixture = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  expectedTotalModelTokens: number;
  guidance: GuidanceFixture[];
};

type FakeAgentFixture = {
  schemaVersion: "comparison-fake-agent.v1";
  id: string;
  description: string;
  notEvidence: true;
  plan: string;
  seed: number;
  expectedConditionOrder: ExperimentCondition[];
  sourceContent: string;
  sourceTokenEstimate: number;
  arms: Record<ExperimentCondition, ArmFixture>;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BENCHMARK_ROOT = path.join(REPO_ROOT, "benchmarks");
const DEFAULT_FIXTURE = path.join(BENCHMARK_ROOT, "fixtures", "comparison-v1.fake-agent.v1.json");
const CONDITIONS: ExperimentCondition[] = ["vanilla", "reasonblocks", "kairn", "kairn_reasonblocks"];

function main(): void {
  const fixturePath = path.resolve(process.argv[2] ?? DEFAULT_FIXTURE);
  assertWithin(BENCHMARK_ROOT, fixturePath, "fixture");
  const fixture = parseFixture(JSON.parse(fs.readFileSync(fixturePath, "utf8")) as unknown);
  const planPath = path.resolve(path.dirname(fixturePath), fixture.plan);
  assertWithin(BENCHMARK_ROOT, planPath, "fixture plan");
  const plan = loadExperimentPlan(planPath);
  if (plan.profile !== "smoke") throw new Error("fake-agent validation requires a smoke-profile plan");
  if (plan.tasks.length !== 1 || plan.repeats !== 1) {
    throw new Error("fake-agent validation requires exactly one task and one repeat");
  }

  const schedule = buildExperimentSchedule({ plan, seed: fixture.seed });
  const conditionOrder = schedule.map((attempt) => attempt.condition);
  if (JSON.stringify(conditionOrder) !== JSON.stringify(fixture.expectedConditionOrder)) {
    throw new Error(`schedule mismatch: expected ${fixture.expectedConditionOrder.join(",")}, got ${conditionOrder.join(",")}`);
  }

  const task = plan.tasks[0]!;
  const verified = schedule.map((attempt) => verifyArm(attempt, task, fixture));
  verifyFailClosedTemplates();

  process.stdout.write(`${JSON.stringify({
    schemaVersion: fixture.schemaVersion,
    fixtureId: fixture.id,
    status: "passed",
    fixtureNotEvidence: true,
    providerCalls: 0,
    networkRequired: false,
    attemptsValidated: verified.length,
    conditionOrder,
    checks: [
      "plan_schema",
      "balanced_schedule",
      "trace_integrity",
      "required_source_recall",
      "token_accounting",
      "template_fail_closed"
    ]
  }, null, 2)}\n`);
}

function verifyArm(
  attempt: ExperimentAttemptPlan,
  task: ExperimentTask,
  fixture: FakeAgentFixture
): { condition: ExperimentCondition; totalModelTokens: number } {
  const arm = fixture.arms[attempt.condition];
  const events = fakeTrace(attempt, task, fixture, arm);
  const invalidReasons = validateExperimentTrace({ attemptId: attempt.id, events });
  if (invalidReasons.length > 0) {
    throw new Error(`${attempt.condition} fake trace is invalid:\n- ${invalidReasons.join("\n- ")}`);
  }
  const metrics = deriveExperimentMetrics({
    task,
    events,
    externalQualityGatePassed: true,
    externalFinalVerifierPassed: true,
    externalRequiredTouchedPassed: true,
    externalSourceInvariantPassed: true,
    externalDiffScopePassed: true
  });
  if (!metrics.requiredSourceFound || metrics.requiredSourceContentRecall !== 1 || metrics.requiredSourceToolReadRecall !== 1) {
    throw new Error(`${attempt.condition} did not deliver every required source through read_file`);
  }
  if (metrics.totalModelTokens !== arm.expectedTotalModelTokens) {
    throw new Error(
      `${attempt.condition} token accounting mismatch: expected ${arm.expectedTotalModelTokens}, got ${metrics.totalModelTokens}`
    );
  }
  const expectedKairn = arm.guidance
    .filter((item) => item.provider === "kairn")
    .reduce((sum, item) => sum + item.tokenEstimate, 0);
  const expectedReasonBlocks = arm.guidance
    .filter((item) => item.provider === "reasonblocks")
    .reduce((sum, item) => sum + item.tokenEstimate, 0);
  if (
    metrics.estimatedKairnGuidanceTokens !== expectedKairn ||
    metrics.estimatedReasonblocksGuidanceTokens !== expectedReasonBlocks
  ) {
    throw new Error(`${attempt.condition} provider-token attribution mismatch`);
  }
  return { condition: attempt.condition, totalModelTokens: metrics.totalModelTokens };
}

function fakeTrace(
  attempt: ExperimentAttemptPlan,
  task: ExperimentTask,
  fixture: FakeAgentFixture,
  arm: ArmFixture
): ExperimentTraceEvent[] {
  const events: ExperimentTraceEvent[] = [];
  const push = (
    kind: ExperimentTraceEvent["kind"],
    fields: Omit<ExperimentTraceEvent, "schemaVersion" | "attemptId" | "sequence" | "monotonicMs" | "turn" | "kind"> = {}
  ): void => {
    const sequence = events.length;
    events.push({
      schemaVersion: 1,
      attemptId: attempt.id,
      sequence,
      monotonicMs: sequence * 10,
      turn: 0,
      kind,
      ...fields
    });
  };
  const requiredPath = task.requiredSourceFiles[0]!;
  const contentHash = createHash("sha256").update(fixture.sourceContent).digest("hex");

  push("attempt_start", { metadata: { condition: attempt.condition, fakeAgent: true, fixtureNotEvidence: true } });
  push("assistance_start");
  push("turn_start");
  for (const guidance of arm.guidance) {
    push("provider_injection", {
      modelStep: 0,
      provider: guidance.provider,
      action: guidance.action,
      tokenEstimate: guidance.tokenEstimate,
      files: [{ path: requiredPath, delivery: "path_hint", tokenEstimate: 1 }]
    });
  }
  push("model_request", { modelStep: 0 });
  push("model_response", {
    modelStep: 0,
    inputTokens: arm.inputTokens,
    cachedInputTokens: arm.cachedInputTokens,
    cacheCreationInputTokens: arm.cacheCreationInputTokens,
    outputTokens: arm.outputTokens,
    metadata: { resolvedModel: "deterministic-fake-agent-v1" }
  });
  push("tool_call", { modelStep: 0, tool: "read_file" });
  push("tool_result", {
    modelStep: 0,
    tool: "read_file",
    tokenEstimate: fixture.sourceTokenEstimate,
    files: [{
      path: requiredPath,
      delivery: "content",
      contentHash,
      tokenEstimate: fixture.sourceTokenEstimate,
      startLine: 1,
      endLine: 1
    }]
  });
  push("turn_end");
  push("verification", { passed: true, tokenEstimate: 0 });
  push("attempt_end", {
    passed: true,
    metadata: {
      fakeAgent: true,
      fixtureNotEvidence: true,
      finalVerifierPassed: true,
      requiredTouchedSatisfied: true,
      sourceInvariantPassed: true,
      diffScopePassed: true
    }
  });
  return events;
}

function verifyFailClosedTemplates(): void {
  for (const filename of [
    "comparison-v1.pilot.template.json",
    "comparison-v1.publication.template.json"
  ]) {
    const templatePath = path.join(BENCHMARK_ROOT, "plans", filename);
    const descriptor = JSON.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
    if (descriptor.runnable !== false || descriptor.unresolvedTaskManifest !== null) {
      throw new Error(`${filename} must remain explicitly non-runnable until its task manifest is sealed`);
    }
    let rejected = false;
    try {
      loadExperimentPlan(templatePath);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`${filename} was unexpectedly accepted as a runnable experiment plan`);
  }
}

function parseFixture(value: unknown): FakeAgentFixture {
  if (!isRecord(value)) throw new Error("fake-agent fixture must be an object");
  if (value.schemaVersion !== "comparison-fake-agent.v1") throw new Error("unsupported fake-agent fixture schema");
  if (value.notEvidence !== true) throw new Error("fake-agent fixture must be marked notEvidence=true");
  if (typeof value.id !== "string" || !value.id.trim()) throw new Error("fake-agent fixture id is required");
  if (typeof value.description !== "string" || !value.description.trim()) throw new Error("fake-agent description is required");
  if (typeof value.plan !== "string" || !value.plan.trim()) throw new Error("fake-agent fixture plan is required");
  if (!Number.isInteger(value.seed) || Number(value.seed) < 0) throw new Error("fake-agent seed must be a non-negative integer");
  if (!Array.isArray(value.expectedConditionOrder) || value.expectedConditionOrder.length !== CONDITIONS.length) {
    throw new Error("fake-agent fixture must pin the four-condition order");
  }
  const expectedConditionOrder = value.expectedConditionOrder as ExperimentCondition[];
  if (new Set(expectedConditionOrder).size !== CONDITIONS.length || CONDITIONS.some((item) => !expectedConditionOrder.includes(item))) {
    throw new Error("fake-agent expectedConditionOrder must contain each condition exactly once");
  }
  if (typeof value.sourceContent !== "string") throw new Error("fake-agent sourceContent must be a string");
  if (!Number.isInteger(value.sourceTokenEstimate) || Number(value.sourceTokenEstimate) < 0) {
    throw new Error("fake-agent sourceTokenEstimate must be a non-negative integer");
  }
  if (!isRecord(value.arms)) throw new Error("fake-agent arms must be an object");
  const arms = Object.fromEntries(CONDITIONS.map((condition) => [condition, parseArm(value.arms![condition], condition)])) as Record<ExperimentCondition, ArmFixture>;
  return {
    schemaVersion: "comparison-fake-agent.v1",
    id: value.id,
    description: value.description,
    notEvidence: true,
    plan: value.plan,
    seed: Number(value.seed),
    expectedConditionOrder,
    sourceContent: value.sourceContent,
    sourceTokenEstimate: Number(value.sourceTokenEstimate),
    arms
  };
}

function parseArm(value: unknown, condition: ExperimentCondition): ArmFixture {
  if (!isRecord(value)) throw new Error(`${condition} arm must be an object`);
  const integer = (key: string): number => {
    const candidate = value[key];
    if (!Number.isInteger(candidate) || Number(candidate) < 0) throw new Error(`${condition}.${key} must be a non-negative integer`);
    return Number(candidate);
  };
  if (!Array.isArray(value.guidance)) throw new Error(`${condition}.guidance must be an array`);
  const guidance = value.guidance.map((entry, index): GuidanceFixture => {
    if (!isRecord(entry)) throw new Error(`${condition}.guidance[${index}] must be an object`);
    if (entry.provider !== "kairn" && entry.provider !== "reasonblocks") {
      throw new Error(`${condition}.guidance[${index}].provider is invalid`);
    }
    if (entry.action !== "emit") throw new Error(`${condition}.guidance[${index}].action must be emit`);
    if (!Number.isInteger(entry.tokenEstimate) || Number(entry.tokenEstimate) < 0) {
      throw new Error(`${condition}.guidance[${index}].tokenEstimate must be a non-negative integer`);
    }
    return { provider: entry.provider, action: "emit", tokenEstimate: Number(entry.tokenEstimate) };
  });
  const expectedProviders = new Set(
    condition === "vanilla" ? [] : condition === "kairn" ? ["kairn"] : condition === "reasonblocks" ? ["reasonblocks"] : ["kairn", "reasonblocks"]
  );
  if (
    guidance.length !== expectedProviders.size ||
    guidance.some((entry) => !expectedProviders.has(entry.provider))
  ) {
    throw new Error(`${condition}.guidance does not match the arm definition`);
  }
  return {
    inputTokens: integer("inputTokens"),
    cachedInputTokens: integer("cachedInputTokens"),
    cacheCreationInputTokens: integer("cacheCreationInputTokens"),
    outputTokens: integer("outputTokens"),
    expectedTotalModelTokens: integer("expectedTotalModelTokens"),
    guidance
  };
}

function assertWithin(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside benchmarks/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
