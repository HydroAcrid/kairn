// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { runDoctor, type DoctorTarget } from "../../doctor/doctor.js";
import { fixDoctorIssues, type DoctorFixResult } from "../../doctor/fix.js";
import { buildDiagnosticExport, writeDiagnosticExport } from "../../telemetry/diagnostics.js";
import { buildTelemetryPayload } from "../../telemetry/payload.js";
import { buildBetaReport } from "../../telemetry/report.js";
import { buildPrivateBetaTelemetrySummary, writePrivateBetaTelemetrySummary } from "../../telemetry/summary.js";
import { disableTelemetry, enableTelemetry, ensureTelemetryIdentity, getTelemetryStatus } from "../../telemetry/config.js";
import { queueAndFlushTelemetrySnapshot } from "../../telemetry/autoFlush.js";
import { enqueueTelemetryPayload } from "../../telemetry/queue.js";
import { flushTelemetryQueue } from "../../telemetry/queue.js";
import { withRuntime } from "../helpers.js";
import { printJson } from "../output.js";

export function registerBetaCommands(program: Command): void {
  program
    .command("doctor")
    .description("Check Kairn beta setup health for hooks, MCP, daemon, telemetry, and state.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--codex-command <command>", "Codex command to check", process.env.KAIRN_CODEX_CMD ?? "codex")
    .addOption(new Option("--target <target>", "limit doctor checks to one client").choices(["all", "codex", "claude-code", "copilot-cli", "gemini-cli", "vscode", "generic"]).default("all"))
    .option("--fix", "repair Kairn-owned hook/MCP config for the selected target")
    .option("--fix-hooks", "rewrite Kairn-owned Codex hook files when safe")
    .option("--json", "print JSON output")
    .action(async (options: { root: string; codexCommand: string; target: DoctorTarget; fix?: boolean; fixHooks?: boolean; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        let fix: DoctorFixResult | undefined;
        if (options.fix || options.fixHooks) {
          fix = fixDoctorIssues({
            rootPath: options.root,
            target: options.fixHooks && !options.fix ? "codex" : options.target
          });
        }
        const report = runDoctor({ rootPath: options.root, runtime, codexCommand: options.codexCommand, target: options.target });
        if (options.json) {
          printJson(fix ? { ...report, fix } : report);
          return;
        }
        if (fix) printDoctorFix(fix);
        printDoctor(report);
      });
    });

  const telemetry = program
    .command("telemetry")
    .description("Manage privacy-first local telemetry and optional sanitized upload.");

  telemetry
    .command("status")
    .description("Show local telemetry status.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action((options: { root: string; json?: boolean }) => {
      const status = getTelemetryStatus(options.root);
      if (options.json) {
        printJson(status);
        return;
      }
      printTelemetryStatus(status);
    });

  telemetry
    .command("enable")
    .description("Opt in to sanitized aggregate telemetry.")
    .option("--root <path>", "target repository root", process.cwd())
    .requiredOption("--destination <destination>", "telemetry destination, currently: supabase")
    .option("--endpoint <url>", "ingest endpoint override")
    .option("--json", "print JSON output")
    .action((options: { root: string; destination: string; endpoint?: string; json?: boolean }) => {
      if (options.destination !== "supabase") {
        throw new Error("Only --destination supabase is supported.");
      }
      const config = enableTelemetry({ rootPath: options.root, destination: "supabase", endpoint: options.endpoint });
      if (options.json) {
        printJson(config);
        return;
      }
      process.stdout.write("Kairn telemetry enabled. Only sanitized aggregate payloads will be uploaded.\n");
    });

  telemetry
    .command("disable")
    .description("Disable telemetry upload.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--json", "print JSON output")
    .action((options: { root: string; json?: boolean }) => {
      const config = disableTelemetry(options.root);
      if (options.json) {
        printJson(config);
        return;
      }
      process.stdout.write("Kairn telemetry disabled. Local metrics remain in .kairn/.\n");
    });

  telemetry
    .command("flush")
    .description("Queue and upload the current sanitized telemetry snapshot.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--endpoint <url>", "ingest endpoint override")
    .option("--dry-run", "preview without queueing or sending")
    .option("--json", "print JSON output")
    .action(async (options: { root: string; endpoint?: string; dryRun?: boolean; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const identity = ensureTelemetryIdentity(options.root);
        const payload = buildTelemetryPayload({
          runtime,
          installationId: identity.installationId!,
          repoSalt: identity.repoSalt!
        });
        if (!options.dryRun) {
          enqueueTelemetryPayload({ rootPath: options.root, payload });
        }
        const result = await flushTelemetryQueue({ rootPath: options.root, endpoint: options.endpoint, dryRun: options.dryRun });
        if (options.json) {
          printJson({ result, ...(options.dryRun ? { payload } : {}) });
          return;
        }
        process.stdout.write(
          [
            options.dryRun ? "Kairn telemetry dry run." : "Kairn telemetry flush complete.",
            `Attempted: ${result.attempted}`,
            `Sent: ${result.sent}`,
            `Retained: ${result.retained}`,
            result.failures.length ? `Failures: ${result.failures.join("; ")}` : "",
            ""
          ].filter(Boolean).join("\n")
        );
      });
    });

  telemetry
    .command("summary")
    .description("Write a sanitized private-beta telemetry summary report.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--session <id>", "limit summary to one Kairn session")
    .option("--out <path>", "Markdown output path", "docs/private-beta-telemetry-summary-20260515.md")
    .option("--json", "print JSON output")
    .action(async (options: { root: string; session?: string; out: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const identity = ensureTelemetryIdentity(options.root);
        const summary = buildPrivateBetaTelemetrySummary({
          runtime,
          installationId: identity.installationId!,
          repoSalt: identity.repoSalt!,
          sessionId: options.session
        });
        writePrivateBetaTelemetrySummary({ summary, outPath: options.out });
        if (options.json) {
          printJson({ outPath: path.resolve(options.out), summary });
          return;
        }
        process.stdout.write(`Kairn private-beta telemetry summary written: ${path.resolve(options.out)}\n`);
      });
    });

  const diagnostics = program
    .command("diagnostics")
    .description("Create local, user-previewed diagnostic bundles.");

  diagnostics
    .command("export")
    .description("Export a redacted local diagnostic bundle.")
    .option("--root <path>", "target repository root", process.cwd())
    .requiredOption("--out <path>", "output JSON path")
    .option("--json", "print JSON output")
    .action(async (options: { root: string; out: string; json?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const identity = ensureTelemetryIdentity(options.root);
        const doctor = runDoctor({ rootPath: options.root, runtime });
        const exportData = buildDiagnosticExport({
          runtime,
          rootPath: options.root,
          installationId: identity.installationId!,
          repoSalt: identity.repoSalt!,
          doctor
        });
        writeDiagnosticExport({ outPath: options.out, exportData });
        if (options.json) {
          printJson({ outPath: path.resolve(options.out), export: exportData });
          return;
        }
        process.stdout.write(`Kairn diagnostic bundle written: ${path.resolve(options.out)}\n`);
      });
    });

  configureBetaReportCommand(program.command("report"));

  const beta = program
    .command("beta")
    .description("Private beta reporting helpers.");

  configureBetaReportCommand(beta.command("report"));
}

