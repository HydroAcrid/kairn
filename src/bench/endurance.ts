import type {
  BenchmarkCase,
  BenchmarkEnduranceModeReport,
  BenchmarkEnduranceReport,
  BenchmarkEnduranceRepeatModeAggregate,
  BenchmarkEnduranceRepeatReport,
  BenchmarkEnduranceSuite,
  BenchmarkEnduranceTurn,
  BenchmarkEnduranceTurnResult,
  BenchmarkDiffScope,
  BenchmarkSourceInvariant,
  BenchmarkAssistClassification,
  BenchmarkTaskOutcome,
  SessionLedgerSummary
} from "../types.js";
import { parseCodexUsageFooter } from "../eval/codexUsage.js";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import { estimateTokens } from "../utils/tokens.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath } from "../utils/paths.js";
import { normalizeHookPayload } from "../watch/normalizeHook.js";
import {
  agentTouchedFiles,
  changedFiles,
  createBenchmarkWorkspace,
  fileHashes,
  runShell,
  runShellWithProcessGroupTimeout
} from "./agent.js";
import { classificationNegativeEvidenceReason, classifyAssistance } from "./assistClassification.js";
import { loadBenchmarkEnduranceSuite } from "./enduranceSuite.js";
import { evaluateDiffScopes, evaluateSourceInvariants } from "./sourceValidation.js";

type EnduranceMode =
  | "baseline"
  | "kairn"
  | "mcp"
  | "hook_full_prime"
  | "kairn_codex_session"
  | "kairn_codex_session_no_governor"
  | "real_mcp_first"
  | "hybrid_mcp_brief";

type EnduranceModeSpec = {
  mode: EnduranceMode;
  command: string;
  setupCommand?: string | undefined;
};

type EnduranceWorkspaceMetrics = {
  kairnSessionCount: number;
  primeEmitted: number;
  primeSuppressed: number;
  hookInvocations: number;
  failureContextUsed: number;
  mcpToolCalls: number;
  mcpFilesReturned: string[];
  mcpReturnedFileCount: number;
};

type BenchmarkEnduranceInput = {
  rootPath: string;
  suitePath: string;
  baselineCommand: string;
  kairnCommand?: string | undefined;
  mcpCommand?: string | undefined;
  hookFullPrimeCommand?: string | undefined;
  hookFullPrimeSetupCommand?: string | undefined;
  kairnCodexSessionCommand?: string | undefined;
  kairnCodexSessionSetupCommand?: string | undefined;
  kairnCodexSessionNoGovernorCommand?: string | undefined;
  kairnCodexSessionNoGovernorSetupCommand?: string | undefined;
  realMcpFirstCommand?: string | undefined;
  realMcpFirstSetupCommand?: string | undefined;
  hybridMcpBriefCommand?: string | undefined;
  hybridMcpBriefSetupCommand?: string | undefined;
  turnTimeoutMs?: number | undefined;
};

