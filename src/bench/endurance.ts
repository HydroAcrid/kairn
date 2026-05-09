import type {
  BenchmarkCase,
  BenchmarkEnduranceModeReport,
  BenchmarkEnduranceReport,
  BenchmarkEnduranceSuite,
  BenchmarkEnduranceTurn,
  BenchmarkEnduranceTurnResult,
  BenchmarkTaskOutcome
} from "../types.js";
import { parseCodexUsageFooter } from "../eval/codexUsage.js";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import { estimateTokens } from "../utils/tokens.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath } from "../utils/paths.js";
import {
  agentTouchedFiles,
  changedFiles,
  createBenchmarkWorkspace,
  runShell
} from "./agent.js";
import { loadBenchmarkEnduranceSuite } from "./enduranceSuite.js";

type EnduranceMode = "baseline" | "kairn" | "mcp";

export async function runBenchmarkEndurance(input: {
  rootPath: string;
  suitePath: string;
  baselineCommand: string;
  kairnCommand: string;
  mcpCommand?: string | undefined;
  turnTimeoutMs?: number | undefined;
}): Promise<BenchmarkEnduranceReport> {
  const suite = loadBenchmarkEnduranceSuite({ suitePath: input.suitePath });
  const startedAt = new Date().toISOString();
  const reports: BenchmarkEnduranceModeReport[] = [];
  reports.push(await runEnduranceMode({ rootPath: input.rootPath, suite, mode: "baseline", command: input.baselineCommand, timeoutMs: input.turnTimeoutMs }));
  reports.push(await runEnduranceMode({ rootPath: input.rootPath, suite, mode: "kairn", command: input.kairnCommand, timeoutMs: input.turnTimeoutMs }));
  if (input.mcpCommand) {
    reports.push(await runEnduranceMode({ rootPath: input.rootPath, suite, mode: "mcp", command: input.mcpCommand, timeoutMs: input.turnTimeoutMs }));
  }
  const endedAt = new Date().toISOString();
  return {
    suiteId: suite.id,
    suiteName: suite.name,
    startedAt,
    endedAt,
    reports,
    deltas: buildEnduranceDeltas(reports),
    recommendations: buildEnduranceRecommendations(reports)
  };
}

async function runEnduranceMode(input: {
  rootPath: string;
  suite: BenchmarkEnduranceSuite;
  mode: EnduranceMode;
  command: string;
  timeoutMs?: number | undefined;
}): Promise<BenchmarkEnduranceModeReport> {
  const workspace = createBenchmarkWorkspace({
    rootPath: input.rootPath,
    benchmarkCase: suiteSeedCase(input.suite)
  });
  const timeoutMs = input.timeoutMs ?? 180000;
  const runtime = input.mode === "baseline" ? undefined : new KairnRuntime(workspace.workspacePath);
  const startedAt = Date.now();
  let sessionId: string | undefined;
  const turnResults: BenchmarkEnduranceTurnResult[] = [];

  try {
    if (runtime) {
      await runtime.init();
      sessionId = (await runtime.startTask(input.suite.task)).session.id;
    }

    for (const turn of input.suite.turns) {
      turnResults.push(await runEnduranceTurn({
        suite: input.suite,
        turn,
        mode: input.mode,
        command: input.command,
        workspacePath: workspace.workspacePath,
        seedMetadata: workspace.metadata,
        timeoutMs,
        runtime,
        sessionId
      }));
    }

    const finalVerification = input.suite.finalVerificationCommand
      ? runShell(input.suite.finalVerificationCommand, workspace.workspacePath, timeoutMs)
      : undefined;
    if (runtime && sessionId && finalVerification) {
      runtime.recordLedgerEvent({
        sessionId,
        kind: finalVerification.status === 0 ? "verification_passed" : "verification_failed",
        source: "bench",
        summary: finalVerification.status === 0 ? "Final endurance verification passed." : "Final endurance verification failed.",
        metadata: {
          finalVerificationCommandHash: sha256(input.suite.finalVerificationCommand ?? ""),
          finalVerificationExitCode: finalVerification.status,
          finalVerificationOutputHash: sha256(finalVerification.output)
        }
      });
    }
    const ledger = runtime && sessionId ? runtime.summarizeSessionLedger(sessionId) : undefined;
    const finalVerificationPassed = finalVerification ? finalVerification.status === 0 : true;
    return {
      mode: input.mode,
      workspacePath: workspace.workspacePath,
      ...(sessionId ? { sessionId } : {}),
      turns: turnResults,
      ...(turnResults.some((turn) => turn.observedCodexTokens !== undefined)
        ? { totalObservedCodexTokens: sumDefined(turnResults.map((turn) => turn.observedCodexTokens)) }
        : {}),
      totalResponseTokens: turnResults.reduce((total, turn) => total + turn.responseTokens, 0),
      totalElapsedMs: Date.now() - startedAt,
      qualityGatePassed: finalVerificationPassed && turnResults.every((turn) => turn.qualityGatePassed),
      finalVerificationPassed,
      ...(ledger ? { ledger } : {})
    };
  } finally {
    runtime?.close();
  }
}

