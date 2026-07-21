import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_ROUTING_PREVIEW_MAX_BYTES,
  evaluateEvidenceRoutingShadow
} from "../src/compression/evidenceRoutingPolicy.js";
import {
  DEFAULT_EVIDENCE_ROUTING_CONFIG,
  loadEvidenceRoutingConfig
} from "../src/config/evidenceRouting.js";
import { ensureKairnDir } from "../src/config/paths.js";
import { summarizeEvidenceRoutingShadow } from "../src/metrics/summary.js";
import type { MetricsEventKind } from "../src/types.js";
import { createFixtureRepo } from "./helpers.js";

const ROOT = "/workspace/project";

function progressLines(label: string, count = 420): string[] {
  return Array.from({ length: count }, (_, index) => `${label} ${index} completed in ${index + 1}ms`);
}

function evaluate(overrides: Partial<Parameters<typeof evaluateEvidenceRoutingShadow>[0]> = {}) {
  return evaluateEvidenceRoutingShadow({
    output: "Build completed with 12 modules.",
    type: "generic",
    rootPath: ROOT,
    linkedFiles: [],
    eventKind: "tool",
    exitCode: 0,
    trivialSuccessfulOutput: false,
    currentDeliveryTokens: 40,
    budget: 320,
    ...overrides
  });
}