export async function runBenchmarkEndurance(input: BenchmarkEnduranceInput): Promise<BenchmarkEnduranceReport> {
  const suite = loadBenchmarkEnduranceSuite({ suitePath: input.suitePath });
  const startedAt = new Date().toISOString();
  const reports: BenchmarkEnduranceModeReport[] = [];
  const modeSpecs: EnduranceModeSpec[] = [
    { mode: "baseline", command: input.baselineCommand },
    ...(input.kairnCommand ? [{ mode: "kairn" as const, command: input.kairnCommand }] : []),
    ...(input.mcpCommand ? [{ mode: "mcp" as const, command: input.mcpCommand }] : []),
    ...(input.hookFullPrimeCommand
      ? [{ mode: "hook_full_prime" as const, command: input.hookFullPrimeCommand, setupCommand: input.hookFullPrimeSetupCommand }]
      : []),
    ...(input.kairnCodexSessionCommand
      ? [{ mode: "kairn_codex_session" as const, command: input.kairnCodexSessionCommand, setupCommand: input.kairnCodexSessionSetupCommand }]
      : []),
    ...(input.kairnCodexSessionNoGovernorCommand
      ? [{ mode: "kairn_codex_session_no_governor" as const, command: input.kairnCodexSessionNoGovernorCommand, setupCommand: input.kairnCodexSessionNoGovernorSetupCommand }]
      : []),
    ...(input.realMcpFirstCommand
      ? [{ mode: "real_mcp_first" as const, command: input.realMcpFirstCommand, setupCommand: input.realMcpFirstSetupCommand }]
      : []),
    ...(input.hybridMcpBriefCommand
      ? [{ mode: "hybrid_mcp_brief" as const, command: input.hybridMcpBriefCommand, setupCommand: input.hybridMcpBriefSetupCommand }]
      : [])
  ];
  for (const spec of modeSpecs) {
    reports.push(await runEnduranceMode({
      rootPath: input.rootPath,
      suite,
      mode: spec.mode,
      command: spec.command,
      setupCommand: spec.setupCommand,
      timeoutMs: input.turnTimeoutMs
    }));
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

export async function runBenchmarkEnduranceRepeats(input: BenchmarkEnduranceInput & {
  repeat?: number | undefined;
}): Promise<BenchmarkEnduranceRepeatReport> {
  const repeat = Math.max(1, Math.floor(input.repeat ?? 1));
  const startedAt = new Date().toISOString();
  const runs: BenchmarkEnduranceReport[] = [];
  for (let index = 0; index < repeat; index += 1) {
    runs.push(await runBenchmarkEndurance(input));
  }
  const suite = runs[0] ?? loadBenchmarkEnduranceSuite({ suitePath: input.suitePath });
  const endedAt = new Date().toISOString();
  const aggregate = buildEnduranceRepeatAggregate(runs);
  return {
    suiteId: "suiteId" in suite ? suite.suiteId : suite.id,
    suiteName: "suiteName" in suite ? suite.suiteName : suite.name,
    repeat,
    startedAt,
    endedAt,
    runs,
    aggregate,
    recommendations: buildEnduranceRepeatRecommendations(aggregate)
  };
}

async function runEnduranceMode(input: {
  rootPath: string;
  suite: BenchmarkEnduranceSuite;
  mode: EnduranceMode;
  command: string;
  setupCommand?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<BenchmarkEnduranceModeReport> {
  const workspace = createBenchmarkWorkspace({
    rootPath: input.rootPath,
    benchmarkCase: suiteSeedCase(input.suite)
  });
  const timeoutMs = input.timeoutMs ?? 180000;
  const needsRuntime =
    input.mode === "kairn" ||
    input.mode === "mcp" ||
    input.mode === "hook_full_prime" ||
    input.mode === "kairn_codex_session" ||
    input.mode === "kairn_codex_session_no_governor" ||
    input.mode === "real_mcp_first" ||
    input.mode === "hybrid_mcp_brief";
  const runtime = needsRuntime ? new KairnRuntime(workspace.workspacePath) : undefined;
  const startedAt = Date.now();
  let sessionId: string | undefined;
  const turnResults: BenchmarkEnduranceTurnResult[] = [];

  try {
    if (runtime) {
      await runtime.init();
      sessionId = (await runtime.startTask(input.suite.task)).session.id;
    }

  const setupStartedAt = Date.now();
    const setupResult = input.setupCommand
      ? await runEnduranceShell(enduranceCommandWithPlaceholders(input.setupCommand, {
          prompt: input.suite.task,
          root: workspace.workspacePath,
          session: sessionId ?? "",
          turn: "setup"
        }), workspace.workspacePath, timeoutMs)
      : undefined;
    const setupElapsedMs = Date.now() - setupStartedAt;
    const setupChangedFiles = setupResult && setupResult.status === 0 && !setupResult.timedOut
      ? changedFiles(workspace.workspacePath)
      : [];
    const setupChangedFileHashes = setupChangedFiles.length > 0
      ? fileHashes(workspace.workspacePath, setupChangedFiles)
      : {};

    if (setupResult && (setupResult.status !== 0 || setupResult.timedOut)) {
      return {
        mode: input.mode,
        workspacePath: workspace.workspacePath,
        ...(sessionId ? { sessionId } : {}),
        turns: [],
        totalResponseTokens: estimateTokens(setupResult.output),
        totalElapsedMs: Date.now() - startedAt,
        qualityGatePassed: false,
        finalVerificationPassed: false,
        assistanceStatus: input.mode === "baseline" ? "none" : "passive_suppressed",
        assistanceActions: {
          emitted: 0,
          shrunk: 0,
          suppressed: 0,
          mcpCalls: 0,
          failureContexts: 0
        },
        metadata: {
          setupCommandHash: sha256(input.setupCommand ?? ""),
          setupExitCode: setupResult.status,
          setupTimedOut: setupResult.timedOut,
          setupElapsedMs,
          setupOutputHash: sha256(setupResult.output),
          setupOutputTokens: estimateTokens(setupResult.output)
        }
      };
    }

    for (const turn of input.suite.turns) {
      turnResults.push(await runEnduranceTurn({
        suite: input.suite,
        turn,
        mode: input.mode,
        command: input.command,
        workspacePath: workspace.workspacePath,
        seedMetadata: workspace.metadata,
        setupChangedFiles,
        setupChangedFileHashes,
        timeoutMs,
        runtime,
        sessionId
      }));
    }

    const finalVerification = input.suite.finalVerificationCommand
      ? await runEnduranceShell(input.suite.finalVerificationCommand, workspace.workspacePath, timeoutMs)
      : undefined;
    const finalSourceInvariantResult = evaluateSourceInvariants({
      rootPath: workspace.workspacePath,
      invariants: input.suite.finalSourceInvariants
    });
    const finalDiffScopeResult = await evaluateDiffScopes({
      rootPath: workspace.workspacePath,
      scopes: input.suite.allowedDiffScopes,
      ignoreFiles: unchangedSetupFiles(workspace.workspacePath, setupChangedFileHashes)
    });
    const finalVerificationCommandPassed = finalVerification ? finalVerification.status === 0 && !finalVerification.timedOut : true;
    const finalVerificationPassed = finalVerificationCommandPassed && finalSourceInvariantResult.passed && finalDiffScopeResult.passed;
    if (runtime && sessionId && (finalVerification || input.suite.finalSourceInvariants || input.suite.allowedDiffScopes)) {
      runtime.recordLedgerEvent({
        sessionId,
        kind: finalVerificationPassed ? "verification_passed" : "verification_failed",
        source: "bench",
        summary: finalVerificationPassed ? "Final endurance verification passed." : "Final endurance verification failed.",
        metadata: {
          finalVerificationCommandHash: sha256(input.suite.finalVerificationCommand ?? ""),
          finalVerificationExitCode: finalVerification?.status,
          finalVerificationOutputHash: sha256(finalVerification?.output ?? ""),
          finalSourceInvariantPassed: finalSourceInvariantResult.passed,
          finalSourceInvariantFailures: finalSourceInvariantResult.failures,
          finalDiffScopePassed: finalDiffScopeResult.passed,
          finalDiffScopeViolations: finalDiffScopeResult.violations
        }
      });
    }
    const ledgerEvents = runtime && sessionId ? runtime.getSessionLedger(sessionId) : [];
    const ledger = runtime && sessionId ? runtime.summarizeSessionLedger(sessionId) : undefined;
    const workspaceMetrics = collectEnduranceWorkspaceMetrics(workspace.workspacePath, runtime);
    const assistanceActions = buildAssistanceActions({
      mode: input.mode,
      turns: turnResults,
      ledgerEvents,
      workspaceMetrics
    });
    const assistanceStatus = classifyEnduranceAssistanceStatus(input.mode, assistanceActions);
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
      assistanceStatus,
      assistanceActions,
      ...(ledger ? { ledger } : {}),
      metadata: {
        finalVerificationCommandPassed,
        finalSourceInvariantPassed: finalSourceInvariantResult.passed,
        finalSourceInvariantFailures: finalSourceInvariantResult.failures,
        finalDiffScopePassed: finalDiffScopeResult.passed,
        finalDiffScopeViolations: finalDiffScopeResult.violations,
        finalChangedFiles: finalDiffScopeResult.changedFiles,
        setupElapsedMs,
        ...(setupResult
          ? {
              setupCommandHash: sha256(input.setupCommand ?? ""),
              setupExitCode: setupResult.status,
              setupTimedOut: setupResult.timedOut,
              setupOutputHash: sha256(setupResult.output),
              setupOutputTokens: estimateTokens(setupResult.output),
              setupChangedFiles
            }
          : {}),
        ...workspaceMetrics,
        mcpReturnedUsefulFileCount: usefulReturnedFileCount(workspaceMetrics.mcpFilesReturned, turnResults),
        mcpObservedTokensPerCall: workspaceMetrics.mcpToolCalls > 0 && turnResults.some((turn) => turn.observedCodexTokens !== undefined)
          ? sumDefined(turnResults.map((turn) => turn.observedCodexTokens)) / workspaceMetrics.mcpToolCalls
          : undefined,
        mcpObservedTokensPerUsefulFile:
          usefulReturnedFileCount(workspaceMetrics.mcpFilesReturned, turnResults) > 0 && turnResults.some((turn) => turn.observedCodexTokens !== undefined)
            ? sumDefined(turnResults.map((turn) => turn.observedCodexTokens)) / usefulReturnedFileCount(workspaceMetrics.mcpFilesReturned, turnResults)
            : undefined
      } as Record<string, unknown>
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
  setupChangedFiles: string[];
  setupChangedFileHashes: Record<string, string>;
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
  } else if (input.runtime && input.sessionId && input.mode === "kairn_codex_session") {
    const hook = await runSessionBoundPromptHook({
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      prompt,
      turnId: input.turn.id,
      budget: input.turn.budget,
      editScopeHints: {
        allowedDiffScopes: input.turn.allowedDiffScopes,
        sourceInvariants: input.turn.sourceInvariants
      }
    });
    primeMetadata = {
      hookSimulated: true,
      hookDeliveredContext: Boolean(hook.content),
      hookDecision: hook.decision,
      primeDecision: hook.decision,
      hookRecommendation: hook.recommendation,
      primeFiles: hook.files,
      hookFiles: hook.files,
      hookOutputTokens: hook.tokenEstimate,
      ...(hook.metadata ? { hookSignalMetadata: hook.metadata } : {})
    };
    preparedPrompt = hook.content
      ? [
          hook.content,
          "",
          "User task:",
          prompt,
          "",
          "This context was delivered by Kairn's session-bound Codex prompt hook. Continue normally and do not reread already-shown files unless they changed or verification fails."
        ].join("\n")
      : prompt;
  } else if (input.runtime && input.sessionId && input.mode === "kairn_codex_session_no_governor") {
    const response = await input.runtime.findContext({
      sessionId: input.sessionId,
      query: prompt,
      requestType: "initial_brief",
      budget: input.turn.budget,
      refreshIndex: false
    });
    primeMetadata = {
      noGovernorAblation: true,
      noGovernorMode: response.mode,
      noGovernorFiles: response.files,
      noGovernorTokenEstimate: response.tokenEstimate,
      noGovernorWarnings: response.warnings,
      primeDecision: "emit",
      primeFiles: response.files,
      primeTokenEstimate: response.tokenEstimate,
      primeEmitted: true
    };
    preparedPrompt = [
      response.content,
      "",
      "User task:",
      prompt,
      "",
      "Use this Kairn context first. This publication ablation intentionally disables suppression and session stop decisions."
    ].join("\n");
  } else if (
    input.runtime &&
    input.sessionId &&
    (input.mode === "mcp" || input.mode === "real_mcp_first" || input.mode === "hybrid_mcp_brief")
  ) {
    const mcpPrompt = buildMcpEndurancePrompt({
      sessionId: input.sessionId,
      prompt,
      ledger: beforeLedger,
      mcpFiles: input.runtime.getCoordinationState(input.sessionId).mcpFiles
    });
    preparedPrompt = mcpPrompt.prompt;
    primeMetadata = {
      mcpGuidance: mcpPrompt.guidance,
      ...(mcpPrompt.knownSource ? { mcpKnownSource: mcpPrompt.knownSource } : {}),
      mcpShouldCallPrepare: mcpPrompt.shouldCallPrepare
    };
  }

  const command = enduranceCommandWithPlaceholders(input.command, {
    prompt: preparedPrompt,
    root: input.workspacePath,
    session: input.sessionId ?? "",
    turn: input.turn.id
  });
  const result = await runEnduranceShell(command, input.workspacePath, input.timeoutMs);
  const verification = input.turn.verificationCommand ? await runEnduranceShell(input.turn.verificationCommand, input.workspacePath, input.timeoutMs) : undefined;
  const output = [result.output, verification?.output].filter(Boolean).join("\n");
  const usage = parseCodexUsageFooter(output);
  const expectedMentions = mentionedExpectedFiles(output, input.turn.expectedFiles);
  const changed = changedFiles(input.workspacePath);
  const seedPatchFiles = uniquePaths([...stringList(input.seedMetadata.seedPatchFiles), ...input.setupChangedFiles]);
  const seedPatchFileHashes = {
    ...stringRecord(input.seedMetadata.seedPatchFileHashes),
    ...input.setupChangedFileHashes
  };
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
  const sourceInvariantResult = evaluateSourceInvariants({
    rootPath: input.workspacePath,
    invariants: input.turn.sourceInvariants
  });
  const diffScopeResult = await evaluateDiffScopes({
    rootPath: input.workspacePath,
    scopes: input.turn.allowedDiffScopes,
    ignoreFiles: unchangedSetupFiles(input.workspacePath, input.setupChangedFileHashes)
  });
  const requiredTouchedSatisfied = missingRequiredTouchedFiles.length === 0;
  const qualityGatePassed =
    commandPassed &&
    verificationPassed &&
    requiredTouchedSatisfied &&
    excludedTouchedFiles.length === 0 &&
    sourceInvariantResult.passed &&
    diffScopeResult.passed;
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
      output,
      qualityGatePassed,
      sourceInvariantChecked: Boolean(input.turn.sourceInvariants?.length),
      sourceInvariantFiles: uniquePaths((input.turn.sourceInvariants ?? []).map((invariant) => invariant.file)),
      sourceInvariantPassed: sourceInvariantResult.passed,
      sourceInvariantFailures: sourceInvariantResult.failures,
      diffScopeChecked: Boolean(input.turn.allowedDiffScopes?.length),
      diffScopePassed: diffScopeResult.passed,
      diffScopeViolations: diffScopeResult.violations
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
      : buildTurnFailureSummary({
          commandPassed,
          verificationPassed,
          missingRequiredTouchedFiles,
          excludedTouchedFiles,
          sourceInvariantFailures: sourceInvariantResult.failures,
          diffScopeViolations: diffScopeResult.violations,
          result
        }),
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
      sourceInvariantPassed: sourceInvariantResult.passed,
      sourceInvariantFailures: sourceInvariantResult.failures,
      diffScopePassed: diffScopeResult.passed,
      diffScopeViolations: diffScopeResult.violations,
      diffScopeChangedFiles: diffScopeResult.changedFiles,
      ...(usage ? { codexUsage: { ...usage, source: "footer" } } : {}),
      ...primeMetadata
    }
  };
}

function buildMcpEndurancePrompt(input: {
  sessionId: string;
  prompt: string;
  ledger?: SessionLedgerSummary | undefined;
  mcpFiles?: string[] | undefined;
}): {
  prompt: string;
  guidance: "prepare_first" | "continue_known_source" | "failure_gateway" | "obvious_single_source_abstain";
  shouldCallPrepare: boolean;
  knownSource?: string | undefined;
} {
  const knownSource = firstKnownSource(input.ledger, input.mcpFiles);
  const invariant = enduranceInvariantForPrompt(input.ledger?.workingSet.currentInvariant?.statement, input.prompt);
  const unresolvedFailures = (input.ledger?.unresolvedFailures ?? 0) > 0;
  const taskLooksFailureDriven = /\b(fail|failing|failure|error|exception|stack trace|traceback)\b/i.test(input.prompt);
  if (knownSource && (unresolvedFailures || taskLooksFailureDriven)) {
    return {
      guidance: "failure_gateway",
      shouldCallPrepare: false,
      knownSource,
      prompt: [
        "Kairn long-session instruction:",
        `Use Kairn session ${input.sessionId}.`,
        `Known active source: ${knownSource}.`,
        invariant ? `Known invariant: ${invariant}` : undefined,
        ...mcpSourceOnlyScopeLines(knownSource),
        "Do not call kairn_prepare_task for this turn; source discovery is already complete.",
        "If there is concrete failure output, call kairn_get_failure_context once with that output. Otherwise continue from the known source and run the smallest check.",
        "Do not call kairn_get_next_context unless the failure context explicitly asks for it.",
        "",
        "User task:",
        input.prompt
      ].filter(Boolean).join("\n")
    };
  }
  if (knownSource) {
    return {
      guidance: "continue_known_source",
      shouldCallPrepare: false,
      knownSource,
      prompt: [
        `Kairn session ${input.sessionId}: source already found.`,
        `Source: ${knownSource}.`,
        invariant ? `Invariant: ${invariant}` : undefined,
        ...mcpSourceOnlyScopeLines(knownSource),
        "Do not call Kairn again unless a real check fails or the target changes.",
        "Do not run broad repo search or reread unrelated files; for repeat, cleanup, or diff-review turns, answer from the known source/current diff in a short bounded response.",
        "",
        "User task:",
        input.prompt
      ].filter(Boolean).join("\n")
    };
  }
  if (isLikelyObviousSingleSourcePrompt(input.prompt)) {
    return {
      guidance: "obvious_single_source_abstain",
      shouldCallPrepare: false,
      prompt: [
        "Kairn long-session instruction:",
        `Use Kairn session ${input.sessionId}.`,
        "This looks like a short single-source symbol task.",
        "Do not call Kairn on this turn unless your first local source guess fails, a concrete check fails, or the task target broadens.",
        "",
        "User task:",
        input.prompt
      ].join("\n")
    };
  }
  return {
    guidance: "prepare_first",
    shouldCallPrepare: true,
    prompt: [
      "Kairn long-session instruction:",
      `Use Kairn session ${input.sessionId}.`,
      "No active source has been established yet. For this diagnose/source-rescue turn, call kairn_prepare_task once before manual source reads.",
      "For an obvious single-source symbol task, inspect the likely source directly and do not call Kairn just to confirm it.",
      "If it returns stopCondition or no nextToolCalls, continue from its files and do not call more Kairn unless a check fails or the target changes.",
      "Obey Kairn's edit-scope guidance: tests, docs, examples, fixtures, snapshots, generated files, and vendor/dependency files are read-only unless a focused verification failure proves they must change.",
      "Only call kairn_get_next_context when prepare explicitly returns it; call kairn_get_failure_context once after real failures.",
      "Prefer the smallest Kairn-provided source read and avoid repeating files already shown by Kairn.",
      "",
      "User task:",
      input.prompt
    ].join("\n")
  };
}

function mcpSourceOnlyScopeLines(sourceFile: string): string[] {
  return [
    `Edit scope: ${sourceFile} only unless a focused verification failure names another production source file.`,
    "Treat tests, docs, examples, fixtures, snapshots, generated files, and vendor/dependency files as read-only unless the user explicitly asks to edit them or verification proves expected-output drift.",
    "If any out-of-scope file changed while exploring, revert it before finalizing."
  ];
}

export function enduranceInvariantForPrompt(ledgerInvariant: string | undefined, prompt: string): string | undefined {
  const cleaned = cleanEnduranceInvariant(ledgerInvariant);
  if (cleaned && !isWeakEnduranceInvariant(cleaned)) return cleaned;
  return extractPromptInvariant(prompt);
}

function cleanEnduranceInvariant(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/\s+/g, " ")
    .replace(/^[\s,;:.!?-]+/, "")
    .trim();
  return cleaned || undefined;
}

function isWeakEnduranceInvariant(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.length < 12 ||
    /^\b(debug|fix|verify|preserve)\b(?:,|\s+and|\s)/i.test(value) ||
    /\bdebug,\s*fix,\s*verify\b/.test(normalized) ||
    /\bacross\s+(?:ten|\d+)\s+turns\b/.test(normalized)
  );
}