async function runEnduranceTurn(input: {
  suite: BenchmarkEnduranceSuite;
  turn: BenchmarkEnduranceTurn;
  mode: EnduranceMode;
  command: string;
  workspacePath: string;
  seedMetadata: Record<string, unknown>;
  timeoutMs: number;
  runtime?: KairnRuntime | undefined;
  sessionId?: string | undefined;
}): Promise<BenchmarkEnduranceTurnResult> {
  const prompt = input.turn.agentPrompt ?? input.turn.task;
  const startedAt = Date.now();
  const beforeLedger = input.runtime && input.sessionId ? input.runtime.summarizeSessionLedger(input.sessionId) : undefined;
  let preparedPrompt = prompt;
  let primeMetadata: Record<string, unknown> = {};

  if (input.runtime && input.sessionId && input.mode === "kairn") {
    const prime = await input.runtime.primeContext({
      task: prompt,
      sessionId: input.sessionId,
      budget: input.turn.budget,
      source: "bench",
      eventName: "endurance_prime"
    });
    primeMetadata = {
      primeProfile: prime.profile,
      primeDecision: prime.contextDecision?.action,
      primeFiles: prime.files,
      primeTokenEstimate: prime.tokenEstimate,
      primeWarnings: prime.warnings
    };
    preparedPrompt = prime.contextDecision?.action === "suppress"
      ? prompt
      : [
          prime.content,
          "",
          "User task:",
          prompt,
          "",
          "Use this context first. Do not reread already-shown files unless they changed or verification fails."
        ].join("\n");
  } else if (input.runtime && input.sessionId && input.mode === "mcp") {
    preparedPrompt = [
      "Kairn long-session instruction:",
      `Use Kairn session ${input.sessionId}.`,
      "Call kairn_prepare_task before broad reads, kairn_get_next_context for follow-up reads, and kairn_get_failure_context after failures.",
      "Prefer the smallest Kairn-provided source read and avoid repeating files already shown by Kairn.",
      "",
      "User task:",
      prompt
    ].join("\n");
  }

  const command = enduranceCommandWithPlaceholders(input.command, {
    prompt: preparedPrompt,
    root: input.workspacePath,
    session: input.sessionId ?? "",
    turn: input.turn.id
  });
  const result = runShell(command, input.workspacePath, input.timeoutMs);
  const verification = input.turn.verificationCommand ? runShell(input.turn.verificationCommand, input.workspacePath, input.timeoutMs) : undefined;
  const output = [result.output, verification?.output].filter(Boolean).join("\n");
  const usage = parseCodexUsageFooter(output);
  const expectedMentions = mentionedExpectedFiles(output, input.turn.expectedFiles);
  const changed = changedFiles(input.workspacePath);
  const seedPatchFiles = stringList(input.seedMetadata.seedPatchFiles);
  const seedPatchFileHashes = stringRecord(input.seedMetadata.seedPatchFileHashes);
  const touched = agentTouchedFiles({
    workspacePath: input.workspacePath,
    changedFiles: changed,
    seedPatchFiles,
    seedPatchFileHashes
  });
  const actualFiles = uniquePaths([...touched, ...expectedMentions]);
  const missingExpectedFiles = input.turn.expectedFiles.filter((file) => !actualFiles.includes(file));
  const missingRequiredTouchedFiles = (input.turn.requiredTouchedFiles ?? []).filter((file) => !touched.includes(file));
  const excludedTouchedFiles = actualFiles.filter((file) => input.turn.excludedFiles.some((excluded) => benchmarkPathMatches(file, excluded)));
  const commandPassed = result.status === 0 && !result.timedOut;
  const verificationPassed = verification ? verification.status === 0 && !verification.timedOut : true;
  const requiredTouchedSatisfied = missingRequiredTouchedFiles.length === 0;
  const qualityGatePassed = commandPassed && verificationPassed && requiredTouchedSatisfied && excludedTouchedFiles.length === 0;
  const outcome: BenchmarkTaskOutcome = qualityGatePassed ? "pass" : commandPassed && verificationPassed ? "partial" : "fail";

  if (input.runtime && input.sessionId) {
    recordTurnLedger({
      runtime: input.runtime,
      sessionId: input.sessionId,
      turn: input.turn,
      command,
      result,
      verification,
      expectedMentions,
      touched,
      output
    });
  }
  const afterLedger = input.runtime && input.sessionId ? input.runtime.summarizeSessionLedger(input.sessionId) : undefined;

  return {
    turnId: input.turn.id,
    mode: input.mode,
    outcome,
    ...(usage ? { observedCodexTokens: usage.totalTokens } : {}),
    responseTokens: estimateTokens(output),
    elapsedMs: Date.now() - startedAt,
    actualFiles,
    agentTouchedFiles: touched,
    expectedFiles: input.turn.expectedFiles,
    missingExpectedFiles,
    requiredTouchedSatisfied,
    qualityGatePassed,
    repeatedFilesAvoided: Math.max(0, (afterLedger?.repeatedFilesAvoided ?? 0) - (beforeLedger?.repeatedFilesAvoided ?? 0)),
    repeatedSnippetsAvoided: Math.max(0, (afterLedger?.repeatedSnippetsAvoided ?? 0) - (beforeLedger?.repeatedSnippetsAvoided ?? 0)),
    summary: qualityGatePassed
      ? "Turn passed quality gate."
      : buildTurnFailureSummary({ commandPassed, verificationPassed, missingRequiredTouchedFiles, excludedTouchedFiles, result }),
    metadata: {
      promptHash: sha256(prompt),
      preparedPromptHash: sha256(preparedPrompt),
      commandHash: sha256(command),
      commandExitCode: result.status,
      commandTimedOut: result.timedOut,
      commandSignal: result.signal ?? undefined,
      outputHash: sha256(output),
      expectedFileMentions: expectedMentions,
      changedFiles: changed,
      seedPatchFiles,
      agentTouchedFiles: touched,
      missingRequiredTouchedFiles,
      excludedTouchedFiles,
      verificationExitCode: verification?.status,
      verificationTimedOut: verification?.timedOut,
      ...(usage ? { codexUsage: { ...usage, source: "footer" } } : {}),
      ...primeMetadata
    }
  };
}

