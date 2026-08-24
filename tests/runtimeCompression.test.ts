// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { createFixtureRepo } from "./helpers.js";

describe("KairnRuntime evidence compression", () => {
  it("returns attributed compressed evidence and records aggregate metrics", async () => {
    const runtime = new KairnRuntime(createFixtureRepo());
    const { session } = await runtime.startTask("Diagnose a failing application test");
    const response = runtime.compressOutput({
      sessionId: session.id,
      type: "test",
      output: [
        "FAIL src/app.test.ts",
        "AssertionError: expected true to be false",
        ...Array.from({ length: 500 }, (_, index) => `worker trace ${index}`),
        "Command failed with exit code 1"
      ].join("\n"),
      budget: 360
    });
    const metrics = runtime.getMetrics(session.id);

    expect(response.files).toContain("src/app.test.ts");
    expect(response.metadata?.compression).toMatchObject({
      schemaVersion: 1,
      status: "compressed",
      evidenceClass: "test"
    });
    expect(metrics.compression).toMatchObject({ attempts: 1, compressed: 1, skipped: 0, failedOpen: 0 });
    expect(metrics.compression?.savedTokens).toBeGreaterThan(0);
    runtime.close();
  });

  it("distinguishes compressed, skipped, and failed-open attempts without retaining raw evidence", async () => {
    const runtime = new KairnRuntime(createFixtureRepo());
    const { session } = await runtime.startTask("Review local command evidence");
    const privateMarker = "private-command-evidence";

    runtime.compressOutput({
      sessionId: session.id,
      type: "test",
      output: [
        `FAIL src/app.test.ts > ${privateMarker}`,
        "AssertionError: expected true to be false",
        ...Array.from({ length: 500 }, (_, index) => `worker trace ${index}`),
        "Command failed with exit code 1"
      ].join("\n"),
      budget: 360
    });
    runtime.compressOutput({ sessionId: session.id, type: "lint", output: "No lint warnings or errors.", budget: 360 });
    runtime.compressOutput({
      sessionId: session.id,
      type: "generic",
      output: [
        "Error: request failed",
        ...Array.from({ length: 50 }, (_, index) => `    at handler${index} (/workspace/src/handler${index}.ts:${index + 1}:2)`),
        ...Array.from({ length: 600 }, (_, index) => `background worker ${index} completed`),
        "Process exited with status 1"
      ].join("\n"),
      budget: 180
    });

    const metrics = runtime.getMetrics(session.id);
    expect(metrics.compression).toMatchObject({ attempts: 3, compressed: 1, skipped: 1, failedOpen: 1 });
    expect(metrics.compression?.savedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(metrics.recentEvents)).not.toContain(privateMarker);
    runtime.close();
  });
});
