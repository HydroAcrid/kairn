import { describe, expect, it } from "vitest";
import { decideEditScope } from "../src/scope/editScope.js";
import type { ContextValueDecision } from "../src/types.js";

describe("edit scope controller", () => {
  it("keeps cheap exact-source tasks to one production file with tests read-only", () => {
    const scope = decideEditScope({
      task: "Debug the seeded regression. Fix src/app.ts and preserve behavior.",
      candidateFiles: ["src/app.ts", "src/app.test.ts", "docs/app.md"],
      contextDecision: decision({
        primaryFile: "src/app.ts",
        exactSourceHit: true,
        cheapSingleSource: true,
        recommendedDelivery: "one_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["src/app.ts"]);
    expect(scope.readOnlyFiles).toContain("src/app.test.ts");
    expect(scope.forbiddenEditPatterns).toContain("tests/");
    expect(scope.scopeConfidence).toBe("high");
  });

  it("caps multi-file debug scope to two production files", () => {
    const scope = decideEditScope({
      task: "Debug the router/dependency interaction across files.",
      candidateFiles: ["src/router.ts", "src/dependencies.ts", "src/router.test.ts", "examples/router.ts"],
      contextDecision: decision({
        primaryFile: "src/router.ts",
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["src/router.ts", "src/dependencies.ts"]);
    expect(scope.readOnlyFiles).toContain("src/router.test.ts");
    expect(scope.initialEditFiles).not.toContain("examples/router.ts");
  });

  it("keeps production-source-only source rescue to one edit file even with companion evidence", () => {
    const scope = decideEditScope({
      task: "Debug the seeded failing check. Fix the production source and do not edit unrelated files.",
      candidateFiles: ["src/client.ts", "src/shared/utils.ts", "src/node/plugins/importAnalysis.ts"],
      contextDecision: decision({
        primaryFile: "src/client.ts",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        companionSpecific: true,
        recommendedDelivery: "one_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["src/client.ts"]);
    expect(scope.readOnlyFiles).toEqual(expect.arrayContaining(["src/shared/utils.ts", "src/node/plugins/importAnalysis.ts"]));
    expect(scope.scopeSource).toBe("source_rescue");
  });

  it("treats production header fixes as one-file source scope", () => {
    const scope = decideEditScope({
      task: "Debug the seeded failing C++ check. Fix the production header and do not edit unrelated files.",
      candidateFiles: ["include/fmt/base.h", "include/fmt/format-inl.h"],
      contextDecision: decision({
        primaryFile: "include/fmt/base.h",
        exactSourceHit: true,
        sourceRescue: true,
        multiSurfaceSignal: true,
        companionSpecific: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["include/fmt/base.h"]);
    expect(scope.readOnlyFiles).toContain("include/fmt/format-inl.h");
    expect(scope.scopeSource).toBe("exact_source");
  });

  it("allows test edits only when the task explicitly asks for them", () => {
    const scope = decideEditScope({
      task: "Update the snapshot tests for the new expected output.",
      candidateFiles: ["tests/app.test.ts"],
      contextDecision: decision({
        primaryFile: "tests/app.test.ts",
        recommendedDelivery: "one_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["tests/app.test.ts"]);
    expect(scope.forbiddenEditPatterns).not.toContain("tests/");
  });
});

function decision(overrides: Partial<ContextValueDecision>): ContextValueDecision {
  return {
    score: 80,
    action: "shrink",
    reasons: [],
    topScore: 500,
    topGap: 300,
    language: "typescript",
    exactPathMentioned: false,
    recommendedDelivery: "one_file_directive",
    estimatedContextCost: 400,
    expectedSavingsRisk: "medium",
    debugSignal: true,
    easyTaskSignal: false,
    ...overrides
  };
}
