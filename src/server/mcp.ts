import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import type { OutputKind } from "../types.js";

const outputKindSchema = z.enum(["test", "lint", "typecheck", "generic"]);
const contextModeSchema = z.enum(["brief", "snippets", "summary", "exact"]);
const primeProfileSchema = z.enum(["auto", "ui", "workflow", "backend", "test", "failure_debug", "generic"]);
const prepareDetailSchema = z.enum(["compact", "full"]);

export async function startMcpServer(options: { root?: string }): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}

export function createMcpServer(options: { root?: string }): McpServer {
  const server = new McpServer({
    name: "kairn",
    version: "0.1.0"
  });

  const runtime = new KairnRuntime(options.root);

  server.registerTool(
    "kairn_prepare_task",
    {
      title: "Prepare Kairn task",
      description: "Start or reuse a task session and return proactive context plus recommended next Kairn tool calls.",
      inputSchema: {
        task: z.string().min(1),
        sessionId: z.string().optional(),
        budget: z.number().int().positive().optional(),
        profile: primeProfileSchema.optional(),
        detail: prepareDetailSchema.optional()
      }
    },
    async ({ task, sessionId, budget, profile, detail }) => {
      const prime = await runtime.primeContext({ task, sessionId, budget: budget ?? 900, profile, source: "mcp" });
      const value = (detail ?? "compact") === "full" ? fullPrepareResult(prime) : compactPrepareResult(runtime, prime);
      return mcpToolResult(runtime, "kairn_prepare_task", { task, sessionId, budget, profile, detail }, value);
    }
  );

  server.registerTool(
    "kairn_start_task",
    {
      title: "Start Kairn task",
      description: "Start a Kairn task session for the target repo.",
      inputSchema: {
        task: z.string().min(1)
      }
    },
    async ({ task }) => mcpToolResult(runtime, "kairn_start_task", { task }, await runtime.startTask(task))
  );

  server.registerTool(
    "kairn_find_context",
    {
      title: "Find context",
      description: "Find high-confidence files for the active task or query.",
      inputSchema: {
        sessionId: z.string().min(1),
        query: z.string().optional(),
        mode: contextModeSchema.optional(),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, query, mode, budget }) => {
      const exactSourceFile = mcpExactSourceFile(runtime, sessionId);
      const value = exactSourceFile
        ? runtime.focusedExactSourceContext({
            sessionId,
            file: exactSourceFile,
            budget,
            alreadyReturned: runtime.getCoordinationState(sessionId).mcpFiles.includes(exactSourceFile),
            reason: "Kairn already found an exact source hit; find_context is staying focused instead of reopening broad retrieval."
          })
        : await runtime.findContext({ sessionId, query, mode, requestType: "find_context", budget });
      return mcpToolResult(
        runtime,
        "kairn_find_context",
        { sessionId, query, mode, budget },
        value
      );
    }
  );

  server.registerTool(
    "kairn_read_file",
    {
      title: "Read file",
      description: "Read exact source or compressed context for a file.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().min(1),
        mode: z.enum(["exact", "summary"]).optional(),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, target, mode, budget }) =>
      mcpToolResult(runtime, "kairn_read_file", { sessionId, target, mode, budget }, await runtime.readFile({ sessionId, target, mode, budget }))
  );

  server.registerTool(
    "kairn_read_symbol",
    {
      title: "Read symbol",
      description: "Read a symbol from a file with the lightweight V1 extractor.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().min(1),
        symbol: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, target, symbol, budget }) =>
      mcpToolResult(
        runtime,
        "kairn_read_symbol",
        { sessionId, target, symbol, budget },
        await runtime.readSymbol({ sessionId, target, symbol, budget })
      )
  );

  server.registerTool(
    "kairn_get_related_files",
    {
      title: "Get related files",
      description: "Find related files with deterministic import/path/test heuristics.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, target, budget }) => {
      const exactSourceFile = mcpExactSourceFile(runtime, sessionId);
      const value = exactSourceFile
        ? runtime.focusedExactSourceContext({
            sessionId,
            file: exactSourceFile,
            budget,
            alreadyReturned: runtime.getCoordinationState(sessionId).mcpFiles.includes(exactSourceFile),
            reason: "Kairn already found an exact source hit; related-file expansion is intentionally skipped."
          })
        : await runtime.getRelatedFiles({ sessionId, target, budget });
      return mcpToolResult(runtime, "kairn_get_related_files", { sessionId, target, budget }, value);
    }
  );

  server.registerTool(
    "kairn_find_tests",
    {
      title: "Find tests",
      description: "Find test files and package scripts related to a file or task.",
      inputSchema: {
        sessionId: z.string().min(1),
        target: z.string().optional(),
        budget: z.number().int().positive().optional(),
        limit: z.number().int().nonnegative().optional()
      }
    },
    async ({ sessionId, target, budget, limit }) =>
      mcpToolResult(
        runtime,
        "kairn_find_tests",
        { sessionId, target, budget, limit },
        await runtime.findTests({ sessionId, target, budget, limit: limit ?? 1, focused: true })
      )
  );

  server.registerTool(
    "kairn_review_diff",
    {
      title: "Review diff",
      description: "Review the current git diff against the task session context.",
      inputSchema: {
        sessionId: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, budget }) => mcpToolResult(runtime, "kairn_review_diff", { sessionId, budget }, await runtime.reviewDiff({ sessionId, budget }))
  );

  server.registerTool(
    "kairn_compress_output",
    {
      title: "Compress output",
      description: "Compress test, lint, typecheck, or generic command output for the active task.",
      inputSchema: {
        sessionId: z.string().min(1),
        type: outputKindSchema,
        output: z.string(),
        budget: z.number().int().positive().optional()
      }
    },
    ({ sessionId, type, output, budget }) =>
      mcpToolResult(
        runtime,
        "kairn_compress_output",
        { sessionId, type, budget },
        runtime.compressOutput({ sessionId, type: type as OutputKind, output, budget, source: "mcp" })
      )
  );

  server.registerTool(
    "kairn_get_next_context",
    {
      title: "Get next context",
      description: "Recommend the next smallest useful context from session history, failures, and diff state.",
      inputSchema: {
        sessionId: z.string().min(1),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, budget }) =>
      mcpToolResult(runtime, "kairn_get_next_context", { sessionId, budget }, await runtime.getNextContext({ sessionId, budget }))
  );

  server.registerTool(
    "kairn_get_failure_context",
    {
      title: "Get failure context",
      description: "Build failure-first context from test, lint, typecheck, or generic command output.",
      inputSchema: {
        sessionId: z.string().min(1),
        type: outputKindSchema,
        output: z.string().optional(),
        command: z.string().optional(),
        files: z.array(z.string()).optional(),
        budget: z.number().int().positive().optional()
      }
    },
    async ({ sessionId, type, output, command, files, budget }) =>
      mcpToolResult(
        runtime,
        "kairn_get_failure_context",
        { sessionId, type, command, files, budget },
        await runtime.getFailureContext({ sessionId, type: type as OutputKind, output, command, files, budget, source: "mcp" })
      )
  );

  server.registerTool(
    "kairn_get_metrics",
    {
      title: "Get metrics",
      description: "Return session token-savings and hook/watch metrics.",
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    ({ sessionId }) => toolResult(runtime.getMetrics(sessionId))
  );

  server.registerTool(
    "kairn_get_session_state",
    {
      title: "Get session state",
      description: "Return Kairn's stored task session state.",
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    ({ sessionId }) => mcpToolResult(runtime, "kairn_get_session_state", { sessionId }, runtime.getSession(sessionId))
  );

  return server;
}

type PrimeContextResult = Awaited<ReturnType<KairnRuntime["primeContext"]>>;

function compactPrepareResult(runtime: KairnRuntime, prime: PrimeContextResult) {
  const coordination = runtime.getCoordinationState(prime.session.id);
  const decision = prime.contextDecision;
  const workingSet = isRecord(prime.metadata?.workingSet) ? prime.metadata.workingSet : undefined;
  const editScope = prime.editScope ?? (isRecord(prime.metadata?.editScope) ? prime.metadata.editScope : undefined);
  const priorMcpSource = coordination.mcpFiles.find(isMcpPrimarySourceFile);
  const priorSourceStop = priorMcpSource
    ? mcpPrepareStopAfterPriorSource({ task: prime.task, sourceFile: priorMcpSource, workingSet })
    : undefined;
  if (priorSourceStop) {
    const tokenEstimate = estimateCompactPrepareTokens([], [], [], undefined);
    return {
      detail: "compact",
      contextSuppressed: true,
      sessionId: prime.session.id,
      session: { id: prime.session.id, task: prime.session.task },
      task: prime.task,
      profile: prime.profile,
      startFiles: [],
      files: [],
      companionFiles: [],
      fallbackFiles: [],
      exactSymbolHint: null,
      exactSourceEvidence: null,
      invariant: workingSetInvariant(workingSet) ?? prime.invariants?.[0] ?? null,
      invariantStatement: workingSetInvariantStatement(workingSet) ?? prime.invariants?.[0]?.statement ?? null,
      expectedBehavior: workingSetInvariantStatement(workingSet) ?? null,
      verificationCommand: null,
      workingSet,
      editScope,
      primaryReason: priorSourceStop.reason,
      stopCondition: priorSourceStop.stopCondition,
      nextToolCalls: [],
      recommendedToolCalls: [],
      likelyTests: [],
      tokenEstimate,
      quality: prime.quality,
      contextDecision: {
        ...(decision ?? {}),
        action: "suppress",
        recommendedDelivery: "none",
        reasons: uniqueValues([...(decision?.reasons ?? []), priorSourceStop.reason])
      },
      warnings: uniqueValues([...prime.warnings, priorSourceStop.reason]),
      duplicateContextAvoided: coordination.duplicateContextAvoided + 1,
      hookFiles: coordination.hookFiles.slice(0, 3),
      priorMcpFiles: coordination.mcpFiles.slice(0, 3)
    };
  }
  const cheapOneShotStop = mcpCheapOneShotAbstention(prime);
  if (cheapOneShotStop) {
    const guardrailFiles = cheapOneShotStop.primaryFile ? [cheapOneShotStop.primaryFile] : [];
    const contextSuppressed = guardrailFiles.length === 0;
    const tokenEstimate = estimateCompactPrepareTokens(guardrailFiles, [], [], undefined);
    return {
      detail: "compact",
      contextSuppressed,
      sessionId: prime.session.id,
      session: { id: prime.session.id, task: prime.session.task },
      task: prime.task,
      profile: prime.profile,
      startFiles: guardrailFiles,
      files: guardrailFiles,
      companionFiles: [],
      fallbackFiles: [],
      exactSymbolHint: null,
      exactSourceEvidence: null,
      invariant: prime.invariants?.[0] ?? null,
      invariantStatement: prime.invariants?.[0]?.statement ?? null,
      expectedBehavior: prime.invariants?.[0]?.statement ?? null,
      verificationCommand: null,
      workingSet,
      editScope,
      primaryReason: cheapOneShotStop.reason,
      stopCondition: cheapOneShotStop.stopCondition,
      nextToolCalls: [],
      recommendedToolCalls: [],
      likelyTests: [],
      tokenEstimate,
      quality: {
        ...(prime.quality ?? {
          score: prime.contextDecision?.score ?? 0,
          action: contextSuppressed ? "suppress" : "shrink",
          reasons: [],
          topScore: prime.contextDecision?.topScore ?? 0,
          topGap: prime.contextDecision?.topGap ?? 0,
          exactPathMentioned: false,
          expectedSavingsRisk: "high"
        }),
        action: contextSuppressed ? "suppress" : "shrink",
        expectedSavingsRisk: contextSuppressed ? "high" : "medium",
        reasons: uniqueValues([...(prime.quality?.reasons ?? []), cheapOneShotStop.reason])
      },
      contextDecision: {
        ...(decision ?? {}),
        action: contextSuppressed ? "suppress" : "shrink",
        recommendedDelivery: contextSuppressed ? "none" : "one_file_directive",
        expectedSavingsRisk: contextSuppressed ? "high" : "medium",
        reasons: uniqueValues([...(decision?.reasons ?? []), cheapOneShotStop.reason])
      },
      warnings: uniqueValues([...prime.warnings, cheapOneShotStop.reason]),
      duplicateContextAvoided: coordination.duplicateContextAvoided,
      hookFiles: coordination.hookFiles.slice(0, 3)
    };
  }
  if (decision?.action === "suppress") {
    return {
      detail: "compact",
      sessionId: prime.session.id,
      session: { id: prime.session.id, task: prime.session.task },
      task: prime.task,
      profile: prime.profile,
      startFiles: [],
      files: [],
      exactSymbolHint: null,
      primaryReason: "Kairn does not have high-confidence context yet; continue normally and call Kairn again after a failure, diff, or more specific target.",
      nextToolCalls: [],
      recommendedToolCalls: [],
      likelyTests: [],
      tokenEstimate: 0,
      quality: prime.quality,
      contextDecision: decision,
      editScope,
      workingSet,
      warnings: uniqueValues([...prime.warnings, "Kairn suppressed proactive context because expected savings risk is high."]),
      duplicateContextAvoided: coordination.duplicateContextAvoided,
      hookFiles: coordination.hookFiles.slice(0, 3)
    };
  }
  if (decision?.wrongContextRisk && decision.action === "shrink") {
    const quality = prime.quality ?? {
      score: decision.score,
      action: decision.action,
      reasons: decision.reasons,
      topScore: decision.topScore,
      topGap: decision.topGap,
      exactPathMentioned: decision.exactPathMentioned,
      expectedSavingsRisk: decision.expectedSavingsRisk
    };
    return {
      detail: "compact",
      sessionId: prime.session.id,
      session: { id: prime.session.id, task: prime.session.task },
      task: prime.task,
      profile: prime.profile,
      startFiles: [],
      files: [],
      exactSymbolHint: null,
      primaryReason: "Kairn found possible context, but the top source signal is risky for this task. Continue normally; call Kairn again after a concrete failure, diff, or exact target.",
      stopCondition: "context_risk_abstention",
      nextToolCalls: [],
      recommendedToolCalls: [],
      likelyTests: [],
      tokenEstimate: 0,
      quality: {
        ...quality,
        action: "suppress",
        reasons: [...quality.reasons, "MCP compact abstained because context risk is high"]
      },
      contextDecision: {
        ...decision,
        action: "suppress",
        recommendedDelivery: "none",
        expectedSavingsRisk: "high",
        reasons: [...decision.reasons, "MCP compact abstained because context risk is high"]
      },
      editScope,
      workingSet,
      warnings: uniqueValues([...prime.warnings, "Kairn suppressed MCP context because the expected savings risk is high."]),
      duplicateContextAvoided: coordination.duplicateContextAvoided,
      hookFiles: coordination.hookFiles.slice(0, 3)
    };
  }
  const unshownPrimeFiles = prime.files.filter((file) => !coordination.hookFiles.includes(file));
  const sourceCandidates = uniqueValues([
    ...unshownPrimeFiles.filter(isMcpPrimarySourceFile),
    ...prime.files.filter(isMcpPrimarySourceFile),
    ...unshownPrimeFiles.filter((file) => !isMcpLikelyTestFile(file) && !isMcpNoisyFile(file)),
    ...prime.files.filter((file) => !isMcpLikelyTestFile(file) && !isMcpNoisyFile(file))
  ]);
  const startFiles = sourceCandidates.slice(0, 1);
  const companionFiles = sourceCandidates
    .filter((file) => !startFiles.includes(file))
    .slice(0, shouldIncludeMcpCompanion(prime) ? 1 : 0);
  const likelyTests = shouldIncludeMcpLikelyTests(prime)
    ? uniqueValues(prime.files.filter(isMcpLikelyTestFile)).slice(0, 1)
    : [];
  const primaryFile = startFiles[0];
  const exactSourceEvidence = primaryFile && decision?.exactSourceHit
    ? runtime.getExactSourceEvidence({ sessionId: prime.session.id, file: primaryFile, budget: 220 })
    : undefined;
  const symbolHint = exactSourceEvidence?.symbol ?? extractSymbolHints(prime.content)[0];
  const sourceEvidenceStop = Boolean(primaryFile);
  const nextToolCalls = sourceEvidenceStop
    ? []
    : [
      ...(primaryFile && symbolHint
      ? [{ tool: "kairn_read_symbol", input: { sessionId: prime.session.id, target: primaryFile, symbol: symbolHint, budget: 550 } }]
      : primaryFile
        ? [{ tool: "kairn_read_file", input: { sessionId: prime.session.id, target: primaryFile, mode: "summary", budget: 550 } }]
        : []),
      ...(!primaryFile ? [{ tool: "kairn_get_next_context", input: { sessionId: prime.session.id, budget: 550 } }] : [])
    ].slice(0, 1);

  return {
    detail: "compact",
    sessionId: prime.session.id,
    session: { id: prime.session.id, task: prime.session.task },
    task: prime.task,
    profile: prime.profile,
    startFiles,
    files: uniqueValues([...startFiles, ...companionFiles]),
    companionFiles,
    fallbackFiles: companionFiles,
    exactSymbolHint: symbolHint ?? null,
    exactSourceEvidence: exactSourceEvidence ?? null,
    invariant: exactSourceEvidence?.invariant ?? prime.invariants?.[0] ?? null,
    invariantStatement: exactSourceEvidence?.invariant?.statement ?? prime.invariants?.[0]?.statement ?? null,
    expectedBehavior: exactSourceEvidence?.expectedBehavior ?? null,
    verificationCommand: exactSourceEvidence?.verificationCommand ?? null,
    workingSet,
    editScope,
    primaryReason: primaryFile
      ? sourceEvidenceStop
        ? `Source evidence stop: use ${primaryFile}; do not call more Kairn unless a check fails, the file changes, or the task target changes.`
        : companionFiles[0]
        ? `Start with ${primaryFile}; ${companionFiles[0]} is the one capped companion for this multi-surface task.`
        : `Start with ${primaryFile}; it is Kairn's highest-confidence unshown file for this task.`
      : "Kairn did not find a high-confidence start file.",
    stopCondition: sourceEvidenceStop ? "source_evidence_sufficient" : null,
    nextToolCalls,
    recommendedToolCalls: nextToolCalls,
    likelyTests,
    tokenEstimate: estimateCompactPrepareTokens(uniqueValues([...startFiles, ...companionFiles]), likelyTests, nextToolCalls, exactSourceEvidence),
    quality: prime.quality,
    contextDecision: decision,
    warnings: prime.warnings,
    duplicateContextAvoided: coordination.duplicateContextAvoided,
    hookFiles: coordination.hookFiles.slice(0, 3)
  };
}

function fullPrepareResult(prime: PrimeContextResult) {
  const recommendedToolCalls = [
    ...(prime.files[0] ? [{ tool: "kairn_read_file", input: { sessionId: prime.session.id, target: prime.files[0], mode: "summary", budget: 700 } }] : []),
    ...(prime.files[0] ? [{ tool: "kairn_get_next_context", input: { sessionId: prime.session.id, budget: 700 } }] : []),
    ...(prime.files[0] ? [{ tool: "kairn_find_tests", input: { sessionId: prime.session.id, target: prime.files[0], budget: 600 } }] : [])
  ];
  return {
    detail: "full",
    session: prime.session,
    sessionId: prime.session.id,
    task: prime.task,
    profile: prime.profile,
    content: prime.content,
    startFiles: prime.files.slice(0, 4),
    files: prime.files.slice(0, 4),
    quality: prime.quality,
    contextDecision: prime.contextDecision,
    editScope: prime.editScope,
    invariants: prime.invariants ?? [],
    warnings: prime.warnings,
    suggestedCommands: prime.suggestedCommands.slice(0, 3),
    tokenEstimate: prime.tokenEstimate,
    recommendedToolCalls,
    nextToolCalls: recommendedToolCalls.slice(0, 2)
  };
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isMcpLikelyTestFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    normalized.includes("__tests__/") ||
    /^test_.*\.pyi?$/.test(normalized.split("/").at(-1) ?? normalized) ||
    /_test\.pyi?$/.test(normalized) ||
    /(test|tests)\.java$/.test(normalized) ||
    normalized.includes("/src/test/java/") ||
    /(_test|_tests|_unittest)\.(cc|cpp|cxx|c|hh|hpp|hxx)$/.test(normalized) ||
    /_test\.go$/.test(normalized) ||
    /(_test|_spec)\.rb$/.test(normalized) ||
    /(^|\/)(test|tests)\//.test(normalized)
  );
}

function isMcpPrimarySourceFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    !isMcpLikelyTestFile(normalized) &&
    !isMcpNoisyFile(normalized) &&
    (normalized.startsWith("src/") ||
      normalized.includes("/src/") ||
      normalized.startsWith("include/") ||
      normalized.includes("/include/") ||
      normalized.startsWith("lib/") ||
      normalized.includes("/lib/") ||
      /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|c|cc|cpp|cxx|h|hh|hpp|hxx|go|rb)$/.test(normalized))
  );
}

function isMcpNoisyFile(filePath: string): boolean {
  return /(^|\/)(docs?|docs_src|documentation|_?examples|demo|demos|devtools|codemods|fixtures|fixture|generated|gen|dist|build|coverage|website|site|playground|storybook|testing|testdata|integration)\//.test(filePath);
}

function shouldIncludeMcpLikelyTests(prime: PrimeContextResult): boolean {
  if (!prime.contextDecision?.exactSourceHit) return true;
  return /\b(test|tests|spec|verify|verification|failing test|failure output)\b/i.test(prime.task);
}

function shouldIncludeMcpCompanion(prime: PrimeContextResult): boolean {
  if (prime.contextDecision?.exactSourceHit) return false;
  return /\b(route|routing|dependency|dependencies|controller|repository|model|scheduler|renderer|interceptor|dispatch|adapter|validation|callback|group|context|handler|middleware|fixture|framework|flow|request|response)\b/i.test(
    prime.task
  );
}