function suiteSeedCase(suite: BenchmarkEnduranceSuite): BenchmarkCase {
  return {
    id: `${suite.id}-workspace`,
    mode: "agent",
    task: suite.task,
    expectedFiles: [],
    excludedFiles: [],
    ...(suite.seed ? { seed: suite.seed } : {})
  };
}

function recordTurnLedger(input: {
  runtime: KairnRuntime;
  sessionId: string;
  turn: BenchmarkEnduranceTurn;
  command: string;
  result: ReturnType<typeof runShell>;
  verification?: ReturnType<typeof runShell> | undefined;
  expectedMentions: string[];
  touched: string[];
  output: string;
}): void {
  input.runtime.recordLedgerEvent({
    sessionId: input.sessionId,
    kind: /(?:test|pytest|vitest|jest|mvn|gradle|ctest|go test|cargo test|npm test|pnpm test)/i.test(input.command) ? "test_run" : "command_run",
    turnId: input.turn.id,
    source: "agent",
    summary: `Agent command for endurance turn ${input.turn.id} exited ${input.result.status}.`,
    metadata: {
      commandHash: sha256(input.command),
      exitCode: input.result.status,
      timedOut: input.result.timedOut,
      outputHash: sha256(input.output)
    }
  });
  for (const file of input.expectedMentions) {
    input.runtime.recordLedgerEvent({
      sessionId: input.sessionId,
      kind: "agent_file_mentioned",
      turnId: input.turn.id,
      filePath: file,
      source: "agent",
      summary: `Agent mentioned ${file}.`,
      metadata: { turnId: input.turn.id }
    });
  }
  for (const file of input.touched) {
    input.runtime.recordLedgerEvent({
      sessionId: input.sessionId,
      kind: "agent_file_touched",
      turnId: input.turn.id,
      filePath: file,
      source: "agent",
      summary: `Agent touched ${file}.`,
      metadata: { turnId: input.turn.id }
    });
  }
  const verificationFailed = input.verification ? input.verification.status !== 0 || input.verification.timedOut : false;
  if (input.result.status !== 0 || input.result.timedOut || verificationFailed) {
    input.runtime.recordLedgerEvent({
      sessionId: input.sessionId,
      kind: "failure_seen",
      turnId: input.turn.id,
      source: "agent",
      summary: `Failure observed during endurance turn ${input.turn.id}.`,
      metadata: {
        commandExitCode: input.result.status,
        commandTimedOut: input.result.timedOut,
        verificationExitCode: input.verification?.status,
        verificationTimedOut: input.verification?.timedOut
      }
    });
  }
  if (input.verification) {
    input.runtime.recordLedgerEvent({
      sessionId: input.sessionId,
      kind: input.verification.status === 0 ? "verification_passed" : "verification_failed",
      turnId: input.turn.id,
      source: "bench",
      summary: input.verification.status === 0
        ? `Verification passed for endurance turn ${input.turn.id}.`
        : `Verification failed for endurance turn ${input.turn.id}.`,
      metadata: {
        verificationCommandHash: sha256(input.turn.verificationCommand ?? ""),
        verificationExitCode: input.verification.status,
        verificationTimedOut: input.verification.timedOut
      }
    });
  }
}

