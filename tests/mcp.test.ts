import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { runBenchmarkMcpSmoke } from "../src/bench/mcpSmoke.js";
import { filesFromMcpValue } from "../src/mcp/resultExtractors.js";
import { createFixtureRepo } from "./helpers.js";

describe("MCP server", () => {
  it("does not count suppressed failure metadata as returned MCP files", () => {
    expect(
      filesFromMcpValue({
        contextSuppressed: true,
        files: [],
        failureFiles: ["eslint.config.js", "tests/browser/interceptors.browser.test.js"],
        changedFiles: ["AGENTS.md", "lib/core/Axios.js"],
        testFiles: ["tests/browser/interceptors.browser.test.js"]
      })
    ).toEqual([]);

    expect(
      filesFromMcpValue({
        files: ["lib/core/Axios.js"],
        changedFiles: ["AGENTS.md"]
      })
    ).toEqual(["lib/core/Axios.js"]);
  });

  it("lists and calls Kairn tools over stdio", async () => {
    const root = createFixtureRepo();
    const client = new Client({
      name: "kairn-test-client",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: path.join(process.cwd(), "node_modules/.bin/tsx"),
      args: ["src/cli.ts", "serve", "--mcp", "--root", root],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_start_task");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_get_metrics");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_prepare_task");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_get_failure_context");
    expect(tools.tools.map((tool) => tool.name)).toContain("kairn_get_next_context");

    const started = await client.callTool({
      name: "kairn_start_task",
      arguments: {
        task: "Update dashboard rendering"
      }
    });
    const startedText = firstTextContent(started);
    expect(startedText).toBeTruthy();
    const parsed = JSON.parse(startedText!) as { session: { id: string } };

    const prepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Update dashboard rendering",
        sessionId: parsed.session.id,
        budget: 700
      }
    });
    const preparedText = firstTextContent(prepared);
    expect(preparedText).toContain("recommendedToolCalls");
    const preparedParsed = JSON.parse(preparedText!) as {
      detail: string;
      sessionId: string;
      startFiles: string[];
      nextToolCalls: unknown[];
      likelyTests: string[];
      exactSymbolHint?: string | null;
      content?: string;
    };
    expect(preparedParsed.detail).toBe("compact");
    expect(preparedParsed.sessionId).toBe(parsed.session.id);
    expect(preparedParsed.startFiles.length).toBeLessThanOrEqual(1);
    expect(preparedParsed.nextToolCalls.length).toBeLessThanOrEqual(1);
    expect(preparedParsed.likelyTests.length).toBeLessThanOrEqual(1);
    expect(preparedParsed).toHaveProperty("exactSymbolHint");
    expect(preparedParsed.content).toBeUndefined();

    const fullPrepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Update dashboard rendering",
        sessionId: parsed.session.id,
        budget: 700,
        detail: "full"
      }
    });
    const fullPreparedText = firstTextContent(fullPrepared);
    const fullPreparedParsed = JSON.parse(fullPreparedText!) as { detail: string; content?: string };
    expect(fullPreparedParsed.detail).toBe("full");
    expect(fullPreparedParsed.content).toContain("Kairn");

    const file = await client.callTool({
      name: "kairn_read_file",
      arguments: {
        sessionId: parsed.session.id,
        target: "src/app.ts"
      }
    });
    const fileText = firstTextContent(file);
    expect(fileText).toContain("renderDashboard");

    const context = await client.callTool({
      name: "kairn_find_context",
      arguments: {
        sessionId: parsed.session.id,
        query: "DashboardMetrics",
        mode: "snippets"
      }
    });
    const contextText = firstTextContent(context);
    expect(contextText).toContain("DashboardMetrics");
    expect(contextText).toContain("snippets");

    const tests = await client.callTool({
      name: "kairn_find_tests",
      arguments: {
        sessionId: parsed.session.id,
        target: "src/app.ts"
      }
    });
    const testsText = firstTextContent(tests);
    const testsParsed = JSON.parse(testsText!) as { files: string[] };
    expect(testsParsed.files.length).toBeLessThanOrEqual(1);

    const failure = await client.callTool({
      name: "kairn_get_failure_context",
      arguments: {
        sessionId: parsed.session.id,
        type: "test",
        output: "FAIL src/app.test.ts\nsrc/app.test.ts:4:10 Expected true to be false"
      }
    });
    expect(firstTextContent(failure)).toContain("Kairn Failure Context");

    const metrics = await client.callTool({
      name: "kairn_get_metrics",
      arguments: {
        sessionId: parsed.session.id
      }
    });
    const metricsText = firstTextContent(metrics);
    expect(metricsText).toContain("savedTokens");
    const metricsParsed = JSON.parse(metricsText!) as {
      byKind: Record<string, { events: number }>;
      bySource: Record<string, { events: number }>;
    };
    expect(metricsParsed.byKind.mcp_tool_call?.events).toBeGreaterThan(0);
    expect(metricsParsed.bySource.mcp?.events).toBeGreaterThan(0);

    await client.close();
  });

  it("runs the benchmark MCP smoke helper", async () => {
    const root = createFixtureRepo();
    const report = await runBenchmarkMcpSmoke({
      rootPath: root,
      task: "Find the dashboard rendering source before broad scans",
      serverCommand: path.join(process.cwd(), "node_modules/.bin/tsx"),
      serverArgs: ["src/cli.ts", "serve", "--mcp", "--root", "{root}"]
    });

    expect(report.tools).toContain("kairn_prepare_task");
    expect(report.sessionId).toMatch(/^task_/);
    expect(report.metrics.mcpToolCalls).toBeGreaterThan(0);
    expect(report.prepare.startFiles.length).toBeLessThanOrEqual(1);
  });

  it("stops MCP expansion after a high-confidence exact source hit", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "include/fmt"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "include/fmt/base.h"),
      [
        "namespace fmt {",
        "class basic_string_view {",
        " public:",
        "  bool starts_with(basic_string_view prefix) const {",
        "    return size_ > prefix.size_;",
        "  }",
        " private:",
        "  int size_;",
        "};",
        "}",
        ""
      ].join("\n")
    );
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "test/base-test.cc"), "TEST(starts_with, equal_length) {}\n");
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/starts-with.md"), "starts_with documentation\n");

    const client = new Client({
      name: "kairn-test-client",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: path.join(process.cwd(), "node_modules/.bin/tsx"),
      args: ["src/cli.ts", "serve", "--mcp", "--root", root],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    await client.connect(transport);

    const prepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Debug a seeded failing C++ check. basic_string_view::starts_with should return true for an equal-length identical prefix. Fix the production header.",
        budget: 700
      }
    });
    const preparedParsed = JSON.parse(firstTextContent(prepared)!) as {
      sessionId: string;
      startFiles: string[];
      contextDecision?: { exactSourceHit?: boolean };
      exactSourceEvidence?: {
        file: string;
        symbol?: string;
        snippet?: string;
        verificationCommand?: string;
        invariant?: {
          statement: string;
          confidence: number;
        };
      } | null;
      invariantStatement?: string | null;
      editScope?: {
        initialEditFiles: string[];
        readOnlyFiles: string[];
        allowedExpansionTriggers: string[];
      };
      editScopeDirective?: string;
    };
    expect(preparedParsed.contextDecision?.exactSourceHit).toBe(true);
    expect(preparedParsed.startFiles).toEqual(["include/fmt/base.h"]);
    expect(preparedParsed.exactSourceEvidence?.file).toBe("include/fmt/base.h");
    expect(preparedParsed.exactSourceEvidence?.symbol).toBe("starts_with");
    expect(preparedParsed.exactSourceEvidence?.snippet).toContain("starts_with");
    expect(preparedParsed.exactSourceEvidence?.invariant?.statement).toContain("equal-length identical prefix");
    expect(preparedParsed.exactSourceEvidence?.invariant?.confidence).toBeGreaterThanOrEqual(70);
    expect(preparedParsed.invariantStatement).toContain("equal-length identical prefix");
    expect(preparedParsed.exactSourceEvidence?.verificationCommand).toBeTruthy();
    expect(preparedParsed.editScope?.initialEditFiles).toEqual(["include/fmt/base.h"]);
    expect(preparedParsed.editScope?.allowedExpansionTriggers.length).toBeGreaterThan(0);
    expect(preparedParsed.editScopeDirective).toContain("include/fmt/base.h");
    expect(preparedParsed.editScopeDirective).toContain("tests/");
    expect(preparedParsed.editScopeDirective).toContain("revert");

    const repeatedPrepare = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Fix the same seeded C++ starts_with regression now.",
        sessionId: preparedParsed.sessionId,
        budget: 700
      }
    });
    const repeatedPrepareParsed = JSON.parse(firstTextContent(repeatedPrepare)!) as {
      contextSuppressed?: boolean;
      stopCondition?: string | null;
      startFiles: string[];
      files: string[];
      nextToolCalls: unknown[];
      primaryReason: string;
      editScopeDirective?: string;
    };
    expect(repeatedPrepareParsed.contextSuppressed).toBe(true);
    expect(repeatedPrepareParsed.stopCondition).toBe("source_evidence_already_shown");
    expect(repeatedPrepareParsed.startFiles).toEqual([]);
    expect(repeatedPrepareParsed.files).toEqual([]);
    expect(repeatedPrepareParsed.nextToolCalls).toEqual([]);
    expect(repeatedPrepareParsed.primaryReason).toContain("include/fmt/base.h");
    expect(repeatedPrepareParsed.primaryReason).toContain("out-of-scope");
    expect(repeatedPrepareParsed.editScopeDirective).toContain("include/fmt/base.h");

    const next = await client.callTool({
      name: "kairn_get_next_context",
      arguments: {
        sessionId: preparedParsed.sessionId,
        budget: 500
      }
    });
    const nextParsed = JSON.parse(firstTextContent(next)!) as { files: string[]; related: string[]; warnings: string[]; content: string };
    expect(nextParsed.files).toEqual([]);
    expect(nextParsed.related).toEqual([]);
    expect(nextParsed.warnings.join(" ")).toContain("No fresh context");
    expect(nextParsed.content).toContain("already showed include/fmt/base.h");
    expect(nextParsed.content).toContain("no new failure or diff");

    const context = await client.callTool({
      name: "kairn_find_context",
      arguments: {
        sessionId: preparedParsed.sessionId,
        query: "starts_with tests and related files",
        mode: "snippets",
        budget: 700
      }
    });
    const contextParsed = JSON.parse(firstTextContent(context)!) as { files: string[]; related: string[]; suggestedNextContext: string[]; content: string };
    expect(contextParsed.files).toEqual(["include/fmt/base.h"]);
    expect(contextParsed.related).toEqual([]);
    expect(contextParsed.suggestedNextContext).toEqual([]);
    expect(contextParsed.content).toContain("include/fmt/base.h");

    const failure = await client.callTool({
      name: "kairn_get_failure_context",
      arguments: {
        sessionId: preparedParsed.sessionId,
        type: "test",
        output: "FAIL test/base-test.cc\n test/base-test.cc:1:1 starts_with equal length failed"
      }
    });
    const failureParsed = JSON.parse(firstTextContent(failure)!) as { files: string[]; relatedFiles: string[]; testFiles: string[] };
    expect(failureParsed.files).toEqual(["include/fmt/base.h"]);
    expect(failureParsed.relatedFiles).toEqual([]);
    expect(failureParsed.testFiles).toEqual([]);

    await client.close();
  });

  it("returns only an ultra-minimal MCP guardrail for cheap one-shot exact-source fixes", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "src/flask"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/flask/app.py"),
      [
        "class Flask:",
        "    def dispatch_request(self):",
        "        req = request_ctx.request",
        "        rule = req.url_rule",
        "        return self.ensure_sync(self.view_functions[rule.endpoint])(**req.view_args)",
        ""
      ].join("\n")
    );
    const client = new Client({
      name: "kairn-test-client",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: path.join(process.cwd(), "node_modules/.bin/tsx"),
      args: ["src/cli.ts", "serve", "--mcp", "--root", root],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    await client.connect(transport);

    const prepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Debug the seeded failing Python check. Flask dispatch_request should call the matched endpoint view function with view_args, but the seeded regression returns None. Fix the production source and do not edit unrelated files.",
        budget: 700
      }
    });
    const parsed = JSON.parse(firstTextContent(prepared)!) as {
      contextSuppressed?: boolean;
      stopCondition?: string | null;
      startFiles: string[];
      files: string[];
      nextToolCalls: unknown[];
      primaryReason: string;
    };

    expect(parsed.contextSuppressed).toBe(true);
    expect(parsed.stopCondition).toBe("cheap_one_shot_guardrail");
    expect(parsed.startFiles).toEqual([]);
    expect(parsed.files).toEqual([]);
    expect(parsed.nextToolCalls).toEqual([]);
    expect(parsed.primaryReason).toContain("ultra-minimal guardrail");
    expect(parsed.primaryReason).toContain("src/flask/app.py");

    await client.close();
  });

  it("does not collapse multi-surface source-rescue MCP context into a cheap guardrail", async () => {
    const root = createFixtureRepo();
    fs.mkdirSync(path.join(root, "packages/vite/src/client"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/vite/src/shared"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages/vite/src/node"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "packages/vite/src/client/client.ts"),
      [
        "import { isExternalUrl } from '../shared/utils';",
        "export function injectQuery(url: string, queryToInject: string) {",
        "  if (isExternalUrl(url)) return url;",
        "  if (url[0] === '.' || url[0] === '/') return url;",
        "  return `${url}${queryToInject}`;",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "packages/vite/src/shared/utils.ts"),
      [
        "export function isExternalUrl(url: string) {",
        "  return /^https?:/.test(url);",
        "}",
        ""
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(root, "packages/vite/src/node/utils.ts"),
      [
        "export function injectQueryForNode(url: string, queryToInject: string) {",
        "  return `${url}${queryToInject}`;",
        "}",
        ""
      ].join("\n")
    );

    const client = new Client({
      name: "kairn-test-client",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: path.join(process.cwd(), "node_modules/.bin/tsx"),
      args: ["src/cli.ts", "serve", "--mcp", "--root", root],
      cwd: process.cwd(),
      stderr: "pipe"
    });

    await client.connect(transport);

    const prepared = await client.callTool({
      name: "kairn_prepare_task",
      arguments: {
        task: "Debug the seeded failing TypeScript check. Vite injectQuery should skip external URLs, but relative URLs like ./dep.js and absolute URLs like /src/main.ts must receive the injected query. Fix the production source and do not edit unrelated files.",
        budget: 700
      }
    });
    const parsed = JSON.parse(firstTextContent(prepared)!) as {
      contextSuppressed?: boolean;
      stopCondition?: string | null;
      startFiles: string[];
      files: string[];
      companionFiles: string[];
      contextDecision?: {
        taskFrame?: string;
        recommendedDelivery?: string;
      };
    };

    expect(parsed.contextDecision?.taskFrame).toBe("source_rescue");
    expect(parsed.contextSuppressed).not.toBe(true);
    expect(parsed.stopCondition ?? "").not.toMatch(/cheap_one_shot/);
    expect([...parsed.startFiles, ...parsed.files, ...parsed.companionFiles].length).toBeGreaterThan(0);

    await client.close();
  });
});

function firstTextContent(result: unknown): string | undefined {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const item = content.find((entry): entry is { type: "text"; text: string } => {
    return (
      typeof entry === "object" &&
      entry !== null &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    );
  });

  return item?.text;
}
