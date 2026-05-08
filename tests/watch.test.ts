import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { classifyObservedCommand } from "../src/watch/classifyCommand.js";
import { extractFailureFiles } from "../src/watch/failureParser.js";
import { hostHookOutput, normalizeHookPayload } from "../src/watch/normalizeHook.js";
import { createFixtureRepo } from "./helpers.js";

const CLI = ["tsx", "src/cli.ts"];

describe("watch utilities", () => {
  it("normalizes generic, Claude, and Codex hook payloads", () => {
    const generic = normalizeHookPayload({
      source: "generic",
      payload: {
        eventName: "PostToolUse",
        toolName: "shell",
        command: "pnpm test",
        output: "FAIL src/app.test.ts:3:1",
        exitCode: 1,
        files: ["src/app.test.ts"],
        customField: "kept"
      }
    });
    const claude = normalizeHookPayload({
      source: "claude",
      payload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm typecheck" },
        tool_response: { stderr: "src/app.ts(4,2): error TS2322", exit_code: 2 },
        session_id: "claude-session"
      }
    });
    const codex = normalizeHookPayload({
      source: "codex",
      payload: {
        eventName: "PostToolUse",
        toolName: "shell",
        toolInput: { command: "npm run lint" },
        toolResponse: { output: "lint failed", exitCode: 1 },
        hostSessionId: "codex-session"
      }
    });

    expect(generic.kind).toBe("failure");
    expect(generic.files).toEqual(["src/app.test.ts"]);
    expect(generic.metadata.customField).toBe("kept");
    expect(generic.metadata.outputHash).toBeTruthy();
    expect(claude.command).toBe("pnpm typecheck");
    expect(claude.output).toContain("TS2322");
    expect(claude.hostSessionId).toBe("claude-session");
    expect(codex.command).toBe("npm run lint");
    expect(codex.output).toContain("lint failed");
  });

  it("normalizes official Codex hook payload shapes", () => {
    const bash = normalizeHookPayload({
      source: "codex",
      payload: {
        cwd: "/repo",
        hook_event_name: "PostToolUse",
        model: "gpt-5.4",
        permission_mode: "default",
        session_id: "codex-session",
        transcript_path: null,
        turn_id: "turn_123",
        tool_name: "Bash",
        tool_use_id: "tool_123",
        tool_input: { command: "pnpm test" },
        tool_response: { stdout: "FAIL src/app.test.ts:3:1", stderr: "Expected true to be false", exit_code: 1 }
      }
    });
    const mcp = normalizeHookPayload({
      source: "codex",
      payload: {
        cwd: "/repo",
        hook_event_name: "PostToolUse",
        model: "gpt-5.4",
        permission_mode: "default",
        session_id: "codex-session",
        transcript_path: null,
        turn_id: "turn_123",
        tool_name: "mcp__fs__read_file",
        tool_use_id: "tool_456",
        tool_input: { path: "src/app.ts" },
        tool_response: { content: [{ type: "text", text: "src/app.ts:4:2" }] }
      }
    });
    const prompt = normalizeHookPayload({
      source: "codex",
      payload: {
        cwd: "/repo",
        hook_event_name: "UserPromptSubmit",
        model: "gpt-5.4",
        permission_mode: "default",
        session_id: "codex-session",
        transcript_path: null,
        turn_id: "turn_789",
        prompt: "Fix the dashboard"
      }
    });
    const stop = normalizeHookPayload({
      source: "codex",
      payload: {
        cwd: "/repo",
        hook_event_name: "Stop",
        model: "gpt-5.4",
        permission_mode: "default",
        session_id: "codex-session",
        transcript_path: null,
        turn_id: "turn_999",
        stop_hook_active: false,
        last_assistant_message: "Implemented changes"
      }
    });
    const permission = normalizeHookPayload({
      source: "codex",
      payload: {
        cwd: "/repo",
        hook_event_name: "PermissionRequest",
        model: "gpt-5.4",
        permission_mode: "default",
        session_id: "codex-session",
        transcript_path: null,
        turn_id: "turn_777",
        tool_name: "Bash",
        tool_input: { command: "pnpm install", description: "Install dependencies" }
      }
    });

    expect(bash.command).toBe("pnpm test");
    expect(bash.output).toContain("FAIL src/app.test.ts");
    expect(bash.output).toContain("Expected true to be false");
    expect(bash.metadata.turn_id).toBe("turn_123");
    expect((bash.metadata.tool_response as Record<string, unknown>).stdoutHash).toBeTruthy();
    expect((bash.metadata.tool_response as Record<string, unknown>).stderrHash).toBeTruthy();
    expect((bash.metadata.tool_response as Record<string, unknown>).exit_code).toBe(1);
    expect(mcp.output).toContain("src/app.ts");
    expect(mcp.files).toEqual(["src/app.ts"]);
    expect(prompt.eventName).toBe("UserPromptSubmit");
    expect(prompt.output).toContain("Fix the dashboard");
    expect(stop.kind).toBe("session");
    expect(stop.output).toContain("Implemented changes");
    expect(permission.command).toBe("pnpm install");
    expect(permission.kind).toBe("command");
  });

  it("normalizes official Claude hook payload shapes", () => {
    const postToolUse = normalizeHookPayload({
      source: "claude",
      payload: {
        session_id: "claude-session",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/repo",
        permission_mode: "default",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "FAIL src/app.test.ts:3:1", stderr: "", interrupted: false, isImage: false }
      }
    });
    const failure = normalizeHookPayload({
      source: "claude",
      payload: {
        session_id: "claude-session",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/repo",
        permission_mode: "default",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_use_id: "toolu_123",
        error: "Command exited with non-zero status code 1: src/app.test.ts:3:1",
        is_interrupt: false,
        duration_ms: 4187
      }
    });
    const fileChanged = normalizeHookPayload({
      source: "claude",
      payload: {
        session_id: "claude-session",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/repo",
        permission_mode: "default",
        hook_event_name: "FileChanged",
        file_path: "src/app.ts",
        event: "change"
      }
    });
    const batch = normalizeHookPayload({
      source: "claude",
      payload: {
        session_id: "claude-session",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/repo",
        permission_mode: "default",
        hook_event_name: "PostToolBatch",
        tool_calls: [
          {
            tool_name: "Read",
            tool_input: { file_path: "src/app.ts" },
            tool_use_id: "toolu_1",
            tool_response: "1\t export function renderDashboard() {}"
          },
          {
            tool_name: "Read",
            tool_input: { file_path: "src/user.ts" },
            tool_use_id: "toolu_2",
            tool_response: "1\t export function formatUser() {}"
          }
        ]
      }
    });

    expect(postToolUse.command).toBe("npm test");
    expect(postToolUse.output).toContain("FAIL src/app.test.ts");
    expect(failure.kind).toBe("failure");
    expect(failure.output).toContain("src/app.test.ts");
    expect(failure.metadata.errorHash).toBeTruthy();
    expect(fileChanged.kind).toBe("file_change");
    expect(fileChanged.files).toEqual(["src/app.ts"]);
    expect(batch.files).toEqual(["src/app.ts", "src/user.ts"]);
    expect(batch.output).toContain("renderDashboard");
  });

  it("emits non-blocking host-specific additional context JSON", () => {
    const codexOutput = JSON.parse(
      hostHookOutput({
        source: "codex",
        eventName: "PostToolUse",
        content: "Read src/app.ts next"
      })
    ) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    const claudeOutput = JSON.parse(
      hostHookOutput({
        source: "claude",
        eventName: "PostToolUseFailure",
        content: "Inspect the failing test"
      })
    ) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

    expect(codexOutput.hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      additionalContext: "Read src/app.ts next"
    });
    expect(claudeOutput.hookSpecificOutput).toEqual({
      hookEventName: "PostToolUseFailure",
      additionalContext: "Inspect the failing test"
    });
    expect(
      JSON.parse(hostHookOutput({ source: "codex", eventName: "Stop", content: "Review the final diff" })) as {
        systemMessage: string;
      }
    ).toEqual({
      systemMessage: "Review the final diff"
    });
    expect(hostHookOutput({ source: "claude", eventName: "FileChanged", content: "Review src/app.ts" })).toBe("");
  });

  it("classifies observed command output", () => {
    expect(classifyObservedCommand({ command: "pnpm vitest run" })).toBe("test");
    expect(classifyObservedCommand({ command: "pnpm lint" })).toBe("lint");
    expect(classifyObservedCommand({ output: "src/app.ts(1,2): error TS2304" })).toBe("typecheck");
    expect(classifyObservedCommand({ command: "git status" })).toBe("generic");
  });

  it("extracts failure file references", () => {
    const root = createFixtureRepo();
    const files = extractFailureFiles({
      rootPath: root,
      knownFiles: ["src/app.ts", "src/app.test.ts"],
      output: [
        "FAIL src/app.test.ts:3:1",
        "src/app.ts(4,2): error TS2322",
        `at render (${root}/src/app.ts:4:2)`
      ].join("\n")
    });

    expect(files).toEqual(["src/app.test.ts", "src/app.ts"]);
  });
});