function buildEnduranceDeltas(reports: BenchmarkEnduranceModeReport[]): BenchmarkEnduranceReport["deltas"] {
  const baseline = reports.find((report) => report.mode === "baseline");
  const baselineTokens = baseline?.totalObservedCodexTokens;
  const deltas: BenchmarkEnduranceReport["deltas"] = {};
  for (const report of reports.filter((item) => item.mode !== "baseline")) {
    const modeTokens = report.totalObservedCodexTokens;
    const savedTokens = baselineTokens !== undefined && modeTokens !== undefined ? baselineTokens - modeTokens : undefined;
    const savingsRate = savedTokens !== undefined && baselineTokens && baselineTokens > 0 ? savedTokens / baselineTokens : undefined;
    deltas[report.mode] = {
      ...(baselineTokens !== undefined ? { baselineTokens } : {}),
      ...(modeTokens !== undefined ? { modeTokens } : {}),
      ...(savedTokens !== undefined ? { savedTokens } : {}),
      ...(savingsRate !== undefined ? { savingsRate } : {}),
      qualityGatePassed: report.qualityGatePassed,
      ...(savedTokens !== undefined && report.qualityGatePassed && savedTokens > 0 ? { validSavings: savedTokens } : {}),
      ...(savedTokens !== undefined && !report.qualityGatePassed && savedTokens > 0 ? { invalidSavings: savedTokens } : {})
    };
  }
  return deltas;
}

function buildEnduranceRecommendations(reports: BenchmarkEnduranceModeReport[]): string[] {
  const recommendations: string[] = [];
  for (const report of reports) {
    if (!report.qualityGatePassed) {
      recommendations.push(`${report.mode}: quality gate failed; do not claim token savings for this mode.`);
    }
    if ((report.ledger?.repeatedFilesAvoided ?? 0) > 0) {
      recommendations.push(`${report.mode}: ledger avoided ${report.ledger?.repeatedFilesAvoided ?? 0} repeated file context event(s).`);
    }
    const repeatedTouches = report.ledger?.repeatedlyTouchedFiles ?? [];
    if (repeatedTouches.length > 0) {
      recommendations.push(`${report.mode}: repeatedly touched files suggest a follow-up focused cleanup context: ${repeatedTouches.slice(0, 3).join(", ")}.`);
    }
  }
  if (recommendations.length === 0) recommendations.push("No endurance-specific issues detected.");
  return uniqueStrings(recommendations);
}

function buildTurnFailureSummary(input: {
  commandPassed: boolean;
  verificationPassed: boolean;
  missingRequiredTouchedFiles: string[];
  excludedTouchedFiles: string[];
  result: ReturnType<typeof runShell>;
}): string {
  if (input.result.timedOut) return "Turn command timed out.";
  if (!input.commandPassed) return `Turn command failed with exit code ${input.result.status}.`;
  if (!input.verificationPassed) return "Turn verification failed.";
  if (input.missingRequiredTouchedFiles.length > 0) {
    return `Turn missed required touched files: ${input.missingRequiredTouchedFiles.join(", ")}.`;
  }
  if (input.excludedTouchedFiles.length > 0) {
    return `Turn touched excluded files: ${input.excludedTouchedFiles.join(", ")}.`;
  }
  return "Turn did not pass the quality gate.";
}

function mentionedExpectedFiles(output: string, expectedFiles: string[]): string[] {
  return expectedFiles.filter((file) => output.includes(file));
}

function benchmarkPathMatches(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizeRelativePath(filePath);
  const normalizedPattern = normalizeRelativePath(pattern);
  return normalizedFile === normalizedPattern ||
    normalizedFile.startsWith(normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`) ||
    normalizedFile.includes(normalizedPattern);
}

function enduranceCommandWithPlaceholders(command: string, input: { prompt: string; root: string; session: string; turn: string }): string {
  return command
    .replaceAll("{prompt}", shellQuote(input.prompt))
    .replaceAll("{root}", shellQuote(input.root))
    .replaceAll("{session}", shellQuote(input.session))
    .replaceAll("{turn}", shellQuote(input.turn));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") output[key] = item;
  }
  return output;
}

function sumDefined(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map(normalizeRelativePath).filter(Boolean))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