function configureBetaReportCommand(command: Command): void {
  command
    .description("Summarize whether Kairn helped, stayed silent, or over-assisted.")
    .option("--root <path>", "target repository root", process.cwd())
    .option("--session <id>", "limit report to one Kairn session")
    .option("--last <count>", "report the most recent session count", parseSessionLimit, 12)
    .option("--json", "print JSON output")
    .addOption(new Option("--share", "print a concise privacy-safe check-in").conflicts("json"))
    .action(async (options: { root: string; session?: string; last: number; json?: boolean; share?: boolean }) => {
      await withRuntime(options.root, async (runtime) => {
        const report = buildBetaReport({ runtime, sessionId: options.session, limit: options.last });
        const telemetry = await queueAndFlushTelemetrySnapshot({ rootPath: options.root, runtime, sessionId: options.session });
        if (options.json) {
          printJson({ ...report, ...(telemetry ? { telemetry } : {}) });
          return;
        }
        if (options.share) {
          process.stdout.write(formatShareableBetaReport(report));
        } else {
          printBetaReport(report);
        }
        if (telemetry?.sent) {
          process.stdout.write(`Telemetry uploaded: ${telemetry.sent} snapshot(s).\n`);
        }
      });
    });
}

function parseSessionLimit(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError("must be an integer from 1 to 500");
  const parsed = Number(value);
  if (parsed < 1 || parsed > 500) throw new InvalidArgumentError("must be an integer from 1 to 500");
  return parsed;
}

function printDoctor(report: ReturnType<typeof runDoctor>): void {
  process.stdout.write(
    [
      `Kairn doctor: ${report.status}`,
      `Root: ${report.rootPath}`,
      ...report.checks.map((check) => {
        const fix = check.fix ? `\n  fix: ${check.fix}` : "";
        return `- ${check.status.toUpperCase()} ${check.id}: ${check.summary}${fix}`;
      }),
      ""
    ].join("\n")
  );
}

function printDoctorFix(result: DoctorFixResult): void {
  process.stdout.write(
    [
      "Kairn doctor fix.",
      `Target: ${result.target}`,
      `Repaired: ${result.repaired.join(", ") || "none"}`,
      ...result.skipped.map((item) => `Skipped ${item.target}: ${item.reason}`),
      ""
    ].join("\n")
  );
}