function mcpExactSourceFile(runtime: KairnRuntime, sessionId: string): string | undefined {
  return runtime.getCoordinationState(sessionId).exactSourceFiles[0];
}

function mcpPrepareStopAfterPriorSource(input: {
  task: string;
  sourceFile: string;
  workingSet: Record<string, unknown> | undefined;
}): { stopCondition: string; reason: string } | undefined {
  if (hasMcpExplicitMultiFileSignal(input.task)) return undefined;
  const phase = mcpTaskPhase(input.task);
  const invariant = workingSetInvariantStatement(input.workingSet);
  const lastPassingVerification = isRecord(input.workingSet?.lastPassingVerification) ? input.workingSet?.lastPassingVerification : undefined;
  const lastFailure = isRecord(input.workingSet?.lastFailure) ? input.workingSet?.lastFailure : undefined;
  const unresolvedFailure = Boolean(lastFailure) && !lastPassingVerification;
  if (unresolvedFailure) return undefined;

  if (lastPassingVerification && (phase === "verification" || phase === "cleanup")) {
    return {
      stopCondition: "verification_already_passed",
      reason: `Kairn already returned ${input.sourceFile} and the latest verification passed. Continue from the existing source and invariant${invariant ? `: ${invariant}` : ""}; do not call more Kairn unless a new check fails or the target changes.`
    };
  }
  if (phase === "verification" || phase === "cleanup") {
    return {
      stopCondition: "source_evidence_already_shown",
      reason: `Kairn already returned ${input.sourceFile}. Run the smallest verification or cleanup check from that source; do not request more Kairn context unless it fails.`
    };
  }
  if (phase === "implementation" || phase === "debugging") {
    return {
      stopCondition: "source_evidence_already_shown",
      reason: `Kairn already returned ${input.sourceFile}. Use that source file first; ask Kairn again only after a concrete failure, file change, or different target.`
    };
  }
  return undefined;
}

