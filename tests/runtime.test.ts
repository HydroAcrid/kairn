import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { createFixtureRepo } from "./helpers.js";

describe("KairnRuntime", () => {
  it("initializes state and starts a task session", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const init = await runtime.init();
    const started = await runtime.startTask("Update dashboard rendering");

    expect(init.scan.files.length).toBeGreaterThan(0);
    expect(started.session.id).toMatch(/^task_/);
    expect(started.response.files).toContain("src/app.ts");

    runtime.close();
  });

  it("reads files, symbols, related files, tests, diff, and compressed output", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");

    const file = await runtime.readFile({ sessionId: session.id, target: "src/app.ts" });
    const symbol = await runtime.readSymbol({
      sessionId: session.id,
      target: "src/app.ts",
      symbol: "renderDashboard"
    });
    const related = await runtime.getRelatedFiles({ sessionId: session.id, target: "src/app.ts" });
    const tests = await runtime.findTests({ sessionId: session.id, target: "src/app.ts" });
    const symbolContext = await runtime.findContext({ sessionId: session.id, query: "DashboardMetrics" });
    const diff = await runtime.reviewDiff({ sessionId: session.id });
    const compressed = runtime.compressOutput({
      sessionId: session.id,
      type: "test",
      output: "FAIL src/app.test.ts\nExpected true to be false"
    });

    expect(file.mode).toBe("exact_code");
    expect(symbol.symbols).toEqual(["renderDashboard"]);
    expect(related.related).toContain("src/user.ts");
    expect(related.content).toMatch(/imports target|imported by target|target imports file/);
    expect(tests.files).toContain("src/app.test.ts");
    expect(symbolContext.files).toContain("src/widgets.ts");
    expect(diff.files).toContain("src/app.ts");
    expect(compressed.content).toContain("Expected true");

    runtime.close();
  });

  it("uses graph edges for parent route relationships", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard card");

    const related = await runtime.getRelatedFiles({
      sessionId: session.id,
      target: "app/dashboard/DashboardCard.tsx"
    });

    expect(related.related).toContain("app/dashboard/page.tsx");
    expect(related.content).toContain("parent route");

    runtime.close();
  });
});
