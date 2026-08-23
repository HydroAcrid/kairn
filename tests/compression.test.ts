import { describe, expect, it } from "vitest";
import {
  routeEvidenceCompression,
  validateEvidenceAnchorPreservation
} from "../src/compression/routeEvidence.js";
import type { EvidenceClass, OutputKind } from "../src/types.js";
import { estimateTokens } from "../src/utils/tokens.js";

function repeatedLines(label: string, count = 360): string[] {
  return Array.from({ length: count }, (_, index) => `${label} ${index} completed in ${index + 1}ms`);
}

describe("Kairn-native evidence compression router", () => {
  it("compresses repeated test evidence while preserving paths, assertions, stack frames, and exit status", () => {
    const output = [
      "RUN v3.2.1 /workspace",
      "FAIL src/core/math.test.ts > arithmetic > adds values",
      "AssertionError: expected 3 to be 4",
      "    at verifyResult (src/core/math.test.ts:42:8)",
      ...repeatedLines("worker heartbeat", 500),
      "Tests: 1 failed, 12 passed",
      "Command failed with exit code 1"
    ].join("\n");

    const result = routeEvidenceCompression({ output, type: "test", budget: 360 });

    expect(result.metadata.status).toBe("compressed");
    expect(result.content).toContain("FAIL src/core/math.test.ts > arithmetic > adds values");
    expect(result.content).toContain("AssertionError: expected 3 to be 4");
    expect(result.content).toContain("at verifyResult (src/core/math.test.ts:42:8)");
    expect(result.content).toContain("Command failed with exit code 1");
    expect(result.files).toEqual(["src/core/math.test.ts"]);
    expect(result.metadata.anchors.byCategory.path_location).toBeGreaterThan(0);
    expect(result.metadata.anchors.byCategory.stack_frame).toBe(1);
    expect(result.metadata.collapsedRepetitionCount).toBeGreaterThan(400);
    expect(result.metadata.savedTokens).toBeGreaterThan(128);
    expect(result.metadata.savingsRate).toBeGreaterThan(0.1);
  });

  it.each([
    {
      name: "test",
      type: "test" as OutputKind,
      expectedClass: "test" as EvidenceClass,
      head: ["FAIL test/service.test.ts > retries requests", "AssertionError: expected 2 to be 3"],
      tail: "Tests: 1 failed"
    },
    {
      name: "CI",
      type: "generic" as OutputKind,
      expectedClass: "ci" as EvidenceClass,
      head: ["GitHub Actions runner", "##[error] build step failed in src/build.ts:18:4"],
      tail: "Process completed with exit code 1"
    },
    {
      name: "lint",
      type: "lint" as OutputKind,
      expectedClass: "lint" as EvidenceClass,
      head: ["src/ui.ts:4:2 error Unexpected console statement no-console"],
      tail: "1 problem (1 error, 0 warnings)"
    },
    {
      name: "typecheck",
      type: "typecheck" as OutputKind,
      expectedClass: "typecheck" as EvidenceClass,
      head: ["src/model.ts:9:7 - error TS2322: Type string is not assignable to number"],
      tail: "Found 1 error in src/model.ts:9"
    },
    {
      name: "stack trace",
      type: "generic" as OutputKind,
      expectedClass: "stack_trace" as EvidenceClass,
      head: [
        "TypeError: cannot read properties of undefined",
        "    at loadRecord (/workspace/src/store.ts:20:5)",
        "    at runJob (/workspace/src/job.ts:31:9)"
      ],
      tail: "Process exited with status 1"
    }
  ])("compresses bulky $name evidence with its inferred class", ({ type, expectedClass, head, tail }) => {
    const output = [...head, ...repeatedLines("progress record"), tail].join("\n");
    const result = routeEvidenceCompression({ output, type, budget: 360 });

    expect(result.metadata.status).toBe("compressed");
    expect(result.metadata.evidenceClass).toBe(expectedClass);
    for (const anchor of head) expect(result.content).toContain(anchor);
    expect(result.content).toContain(tail);
  });

  it("normalizes ANSI and CRLF while preserving Windows path anchors", () => {
    const windowsLocation = String.raw`C:\work tree\src\index.ts:10:5`;
    const output = [
      `\u001b[31m${windowsLocation} - error TS2345: Argument is invalid\u001b[0m`,
      ...repeatedLines("typecheck worker", 420),
      "Process exited with code 2"
    ].join("\r\n");

    const result = routeEvidenceCompression({ output, type: "typecheck", budget: 320 });

    expect(result.metadata.status).toBe("compressed");
    expect(result.content).toContain(windowsLocation);
    expect(result.content).not.toContain("\u001b");
    expect(result.files).toEqual(["C:/work tree/src/index.ts"]);
  });

  it("attributes only repository-local absolute paths when a root is provided", () => {
    const output = [
      "Error: request failed",
      "    at loadLocal (/workspace/project/src/local.ts:12:4)",
      "    at loadDependency (/opt/runtime/dependency.ts:8:2)",
      ...repeatedLines("request trace", 400),
      "Process exited with status 1"
    ].join("\n");
    const result = routeEvidenceCompression({
      output,
      type: "generic",
      budget: 320,
      rootPath: "/workspace/project"
    });

    expect(result.metadata.status).toBe("compressed");
    expect(result.content).toContain("/opt/runtime/dependency.ts:8:2");
    expect(result.files).toEqual(["src/local.ts"]);
  });

  it("returns short and already-budgeted output byte-for-byte", () => {
    const output = "FAIL src/short.test.ts\r\nAssertionError: expected true";
    const result = routeEvidenceCompression({ output, type: "test", budget: 1200 });

    expect(result.content).toBe(output);
    expect(result.metadata.status).toBe("skipped");
    expect(result.metadata.reason).toBe("within_budget");
    expect(result.metadata.inputHash).toBe(result.metadata.outputHash);
  });

  it("abstains on source-like input even when it exceeds the budget", () => {
    const output = Array.from(
      { length: 180 },
      (_, index) => `export const value${index} = () => { return ${index}; };`
    ).join("\n");
    const result = routeEvidenceCompression({ output, type: "generic", budget: 200 });

    expect(result.content).toBe(output);
    expect(result.metadata.status).toBe("skipped");
    expect(result.metadata.reason).toBe("source_like_input");
  });

  it("fails open when preserved anchors cannot fit inside the requested budget", () => {
    const stack = Array.from(
      { length: 60 },
      (_, index) => `    at handler${index} (/workspace/src/handler${index}.ts:${index + 1}:2)`
    );
    const output = [
      "Error: request failed",
      ...stack,
      ...repeatedLines("background worker", 900),
      "Process exited with status 1"
    ].join("\n");
    const result = routeEvidenceCompression({ output, type: "generic", budget: 220 });

    expect(result.content).toBe(output);
    expect(result.metadata.status).toBe("failed_open");
    expect(result.metadata.reason).toBe("anchor_budget_exceeded");
    expect(result.metadata.savedTokens).toBe(0);
  });

  it("skips candidates that do not clear the absolute savings threshold", () => {
    const signals = Array.from(
      { length: 16 },
      (_, index) => `ERROR unique-${String.fromCharCode(97 + index)} failure remained`
    );
    const output = [...signals.slice(0, 6), "ordinary " + "x".repeat(400), ...signals.slice(6)].join("\n");
    const result = routeEvidenceCompression({
      output,
      type: "generic",
      budget: estimateTokens(output) - 1
    });

    expect(result.content).toBe(output);
    expect(result.metadata.status).toBe("skipped");
    expect(result.metadata.reason).toBe("insufficient_savings");
  });

  it("detects anchor loss during candidate validation", () => {
    const original = [
      "FAIL src/parser.test.ts > rejects malformed records",
      "ParseError: unexpected token",
      "    at parseRecord (src/parser.ts:8:3)",
      "Command failed with exit code 1"
    ].join("\n");

    expect(validateEvidenceAnchorPreservation(original, original)).toBe(true);
    expect(validateEvidenceAnchorPreservation(original, "FAIL src/parser.test.ts > rejects malformed records")).toBe(false);
  });

  it("is deterministic and keeps receipts free of raw evidence", () => {
    const marker = "private-evidence-marker";
    const output = [
      `Error: ${marker}`,
      ...repeatedLines("deterministic record", 480),
      "Process exited with status 1"
    ].join("\n");
    const first = routeEvidenceCompression({ output, type: "generic", budget: 300 });
    const second = routeEvidenceCompression({ output, type: "generic", budget: 300 });

    expect(first.content).toBe(second.content);
    expect(first.files).toEqual(second.files);
    expect({ ...first.metadata, elapsedMs: 0 }).toEqual({ ...second.metadata, elapsedMs: 0 });
    expect(JSON.stringify(first.metadata)).not.toContain(marker);
  });
});