describe("KairnRuntime watch behavior", () => {
  it("records watch events and includes them in session state", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");

    await runtime.recordFileChanges({
      sessionId: session.id,
      files: ["src/app.ts"]
    });
    const snapshot = await runtime.createWatchSnapshot({ sessionId: session.id });
    const updatedSession = runtime.getSession(session.id);

    expect(snapshot.changedFiles).toContain("src/app.ts");
    expect(updatedSession.watchEvents.some((event) => event.kind === "file_change")).toBe(true);
    expect(updatedSession.watchEvents.some((event) => event.kind === "diff_change")).toBe(true);

    runtime.close();
  });

  it("handles hook failures with failure-first context and recommends linked context", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");
    const event = normalizeHookPayload({
      source: "generic",
      payload: {
        eventName: "PostToolUse",
        command: "pnpm test",
        output: "FAIL src/app.test.ts:3:1\nExpected true to be false",
        exitCode: 1
      }
    });

    const result = await runtime.handleHookEvent({ sessionId: session.id, event });

    expect(result.event.kind).toBe("failure");
    expect(result.event.files).toContain("src/app.test.ts");
    expect(result.failureContext?.content).toContain("Expected true");
    expect(result.failureContext?.failureFiles).toContain("src/app.test.ts");
    expect(result.recommendation?.suggestedNextContext).toContain("src/app.test.ts");

    runtime.close();
  });

  it("records trivial successful hook output without emitting recommendation context", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");
    const event = normalizeHookPayload({
      source: "codex",
      payload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "pwd" },
        tool_response: { stdout: root, exit_code: 0 }
      }
    });

    const result = await runtime.handleHookEvent({ sessionId: session.id, event });
    const metrics = runtime.getMetrics(session.id);

    expect(result.event.kind).toBe("command");
    expect(result.response).toBeUndefined();
    expect(result.recommendation).toBeUndefined();
    expect(metrics.byKind.hook_signal?.events).toBe(1);

    runtime.close();
  });

  it("creates and reuses sessions for sessionless Codex prompt-submit hooks", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const promptEvent = normalizeHookPayload({
      source: "codex",
      payload: {
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-session",
        turn_id: "turn_1",
        prompt: "Fix the job tracker mobile layout bottom sheet"
      }
    });

    const first = await runtime.handleHookEvent({ event: promptEvent, primeBudget: 1200 });
    const followup = await runtime.handleHookEvent({
      event: normalizeHookPayload({
        source: "codex",
        payload: {
          cwd: root,
          hook_event_name: "PostToolUse",
          session_id: "codex-session",
          turn_id: "turn_2",
          tool_name: "Bash",
          tool_input: { command: "pwd" },
          tool_response: { stdout: root, exit_code: 0 }
        }
      })
    });
    const metrics = runtime.getMetrics(first.session.id);

    expect(first.session.task).toContain("Fix the job tracker mobile layout");
    expect(first.prime?.content).toContain("Kairn Proactive Context");
    expect(first.recommendation).toBeUndefined();
    expect(first.prime?.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
    expect(followup.session.id).toBe(first.session.id);
    expect(metrics.byKind.prime_context?.events).toBe(1);

    runtime.close();
  });

  it("suppresses duplicate prompt-submit prime context for the same Codex turn", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const payload = {
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-session",
      turn_id: "turn_1",
      prompt: "Fix the job tracker mobile layout bottom sheet"
    };
    const first = await runtime.handleHookEvent({ event: normalizeHookPayload({ source: "codex", payload }) });
    const duplicate = await runtime.handleHookEvent({ event: normalizeHookPayload({ source: "codex", payload }) });
    const metrics = runtime.getMetrics(first.session.id);

    expect(first.prime).toBeDefined();
    expect(duplicate.prime).toBeUndefined();
    expect(duplicate.recommendation).toBeUndefined();
    expect(duplicate.event.metadata.duplicatePromptPrime).toBe(true);
    expect(metrics.byKind.prime_context?.events).toBe(1);
    expect(metrics.byKind.hook_signal?.events).toBe(2);

    runtime.close();
  });

  it("supports tiny directive and failure-only hook output profiles", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const event = normalizeHookPayload({
      source: "codex",
      payload: {
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-session",
        turn_id: "turn_1",
        prompt: "Fix the job tracker mobile layout bottom sheet"
      }
    });
    const tiny = await runtime.handleHookEvent({
      event,
      hookOutput: "tiny-directive",
      primeBudget: 600
    });
    const failureOnly = await runtime.handleHookEvent({
      event: normalizeHookPayload({
        source: "codex",
        payload: {
          cwd: root,
          hook_event_name: "UserPromptSubmit",
          session_id: "codex-failure-only-session",
          turn_id: "turn_1",
          prompt: "Fix the job tracker mobile layout bottom sheet"
        }
      }),
      hookOutput: "failure-only",
      primeBudget: 600
    });

    expect(tiny.prime?.content).toContain("Kairn Start Points");
    expect(tiny.prime?.content).toContain("Use these before broad repo search");
    expect(tiny.prime?.tokenEstimate).toBeLessThanOrEqual(600);
    expect(tiny.prime?.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
    expect(failureOnly.prime).toBeUndefined();
    expect(failureOnly.recommendation).toBeUndefined();

    runtime.close();
  });

  it("records low-confidence sessionless prompt hooks without emitting context", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const result = await runtime.handleHookEvent({
      event: normalizeHookPayload({
        source: "codex",
        payload: {
          cwd: root,
          hook_event_name: "UserPromptSubmit",
          session_id: "codex-session",
          turn_id: "turn_1",
          prompt: "thanks"
        }
      })
    });
    const metrics = runtime.getMetrics(result.session.id);

    expect(result.event.eventName).toBe("UserPromptSubmit");
    expect(result.prime).toBeUndefined();
    expect(result.recommendation).toBeUndefined();
    expect(metrics.byKind.prime_context).toBeUndefined();
    expect(metrics.byKind.hook_signal?.events).toBe(1);

    runtime.close();
  });
});

