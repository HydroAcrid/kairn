import { describe, expect, it } from "vitest";
import { decideEditScope, editScopeBlock } from "../src/scope/editScope.js";
import type { ContextValueDecision, FileRecord } from "../src/types.js";

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

  it("does not treat non-existent log source paths as official edit scope", () => {
    const task = [
      "kubectl exec fails with a streaming error.",
      "Debug logs:",
      "WARN executor failed proxy/forwarder.go:773",
      "Selected verification tests from SWE-Bench Pro metadata: TestAuthenticate/local_user_and_remote_cluster",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: ["lib/utils/replace.go", "lib/kube/proxy/forwarder.go"],
      knownFiles: [
        file("lib/kube/proxy/forwarder.go"),
        file("lib/kube/proxy/server.go"),
        file("lib/utils/replace.go")
      ],
      contextDecision: decision({
        primaryFile: "lib/kube/proxy/forwarder.go",
        sourceRescue: true,
        canonicalSourceHit: true,
        recommendedDelivery: "one_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["lib/kube/proxy/forwarder.go"]);
    expect(scope.initialEditFiles).not.toContain("proxy/forwarder.go");
    expect(scope.initialEditFiles).not.toContain("lib/utils/replace.go");
    expect(scope.readOnlyFiles).toContain("lib/utils/replace.go");
    expect(scope.strictBoundary).toBe(true);
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

  it("allows prompt-derived multi-file official scope for central backend configuration tasks", () => {
    const task = [
      "Teleport HSM and KMS test configuration logic is duplicated across backend test files.",
      "Requirements:",
      "- Provide a unified HSMTestConfig function that automatically detects available HSM/KMS backends.",
      "- Add dedicated configuration functions for SoftHSM, YubiHSM, CloudHSM, AWS KMS, and GCP KMS.",
      "- Centralize backend detection and environment validation logic.",
      "Selected verification tests from SWE-Bench Pro metadata: TestBackends, TestBackends/fake_gcp_kms, TestBackends/fake_aws_kms",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: ["lib/auth/keystore/pkcs11.go", "lib/auth/keystore/testhelpers.go"],
      contextDecision: decision({
        primaryFile: "lib/auth/keystore/pkcs11.go",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["lib/auth/keystore/pkcs11.go", "lib/auth/keystore/testhelpers.go"]);
    expect(scope.strictBoundary).toBe(true);
    expect(scope.readOnlyFiles).not.toContain("lib/auth/keystore/testhelpers.go");
  });

  it("keeps unrelated generic test helpers out of central backend configuration edit scope", () => {
    const task = [
      "Teleport HSM and KMS test configuration logic is duplicated across backend test files.",
      "Requirements:",
      "- Provide a unified HSMTestConfig function that automatically detects available HSM/KMS backends.",
      "- Add dedicated configuration functions for SoftHSM, YubiHSM, CloudHSM, AWS KMS, and GCP KMS.",
      "Selected verification tests from SWE-Bench Pro metadata: TestBackends, TestBackends/fake_gcp_kms, TestBackends/fake_aws_kms",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: ["lib/auth/keystore/pkcs11.go", "api/utils/sshutils/test.go"],
      contextDecision: decision({
        primaryFile: "lib/auth/keystore/pkcs11.go",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["lib/auth/keystore/pkcs11.go"]);
    expect(scope.initialEditFiles).not.toContain("api/utils/sshutils/test.go");
  });

  it("keeps frontend autocomplete and tests out of backend autocomplete official edit scope", () => {
    const task = [
      "Autocomplete endpoints lack unified logic and flexible OLID handling.",
      "The file ‘autocomplete.py’ must define a reusable page class named autocomplete.",
      "The function find_olid_in_string must extract an OLID and olid_to_key must convert it.",
      "Selected verification tests from SWE-Bench Pro metadata: openlibrary/plugins/worksearch/tests/test_autocomplete.py",
      "These tests are verification targets only; do not edit tests, snapshots, docs, examples, generated files, or unrelated files.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: [
        "openlibrary/plugins/worksearch/autocomplete.py",
        "openlibrary/utils/schema.py",
        "openlibrary/plugins/openlibrary/js/autocomplete.js",
        "openlibrary/catalog/add_book/tests/test_add_book.py"
      ],
      contextDecision: decision({
        primaryFile: "openlibrary/plugins/worksearch/autocomplete.py",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["openlibrary/plugins/worksearch/autocomplete.py"]);
    expect(scope.initialEditFiles).not.toContain("openlibrary/utils/schema.py");
    expect(scope.initialEditFiles).not.toContain("openlibrary/plugins/openlibrary/js/autocomplete.js");
    expect(scope.initialEditFiles).not.toContain("openlibrary/catalog/add_book/tests/test_add_book.py");
  });

  it("keeps generic date helpers and leaf modules out of deprecation lifecycle official edit scope", () => {
    const task = [
      "Support deprecation by date in modules.",
      "Deprecated aliases should validate version or date and display warnings.",
      "Internal errors should mention removed_in_version and removed_at_date.",
      "Selected verification tests from SWE-Bench Pro metadata: test/lib/ansible_test/_internal/sanity/validate_modules.py, test/lib/ansible_test/_data/sanity/validate-modules/validate_modules/schema.py, test/lib/ansible_test/_data/sanity/validate-modules/validate_modules/main.py, test/lib/ansible_test/_data/sanity/validate-modules/validate_modules/utils.py.",
      "Fix the issue in production source only."
    ].join(" ");
    const scope = decideEditScope({
      task,
      candidateFiles: [
        "lib/ansible/module_utils/common/parameters.py",
        "lib/ansible/module_utils/basic.py",
        "lib/ansible/module_utils/facts/system/date_time.py",
        "lib/ansible/module_utils/facts/utils.py",
        "lib/ansible/modules/assert.py",
        "lib/ansible/module_utils/common/warnings.py",
        "lib/ansible/module_utils/csharp/Ansible.Basic.cs",
        "lib/ansible/utils/display.py"
      ],
      contextDecision: decision({
        primaryFile: "lib/ansible/module_utils/common/parameters.py",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual([
      "lib/ansible/module_utils/common/parameters.py",
      "lib/ansible/module_utils/basic.py",
      "lib/ansible/module_utils/common/warnings.py",
      "lib/ansible/module_utils/csharp/Ansible.Basic.cs",
      "lib/ansible/utils/display.py"
    ]);
    expect(scope.initialEditFiles).not.toContain("lib/ansible/module_utils/facts/system/date_time.py");
    expect(scope.initialEditFiles).not.toContain("lib/ansible/module_utils/facts/utils.py");
    expect(scope.initialEditFiles).not.toContain("lib/ansible/modules/assert.py");
  });

  it("allows prompt-derived schema companions into official config-setting edit scope", () => {
    const task = [
      "Requirements:",
      "- A configuration setting named `qt.workarounds.disable_accelerated_2d_canvas` must exist.",
      "- The setting must accept `always`, `never`, and `auto`.",
      "- The setting must affect QtWebEngine accelerated 2D canvas arguments at runtime.",
      "Selected verification tests from SWE-Bench Pro metadata: tests/unit/config/test_qtargs.py",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: ["qutebrowser/config/configdata.yml", "qutebrowser/config/qtargs.py"],
      allowedDiffScopes: [{ file: "qutebrowser/config/qtargs.py", allowWholeFile: true }],
      contextDecision: decision({
        primaryFile: "qutebrowser/config/configdata.yml",
        sourceRescue: true,
        canonicalSourceHit: true,
        multiSurfaceSignal: true,
        companionSpecific: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["qutebrowser/config/qtargs.py", "qutebrowser/config/configdata.yml"]);
    expect(scope.readOnlyFiles).not.toContain("qutebrowser/config/configdata.yml");
    expect(scope.strictBoundary).toBe(true);
  });

  it("keeps unrelated selected-test schema companions read-only when the prompt does not require schema changes", () => {
    const task = [
      "Fix QtWebEngine accelerated 2D canvas arguments at runtime.",
      "Selected verification tests from SWE-Bench Pro metadata: tests/unit/config/test_qtargs.py",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: ["qutebrowser/config/configdata.yml", "qutebrowser/config/qtargs.py"],
      allowedDiffScopes: [{ file: "qutebrowser/config/qtargs.py", allowWholeFile: true }],
      contextDecision: decision({
        primaryFile: "qutebrowser/config/qtargs.py",
        sourceRescue: true,
        canonicalSourceHit: true,
        companionSpecific: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual(["qutebrowser/config/qtargs.py"]);
    expect(scope.readOnlyFiles).toContain("qutebrowser/config/configdata.yml");
    expect(scope.strictBoundary).toBe(true);
  });

  it("allows prompt-derived UI surface scope to expand narrow official prompt metadata", () => {
    const task = [
      "Voice broadcast liveness icon provides inconsistent feedback.",
      "Requirements:",
      "- Add an optional grey prop to the LiveBadge component.",
      "- Update VoiceBroadcastHeader to accept a VoiceBroadcastLiveness value.",
      "- Define VoiceBroadcastLiveness in src/voice-broadcast/index.ts.",
      "- Implement liveness state management inside VoiceBroadcastPlayback.",
      "- Expose liveness in the useVoiceBroadcastPlayback hook.",
      "- Add isLast(event) in VoiceBroadcastChunkEvents.",
      "- Update playback and recording call sites to pass the right liveness state.",
      "Selected verification tests from SWE-Bench Pro metadata: test/voice-broadcast/components/atoms/LiveBadge-test.tsx, test/voice-broadcast/models/VoiceBroadcastPlayback-test.ts, test/voice-broadcast/components/molecules/VoiceBroadcastPlaybackBody-test.tsx",
      "These tests are verification targets only; do not edit tests.",
      "Fix the issue in production source only."
    ].join("\n");
    const scope = decideEditScope({
      task,
      candidateFiles: [
        "src/voice-broadcast/components/atoms/LiveBadge.tsx",
        "src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx",
        "src/voice-broadcast/components/molecules/VoiceBroadcastPlaybackBody.tsx",
        "src/voice-broadcast/components/molecules/VoiceBroadcastRecordingBody.tsx",
        "src/voice-broadcast/components/molecules/VoiceBroadcastRecordingPip.tsx",
        "src/voice-broadcast/components/molecules/VoiceBroadcastPreRecordingPip.tsx",
        "src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts",
        "src/voice-broadcast/index.ts",
        "src/voice-broadcast/models/VoiceBroadcastPlayback.ts",
        "src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts",
        "res/css/voice-broadcast/atoms/_LiveBadge.pcss"
      ],
      contextDecision: decision({
        primaryFile: "src/voice-broadcast/components/atoms/LiveBadge.tsx",
        sourceRescue: true,
        multiSurfaceSignal: true,
        recommendedDelivery: "multi_file_directive"
      })
    });

    expect(scope.initialEditFiles).toEqual([
      "src/voice-broadcast/components/atoms/LiveBadge.tsx",
      "src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx",
      "src/voice-broadcast/components/molecules/VoiceBroadcastPlaybackBody.tsx",
      "src/voice-broadcast/components/molecules/VoiceBroadcastRecordingBody.tsx",
      "src/voice-broadcast/components/molecules/VoiceBroadcastRecordingPip.tsx",
      "src/voice-broadcast/index.ts",
      "src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts",
      "src/voice-broadcast/models/VoiceBroadcastPlayback.ts",
      "src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts"
    ]);
    expect(scope.initialEditFiles).not.toContain("src/voice-broadcast/components/molecules/VoiceBroadcastPreRecordingPip.tsx");
    expect(scope.initialEditFiles).not.toContain("res/css/voice-broadcast/atoms/_LiveBadge.pcss");
    expect(scope.forbiddenEditPatterns).toEqual(expect.arrayContaining(["res/css/", "*.pcss"]));
    expect(scope.strictBoundary).toBe(true);
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

function file(filePath: string): FileRecord {
  return {
    rootPath: "/repo",
    path: filePath,
    language: filePath.endsWith(".go") ? "go" : "typescript",
    kind: "source",
    size: 100,
    hash: filePath,
    importance: 1,
    updatedAt: "2026-05-30T00:00:00.000Z"
  };
}