function extractPromptInvariant(prompt: string): string | undefined {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const explicit = normalized.match(/\binvariant\s+is\s+that\s+(.+?)(?:\s+(?:do not|don't|dont|then|if|use|keep|run)\b|$)/i)?.[1]?.trim();
  if (explicit) return sentenceCaseInvariant(ensureTerminalPeriod(explicit));

  const behaviorSentence = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => /\b(must|should|preserve|requires?|ensure)\b/i.test(sentence) && !isWeakEnduranceInvariant(sentence));
  return behaviorSentence ? sentenceCaseInvariant(behaviorSentence) : undefined;
}

function sentenceCaseInvariant(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").replace(/^[\s,;:.!?-]+/, "").trim();
  if (!cleaned) return value;
  return cleaned[0]!.toUpperCase() + cleaned.slice(1);
}

function ensureTerminalPeriod(value: string): string {
  const cleaned = value.trim();
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

async function runSessionBoundPromptHook(input: {
  runtime: KairnRuntime;
  workspacePath: string;
  sessionId: string;
  prompt: string;
  turnId: string;
  budget?: number | undefined;
  editScopeHints?: {
    allowedDiffScopes?: BenchmarkDiffScope[] | undefined;
    sourceInvariants?: BenchmarkSourceInvariant[] | undefined;
  } | undefined;
}): Promise<{
  content?: string | undefined;
  decision?: string | undefined;
  recommendation?: string | undefined;
  files: string[];
  tokenEstimate: number;
  metadata?: Record<string, unknown> | undefined;
}> {
  const event = normalizeHookPayload({
    source: "codex",
    payload: {
      cwd: input.workspacePath,
      hook_event_name: "UserPromptSubmit",
      session_id: input.sessionId,
      turn_id: input.turnId,
      prompt: input.prompt,
      enduranceMode: "kairn_codex_session",
      simulatedByBenchmark: true
    }
  });
  const result = await input.runtime.handleHookEvent({
    sessionId: input.sessionId,
    event,
    primeBudget: input.budget,
    hookOutput: "full-prime",
    refreshIndex: false,
    editScopeHints: input.editScopeHints
  });
  const content =
    result.prime?.content ??
    result.recommendation?.content ??
    result.failureContext?.content ??
    result.response?.content;
  const files = uniquePaths([
    ...(result.prime?.files ?? []),
    ...(result.recommendation?.files ?? []),
    ...(result.failureContext?.files ?? []),
    ...(result.response?.files ?? [])
  ]);
  const metadata = latestHookSignalMetadata(input.runtime, input.sessionId);
  return {
    ...(content?.trim() ? { content } : {}),
    decision: stringMetadata(metadata, "decision"),
    recommendation: stringMetadata(metadata, "recommendation"),
    files,
    tokenEstimate: content ? estimateTokens(content) : 0,
    ...(metadata ? { metadata } : {})
  };
}

function latestHookSignalMetadata(runtime: KairnRuntime, sessionId: string): Record<string, unknown> | undefined {
  const metrics = runtime.getMetrics(sessionId);
  const event = [...metrics.recentEvents].reverse().find((item) => item.eventKind === "hook_signal");
  return recordValue(event?.metadata);
}

function isLikelyObviousSingleSourcePrompt(prompt: string): boolean {
  if (prompt.length > 260) return false;
  if (/\b(diagnose|investigate|audit|trace)\b/i.test(prompt)) return false;
  if (/\b(multi[-\s]?file|multiple files|across files|across modules|integration|workflow|end-to-end|e2e|stack trace|traceback|selected tests|requirements:|production source|source fix|smallest production)\b/i.test(prompt)) {
    return false;
  }
  if (!/\b(debug|diagnose|fix|repair|regression|bug|verify)\b/i.test(prompt)) return false;
  return /\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\b/.test(prompt) ||
    /\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/.test(prompt);
}

function firstKnownSource(ledger?: SessionLedgerSummary | undefined, mcpFiles: string[] = []): string | undefined {
  if (!ledger) return undefined;
  const nextRead = ledger.workingSet.nextSmallestUsefulRead;
  return [
    ...mcpFiles,
    ledger.workingSet.currentInvariant?.filePath,
    ...ledger.workingSet.recentlyTouchedFiles,
    ...ledger.workingSet.activeFiles,
    ...ledger.shownFiles,
    nextRead && nextRead.source !== "ignored_recommendation" ? nextRead.filePath : undefined
  ].find(isLikelyBenchmarkSource);
}

function collectEnduranceWorkspaceMetrics(workspacePath: string, runtime?: KairnRuntime | undefined): EnduranceWorkspaceMetrics {
  const ownsRuntime = !runtime;
  const activeRuntime = runtime ?? new KairnRuntime(workspacePath);
  try {
    const sessions = activeRuntime.listSessions({ allRoots: true });
    const summaries = sessions.map((session) => activeRuntime.getMetrics(session.id));
    const recentEvents = summaries.flatMap((summary) => summary.recentEvents);
    const hookSignals = recentEvents.filter((event) => event.eventKind === "hook_signal");
    const mcpFilesReturned = uniquePaths(
      recentEvents
        .filter((event) => event.eventKind === "mcp_tool_call")
        .flatMap((event) => event.files)
    );
    return {
      kairnSessionCount: sessions.length,
      primeEmitted: hookSignals.filter((event) => event.metadata.primeContextDelivered === true).length,
      primeSuppressed: hookSignals.filter((event) => event.metadata.primeSuppressed === true).length,
      hookInvocations: summaries.reduce((total, summary) => total + (summary.byKind.hook_signal?.events ?? 0), 0),
      failureContextUsed: summaries.reduce((total, summary) => total + (summary.byKind.failure_context?.events ?? 0), 0),
      mcpToolCalls: summaries.reduce((total, summary) => total + (summary.byKind.mcp_tool_call?.events ?? 0), 0),
      mcpFilesReturned,
      mcpReturnedFileCount: mcpFilesReturned.length
    };
  } catch {
    return {
      kairnSessionCount: 0,
      primeEmitted: 0,
      primeSuppressed: 0,
      hookInvocations: 0,
      failureContextUsed: 0,
      mcpToolCalls: 0,
      mcpFilesReturned: [],
      mcpReturnedFileCount: 0
    };
  } finally {
    if (ownsRuntime) {
      activeRuntime.close();
    }
  }
}

function usefulReturnedFileCount(files: string[], turns: BenchmarkEnduranceTurnResult[]): number {
  const usefulFiles = new Set(
    turns.flatMap((turn) => [
      ...turn.actualFiles,
      ...turn.expectedFiles,
      ...turn.agentTouchedFiles
    ])
  );
  return uniquePaths(files).filter((file) => usefulFiles.has(file)).length;
}

function isLikelyBenchmarkSource(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  if (!/\.(?:[cm]?[jt]sx?|py|java|go|rs|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(filePath)) return false;
  return !/(^|\/)(?:test|tests|testing|__tests__|spec|specs|docs|examples|fixtures|generated|gen|codemods|devtools)(?:\/|$)/i.test(filePath);
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
  qualityGatePassed: boolean;
  sourceInvariantChecked: boolean;
  sourceInvariantFiles: string[];
  sourceInvariantPassed: boolean;
  sourceInvariantFailures: string[];
  diffScopeChecked: boolean;
  diffScopePassed: boolean;
  diffScopeViolations: string[];
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
  for (const file of input.touched) {
    input.runtime.recordLedgerEvent({
      sessionId: input.sessionId,
      kind: "diff_seen",
      turnId: input.turn.id,
      filePath: file,
      source: "agent",
      summary: `Diff touched ${file} during endurance turn ${input.turn.id}.`,
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
  const semanticVerificationChecked = input.sourceInvariantChecked || input.diffScopeChecked;
  if (input.verification || semanticVerificationChecked) {
    const verificationPassed =
      (input.verification ? input.verification.status === 0 && !input.verification.timedOut : true) &&
      (!input.sourceInvariantChecked || input.sourceInvariantPassed) &&
      (!input.diffScopeChecked || input.diffScopePassed);
    input.runtime.recordLedgerEvent({
      sessionId: input.sessionId,
      kind: verificationPassed ? "verification_passed" : "verification_failed",
      turnId: input.turn.id,
      source: "bench",
      filePath: input.sourceInvariantFiles[0] ?? input.touched[0] ?? input.expectedMentions[0],
      summary: verificationPassed
        ? `Verification passed for endurance turn ${input.turn.id}.`
        : `Verification failed for endurance turn ${input.turn.id}.`,
      metadata: {
        verificationCommandHash: sha256(input.turn.verificationCommand ?? ""),
        verificationExitCode: input.verification?.status,
        verificationTimedOut: input.verification?.timedOut,
        sourceInvariantChecked: input.sourceInvariantChecked,
        sourceInvariantPassed: input.sourceInvariantPassed,
        sourceInvariantFailures: input.sourceInvariantFailures,
        diffScopeChecked: input.diffScopeChecked,
        diffScopePassed: input.diffScopePassed,
        diffScopeViolations: input.diffScopeViolations,
        qualityGatePassed: input.qualityGatePassed
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
    const classification = classifyAssistance({
      assistanceStatus: report.assistanceStatus,
      qualityGatePassed: report.qualityGatePassed,
      savedTokens,
      baselineTokens,
      baselineQualityGatePassed: baseline?.qualityGatePassed,
      turnCount: baseline?.turns.length
    });
    const assistanceEligible = enduranceUsefulAssistanceEligible(report, classification.assistanceEligible);
    const qualityFailureReason = enduranceQualityFailureReason(report);
    const negativeEvidenceReason =
      classificationNegativeEvidenceReason({ classification, qualityFailureReason }) ??
      enduranceNegativeEvidenceReason({ report, savedTokens, assistanceEligible });
    const assistClassification = assistanceEligible || !classification.assistanceEligible
      ? classification.assistClassification
      : savedTokens !== undefined && savedTokens <= 0
        ? "over_assist"
        : "neutral";
    deltas[report.mode] = {
      ...(baselineTokens !== undefined ? { baselineTokens } : {}),
      ...(modeTokens !== undefined ? { modeTokens } : {}),
      ...(savedTokens !== undefined ? { savedTokens } : {}),
      ...(savingsRate !== undefined ? { savingsRate } : {}),
      qualityGatePassed: report.qualityGatePassed,
      assistanceStatus: report.assistanceStatus,
      assistanceEligible,
      baselineDifficulty: classification.baselineDifficulty,
      ...(classification.baselineTokenCost !== undefined ? { baselineTokenCost: classification.baselineTokenCost } : {}),
      abstentionOutcome: classification.abstentionOutcome,
      missedOpportunity: classification.missedOpportunity,
      overAssist: classification.overAssist,
      harmfulAssist: classification.harmfulAssist,
      assistClassification,
      ...(savedTokens !== undefined && report.qualityGatePassed && assistanceEligible && savedTokens > 0 ? { validSavings: savedTokens } : {}),
      ...(savedTokens !== undefined && (!report.qualityGatePassed || (classification.assistanceEligible && !assistanceEligible)) && savedTokens > 0 ? { invalidSavings: savedTokens } : {}),
      ...(savedTokens !== undefined && report.qualityGatePassed && !classification.assistanceEligible && savedTokens > 0 ? { passiveSavings: savedTokens } : {}),
      ...(negativeEvidenceReason ? { negativeEvidenceReason } : {})
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
    if (report.mode !== "baseline" && report.assistanceStatus !== "active") {
      recommendations.push(`${report.mode}: Kairn was ${report.assistanceStatus}; any lower token usage is passive evidence, not valid Kairn-assisted savings.`);
    }
    if ((report.ledger?.repeatedFilesAvoided ?? 0) > 0) {
      recommendations.push(`${report.mode}: ledger avoided ${report.ledger?.repeatedFilesAvoided ?? 0} repeated file context event(s).`);
    }
    if (report.assistanceStatus === "active" && report.ledger?.workingSet.nextSmallestUsefulRead) {
      recommendations.push(`${report.mode}: working set next read is ${report.ledger.workingSet.nextSmallestUsefulRead.filePath}.`);
    }
    if ((report.ledger?.workingSet.openRisks.length ?? 0) > 0) {
      recommendations.push(`${report.mode}: open working-set risks: ${report.ledger?.workingSet.openRisks.slice(0, 2).join("; ")}.`);
    }
    const repeatedTouches = report.ledger?.repeatedlyTouchedFiles ?? [];
    if (repeatedTouches.length > 0) {
      recommendations.push(`${report.mode}: repeatedly touched files suggest a follow-up focused cleanup context: ${repeatedTouches.slice(0, 3).join(", ")}.`);
    }
  }
  if (recommendations.length === 0) recommendations.push("No endurance-specific issues detected.");
  return uniqueStrings(recommendations);
}

function buildEnduranceRepeatAggregate(runs: BenchmarkEnduranceReport[]): BenchmarkEnduranceRepeatReport["aggregate"] {
  const modes = uniqueStrings(runs.flatMap((run) => run.reports.map((report) => report.mode))) as EnduranceMode[];
  const aggregate: BenchmarkEnduranceRepeatReport["aggregate"] = {};
  for (const mode of modes) {
    const modeReports = runs.flatMap((run) => run.reports.filter((report) => report.mode === mode));
    const modeDeltas = runs.flatMap((run) => {
      const delta = run.deltas[mode];
      return delta ? [delta] : [];
    });
    const tokens = modeReports
      .map((report) => report.totalObservedCodexTokens)
      .filter((value): value is number => typeof value === "number");
    const savedTokens = modeDeltas
      .map((delta) => delta.savedTokens)
      .filter((value): value is number => typeof value === "number");
    const savingsRates = modeDeltas
      .map((delta) => delta.savingsRate)
      .filter((value): value is number => typeof value === "number");
    const classifications = countRepeatClassifications(modeDeltas.map((delta) => delta.assistClassification));
    const repeatedFilesAvoided = modeReports.reduce((total, report) => {
      return total + report.turns.reduce((turnTotal, turn) => turnTotal + turn.repeatedFilesAvoided, 0);
    }, 0);
    const repeatedSnippetsAvoided = modeReports.reduce((total, report) => {
      return total + report.turns.reduce((turnTotal, turn) => turnTotal + turn.repeatedSnippetsAvoided, 0);
    }, 0);
    const scopeViolations = modeReports.reduce((total, report) => {
      const finalViolations = stringArrayMetadata(report.metadata?.finalDiffScopeViolations).length;
      const turnViolations = report.turns.reduce((turnTotal, turn) => {
        return turnTotal + stringArrayMetadata(turn.metadata.diffScopeViolations).length;
      }, 0);
      return total + finalViolations + turnViolations;
    }, 0);
    const summary: BenchmarkEnduranceRepeatModeAggregate = {
      mode,
      repeats: modeReports.length,
      qualityPasses: modeReports.filter((report) => report.qualityGatePassed).length,
      activeRuns: modeReports.filter((report) => report.assistanceStatus === "active").length,
      passiveSuppressedRuns: modeReports.filter((report) => report.assistanceStatus === "passive_suppressed").length,
      ...(tokens.length > 0 ? { medianObservedCodexTokens: medianNumber(tokens), meanObservedCodexTokens: meanNumber(tokens) } : {}),
      ...(savedTokens.length > 0 ? { medianSavedTokens: medianNumber(savedTokens) } : {}),
      ...(savingsRates.length > 0 ? { medianSavingsRate: medianNumber(savingsRates) } : {}),
      validSavingsRuns: modeDeltas.filter((delta) => (delta.validSavings ?? 0) > 0).length,
      overAssistRuns: modeDeltas.filter((delta) => delta.overAssist).length,
      harmfulRuns: modeDeltas.filter((delta) => delta.harmfulAssist).length,
      missedOpportunityRuns: modeDeltas.filter((delta) => delta.missedOpportunity).length,
      correctAbstentionRuns: modeDeltas.filter((delta) => delta.assistClassification === "correct_abstention").length,
      mcpCalls: modeReports.reduce((total, report) => total + report.assistanceActions.mcpCalls, 0),
      mcpReturnedFileCount: modeReports.reduce((total, report) => total + numberMetadata(report.metadata?.mcpReturnedFileCount), 0),
      mcpReturnedUsefulFileCount: modeReports.reduce((total, report) => total + numberMetadata(report.metadata?.mcpReturnedUsefulFileCount), 0),
      repeatedFilesAvoided,
      repeatedSnippetsAvoided,
      scopeViolations,
      classifications,
      verdict: "insufficient_data"
    };
    summary.verdict = repeatVerdict(summary);
    aggregate[mode] = summary;
  }
  return aggregate;
}

function repeatVerdict(summary: Omit<BenchmarkEnduranceRepeatModeAggregate, "verdict">): BenchmarkEnduranceRepeatModeAggregate["verdict"] {
  if (summary.mode === "baseline") return "baseline";
  if (summary.repeats === 0 || summary.qualityPasses === 0) return "insufficient_data";
  if (summary.harmfulRuns > 0 || summary.qualityPasses < summary.repeats) return "quality_risk";
  const threshold = Math.ceil(summary.repeats * 0.67);
  if (summary.validSavingsRuns >= threshold && summary.overAssistRuns === 0) return "consistent_win";
  if (summary.overAssistRuns >= threshold) return "consistent_loss";
  if (summary.activeRuns === 0 && summary.passiveSuppressedRuns > 0) return "passive_only";
  return "mixed";
}

function buildEnduranceRepeatRecommendations(
  aggregate: BenchmarkEnduranceRepeatReport["aggregate"]
): string[] {
  const recommendations: string[] = [];
  for (const summary of Object.values(aggregate)) {
    if (summary.mode === "baseline") continue;
    if (summary.verdict === "consistent_win") {
      recommendations.push(`${summary.mode}: repeat evidence is positive; median savings ${formatPercent(summary.medianSavingsRate)}.`);
    } else if (summary.verdict === "consistent_loss") {
      recommendations.push(`${summary.mode}: repeat evidence shows over-assist; keep this mode guarded or quieter.`);
    } else if (summary.verdict === "quality_risk") {
      recommendations.push(`${summary.mode}: quality risk detected; do not claim savings until failures are resolved.`);
    } else if (summary.verdict === "passive_only") {
      recommendations.push(`${summary.mode}: Kairn stayed passive; useful as abstention evidence, not active savings.`);
    } else if (summary.missedOpportunityRuns > 0) {
      recommendations.push(`${summary.mode}: missed ${summary.missedOpportunityRuns}/${summary.repeats} savings opportunities; improve activation confidence.`);
    } else {
      recommendations.push(`${summary.mode}: mixed repeat evidence; collect more holdout runs before tuning.`);
    }
  }
  return recommendations.length > 0 ? uniqueStrings(recommendations) : ["No repeat-level endurance issues detected."];
}

function countRepeatClassifications(values: BenchmarkAssistClassification[]): Partial<Record<BenchmarkAssistClassification, number>> {
  const counts: Partial<Record<BenchmarkAssistClassification, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function medianNumber(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function meanNumber(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function numberMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArrayMetadata(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(value * 10_000) / 100}%`;
}

function buildAssistanceActions(input: {
  mode: EnduranceMode;
  turns: BenchmarkEnduranceTurnResult[];
  ledgerEvents: ReturnType<KairnRuntime["getSessionLedger"]>;
  workspaceMetrics: EnduranceWorkspaceMetrics;
}): BenchmarkEnduranceModeReport["assistanceActions"] {
  if (input.mode === "baseline") {
    return {
      emitted: 0,
      shrunk: 0,
      suppressed: 0,
      mcpCalls: 0,
      failureContexts: 0
    };
  }
  const decisions = input.turns.map((turn) => typeof turn.metadata.primeDecision === "string" ? turn.metadata.primeDecision : "");
  const mcpCalls = input.workspaceMetrics.mcpToolCalls;
  const failureContexts = input.ledgerEvents.filter(
    (event) => event.kind === "context_shown" && event.metadata.policyReason === "failure_reemitted"
  ).length;
  return {
    emitted: decisions.filter((decision) => decision === "emit").length + input.workspaceMetrics.primeEmitted,
    shrunk: decisions.filter((decision) => decision === "shrink").length,
    suppressed: decisions.filter((decision) => decision === "suppress").length + input.workspaceMetrics.primeSuppressed,
    mcpCalls,
    failureContexts: failureContexts + input.workspaceMetrics.failureContextUsed
  };
}

function classifyEnduranceAssistanceStatus(
  mode: EnduranceMode,
  actions: BenchmarkEnduranceModeReport["assistanceActions"]
): BenchmarkEnduranceModeReport["assistanceStatus"] {
  if (mode === "baseline") return "none";
  if (actions.emitted > 0 || actions.shrunk > 0 || actions.mcpCalls > 0 || actions.failureContexts > 0) return "active";
  return "passive_suppressed";
}

function enduranceUsefulAssistanceEligible(report: BenchmarkEnduranceModeReport, baseEligible: boolean): boolean {
  if (!baseEligible) return false;
  const mcpOnly =
    (report.mode === "mcp" || report.mode === "real_mcp_first") &&
    report.assistanceActions.mcpCalls > 0 &&
    report.assistanceActions.emitted === 0 &&
    report.assistanceActions.shrunk === 0;
  if (!mcpOnly) return true;
  const usefulMcpFiles = typeof report.metadata?.mcpReturnedUsefulFileCount === "number"
    ? report.metadata.mcpReturnedUsefulFileCount
    : 0;
  return usefulMcpFiles > 0;
}

function enduranceNegativeEvidenceReason(input: {
  report: BenchmarkEnduranceModeReport;
  savedTokens: number | undefined;
  assistanceEligible: boolean;
}): string | undefined {
  if (input.savedTokens === undefined || input.savedTokens <= 0) return undefined;
  if (!input.report.qualityGatePassed) return "Token reduction is invalid because the endurance quality gate failed.";
  if (input.report.assistanceStatus === "active" && !input.assistanceEligible) {
    return "Token reduction is invalid because active MCP did not return an expected or later-used source file.";
  }
  if (!input.assistanceEligible) return "Token reduction is passive evidence because Kairn emitted no useful context, MCP call, or failure context.";
  return undefined;
}

function enduranceQualityFailureReason(report: BenchmarkEnduranceModeReport): string | undefined {
  if (report.qualityGatePassed) return undefined;
  if (!report.finalVerificationPassed) return "Final endurance verification failed.";
  const failedTurn = report.turns.find((turn) => !turn.qualityGatePassed);
  return failedTurn ? `${failedTurn.turnId}: ${failedTurn.summary}` : "Endurance quality gate failed.";
}

function buildTurnFailureSummary(input: {
  commandPassed: boolean;
  verificationPassed: boolean;
  missingRequiredTouchedFiles: string[];
  excludedTouchedFiles: string[];
  sourceInvariantFailures: string[];
  diffScopeViolations: string[];
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
  if (input.sourceInvariantFailures.length > 0) {
    return `Turn source invariant failed: ${input.sourceInvariantFailures.slice(0, 2).join("; ")}.`;
  }
  if (input.diffScopeViolations.length > 0) {
    return `Turn changed outside allowed diff scope: ${input.diffScopeViolations.slice(0, 2).join("; ")}.`;
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

async function runEnduranceShell(command: string, cwd: string, timeoutMs: number): Promise<{ status: number; output: string; timedOut: boolean; signal?: NodeJS.Signals | null }> {
  const result = await runShellWithProcessGroupTimeout(command, cwd, timeoutMs, 16 * 1024 * 1024);
  return {
    status: result.status ?? 1,
    output: result.output,
    timedOut: result.timedOut,
    ...(result.signal !== undefined ? { signal: result.signal } : {})
  };
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function sumDefined(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map(normalizeRelativePath).filter(Boolean))];
}

function unchangedSetupFiles(workspacePath: string, setupChangedFileHashes: Record<string, string>): string[] {
  const files = Object.keys(setupChangedFileHashes);
  if (files.length === 0) return [];
  const current = fileHashes(workspacePath, files);
  return files.filter((file) => current[file] === setupChangedFileHashes[file]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