describe("shadow evidence-routing policy", () => {
  it("classifies source-like and compact evidence as exact", () => {
    const source = Array.from(
      { length: 180 },
      (_, index) => `export const value${index} = () => { return ${index}; };`
    ).join("\n");
    const sourceResult = evaluate({ output: source });
    const shortSourceResult = evaluate({
      output: "export const value = () => 1;",
      trivialSuccessfulOutput: true
    });
    const compactResult = evaluate({ output: "Build completed with 12 modules." });

    expect(sourceResult.receipt).toMatchObject({
      action: "exact",
      reason: "source_like_input",
      mode: "shadow"
    });
    expect(compactResult.receipt).toMatchObject({
      action: "exact",
      reason: "existing_delivery_preferred"
    });
    expect(shortSourceResult.receipt).toMatchObject({
      action: "exact",
      reason: "source_like_input"
    });
  });

  it("classifies safe attributed compression candidates as compress", () => {
    const output = [
      "FAIL src/core/math.test.ts > arithmetic > adds values",
      "AssertionError: expected 3 to be 4",
      "    at verifyResult (src/core/math.test.ts:42:8)",
      ...progressLines("worker heartbeat", 500),
      "Command failed with exit code 1"
    ].join("\n");
    const result = evaluate({
      output,
      type: "test",
      linkedFiles: ["src/core/math.test.ts"],
      eventKind: "failure",
      exitCode: 1
    });

    expect(result.receipt).toMatchObject({
      action: "compress",
      reason: "safe_compression_candidate",
      attributedFileCount: 1,
      compression: { status: "compressed", reason: "compressed" }
    });
    expect(result.receipt.candidateVsInputSavedTokens).toBeGreaterThan(0);
  });

  it("requests more evidence for an unattributed failure", () => {
    const result = evaluate({
      output: "Error: connection refused after retry",
      eventKind: "failure",
      exitCode: 1
    });

    expect(result.receipt).toMatchObject({
      action: "request_more",
      reason: "missing_repository_attribution",
      attributedFileCount: 0
    });
  });

  it("suppresses trivial success and large generic zero-signal output", () => {
    const trivial = evaluate({
      output: "Build completed.",
      trivialSuccessfulOutput: true
    });
    const lowSignal = evaluate({
      output: progressLines("background progress", 500).join("\n")
    });

    expect(trivial.receipt).toMatchObject({ action: "suppress", reason: "trivial_success" });
    expect(lowSignal.receipt).toMatchObject({ action: "suppress", reason: "low_signal_output" });
  });

  it("keeps failed-open evidence exact before considering missing attribution", () => {
    const output = [
      "Error: request failed",
      ...Array.from(
        { length: 60 },
        (_, index) => `    at handler${index} (/external/src/handler${index}.ts:${index + 1}:2)`
      ),
      ...progressLines("background worker", 900),
      "Process exited with status 1"
    ].join("\n");
    const result = evaluate({ output, eventKind: "failure", exitCode: 1, budget: 220 });

    expect(result.receipt).toMatchObject({
      action: "exact",
      reason: "unsafe_compression",
      compression: { status: "failed_open" }
    });
  });

  it("does not preview inputs over one MiB", () => {
    const output = "x".repeat(EVIDENCE_ROUTING_PREVIEW_MAX_BYTES + 1);
    const result = evaluate({ output });

    expect(result.receipt).toMatchObject({
      action: "exact",
      reason: "input_limit_exceeded",
      inputBytes: EVIDENCE_ROUTING_PREVIEW_MAX_BYTES + 1,
      compression: { status: "not_run", reason: "input_limit_exceeded" }
    });
    expect(result.receipt.inputHash).toBe(result.receipt.candidateHash);
  });

  it("is deterministic apart from latency and stores no raw evidence", () => {
    const marker = "private-shadow-evidence-marker";
    const output = [
      `FAIL src/private.test.ts > ${marker}`,
      "AssertionError: expected true to be false",
      ...progressLines("deterministic worker", 500),
      "Command failed with exit code 1"
    ].join("\n");
    const first = evaluate({ output, type: "test", linkedFiles: ["src/private.test.ts"], eventKind: "failure", exitCode: 1 });
    const second = evaluate({ output, type: "test", linkedFiles: ["src/private.test.ts"], eventKind: "failure", exitCode: 1 });

    expect({ ...first.receipt, elapsedMs: 0 }).toEqual({ ...second.receipt, elapsedMs: 0 });
    expect(JSON.stringify(first.receipt)).not.toContain(marker);
    expect(JSON.stringify(first.receipt)).not.toContain("src/private.test.ts");
  });

  it("loads only the explicit shadow setting and fails closed", () => {
    const root = createFixtureRepo();
    const configDir = path.join(root, ".kairn");
    const configPath = path.join(configDir, "config.json");
    fs.mkdirSync(configDir, { recursive: true });

    expect(loadEvidenceRoutingConfig(root)).toEqual(DEFAULT_EVIDENCE_ROUTING_CONFIG);
    fs.writeFileSync(configPath, JSON.stringify({ routing: { evidence: { mode: "shadow" } } }));
    expect(loadEvidenceRoutingConfig(root)).toEqual({ mode: "shadow" });
    fs.writeFileSync(configPath, JSON.stringify({ routing: { evidence: { mode: "automatic" } } }));
    expect(loadEvidenceRoutingConfig(root)).toEqual({ mode: "off" });
    fs.writeFileSync(configPath, "{not-json");
    expect(loadEvidenceRoutingConfig(root)).toEqual({ mode: "off" });
  });

  it("writes shadow routing disabled in newly generated configuration", () => {
    const root = createFixtureRepo();
    const paths = ensureKairnDir(root);
    const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as {
      routing?: { evidence?: { mode?: string } };
    };

    expect(config.routing?.evidence?.mode).toBe("off");
    expect(loadEvidenceRoutingConfig(root)).toEqual({ mode: "off" });
  });

  it("aggregates only projected compress decisions", () => {
    const compressed = evaluate({
      output: [
        "FAIL src/core/math.test.ts > adds values",
        "AssertionError: expected 3 to be 4",
        ...progressLines("worker heartbeat", 500),
        "Command failed with exit code 1"
      ].join("\n"),
      type: "test",
      linkedFiles: ["src/core/math.test.ts"],
      eventKind: "failure",
      exitCode: 1
    }).receipt;
    const exact = evaluate({ output: "Build completed with 12 modules." }).receipt;
    const events = [compressed, exact].map((receipt) => ({
      eventKind: "evidence_routing_shadow" as MetricsEventKind,
      metadata: { evidenceRoutingShadow: receipt }
    }));
    const summary = summarizeEvidenceRoutingShadow(events);

    expect(summary).toMatchObject({
      observations: 2,
      byAction: { compress: 1, exact: 1, suppress: 0, request_more: 0 },
      projectedCompressibleInputTokens: compressed.inputTokens,
      projectedCompressedTokens: compressed.candidateTokens,
      projectedSavedTokens: compressed.candidateVsInputSavedTokens
    });
    expect(summary.projectedSavingsRate).toBeGreaterThan(0);
  });
});