describe("watch and hook CLI", () => {
  it("supports watch --once and generic hook ingestion", () => {
    const root = createFixtureRepo();
    const start = execFileSync(CLI[0]!, [...CLI.slice(1), "start", "Update dashboard", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const parsed = JSON.parse(start) as { session: { id: string } };
    const watch = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "watch", "--session", parsed.session.id, "--root", root, "--once", "--json"],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    const hook = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "hook", "--session", parsed.session.id, "--root", root, "--source", "generic", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify({
          eventName: "PostToolUse",
          command: "pnpm test",
          output: "FAIL src/app.test.ts:3:1\nExpected true to be false",
          exitCode: 1
        })
      }
    );
    const watchParsed = JSON.parse(watch) as { changedFiles: string[]; recommendations: unknown[] };
    const hookParsed = JSON.parse(hook) as { event: { kind: string; files: string[] }; recommendation?: { suggestedNextContext: string[] } };

    expect(watchParsed.changedFiles).toContain("src/app.ts");
    expect(hookParsed.event.kind).toBe("failure");
    expect(hookParsed.event.files).toContain("src/app.test.ts");
    expect(hookParsed.recommendation?.suggestedNextContext).toContain("src/app.test.ts");
  });

  it("supports snake_case Codex and Claude hook ingestion", () => {
    const root = createFixtureRepo();
    const start = execFileSync(CLI[0]!, [...CLI.slice(1), "start", "Update dashboard", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const parsed = JSON.parse(start) as { session: { id: string } };
    const codexHook = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "hook", "--session", parsed.session.id, "--root", root, "--source", "codex", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify({
          cwd: root,
          hook_event_name: "PostToolUse",
          model: "gpt-5.4",
          permission_mode: "default",
          session_id: "codex-session",
          transcript_path: null,
          turn_id: "turn_123",
          tool_name: "Bash",
          tool_use_id: "tool_123",
          tool_input: { command: "pnpm test" },
          tool_response: { stdout: "FAIL src/app.test.ts:3:1", stderr: "Expected true to be false", exit_code: 1 }
        })
      }
    );
    const claudeHook = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "hook", "--session", parsed.session.id, "--root", root, "--source", "claude", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify({
          session_id: "claude-session",
          transcript_path: "/tmp/transcript.jsonl",
          cwd: root,
          permission_mode: "default",
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          tool_input: { command: "pnpm test" },
          tool_use_id: "toolu_123",
          error: "Command exited with non-zero status code 1: src/app.test.ts:3:1",
          is_interrupt: false,
          duration_ms: 4187
        })
      }
    );
    const hostOutput = execFileSync(
      CLI[0]!,
      [...CLI.slice(1), "hook", "--session", parsed.session.id, "--root", root, "--source", "codex"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify({
          cwd: root,
          hook_event_name: "PostToolUse",
          model: "gpt-5.4",
          permission_mode: "default",
          session_id: "codex-session",
          transcript_path: null,
          turn_id: "turn_123",
          tool_name: "Bash",
          tool_use_id: "tool_123",
          tool_input: { command: "pnpm test" },
          tool_response: { stdout: "FAIL src/app.test.ts:3:1", stderr: "Expected true to be false", exit_code: 1 }
        })
      }
    );
    const codexParsed = JSON.parse(codexHook) as { event: { command: string; files: string[]; metadata: Record<string, unknown> } };
    const claudeParsed = JSON.parse(claudeHook) as { event: { kind: string; files: string[] }; recommendation?: { suggestedNextContext: string[] } };
    const hostParsed = JSON.parse(hostOutput) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

    expect(codexParsed.event.command).toBe("pnpm test");
    expect(codexParsed.event.files).toContain("src/app.test.ts");
    expect(codexParsed.event.metadata.turn_id).toBe("turn_123");
    expect(claudeParsed.event.kind).toBe("failure");
    expect(claudeParsed.event.files).toContain("src/app.test.ts");
    expect(claudeParsed.recommendation?.suggestedNextContext).toContain("src/app.test.ts");
    expect(hostParsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(hostParsed.hookSpecificOutput.additionalContext).toContain("Kairn Failure Context");
  });

  it("supports sessionless Codex prompt hooks and setup codex config", () => {
    const root = createFixtureRepo();
    const setup = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "codex", "--root", root, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { configPath: string; hooksPath: string; primeBudget: number; hookOutput: string; postToolHookOutput: string };
    const config = fs.readFileSync(setup.configPath, "utf8");
    const hooks = fs.readFileSync(setup.hooksPath, "utf8");
    const observe = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "codex", "--root", root, "--mode", "observe", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { hooksPath: string; mode: string };
    const observeHooks = fs.readFileSync(observe.hooksPath, "utf8");
    const debug = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "setup", "codex", "--root", root, "--mode", "debug", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { hooksPath: string; mode: string };
    const debugHooks = fs.readFileSync(debug.hooksPath, "utf8");
    const hook = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "hook", "--root", root, "--source", "codex", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8",
        input: JSON.stringify({
          cwd: root,
          hook_event_name: "UserPromptSubmit",
          session_id: "codex-session",
          turn_id: "turn_1",
          prompt: "Fix the job tracker mobile layout bottom sheet"
        })
      })
    ) as { session: { id: string }; prime?: { content: string; files: string[] }; recommendation?: { content: string } };
    const hostOutput = execFileSync(CLI[0]!, [...CLI.slice(1), "hook", "--root", root, "--source", "codex"], {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-host-output-session",
        turn_id: "turn_1",
        prompt: "Fix the job tracker mobile layout bottom sheet"
      })
    });
    const hostParsed = JSON.parse(hostOutput) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };

    expect(setup.primeBudget).toBe(600);
    expect(setup.hookOutput).toBe("tiny-directive");
    expect(setup.postToolHookOutput).toBe("failure-only");
    expect(config).toContain("codex_hooks = true");
    expect(hooks).toContain("--prime-budget 600");
    expect(hooks).toContain("--hook-output tiny-directive");
    expect(hooks).not.toContain("--session");
    expect(hooks).not.toContain("PostToolUse");
    expect(observe.mode).toBe("observe");
    expect(observeHooks).toContain("PostToolUse");
    expect(observeHooks).toContain("Bash|apply_patch|mcp__.*");
    expect(observeHooks).toContain("--hook-output failure-only");
    expect(debug.mode).toBe("debug");
    expect(debugHooks).toContain("\"matcher\": \".*\"");
    expect(debugHooks).toContain("Stop");
    expect(hook.session.id).toMatch(/^task_/);
    expect(hook.prime?.content).toContain("Kairn Proactive Context");
    expect(hook.prime?.files).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
    expect(hook.recommendation).toBeUndefined();
    expect(hostParsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(hostParsed.hookSpecificOutput.additionalContext).toContain("Kairn Proactive Context");
  });
});
