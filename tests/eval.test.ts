import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { parseCodexUsageFooter, readCodexTranscript } from "../src/eval/codexUsage.js";
import { createFixtureRepo } from "./helpers.js";

const CLI = ["tsx", "src/cli.ts"];

describe("Codex usage parsing", () => {
  it("parses Codex token usage footers with cached input", () => {
    const parsed = parseCodexUsageFooter("Token usage: total=33,729 input=33,253 (+ 24,704 cached) output=476");

    expect(parsed).toEqual({
      totalTokens: 33729,
      inputTokens: 33253,
      cachedInputTokens: 24704,
      outputTokens: 476
    });
  });

  it("parses Codex token usage footers without cached input and ignores malformed text", () => {
    expect(parseCodexUsageFooter("Token usage: total=1,000 input=800 output=200")).toEqual({
      totalTokens: 1000,
      inputTokens: 800,
      cachedInputTokens: 0,
      outputTokens: 200
    });
    expect(parseCodexUsageFooter("no usage here")).toBeUndefined();
  });

  it("parses current Codex total-only token footers from stderr output", () => {
    expect(parseCodexUsageFooter("tokens used\n121,764")).toEqual({
      totalTokens: 121764,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0
    });
  });

  it("parses transcript metadata without storing raw transcript text", () => {
    const root = createFixtureRepo();
    const transcriptPath = path.join(root, "codex-transcript.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ session_id: "codex-session", turn_id: "turn_123", model: "gpt-5.4" }),
        JSON.stringify({ usage: { total_tokens: 1200, input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 } })
      ].join("\n")
    );

    const transcript = readCodexTranscript({ transcriptPath });

    expect(transcript.metadata).toEqual({
      model: "gpt-5.4",
      hostSessionId: "codex-session",
      turnId: "turn_123"
    });
    expect(transcript.usage?.totalTokens).toBe(1200);
    expect(transcript.transcriptHash).toHaveLength(64);
  });
});

describe("eval runtime", () => {
  it("records eval runs, Codex usage, notes, reports, and comparisons", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);
    const { session } = await runtime.startTask("Update dashboard rendering");
    const baseline = runtime.startEvalRun({
      sessionId: session.id,
      task: "Update dashboard rendering",
      label: "baseline",
      mode: "baseline"
    });
    const kairn = runtime.startEvalRun({
      sessionId: session.id,
      task: "Update dashboard rendering",
      label: "kairn",
      mode: "kairn"
    });

    runtime.ingestCodexUsage({
      sessionId: session.id,
      runId: baseline.id,
      usageText: "Token usage: total=2,000 input=1,800 output=200"
    });
    runtime.ingestCodexUsage({
      sessionId: session.id,
      runId: kairn.id,
      usageText: "Token usage: total=1,200 input=1,050 (+ 300 cached) output=150"
    });
    runtime.addEvalNote({
      runId: kairn.id,
      outcome: "pass",
      summary: "Completed with fewer context reads.",
      files: ["src/app.ts"]
    });

    const report = runtime.getEvalReport({ runId: kairn.id });
    const comparison = runtime.compareEvalRuns({
      baselineRunId: baseline.id,
      kairnRunId: kairn.id
    });
    const metrics = runtime.getMetrics(session.id);

    expect("run" in report && report.codexUsage?.totalTokens).toBe(1200);
    expect(comparison.observedTokenDelta?.savedTokens).toBe(800);
    expect(comparison.outcomeNotes[0]?.summary).toContain("fewer context");
    expect(metrics.observed.latestCodexUsage?.cachedInputTokens).toBe(300);

    runtime.close();
  });
});

describe("eval CLI", () => {
  it("supports eval start, ingest-codex, note, report, compare, and metrics output", () => {
    const root = createFixtureRepo();
    const start = execFileSync(CLI[0]!, [...CLI.slice(1), "start", "Update dashboard", "--root", root, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const parsed = JSON.parse(start) as { session: { id: string } };
    const baseline = JSON.parse(
      execFileSync(
        CLI[0]!,
        [
          ...CLI.slice(1),
          "eval",
          "start",
          "--root",
          root,
          "--session",
          parsed.session.id,
          "--task",
          "Update dashboard",
          "--mode",
          "baseline",
          "--label",
          "baseline",
          "--json"
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as { id: string };
    const kairn = JSON.parse(
      execFileSync(
        CLI[0]!,
        [
          ...CLI.slice(1),
          "eval",
          "start",
          "--root",
          root,
          "--session",
          parsed.session.id,
          "--task",
          "Update dashboard",
          "--mode",
          "kairn",
          "--label",
          "kairn",
          "--json"
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as { id: string };

    execFileSync(
      CLI[0]!,
      [
        ...CLI.slice(1),
        "eval",
        "ingest-codex",
        "--root",
        root,
        "--session",
        parsed.session.id,
        "--run",
        baseline.id,
        "--usage",
        "Token usage: total=2,000 input=1,800 output=200"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    execFileSync(
      CLI[0]!,
      [
        ...CLI.slice(1),
        "eval",
        "ingest-codex",
        "--root",
        root,
        "--session",
        parsed.session.id,
        "--run",
        kairn.id,
        "--usage",
        "Token usage: total=1,500 input=1,200 (+ 200 cached) output=300"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    execFileSync(
      CLI[0]!,
      [
        ...CLI.slice(1),
        "eval",
        "note",
        "--root",
        root,
        "--run",
        kairn.id,
        "--outcome",
        "pass",
        "--summary",
        "Finished successfully",
        "--files",
        "src/app.ts"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    const report = execFileSync(CLI[0]!, [...CLI.slice(1), "eval", "report", "--root", root, "--run", kairn.id], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const comparison = JSON.parse(
      execFileSync(
        CLI[0]!,
        [...CLI.slice(1), "eval", "compare", "--root", root, "--baseline", baseline.id, "--kairn", kairn.id, "--json"],
        { cwd: process.cwd(), encoding: "utf8" }
      )
    ) as { observedTokenDelta?: { savedTokens: number } };
    const metrics = JSON.parse(
      execFileSync(CLI[0]!, [...CLI.slice(1), "metrics", "--session", parsed.session.id, "--root", root, "--json"], {
        cwd: process.cwd(),
        encoding: "utf8"
      })
    ) as { observed: { latestCodexUsage?: { totalTokens: number } } };

    expect(report).toContain("Observed Codex tokens: 1500 total");
    expect(comparison.observedTokenDelta?.savedTokens).toBe(500);
    expect(metrics.observed.latestCodexUsage?.totalTokens).toBe(1500);
  });
});