function mcpCheapOneShotAbstention(prime: PrimeContextResult): { stopCondition: string; reason: string; primaryFile?: string } | undefined {
  const decision = prime.contextDecision;
  if (!decision) return undefined;
  if (!isMcpCheapOneShotTask(prime.task)) return undefined;
  if (decision.wrongContextRisk) return undefined;
  if (hasMcpExplicitMultiFileSignal(prime.task)) return undefined;
  const primaryFile = uniqueValues([
    ...(decision.primaryFile ? [decision.primaryFile] : []),
    ...prime.files
  ]).find((file) => isMcpPrimarySourceFile(file) && !isMcpNoisyFile(file));
  if (primaryFile) {
    return {
      stopCondition: "cheap_one_shot_guardrail",
      primaryFile,
      reason: `Kairn returned an ultra-minimal guardrail for this cheap one-shot source fix: use ${primaryFile}, preserve the stated invariant, and do not call more Kairn unless a concrete check fails or the target broadens.`
    };
  }
  return {
    stopCondition: "cheap_one_shot_abstention",
    reason: "Kairn abstained because this looks like an obvious one-shot source fix; continue normally and call Kairn again only after a concrete failure, broader target, or multi-file signal."
  };
}

function isMcpCheapOneShotTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (task.length > 420) return false;
  if (!/\b(debug|fix|repair|patch|regression|bug|failing|failure)\b/.test(normalized)) return false;
  if (!/\b(production source|source|do not edit unrelated|unrelated files|smallest)\b/.test(normalized)) return false;
  if (/\b(stack trace|traceback|selected tests|requirements:|actual behavior|expected behavior|multi[-\s]?file|multiple files|across files|across modules|integration|workflow|end-to-end|e2e)\b/.test(normalized)) {
    return false;
  }
  return true;
}