function printTelemetryStatus(status: ReturnType<typeof getTelemetryStatus>): void {
  process.stdout.write(
    [
      "Kairn telemetry status.",
      `Enabled: ${status.enabled}`,
      `Destination: ${status.destination ?? "none"}`,
      `Endpoint configured: ${status.endpointConfigured}`,
      `Queue length: ${status.queueLength}`,
      `Queue: ${status.queuePath}`,
      ""
    ].join("\n")
  );
}

function printBetaReport(report: ReturnType<typeof buildBetaReport>): void {
  const percent = Math.abs(report.headline.estimatedContextSavingsRate * 100).toFixed(1);
  const contextImproved = report.headline.estimatedContextTokensAvoided >= 0;
  const basis = report.headline.basis === "quality_gated_estimate"
    ? `quality-gated local estimate from ${report.tokens.qualityGatedSessions} verified session(s)`
    : report.headline.basis === "all_sessions_estimate"
      ? "directional local estimate; no quality-passing session was available"
      : "not enough context data yet";
  const recommendationUse = report.quality.recommendationUseRate === undefined
    ? "n/a"
    : `${(report.quality.recommendationUseRate * 100).toFixed(1)}% (${report.quality.recommendationsLaterUsed}/${report.quality.recommendationsMade})`;
  const recommendationTouch = report.quality.recommendationTouchRate === undefined
    ? "n/a"
    : `${(report.quality.recommendationTouchRate * 100).toFixed(1)}% (${report.quality.recommendationsLaterTouched}/${report.quality.recommendationsMade})`;
  process.stdout.write(
    [
      `Kairn report — last ${report.window.sampled} session${report.window.sampled === 1 ? "" : "s"}`,
      "",
      `Estimated context ${contextImproved ? "saved" : "added"}: ${percent}%`,
      `Estimated context tokens ${contextImproved ? "avoided" : "added"}: ${formatInteger(Math.abs(report.headline.estimatedContextTokensAvoided))}`,
      `Evidence: ${basis}; not provider billing usage.`,
      "",
      "Quality",
      `Verification: ${report.quality.sessionsPassingVerification}/${report.sessions} passed latest verification · ${report.quality.sessionsFailingVerification} failed · ${report.quality.sessionsUnverified} unverified`,
      `Recommended files later used: ${recommendationUse}`,
      `Recommended files later modified: ${recommendationTouch}`,
      `Harmful assists: ${report.quality.harmfulAssists}`,
      "",
      "Behavior",
      `Kairn interventions: ${report.decisions.interventions} · stayed silent: ${report.decisions.stayedSilent}`,
      `Repeated context blocked: ${report.context.repeatedFilesAvoided} files · ${report.context.repeatedSnippetsAvoided} snippets`,
      `Verdict: ${report.verdict}`,
      "",
      ...report.summary.map((line) => `- ${line}`),
      ""
    ].join("\n")
  );
}

export function formatShareableBetaReport(report: ReturnType<typeof buildBetaReport>): string {
  const percent = Math.abs(report.headline.estimatedContextSavingsRate * 100).toFixed(1);
  const contextImproved = report.headline.estimatedContextTokensAvoided >= 0;
  const contextHeadline = report.headline.basis === "no_data"
    ? "Estimated context saved: not enough data"
    : `Estimated context ${contextImproved ? "saved" : "added"}: ${percent}% (${formatInteger(Math.abs(report.headline.estimatedContextTokensAvoided))} tokens)`;
  const recommendationUse = report.quality.recommendationUseRate === undefined
    ? "no recommendations recorded"
    : `${(report.quality.recommendationUseRate * 100).toFixed(1)}% (${report.quality.recommendationsLaterUsed}/${report.quality.recommendationsMade}) later used`;
  const basis = report.headline.basis === "quality_gated_estimate"
    ? `Quality-gated estimate from ${report.tokens.qualityGatedSessions} verified session(s), using Kairn's local full-context baselines; not observed provider usage or billing savings.`
    : report.headline.basis === "all_sessions_estimate"
      ? "Directional estimate using Kairn's local full-context baselines; no quality-passing session was available, and this is not observed provider usage or billing savings."
      : "Not enough recorded context data yet; no savings claim.";
  return [
    `Kairn check-in — last ${report.window.sampled} session${report.window.sampled === 1 ? "" : "s"}`,
    contextHeadline,
    `Quality: ${report.quality.sessionsPassingVerification} passed · ${report.quality.sessionsFailingVerification} failed · ${report.quality.sessionsUnverified} unverified · ${report.quality.harmfulAssists} recorded harmful assists`,
    `Recommendations followed: ${recommendationUse}`,
    `Behavior: ${report.decisions.interventions} interventions · ${report.decisions.stayedSilent} silent decisions`,
    `Repeated context blocked: ${report.context.repeatedFilesAvoided} files · ${report.context.repeatedSnippetsAvoided} snippets`,
    `Basis: ${basis}`,
    "Privacy: aggregate only; no prompts, source, paths, diffs, repository, or branch identity.",
    ""
  ].join("\n");
}
function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
