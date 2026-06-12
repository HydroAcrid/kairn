import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSessionWorkingSet } from "../src/ledger/workingSet.js";
import { formatShrunkPrimeContext, officialGuardrailVariantFor } from "../src/prime/formatPrime.js";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import type { SessionLedgerEvent } from "../src/types.js";
import { estimateTokens } from "../src/utils/tokens.js";
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

  it("records and summarizes durable session ledger events", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Recommended app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "agent_file_touched",
      filePath: "src/app.ts",
      source: "agent",
      summary: "Agent touched app source"
    });

    const events = runtime.getSessionLedger(session.id);
    const summary = runtime.summarizeSessionLedger(session.id);

    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["context_recommended", "agent_file_touched"]));
    expect(summary.recommendedFilesUsed).toContain("src/app.ts");
    expect(summary.currentPhase).toBe("implementation");
    expect(summary.workingSet.activeFiles).toContain("src/app.ts");
    expect(summary.workingSet.recentlyTouchedFiles).toContain("src/app.ts");

    runtime.close();
  });

  it("suppresses duplicate automatic prime context in the same session", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update job tracker mobile layout");

    const first = await runtime.primeContext({
      task: "Update job tracker mobile layout",
      sessionId: session.id,
      budget: 700
    });
    const second = await runtime.primeContext({
      task: "Update job tracker mobile layout",
      sessionId: session.id,
      budget: 700
    });
    const ledger = runtime.summarizeSessionLedger(session.id);

    expect(first.files.length).toBeGreaterThan(0);
    expect(second.contextDecision?.action).toBe("suppress");
    expect(ledger.repeatedFilesAvoided).toBeGreaterThanOrEqual(1);
    expect(ledger.workingSet.shownFiles.length).toBeGreaterThan(0);

    runtime.close();
  });

  it("requests runtime evidence before expensive source retrieval for procedural QnA", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Run the dashboard import command twice and tell me what log output appears.",
      budget: 900
    });

    expect(prime.contextDecision?.action).toBe("request_evidence");
    expect(prime.contextDecision?.taskFrame).toBe("runtime_procedural");
    expect(prime.contextDecision?.evidenceRequest?.kind).toBe("runtime_scope");
    expect(prime.files).toEqual([]);
    expect(prime.timings?.findContextMs).toBeUndefined();
    expect(prime.content).toContain("Kairn Needs One More Signal");

    runtime.close();
  });

  it("keeps a tiny edit-scope guardrail for automatic production-source-only tasks", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Debug the greeting helper. Names with whitespace should be trimmed before rendering. Fix the production source and do not edit unrelated files.",
      budget: 900,
      source: "codex"
    });

    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.contextDecision?.recommendedDelivery).toBe("one_file_directive");
    expect(prime.content).toContain("Edit scope");
    expect(prime.content).toContain("Initial edit scope");
    expect(prime.files.length).toBeGreaterThanOrEqual(1);

    runtime.close();
  });

  it("uses a compact source map for read-only source-routing prompts", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "src/black"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/black/lines.py"), "class Line:\n    pass\n\ndef append_comment(line):\n    return line\n");
    fs.writeFileSync(path.join(root, "src/black/comments.py"), "def normalize_fmt_off(comment):\n    return comment\n");
    fs.writeFileSync(path.join(root, "src/black/linegen.py"), "class LineGenerator:\n    def visit_default(self, node):\n        return node\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: "Diagnose source ownership only: identify the smallest production source files involved when Black LineGenerator creates output lines and comment handling changes line splitting behavior. Do not edit files. Return the relevant file paths and a short reason for each.",
        budget: 900,
        source: "codex"
      });

      expect(prime.contextDecision?.action).toBe("shrink");
      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.content).toContain("# Kairn Source Map");
      expect(prime.content).toContain("Relevant source files:");
      expect(prime.content).toContain("Do not edit files");
      expect(prime.content).not.toContain("## Targeted Context");
      expect(prime.content).not.toContain("Edit scope");
      expect(prime.editScope).toBeUndefined();
      expect(estimateTokens(prime.content)).toBeLessThan(260);
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an ultra-minimal one-file guardrail for high-confidence session source fixes", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Debug formatUser. formatUser should trim whitespace before rendering. Fix the production source and do not edit unrelated files.",
      budget: 900
    });

    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.contextDecision?.recommendedDelivery).toBe("one_file_directive");
    expect(prime.files).toEqual(["src/user.ts"]);
    expect(prime.content).toContain("# Kairn Fix Guardrail");
    expect(prime.content).toContain("Do not edit tests, snapshots, docs, examples, generated files, or sibling source files");
    expect(prime.content).not.toContain("Focused context:");
    expect(estimateTokens(prime.content)).toBeLessThan(360);

    runtime.close();
  });

  it("uses a scope-only guardrail for long official exact-source patch prompts", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/PosthogAnalytics.ts"),
      [
        "export class PosthogAnalytics {",
        "  initialize(enabled: boolean) {",
        "    return enabled;",
        "  }",
        "  trackEvent(name: string) {",
        "    return name;",
        "  }",
        "}",
        ""
      ].join("\n")
    );
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "test/PosthogAnalytics-test.ts"), "test('posthog analytics', () => {})\n");
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: [
        "Title: PosthogAnalytics event tracking ignores privacy state.",
        "",
        "Requirements:",
        "- Update PosthogAnalytics so initialization and event tracking respect the enabled flag.",
        "- Fix the issue in production source. Do not edit unrelated files.",
        "",
        "Interface notes, not necessarily edit targets:",
        "No new interfaces are introduced.",
        "",
        "Selected tests from SWE-Bench Pro metadata: test/PosthogAnalytics-test.ts",
        "",
        "Additional detail ".repeat(120)
      ].join("\n"),
      budget: 900,
      source: "codex"
    });

    expect(prime.contextDecision?.taskFrame).toBe("official_patch");
    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.contextDecision?.recommendedDelivery).toBe("one_file_directive");
    expect(prime.contextDecision?.directiveStyle).toBe("scope_guardrail");
    expect(prime.files).toEqual(["src/PosthogAnalytics.ts"]);
    expect(prime.content).toContain("# Kairn Fix Guardrail");
    expect(prime.content).toContain("Task:");
    expect(prime.content).toContain("src/PosthogAnalytics.ts");
    expect(prime.content).toContain("Edit only: src/PosthogAnalytics.ts");
    expect(prime.content).toContain("Boundary: do not edit tests");
    expect(prime.content).toContain("Verify read-only: test/PosthogAnalytics-test.ts");
    expect(prime.content).toContain("report the missing evidence");
    expect(prime.content).not.toContain("Session:");
    expect(prime.content).not.toContain("Invariant to preserve:");
    expect(prime.content).not.toContain("Edit scope:");
    expect(prime.content).not.toContain("Focused context:");
    expect(prime.content).not.toContain("Additional detail Additional detail");
    expect(prime.metadata?.guardrailVariant).toBe("compact_official");
    expect(prime.metadata?.guardrailDirectiveStyle).toBe("scope_guardrail");
    expect(prime.metadata?.guardrailStrictOfficialScope).toBe(true);
    expect(prime.metadata?.deliveryTrace).toMatchObject({
      requiredSurface: "single_file",
      directiveStyle: "scope_guardrail",
      guardrailVariant: "compact_official",
      emittedFileCount: 1,
      editScopeSource: "exact_source",
      sizingReason: "official compact official"
    });
    expect((prime.metadata?.deliveryTrace as { estimatedDirectiveTokens?: number } | undefined)?.estimatedDirectiveTokens).toBeGreaterThan(0);
    expect((prime.metadata?.deliveryTrace as { estimatedSourceContextTokens?: number } | undefined)?.estimatedSourceContextTokens).toBeGreaterThanOrEqual(0);
    expect(estimateTokens(prime.content)).toBeLessThan(190);

    runtime.close();
  });

  it("does not auto-suppress cheap exact-source official patch guardrails", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "openlibrary/core"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "openlibrary/core/vendors.py"),
      [
        "def serialize(product):",
        "    metadata = {}",
        "    return metadata",
        "",
        "def clean_amazon_metadata_for_load(metadata):",
        "    accepted = ['title', 'authors']",
        "    return {key: value for key, value in metadata.items() if key in accepted}",
        ""
      ].join("\n")
    );
    fs.mkdirSync(path.join(root, "openlibrary/tests/core"), { recursive: true });
    fs.writeFileSync(path.join(root, "openlibrary/tests/core/test_vendors.py"), "def test_vendors(): pass\n");
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: [
        "## Amazon imports are missing language metadata from editions",
        "",
        "Requirements:",
        "- The function `serialize(product)` in `openlibrary/core/vendors.py` must include a key \"languages\" in its output when Amazon metadata provides language information.",
        "- The function `clean_amazon_metadata_for_load(metadata)` must preserve the \"languages\" field by including it in the list of accepted metadata keys.",
        "",
        "Selected tests from SWE-Bench Pro metadata: openlibrary/tests/core/sample_amazon_record.py, openlibrary/tests/core/test_vendors.py",
        "",
        "Fix the issue in production source. Do not edit unrelated files. Avoid broad scans once the relevant source surface is known."
      ].join("\n"),
      budget: 900,
      source: "codex"
    });

    expect(prime.contextDecision?.taskFrame).toBe("official_patch");
    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.contextDecision?.directiveStyle).toBe("scope_guardrail");
    expect(prime.files).toEqual(["openlibrary/core/vendors.py"]);
    expect(prime.content).toContain("openlibrary/core/vendors.py");
    expect(prime.content).toContain("Edit only: openlibrary/core/vendors.py");
    expect(prime.content).toContain("Boundary: do not edit tests");
    expect(prime.content).toContain("Verify read-only:");
    expect(prime.content).toContain("openlibrary/tests/core/test_vendors.py");
    expect(prime.content).not.toContain("Session:");
    expect(prime.content).not.toContain("Invariant to preserve:");
    expect(prime.content).not.toContain("Edit scope:");
    expect(prime.content).not.toContain("Focused context:");
    expect(prime.metadata?.guardrailVariant).toBe("compact_official");
    expect(prime.metadata?.deliveryTrace).toMatchObject({
      requiredSurface: "single_file",
      guardrailVariant: "compact_official",
      emittedFileRoleSummary: { production_source: 1 }
    });
    expect(estimateTokens(prime.content)).toBeLessThan(190);

    runtime.close();
  });

  it("keeps normal codex official prompts multi-file when the prompt implies multiple production surfaces", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "lib/ansible/plugins/lookup"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/utils"), { recursive: true });
    fs.mkdirSync(path.join(root, "test/units/plugins/lookup"), { recursive: true });
    fs.mkdirSync(path.join(root, "test/units/utils"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "lib/ansible/plugins/lookup/password.py"),
      [
        "def lookup_password(path, chars, encrypt=None, salt=None, ident=None):",
        "    stored = read_password_file(path)",
        "    if stored:",
        "        return stored",
        "    password = generate_password(chars)",
        "    return password",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "lib/ansible/utils/encrypt.py"),
      [
        "def encrypt_secret(secret, salt=None, ident=None):",
        "    return f'{ident}:{salt}:{secret}'",
        "",
        "def validate_salt_ident(salt, ident):",
        "    return bool(salt and ident)",
        ""
      ].join("\n")
    );
    fs.writeFileSync(path.join(root, "test/units/plugins/lookup/test_password.py"), "def test_password_lookup(): pass\n");
    fs.writeFileSync(path.join(root, "test/units/utils/test_encrypt.py"), "def test_encrypt_secret(): pass\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Title: password lookup should preserve encrypted stored passwords.",
          "",
          "Requirements:",
          "- Reuse the existing password file when it is present and readable.",
          "- Generate a password when no stored value exists.",
          "- Encrypt the generated password with the requested salt and ident.",
          "- Write the stored value atomically and keep error messages clear.",
          "",
          "Selected tests from SWE-Bench Pro metadata: test/units/plugins/lookup/test_password.py, test/units/utils/test_encrypt.py",
          "Fix the issue in production source. Do not edit unrelated files."
        ].join("\n"),
        budget: 1200,
        source: "codex"
      });

      expect(prime.contextDecision?.taskFrame).toBe("official_patch");
      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.files).toEqual(
        expect.arrayContaining([
          "lib/ansible/plugins/lookup/password.py",
          "lib/ansible/utils/encrypt.py"
        ])
      );
      expect(prime.metadata?.guardrailVariant).not.toBe("compact_official");
      expect(prime.content).toContain("lib/ansible/plugins/lookup/password.py");
      expect(prime.content).toContain("lib/ansible/utils/encrypt.py");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports official guardrail variants without formatting the body", () => {
    const editScope = {
      initialEditFiles: ["lib/ansible/vars/manager.py", "lib/ansible/utils/vars.py"],
      readOnlyFiles: ["test/units/vars/test_manager.py"],
      allowedExpansionTriggers: ["only if a focused failure names another production file"],
      forbiddenEditPatterns: ["tests/**", "docs/**"],
      scopeConfidence: "high" as const,
      scopeSource: "official_harness" as const,
      reason: "official metadata supplied production scope",
      strictBoundary: true,
      dynamic: true as const
    };

    expect(officialGuardrailVariantFor({
      task: "TypeError combining VarsWithSources and dict in combine_vars.",
      files: ["lib/ansible/vars/manager.py", "lib/ansible/utils/vars.py"],
      editScope,
      invariants: [
        {
          file: "lib/ansible/vars/manager.py",
          statement: "Preserve dict-like behavior when combining VarsWithSources with normal dict values.",
          confidence: 0.85,
          source: "heuristic"
        }
      ]
    })).toBe("semantic_official");

    expect(officialGuardrailVariantFor({
      task: "Undefined template variable should raise a clear undefined-variable error.",
      files: ["lib/ansible/parsing/yaml/dumper.py", "lib/ansible/plugins/filter/core.py"],
      editScope: {
        ...editScope,
        initialEditFiles: ["lib/ansible/parsing/yaml/dumper.py", "lib/ansible/plugins/filter/core.py"],
        readOnlyFiles: ["test/units/plugins/filter/test_core.py"]
      },
      invariants: [
        {
          file: "lib/ansible/plugins/filter/core.py",
          statement: "Preserve clear undefined-variable errors for template filters.",
          confidence: 0.85,
          source: "heuristic"
        }
      ]
    })).toBe("compact_official");
  });

  it("keeps semantic guardrail detail for multi-file official patch scope", () => {
    const content = formatShrunkPrimeContext({
      task: [
        "## Title",
        "",
        "TypeError combining `VarsWithSources` and `dict` in `combine_vars`.",
        "Fix the issue in production source. Do not edit unrelated files."
      ].join("\n"),
      sessionId: "task_semantic_guardrail",
      profile: "generic",
      quality: {
        score: 64,
        action: "shrink",
        reasons: [],
        topScore: 400,
        topGap: 180,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files: ["lib/ansible/vars/manager.py", "lib/ansible/utils/vars.py"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["lib/ansible/vars/manager.py", "lib/ansible/utils/vars.py"],
        rankedFiles: [],
        tokenEstimate: 0
      },
      files: ["lib/ansible/vars/manager.py", "lib/ansible/utils/vars.py"],
      budget: 900,
      minimal: true,
      invariants: [
        {
          file: "lib/ansible/vars/manager.py",
          statement: "Preserve dict-like behavior when combining VarsWithSources with normal dict values.",
          evidence: "Official patch task describes unsupported operand behavior.",
          confidence: 0.85,
          source: "heuristic"
        }
      ],
      editScope: {
        initialEditFiles: ["lib/ansible/vars/manager.py", "lib/ansible/utils/vars.py"],
        readOnlyFiles: ["test/units/vars/test_manager.py"],
        allowedExpansionTriggers: ["only if a focused failure names another production file"],
        forbiddenEditPatterns: ["tests/**", "docs/**"],
        scopeConfidence: "high",
        scopeSource: "official_harness",
        reason: "official metadata supplied production scope",
        strictBoundary: true,
        dynamic: true
      }
    });

    expect(content).toContain("Edit only: lib/ansible/vars/manager.py, lib/ansible/utils/vars.py");
    expect(content).toContain("Preserve:");
    expect(content).toContain("VarsWithSources");
    expect(content).toContain("Verify read-only: test/units/vars/test_manager.py");
    expect(content).not.toContain("Session:");
    expect(content).not.toContain("Focused context:");
    expect(estimateTokens(content)).toBeLessThan(280);
  });

  it("uses a compact lifecycle policy guardrail for deprecation-date official patch scope", () => {
    const editScope = {
      initialEditFiles: [
        "lib/ansible/module_utils/common/parameters.py",
        "lib/ansible/module_utils/basic.py",
        "lib/ansible/module_utils/common/warnings.py",
        "lib/ansible/module_utils/csharp/Ansible.Basic.cs",
        "lib/ansible/utils/display.py"
      ],
      readOnlyFiles: [
        "lib/ansible/module_utils/facts/system/date_time.py",
        "test/lib/ansible_test/_internal/sanity/validate_modules.py"
      ],
      allowedExpansionTriggers: ["only if a focused failure names another production file"],
      forbiddenEditPatterns: ["tests/**", "docs/**"],
      scopeConfidence: "high" as const,
      scopeSource: "official_harness" as const,
      reason: "official metadata supplied production scope",
      strictBoundary: true,
      dynamic: true as const
    };
    const task = [
      "Support deprecation by date in modules.",
      "Deprecated aliases should validate version or date and display warnings.",
      "Internal errors should mention removed_in_version and removed_at_date.",
      "Fix the issue in production source only."
    ].join(" ");

    expect(officialGuardrailVariantFor({
      task,
      files: editScope.initialEditFiles,
      editScope,
      invariants: [
        {
          file: "lib/ansible/module_utils/common/parameters.py",
          statement: "Preserve existing version deprecation behavior while adding removed-at-date support.",
          confidence: 0.85,
          source: "heuristic"
        }
      ]
    })).toBe("lifecycle_policy_compact");

    const content = formatShrunkPrimeContext({
      task,
      sessionId: "task_lifecycle_guardrail",
      profile: "generic",
      quality: {
        score: 68,
        action: "shrink",
        reasons: [],
        topScore: 600,
        topGap: 70,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files: editScope.initialEditFiles,
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: editScope.initialEditFiles,
        rankedFiles: [],
        tokenEstimate: 0
      },
      files: editScope.initialEditFiles,
      budget: 900,
      minimal: true,
      invariants: [
        {
          file: "lib/ansible/module_utils/common/parameters.py",
          statement: "Preserve existing version deprecation behavior while adding removed-at-date support.",
          confidence: 0.85,
          source: "heuristic"
        }
      ],
      editScope
    });

    expect(content).toContain("# Kairn Policy Scope");
    expect(content).toContain("policy/source surfaces only");
    expect(content).toContain("lib/ansible/module_utils/common/parameters.py");
    expect(content).toContain("lib/ansible/module_utils/common/warnings.py");
    expect(content).not.toContain("lib/ansible/module_utils/facts/system/date_time.py");
    expect(content).not.toContain("Focused context:");
    expect(estimateTokens(content)).toBeLessThan(230);
  });

  it("uses a compact frontend owner map and filters style/test/variant files", () => {
    const task = [
      "Voice broadcast liveness icon provides inconsistent feedback.",
      "Add an optional grey prop to LiveBadge.",
      "Expose liveness in the playback hook and model.",
      "Fix the issue in production source only."
    ].join(" ");
    const editScope = {
      initialEditFiles: [
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
      readOnlyFiles: ["test/voice-broadcast/components/atoms/LiveBadge-test.tsx"],
      allowedExpansionTriggers: ["only if a focused failure names another production file"],
      forbiddenEditPatterns: ["tests/**", "res/css/"],
      scopeConfidence: "high" as const,
      scopeSource: "official_harness" as const,
      reason: "official metadata supplied production scope",
      strictBoundary: true,
      dynamic: true as const
    };
    const content = formatShrunkPrimeContext({
      task,
      sessionId: "task_frontend_owner_map",
      profile: "generic",
      quality: {
        score: 70,
        action: "shrink",
        reasons: [],
        topScore: 600,
        topGap: 40,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files: editScope.initialEditFiles,
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: editScope.initialEditFiles,
        rankedFiles: [],
        tokenEstimate: 0
      },
      files: editScope.initialEditFiles,
      budget: 900,
      minimal: true,
      editScope
    });

    expect(content).toContain("# Kairn Owner Map");
    expect(content).toContain("src/voice-broadcast/components/atoms/LiveBadge.tsx");
    expect(content).toContain("src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts");
    expect(content).toContain("src/voice-broadcast/models/VoiceBroadcastPlayback.ts");
    expect(content).not.toContain("VoiceBroadcastPreRecordingPip");
    expect(content).not.toContain("_LiveBadge.pcss");
    expect(content).not.toContain("Focused context:");
    expect(estimateTokens(content)).toBeLessThan(260);
  });

  it("keeps multiple visible UI surfaces in broad feedback guardrails", () => {
    const files = [
      "src/voice-broadcast/components/atoms/LiveBadge.tsx",
      "src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx",
      "src/voice-broadcast/components/molecules/VoiceBroadcastPlaybackBody.tsx",
      "src/voice-broadcast/components/molecules/VoiceBroadcastRecordingBody.tsx",
      "src/voice-broadcast/components/molecules/VoiceBroadcastRecordingPip.tsx"
    ];
    const content = formatShrunkPrimeContext({
      task: "Fix voice broadcast liveness icon inconsistent feedback while recording and playback are active.",
      sessionId: "task_ui_multi_surface",
      profile: "generic",
      quality: {
        score: 68,
        action: "shrink",
        reasons: [],
        topScore: 500,
        topGap: 40,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files,
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: files,
        rankedFiles: [],
        tokenEstimate: 0
      },
      files,
      budget: 900
    });

    expect(content).toContain("src/voice-broadcast/components/atoms/LiveBadge.tsx");
    expect(content).toContain("src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx");
    expect(content).toContain("src/voice-broadcast/components/molecules/VoiceBroadcastRecordingBody.tsx");
    expect(content).toContain("src/voice-broadcast/components/molecules/VoiceBroadcastRecordingPip.tsx");
    expect(content).not.toContain("Focused context:");
  });

  it("allows compact guardrails for trivial two-file official patch scope", () => {
    const content = formatShrunkPrimeContext({
      task: [
        "Undefined template variable should raise a clear undefined-variable error.",
        "Fix the issue in production source. Do not edit unrelated files."
      ].join("\n"),
      sessionId: "task_compact_two_file_guardrail",
      profile: "generic",
      quality: {
        score: 64,
        action: "shrink",
        reasons: [],
        topScore: 400,
        topGap: 180,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files: ["lib/ansible/parsing/yaml/dumper.py", "lib/ansible/plugins/filter/core.py"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["lib/ansible/parsing/yaml/dumper.py", "lib/ansible/plugins/filter/core.py"],
        rankedFiles: [],
        tokenEstimate: 0
      },
      files: ["lib/ansible/parsing/yaml/dumper.py", "lib/ansible/plugins/filter/core.py"],
      budget: 900,
      minimal: true,
      invariants: [
        {
          file: "lib/ansible/plugins/filter/core.py",
          statement: "Preserve clear undefined-variable errors for template filters.",
          evidence: "Official patch task describes unclear undefined-variable behavior.",
          confidence: 0.85,
          source: "heuristic"
        }
      ],
      editScope: {
        initialEditFiles: ["lib/ansible/parsing/yaml/dumper.py", "lib/ansible/plugins/filter/core.py"],
        readOnlyFiles: ["test/units/plugins/filter/test_core.py"],
        allowedExpansionTriggers: ["only if a focused failure names another production file"],
        forbiddenEditPatterns: ["tests/**", "docs/**"],
        scopeConfidence: "high",
        scopeSource: "official_harness",
        reason: "official metadata supplied production scope",
        strictBoundary: true,
        dynamic: true
      }
    });

    expect(content).toContain("Edit only: lib/ansible/parsing/yaml/dumper.py, lib/ansible/plugins/filter/core.py");
    expect(content).toContain("Boundary: do not edit tests");
    expect(content).not.toContain("Preserve:");
    expect(content).not.toContain("Session:");
    expect(content).not.toContain("Focused context:");
    expect(estimateTokens(content)).toBeLessThan(190);
  });

  it("keeps request-body reconstruction semantics in compact form guardrails", () => {
    const content = formatShrunkPrimeContext({
      task: [
        "/lists/add returns 500 when POST body data conflicts with query parameters.",
        "Requirements:",
        "- When body data is present, prefer the body exclusively; the query string must not be merged.",
        "- Defaults may only fill keys that are absent and not ancestors of nested/indexed keys.",
        "- During reconstruction, later assignments to the same simple key must win.",
        "Selected tests from SWE-Bench Pro metadata: openlibrary/plugins/openlibrary/tests/test_lists.py"
      ].join("\n"),
      sessionId: "task_form_reconstruction_guardrail",
      profile: "generic",
      quality: {
        score: 74,
        action: "shrink",
        reasons: [],
        topScore: 500,
        topGap: 80,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files: ["openlibrary/plugins/openlibrary/lists.py", "openlibrary/plugins/upstream/utils.py"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["openlibrary/plugins/openlibrary/lists.py", "openlibrary/plugins/upstream/utils.py"],
        rankedFiles: [],
        tokenEstimate: 0
      },
      files: ["openlibrary/plugins/openlibrary/lists.py", "openlibrary/plugins/upstream/utils.py"],
      budget: 900,
      minimal: true,
      invariants: [
        {
          file: "openlibrary/plugins/upstream/utils.py",
          statement: "Request-body reconstruction must use body data without merging query parameters, preserve ordered key/value pairs through unflattening, skip ancestor defaults for nested keys, and let later duplicate simple keys win.",
          confidence: 88,
          source: "heuristic"
        }
      ],
      editScope: {
        initialEditFiles: ["openlibrary/plugins/openlibrary/lists.py", "openlibrary/plugins/upstream/utils.py"],
        readOnlyFiles: ["openlibrary/plugins/openlibrary/tests/test_lists.py"],
        allowedExpansionTriggers: ["only if a focused failure names another production file"],
        forbiddenEditPatterns: ["tests/**", "docs/**"],
        scopeConfidence: "medium",
        scopeSource: "multi_file_debug",
        reason: "request-body reconstruction spans route and unflatten helper",
        strictBoundary: true,
        dynamic: true
      }
    });

    expect(content).toContain("# Kairn Request Scope");
    expect(content).toContain("preserve pair order");
    expect(content).toContain("body wins over query");
    expect(content).toContain("absent non-ancestor keys");
    expect(content).not.toContain("Focused context:");
    expect(estimateTokens(content)).toBeLessThan(150);
  });

  it("keeps discovery metadata contracts in compact discovery guardrails", () => {
    const task = [
      "Homeserver discovery should preserve delegated authentication metadata.",
      "When m.authentication appears in .well-known discovery, the validated server configuration must expose it.",
      "Fix the issue in production source only."
    ].join(" ");
    const editScope = {
      initialEditFiles: ["src/utils/AutoDiscoveryUtils.tsx", "src/utils/ValidatedServerConfig.ts"],
      readOnlyFiles: ["test/utils/AutoDiscoveryUtils-test.ts"],
      allowedExpansionTriggers: ["only if a focused failure names another production file"],
      forbiddenEditPatterns: ["tests/**", "docs/**"],
      scopeConfidence: "high" as const,
      scopeSource: "official_harness" as const,
      reason: "discovery metadata spans parser and validated config contract",
      strictBoundary: true,
      dynamic: true as const
    };

    expect(officialGuardrailVariantFor({
      task,
      files: editScope.initialEditFiles,
      editScope,
      invariants: [
        {
          file: "src/utils/ValidatedServerConfig.ts",
          statement: "Preserve delegated authentication metadata in the validated server config contract.",
          confidence: 0.85,
          source: "heuristic"
        }
      ]
    })).toBe("discovery_config_compact");

    const content = formatShrunkPrimeContext({
      task,
      sessionId: "task_discovery_config_guardrail",
      profile: "generic",
      quality: {
        score: 74,
        action: "shrink",
        reasons: [],
        topScore: 500,
        topGap: 80,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files: editScope.initialEditFiles,
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: editScope.initialEditFiles,
        rankedFiles: [],
        tokenEstimate: 0
      },
      files: editScope.initialEditFiles,
      budget: 900,
      minimal: true,
      invariants: [
        {
          file: "src/utils/ValidatedServerConfig.ts",
          statement: "Preserve delegated authentication metadata in the validated server config contract.",
          confidence: 0.85,
          source: "heuristic"
        }
      ],
      editScope
    });

    expect(content).toContain("# Kairn Discovery Scope");
    expect(content).toContain("Edit both:");
    expect(content).toContain("src/utils/AutoDiscoveryUtils.tsx");
    expect(content).toContain("src/utils/ValidatedServerConfig.ts");
    expect(content).toContain("m.authentication");
    expect(content).not.toContain("Focused context:");
    expect(estimateTokens(content)).toBeLessThan(170);
  });

  it("routes request-body form guardrails to upstream utilities instead of generic admin utilities", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "openlibrary/plugins/openlibrary"), { recursive: true });
    fs.mkdirSync(path.join(root, "openlibrary/plugins/upstream"), { recursive: true });
    fs.mkdirSync(path.join(root, "openlibrary/admin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "openlibrary/plugins/openlibrary/lists.py"),
      [
        "def add_list(request):",
        "    data = request.form",
        "    query = request.query",
        "    return data, query",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "openlibrary/plugins/upstream/utils.py"),
      [
        "def rebuild_upstream_request(form_pairs):",
        "    return form_pairs",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "openlibrary/admin/utils.py"),
      [
        "def admin_helper(value):",
        "    return value",
        ""
      ].join("\n")
    );
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: "Fix the /lists/add POST conflict bug. The task involves list request handling and upstream request/query handling. Keep edits to production source that directly controls the add-list request flow.",
        budget: 900,
        source: "codex"
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("request_body_form");
      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.files).toContain("openlibrary/plugins/openlibrary/lists.py");
      expect(prime.files).toContain("openlibrary/plugins/upstream/utils.py");
      expect(prime.files).not.toContain("openlibrary/admin/utils.py");
      expect(prime.content).not.toContain("openlibrary/admin/utils.py");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps official single-location Wikidata prompts to one production file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-wikidata-"));
    fs.mkdirSync(path.join(root, "openlibrary/core"), { recursive: true });
    fs.mkdirSync(path.join(root, "openlibrary/plugins/openlibrary"), { recursive: true });
    fs.mkdirSync(path.join(root, "openlibrary/plugins/upstream"), { recursive: true });
    fs.mkdirSync(path.join(root, "openlibrary/tests/core"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "openlibrary/core/wikidata.py"),
      [
        "class WikidataEntity:",
        "    def get_statement_values(self, property_id):",
        "        return []",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "openlibrary/plugins/openlibrary/lists.py"),
      [
        "def add_list(request):",
        "    return request",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "openlibrary/plugins/upstream/utils.py"),
      [
        "def rebuild_upstream_request(form_pairs):",
        "    return form_pairs",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "openlibrary/tests/core/test_wikidata.py"),
      [
        "def test_get_statement_values():",
        "    assert True",
        ""
      ].join("\n")
    );
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Incomplete Retrieval of Property Statement Values in Wikidata Entities.",
          "The WikidataEntity class should provide get_statement_values.",
          "The method should iterate over nested statement objects and return a list of string values.",
          "New interfaces introduced:",
          "Type: Method Name: get_statement_values Location: openlibrary/core/wikidata.py",
          "Selected verification tests from SWE-Bench Pro metadata: openlibrary/tests/core/test_wikidata.py",
          "Fix the issue in production source only. Avoid broad scans once the relevant source surface is known."
        ].join("\n"),
        budget: 900,
        source: "bench"
      });

      expect(prime.contextDecision?.requiredSurface).toBe("single_file");
      expect(prime.contextDecision?.recommendedDelivery).toBe("one_file_directive");
      expect(prime.files).toEqual(["openlibrary/core/wikidata.py"]);
      expect(prime.editScope?.initialEditFiles).toEqual(["openlibrary/core/wikidata.py"]);
      expect(prime.editScope?.readOnlyFiles).toContain("openlibrary/tests/core/test_wikidata.py");
      expect(prime.editScope?.readOnlyFiles).not.toContain("openlibrary/plugins/openlibrary/lists.py");
      expect(prime.editScope?.readOnlyFiles).not.toContain("openlibrary/plugins/upstream/utils.py");
      expect(prime.content).toContain("openlibrary/core/wikidata.py");
      expect(prime.content).not.toContain("openlibrary/plugins/openlibrary/lists.py");
      expect(prime.content).not.toContain("openlibrary/plugins/upstream/utils.py");
      expect(prime.metadata?.deliveryTrace).toMatchObject({
        requiredSurface: "single_file",
        emittedFileCount: 1
      });
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps pinned topic reorder guardrails to topic owner files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-topic-ordering-"));
    fs.mkdirSync(path.join(root, "public/src/client/category"), { recursive: true });
    fs.mkdirSync(path.join(root, "public/src/client/account"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/socket.io/topics"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/topics"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "public/src/client/category/tools.js"), "export function orderPinnedTopics() {}\n");
    fs.writeFileSync(path.join(root, "src/socket.io/topics/tools.js"), "exports.orderPinnedTopics = async function() {};\n");
    fs.writeFileSync(path.join(root, "src/topics/tools.js"), "exports.orderPinnedTopics = async function() {};\n");
    fs.writeFileSync(path.join(root, "public/src/client/account/topics.js"), "export function accountTopics() {}\n");
    fs.writeFileSync(path.join(root, "public/src/client/topic.js"), "export function topicPage() {}\n");
    fs.writeFileSync(path.join(root, "test/topics.js"), "describe('topics', () => {});\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Reordering pinned topics does not behave correctly for all cases.",
          "Maintain authorization so only moderator or admin users can request reordering of pinned topics.",
          "Unprivileged users should fail without changing pinned ordering or membership.",
          "If a topic is not pinned, attempting to reorder it should not change the pinned list.",
          "When multiple topics are pinned, reordering one should update their relative order correctly.",
          "Selected verification tests from SWE-Bench Pro metadata: test/topics.js",
          "Fix the issue in production source only. Avoid broad scans once the relevant source surface is known."
        ].join("\n"),
        budget: 1200,
        source: "bench"
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("topic_ordering");
      expect(prime.contextDecision?.requiredSurface).toBe("paired_contract");
      expect(prime.files).toEqual([
        "src/topics/tools.js",
        "src/socket.io/topics/tools.js",
        "public/src/client/category/tools.js"
      ]);
      expect(prime.editScope?.initialEditFiles).toEqual([
        "src/topics/tools.js",
        "src/socket.io/topics/tools.js",
        "public/src/client/category/tools.js"
      ]);
      expect(prime.files).not.toContain("public/src/client/account/topics.js");
      expect(prime.files).not.toContain("public/src/client/topic.js");
      expect(prime.content).not.toContain("public/src/client/account/topics.js");
      expect(prime.content).not.toContain("public/src/client/topic.js");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps collection-name validation guardrails to authoritative validation files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-collection-validation-"));
    fs.mkdirSync(path.join(root, "lib/ansible/galaxy/dependency_resolution"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/utils/collection_loader"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/module_utils/facts"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/utils"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib/ansible/galaxy/dependency_resolution/dataclasses.py"), "def is_valid_requirement(value):\n    return True\n");
    fs.writeFileSync(path.join(root, "lib/ansible/utils/collection_loader/_collection_finder.py"), "class AnsibleCollectionRef:\n    pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/module_utils/facts/namespace.py"), "def namespace(value):\n    return value\n");
    fs.writeFileSync(path.join(root, "lib/ansible/utils/fqcn.py"), "def parse_fqcn(value):\n    return value\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Collection Name Validation Accepts Python Keywords.",
          "The validation system for Fully Qualified Collection Names incorrectly accepts collection names with Python reserved keywords.",
          "Collection names like def.collection, return.module, assert.test, and import.utils should be rejected.",
          "The validation system should reject any collection name that contains a Python reserved keyword in either namespace or collection name.",
          "Fix production source only."
        ].join(" "),
        budget: 900,
        source: "bench"
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("collection_name_validation");
      expect(prime.contextDecision?.requiredSurface).toBe("paired_contract");
      expect(prime.files).toEqual([
        "lib/ansible/utils/collection_loader/_collection_finder.py",
        "lib/ansible/galaxy/dependency_resolution/dataclasses.py"
      ]);
      expect(prime.editScope?.initialEditFiles).toEqual([
        "lib/ansible/utils/collection_loader/_collection_finder.py",
        "lib/ansible/galaxy/dependency_resolution/dataclasses.py"
      ]);
      expect(prime.files).not.toContain("lib/ansible/module_utils/facts/namespace.py");
      expect(prime.files).not.toContain("lib/ansible/utils/fqcn.py");
      expect(prime.editScope?.readOnlyFiles).not.toContain("lib/ansible/module_utils/facts/namespace.py");
      expect(prime.editScope?.readOnlyFiles).not.toContain("lib/ansible/utils/fqcn.py");
      expect(prime.content).not.toContain("lib/ansible/module_utils/facts/namespace.py");
      expect(prime.content).not.toContain("lib/ansible/utils/fqcn.py");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses first-turn gRPC context status policy when failure evidence is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-grpc-status-"));
    fs.mkdirSync(path.join(root, "internal/cmd"), { recursive: true });
    fs.mkdirSync(path.join(root, "internal/server/auth"), { recursive: true });
    fs.mkdirSync(path.join(root, "internal/server/middleware/grpc"), { recursive: true });
    fs.mkdirSync(path.join(root, "internal/server"), { recursive: true });
    fs.writeFileSync(path.join(root, "internal/cmd/grpc.go"), "package cmd\nfunc NewGRPCServer() {}\n");
    fs.writeFileSync(path.join(root, "internal/cmd/auth.go"), "package cmd\nfunc AuthConfig() {}\n");
    fs.writeFileSync(path.join(root, "internal/server/auth/middleware.go"), "package auth\nfunc Middleware() {}\n");
    fs.writeFileSync(path.join(root, "internal/server/middleware/grpc/middleware.go"), "package grpc\nfunc ErrorUnaryInterceptor() {}\n");
    fs.writeFileSync(path.join(root, "internal/server/segment.go"), "package server\nfunc Segment() {}\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Context cancellation and deadline exceeded errors are incorrectly classified as Internal or Unauthenticated in gRPC responses.",
          "Return Canceled and DeadlineExceeded from middleware/authentication when errors wrap context.Canceled or context.DeadlineExceeded.",
          "Fix production source only."
        ].join(" "),
        budget: 900,
        source: "bench",
        editScopeHints: {
          allowedDiffScopes: [
            { file: "internal/cmd/grpc.go", allowWholeFile: true },
            { file: "internal/server/auth/middleware.go", allowWholeFile: true },
            { file: "internal/server/middleware/grpc/middleware.go", allowWholeFile: true }
          ]
        }
      });

      expect(prime.contextDecision?.action).toBe("suppress");
      expect(prime.contextDecision?.taskShapeSignal).toBe("grpc_error_policy");
      expect(prime.contextDecision?.requiredSurface).toBe("evidence_needed");
      expect(prime.metadata?.guardrailVariant).toBeUndefined();
      expect(prime.files).toEqual([]);
      expect(prime.editScope?.initialEditFiles).toEqual([
        "internal/cmd/grpc.go",
        "internal/server/auth/middleware.go",
        "internal/server/middleware/grpc/middleware.go"
      ]);
      expect(prime.content).toContain("# Kairn Prime Suppressed");
      expect(prime.content).not.toContain("internal/cmd/auth.go");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps HTTP auth netrc guardrails to request modules unless action plugin is requested", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-http-auth-"));
    fs.mkdirSync(path.join(root, "lib/ansible/module_utils"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/plugins/lookup"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/plugins/action"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib/ansible/module_utils/urls.py"), "def open_url(url, headers=None, use_netrc=True):\n    return url\n");
    fs.writeFileSync(path.join(root, "lib/ansible/modules/uri.py"), "def main():\n    pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/modules/get_url.py"), "def main():\n    pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/plugins/lookup/url.py"), "class LookupModule:\n    def run(self):\n        pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/plugins/action/uri.py"), "class ActionModule:\n    def run(self):\n        pass\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "The uri module uses .netrc to overwrite an explicit Authorization header.",
          "Add a use_netrc parameter to Request.open and open_url, default enabled, and forward it through uri, get_url, and url lookup.",
          "Fix production source only."
        ].join(" "),
        budget: 900,
        source: "bench",
        editScopeHints: {
          allowedDiffScopes: [
            { file: "lib/ansible/module_utils/urls.py", allowWholeFile: true },
            { file: "lib/ansible/modules/get_url.py", allowWholeFile: true },
            { file: "lib/ansible/modules/uri.py", allowWholeFile: true },
            { file: "lib/ansible/plugins/lookup/url.py", allowWholeFile: true }
          ]
        }
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("http_auth_policy");
      expect(prime.contextDecision?.requiredSurface).toBe("paired_contract");
      expect(prime.files).toHaveLength(4);
      expect(prime.files).toEqual(expect.arrayContaining([
        "lib/ansible/module_utils/urls.py",
        "lib/ansible/modules/uri.py",
        "lib/ansible/modules/get_url.py",
        "lib/ansible/plugins/lookup/url.py"
      ]));
      expect(prime.files).not.toContain("lib/ansible/plugins/action/uri.py");
      expect(prime.editScope?.initialEditFiles).toHaveLength(4);
      expect(prime.editScope?.initialEditFiles).toEqual(expect.arrayContaining([
        "lib/ansible/module_utils/urls.py",
        "lib/ansible/modules/get_url.py",
        "lib/ansible/modules/uri.py",
        "lib/ansible/plugins/lookup/url.py"
      ]));
      expect(prime.content).not.toContain("lib/ansible/plugins/action/uri.py");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps execution state migrations to iterator and strategy owners", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-exec-state-"));
    fs.mkdirSync(path.join(root, "lib/ansible/executor"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/plugins/strategy"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/ansible/module_utils"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib/ansible/executor/play_iterator.py"), "class PlayIterator:\n    pass\nclass HostState:\n    pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/plugins/strategy/__init__.py"), "class StrategyBase:\n    pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/plugins/strategy/linear.py"), "class StrategyModule:\n    pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/plugins/strategy/debug.py"), "class StrategyModule:\n    pass\n");
    fs.writeFileSync(path.join(root, "lib/ansible/module_utils/basic.py"), "def helper():\n    pass\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Standardize PlayIterator state representation with public IteratingStates and FailedStates enums.",
          "Update the strategy plugins that consume the iterator state.",
          "Preserve legacy constants, HostState string output, and third-party strategy plugin compatibility.",
          "Fix production source only."
        ].join(" "),
        budget: 900,
        source: "bench",
        editScopeHints: {
          allowedDiffScopes: [
            { file: "lib/ansible/executor/play_iterator.py", allowWholeFile: true },
            { file: "lib/ansible/plugins/strategy/__init__.py", allowWholeFile: true },
            { file: "lib/ansible/plugins/strategy/linear.py", allowWholeFile: true }
          ]
        }
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("execution_state_migration");
      expect(prime.contextDecision?.requiredSurface).toBe("paired_contract");
      expect(prime.files.length).toBeGreaterThanOrEqual(2);
      expect(prime.files.length).toBeLessThanOrEqual(3);
      expect(prime.files).toEqual(expect.arrayContaining([
        "lib/ansible/executor/play_iterator.py",
        "lib/ansible/plugins/strategy/__init__.py"
      ]));
      expect(prime.files).not.toContain("lib/ansible/plugins/strategy/debug.py");
      expect(prime.files).not.toContain("lib/ansible/module_utils/basic.py");
      expect(prime.editScope?.initialEditFiles).toEqual(expect.arrayContaining([
        "lib/ansible/executor/play_iterator.py",
        "lib/ansible/plugins/strategy/__init__.py"
      ]));
      expect(prime.editScope?.initialEditFiles).not.toContain("lib/ansible/plugins/strategy/debug.py");
      expect(prime.editScope?.initialEditFiles).not.toContain("lib/ansible/module_utils/basic.py");
      expect(prime.content).not.toContain("lib/ansible/plugins/strategy/debug.py");
      expect(prime.content).not.toContain("lib/ansible/module_utils/basic.py");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps database failover tasks to proxy, type, fake tunnel, and CLI owners", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-runtime-db-failover-"));
    fs.mkdirSync(path.join(root, "api/types"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/srv/db"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/reversetunnel"), { recursive: true });
    fs.mkdirSync(path.join(root, "tool/tsh"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/events"), { recursive: true });
    fs.writeFileSync(path.join(root, "api/types/databaseserver.go"), "package types\ntype DatabaseServerV3 struct { HostID string }\n");
    fs.writeFileSync(path.join(root, "lib/srv/db/proxyserver.go"), "package db\nfunc connectCandidateServers() {}\n");
    fs.writeFileSync(path.join(root, "lib/reversetunnel/fake.go"), "package reversetunnel\ntype FakeRemoteSite struct{}\nfunc OfflineTunnels() {}\n");
    fs.writeFileSync(path.join(root, "lib/reversetunnel/agent.go"), "package reversetunnel\ntype Agent struct{}\nfunc KeepAlive() {}\n");
    fs.writeFileSync(path.join(root, "tool/tsh/db.go"), "package tsh\nfunc onListDatabases() {}\n");
    fs.writeFileSync(path.join(root, "lib/events/auditlog.go"), "package events\ntype ServerID string\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Better handle HA database access when multiple database services share the same service name.",
          "Proxy should shuffle candidate database servers, retry on tunnel connection failures, deduplicate tsh db ls, and include HostID.",
          "Fix production source only."
        ].join(" "),
        budget: 900,
        source: "bench",
        editScopeHints: {
          allowedDiffScopes: [
            { file: "api/types/databaseserver.go", allowWholeFile: true },
            { file: "lib/srv/db/proxyserver.go", allowWholeFile: true },
            { file: "lib/reversetunnel/fake.go", allowWholeFile: true },
            { file: "tool/tsh/db.go", allowWholeFile: true }
          ]
        }
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("database_failover");
      expect(prime.contextDecision?.requiredSurface).toBe("paired_contract");
      expect(prime.files).toHaveLength(4);
      expect(prime.files).toEqual(expect.arrayContaining([
        "api/types/databaseserver.go",
        "lib/srv/db/proxyserver.go",
        "lib/reversetunnel/fake.go",
        "tool/tsh/db.go"
      ]));
      expect(prime.files).not.toContain("lib/reversetunnel/agent.go");
      expect(prime.files).not.toContain("lib/events/auditlog.go");
      expect(prime.editScope?.initialEditFiles).toEqual(expect.arrayContaining([
        "api/types/databaseserver.go",
        "lib/srv/db/proxyserver.go",
        "lib/reversetunnel/fake.go",
        "tool/tsh/db.go"
      ]));
      expect(prime.editScope?.initialEditFiles).not.toContain("lib/reversetunnel/agent.go");
      expect(prime.content).not.toContain("lib/reversetunnel/agent.go");
      expect(prime.content).toContain("Required diff checklist");
      expect(prime.content).toContain("identity/sort");
      expect(prime.content).toContain("proxy retry/shuffle");
      expect(prime.content).toContain("tunnel failure simulation");
      expect(prime.content).toContain("CLI/list output");
      expect(prime.content).toContain("changed files must include every checklist path");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps dominant converter-output official tasks to a single converter guardrail", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "contrib/trivy/pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "cmd/vuls"), { recursive: true });
    fs.mkdirSync(path.join(root, "scanner/trivy/jar"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "contrib/trivy/pkg/converter.go"),
      [
        "package pkg",
        "",
        "func Convert(contents []CVEContent) []Finding {",
        "    return buildFindings(contents)",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "cmd/vuls/main.go"),
      [
        "package main",
        "",
        "func main() {",
        "    runCLI()",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "scanner/trivy/jar/parse.go"),
      [
        "package jar",
        "",
        "func ParseJar() {}",
        ""
      ].join("\n")
    );
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Selected tests from SWE-Bench Pro metadata: contrib/trivy/pkg/converter_test.go.",
          "Fix the trivy-to-vuls converter output.",
          "cveContents should not duplicate Debian severity records when conversion builds Vuls JSON findings.",
          "Fix production source only."
        ].join(" "),
        budget: 900,
        source: "codex"
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("converter_output");
      expect(prime.contextDecision?.requiredSurface).toBe("single_file");
      expect(prime.contextDecision?.directiveStyle).toBe("scope_guardrail");
      expect(prime.contextDecision?.recommendedDelivery).toBe("one_file_directive");
      expect(prime.files).toEqual(["contrib/trivy/pkg/converter.go"]);
      expect(prime.content).toContain("# Kairn Fix Guardrail");
      expect(prime.content).toContain("contrib/trivy/pkg/converter.go");
      expect(prime.content).not.toContain("cmd/vuls/main.go");
      expect(prime.content).not.toContain("scanner/trivy/jar/parse.go");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps benchmark generator guardrails off generic command entrypoints", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "lib/client"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/benchmark"), { recursive: true });
    fs.mkdirSync(path.join(root, "tool/tsh"), { recursive: true });
    fs.mkdirSync(path.join(root, "tool/tctl"), { recursive: true });
    fs.mkdirSync(path.join(root, "tool/teleport"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "lib/client/bench.go"),
      [
        "package client",
        "",
        "func BenchmarkCommand() {",
        "    // benchmark command configuration",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "lib/benchmark/linear_test.go"),
      [
        "package benchmark",
        "",
        "func TestGetBenchmark() {}",
        "func TestValidateConfig() {}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "tool/tsh/tsh.go"),
      [
        "package tsh",
        "",
        "func onBenchmark() {",
        "    // benchmark CLI command",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "tool/tctl/main.go"),
      [
        "package main",
        "",
        "func main() {",
        "    // generic benchmark launcher",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "tool/teleport/main.go"),
      [
        "package main",
        "",
        "func main() {",
        "    // generic benchmark launcher",
        "}",
        ""
      ].join("\n")
    );
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Add linear benchmark generator for progressive request rate configurations.",
          "New file: lib/benchmark/linear.go.",
          "The Linear struct and GetBenchmark method should produce benchmark configurations.",
          "Selected verification tests from SWE-Bench Pro metadata: TestGetBenchmark, TestValidateConfig.",
          "Fix production source only. Avoid broad scans once the relevant source surface is known."
        ].join(" "),
        budget: 900,
        source: "codex"
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("benchmark_generator");
      expect(prime.contextDecision?.requiredSurface).toBe("paired_contract");
      expect(prime.files).toContain("lib/client/bench.go");
      expect(prime.files).toContain("tool/tsh/tsh.go");
      expect(prime.files).not.toContain("tool/tctl/main.go");
      expect(prime.files).not.toContain("tool/teleport/main.go");
      expect(prime.editScope?.initialEditFiles).not.toContain("tool/tctl/main.go");
      expect(prime.editScope?.initialEditFiles).not.toContain("tool/teleport/main.go");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps discovery config contracts in authoritative edit scope", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "src/utils"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/utils/AutoDiscoveryUtils.tsx"),
      [
        "export function buildValidatedConfig(discovery: any) {",
        "  return { homeserver: discovery.mHomeserver };",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "src/utils/ValidatedServerConfig.ts"),
      [
        "export interface ValidatedServerConfig {",
        "  homeserver?: unknown;",
        "  warning?: string;",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "src/utils/WellKnownUtils.ts"),
      [
        "export function parseWellKnown(value: unknown) {",
        "  return value;",
        "}",
        ""
      ].join("\n")
    );
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Discovery omits delegated authentication metadata advertised under m.authentication.",
          "When building validated configuration from homeserver discovery, preserve delegatedAuthentication.",
          "The public interface ValidatedServerConfig must optionally declare the delegatedAuthentication property.",
          "Fix the issue in production source only."
        ].join(" "),
        budget: 900,
        source: "codex"
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("discovery_config");
      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.editScope?.initialEditFiles).toEqual(
        expect.arrayContaining([
          "src/utils/AutoDiscoveryUtils.tsx",
          "src/utils/ValidatedServerConfig.ts"
        ])
      );
      expect(prime.editScope?.initialEditFiles).not.toContain("src/utils/WellKnownUtils.ts");
      expect(prime.content).toContain("src/utils/AutoDiscoveryUtils.tsx");
      expect(prime.content).toContain("src/utils/ValidatedServerConfig.ts");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps package source mapping semantics in compact package guardrails", () => {
    const content = formatShrunkPrimeContext({
      task: [
        "Alpine Linux vulnerability detection incorrectly handles source vs binary packages.",
        "Requirements:",
        "- OVAL vulnerability detection logic should identify source packages and assess vulnerabilities accordingly.",
        "- Alpine scanner should parse apk list output to extract binary details and source package names.",
        "- Alpine scanner should parse package index mapping between binary and source packages.",
        "- Alpine scanner should parse upgradable package information using apk list --upgradable."
      ].join("\n"),
      sessionId: "task_package_source_mapping_guardrail",
      profile: "generic",
      quality: {
        score: 74,
        action: "shrink",
        reasons: [],
        topScore: 500,
        topGap: 80,
        exactPathMentioned: false,
        expectedSavingsRisk: "medium"
      },
      context: {
        mode: "snippets",
        content: "",
        files: ["scanner/alpine.go", "oval/util.go", "scanner/scanner.go"],
        symbols: [],
        related: [],
        warnings: [],
        suggestedNextContext: ["scanner/alpine.go", "oval/util.go", "scanner/scanner.go"],
        rankedFiles: [],
        tokenEstimate: 0
      },
      files: ["scanner/alpine.go", "oval/util.go", "scanner/scanner.go"],
      budget: 900,
      minimal: true,
      invariants: [
        {
          file: "oval/util.go",
          statement: "Package scanning must preserve binary package identity while recording source-package associations, and vulnerability matching must assess source packages when binaries derive from them.",
          confidence: 88,
          source: "heuristic"
        }
      ],
      editScope: {
        initialEditFiles: ["scanner/alpine.go", "oval/util.go", "scanner/scanner.go"],
        readOnlyFiles: ["scanner/alpine_test.go", "oval/util_test.go"],
        allowedExpansionTriggers: ["only if a focused failure names another production file"],
        forbiddenEditPatterns: ["tests/**", "docs/**"],
        scopeConfidence: "medium",
        scopeSource: "multi_file_debug",
        reason: "package source mapping spans scanner and OVAL matcher surfaces",
        strictBoundary: true,
        dynamic: true
      }
    });

    expect(content).toContain("# Kairn Package Scope");
    expect(content).toContain("scanner/alpine.go");
    expect(content).toContain("oval/util.go");
    expect(content).toContain("scanner/scanner.go");
    expect(content).toContain("source-package associations");
    expect(content).toContain("OVAL/vulnerability checks");
    expect(content).not.toContain("Focused context:");
    expect(estimateTokens(content)).toBeLessThan(320);
  });

  it("suppresses narrow RPM source-package parser official prompts", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "scanner"), { recursive: true });
    fs.mkdirSync(path.join(root, "oval"), { recursive: true });
    fs.writeFileSync(path.join(root, "scanner/redhatbase.go"), "func parseInstalledPackagesLine() {}\nfunc splitFileName() {}\n");
    fs.writeFileSync(path.join(root, "scanner/centos.go"), "func centosScanner() {}\n");
    fs.writeFileSync(path.join(root, "scanner/rhel.go"), "func rhelScanner() {}\n");
    fs.writeFileSync(path.join(root, "scanner/scanner.go"), "func Detect() {}\n");
    fs.writeFileSync(path.join(root, "oval/util.go"), "func matchSourcePackage() {}\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Scanner fails on non-standard source RPM filenames and epoch handling.",
          "Update parseInstalledPackagesLine to append warnings for unparseable SOURCERPM filenames without aborting.",
          "Implement splitFileName handling for source RPM filenames with epoch values.",
          "Selected verification tests from SWE-Bench Pro metadata: Test_redhatBase_parseInstalledPackagesLine",
          "Fix the issue in production source only."
        ].join("\n"),
        budget: 900,
        source: "bench",
        editScopeHints: {
          allowedDiffScopes: [{ file: "scanner/redhatbase.go", allowWholeFile: true }]
        }
      });

      expect(prime.contextDecision?.action).toBe("suppress");
      expect(prime.contextDecision?.requiredSurface).toBe("single_file");
      expect(prime.contextDecision?.taskShapeSignal).toBe("narrow_package_parser");
      expect(prime.files).toEqual([]);
      expect(prime.editScope?.initialEditFiles).toEqual(["scanner/redhatbase.go"]);
      expect(prime.editScope?.readOnlyFiles).toEqual([]);
      expect(prime.content).not.toContain("# Kairn Package Scope");
      expect(prime.content).not.toContain("# Kairn Policy Scope");
      expect(prime.content).not.toContain("scanner/centos.go");
      expect(prime.content).not.toContain("oval/util.go");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes web session renewal tasks to web/auth session surfaces instead of constants", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "lib/web"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/auth"), { recursive: true });
    fs.mkdirSync(path.join(root, "api/types"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib/web/sessions.go"), "type WebSessionReq struct { PrevSessionID string }\nfunc renewWebSession() {}\n");
    fs.writeFileSync(path.join(root, "lib/web/apiserver.go"), "func webSessionHandler() { renewWebSession() }\n");
    fs.writeFileSync(path.join(root, "lib/auth/apiserver.go"), "func ReloadUser() {}\n");
    fs.writeFileSync(path.join(root, "lib/auth/auth.go"), "func issueCertificatesForRoles() {}\n");
    fs.writeFileSync(path.join(root, "api/types/constants.go"), "const SessionRenewalDefault = true\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Fix web session renewal after user traits update.",
          "Renewing a WebSessionReq with PrevSessionID must reload the user record from the backend.",
          "The renewed session should preserve Switchback, active access requests, certificate roles, allowed resources, login time, and expiry.",
          "Patch production source only."
        ].join("\n"),
        budget: 1200
      });

      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.files).toEqual(
        expect.arrayContaining([
          "lib/web/sessions.go",
          "lib/web/apiserver.go",
          "lib/auth/apiserver.go",
          "lib/auth/auth.go"
        ])
      );
      expect(prime.files).not.toContain("api/types/constants.go");
      expect(prime.content).not.toContain("# Kairn Request Scope");
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps exact prompt-mentioned Solr source paths together", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "openlibrary/solr"), { recursive: true });
    fs.mkdirSync(path.join(root, "scripts/solr_builder/solr_builder"), { recursive: true });
    fs.mkdirSync(path.join(root, "openlibrary/components/LibraryExplorer"), { recursive: true });
    fs.writeFileSync(path.join(root, "openlibrary/solr/update_work.py"), "def update_work():\n    pass\n");
    fs.writeFileSync(path.join(root, "openlibrary/solr/update_edition.py"), "def update_edition():\n    pass\n");
    fs.writeFileSync(path.join(root, "openlibrary/solr/utils.py"), "def solr_field(value):\n    return value\n");
    fs.writeFileSync(path.join(root, "scripts/solr_builder/solr_builder/index_subjects.py"), "def index_subjects():\n    pass\n");
    fs.writeFileSync(path.join(root, "openlibrary/components/LibraryExplorer/utils.js"), "export function clientOnlyExplorerUtility() {}\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Refactor shared Solr utility logic across these production files:",
          "openlibrary/solr/update_work.py",
          "openlibrary/solr/update_edition.py",
          "openlibrary/solr/utils.py",
          "scripts/solr_builder/solr_builder/index_subjects.py",
          "Keep the existing behavior and do not edit frontend utilities."
        ].join("\n"),
        budget: 1200
      });

      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.files).toEqual(
        expect.arrayContaining([
          "openlibrary/solr/update_work.py",
          "openlibrary/solr/update_edition.py",
          "openlibrary/solr/utils.py",
          "scripts/solr_builder/solr_builder/index_subjects.py"
        ])
      );
      expect(prime.files).not.toContain("openlibrary/components/LibraryExplorer/utils.js");
      expect(prime.editScope?.initialEditFiles).toEqual(
        expect.arrayContaining([
          "openlibrary/solr/update_work.py",
          "openlibrary/solr/update_edition.py",
          "openlibrary/solr/utils.py",
          "scripts/solr_builder/solr_builder/index_subjects.py"
        ])
      );
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps datastore backend parity scopes required and drops unrelated same-name client files", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "src/database/mongo"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/database/postgres"), { recursive: true });
    fs.mkdirSync(path.join(root, "src/database/redis"), { recursive: true });
    fs.mkdirSync(path.join(root, "public/src/client/flags"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/database/mongo/list.js"), "exports.listRemove = async function(list, value) { return list.pull(value); };\n");
    fs.writeFileSync(path.join(root, "src/database/postgres/list.js"), "exports.listRemove = async function(list, value) { return list.remove(value); };\n");
    fs.writeFileSync(path.join(root, "src/database/redis/list.js"), "exports.listRemove = async function(list, value) { return list.srem(value); };\n");
    fs.writeFileSync(path.join(root, "public/src/client/flags/list.js"), "export function flagList() {}\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Fix listRemove so it can remove multiple distinct values from a list in one call.",
          "Apply the same behavior across the Mongo, Postgres, and Redis database backends.",
          "Selected verification tests from SWE Bench Pro metadata: test/database/list.js.",
          "Patch production source only and do not edit frontend files."
        ].join("\n"),
        budget: 1200,
        source: "codex"
      });

      expect(prime.contextDecision?.taskShapeSignal).toBe("backend_parity");
      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.files).toHaveLength(3);
      expect(prime.files).toEqual(
        expect.arrayContaining([
          "src/database/mongo/list.js",
          "src/database/postgres/list.js",
          "src/database/redis/list.js"
        ])
      );
      expect(prime.files).not.toContain("public/src/client/flags/list.js");
      expect(prime.content).toContain("Required backend edits:");
      expect(prime.content).toContain("patch every listed backend");
      expect(prime.editScope?.initialEditFiles).toEqual(
        expect.arrayContaining([
          "src/database/mongo/list.js",
          "src/database/postgres/list.js",
          "src/database/redis/list.js"
        ])
      );
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a three-file directive when selected failing tests imply three production counterparts", async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp-kairn-runtime-"));
    fs.mkdirSync(path.join(root, "qutebrowser/components"), { recursive: true });
    fs.mkdirSync(path.join(root, "qutebrowser/config"), { recursive: true });
    fs.mkdirSync(path.join(root, "qutebrowser/utils"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests/unit/components"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests/unit/config"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests/unit/utils"), { recursive: true });
    fs.writeFileSync(path.join(root, "qutebrowser/components/hostblock.py"), "class HostBlocker:\n    def _is_blocked(self, request_url):\n        return request_url.host() in self._blocked_hosts\n");
    fs.writeFileSync(path.join(root, "qutebrowser/config/configutils.py"), "def _widened_hostnames(hostname):\n    while hostname:\n        yield hostname\n        hostname = hostname.partition('.')[2]\n");
    fs.writeFileSync(path.join(root, "qutebrowser/utils/urlutils.py"), "def widened_hostnames(hostname):\n    while hostname:\n        yield hostname\n        hostname = hostname.partition('.')[2]\n");
    fs.writeFileSync(path.join(root, "tests/unit/components/test_hostblock.py"), "def test_hostblock(): pass\n");
    fs.writeFileSync(path.join(root, "tests/unit/config/test_configutils.py"), "def test_configutils(): pass\n");
    fs.writeFileSync(path.join(root, "tests/unit/utils/test_urlutils.py"), "def test_urlutils(): pass\n");
    const runtime = new KairnRuntime(root);

    try {
      const prime = await runtime.primeContext({
        task: [
          "Fix host blocking for subdomains in production source.",
          "Selected tests from SWE-Bench Pro metadata: tests/unit/components/test_hostblock.py, tests/unit/utils/test_urlutils.py, tests/unit/config/test_configutils.py",
          "Interface notes: widened_hostnames(hostname: str) -> Iterable[str]. Do not edit tests."
        ].join("\n"),
        budget: 1200
      });

      expect(prime.contextDecision?.recommendedDelivery).toBe("multi_file_directive");
      expect(prime.files).toEqual(
        expect.arrayContaining([
          "qutebrowser/components/hostblock.py",
          "qutebrowser/config/configutils.py",
          "qutebrowser/utils/urlutils.py"
        ])
      );
      expect(prime.editScope?.initialEditFiles).toEqual(
        expect.arrayContaining([
          "qutebrowser/components/hostblock.py",
          "qutebrowser/config/configutils.py",
          "qutebrowser/utils/urlutils.py"
        ])
      );
    } finally {
      runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tracks index freshness across repo changes and refreshes", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    await runtime.init();
    expect(runtime.getIndexStatus().freshness?.stale).toBe(false);

    fs.writeFileSync(path.join(root, "src/new-source.ts"), "export const newSource = true;\n");
    const stale = runtime.getIndexStatus().freshness;
    expect(stale?.stale).toBe(true);
    expect(stale?.reason).toBe("dirty_state_changed");

    const refreshed = await runtime.refreshIndexNow();
    expect(refreshed.freshness?.stale).toBe(false);

    runtime.close();
  });

  it("builds a working-set next read from ignored recommendations", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Recommended app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Showed app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Recommended user formatting source"
    });

    const summary = runtime.summarizeSessionLedger(session.id);

    expect(summary.workingSet.ignoredRecommendedFiles).toContain("src/user.ts");
    expect(summary.workingSet.nextSmallestUsefulRead?.filePath).toBe("src/user.ts");
    expect(summary.workingSet.nextSmallestUsefulRead?.source).toBe("ignored_recommendation");

    runtime.close();
  });

  it("does not suggest ignored recommendations after suppress-only context or passing verification", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_recommended",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Recommended user formatting source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      source: "runtime",
      summary: "Kairn suppressed low-value context",
      metadata: { policyReason: "repeated_context_suppressed" }
    });

    const suppressedSummary = runtime.summarizeSessionLedger(session.id);
    expect(suppressedSummary.workingSet.ignoredRecommendedFiles).toContain("src/user.ts");
    expect(suppressedSummary.workingSet.nextSmallestUsefulRead).toBeUndefined();

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Showed app source"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "verification_passed",
      source: "bench",
      summary: "Final verification passed."
    });

    const verifiedSummary = runtime.summarizeSessionLedger(session.id);
    expect(verifiedSummary.workingSet.nextSmallestUsefulRead).toBeUndefined();
    expect(verifiedSummary.workingSet.openRisks).not.toEqual(
      expect.arrayContaining([expect.stringContaining("recommended file")])
    );

    runtime.close();
  });

  it("clears changed-file stale risk after a later passing verification", () => {
    const events: SessionLedgerEvent[] = [
      ledgerEvent("context_shown", "src/app.ts", "2026-05-12T10:00:00.000Z"),
      ledgerEvent("agent_file_touched", "src/app.ts", "2026-05-12T10:01:00.000Z")
    ];
    const stale = buildSessionWorkingSet({ sessionId: "task_test", events, currentPhase: "implementation" });

    expect(stale.staleFiles).toContain("src/app.ts");
    expect(stale.nextSmallestUsefulRead?.source).toBe("changed_file");

    const verified = buildSessionWorkingSet({
      sessionId: "task_test",
      events: [
        ...events,
        ledgerEvent("verification_passed", "src/app.ts", "2026-05-12T10:02:00.000Z")
      ],
      currentPhase: "verification"
    });

    expect(verified.staleFiles).not.toContain("src/app.ts");
    expect(verified.nextSmallestUsefulRead?.source).not.toBe("changed_file");
    expect(verified.openRisks).not.toEqual(expect.arrayContaining([expect.stringContaining("changed after being shown")]));
  });

  it("shrinks post-diagnose context to the active source instead of resurfacing companions", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Earlier companion context"
    });

    const prime = await runtime.primeContext({
      task: "Fix the dashboard formatting regression in the production source.",
      sessionId: session.id,
      budget: 500,
      source: "bench"
    });
    const sessionPolicy = prime.metadata?.sessionPolicy as { reason?: string } | undefined;

    expect(sessionPolicy?.reason).toBe("active_source_context_shrunk");
    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.files).toEqual(["src/app.ts"]);
    expect(prime.content).toContain("src/app.ts");
    expect(prime.content).not.toContain("src/user.ts");
    expect(prime.content).toContain("Kairn Fix Guardrail");
    expect(prime.content).not.toContain("Quality score");

    runtime.close();
  });

  it("keeps the active session source ahead of fresh one-file production candidates", async () => {
    const root = createFixtureRepo();
    execFileSync("git", ["checkout", "--", "src/app.ts"], { cwd: root, stdio: "ignore" });
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate formatUser whitespace fallback");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/user.ts",
      source: "runtime",
      summary: "Known source invariant",
      metadata: {
        invariant: {
          statement: "formatUser must trim whitespace",
          confidence: 0.9
        }
      }
    });

    const prime = await runtime.primeContext({
      task: "Fix the src/app.ts dashboard formatting regression in the production source.",
      sessionId: session.id,
      budget: 500,
      source: "bench"
    });
    const sessionPolicy = prime.metadata?.sessionPolicy as { reason?: string; files?: string[] } | undefined;

    expect(sessionPolicy?.reason).toBe("active_source_context_shrunk");
    expect(sessionPolicy?.files).toEqual(["src/user.ts"]);
    expect(prime.contextDecision?.action).toBe("shrink");
    expect(prime.files).toEqual(["src/user.ts"]);
    expect(prime.content).toContain("src/user.ts");
    expect(prime.content).not.toContain("Start file:\n- src/app.ts");

    runtime.close();
  });

  it("suppresses automatic verification and cleanup context after a passing check", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Investigate dashboard formatting");

    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "context_shown",
      filePath: "src/app.ts",
      source: "runtime",
      summary: "Earlier focused source context"
    });
    runtime.recordLedgerEvent({
      sessionId: session.id,
      kind: "verification_passed",
      filePath: "src/app.ts",
      source: "bench",
      summary: "Dashboard verification passed."
    });

    const prime = await runtime.primeContext({
      task: "Verify the src/app.ts dashboard rendering fix after the passing check.",
      sessionId: session.id,
      budget: 500,
      source: "codex"
    });
    const sessionPolicy = prime.metadata?.sessionPolicy as { reason?: string } | undefined;

    expect(sessionPolicy?.reason).toBe("verified_context_suppressed");
    expect(prime.contextDecision?.action).toBe("suppress");
    expect(prime.files).toEqual([]);

    const cleanup = await runtime.primeContext({
      task: "Review the final diff and confirm only src/app.ts changed.",
      sessionId: session.id,
      budget: 500,
      source: "codex"
    });
    const cleanupPolicy = cleanup.metadata?.sessionPolicy as { phase?: string; reason?: string } | undefined;

    expect(cleanupPolicy?.phase).toBe("cleanup");
    expect(cleanupPolicy?.reason).toBe("verified_context_suppressed");
    expect(cleanup.contextDecision?.action).toBe("suppress");

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
      output: ["FAIL src/app.test.ts", "Expected true to be false", ...Array.from({ length: 800 }, (_, index) => `trace line ${index}`)].join("\n")
    });
    const metrics = runtime.getMetrics(session.id);

    expect(file.mode).toBe("exact_code");
    expect(symbol.symbols).toEqual(["renderDashboard"]);
    expect(related.related).toContain("src/user.ts");
    expect(related.content).toMatch(/imports target|imported by target|target imports file/);
    expect(tests.files).toContain("src/app.test.ts");
    expect(symbolContext.files).toContain("src/widgets.ts");
    expect(symbolContext.content).toContain("Response Mode");
    expect(symbolContext.content).toMatch(/semantic match|symbol match/);
    expect(diff.files).toContain("src/app.ts");
    expect(compressed.content).toContain("Expected true");
    expect(metrics.totals.events).toBeGreaterThanOrEqual(7);
    expect(metrics.totals.savedTokens).toBeGreaterThan(0);
    expect(metrics.byKind.compression?.savedTokens).toBeGreaterThan(0);

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

  it("routes vague context queries to snippets when requested", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard card");

    const response = await runtime.findContext({
      sessionId: session.id,
      query: "metrics",
      mode: "snippets",
      budget: 800
    });

    expect(response.mode).toBe("snippets");
    expect(response.content).toContain("## Matched Snippets");
    expect(estimateTokens(response.content)).toBeLessThanOrEqual(800);

    runtime.close();
  });

  it("prioritizes job tracker UI files for mobile layout queries", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update job tracker mobile layout");

    const response = await runtime.findContext({
      sessionId: session.id,
      query: "job tracker mobile layout",
      mode: "snippets",
      budget: 1200
    });

    expect(response.files.slice(0, 3)).toEqual(
      expect.arrayContaining([
        "src/app/private/jobs/JobsApplicationsTable.tsx",
        "src/app/private/jobs/JobsDashboardTabs.tsx"
      ])
    );
    expect(response.content).toContain("Detected Intent: ui");
    const uiIndex = response.files.indexOf("src/app/private/jobs/JobsApplicationsTable.tsx");
    const parserIndex = response.files.indexOf("src/lib/jobs/parser.ts");
    expect(parserIndex === -1 || uiIndex < parserIndex).toBe(true);

    runtime.close();
  });

  it("suppresses low-value exact-path prime briefs", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    const prime = await runtime.primeContext({
      task: "Fix src/app.ts by checking renderDashboard",
      budget: 900
    });

    expect(prime.quality?.action).toBe("suppress");
    expect(prime.quality?.exactPathMentioned).toBe(true);
    expect(prime.content).toContain("Kairn Prime Suppressed");

    runtime.close();
  });

  it("builds failure-first context from failing test output", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Debug dashboard test failure");

    const context = await runtime.getFailureContext({
      sessionId: session.id,
      type: "test",
      command: "pnpm test",
      output: "FAIL src/app.test.ts\nsrc/app.test.ts:4:10 Expected true to be false"
    });

    expect(context.failureFiles).toContain("src/app.test.ts");
    expect(context.files).toContain("src/app.ts");
    expect(context.content).toContain("Kairn Failure Context");
    expect(context.content).toContain("Likely tests");

    runtime.close();
  });
});

function ledgerEvent(kind: SessionLedgerEvent["kind"], filePath: string, createdAt: string): SessionLedgerEvent {
  return {
    sessionId: "task_test",
    kind,
    filePath,
    contentHash: `${kind}:${filePath}:${createdAt}`,
    tokenEstimate: 1,
    source: "bench",
    summary: `${kind} ${filePath}`,
    metadata: {},
    createdAt
  };
}