function mcpTaskPhase(task: string): "discovery" | "implementation" | "debugging" | "verification" | "cleanup" {
  const text = task.toLowerCase();
  if (/\b(cleanup|clean up|review diff|final diff|final review|summarize)\b/.test(text)) return "cleanup";
  if (/\b(verify|verification|test|check|typecheck|lint|build)\b/.test(text)) return "verification";
  if (/\b(debug|failure|failing|regression|error|exception)\b/.test(text)) return "debugging";
  if (/\b(fix|repair|patch|edit|change|update|implement)\b/.test(text)) return "implementation";
  return "discovery";
}

function hasMcpExplicitMultiFileSignal(task: string): boolean {
  return /\b(multi[-\s]?file|multiple files|across files|across modules|between .+ and .+|wire .+ and .+|integrat(?:e|ion)|companion|controller.+repository|repository.+controller|router.+dependency|dependency.+router|scheduler.+renderer|renderer.+scheduler|interceptor.+dispatch|dispatch.+interceptor)\b/i.test(task);
}

function workingSetInvariant(workingSet: Record<string, unknown> | undefined): unknown {
  return isRecord(workingSet?.currentInvariant) ? workingSet?.currentInvariant : undefined;
}

function workingSetInvariantStatement(workingSet: Record<string, unknown> | undefined): string | undefined {
  const invariant = workingSetInvariant(workingSet);
  return isRecord(invariant) && typeof invariant.statement === "string" ? invariant.statement : undefined;
}

function estimateCompactPrepareTokens(startFiles: string[], likelyTests: string[], nextToolCalls: unknown[], exactSourceEvidence?: unknown): number {
  return Math.ceil(JSON.stringify({ startFiles, likelyTests, nextToolCalls, exactSourceEvidence }).length / 4);
}

function extractSymbolHints(content: string): string[] {
  const symbols: string[] = [];
  for (const match of content.matchAll(/\bsymbol(?: match)?:\s*([A-Za-z_$][\w$]*)/g)) {
    symbols.push(match[1]!);
  }
  return uniqueValues(symbols).slice(0, 3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpToolResult(runtime: KairnRuntime, toolName: string, input: unknown, value: unknown) {
  runtime.recordMcpToolCall({
    toolName,
    input,
    result: value
  });
  return toolResult(value);
}

function toolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
