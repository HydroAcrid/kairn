import { describe, expect, it } from "vitest";
import { decideEditScope, editScopeBlock } from "../src/scope/editScope.js";
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
    expect(editScopeBlock(scope).join("\n")).toContain("Edit only the initial scope first");
  });

  it("treats benchmark-style production-source instructions as one-file scope", () => {
    const scope = decideEditScope({
      task: "Selected tests from SWE-Bench Pro metadata: contrib/trivy/pkg/converter_test.go\n\nFix the issue in production source. Do not edit unrelated files. Avoid broad scans once the relevant source surface is known.",
      candidateFiles: ["contrib/trivy/pkg/converter.go", "scanner/trivy/jar/parse.go"],
      contextDecision: decision({
        primaryFile: "contrib/trivy/pkg/converter.go",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        companionSpecific: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["contrib/trivy/pkg/converter.go"]);
    expect(scope.readOnlyFiles).toContain("contrib/trivy/pkg/converter_test.go");
    expect(scope.readOnlyFiles).toContain("scanner/trivy/jar/parse.go");
    expect(scope.forbiddenEditPatterns).toContain("tests/");
  });

  it("treats official harness scopes as hard edit boundaries", () => {
    const scope = decideEditScope({
      task: "Selected tests from SWE-Pro metadata: scanner/scanner_test.go\n\nFix the issue in production source. Do not edit unrelated files.",
      candidateFiles: ["scanner/scanner.go", "scanner/ssh_helpers.go", "scanner/scanner_test.go"],
      allowedDiffScopes: [{ file: "scanner/scanner.go" }],
      contextDecision: decision({
        primaryFile: "scanner/scanner.go",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        companionSpecific: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["scanner/scanner.go"]);
    expect(scope.readOnlyFiles).toContain("scanner/ssh_helpers.go");
    expect(scope.strictBoundary).toBe(true);
    expect(scope.allowedExpansionTriggers.join(" ")).toContain("do not expand edit scope");
    const block = editScopeBlock(scope).join("\n");
    expect(block).toContain("Hard boundary");
    expect(block).toContain("Do not create or edit sibling/helper production files");
    expect(block).toContain("Expansion policy:");
  });

  it("uses official prompt source metadata as strict patch scope", () => {
    const task = [
      "Affected Scope: Server initialization in `internal/cmd/grpc.go`",
      "New Interface: NewProvider Function",
      "File Path: internal/tracing/tracing.go",
      "Selected verification tests from SWE-Bench Pro metadata: TestGetTraceExporter, TestNewResourceDefault",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: ["internal/cmd/grpc.go", "internal/config/tracing.go", "internal/tracing/tracing.go"],
      contextDecision: decision({
        primaryFile: "internal/cmd/grpc.go",
        sourceRescue: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["internal/cmd/grpc.go", "internal/tracing/tracing.go"]);
    expect(scope.readOnlyFiles).toContain("internal/config/tracing.go");
    expect(scope.strictBoundary).toBe(true);
    expect(scope.scopeSource).toBe("official_harness");
  });

  it("keeps official production prompts without source metadata to one strict source file", () => {
    const task = [
      "Selected verification tests from SWE-Bench Pro metadata: TestScannerHostKeys",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: ["scanner/scanner.go", "scanner/ssh_helpers.go"],
      contextDecision: decision({
        primaryFile: "scanner/scanner.go",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["scanner/scanner.go"]);
    expect(scope.readOnlyFiles).toContain("scanner/ssh_helpers.go");
    expect(scope.strictBoundary).toBe(true);
    expect(scope.allowedExpansionTriggers.join(" ")).toContain("do not expand edit scope");
  });

  it("keeps unmentioned provider variants out of official edit scope", () => {
    const task = [
      "Location: `internal/server/auth/http.go`",
      "Selected verification tests from SWE-Bench Pro metadata: TestErrorHandler, TestHandler",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: [
        "internal/server/auth/http.go",
        "internal/server/auth/method/oidc/http.go",
        "internal/cmd/auth.go"
      ],
      contextDecision: decision({
        primaryFile: "internal/server/auth/http.go",
        sourceRescue: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["internal/server/auth/http.go", "internal/cmd/auth.go"]);
    expect(scope.initialEditFiles).not.toContain("internal/server/auth/method/oidc/http.go");
    expect(scope.readOnlyFiles).toContain("internal/server/auth/method/oidc/http.go");
    expect(scope.strictBoundary).toBe(true);
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
