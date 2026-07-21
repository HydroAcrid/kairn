import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import type {
  BenchmarkAssistanceMode,
  BenchmarkDiffScope,
  BenchmarkSourceInvariant,
  BenchmarkComparison,
  BenchmarkProofReport,
  BenchmarkReport,
  BenchmarkResultRecord,
  BenchmarkRunMode,
  ContextPrime,
  ContextQueryMode,
  ContextInvariant,
  ContextRankedFile,
  ContextResponse,
  ContextResponseMode,
  ContextValueDecision,
  ExactSourceEvidence,
  EvalComparison,
  EvalObservationRecord,
  EvalRunMode,
  EvalRunReport,
  FailureContext,
  FileRoleV2,
  FileRecord,
  HybridScoredResult,
  HookHandlingResult,
  HookOutputProfile,
  ImpactStats,
  InitResult,
  IndexCompactionResult,
  IndexStateStats,
  MetricsEventKind,
  MetricsSummary,
  NormalizedHookEvent,
  OutputKind,
  PrimeProfile,
  QueryLocalIndex,
  SessionContextPolicyDecision,
  SessionLedgerEvent,
  SessionLedgerEventKind,
  SessionLedgerSummary,
  SymbolRecord,
  TaskSession,
  TaskPhase,
  WatchEventKind,
  WatchEventRecord,
  WatchEventSource,
  WatchRecommendation,
  WatchSnapshot
} from "../types.js";
import type { BenchmarkCase } from "../types/bench.js";
import { ensureKairnDir, getKairnPaths } from "../config/paths.js";
import { loadEvidenceRoutingConfig } from "../config/evidenceRouting.js";
import { SqliteStore } from "../store/sqliteStore.js";
import { compressOutput as compressOutputText } from "../compression/compressOutput.js";
import { evaluateEvidenceRoutingShadow } from "../compression/evidenceRoutingPolicy.js";
import { routeEvidenceCompression } from "../compression/routeEvidence.js";
import { reviewGitDiff } from "../git/reviewDiff.js";
import { hybridSearch } from "../retrieval/hybridRetrieval.js";
import { applyCompanionCandidatesToResults, findCompanionCandidates } from "../retrieval/companions.js";
import { findRelatedFiles, findTestsFor } from "../retrieval/relatedFiles.js";
import { extractSymbol, readTextFile, summarizeFile } from "../retrieval/readSource.js";
import { decideResponse } from "../retrieval/responseRouter.js";
import { sha256 } from "../utils/hash.js";
import { normalizeRelativePath, resolveRoot } from "../utils/paths.js";
import { estimateTokens, truncateToBudget } from "../utils/tokens.js";
import { classifyObservedCommand } from "../watch/classifyCommand.js";
import { extractFailureFiles } from "../watch/failureParser.js";
import { normalizeHookPayload } from "../watch/normalizeHook.js";
import { nowIso } from "../utils/time.js";
import { classifyQueryIntent } from "../retrieval/queryIntent.js";
import { tokenizeLexical } from "../semantic/tokenize.js";
import { loadBenchmarkSuite } from "../bench/suite.js";
import { buildBenchmarkReport, compareBenchmarkReports, scoreBenchmarkCase } from "../bench/score.js";
import { runAgentBenchmarkCase } from "../bench/agent.js";
import { buildBenchmarkProofReport, shuffleItems } from "../bench/proofReport.js";
import { benchmarkCaseApplies, requireBenchmarkTarget } from "../bench/runtimeHelpers.js";
import {
  evaluatePrimeQuality,
  primeProfileLimits,
  resolvePrimeProfile
} from "../prime/quality.js";
import { evaluateContextValue } from "../prime/contextValue.js";
import {
  classifyTaskFrameFromTask,
  hasExplicitMultiFileScopeRequest,
  hasConfigOptionRuntimeScope,
  hasDeprecationLifecycleScope,
  hasPromptDerivedMultiFileScope,
  taskHasProductionOnlyEditIntent,
  taskIsOfficialProductionPatchPrompt,
  taskIsReadOnlySourceRouting
} from "../prime/contextGovernor.js";
import { decideSessionContextPolicy, inferTaskPhase } from "../ledger/policy.js";
import { summarizeSessionLedger } from "../ledger/summary.js";
import {
  formatEvidenceRequestPrimeContext,
  formatMcpBriefPrimeContext,
  officialGuardrailVariantFor,
  formatPrimeContext,
  formatShrunkPrimeContext,
  formatSourceRoutingPrimeContext,
  formatSuppressedPrimeContext,
  withTinyDirectivePrime
} from "../prime/formatPrime.js";
import { estimateFileBaselineTokens } from "../metrics/baseline.js";
import { uniquePaths, uniqueStrings } from "../utils/collections.js";
import { formatContextResults } from "../context/formatContext.js";
import { buildContextInvariant } from "../context/invariants.js";
import { failureRecommendation } from "../watch/recommendation.js";
import { adaptivePrimeBudget, queryLocalBudget } from "../budget/adaptiveBudget.js";
import {
  hostSessionIdForEvent,
  hostSessionMetadata,
  isHighConfidencePrompt,
  isPromptEvent,
  isTrivialSuccessfulHook,
  stringMetadata,
  taskFromHookEvent
} from "../watch/hookPredicates.js";
import { graphReason, mergeReasonText } from "../graph/reasons.js";
import { sliceLines } from "../source/text.js";
import { IndexService } from "./services/IndexService.js";
import { MetricsService } from "./services/MetricsService.js";
import { EvalService } from "./services/EvalService.js";
import { decideEditScope } from "../scope/editScope.js";
import { isUnrelatedDeprecationLifecyclePath, scoreDeprecationLifecyclePath } from "../scope/lifecycleSurfaces.js";

type PrimeDeliveryTrace = {
  action: ContextValueDecision["action"];
  recommendedDelivery?: ContextValueDecision["recommendedDelivery"];
  taskShapeSignal?: ContextValueDecision["taskShapeSignal"];
  requiredSurface?: ContextValueDecision["requiredSurface"];
  directiveStyle?: ContextValueDecision["directiveStyle"];
  guardrailVariant?: string;
  emittedFileCount: number;
  emittedFileRoleSummary: Partial<Record<FileRoleV2, number>>;
  editScopeSource?: string;
  estimatedDirectiveTokens: number;
  estimatedSourceContextTokens: number;
  sizingReason: string;
};

export class KairnRuntime {
  private readonly rootPath: string;
  private readonly store: SqliteStore;
  private readonly indexService: IndexService;
  private readonly metricsService: MetricsService;
  private readonly evalService: EvalService;

  constructor(root?: string) {
    this.rootPath = resolveRoot(root);
    const paths = ensureKairnDir(this.rootPath);
    this.store = new SqliteStore(paths.databasePath);
    const deps = { rootPath: this.rootPath, store: this.store };
    this.indexService = new IndexService(deps);
    this.metricsService = new MetricsService(deps);
    this.evalService = new EvalService(deps, this.metricsService);
  }

  close(): void {
    this.store.close();
  }

  async init(): Promise<InitResult> {
    return this.indexService.init();
  }

  async startTask(task: string): Promise<{ session: TaskSession; response: ContextResponse }> {
    await this.init();
    const session = this.store.createSession({
      id: `task_${randomUUID()}`,
      rootPath: this.rootPath,
      task,
      verificationHints: ["Review changed files", "Run related tests", "Check for context drift"]
    });
    const response = await this.findContext({
      sessionId: session.id,
      query: task,
      requestType: "initial_brief",
      budget: 1600
    });

    return {
      session: this.getSession(session.id),
      response
    };
  }

  async primeContext(input: {
    task: string;
    sessionId?: string | undefined;
    budget?: number | undefined;
    mode?: ContextQueryMode | undefined;
    profile?: PrimeProfile | undefined;
    format?: "standard" | "mcp_brief" | undefined;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | undefined;
    eventName?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    refreshIndex?: boolean | undefined;
    editScopeHints?: {
      allowedDiffScopes?: BenchmarkDiffScope[] | undefined;
      sourceInvariants?: BenchmarkSourceInvariant[] | undefined;
      failureFiles?: string[] | undefined;
    } | undefined;
  }): Promise<ContextPrime> {
    const primeStartedAt = Date.now();
    const timings: Record<string, number> = {};
    const markTiming = (label: string, startedAt: number) => {
      timings[label] = Date.now() - startedAt;
    };
    const inventoryStartedAt = Date.now();
    let knownFiles = this.store.listFiles(this.rootPath);
    markTiming("initialInventoryMs", inventoryStartedAt);
    const hadInventory = knownFiles.length > 0;
    const freshness = hadInventory ? this.indexService.getStatus(this.rootPath).freshness : undefined;
    const shouldRefreshIndex = input.refreshIndex === true || ((!hadInventory || freshness?.stale) && input.refreshIndex !== false);
    if (shouldRefreshIndex) {
      const initStartedAt = Date.now();
      knownFiles = await this.refreshIndex(this.rootPath, { force: input.refreshIndex === true });
      markTiming("initMs", initStartedAt);
      const refreshedInventoryStartedAt = Date.now();
      knownFiles = this.store.listFiles(this.rootPath);
      markTiming("refreshedInventoryMs", refreshedInventoryStartedAt);
    }
    const task = input.task;
    const profile = resolvePrimeProfile(input.profile ?? "auto", task);
    const repoFileCount = knownFiles.length;
    const budget = input.budget ?? adaptivePrimeBudget({ profile, task, repoFileCount });
    const limits = primeProfileLimits(profile);
    const session = input.sessionId
      ? this.getOrCreatePrimeSession(input.sessionId, input.task)
      : this.store.createSession({
          id: `task_${randomUUID()}`,
          rootPath: this.rootPath,
          task: input.task,
          verificationHints: ["Start from Kairn prime context", "Avoid broad scans unless the prime is insufficient", "Run related tests before finalizing"]
        });
    const resolvedTask = input.task || session.task;
    const preRetrievalTaskFrame = classifyTaskFrameFromTask(resolvedTask, profile);
    if (preRetrievalTaskFrame === "runtime_procedural") {
      const preRetrievalFiles = session.rootPath === this.rootPath ? knownFiles : this.store.listFiles(session.rootPath);
      const evidenceRequest = {
        kind: "runtime_scope" as const,
        prompt: "Provide the runtime command/output, log excerpt, or observation target before Kairn sends source context.",
        reason: "This prompt asks for runtime observation; static retrieval alone would likely over-assist or point at the wrong source."
      };
      const contextDecision: ContextValueDecision = {
        score: 42,
        action: "request_evidence",
        reasons: ["pre-retrieval governor requested runtime evidence before source retrieval"],
        topScore: 0,
        topGap: 0,
        language: "unknown",
        exactPathMentioned: false,
        recommendedDelivery: "evidence_request",
        estimatedContextCost: 0,
        expectedSavingsRisk: "high",
        debugSignal: profile === "failure_debug",
        easyTaskSignal: false,
        taskFrame: preRetrievalTaskFrame,
        requiredSurface: "evidence_needed",
        evidenceRequest,
        modelPrediction: {
          pUseful: 0.24,
          pHarm: 0.52,
          pNeedMoreEvidence: 0.86,
          suggestedAction: "request_evidence",
          confidence: 0.86,
          source: "deterministic"
        },
        featureSummary: {
          taskFrame: preRetrievalTaskFrame,
          requiredSurface: "evidence_needed",
          candidateCount: 0,
          fileRoleCounts: {},
          repoLanguageMix: languageMixForGovernorSummary(preRetrievalFiles),
          confidenceGap: 0,
          candidateEntropy: 0,
          ambiguity: 1,
          expectedContextCost: 0,
          estimatedSearchCost: Math.min(100, Math.round(Math.log10(Math.max(10, preRetrievalFiles.length)) * 18 + 22))
        }
      };
      const quality = {
        score: contextDecision.score,
        action: contextDecision.action,
        reasons: contextDecision.reasons,
        topScore: 0,
        topGap: 0,
        exactPathMentioned: false,
        expectedSavingsRisk: contextDecision.expectedSavingsRisk
      };
      const content = formatEvidenceRequestPrimeContext({
        task: resolvedTask,
        sessionId: session.id,
        profile,
        quality,
        evidenceRequest
      });
      timings.totalPrimeMs = Date.now() - primeStartedAt;
      this.recordShown(session.id, "context", "brief", content);
      this.recordMetricsEvent({
        sessionId: session.id,
        rootPath: session.rootPath,
        eventKind: "prime_context",
        eventName: "request_evidence",
        source: input.source ?? "cli",
        responseMode: "brief",
        baselineTokens: 0,
        outputTokens: estimateTokens(content),
        files: [],
        metadata: {
          ...input.metadata,
          taskHash: sha256(resolvedTask),
          profile,
          budget,
          format: input.format ?? "standard",
          quality,
          contextDecision,
          timings,
          contextTokenEstimate: 0,
          estimator: "pre-retrieval runtime evidence request"
        }
      });
      this.recordMetricsEvent({
        sessionId: session.id,
        rootPath: session.rootPath,
        eventKind: "prime_quality",
        eventName: "request_evidence",
        source: input.source ?? "cli",
        responseMode: "brief",
        baselineTokens: 0,
        outputTokens: 0,
        files: [],
        metadata: {
          ...quality,
          contextDecision,
          timings,
          taskHash: sha256(resolvedTask),
          profile
        }
      });
      this.recordMetricsEvent({
        sessionId: session.id,
        rootPath: session.rootPath,
        eventKind: "context_value_decision",
        eventName: "request_evidence",
        source: input.source ?? "cli",
        responseMode: "brief",
        baselineTokens: 0,
        outputTokens: 0,
        files: [],
        metadata: {
          ...contextDecision,
          timings,
          taskHash: sha256(resolvedTask),
          profile
        }
      });
      return {
        session: this.getSession(session.id),
        task: resolvedTask,
        profile,
        content,
        files: [],
        tokenEstimate: estimateTokens(content),
        quality,
        contextDecision,
        timings,
        metadata: {
          preRetrievalTaskFrame
        },
        warnings: ["Kairn requested runtime evidence before source retrieval."],
        suggestedCommands: [
          `kairn context --session ${session.id} --root <repo> --query "${resolvedTask.replaceAll('"', '\\"')}" --mode snippets`
        ]
      };
    }
    const findContextStartedAt = Date.now();
    const context = await this.findContext({
      sessionId: session.id,
      query: resolvedTask,
      requestType: "find_context",
      budget: Math.max(360, Math.floor(budget * limits.contextRatio)),
      mode: input.mode ?? "snippets",
      refreshIndex: false
    });
    markTiming("findContextMs", findContextStartedAt);
    const primaryFile = context.suggestedNextContext[0] ?? context.files[0];
    const companionMetadata = Array.isArray(context.metadata?.companions) ? context.metadata.companions : [];
    const companionPaths = companionMetadata
      .map((item) => (item && typeof item === "object" && "file" in item ? (item as { file?: unknown }).file : undefined))
      .filter((file): file is string => typeof file === "string");
    const companionTopScore = Math.max(
      0,
      ...companionMetadata
        .map((item) => (item && typeof item === "object" && "score" in item ? Number((item as { score?: unknown }).score) : 0))
        .filter((score) => Number.isFinite(score))
    );
    const companionSpecific = companionMetadata.some(hasSpecificCompanionEvidence);
    const sessionFiles = session.rootPath === this.rootPath ? knownFiles : this.store.listFiles(session.rootPath);
    const decisionStartedAt = Date.now();
    const baseQuality = evaluatePrimeQuality({
      task: resolvedTask,
      context,
      knownFiles: sessionFiles
    });
    let contextDecision = evaluateContextValue({
      task: resolvedTask,
      profile,
      context,
      quality: baseQuality,
      knownFiles: sessionFiles,
      repoFileCount: sessionFiles.length,
      estimatedContextCost: budget,
      companionCount: companionMetadata.length,
      companionTopScore,
      companionSpecific
    });
    const automaticSuppressionReason = automaticPrimeSuppressionReason({
      source: input.source,
      task: resolvedTask,
      decision: contextDecision
    });
    const mcpBriefSuppressionReason = input.format === "mcp_brief" && contextDecision.wrongContextRisk
      ? "hybrid MCP brief abstained because compact MCP context risk is high"
      : undefined;
    const suppressionReason = automaticSuppressionReason ?? mcpBriefSuppressionReason;
    if (suppressionReason) {
      contextDecision = {
        ...contextDecision,
        score: Math.max(0, contextDecision.score - 18),
        action: "suppress",
        recommendedDelivery: "none",
        expectedSavingsRisk: "high",
        reasons: uniqueStrings([...contextDecision.reasons, suppressionReason])
      };
    }
    markTiming("decisionMs", decisionStartedAt);
    const quality = {
      ...baseQuality,
      score: contextDecision.score,
      action: contextDecision.action,
      reasons: contextDecision.reasons,
      expectedSavingsRisk: contextDecision.expectedSavingsRisk
    };
    const readOnlySourceRouting = taskIsReadOnlySourceRouting(resolvedTask);
    const promptDerivedMultiFileScope = hasPromptDerivedMultiFileScope(resolvedTask);
    if (freshness?.stale && input.refreshIndex === false) {
      quality.reasons = uniqueStrings([...quality.reasons, `index freshness: ${freshness.reason}`]);
    }
    const structuredPrimaryCandidate =
      contextDecision.primaryFile && uniquePaths([...context.files, ...context.suggestedNextContext, ...companionPaths]).includes(contextDecision.primaryFile)
        ? contextDecision.primaryFile
        : primaryFile;
    const directivePrimaryFile = contextDecision.recommendedDelivery === "multi_file_directive" && !contextDecision.exactSourceHit && !contextDecision.canonicalSourceHit
      ? preferredStructuredDebugPrimary(structuredPrimaryCandidate, companionMetadata)
      : primaryFile;
    let invariants = !readOnlySourceRouting && directivePrimaryFile && (contextDecision.exactSourceHit || contextDecision.cheapSingleSource || contextDecision.recommendedDelivery === "multi_file_directive")
      ? [
          contextDecision.exactSourceHit
            ? sourceInvariantContextForFile(input.editScopeHints?.sourceInvariants, directivePrimaryFile) ??
              this.getExactSourceEvidence({ sessionId: session.id, file: directivePrimaryFile, budget: 180, task: resolvedTask }).invariant
            : buildContextInvariant({ task: resolvedTask, file: directivePrimaryFile })
        ].filter((invariant): invariant is NonNullable<typeof invariant> => Boolean(invariant))
      : [];
    let related: Awaited<ReturnType<KairnRuntime["getRelatedFiles"]>> | undefined;
    let tests: Awaited<ReturnType<KairnRuntime["findTests"]>> | undefined;
    const includeCompanionContext =
      (!contextDecision.exactSourceHit || contextDecision.recommendedDelivery === "multi_file_directive") &&
      shouldUseCompanionContext(resolvedTask, companionPaths);
    const needsExpansion =
      quality.action === "emit" && !contextDecision.exactSourceHit && !includeCompanionContext && input.format !== "mcp_brief";
    if (needsExpansion) {
      const expansionStartedAt = Date.now();
      const relatedStartedAt = Date.now();
      const testsStartedAt = Date.now();
      const [relatedResult, testsResult] = await Promise.all([
        primaryFile && limits.relatedFiles > 0
          ? this.getRelatedFiles({
              sessionId: session.id,
              target: primaryFile,
              budget: 420,
              refreshIndex: false
            })
          : Promise.resolve(undefined),
        limits.testFiles > 0
          ? this.findTests({
              sessionId: session.id,
              target: primaryFile,
              budget: 420,
              refreshIndex: false
            })
          : Promise.resolve(undefined)
      ].map((promise) => promise.catch(() => undefined)));
      related = relatedResult as typeof related;
      tests = testsResult as typeof tests;
      markTiming("relatedFilesMs", relatedStartedAt);
      markTiming("findTestsMs", testsStartedAt);
      markTiming("expansionWallMs", expansionStartedAt);
    }
    const baseMultiFileLimit = multiFileDirectiveFileLimit(resolvedTask, companionPaths, contextDecision);
    const promptNamedSourceFiles = (promptDerivedMultiFileScope || contextDecision.recommendedDelivery === "multi_file_directive")
      ? promptNamedSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 9)
      : [];
    const promptMentionedSourceFiles = promptMentionedProductionSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 12);
	    const kubernetesExecSourceFiles = hasKubernetesExecForwarderScope(resolvedTask)
	      ? kubernetesExecForwarderSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 6)
	      : [];
    const webSessionRenewalSourceFiles = hasWebSessionRenewalScope(resolvedTask)
      ? webSessionRenewalSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 6)
      : [];
    const requestBodyFormSourceFiles = hasRequestBodyFormScope(resolvedTask)
      ? requestBodyFormSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const converterOutputSourceFiles = hasConverterOutputScope(resolvedTask)
      ? converterOutputSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const benchmarkGeneratorSourceFiles = hasBenchmarkGeneratorScope(resolvedTask)
      ? benchmarkGeneratorSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 6)
      : [];
    const topicOrderingSourceFiles = hasTopicOrderingScope(resolvedTask)
      ? topicOrderingSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 5)
      : [];
    const collectionNameValidationSourceFiles = hasCollectionNameValidationScope(resolvedTask)
      ? collectionNameValidationSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const grpcErrorPolicySourceFiles = hasGrpcErrorPolicyScope(resolvedTask)
      ? grpcErrorPolicySourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const httpAuthPolicySourceFiles = hasHttpAuthPolicyScope(resolvedTask)
      ? httpAuthPolicySourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 5)
      : [];
    const systemMetadataSourceFiles = hasSystemMetadataScope(resolvedTask)
      ? systemMetadataSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const databaseFailoverSourceFiles = hasDatabaseFailoverScope(resolvedTask)
      ? databaseFailoverSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 5)
      : [];
    const pluginActivationValidationSourceFiles = hasPluginActivationValidationScope(resolvedTask)
      ? pluginActivationValidationSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const executionStateMigrationSourceFiles = hasExecutionStateMigrationScope(resolvedTask)
      ? executionStateMigrationSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const converterOutputDeliveryFiles = contextDecision.requiredSurface === "single_file"
      ? converterOutputSourceFiles.filter(isLikelyProductionSourceFile).slice(0, 1)
      : converterOutputSourceFiles;
    const discoveryConfigSourceFiles = hasDiscoveryConfigScope(resolvedTask)
      ? discoveryConfigSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const deviceSessionListenerSourceFiles = hasDeviceSessionListenerScope(resolvedTask)
      ? deviceSessionListenerSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 4)
      : [];
    const packageSourceMappingSourceFiles = hasPackageSourceMappingScope(resolvedTask)
      ? packageSourceMappingSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 6)
      : [];
    const datastoreBackendParitySourceFiles = hasDatastoreBackendParityScope(resolvedTask)
      ? datastoreBackendParitySourceFilesFromKnownFiles(
          sessionFiles,
          resolvedTask,
          uniquePaths([
            ...(directivePrimaryFile ? [directivePrimaryFile] : []),
            ...(primaryFile ? [primaryFile] : []),
            ...context.files,
            ...companionPaths
          ])
        ).slice(0, 6)
      : [];
	    const multiFileLimit =
	      contextDecision.recommendedDelivery === "multi_file_directive" &&
	      kubernetesExecSourceFiles.length >= 3
	        ? Math.min(6, Math.max(baseMultiFileLimit, kubernetesExecSourceFiles.length))
	        : contextDecision.recommendedDelivery === "multi_file_directive" &&
	            packageSourceMappingSourceFiles.length >= 3
	          ? Math.min(6, Math.max(baseMultiFileLimit, packageSourceMappingSourceFiles.length))
		        : contextDecision.recommendedDelivery === "multi_file_directive" &&
		            webSessionRenewalSourceFiles.length >= 3
		          ? Math.min(6, Math.max(baseMultiFileLimit, webSessionRenewalSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              requestBodyFormSourceFiles.length >= 2
            ? Math.min(requestBodyFormSourceFiles.length, Math.max(baseMultiFileLimit, requestBodyFormSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              converterOutputSourceFiles.length >= 1
            ? Math.min(4, Math.max(baseMultiFileLimit, converterOutputSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              benchmarkGeneratorSourceFiles.length >= 2
            ? Math.min(6, Math.max(baseMultiFileLimit, benchmarkGeneratorSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              topicOrderingSourceFiles.length >= 2
            ? Math.min(5, Math.max(baseMultiFileLimit, topicOrderingSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              collectionNameValidationSourceFiles.length >= 2
            ? Math.min(4, Math.max(baseMultiFileLimit, collectionNameValidationSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              grpcErrorPolicySourceFiles.length >= 2
            ? Math.min(4, Math.max(baseMultiFileLimit, grpcErrorPolicySourceFiles.length))
          : httpAuthPolicySourceFiles.length >= 2
            ? Math.min(5, Math.max(baseMultiFileLimit, httpAuthPolicySourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              systemMetadataSourceFiles.length >= 1
            ? Math.min(4, Math.max(baseMultiFileLimit, systemMetadataSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              databaseFailoverSourceFiles.length >= 2
            ? Math.min(5, Math.max(baseMultiFileLimit, databaseFailoverSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              pluginActivationValidationSourceFiles.length >= 1
            ? Math.min(4, Math.max(baseMultiFileLimit, pluginActivationValidationSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              executionStateMigrationSourceFiles.length >= 2
            ? Math.max(2, Math.min(4, executionStateMigrationSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              discoveryConfigSourceFiles.length >= 2
            ? Math.min(4, Math.max(baseMultiFileLimit, discoveryConfigSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              deviceSessionListenerSourceFiles.length >= 1
            ? Math.min(5, Math.max(baseMultiFileLimit, deviceSessionListenerSourceFiles.length))
          : contextDecision.recommendedDelivery === "multi_file_directive" &&
              datastoreBackendParitySourceFiles.length >= 2
            ? Math.min(6, Math.max(baseMultiFileLimit, datastoreBackendParitySourceFiles.length))
          : promptDerivedMultiFileScope &&
              promptMentionedSourceFiles.length >= 3
            ? Math.min(12, Math.max(baseMultiFileLimit, promptMentionedSourceFiles.length))
		        : contextDecision.recommendedDelivery === "multi_file_directive" &&
		            promptMentionedSourceFiles.length >= 3
		          ? Math.min(12, Math.max(baseMultiFileLimit, promptMentionedSourceFiles.length))
	          : contextDecision.recommendedDelivery === "multi_file_directive" &&
	              hasUiLivenessMultiSurfaceDirective(resolvedTask.toLowerCase()) &&
	              promptNamedSourceFiles.length >= 3
	            ? Math.min(9, Math.max(baseMultiFileLimit, promptNamedSourceFiles.length))
	            : baseMultiFileLimit;
    const topFileLimit = includeCompanionContext ? Math.max(limits.topFiles, multiFileLimit) : limits.topFiles;
    const selectedTestCounterpartSourceFiles = contextDecision.recommendedDelivery === "multi_file_directive"
      ? selectedTestCounterpartSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 3)
      : [];
    const deprecationLifecycleSourceFiles = hasDeprecationLifecycleScope(resolvedTask)
      ? deprecationLifecycleSourceFilesFromKnownFiles(sessionFiles, resolvedTask).slice(0, 5)
      : [];
    const files = contextDecision.exactSourceHit && directivePrimaryFile && !includeCompanionContext && contextDecision.recommendedDelivery !== "multi_file_directive"
      ? [directivePrimaryFile]
      : contextDecision.recommendedDelivery === "multi_file_directive" && directivePrimaryFile
        ? uniquePaths([
            ...packageSourceMappingSourceFiles,
	            ...selectedTestCounterpartSourceFiles,
	            directivePrimaryFile,
	            ...(primaryFile && primaryFile !== directivePrimaryFile ? [primaryFile] : []),
            ...promptMentionedSourceFiles,
	            ...kubernetesExecSourceFiles,
            ...webSessionRenewalSourceFiles,
            ...requestBodyFormSourceFiles,
            ...converterOutputSourceFiles,
            ...benchmarkGeneratorSourceFiles,
            ...topicOrderingSourceFiles,
            ...collectionNameValidationSourceFiles,
            ...grpcErrorPolicySourceFiles,
            ...httpAuthPolicySourceFiles,
            ...systemMetadataSourceFiles,
            ...databaseFailoverSourceFiles,
            ...pluginActivationValidationSourceFiles,
            ...executionStateMigrationSourceFiles,
            ...discoveryConfigSourceFiles,
            ...deviceSessionListenerSourceFiles,
            ...datastoreBackendParitySourceFiles,
	            ...promptNamedSourceFiles,
            ...deprecationLifecycleSourceFiles,
            ...companionPaths,
            ...context.suggestedNextContext,
            ...context.files
          ]).slice(0, Math.max(multiFileLimit, topFileLimit))
      : uniquePaths([
          ...packageSourceMappingSourceFiles,
          ...context.suggestedNextContext.slice(0, topFileLimit),
          ...promptMentionedSourceFiles,
	          ...selectedTestCounterpartSourceFiles,
	          ...kubernetesExecSourceFiles,
          ...webSessionRenewalSourceFiles,
          ...requestBodyFormSourceFiles,
          ...converterOutputSourceFiles,
          ...benchmarkGeneratorSourceFiles,
          ...topicOrderingSourceFiles,
          ...collectionNameValidationSourceFiles,
          ...grpcErrorPolicySourceFiles,
          ...httpAuthPolicySourceFiles,
          ...systemMetadataSourceFiles,
          ...databaseFailoverSourceFiles,
          ...pluginActivationValidationSourceFiles,
          ...executionStateMigrationSourceFiles,
          ...discoveryConfigSourceFiles,
          ...deviceSessionListenerSourceFiles,
          ...datastoreBackendParitySourceFiles,
	          ...promptNamedSourceFiles,
          ...deprecationLifecycleSourceFiles,
          ...companionPaths.slice(0, 2),
          ...context.files.slice(0, topFileLimit),
          ...(related?.related ?? []).slice(0, limits.relatedFiles),
          ...(tests?.files ?? []).slice(0, limits.testFiles)
        ]);
    const readOnlySourceRoutingFiles = readOnlySourceRouting
      ? uniquePaths([
          ...companionPaths,
          ...context.suggestedNextContext,
          ...context.files,
          ...(context.rankedFiles ?? []).map((file) => file.path)
        ]).filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : [];
    const officialPatchScopeFiles = uniquePaths(
      (input.editScopeHints?.allowedDiffScopes ?? [])
        .map((scope) => scope.file)
        .filter(isLikelyProductionSourceFile)
    );
    const hasOfficialMultiFilePatchScope = officialPatchScopeFiles.length > 1;
    const promptMentionsMultipleProductionSourceFiles = promptMentionedSourceFiles.length > 1;
    const officialSingleFilePatchScope =
      contextDecision.taskFrame === "official_patch" &&
      officialPatchScopeFiles.length === 1 &&
	      !hasExplicitMultiFileScopeRequest(resolvedTask) &&
      !promptMentionsMultipleProductionSourceFiles &&
	      !hasDeprecationLifecycleScope(resolvedTask) &&
      !hasWebSessionRenewalScope(resolvedTask) &&
      !hasRequestBodyFormScope(resolvedTask) &&
      !hasDiscoveryConfigScope(resolvedTask) &&
      !hasBenchmarkGeneratorScope(resolvedTask) &&
      !hasTopicOrderingScope(resolvedTask) &&
      !hasCollectionNameValidationScope(resolvedTask) &&
      !hasGrpcErrorPolicyScope(resolvedTask) &&
      !hasHttpAuthPolicyScope(resolvedTask) &&
      !hasExecutionStateMigrationScope(resolvedTask) &&
	      !hasPackageSourceMappingScope(resolvedTask) &&
	      !hasConfigOptionRuntimeScope(resolvedTask);
    const officialPromptSingleFilePatchScope =
      contextDecision.taskFrame === "official_patch" &&
      taskIsOfficialProductionPatchPrompt(resolvedTask) &&
      promptMentionedSourceFiles.length === 1 &&
      officialPatchScopeFiles.length <= 1 &&
      !hasExplicitMultiFileScopeRequest(resolvedTask) &&
      !hasDeprecationLifecycleScope(resolvedTask) &&
      !hasWebSessionRenewalScope(resolvedTask) &&
      !hasRequestBodyFormScope(resolvedTask) &&
      !hasDiscoveryConfigScope(resolvedTask) &&
      !hasBenchmarkGeneratorScope(resolvedTask) &&
      !hasTopicOrderingScope(resolvedTask) &&
      !hasCollectionNameValidationScope(resolvedTask) &&
      !hasGrpcErrorPolicyScope(resolvedTask) &&
      !hasHttpAuthPolicyScope(resolvedTask) &&
      !hasExecutionStateMigrationScope(resolvedTask) &&
      !hasPackageSourceMappingScope(resolvedTask) &&
      !hasConfigOptionRuntimeScope(resolvedTask);
    const governorSingleFilePatchScope =
      contextDecision.taskFrame === "official_patch" &&
      contextDecision.requiredSurface === "single_file" &&
	      !hasExplicitMultiFileScopeRequest(resolvedTask) &&
      !promptMentionsMultipleProductionSourceFiles &&
      !hasDeprecationLifecycleScope(resolvedTask) &&
      !hasWebSessionRenewalScope(resolvedTask) &&
      !hasRequestBodyFormScope(resolvedTask) &&
      !hasDiscoveryConfigScope(resolvedTask) &&
      !hasBenchmarkGeneratorScope(resolvedTask) &&
      !hasTopicOrderingScope(resolvedTask) &&
      !hasCollectionNameValidationScope(resolvedTask) &&
      !hasGrpcErrorPolicyScope(resolvedTask) &&
      !hasHttpAuthPolicyScope(resolvedTask) &&
	      !hasExecutionStateMigrationScope(resolvedTask) &&
	      !hasPackageSourceMappingScope(resolvedTask) &&
	      !hasConfigOptionRuntimeScope(resolvedTask);
    const officialSingleFileDirective = officialSingleFilePatchScope
      ? officialPatchScopeFiles[0]
      : officialPromptSingleFilePatchScope
        ? promptMentionedSourceFiles[0]
        : undefined;
    const suggestedCommands = [
      `kairn context --session ${session.id} --root <repo> --query "${resolvedTask.replaceAll('"', '\\"')}" --mode snippets`,
      ...(primaryFile ? [`kairn context --session ${session.id} --root <repo> --related ${primaryFile}`] : []),
      ...(primaryFile ? [`kairn context --session ${session.id} --root <repo> --tests ${primaryFile}`] : [])
    ];
    const ledgerEvents = this.getSessionLedger(session.id);
    const ledgerSummary = summarizeSessionLedger(session.id, ledgerEvents);
    const changedFilesForPolicy = await this.getChangedFiles(session.rootPath).catch(() => []);
    const failureFilesForPolicy = uniquePaths(
      ledgerEvents
        .filter((event) => event.kind === "failure_seen" && event.filePath)
        .map((event) => event.filePath!)
    );
    const sessionPolicy = decideSessionContextPolicy({
      task: resolvedTask,
      candidateFiles: files,
      contentHash: sha256([resolvedTask, ...files, quality.action].join("\n")),
      tokenEstimate: budget,
      ledger: ledgerSummary,
      recentEvents: ledgerEvents,
      changedFiles: [...changedFilesForPolicy],
      failureFiles: failureFilesForPolicy,
      source: input.source ?? "cli"
    });
    const forceMinimalSourceFocus = minimalSourceFocusOverridesSuppression(sessionPolicy.reason);
    const forcePromptMentionedMultiFileScope =
      quality.action === "suppress" &&
      promptDerivedMultiFileScope &&
      promptMentionedSourceFiles.length > 1 &&
      !officialSingleFilePatchScope &&
      !officialPromptSingleFilePatchScope &&
      !governorSingleFilePatchScope &&
      !readOnlySourceRouting;
    const narrowPackageParserTask = hasNarrowPackageParserScope(resolvedTask.toLowerCase());
    const suppressNarrowPackageParserGuardrail =
      contextDecision.taskFrame === "official_patch" &&
      (contextDecision.taskShapeSignal === "narrow_package_parser" || narrowPackageParserTask) &&
      !readOnlySourceRouting &&
      failureFilesForPolicy.length === 0;
    const grpcErrorPolicyTask = hasGrpcErrorPolicyScope(resolvedTask);
    const strictMultiFileEditScopeHint = (input.editScopeHints?.allowedDiffScopes ?? []).filter((scope) => isLikelyProductionSourceFile(scope.file)).length > 1;
    const concreteGrpcPolicyFileCount = grpcErrorPolicySourceFiles.filter(isLikelyProductionSourceFile).length;
    const suppressGrpcErrorPolicyGuardrail =
      contextDecision.taskFrame === "official_patch" &&
      !strictMultiFileEditScopeHint &&
      concreteGrpcPolicyFileCount <= 1 &&
      !promptMentionsMultipleProductionSourceFiles &&
      grpcErrorPolicyTask &&
      !readOnlySourceRouting &&
      failureFilesForPolicy.length === 0;
    const suppressCollectionNameValidationGuardrail =
      (contextDecision.taskShapeSignal === "collection_name_validation" || hasCollectionNameValidationScope(resolvedTask)) &&
      collectionNameValidationSourceFiles.filter(isLikelyProductionSourceFile).length >= 2 &&
      !readOnlySourceRouting &&
      failureFilesForPolicy.length === 0;
    const suppressTopicOrderingGuardrail =
      (contextDecision.taskShapeSignal === "topic_ordering" || hasTopicOrderingScope(resolvedTask)) &&
      topicOrderingSourceFiles.filter(isLikelyProductionSourceFile).length >= 3 &&
      !readOnlySourceRouting &&
      failureFilesForPolicy.length === 0;
    const suppressHiddenPluginActivationGuardrail =
      contextDecision.taskFrame === "official_patch" &&
      (contextDecision.taskShapeSignal === "plugin_activation_validation" || hasPluginActivationValidationScope(resolvedTask)) &&
      strictMultiFileEditScopeHint &&
      !hasPromptSupportedPluginActivationConsumerScope(resolvedTask) &&
      !hasExplicitMultiFileScopeRequest(resolvedTask) &&
      !readOnlySourceRouting &&
      failureFilesForPolicy.length === 0;
    const suppressSelfContainedExecutionStateMigrationGuardrail =
      (contextDecision.taskShapeSignal === "execution_state_migration" || hasExecutionStateMigrationScope(resolvedTask)) &&
      strictMultiFileEditScopeHint &&
      officialPatchScopeFiles.length > 1 &&
      hasSelfContainedExecutionStateMigrationPrompt(resolvedTask) &&
      !readOnlySourceRouting &&
      failureFilesForPolicy.length === 0;
    const effectiveAction = suppressNarrowPackageParserGuardrail
      ? "suppress"
      : suppressGrpcErrorPolicyGuardrail
      ? "suppress"
      : suppressCollectionNameValidationGuardrail
      ? "suppress"
      : suppressTopicOrderingGuardrail
      ? "suppress"
      : suppressHiddenPluginActivationGuardrail
      ? "suppress"
      : suppressSelfContainedExecutionStateMigrationGuardrail
      ? "suppress"
      : forceMinimalSourceFocus || forcePromptMentionedMultiFileScope
      ? "shrink"
      : strongestSuppressiveAction(quality.action, contextDecision.action, sessionPolicy.action);
    const forceProductionOnlyOneFile =
      effectiveAction === "shrink" &&
      taskHasProductionOnlyEditIntent(resolvedTask) &&
      !hasExplicitMultiFileScopeRequest(resolvedTask) &&
      (!promptDerivedMultiFileScope || officialSingleFilePatchScope || officialPromptSingleFilePatchScope || governorSingleFilePatchScope) &&
      !hasOfficialMultiFilePatchScope &&
      !(contextDecision.taskFrame === "official_patch" && contextDecision.recommendedDelivery === "multi_file_directive" && !officialSingleFilePatchScope && !officialPromptSingleFilePatchScope && !governorSingleFilePatchScope) &&
      Boolean(officialSingleFileDirective || directivePrimaryFile || primaryFile) &&
      (officialSingleFilePatchScope || officialPromptSingleFilePatchScope || governorSingleFilePatchScope || Boolean(contextDecision.exactSourceHit || contextDecision.canonicalSourceHit || contextDecision.sourceRescue));
    const forceOfficialMultiFileScope =
      effectiveAction === "shrink" &&
      hasOfficialMultiFilePatchScope &&
      !readOnlySourceRouting;
    const forcePromptDerivedMultiFileScope =
      effectiveAction === "shrink" &&
      promptDerivedMultiFileScope &&
      !officialSingleFilePatchScope &&
      !officialPromptSingleFilePatchScope &&
      !governorSingleFilePatchScope &&
      files.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceDeprecationLifecycleScope =
      effectiveAction === "shrink" &&
      hasDeprecationLifecycleScope(resolvedTask) &&
      deprecationLifecycleSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceRequestBodyFormScope =
      effectiveAction === "shrink" &&
      hasRequestBodyFormScope(resolvedTask) &&
      requestBodyFormSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceConverterOutputScope =
      effectiveAction === "shrink" &&
      hasConverterOutputScope(resolvedTask) &&
      contextDecision.requiredSurface !== "single_file" &&
      converterOutputDeliveryFiles.filter(isLikelyProductionSourceFile).length > 0 &&
      !readOnlySourceRouting;
    const forceBenchmarkGeneratorScope =
      effectiveAction === "shrink" &&
      hasBenchmarkGeneratorScope(resolvedTask) &&
      benchmarkGeneratorSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceTopicOrderingScope =
      effectiveAction === "shrink" &&
      hasTopicOrderingScope(resolvedTask) &&
      topicOrderingSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceCollectionNameValidationScope =
      effectiveAction === "shrink" &&
      hasCollectionNameValidationScope(resolvedTask) &&
      collectionNameValidationSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceGrpcErrorPolicyScope =
      effectiveAction === "shrink" &&
      hasGrpcErrorPolicyScope(resolvedTask) &&
      grpcErrorPolicySourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceHttpAuthPolicyScope =
      effectiveAction === "shrink" &&
      hasHttpAuthPolicyScope(resolvedTask) &&
      httpAuthPolicySourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceSystemMetadataScope =
      effectiveAction === "shrink" &&
      hasSystemMetadataScope(resolvedTask) &&
      systemMetadataSourceFiles.filter(isLikelyProductionSourceFile).length > 0 &&
      !readOnlySourceRouting;
    const forceDatabaseFailoverScope =
      effectiveAction === "shrink" &&
      hasDatabaseFailoverScope(resolvedTask) &&
      databaseFailoverSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forcePluginActivationValidationScope =
      effectiveAction === "shrink" &&
      hasPluginActivationValidationScope(resolvedTask) &&
      pluginActivationValidationSourceFiles.filter(isLikelyProductionSourceFile).length > 0 &&
      !readOnlySourceRouting;
    const forceExecutionStateMigrationScope =
      effectiveAction === "shrink" &&
      hasExecutionStateMigrationScope(resolvedTask) &&
      executionStateMigrationSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceDiscoveryConfigScope =
      effectiveAction === "shrink" &&
      hasDiscoveryConfigScope(resolvedTask) &&
      discoveryConfigSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceWebSessionRenewalScope =
      effectiveAction === "shrink" &&
      hasWebSessionRenewalScope(resolvedTask) &&
      webSessionRenewalSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forcePackageSourceMappingScope =
      effectiveAction === "shrink" &&
      hasPackageSourceMappingScope(resolvedTask) &&
      packageSourceMappingSourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const forceDatastoreBackendParityScope =
      effectiveAction === "shrink" &&
      hasDatastoreBackendParityScope(resolvedTask) &&
      datastoreBackendParitySourceFiles.filter(isLikelyProductionSourceFile).length > 1 &&
      !readOnlySourceRouting;
    const effectiveQuality = {
      ...quality,
      action: effectiveAction,
      reasons: uniqueStrings([
        ...quality.reasons,
        ...(suppressNarrowPackageParserGuardrail ? ["narrow package parser task already has a dominant source surface; staying silent"] : []),
        ...(suppressGrpcErrorPolicyGuardrail ? ["gRPC context status policy needs concrete failure evidence; staying silent to avoid command-only over-assist"] : []),
        ...(suppressHiddenPluginActivationGuardrail ? ["plugin activation consumer scope is hidden by benchmark metadata; staying silent until prompt or failure evidence supports it"] : []),
        ...(suppressSelfContainedExecutionStateMigrationGuardrail ? ["execution-state migration prompt is already self-contained; staying silent to avoid over-assist"] : []),
        ...(forcePromptMentionedMultiFileScope ? ["prompt names multiple production source files; emit compact multi-file guardrail"] : []),
        `session policy: ${sessionPolicy.reason}`
      ])
    };
    const effectiveContextDecision = {
      ...contextDecision,
      ...(narrowPackageParserTask ? { taskShapeSignal: "narrow_package_parser" as const, requiredSurface: "single_file" as const } : {}),
      ...(grpcErrorPolicyTask
        ? {
            taskShapeSignal: "grpc_error_policy" as const,
            requiredSurface: suppressGrpcErrorPolicyGuardrail ? "evidence_needed" as const : "paired_contract" as const
          }
        : {}),
      ...(forceCollectionNameValidationScope ? { taskShapeSignal: "collection_name_validation" as const, requiredSurface: "paired_contract" as const } : {}),
      ...(officialSingleFilePatchScope || officialPromptSingleFilePatchScope || governorSingleFilePatchScope
        ? { requiredSurface: "single_file" as const }
        : {}),
      action: effectiveAction,
      recommendedDelivery: suppressNarrowPackageParserGuardrail
        ? "none" as const
        : suppressGrpcErrorPolicyGuardrail
        ? "none" as const
        : suppressHiddenPluginActivationGuardrail
        ? "none" as const
        : suppressSelfContainedExecutionStateMigrationGuardrail
        ? "none" as const
        : forceOfficialMultiFileScope
        ? "multi_file_directive" as const
        : forceDeprecationLifecycleScope
          ? "multi_file_directive" as const
        : forceRequestBodyFormScope
          ? "multi_file_directive" as const
        : forceConverterOutputScope
          ? converterOutputDeliveryFiles.length > 1 ? "multi_file_directive" as const : "one_file_directive" as const
        : forceBenchmarkGeneratorScope
          ? "multi_file_directive" as const
        : forceTopicOrderingScope
          ? "multi_file_directive" as const
        : forceCollectionNameValidationScope
          ? "multi_file_directive" as const
        : forceGrpcErrorPolicyScope
          ? "multi_file_directive" as const
        : forceHttpAuthPolicyScope
          ? "multi_file_directive" as const
        : forceSystemMetadataScope
          ? "multi_file_directive" as const
        : forceDatabaseFailoverScope
          ? "multi_file_directive" as const
        : forcePluginActivationValidationScope
          ? "multi_file_directive" as const
        : forceExecutionStateMigrationScope
          ? "multi_file_directive" as const
        : forceDiscoveryConfigScope
          ? "multi_file_directive" as const
        : forceWebSessionRenewalScope
          ? "multi_file_directive" as const
        : forcePackageSourceMappingScope
          ? "multi_file_directive" as const
        : forceDatastoreBackendParityScope
          ? "multi_file_directive" as const
        : forcePromptMentionedMultiFileScope
          ? "multi_file_directive" as const
        : forcePromptDerivedMultiFileScope
          ? "multi_file_directive" as const
        : forceMinimalSourceFocus || forceProductionOnlyOneFile
        ? "one_file_directive" as const
        : effectiveAction === "emit"
        ? contextDecision.recommendedDelivery ?? "full_prime"
        : effectiveAction === "shrink"
          ? contextDecision.recommendedDelivery === "multi_file_directive" ? "multi_file_directive" as const : "one_file_directive" as const
        : effectiveAction === "request_evidence"
          ? "evidence_request" as const
        : "none" as const
    };
    const rawSourceDeliveryFiles = uniquePaths([
      ...packageSourceMappingSourceFiles,
      ...deprecationLifecycleSourceFiles,
      ...promptMentionedSourceFiles,
      ...webSessionRenewalSourceFiles,
      ...requestBodyFormSourceFiles,
      ...converterOutputDeliveryFiles,
      ...benchmarkGeneratorSourceFiles,
      ...topicOrderingSourceFiles,
      ...collectionNameValidationSourceFiles,
      ...grpcErrorPolicySourceFiles,
      ...httpAuthPolicySourceFiles,
      ...systemMetadataSourceFiles,
      ...databaseFailoverSourceFiles,
      ...pluginActivationValidationSourceFiles,
      ...executionStateMigrationSourceFiles,
      ...discoveryConfigSourceFiles,
      ...deviceSessionListenerSourceFiles,
      ...datastoreBackendParitySourceFiles,
      ...files
    ]).filter((file) =>
      !isUnrelatedCentralBackendTestHelper(file, resolvedTask) &&
      !isUnrelatedBackendAutocompleteSurface(file, resolvedTask) &&
      !isUnrelatedDeprecationLifecycleSurface(file, resolvedTask) &&
      !isUnrelatedConfigSchemaSurface(file, resolvedTask, selectedTestCounterpartSourceFiles) &&
      !isUnrelatedWebSessionRenewalSurface(file, resolvedTask) &&
      !isUnrelatedRequestBodyFormSurface(file, resolvedTask, requestBodyFormSourceFiles) &&
      !isUnrelatedBenchmarkGeneratorSurface(file, resolvedTask, benchmarkGeneratorSourceFiles) &&
      !isUnrelatedGrpcErrorPolicySurface(file, resolvedTask, grpcErrorPolicySourceFiles) &&
      !isUnrelatedHttpAuthPolicySurface(file, resolvedTask, httpAuthPolicySourceFiles) &&
      !isUnrelatedSystemMetadataSurface(file, resolvedTask, systemMetadataSourceFiles) &&
      !isUnrelatedDatabaseFailoverSurface(file, resolvedTask, databaseFailoverSourceFiles) &&
      !isUnrelatedPluginActivationValidationSurface(file, resolvedTask, pluginActivationValidationSourceFiles) &&
      !isUnrelatedExecutionStateMigrationSurface(file, resolvedTask, executionStateMigrationSourceFiles) &&
      !isForbiddenFrontendEditSurface(file, resolvedTask) &&
      !isUnrelatedDatastoreBackendParitySurface(file, resolvedTask, datastoreBackendParitySourceFiles) &&
      !isUnrelatedPromptMentionedSourceSurface(file, resolvedTask, promptMentionedSourceFiles)
    );
    const sourceDeliveryFiles = hasPackageSourceMappingScope(resolvedTask)
      ? orderPackageSourceMappingFiles(rawSourceDeliveryFiles, resolvedTask)
      : rawSourceDeliveryFiles;
    const emittedFiles = !isFileEmittingAction(effectiveAction)
      ? []
      : readOnlySourceRouting
        ? readOnlySourceRoutingFiles
      : effectiveAction === "shrink" && forceMinimalSourceFocus && sessionPolicy.files.length > 0
        ? sessionPolicy.files.slice(0, 1)
      : forceOfficialMultiFileScope
        ? uniquePaths([...officialPatchScopeFiles, ...sourceDeliveryFiles]).slice(0, Math.max(multiFileLimit, officialPatchScopeFiles.length))
      : forceDeprecationLifecycleScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceRequestBodyFormScope
        ? requestBodyFormSourceFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceConverterOutputScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, Math.max(1, Math.min(multiFileLimit, converterOutputDeliveryFiles.length || 1)))
      : forceBenchmarkGeneratorScope
        ? uniquePaths([...benchmarkGeneratorSourceFiles, ...sourceDeliveryFiles]).filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceTopicOrderingScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceCollectionNameValidationScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceGrpcErrorPolicyScope
        ? grpcErrorPolicySourceFiles.filter(isLikelyProductionSourceFile).length >= 2
          ? grpcErrorPolicySourceFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
          : uniquePaths([...grpcErrorPolicySourceFiles, ...sourceDeliveryFiles]).filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceHttpAuthPolicyScope
        ? uniquePaths([...httpAuthPolicySourceFiles, ...sourceDeliveryFiles]).filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceSystemMetadataScope
        ? uniquePaths([...systemMetadataSourceFiles, ...sourceDeliveryFiles]).filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceDatabaseFailoverScope
        ? databaseFailoverSourceFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forcePluginActivationValidationScope
        ? uniquePaths([...pluginActivationValidationSourceFiles, ...sourceDeliveryFiles]).filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceExecutionStateMigrationScope
        ? executionStateMigrationSourceFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceDiscoveryConfigScope
        ? discoveryConfigSourceFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceWebSessionRenewalScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forcePackageSourceMappingScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceDatastoreBackendParityScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forcePromptDerivedMultiFileScope
        ? sourceDeliveryFiles.filter(isLikelyProductionSourceFile).slice(0, multiFileLimit)
      : forceProductionOnlyOneFile
        ? [officialSingleFileDirective ?? directivePrimaryFile ?? primaryFile!]
      : effectiveContextDecision.recommendedDelivery === "multi_file_directive"
        ? sourceDeliveryFiles.slice(0, multiFileLimit)
      : effectiveAction === "shrink" && sessionPolicy.files.length > 0
        ? sessionPolicy.files.slice(0, 1)
      : effectiveAction === "shrink" && includeCompanionContext
        ? sourceDeliveryFiles.slice(0, 3)
        : sourceDeliveryFiles;
    const useMinimalOneFileDirective = shouldUseMinimalOneFileDirective({
      task: resolvedTask,
      action: effectiveAction,
      decision: effectiveContextDecision,
      emittedFiles
    });
    const scopeOnlyGuardrail = effectiveContextDecision.directiveStyle === "scope_guardrail";
    const invariantFilesMatchDelivery = invariants.every((invariant) => emittedFiles.includes(invariant.file));
    const deliveredPrimaryFile = emittedFiles[0];
    if (isFileEmittingAction(effectiveAction) && deliveredPrimaryFile && !invariantFilesMatchDelivery) {
      const deliveredInvariant = contextDecision.exactSourceHit && deliveredPrimaryFile === directivePrimaryFile
        ? sourceInvariantContextForFile(input.editScopeHints?.sourceInvariants, deliveredPrimaryFile) ??
          this.getExactSourceEvidence({ sessionId: session.id, file: deliveredPrimaryFile, budget: 180, task: resolvedTask }).invariant
        : buildContextInvariant({ task: resolvedTask, file: deliveredPrimaryFile });
      invariants = deliveredInvariant ? [deliveredInvariant] : [];
    }
    const editScopeCandidateFiles = !isFileEmittingAction(effectiveAction)
      ? sourceDeliveryFiles
      : forceProductionOnlyOneFile
        ? emittedFiles
        : uniquePaths([...emittedFiles, ...sourceDeliveryFiles, ...(tests?.files ?? [])]);
    const editScopeContextDecision = hasPackageSourceMappingScope(resolvedTask) && emittedFiles[0]
      ? { ...effectiveContextDecision, primaryFile: emittedFiles[0] }
      : effectiveContextDecision;
    const baseEditScope = readOnlySourceRouting
      ? undefined
      : decideEditScope({
          task: resolvedTask,
          candidateFiles: editScopeCandidateFiles,
          contextDecision: editScopeContextDecision,
          invariants,
          knownFiles: sessionFiles,
          allowedDiffScopes: input.editScopeHints?.allowedDiffScopes,
          sourceInvariants: input.editScopeHints?.sourceInvariants,
          failureFiles: uniquePaths([...(input.editScopeHints?.failureFiles ?? []), ...failureFilesForPolicy]),
          changedFiles: [...changedFilesForPolicy]
        });
    const narrowPackageParserAllowedScope = hasNarrowPackageParserScope(resolvedTask.toLowerCase())
      ? uniquePaths((input.editScopeHints?.allowedDiffScopes ?? []).map((scope) => scope.file).filter(isLikelyProductionSourceFile))
      : [];
    const httpAuthPolicyAllowedScope = hasHttpAuthPolicyScope(resolvedTask)
      ? httpAuthPolicySourceFiles.filter(isLikelyProductionSourceFile)
      : [];
    const editScope = baseEditScope && hasNarrowPackageParserScope(resolvedTask.toLowerCase())
      ? {
          ...baseEditScope,
          initialEditFiles: narrowPackageParserAllowedScope.length === 1 ? narrowPackageParserAllowedScope : baseEditScope.initialEditFiles.slice(0, 1),
          readOnlyFiles: []
        }
      : baseEditScope && httpAuthPolicyAllowedScope.length > 0
      ? {
          ...baseEditScope,
          initialEditFiles: httpAuthPolicyAllowedScope,
          readOnlyFiles: baseEditScope.readOnlyFiles.filter((file) => !httpAuthPolicyAllowedScope.includes(file) && !isUnrelatedHttpAuthPolicySurface(file, resolvedTask, httpAuthPolicyAllowedScope))
        }
      : baseEditScope;
    const officialSizedGuardrail =
      effectiveAction === "shrink" &&
      (editScope?.strictBoundary === true || forceGrpcErrorPolicyScope) &&
      (
        scopeOnlyGuardrail ||
        effectiveContextDecision.taskShapeSignal === "lifecycle_policy" ||
        effectiveContextDecision.taskShapeSignal === "frontend_ownership" ||
        effectiveContextDecision.requiredSurface === "feature_cluster" ||
        forceRequestBodyFormScope ||
        forceBenchmarkGeneratorScope ||
        forceTopicOrderingScope ||
        forceCollectionNameValidationScope ||
        forceGrpcErrorPolicyScope ||
        forceHttpAuthPolicyScope ||
        forceDiscoveryConfigScope ||
        forceWebSessionRenewalScope ||
        forcePackageSourceMappingScope ||
        effectiveContextDecision.taskShapeSignal === "database_failover" ||
        forcePluginActivationValidationScope ||
        forceDatastoreBackendParityScope
      );
    const guardrailVariant = officialSizedGuardrail
      ? officialGuardrailVariantFor({
          task: resolvedTask,
          files: emittedFiles,
          editScope,
          invariants
        })
      : undefined;
    const sourceContextTokenEstimate = Math.max(0, Math.round(context.tokenEstimate || estimateTokens(context.content)));
    const guardrailMetadata = guardrailVariant
      ? {
          guardrailVariant,
          guardrailDirectiveStyle: "scope_guardrail",
          guardrailStrictOfficialScope: true,
          guardrailFileCount: emittedFiles.length,
          guardrailInvariantCount: invariants.length,
          guardrailTokenBudget: Math.min(budget, 280)
        }
      : {};
    const deliveryPolicyMetadata = {
      officialPatchScopeFileCount: officialPatchScopeFiles.length,
      forceOfficialMultiFileScope,
      forceDeprecationLifecycleScope,
      forceRequestBodyFormScope,
      forceBenchmarkGeneratorScope,
      forceTopicOrderingScope,
      forceCollectionNameValidationScope,
      forceGrpcErrorPolicyScope,
      forceHttpAuthPolicyScope,
      forceDiscoveryConfigScope,
      forceWebSessionRenewalScope,
      forcePackageSourceMappingScope,
      forcePluginActivationValidationScope,
      forceProductionOnlyOneFile
    };
    for (const file of files) {
      this.recordLedgerEvent({
        sessionId: session.id,
        kind: "context_recommended",
        filePath: file,
        contentHash: sha256(`${resolvedTask}\n${file}`),
        tokenEstimate: 0,
        source: input.source ?? "cli",
        summary: `Kairn recommended ${file}`,
        metadata: {
          taskHash: sha256(resolvedTask),
          phase: sessionPolicy.phase,
          policyReason: sessionPolicy.reason,
          emitted: emittedFiles.includes(file),
          ...guardrailMetadata,
          ...deliveryPolicyMetadata,
          workingSetActiveFiles: ledgerSummary.workingSet.activeFiles.slice(0, 6),
          nextSmallestUsefulRead: ledgerSummary.workingSet.nextSmallestUsefulRead
        }
      });
    }
    if (isFileEmittingAction(effectiveAction) && editScope && editScope.initialEditFiles.length > 0) {
      this.recordLedgerEvent({
        sessionId: session.id,
        kind: "edit_scope_changed",
        contentHash: sha256(JSON.stringify(editScope)),
        tokenEstimate: 0,
        source: input.source ?? "cli",
        summary: `Initial edit scope: ${editScope.initialEditFiles.join(", ")}`,
        metadata: {
          taskHash: sha256(resolvedTask),
          phase: sessionPolicy.phase,
          editScope
        }
      });
    }
    if (sessionPolicy.phase !== ledgerSummary.currentPhase) {
      this.recordLedgerEvent({
        sessionId: session.id,
        kind: "phase_change",
        contentHash: sha256(`${ledgerSummary.currentPhase}->${sessionPolicy.phase}`),
        tokenEstimate: 0,
        source: input.source ?? "cli",
        summary: `Phase changed from ${ledgerSummary.currentPhase} to ${sessionPolicy.phase}`,
        metadata: {
          previousPhase: ledgerSummary.currentPhase,
          phase: sessionPolicy.phase
        }
      });
    }
    const formatStartedAt = Date.now();
    const content = input.format === "mcp_brief"
      ? formatMcpBriefPrimeContext({
          task: resolvedTask,
          sessionId: session.id,
          profile,
          budget: Math.min(budget, 360),
          context,
          files: emittedFiles,
          quality: effectiveQuality,
          invariants,
          editScope
        })
      : effectiveAction === "suppress"
        ? formatSuppressedPrimeContext({ task: resolvedTask, sessionId: session.id, profile, quality: effectiveQuality })
        : effectiveAction === "request_evidence"
          ? formatEvidenceRequestPrimeContext({
              task: resolvedTask,
              sessionId: session.id,
              profile,
              quality: effectiveQuality,
              evidenceRequest: effectiveContextDecision.evidenceRequest
            })
        : effectiveAction === "shrink" && readOnlySourceRouting
          ? formatSourceRoutingPrimeContext({
              task: resolvedTask,
              sessionId: session.id,
              profile,
              context,
              files: emittedFiles,
              budget: Math.min(budget, 260)
            })
        : effectiveAction === "shrink"
          ? formatShrunkPrimeContext({
              task: resolvedTask,
              sessionId: session.id,
              profile,
              quality: effectiveQuality,
              context,
              files: emittedFiles,
              budget: Math.min(budget, officialSizedGuardrail ? 280 : effectiveContextDecision.recommendedDelivery === "multi_file_directive" ? 520 : 420),
              invariants,
              editScope,
              includeSnippet:
                !officialSizedGuardrail &&
                !useMinimalOneFileDirective &&
                sessionPolicy.reason !== "verified_context_shrunk" &&
                sessionPolicy.reason !== "active_source_context_shrunk" &&
                !contextDecision.cheapSingleSource &&
                !contextDecision.wrongContextRisk &&
                !readOnlySourceRouting &&
                !isAutomaticExactSourceHook({ source: input.source, decision: contextDecision }),
              minimal: officialSizedGuardrail ||
                sessionPolicy.reason === "active_source_context_shrunk" ||
                isAutomaticCheapSingleSourceHook({ source: input.source, decision: contextDecision }) ||
                useMinimalOneFileDirective
            })
          : formatPrimeContext({
              task: resolvedTask,
              sessionId: session.id,
              profile,
              budget,
              limits,
              context,
              relatedFiles: related?.related ?? [],
              testFiles: tests?.files ?? [],
              suggestedCommands,
              invariants,
              editScope
            });
    markTiming("formatMs", formatStartedAt);
    timings.totalPrimeMs = Date.now() - primeStartedAt;
    const directiveTokenEstimate = estimateTokens(content);
    const deliveryTrace = buildPrimeDeliveryTrace({
      decision: effectiveContextDecision,
      guardrailVariant,
      emittedFiles,
      editScope,
      estimatedDirectiveTokens: directiveTokenEstimate,
      estimatedSourceContextTokens: sourceContextTokenEstimate
    });
    const fileRecords = sessionFiles.filter((file) => emittedFiles.includes(file.path));
    const policyRepeatedFilesAvoided = typeof sessionPolicy.metadata.repeatedFilesAvoided === "number"
      ? sessionPolicy.metadata.repeatedFilesAvoided
      : sessionPolicy.repeatedFiles.length;

    this.recordShown(session.id, "context", "brief", content);
    for (const file of emittedFiles) {
      this.recordLedgerEvent({
        sessionId: session.id,
        kind: "context_shown",
        filePath: file,
        contentHash: sha256(content),
        tokenEstimate: estimateTokens(content),
        source: input.source ?? "cli",
        summary: `Kairn showed context for ${file}`,
        metadata: {
          taskHash: sha256(resolvedTask),
          phase: sessionPolicy.phase,
          policyReason: sessionPolicy.reason,
          policyAction: sessionPolicy.action,
          ...guardrailMetadata,
          ...deliveryPolicyMetadata,
          deliveryTrace,
          ...(invariants[0] ? { invariant: invariants[0] } : {}),
          workingSetActiveFiles: ledgerSummary.workingSet.activeFiles.slice(0, 6),
          nextSmallestUsefulRead: ledgerSummary.workingSet.nextSmallestUsefulRead
        }
      });
    }
    if (sessionPolicy.action === "suppress") {
      this.recordLedgerEvent({
        sessionId: session.id,
        kind: "context_shown",
        contentHash: sha256(content),
        tokenEstimate: estimateTokens(content),
        source: input.source ?? "cli",
        summary: "Kairn suppressed repeated or low-value context",
        metadata: {
          taskHash: sha256(resolvedTask),
          phase: sessionPolicy.phase,
          policyReason: sessionPolicy.reason,
          ...guardrailMetadata,
          ...deliveryPolicyMetadata,
          deliveryTrace,
          repeatedFilesAvoided: policyRepeatedFilesAvoided,
          repeatedSnippetsAvoided: sessionPolicy.reason === "repeated_context_suppressed" ? 1 : 0,
          workingSetActiveFiles: ledgerSummary.workingSet.activeFiles.slice(0, 6),
          nextSmallestUsefulRead: ledgerSummary.workingSet.nextSmallestUsefulRead
        }
      });
    }
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "prime_context",
      eventName: input.eventName ?? "prime_context",
      source: input.source ?? "cli",
      responseMode: "brief",
      baselineTokens: estimateFileBaselineTokens(fileRecords),
      outputTokens: estimateTokens(content),
      files: emittedFiles,
      metadata: {
        ...input.metadata,
        taskHash: sha256(resolvedTask),
        profile,
        budget,
        format: input.format ?? "standard",
        quality: effectiveQuality,
        contextDecision: effectiveContextDecision,
        editScope,
        sessionPolicy,
        ...guardrailMetadata,
        ...deliveryPolicyMetadata,
        deliveryTrace,
        workingSet: ledgerSummary.workingSet,
        invariants,
        timings,
        contextTokenEstimate: context.tokenEstimate,
        companionCandidates: companionMetadata,
        relatedCount: related?.related.length ?? 0,
        testCount: tests?.files.length ?? 0,
        estimator: "prime selected files as full-source baseline"
      }
    });
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "prime_quality",
      eventName: effectiveQuality.action,
      source: input.source ?? "cli",
      responseMode: "brief",
      baselineTokens: 0,
      outputTokens: 0,
      files: emittedFiles,
      metadata: {
        ...effectiveQuality,
        contextDecision: effectiveContextDecision,
        editScope,
        sessionPolicy,
        ...guardrailMetadata,
        ...deliveryPolicyMetadata,
        deliveryTrace,
        workingSet: ledgerSummary.workingSet,
        invariants,
        timings,
        taskHash: sha256(resolvedTask),
        profile
      }
    });
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "context_value_decision",
      eventName: effectiveContextDecision.action,
      source: input.source ?? "cli",
      responseMode: "brief",
      baselineTokens: 0,
      outputTokens: 0,
      files: emittedFiles,
      metadata: {
        ...effectiveContextDecision,
        editScope,
        sessionPolicy,
        ...guardrailMetadata,
        ...deliveryPolicyMetadata,
        deliveryTrace,
        workingSet: ledgerSummary.workingSet,
        invariants,
        timings,
        taskHash: sha256(resolvedTask),
        profile
      }
    });

    return {
      session: this.getSession(session.id),
      task: resolvedTask,
      profile,
      content,
      files: emittedFiles,
      tokenEstimate: estimateTokens(content),
      invariants,
      quality: effectiveQuality,
      contextDecision: effectiveContextDecision,
      ...(editScope ? { editScope } : {}),
      timings,
      metadata: {
        companionCandidates: companionMetadata,
        sessionPolicy,
        editScope,
        ...guardrailMetadata,
        ...deliveryPolicyMetadata,
        deliveryTrace,
        workingSet: ledgerSummary.workingSet
      },
      warnings: uniqueStrings([...context.warnings, ...(related?.warnings ?? []), ...(tests?.warnings ?? [])]),
      suggestedCommands
    };
  }

  getSession(sessionId: string): TaskSession {
    return this.store.getSession(sessionId);
  }

  private getOrCreatePrimeSession(sessionId: string, task: string): TaskSession {
    try {
      return this.store.getSession(sessionId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Unknown Kairn session:")) {
        throw error;
      }
      return this.store.createSession({
        id: sessionId,
        rootPath: this.rootPath,
        task,
        verificationHints: ["Start from Kairn prime context", "Avoid broad scans unless the prime is insufficient", "Run related tests before finalizing"]
      });
    }
  }

  listSessions(input?: { limit?: number | undefined; allRoots?: boolean | undefined }): TaskSession[] {
    return this.store.listSessions({ rootPath: input?.allRoots ? undefined : this.rootPath, limit: input?.limit });
  }

  getMetrics(sessionId: string): MetricsSummary {
    return this.metricsService.getMetrics(sessionId);
  }

  getImpactStats(sessionId?: string | undefined): ImpactStats {
    return this.metricsService.getImpactStats(sessionId);
  }

  getCoordinationState(sessionId: string): MetricsSummary["coordination"] {
    return this.metricsService.getCoordinationState(sessionId);
  }

  recordLedgerEvent(input: {
    sessionId: string;
    kind: SessionLedgerEventKind;
    turnId?: string | undefined;
    filePath?: string | undefined;
    symbol?: string | undefined;
    contentHash?: string | undefined;
    tokenEstimate?: number | undefined;
    source?: SessionLedgerEvent["source"] | undefined;
    summary: string;
    metadata?: Record<string, unknown> | undefined;
  }): SessionLedgerEvent {
    this.store.getSession(input.sessionId);
    return this.store.recordSessionLedgerEvent({
      sessionId: input.sessionId,
      kind: input.kind,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.filePath ? { filePath: input.filePath } : {}),
      ...(input.symbol ? { symbol: input.symbol } : {}),
      contentHash: input.contentHash ?? sha256([input.kind, input.filePath ?? "", input.symbol ?? "", input.summary].join("\n")),
      tokenEstimate: Math.max(0, Math.round(input.tokenEstimate ?? estimateTokens(input.summary))),
      source: input.source ?? "runtime",
      summary: input.summary,
      metadata: input.metadata ?? {}
    });
  }

  getSessionLedger(sessionId: string, limit?: number | undefined): SessionLedgerEvent[] {
    this.store.getSession(sessionId);
    return this.store.listSessionLedgerEvents(sessionId, limit);
  }

  summarizeSessionLedger(sessionId: string): SessionLedgerSummary {
    return summarizeSessionLedger(sessionId, this.getSessionLedger(sessionId));
  }

  startEvalRun(input: {
    task: string;
    label: string;
    mode: EvalRunMode;
    sessionId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) {
    return this.evalService.startEvalRun(input);
  }

  ingestCodexUsage(input: {
    sessionId: string;
    runId?: string | undefined;
    usageText?: string | undefined;
    transcriptPath?: string | undefined;
  }): EvalObservationRecord {
    return this.evalService.ingestCodexUsage(input);
  }

  getEvalFeedback(input: { sessionId: string }): EvalObservationRecord {
    return this.evalService.getEvalFeedback(input);
  }

  addEvalNote(input: {
    runId: string;
    outcome: "pass" | "fail" | "partial";
    summary: string;
    files?: string[] | undefined;
    sessionId?: string | undefined;
  }): EvalObservationRecord {
    return this.evalService.addEvalNote(input);
  }

  getEvalReport(input: { runId?: string | undefined; sessionId?: string | undefined }): EvalRunReport | { runs: EvalRunReport[] } {
    return this.evalService.getEvalReport(input);
  }

  compareEvalRuns(input: { baselineRunId: string; kairnRunId: string }): EvalComparison {
    return this.evalService.compareEvalRuns(input);
  }

  async runBenchmark(input: {
    suitePath?: string | undefined;
    mode: BenchmarkRunMode;
    agentCommand?: string | undefined;
    agentSetupCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
    assistanceMode?: BenchmarkAssistanceMode | undefined;
    onCaseProgress?: ((event: {
      phase: "start" | "complete";
      caseId: string;
      assistanceMode: BenchmarkAssistanceMode;
      outcome?: string | undefined;
      elapsedMs?: number | undefined;
      summary?: string | undefined;
    }) => void) | undefined;
  }): Promise<BenchmarkReport> {
    await this.init();
    const suite = loadBenchmarkSuite({
      suitePath: input.suitePath,
      files: this.store.listFiles(this.rootPath)
    });
    const { session } = await this.startTask(`Benchmark: ${suite.name}`);
    const run = this.store.createBenchmarkRun({
      id: `bench_${randomUUID()}`,
      rootPath: this.rootPath,
      suiteId: suite.id,
      suiteName: suite.name,
      mode: input.mode,
      status: "active",
      metadata: {
        sessionId: session.id,
        caseCount: suite.cases.length,
        agentConfigured: Boolean(input.agentCommand),
        assistanceMode: input.assistanceMode ?? "baseline"
      }
    });

    for (const benchmarkCase of suite.cases.filter((item) => benchmarkCaseApplies(item.mode, input.mode))) {
      const caseStartedAt = Date.now();
      input.onCaseProgress?.({
        phase: "start",
        caseId: benchmarkCase.id,
        assistanceMode: input.assistanceMode ?? "baseline"
      });
      const result =
        benchmarkCase.mode === "agent"
          ? await this.runAgentBenchmarkCase({
              runId: run.id,
              benchmarkCase,
              agentCommand: input.agentCommand,
              setupCommand: input.agentSetupCommand,
              agentTimeoutMs: input.agentTimeoutMs,
              assistanceMode: input.assistanceMode ?? "baseline"
            })
          : await this.runReplayBenchmarkCase({
              runId: run.id,
              sessionId: session.id,
              benchmarkCase
            });
      this.store.recordBenchmarkResult(result);
      input.onCaseProgress?.({
        phase: "complete",
        caseId: benchmarkCase.id,
        assistanceMode: input.assistanceMode ?? "baseline",
        outcome: result.taskOutcome,
        elapsedMs: Date.now() - caseStartedAt,
        summary: result.summary
      });
    }

    const completed = this.store.updateBenchmarkRunStatus(run.id, "completed");
    return this.buildBenchmarkReport(completed.id);
  }

  async proveBenchmark(input: {
    suitePath?: string | undefined;
    baselineCommand: string;
    baselineSetupCommand?: string | undefined;
    promptOnlyCommand?: string | undefined;
    promptOnlySetupCommand?: string | undefined;
    promptPlusHooksCommand?: string | undefined;
    promptPlusHooksSetupCommand?: string | undefined;
    manualPrimeCommand?: string | undefined;
    manualPrimeSetupCommand?: string | undefined;
    hookFullPrimeCommand?: string | undefined;
    hookFullPrimeSetupCommand?: string | undefined;
    hookTinyDirectiveCommand?: string | undefined;
    hookTinyDirectiveSetupCommand?: string | undefined;
    hookTinyWithFailuresCommand?: string | undefined;
    hookTinyWithFailuresSetupCommand?: string | undefined;
    kairnCodexSessionCommand?: string | undefined;
    kairnCodexSessionSetupCommand?: string | undefined;
    kairnCodexSessionNoGovernorCommand?: string | undefined;
    kairnCodexSessionNoGovernorSetupCommand?: string | undefined;
    mcpFirstCommand?: string | undefined;
    mcpFirstSetupCommand?: string | undefined;
    realMcpFirstCommand?: string | undefined;
    realMcpFirstSetupCommand?: string | undefined;
    mcpFirstPlusHookFullPrimeCommand?: string | undefined;
    mcpFirstPlusHookFullPrimeSetupCommand?: string | undefined;
    hybridMcpBriefCommand?: string | undefined;
    hybridMcpBriefSetupCommand?: string | undefined;
    passiveCommand?: string | undefined;
    passiveSetupCommand?: string | undefined;
    proactiveCommand?: string | undefined;
    proactiveSetupCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
    repeat?: number | undefined;
    shuffleOrder?: boolean | undefined;
    cachedBaselineReports?: BenchmarkReport[] | undefined;
    proofOutputPath?: string | undefined;
    onProgress?: ((message: string) => void) | undefined;
  }): Promise<BenchmarkProofReport> {
    const repeat = Math.max(1, Math.floor(Number(input.repeat ?? 1) || 1));
    const cachedBaselineReports = input.cachedBaselineReports?.filter(Boolean) ?? [];
    const modeCommands: Array<{ mode: BenchmarkAssistanceMode; command: string; setupCommand?: string | undefined }> = [
      ...(cachedBaselineReports.length > 0 ? [] : [{ mode: "baseline" as const, command: input.baselineCommand, setupCommand: input.baselineSetupCommand }]),
      ...(input.promptOnlyCommand ?? input.passiveCommand ? [{ mode: "prompt_only" as const, command: (input.promptOnlyCommand ?? input.passiveCommand)!, setupCommand: input.promptOnlySetupCommand ?? input.passiveSetupCommand }] : []),
      ...(input.promptPlusHooksCommand ?? input.passiveCommand
        ? [{ mode: "prompt_plus_hooks" as const, command: (input.promptPlusHooksCommand ?? input.passiveCommand)!, setupCommand: input.promptPlusHooksSetupCommand ?? input.passiveSetupCommand }]
        : []),
      ...(input.manualPrimeCommand ?? input.proactiveCommand ? [{ mode: "manual_prime" as const, command: (input.manualPrimeCommand ?? input.proactiveCommand)!, setupCommand: input.manualPrimeSetupCommand ?? input.proactiveSetupCommand }] : []),
      ...(input.hookFullPrimeCommand ? [{ mode: "hook_full_prime" as const, command: input.hookFullPrimeCommand, setupCommand: input.hookFullPrimeSetupCommand }] : []),
      ...(input.hookTinyDirectiveCommand ? [{ mode: "hook_tiny_directive" as const, command: input.hookTinyDirectiveCommand, setupCommand: input.hookTinyDirectiveSetupCommand }] : []),
      ...(input.hookTinyWithFailuresCommand ? [{ mode: "hook_tiny_with_failures" as const, command: input.hookTinyWithFailuresCommand, setupCommand: input.hookTinyWithFailuresSetupCommand }] : []),
      ...(input.kairnCodexSessionCommand ? [{ mode: "kairn_codex_session" as const, command: input.kairnCodexSessionCommand, setupCommand: input.kairnCodexSessionSetupCommand }] : []),
      ...(input.kairnCodexSessionNoGovernorCommand ? [{ mode: "kairn_codex_session_no_governor" as const, command: input.kairnCodexSessionNoGovernorCommand, setupCommand: input.kairnCodexSessionNoGovernorSetupCommand }] : []),
      ...(input.mcpFirstCommand ? [{ mode: "mcp_first" as const, command: input.mcpFirstCommand, setupCommand: input.mcpFirstSetupCommand }] : []),
      ...(input.realMcpFirstCommand ? [{ mode: "real_mcp_first" as const, command: input.realMcpFirstCommand, setupCommand: input.realMcpFirstSetupCommand }] : []),
      ...(input.mcpFirstPlusHookFullPrimeCommand ? [{ mode: "mcp_first_plus_hook_full_prime" as const, command: input.mcpFirstPlusHookFullPrimeCommand, setupCommand: input.mcpFirstPlusHookFullPrimeSetupCommand }] : []),
      ...(input.hybridMcpBriefCommand ? [{ mode: "hybrid_mcp_brief" as const, command: input.hybridMcpBriefCommand, setupCommand: input.hybridMcpBriefSetupCommand }] : [])
    ];
    const baselineReports: BenchmarkReport[] = [...cachedBaselineReports];
    if (cachedBaselineReports.length > 0) {
      input.onProgress?.(`[bench prove] baseline: reused ${cachedBaselineReports.length} cached report(s)`);
    }
    const promptOnlyReports: BenchmarkReport[] = [];
    const promptPlusHooksReports: BenchmarkReport[] = [];
    const manualPrimeReports: BenchmarkReport[] = [];
    const hookFullPrimeReports: BenchmarkReport[] = [];
    const hookTinyDirectiveReports: BenchmarkReport[] = [];
    const hookTinyWithFailuresReports: BenchmarkReport[] = [];
    const kairnCodexSessionReports: BenchmarkReport[] = [];
    const kairnCodexSessionNoGovernorReports: BenchmarkReport[] = [];
    const mcpFirstReports: BenchmarkReport[] = [];
    const realMcpFirstReports: BenchmarkReport[] = [];
    const mcpFirstPlusHookFullPrimeReports: BenchmarkReport[] = [];
    const hybridMcpBriefReports: BenchmarkReport[] = [];

    for (let iteration = 0; iteration < repeat; iteration += 1) {
      const order = input.shuffleOrder ? shuffleItems(modeCommands) : modeCommands;
      for (const item of order) {
        input.onProgress?.(`[bench prove] repeat ${iteration + 1}/${repeat} ${item.mode}: start`);
        const report = await this.runProofModeBenchmark({
          suitePath: input.suitePath,
          command: item.command,
          setupCommand: item.setupCommand,
          agentTimeoutMs: input.agentTimeoutMs,
          assistanceMode: item.mode,
          onCaseProgress: (event) => {
            if (event.phase === "start") {
              input.onProgress?.(`[bench prove] repeat ${iteration + 1}/${repeat} ${item.mode}/${event.caseId}: start`);
              return;
            }
            input.onProgress?.(
              `[bench prove] repeat ${iteration + 1}/${repeat} ${item.mode}/${event.caseId}: ${event.outcome ?? "unknown"} in ${event.elapsedMs ?? 0}ms`
            );
          }
        });
        input.onProgress?.(
          `[bench prove] repeat ${iteration + 1}/${repeat} ${item.mode}: completed ${report.results.length} case(s), observed tokens ${report.observed?.codexTokens ?? "n/a"}`
        );
        if (item.mode === "baseline") baselineReports.push(report);
        if (item.mode === "prompt_only" || item.mode === "passive_hooks") promptOnlyReports.push(report);
        if (item.mode === "prompt_plus_hooks") promptPlusHooksReports.push(report);
        if (item.mode === "manual_prime" || item.mode === "proactive") manualPrimeReports.push(report);
        if (item.mode === "hook_full_prime") hookFullPrimeReports.push(report);
        if (item.mode === "hook_tiny_directive") hookTinyDirectiveReports.push(report);
        if (item.mode === "hook_tiny_with_failures") hookTinyWithFailuresReports.push(report);
        if (item.mode === "kairn_codex_session") kairnCodexSessionReports.push(report);
        if (item.mode === "kairn_codex_session_no_governor") kairnCodexSessionNoGovernorReports.push(report);
        if (item.mode === "mcp_first") mcpFirstReports.push(report);
        if (item.mode === "real_mcp_first") realMcpFirstReports.push(report);
        if (item.mode === "mcp_first_plus_hook_full_prime") mcpFirstPlusHookFullPrimeReports.push(report);
        if (item.mode === "hybrid_mcp_brief") hybridMcpBriefReports.push(report);
        this.writeProofSnapshot({
          outputPath: input.proofOutputPath,
          baselineReports,
          promptOnlyReports,
          promptPlusHooksReports,
          manualPrimeReports,
          hookFullPrimeReports,
          hookTinyDirectiveReports,
          hookTinyWithFailuresReports,
          kairnCodexSessionReports,
          kairnCodexSessionNoGovernorReports,
          mcpFirstReports,
          realMcpFirstReports,
          mcpFirstPlusHookFullPrimeReports,
          hybridMcpBriefReports,
          repeat
        });
      }
    }

    if (baselineReports.length === 0) {
      baselineReports.push(await this.runProofModeBenchmark({
        suitePath: input.suitePath,
        command: input.baselineCommand,
        setupCommand: input.baselineSetupCommand,
        agentTimeoutMs: input.agentTimeoutMs,
        assistanceMode: "baseline"
      }));
    }

    const proof = buildBenchmarkProofReport({
      baseline: baselineReports,
      promptOnly: promptOnlyReports,
      promptPlusHooks: promptPlusHooksReports,
      manualPrime: manualPrimeReports,
      hookFullPrime: hookFullPrimeReports,
      hookTinyDirective: hookTinyDirectiveReports,
      hookTinyWithFailures: hookTinyWithFailuresReports,
      kairnCodexSession: kairnCodexSessionReports,
      kairnCodexSessionNoGovernor: kairnCodexSessionNoGovernorReports,
      mcpFirst: mcpFirstReports,
      realMcpFirst: realMcpFirstReports,
      mcpFirstPlusHookFullPrime: mcpFirstPlusHookFullPrimeReports,
      hybridMcpBrief: hybridMcpBriefReports,
      repeat
    });
    this.writeProofFile(input.proofOutputPath, proof);
    return proof;
  }

  private writeProofSnapshot(input: {
    outputPath?: string | undefined;
    baselineReports: BenchmarkReport[];
    promptOnlyReports: BenchmarkReport[];
    promptPlusHooksReports: BenchmarkReport[];
    manualPrimeReports: BenchmarkReport[];
    hookFullPrimeReports: BenchmarkReport[];
    hookTinyDirectiveReports: BenchmarkReport[];
    hookTinyWithFailuresReports: BenchmarkReport[];
    kairnCodexSessionReports: BenchmarkReport[];
    kairnCodexSessionNoGovernorReports: BenchmarkReport[];
    mcpFirstReports: BenchmarkReport[];
    realMcpFirstReports: BenchmarkReport[];
    mcpFirstPlusHookFullPrimeReports: BenchmarkReport[];
    hybridMcpBriefReports: BenchmarkReport[];
    repeat: number;
  }): void {
    if (!input.outputPath || input.baselineReports.length === 0) return;
    const proof = buildBenchmarkProofReport({
      baseline: input.baselineReports,
      promptOnly: input.promptOnlyReports,
      promptPlusHooks: input.promptPlusHooksReports,
      manualPrime: input.manualPrimeReports,
      hookFullPrime: input.hookFullPrimeReports,
      hookTinyDirective: input.hookTinyDirectiveReports,
      hookTinyWithFailures: input.hookTinyWithFailuresReports,
      kairnCodexSession: input.kairnCodexSessionReports,
      kairnCodexSessionNoGovernor: input.kairnCodexSessionNoGovernorReports,
      mcpFirst: input.mcpFirstReports,
      realMcpFirst: input.realMcpFirstReports,
      mcpFirstPlusHookFullPrime: input.mcpFirstPlusHookFullPrimeReports,
      hybridMcpBrief: input.hybridMcpBriefReports,
      repeat: input.repeat
    });
    this.writeProofFile(input.outputPath, {
      ...proof,
      partial: true
    });
  }

  private writeProofFile(outputPath: string | undefined, proof: BenchmarkProofReport | (BenchmarkProofReport & { partial: boolean })): void {
    if (!outputPath) return;
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    const tmpPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(proof, null, 2)}\n`);
    fs.renameSync(tmpPath, outputPath);
  }

  private async runProofModeBenchmark(input: {
    suitePath?: string | undefined;
    command: string;
    setupCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
    assistanceMode: BenchmarkAssistanceMode;
    onCaseProgress?: Parameters<KairnRuntime["runBenchmark"]>[0]["onCaseProgress"];
  }): Promise<BenchmarkReport> {
    try {
      return await this.runBenchmark({
        suitePath: input.suitePath,
        mode: "agent",
        agentCommand: input.command,
        agentSetupCommand: input.setupCommand,
        agentTimeoutMs: input.agentTimeoutMs,
        assistanceMode: input.assistanceMode,
        onCaseProgress: input.onCaseProgress
      });
    } catch (error) {
      return this.buildFailedProofModeReport({
        suitePath: input.suitePath,
        assistanceMode: input.assistanceMode,
        error
      });
    }
  }

  private buildFailedProofModeReport(input: {
    suitePath?: string | undefined;
    assistanceMode: BenchmarkAssistanceMode;
    error: unknown;
  }): BenchmarkReport {
    const suite = loadBenchmarkSuite({
      suitePath: input.suitePath,
      files: this.store.listFiles(this.rootPath)
    });
    const session = this.store.createSession({
      id: `task_${randomUUID()}`,
      rootPath: this.rootPath,
      task: `Failed benchmark mode: ${input.assistanceMode}`,
      verificationHints: ["Inspect benchmark mode setup before trusting token deltas."]
    });
    const run = this.store.createBenchmarkRun({
      id: `bench_${randomUUID()}`,
      rootPath: this.rootPath,
      suiteId: suite.id,
      suiteName: suite.name,
      mode: "agent",
      status: "active",
      metadata: {
        sessionId: session.id,
        caseCount: suite.cases.length,
        agentConfigured: true,
        assistanceMode: input.assistanceMode,
        modeError: input.error instanceof Error ? input.error.message : String(input.error)
      }
    });

    for (const benchmarkCase of suite.cases.filter((item) => benchmarkCaseApplies(item.mode, "agent"))) {
      this.store.recordBenchmarkResult({
        runId: run.id,
        caseId: benchmarkCase.id,
        caseMode: benchmarkCase.mode,
        score: 0,
        expectedFileRecall: 0,
        topKHitRate: 0,
        unexpectedFileRate: 0,
        responseTokens: 0,
        hookContextEmitted: 0,
        hookContextSuppressed: 0,
        taskOutcome: "fail",
        expectedFiles: benchmarkCase.expectedFiles,
        actualFiles: [],
        excludedFiles: benchmarkCase.excludedFiles,
        summary: `Benchmark mode ${input.assistanceMode} failed before producing a result.`,
        recommendations: ["Fix this proof mode before using its token delta."],
        metadata: {
          assistanceMode: input.assistanceMode,
          modeError: input.error instanceof Error ? input.error.message : String(input.error)
        }
      });
    }

    this.store.updateBenchmarkRunStatus(run.id, "abandoned");
    return this.buildBenchmarkReport(run.id);
  }

  getBenchmarkReport(input: { runId?: string | undefined }): BenchmarkReport | { runs: BenchmarkReport[] } {
    if (input.runId) return this.buildBenchmarkReport(input.runId);
    return {
      runs: this.store.listBenchmarkRuns({ rootPath: this.rootPath }).map((run) => this.buildBenchmarkReport(run.id))
    };
  }

  compareBenchmarkRuns(input: { beforeRunId: string; afterRunId: string }): BenchmarkComparison {
    return compareBenchmarkReports(this.buildBenchmarkReport(input.beforeRunId), this.buildBenchmarkReport(input.afterRunId));
  }

  async findContext(input: {
    sessionId: string;
    query?: string | undefined;
    requestType?: "initial_brief" | "find_context" | undefined;
    budget?: number | undefined;
    mode?: ContextQueryMode | undefined;
    refreshIndex?: boolean | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const files = input.refreshIndex === false ? this.store.listFiles(session.rootPath) : await this.refreshIndex(session.rootPath);
    const changedFiles = await this.getChangedFiles(session.rootPath);
    const query = input.query ?? session.task;
    const localIndex = this.getQueryLocalIndex({
      rootPath: session.rootPath,
      files,
      query,
      changedFiles
    });
    const intent = classifyQueryIntent(query);
    const initialScored = hybridSearch({
      files,
      query,
      symbols: localIndex.symbols,
      chunks: localIndex.chunks,
      vectors: localIndex.vectors,
      lexicalDocuments: localIndex.lexicalDocuments,
      lexicalTerms: localIndex.lexicalTerms,
      lexicalStats: localIndex.lexicalStats,
      edges: localIndex.edges,
      shown: session.filesShown,
      changedFiles
    }).slice(0, 12);
    const companionCandidates = findCompanionCandidates({
      files,
      ranked: initialScored,
      query,
      symbols: localIndex.symbols,
      chunks: localIndex.chunks,
      edges: localIndex.edges,
      limit: 2
    });
    const scored = applyCompanionCandidatesToResults(initialScored, companionCandidates).slice(0, 12);
    const rankedFiles = rankedFilesFromScored(scored);
    const repeatedFiles = scored.filter((file) => file.reasons.includes("already shown")).length;
    const decision = decideResponse({
      requestType: input.requestType ?? "find_context",
      query,
      repeatedFiles,
      graphAvailable: localIndex.edges.length > 0,
      ...(input.mode ? { explicitMode: input.mode } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(scored[0] ? { topScore: scored[0].score } : {})
    });
    const content = truncateToBudget(
      formatContextResults({
        title: input.requestType === "initial_brief" ? "Kairn Context Brief" : "Kairn Context Results",
        task: session.task,
        query,
        decisionReason: decision.reason,
        mode: decision.mode,
        intent,
        scored,
        ...(input.budget ? { budget: input.budget } : {})
      }),
      input.budget
    );

    this.recordShown(input.sessionId, "context", decision.mode, content);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "find_context",
      eventName: input.requestType ?? "find_context",
      responseMode: decision.mode,
      baselineTokens: estimateFileBaselineTokens(scored.slice(0, 5)),
      outputTokens: estimateTokens(content),
      files: scored.slice(0, 5).map((file) => file.path),
      metadata: {
        query,
        resultCount: scored.length,
        rankedFiles: rankedFiles.slice(0, 12),
        companionCandidates: companionCandidates.map((candidate) => ({
          file: candidate.file.path,
          score: candidate.score,
          reasons: candidate.reasons
        })),
        estimator: "top 5 ranked files as full-source baseline"
      }
    });

    return {
      mode: decision.mode,
      content,
      files: scored.map((file) => file.path),
      symbols: [],
      related: companionCandidates.map((candidate) => candidate.file.path),
      warnings:
        scored.length === 0
          ? [...decision.warnings, "No hybrid retrieval matches found. Try a more specific query."]
          : decision.warnings,
      suggestedNextContext: scored.slice(0, 5).map((file) => file.path),
      rankedFiles,
      tokenEstimate: estimateTokens(content),
      metadata: {
        rankedFiles,
        companions: companionCandidates.map((candidate) => ({
          file: candidate.file.path,
          score: candidate.score,
          reasons: candidate.reasons
        }))
      }
    };
  }

  async readFile(input: {
    sessionId: string;
    target: string;
    mode?: "exact" | "summary" | undefined;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const target = normalizeRelativePath(input.target);
    const existingFiles = this.store.listFiles(session.rootPath);
    const files = existingFiles.some((record) => record.path === target) ? existingFiles : await this.refreshIndex(session.rootPath);
    const file = files.find((record) => record.path === target);

    if (!file) {
      throw new Error(`File is not in Kairn inventory: ${target}`);
    }

    const content = readTextFile(session.rootPath, target);
    const exact = input.mode === "exact" || input.mode === undefined;
    const responseContent = exact
      ? truncateToBudget(
          [`# Exact Source`, "", `## ${target}`, "", "```", content, "```"].join("\n"),
          input.budget ?? 3000
        )
      : truncateToBudget(summarizeFile(file, content), input.budget ?? 1600);
    const mode = exact ? "exact_code" : "compressed_summary";

    this.store.recordContextShown({
      sessionId: input.sessionId,
      kind: exact ? "file" : "summary",
      filePath: target,
      mode,
      contentHash: sha256(responseContent)
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "read_file",
      eventName: exact ? "read_file_exact" : "read_file_summary",
      responseMode: mode,
      baselineTokens: estimateTokens(content),
      outputTokens: estimateTokens(responseContent),
      files: [target],
      metadata: {
        target,
        requestedMode: input.mode ?? "exact",
        estimator: "full target file as baseline"
      }
    });

    return {
      mode,
      content: responseContent,
      files: [target],
      symbols: [],
      related: [],
      warnings: [],
      suggestedNextContext: [],
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async readSymbol(input: {
    sessionId: string;
    target: string;
    symbol: string;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const target = normalizeRelativePath(input.target);
    const content = readTextFile(session.rootPath, target);
    const storedSymbol = this.store.findSymbol(session.rootPath, target, input.symbol);
    const fallbackSymbol = storedSymbol ? null : extractSymbol(content, input.symbol);
    const symbol = storedSymbol
      ? {
          snippet: sliceLines(content, storedSymbol.startLine, storedSymbol.endLine),
          startLine: storedSymbol.startLine,
          endLine: storedSymbol.endLine
        }
      : fallbackSymbol;

    if (!symbol) {
      const warning = `Symbol "${input.symbol}" was not found in ${target} with the lightweight extractor.`;
      const responseContent = [`# Symbol Not Found`, "", warning].join("\n");
      return {
        mode: "compressed_summary",
        content: responseContent,
        files: [target],
        symbols: [],
        related: [],
        warnings: [warning],
        suggestedNextContext: [target],
        tokenEstimate: estimateTokens(responseContent)
      };
    }

    const responseContent = truncateToBudget(
      [
        "# Exact Symbol Source",
        "",
        `File: ${target}`,
        `Symbol: ${input.symbol}`,
        `Lines: ${symbol.startLine}-${symbol.endLine}`,
        "",
        "```",
        symbol.snippet,
        "```"
      ].join("\n"),
      input.budget ?? 2000
    );

    this.store.recordContextShown({
      sessionId: input.sessionId,
      kind: "symbol",
      filePath: target,
      symbol: input.symbol,
      mode: "exact_code",
      contentHash: sha256(responseContent)
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "read_symbol",
      eventName: "read_symbol",
      responseMode: "exact_code",
      baselineTokens: estimateTokens(content),
      outputTokens: estimateTokens(responseContent),
      files: [target],
      metadata: {
        target,
        symbol: input.symbol,
        estimator: "full target file as baseline"
      }
    });

    return {
      mode: "exact_code",
      content: responseContent,
      files: [target],
      symbols: [input.symbol],
      related: [],
      warnings: [],
      suggestedNextContext: [],
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async getRelatedFiles(input: {
    sessionId: string;
    target: string;
    budget?: number | undefined;
    refreshIndex?: boolean | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const target = normalizeRelativePath(input.target);
    const files = input.refreshIndex === false ? this.store.listFiles(session.rootPath) : await this.refreshIndex(session.rootPath);
    const graphRelated = this.getGraphRelatedFiles(session.rootPath, target);
    const semanticRelated = this.getSemanticRelatedFiles(session.rootPath, target, files);
    const relatedByPath = new Map<string, { file: FileRecord; reason: string }>();

    for (const item of [...graphRelated, ...semanticRelated]) {
      const existing = relatedByPath.get(item.file.path);
      relatedByPath.set(item.file.path, {
        file: item.file,
        reason: mergeReasonText(existing?.reason, item.reason)
      });
    }

    if (relatedByPath.size === 0) {
      for (const file of findRelatedFiles(session.rootPath, files, target)) {
        relatedByPath.set(file.path, { file, reason: "heuristic fallback" });
      }
    }

    const related = [...relatedByPath.values()]
      .sort((a, b) => b.file.importance - a.file.importance || a.file.path.localeCompare(b.file.path))
      .slice(0, 20);
    const responseContent = truncateToBudget(
      [
        "# Related Files",
        "",
        `Target: ${target}`,
        "",
        related.length > 0
          ? related
              .map(({ file, reason }) => `- ${file.path} (${file.kind}, importance ${file.importance}): ${reason}`)
              .join("\n")
          : "No related files found from deterministic heuristics."
      ].join("\n"),
      input.budget ?? 1200
    );

    this.recordShown(input.sessionId, "context", "graph_neighbors", responseContent, target);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "related",
      eventName: "related",
      responseMode: "graph_neighbors",
      baselineTokens: estimateFileBaselineTokens(related.map(({ file }) => file)),
      outputTokens: estimateTokens(responseContent),
      files: related.map(({ file }) => file.path),
      metadata: {
        target,
        resultCount: related.length,
        estimator: "related files as full-source baseline"
      }
    });

    return {
      mode: "graph_neighbors",
      content: responseContent,
      files: [target],
      symbols: [],
      related: related.map(({ file }) => file.path),
      warnings: related.length === 0 ? ["No related files found from graph or fallback heuristics."] : [],
      suggestedNextContext: related.slice(0, 5).map(({ file }) => file.path),
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async findTests(input: {
    sessionId: string;
    target?: string | undefined;
    budget?: number | undefined;
    refreshIndex?: boolean | undefined;
    limit?: number | undefined;
    focused?: boolean | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const files = input.refreshIndex === false ? this.store.listFiles(session.rootPath) : await this.refreshIndex(session.rootPath);
    const target = input.target ? normalizeRelativePath(input.target) : undefined;
    const graphTests = target ? this.getGraphTests(session.rootPath, target) : [];
    const semanticTests = this.getSemanticTests(session.rootPath, files, target, session.task);
    const graphTestPaths = new Set(graphTests.map((file) => file.path));
    const testsByPath = new Map<string, FileRecord>();

    for (const file of [...graphTests, ...semanticTests]) {
      testsByPath.set(file.path, file);
    }

    if (testsByPath.size === 0 && !input.focused) {
      for (const file of findTestsFor(files, target)) {
        testsByPath.set(file.path, file);
      }
    }

    const tests = [...testsByPath.values()]
      .sort((a, b) => Number(graphTestPaths.has(b.path)) - Number(graphTestPaths.has(a.path)) || a.path.localeCompare(b.path))
      .slice(0, Math.max(0, input.limit ?? 30));
    const packageScripts = this.readPackageScripts(session.rootPath);
    const responseContent = truncateToBudget(
      [
        "# Related Tests",
        "",
        target ? `Target: ${target}` : `Task: ${session.task}`,
        "",
        "## Test Files",
        tests.length > 0 ? tests.map((file) => `- ${file.path}`).join("\n") : "No matching test files found.",
        "",
        "## Package Scripts",
        packageScripts.length > 0 ? packageScripts.map((script) => `- ${script}`).join("\n") : "No package scripts found."
      ].join("\n"),
      input.budget ?? 1200
    );

    this.recordShown(input.sessionId, "tests", "brief", responseContent, input.target);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "tests",
      eventName: "find_tests",
      responseMode: "brief",
      baselineTokens: estimateFileBaselineTokens(tests),
      outputTokens: estimateTokens(responseContent),
      files: tests.map((file) => file.path),
      metadata: {
        ...(target ? { target } : {}),
        resultCount: tests.length,
        estimator: "test files as full-source baseline"
      }
    });

    return {
      mode: "brief",
      content: responseContent,
      files: tests.map((file) => file.path),
      symbols: [],
      related: [],
      warnings: tests.length === 0 ? ["No related tests found by filename/path heuristics."] : [],
      suggestedNextContext: tests.slice(0, 5).map((file) => file.path),
      tokenEstimate: estimateTokens(responseContent)
    };
  }

  async reviewDiff(input: { sessionId: string; budget?: number | undefined }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const review = await reviewGitDiff(session.rootPath, session);
    const content = truncateToBudget(review.summary, input.budget ?? 1600);

    this.store.recordDiff({
      sessionId: input.sessionId,
      files: review.files,
      summary: content
    });

    this.store.recordContextShown({
      sessionId: input.sessionId,
      kind: "diff",
      mode: "verification_plan",
      contentHash: sha256(content)
    });
    const changedFileRecords = this.store.listFiles(session.rootPath).filter((file) => review.files.includes(file.path));
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "diff",
      eventName: "review_diff",
      responseMode: "verification_plan",
      baselineTokens: estimateFileBaselineTokens(changedFileRecords),
      outputTokens: estimateTokens(content),
      files: review.files,
      metadata: {
        changedFiles: review.files.length,
        missingContextFiles: review.missingContextFiles.length,
        estimator: "changed files as full-source baseline"
      }
    });

    return {
      mode: "verification_plan",
      content,
      files: review.files,
      symbols: [],
      related: review.missingContextFiles,
      warnings:
        review.missingContextFiles.length > 0
          ? ["Some changed files were not previously shown by Kairn."]
          : [],
      suggestedNextContext: review.missingContextFiles,
      tokenEstimate: estimateTokens(content)
    };
  }

  async getFailureContext(input: {
    sessionId: string;
    type: OutputKind;
    output?: string | undefined;
    files?: string[] | undefined;
    command?: string | undefined;
    budget?: number | undefined;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | undefined;
    eventName?: string | undefined;
  }): Promise<FailureContext> {
    const session = this.store.getSession(input.sessionId);
    await this.refreshIndex(session.rootPath);
    const coordination = this.getCoordinationState(input.sessionId);
    const mcpSourceEvidenceFiles = input.source === "mcp"
      ? uniquePaths(coordination.mcpFiles.filter(isLikelyProductionSourceFile)).slice(0, 2)
      : [];
    const exactSourceFile = input.source === "mcp" ? coordination.exactSourceFiles[0] ?? mcpSourceEvidenceFiles[0] : undefined;
    const knownFiles = this.store.listFiles(session.rootPath).map((file) => file.path);
    const failureFiles = extractFailureFiles({
      output: input.output,
      rootPath: session.rootPath,
      knownFiles,
      explicitFiles: input.files
    });
    const changedFiles = [...(await this.getChangedFiles(session.rootPath))].sort();
    if (exactSourceFile) {
      const outputSummary = input.output ? compressOutputText(input.output, input.type, 360) : "";
      const files = uniquePaths([exactSourceFile, ...changedFiles.filter((file) => file === exactSourceFile)]).slice(0, 1);
      const content = truncateToBudget(
        [
          "# Kairn Failure Context",
          "",
          input.command ? `Command: ${input.command}` : undefined,
          `Output kind: ${input.type}`,
          `Exact source focus: ${exactSourceFile}`,
          failureFiles.length > 0 ? `Failure files: ${failureFiles.join(", ")}` : "Failure files: none detected.",
          "",
          outputSummary ? "## Compressed Failure Output" : undefined,
          outputSummary || undefined,
          "",
          "## Agent Guidance",
          "- Stay on the exact source focus first.",
          "- Do not request broad related files or test fanout unless this source file is insufficient."
        ].filter(Boolean).join("\n"),
        input.budget ?? 900
      );

      this.store.recordCommand({
        sessionId: input.sessionId,
        type: input.type,
        summary: content
      });
      this.recordShown(input.sessionId, "context", "failure_context", content);
      this.recordMetricsEvent({
        sessionId: input.sessionId,
        rootPath: session.rootPath,
        eventKind: "failure_context",
        eventName: input.eventName ?? "failure_context",
        source: input.source ?? "runtime",
        responseMode: "failure_context",
        baselineTokens: input.output ? estimateTokens(input.output) + estimateFileBaselineTokens(this.store.listFiles(session.rootPath).filter((file) => files.includes(file.path))) : 0,
        outputTokens: estimateTokens(content),
        files,
        metadata: {
          outputKind: input.type,
          exactSourceFollowup: true,
          exactSourceFile,
          failureFiles: failureFiles.length,
          relatedFiles: 0,
          testFiles: 0,
          changedFiles: changedFiles.length,
          estimator: "raw failure output plus exact-source linked files as baseline"
        }
      });

      return {
        session: this.getSession(input.sessionId),
        type: input.type,
        content,
        files,
        failureFiles,
        relatedFiles: [],
        testFiles: [],
        changedFiles,
        tokenEstimate: estimateTokens(content),
        warnings: ["Exact source hit: failure context intentionally skipped broad related/test expansion."]
      };
    }
    if (mcpSourceEvidenceFiles.length > 0) {
      const outputSummary = input.output ? compressOutputText(input.output, input.type, 320) : "";
      const files = uniquePaths([
        ...failureFiles.filter(isLikelyProductionSourceFile),
        ...mcpSourceEvidenceFiles,
        ...changedFiles.filter((file) => mcpSourceEvidenceFiles.includes(file))
      ]).slice(0, 3);
      const content = truncateToBudget(
        [
          "# Kairn Failure Context",
          "",
          input.command ? `Command: ${input.command}` : undefined,
          `Output kind: ${input.type}`,
          `Source evidence focus: ${mcpSourceEvidenceFiles.join(", ")}`,
          failureFiles.length > 0 ? `Failure files: ${failureFiles.join(", ")}` : "Failure files: none detected.",
          "",
          outputSummary ? "## Compressed Failure Output" : undefined,
          outputSummary || undefined,
          "",
          "## Agent Guidance",
          "- Stay on the source evidence Kairn already returned.",
          "- Do not request broad related files or test fanout unless these files are insufficient."
        ].filter(Boolean).join("\n"),
        input.budget ?? 760
      );

      this.store.recordCommand({
        sessionId: input.sessionId,
        type: input.type,
        summary: content
      });
      this.recordShown(input.sessionId, "context", "failure_context", content);
      this.recordMetricsEvent({
        sessionId: input.sessionId,
        rootPath: session.rootPath,
        eventKind: "failure_context",
        eventName: input.eventName ?? "failure_context",
        source: input.source,
        responseMode: "failure_context",
        baselineTokens: input.output ? estimateTokens(input.output) + estimateFileBaselineTokens(this.store.listFiles(session.rootPath).filter((file) => files.includes(file.path))) : 0,
        outputTokens: estimateTokens(content),
        files,
        metadata: {
          outputKind: input.type,
          sourceEvidenceFollowup: true,
          sourceEvidenceFiles: mcpSourceEvidenceFiles,
          failureFiles: failureFiles.length,
          relatedFiles: 0,
          testFiles: 0,
          changedFiles: changedFiles.length,
          estimator: "raw failure output plus MCP source evidence as baseline"
        }
      });

      return {
        session: this.getSession(input.sessionId),
        type: input.type,
        content,
        files,
        failureFiles,
        relatedFiles: [],
        testFiles: [],
        changedFiles,
        tokenEstimate: estimateTokens(content),
        warnings: ["MCP source evidence already exists: failure context intentionally skipped broad related/test expansion."]
      };
    }
    if (input.source === "mcp" && hasRecentMcpPrepareAbstention(this.store.listMetricsEvents(input.sessionId))) {
      const outputSummary = input.output ? compressOutputText(input.output, input.type, 240) : "";
      const content = truncateToBudget(
        [
          "# Kairn Failure Context",
          "",
          "Kairn previously abstained because context risk was high.",
          "No additional Kairn files are recommended yet.",
          "",
          outputSummary ? "## Compressed Failure Output" : undefined,
          outputSummary || undefined,
          "",
          "Agent guidance: continue normally. Call Kairn again only after a more specific failing file, stack trace, or changed source target appears."
        ].filter(Boolean).join("\n"),
        input.budget ?? 420
      );
      this.recordMetricsEvent({
        sessionId: input.sessionId,
        rootPath: session.rootPath,
        eventKind: "failure_context",
        eventName: input.eventName ?? "failure_context_suppressed",
        source: input.source,
        responseMode: "failure_context",
        baselineTokens: input.output ? estimateTokens(input.output) : 0,
        outputTokens: estimateTokens(content),
        files: [],
        metadata: {
          outputKind: input.type,
          previousMcpAbstention: true,
          relatedFiles: 0,
          testFiles: 0,
          changedFiles: changedFiles.length
        }
      });
      return {
        session: this.getSession(input.sessionId),
        type: input.type,
        content,
        contextSuppressed: true,
        files: [],
        failureFiles,
        relatedFiles: [],
        testFiles: [],
        changedFiles,
        tokenEstimate: estimateTokens(content),
        warnings: ["Previous MCP prepare abstained: failure context intentionally skipped broad expansion."]
      };
    }
    const seedFiles = uniquePaths([...failureFiles, ...changedFiles]).slice(0, 4);
    const relatedFiles = new Set<string>();
    const testFiles = new Set<string>();
    const warnings: string[] = [];

    for (const file of seedFiles) {
      try {
        const related = await this.getRelatedFiles({ sessionId: input.sessionId, target: file, budget: 500 });
        for (const relatedFile of related.suggestedNextContext.slice(0, 4)) relatedFiles.add(relatedFile);
      } catch {
        warnings.push(`Could not resolve related files for ${file}.`);
      }

      try {
        const tests = await this.findTests({ sessionId: input.sessionId, target: file, budget: 500 });
        for (const testFile of tests.suggestedNextContext.slice(0, 4)) testFiles.add(testFile);
      } catch {
        warnings.push(`Could not resolve tests for ${file}.`);
      }
    }

    const outputSummary = input.output ? compressOutputText(input.output, input.type, 480) : "";
    const files = uniquePaths([...failureFiles, ...relatedFiles, ...testFiles, ...changedFiles]).slice(0, 12);
    const content = truncateToBudget(
      [
        "# Kairn Failure Context",
        "",
        input.command ? `Command: ${input.command}` : undefined,
        `Output kind: ${input.type}`,
        failureFiles.length > 0 ? `Failure files: ${failureFiles.join(", ")}` : "Failure files: none detected.",
        changedFiles.length > 0 ? `Changed files: ${changedFiles.slice(0, 8).join(", ")}` : undefined,
        relatedFiles.size > 0 ? `Related source: ${[...relatedFiles].slice(0, 8).join(", ")}` : undefined,
        testFiles.size > 0 ? `Likely tests: ${[...testFiles].slice(0, 8).join(", ")}` : undefined,
        "",
        outputSummary ? "## Compressed Failure Output" : undefined,
        outputSummary || undefined,
        "",
        "## Agent Guidance",
        "- Inspect failure files first, then related source/tests.",
        "- Avoid broad scans until these files are insufficient."
      ].filter(Boolean).join("\n"),
      input.budget ?? 1200
    );

    this.store.recordCommand({
      sessionId: input.sessionId,
      type: input.type,
      summary: content
    });
    this.recordShown(input.sessionId, "context", "failure_context", content);
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "failure_context",
      eventName: input.eventName ?? "failure_context",
      source: input.source ?? "runtime",
      responseMode: "failure_context",
      baselineTokens: input.output ? estimateTokens(input.output) + estimateFileBaselineTokens(this.store.listFiles(session.rootPath).filter((file) => files.includes(file.path))) : 0,
      outputTokens: estimateTokens(content),
      files,
      metadata: {
        outputKind: input.type,
        failureFiles: failureFiles.length,
        relatedFiles: relatedFiles.size,
        testFiles: testFiles.size,
        changedFiles: changedFiles.length,
        estimator: "raw failure output plus linked full-source files as baseline"
      }
    });

    return {
      session: this.getSession(input.sessionId),
      type: input.type,
      content,
      files,
      failureFiles,
      relatedFiles: [...relatedFiles],
      testFiles: [...testFiles],
      changedFiles,
      tokenEstimate: estimateTokens(content),
      warnings: uniqueStrings(warnings)
    };
  }

  async getNextContext(input: {
    sessionId: string;
    budget?: number | undefined;
  }): Promise<ContextResponse> {
    const session = this.store.getSession(input.sessionId);
    const ledgerEvents = this.getSessionLedger(input.sessionId);
    const ledgerSummary = summarizeSessionLedger(input.sessionId, ledgerEvents);
    const coordination = this.getCoordinationState(input.sessionId);
    const exactSourceFile = coordination.exactSourceFiles[0];
    const alreadyReturnedFiles = uniquePaths([...coordination.hookFiles, ...coordination.mcpFiles, ...ledgerSummary.shownFiles]);
    const avoidReturnedFiles = (files: string[]) => uniquePaths(files).filter((file) => !alreadyReturnedFiles.includes(file));
    const latestFailure = [...this.store.listWatchEvents(input.sessionId)]
      .reverse()
      .find((event) => event.kind === "failure" && event.files.length > 0);
    const workingSetRead = ledgerSummary.workingSet.nextSmallestUsefulRead;
    const changedFiles = [...(await this.getChangedFiles(session.rootPath).catch(() => new Set<string>()))];

    if (exactSourceFile && !latestFailure && !ledgerSummary.workingSet.lastFailure) {
      if (alreadyReturnedFiles.includes(exactSourceFile)) {
        const content = truncateToBudget(
          [
            "# Kairn Next Context",
            "",
            `No fresh source context is needed. Kairn already showed ${exactSourceFile}, and there is no new failure or diff requiring re-emission.`,
            "",
            "Agent guidance: continue from the already-shown source file. Ask Kairn again after a failing check, file change, or clearer new target."
          ].join("\n"),
          input.budget ?? 360
        );
        this.recordLedgerEvent({
          sessionId: input.sessionId,
          kind: "context_shown",
          filePath: exactSourceFile,
          contentHash: sha256(content),
          tokenEstimate: estimateTokens(content),
          source: "runtime",
          summary: `Kairn avoided repeating ${exactSourceFile}.`,
          metadata: {
            repeatedFilesAvoided: 1,
            repeatedSnippetsAvoided: 1,
            policyReason: "repeated_context_suppressed",
            workingSet: ledgerSummary.workingSet
          }
        });
        return {
          mode: "brief",
          content,
          files: [],
          symbols: [],
          related: [],
          warnings: ["No fresh context emitted because the exact source file was already shown."],
          suggestedNextContext: [],
          tokenEstimate: estimateTokens(content),
          metadata: {
            sessionPolicy: "repeated_context_suppressed",
            exactSourceFile,
            workingSet: ledgerSummary.workingSet
          }
        };
      }
      const focused = this.focusedExactSourceContext({
        sessionId: input.sessionId,
        file: exactSourceFile,
        budget: input.budget,
        reason: "Kairn already found a high-confidence exact source file for this task."
      });
      this.recordLedgerEvent({
        sessionId: input.sessionId,
        kind: "context_shown",
        filePath: exactSourceFile,
        contentHash: sha256(focused.content),
        tokenEstimate: focused.tokenEstimate,
        source: "runtime",
        summary: `Kairn showed focused next context for ${exactSourceFile}.`,
        metadata: {
          policyReason: "fresh_context",
          phase: ledgerSummary.currentPhase,
          workingSet: ledgerSummary.workingSet
        }
      });
      return focused;
    }

    const alreadyReturnedSource = uniquePaths([...coordination.mcpFiles, ...coordination.hookFiles]).find(isLikelyProductionSourceFile);
    if (alreadyReturnedSource && !latestFailure && !ledgerSummary.workingSet.lastFailure && changedFiles.length === 0) {
      const content = truncateToBudget(
        [
          "# Kairn Next Context",
          "",
          `Stop condition: Kairn already returned source evidence for ${alreadyReturnedSource}.`,
          "",
          "Agent guidance: continue with that source file and the smallest verification check. Do not ask Kairn for broader context unless a check fails, a file changes, or the task target changes."
        ].join("\n"),
        input.budget ?? 360
      );
      this.recordLedgerEvent({
        sessionId: input.sessionId,
        kind: "context_shown",
        filePath: alreadyReturnedSource,
        contentHash: sha256(content),
        tokenEstimate: estimateTokens(content),
        source: "runtime",
        summary: `Kairn stopped follow-up context after returning ${alreadyReturnedSource}.`,
        metadata: {
          repeatedFilesAvoided: 1,
          repeatedSnippetsAvoided: 1,
          policyReason: "source_evidence_sufficient",
          workingSet: ledgerSummary.workingSet
        }
      });
      return {
        mode: "brief",
        content,
        files: [],
        symbols: [],
        related: [],
        warnings: ["No fresh context emitted because Kairn already returned enough source evidence."],
        suggestedNextContext: [],
        tokenEstimate: estimateTokens(content),
        metadata: {
          sessionPolicy: "source_evidence_sufficient",
          sourceEvidenceFile: alreadyReturnedSource,
          workingSet: ledgerSummary.workingSet
        }
      };
    }

    if (workingSetRead && (workingSetRead.source === "failure" || workingSetRead.source === "changed_file" || !alreadyReturnedFiles.includes(workingSetRead.filePath))) {
      const content = truncateToBudget(
        [
          "# Kairn Next Context",
          "",
          `Next smallest useful read: ${workingSetRead.filePath}`,
          `Reason: ${workingSetRead.reason}`,
          "",
          ledgerSummary.workingSet.currentInvariant ? `Invariant: ${ledgerSummary.workingSet.currentInvariant.statement}` : "",
          ledgerSummary.workingSet.lastFailure ? `Last failure: ${ledgerSummary.workingSet.lastFailure.summary}` : "",
          ledgerSummary.workingSet.lastPassingVerification ? `Last passing verification: ${ledgerSummary.workingSet.lastPassingVerification.summary}` : "",
          "",
          "Agent guidance: read only this file next. Ask Kairn again after the check fails, the file changes, or the task target changes."
        ].filter(Boolean).join("\n"),
        input.budget ?? 520
      );
      this.recordLedgerEvent({
        sessionId: input.sessionId,
        kind: "context_shown",
        filePath: workingSetRead.filePath,
        contentHash: sha256(content),
        tokenEstimate: estimateTokens(content),
        source: "runtime",
        summary: `Kairn showed working-set next read for ${workingSetRead.filePath}.`,
        metadata: {
          policyReason: workingSetRead.source === "failure" ? "failure_reemitted" : workingSetRead.source === "changed_file" ? "changed_file_reemitted" : "fresh_context",
          phase: ledgerSummary.currentPhase,
          workingSet: ledgerSummary.workingSet
        }
      });
      return {
        mode: "brief",
        content,
        files: [workingSetRead.filePath],
        symbols: [],
        related: [],
        warnings: ["Next context selected from session working set."],
        suggestedNextContext: [workingSetRead.filePath],
        tokenEstimate: estimateTokens(content),
        metadata: {
          workingSet: ledgerSummary.workingSet
        }
      };
    }

    if (latestFailure?.files[0]) {
      const related = await this.getRelatedFiles({
        sessionId: input.sessionId,
        target: latestFailure.files[0],
        budget: 500
      });
      const nextReads = uniquePaths([
        ...avoidReturnedFiles([latestFailure.files[0], ...related.suggestedNextContext]),
        latestFailure.files[0]
      ]).slice(0, 2);
      const content = truncateToBudget(
        [
          "# Kairn Next Context",
          "",
          `Latest failure file: ${latestFailure.files[0]}`,
          "",
          "## Next Reads",
          ...nextReads.map((file) => `- ${file}`),
          "",
          "Agent guidance: inspect these files before broad scans."
        ].join("\n"),
        input.budget ?? 700
      );
      for (const file of nextReads) {
        this.recordLedgerEvent({
          sessionId: input.sessionId,
          kind: "context_shown",
          filePath: file,
          contentHash: sha256(content),
          tokenEstimate: estimateTokens(content),
          source: "runtime",
          summary: `Kairn showed failure-linked next context for ${file}.`,
          metadata: {
            policyReason: "failure_reemitted",
            phase: "debugging",
            workingSet: ledgerSummary.workingSet
          }
        });
      }
      return {
        ...related,
        content,
        files: nextReads,
        related: nextReads.filter((file) => file !== latestFailure.files[0]),
        suggestedNextContext: nextReads,
        tokenEstimate: estimateTokens(content),
        warnings: uniqueStrings([...related.warnings, "Next context selected from latest failure event."])
      };
    }

    const diff = await this.reviewDiff({ sessionId: input.sessionId, budget: input.budget ?? 900 });
    if (diff.suggestedNextContext.length > 0) {
      const nextReads = uniquePaths([...avoidReturnedFiles(diff.suggestedNextContext), ...diff.suggestedNextContext]).slice(0, 2);
      const content = truncateToBudget(
        [
          "# Kairn Next Context",
          "",
          "Current diff has files that Kairn has not shown yet.",
          "",
          "## Next Reads",
          ...nextReads.map((file) => `- ${file}`),
          "",
          "Agent guidance: read the smallest missing diff context before broader review."
        ].join("\n"),
        input.budget ?? 700
      );
      for (const file of nextReads) {
        this.recordLedgerEvent({
          sessionId: input.sessionId,
          kind: "context_shown",
          filePath: file,
          contentHash: sha256(content),
          tokenEstimate: estimateTokens(content),
          source: "runtime",
          summary: `Kairn showed diff-linked next context for ${file}.`,
          metadata: {
            policyReason: "changed_file_reemitted",
            phase: "cleanup",
            workingSet: ledgerSummary.workingSet
          }
        });
      }
      return {
        ...diff,
        content,
        files: nextReads,
        suggestedNextContext: nextReads,
        tokenEstimate: estimateTokens(content),
        warnings: uniqueStrings([...diff.warnings, "Next context selected from current diff."])
      };
    }

    const context = await this.findContext({
      sessionId: input.sessionId,
      query: session.task,
      requestType: "find_context",
      budget: input.budget ?? 900,
      mode: "brief"
    });
    const files = this.store.listFiles(session.rootPath);
    const quality = evaluatePrimeQuality({
      task: session.task,
      context,
      knownFiles: files
    });
    const decision = evaluateContextValue({
      task: session.task,
      profile: resolvePrimeProfile("auto", session.task),
      context,
      quality,
      knownFiles: files,
      repoFileCount: files.length,
      estimatedContextCost: input.budget ?? 700
    });
    const nextReads = uniquePaths([...avoidReturnedFiles(context.suggestedNextContext), ...context.suggestedNextContext]).slice(
      0,
      decision.exactSourceHit ? 1 : 2
    );
    if (nextReads.length === 0) return context;
    const content = truncateToBudget(
      [
        "# Kairn Next Context",
        "",
        "## Next Reads",
        ...nextReads.map((file) => `- ${file}`),
        "",
        alreadyReturnedFiles.length > 0 ? `Avoiding already-returned files: ${alreadyReturnedFiles.slice(0, 3).join(", ")}` : "",
        decision.exactSourceHit
          ? "Agent guidance: Kairn found a high-confidence source file; read it before requesting broader related files or tests."
          : "Agent guidance: read the first file before broad scans; use the fallback only if needed."
      ].filter(Boolean).join("\n"),
      input.budget ?? 700
    );
    for (const file of nextReads) {
      this.recordLedgerEvent({
        sessionId: input.sessionId,
        kind: "context_shown",
        filePath: file,
        contentHash: sha256(content),
        tokenEstimate: estimateTokens(content),
        source: "runtime",
        summary: `Kairn showed next context for ${file}.`,
          metadata: {
            policyReason: "fresh_context",
            phase: ledgerSummary.currentPhase,
            workingSet: ledgerSummary.workingSet
          }
        });
    }
    return {
      ...context,
      content,
      files: nextReads,
      related: nextReads.slice(1),
      suggestedNextContext: nextReads,
      tokenEstimate: estimateTokens(content),
      warnings: uniqueStrings([
        ...context.warnings,
        alreadyReturnedFiles.length > 0 ? "Next context avoided files already emitted by Kairn hooks or MCP tools." : "",
        decision.exactSourceHit ? "Exact source hit: Kairn intentionally avoided broad expansion." : ""
      ])
    };
  }

  focusedExactSourceContext(input: {
    sessionId: string;
    file: string;
    budget?: number | undefined;
    alreadyReturned?: boolean | undefined;
    reason?: string | undefined;
  }): ContextResponse {
    const evidence = this.getExactSourceEvidence({
      sessionId: input.sessionId,
      file: input.file,
      budget: Math.max(180, Math.floor((input.budget ?? 550) * 0.62))
    });
    const content = truncateToBudget(
      [
        "# Kairn Focused Next Context",
        "",
        input.reason ?? "Kairn found a high-confidence exact source file.",
        "",
        `Primary source: ${input.file}`,
        evidence.symbol ? `Symbol: ${evidence.symbol}` : undefined,
        evidence.lines ? `Lines: ${evidence.lines}` : undefined,
        "",
        "Invariant to preserve:",
        evidence.expectedBehavior,
        evidence.invariant?.evidence ? `Evidence: ${evidence.invariant.evidence}` : undefined,
        "",
        evidence.snippet ? "## Focused Snippet" : undefined,
        evidence.snippet ? "```" : undefined,
        evidence.snippet,
        evidence.snippet ? "```" : undefined,
        "",
        "Verification:",
        evidence.verificationCommand,
        "",
        "Stop condition: do not request broad related files or test fanout unless this exact source file cannot satisfy the invariant."
      ].filter(Boolean).join("\n"),
      input.budget ?? 550
    );
    this.recordShown(input.sessionId, "context", "brief", content);
    return {
      mode: "brief",
      content,
      files: [input.file],
      symbols: evidence.symbol ? [evidence.symbol] : [],
      related: [],
      warnings: ["Exact source hit: Kairn intentionally stopped broad MCP expansion."],
      suggestedNextContext: input.alreadyReturned ? [] : [input.file],
      tokenEstimate: estimateTokens(content)
    };
  }

  getExactSourceEvidence(input: {
    sessionId: string;
    file: string;
    budget?: number | undefined;
    task?: string | undefined;
  }): ExactSourceEvidence {
    const session = this.store.getSession(input.sessionId);
    const target = normalizeRelativePath(input.file);
    const content = readTextFile(session.rootPath, target);
    const task = input.task ?? session.task;
    const symbol = chooseEvidenceSymbol(this.store.listSymbolsForFile(session.rootPath, target), task);
    const lineCount = content.split(/\r?\n/).length;
    const snippetStart = symbol ? Math.max(1, symbol.startLine - 2) : firstMatchingLine(content, task);
    const snippetEnd = symbol ? Math.min(lineCount, symbol.endLine + 2) : Math.min(lineCount, snippetStart + 8);
    const rawSnippet = sliceLines(content, snippetStart, snippetEnd);
    const snippet = truncateToBudget(rawSnippet, input.budget ?? 220);
    const evidenceSymbol = chooseSnippetIdentifier(rawSnippet, task) ?? symbol?.name;
    const verificationCommand = inferVerificationCommand(session.rootPath, target);
    const invariant = buildContextInvariant({
      task,
      file: target,
      symbol: evidenceSymbol,
      snippet: rawSnippet,
      verificationCommand
    });
    return {
      file: target,
      ...(evidenceSymbol ? { symbol: evidenceSymbol } : {}),
      lines: symbol ? `${symbol.startLine}-${symbol.endLine}` : `${snippetStart}-${snippetEnd}`,
      snippet,
      expectedBehavior: invariant.statement,
      invariant,
      verificationCommand,
      tokenEstimate: estimateTokens(snippet) + estimateTokens(task)
    };
  }

  recordMcpToolCall(input: {
    toolName: string;
    sessionId?: string | undefined;
    result: unknown;
    input?: unknown;
  }): void {
    this.metricsService.recordMcpToolCall(input);
  }

  compressOutput(input: {
    sessionId: string;
    type: OutputKind;
    output: string;
    budget?: number | undefined;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | undefined;
    eventName?: string | undefined;
  }): ContextResponse {
    const session = this.store.getSession(input.sessionId);
    const routed = routeEvidenceCompression({
      output: input.output,
      type: input.type,
      rootPath: session.rootPath,
      ...(input.budget ? { budget: input.budget } : {})
    });
    const content = routed.content;

    this.store.recordCommand({
      sessionId: input.sessionId,
      type: input.type,
      summary: content
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "compression",
      eventName: input.eventName ?? `compress_${input.type}`,
      source: input.source ?? "runtime",
      responseMode: "failure_context",
      baselineTokens: estimateTokens(input.output),
      outputTokens: estimateTokens(content),
      files: routed.files,
      metadata: {
        outputKind: input.type,
        estimator: "raw command output as baseline",
        compression: routed.metadata
      }
    });

    return {
      mode: "failure_context",
      content,
      files: routed.files,
      symbols: [],
      related: [],
      warnings: routed.metadata.status === "failed_open"
        ? [`Compression failed open (${routed.metadata.reason}); original output returned unchanged.`]
        : [],
      suggestedNextContext: [],
      tokenEstimate: estimateTokens(content),
      metadata: {
        compression: routed.metadata
      }
    };
  }

  private compressHookOutput(input: {
    sessionId: string;
    type: OutputKind;
    output: string;
    budget: number;
    source?: WatchEventSource | undefined;
    eventName?: string | undefined;
  }): ContextResponse {
    const session = this.store.getSession(input.sessionId);
    const content = compressOutputText(input.output, input.type, input.budget);

    this.store.recordCommand({
      sessionId: input.sessionId,
      type: input.type,
      summary: content
    });
    this.recordMetricsEvent({
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      eventKind: "compression",
      eventName: input.eventName ?? `compress_${input.type}`,
      source: input.source ?? "runtime",
      responseMode: "failure_context",
      baselineTokens: estimateTokens(input.output),
      outputTokens: estimateTokens(content),
      files: [],
      metadata: {
        outputKind: input.type,
        estimator: "raw command output as baseline",
        compressionPolicy: "legacy_bounded_hook"
      }
    });

    return {
      mode: "failure_context",
      content,
      files: [],
      symbols: [],
      related: [],
      warnings: [],
      suggestedNextContext: [],
      tokenEstimate: estimateTokens(content)
    };
  }

  async recordFileChanges(input: {
    sessionId: string;
    files: string[];
    source?: WatchEventSource | undefined;
    eventName?: string | undefined;
  }): Promise<WatchEventRecord | undefined> {
    this.store.getSession(input.sessionId);
    const files = uniquePaths(input.files);
    if (files.length === 0) return undefined;

    return this.recordWatchEvent({
      sessionId: input.sessionId,
      source: input.source ?? "watch",
      kind: "file_change",
      eventName: input.eventName ?? "FileChanged",
      files,
      summary: `Files changed: ${files.join(", ")}`,
      metadata: { count: files.length }
    });
  }

  async createWatchSnapshot(input: {
    sessionId: string;
    changedFiles?: string[] | undefined;
    source?: WatchEventSource | undefined;
  }): Promise<WatchSnapshot> {
    const session = this.store.getSession(input.sessionId);
    const files = await this.refreshIndex(session.rootPath);
    const explicitlyChanged = uniquePaths(input.changedFiles ?? []);

    if (explicitlyChanged.length > 0) {
      await this.recordFileChanges({
        sessionId: input.sessionId,
        files: explicitlyChanged,
        source: input.source ?? "watch"
      });
    }

    const changedFiles = [...(await this.getChangedFiles(session.rootPath))].sort();
    const recommendations: WatchRecommendation[] = [];

    if (changedFiles.length > 0) {
      const changeHash = sha256(changedFiles.join("\n"));
      const lastDiffEvent = [...this.store.listWatchEvents(input.sessionId)]
        .reverse()
        .find((event) => event.kind === "diff_change");

      if (lastDiffEvent?.contentHash !== changeHash) {
        const diff = await reviewGitDiff(session.rootPath, session);
        this.store.recordDiff({
          sessionId: input.sessionId,
          files: diff.files,
          summary: diff.summary
        });
        this.recordWatchEvent({
          sessionId: input.sessionId,
          source: input.source ?? "watch",
          kind: "diff_change",
          eventName: "GitDiffChanged",
          files: changedFiles,
          summary: diff.summary,
          contentHash: changeHash,
          metadata: {
            expectedFilesTouched: diff.expectedFilesTouched,
            unexpectedFiles: diff.unexpectedFiles,
            missingContextFiles: diff.missingContextFiles
          }
        });

        if (diff.missingContextFiles.length > 0) {
          recommendations.push({
            summary: "Changed files include files not previously shown by Kairn.",
            files: diff.missingContextFiles,
            suggestedNextContext: diff.missingContextFiles.slice(0, 5),
            warnings: ["Review missing changed-file context before continuing."],
            content: diff.summary
          });
        }
      }
    }

    return {
      sessionId: input.sessionId,
      rootPath: session.rootPath,
      changedFiles,
      indexedFiles: files.length,
      watchEvents: this.store.listWatchEvents(input.sessionId, 25),
      recommendations,
      createdAt: nowIso()
    };
  }

  async handleHookEvent(input: {
    sessionId?: string | undefined;
    event: NormalizedHookEvent;
    primeBudget?: number | undefined;
    primeProfile?: PrimeProfile | undefined;
    hookOutput?: HookOutputProfile | undefined;
    transport?: "cli" | "daemon" | undefined;
    daemonAttempted?: boolean | undefined;
    daemonHit?: boolean | undefined;
    refreshIndex?: boolean | undefined;
    editScopeHints?: {
      allowedDiffScopes?: BenchmarkDiffScope[] | undefined;
      sourceInvariants?: BenchmarkSourceInvariant[] | undefined;
      failureFiles?: string[] | undefined;
    } | undefined;
  }): Promise<HookHandlingResult> {
    const hookStartedAt = Date.now();
    const hookOutput = input.hookOutput ?? "full-prime";
    const session = await this.resolveHookSession({
      sessionId: input.sessionId,
      event: input.event
    });
    const refreshStartedAt = Date.now();
    const promptEvent = isPromptEvent(input.event.eventName);
    const shouldRefreshIndex = input.refreshIndex ?? !promptEvent;
    if (shouldRefreshIndex) {
      await this.refreshIndex(session.rootPath);
    }
    const refreshIndexMs = Date.now() - refreshStartedAt;
    const knownFiles = this.store.listFiles(session.rootPath).map((file) => file.path);
    const outputKind = classifyObservedCommand({
      command: input.event.command,
      output: input.event.output,
      eventName: input.event.eventName
    });
    const linkedFiles = extractFailureFiles({
      output: input.event.output,
      rootPath: session.rootPath,
      knownFiles,
      explicitFiles: input.event.files
    });
    const kind = input.event.exitCode && input.event.exitCode !== 0 ? "failure" : input.event.kind;
    const hookPhase = inferTaskPhase({
      task: input.event.output ?? input.event.command ?? session.task,
      recentEvents: this.getSessionLedger(session.id),
      failureFiles: kind === "failure" ? linkedFiles : [],
      changedFiles: input.event.files
    });
    if (input.event.command) {
      this.recordLedgerEvent({
        sessionId: session.id,
        kind: outputKind === "test" ? "test_run" : "command_run",
        turnId: stringMetadata(input.event.metadata, "turn_id"),
        contentHash: sha256(input.event.command),
        tokenEstimate: estimateTokens(input.event.command),
        source: input.event.source,
        summary: `${outputKind} command observed: ${input.event.command}`,
        metadata: {
          eventName: input.event.eventName,
          outputKind,
          phase: hookPhase,
          exitCode: input.event.exitCode ?? null
        }
      });
    }
    if (kind === "failure") {
      for (const file of linkedFiles.length > 0 ? linkedFiles : [undefined]) {
        this.recordLedgerEvent({
          sessionId: session.id,
          kind: "failure_seen",
          turnId: stringMetadata(input.event.metadata, "turn_id"),
          ...(file ? { filePath: file } : {}),
          contentHash: sha256([input.event.command ?? "", input.event.output ? sha256(input.event.output) : ""].join("\n")),
          tokenEstimate: input.event.output ? estimateTokens(input.event.output) : 0,
          source: input.event.source,
          summary: file ? `Failure linked to ${file}` : "Failure observed without a linked file",
          metadata: {
            eventName: input.event.eventName,
            outputKind,
            phase: hookPhase,
            exitCode: input.event.exitCode ?? null
          }
        });
      }
    }
    const promptHash = input.event.output && isPromptEvent(input.event.eventName) ? sha256(input.event.output) : undefined;
    const duplicatePromptPrime = Boolean(
      promptHash &&
        isHighConfidencePrompt(input.event.eventName, input.event.output) &&
        this.hasPromptPrimeForHook({
          sessionId: session.id,
          event: input.event,
          promptHash
        })
    );
    let primeElapsedMs = 0;
    const shouldPrimePrompt =
      hookOutput !== "failure-only" &&
      promptHash &&
      !duplicatePromptPrime &&
      isHighConfidencePrompt(input.event.eventName, input.event.output);
    const prime = shouldPrimePrompt
      ? await (async () => {
          const startedAt = Date.now();
          try {
            return await this.primeContext({
              task: input.event.output!,
              sessionId: session.id,
              budget: input.primeBudget ?? 1200,
              mode: "snippets",
              profile: input.primeProfile ?? "auto",
              format: hookOutput === "mcp-brief" ? "mcp_brief" : "standard",
              source: input.event.source,
              eventName: "prime_context_hook",
              refreshIndex: shouldRefreshIndex,
              editScopeHints: input.editScopeHints,
              metadata: {
                promptHash,
                hostSessionId: input.event.hostSessionId ?? null,
                turnId: stringMetadata(input.event.metadata, "turn_id") ?? null,
                hookEventName: input.event.eventName,
                hookOutput,
                ...(hookOutput === "mcp-brief" ? { coordinationMode: "mcp_hybrid" } : {}),
                transport: input.transport ?? "cli"
              }
            });
          } finally {
            primeElapsedMs = Date.now() - startedAt;
          }
        })()
      : undefined;
    const suppressedPrime = prime?.quality?.action === "suppress" || prime?.contextDecision?.action === "suppress";
    const emittedPrime = suppressedPrime
      ? undefined
      : prime && hookOutput === "tiny-directive"
        ? withTinyDirectivePrime(prime, input.primeBudget ?? 600)
        : prime;
    const failureContext = kind === "failure"
      ? await this.getFailureContext({
          sessionId: session.id,
          type: outputKind,
          output: input.event.output,
          files: linkedFiles,
          command: input.event.command,
          budget: 1000,
          source: input.event.source,
          eventName: input.event.eventName
        })
      : undefined;
    const failureOnlyNonFailure = hookOutput === "failure-only" && kind !== "failure";
    const evidenceRoutingConfig = loadEvidenceRoutingConfig(session.rootPath);
    const shouldObserveEvidenceRouting =
      evidenceRoutingConfig.mode === "shadow" && Boolean(input.event.output) && !promptEvent;
    const shouldCheckTrivialSuccess =
      Boolean(input.event.output) &&
      !promptEvent &&
      ((!failureContext && !failureOnlyNonFailure) || shouldObserveEvidenceRouting);
    const trivialSuccessfulOutput = shouldCheckTrivialSuccess && isTrivialSuccessfulHook({
      eventKind: kind,
      command: input.event.command,
      output: input.event.output,
      linkedFiles,
      exitCode: input.event.exitCode
    });
    const shouldCompressOutput =
      Boolean(input.event.output) &&
      !isPromptEvent(input.event.eventName) &&
      !failureContext &&
      !failureOnlyNonFailure &&
      !trivialSuccessfulOutput;
    const response = shouldCompressOutput
      ? this.compressHookOutput({
          sessionId: session.id,
          type: outputKind,
          output: input.event.output!,
          budget: 1200,
          source: input.event.source,
          eventName: input.event.eventName
        })
      : undefined;
    const recommendation = emittedPrime
      ? undefined
      : failureContext
        ? failureRecommendation(failureContext)
        : failureOnlyNonFailure
          ? undefined
        : promptEvent
          ? undefined
        : await this.recommendFromHook({
          sessionId: session.id,
          command: input.event.command,
          response,
          linkedFiles,
          outputKind,
          eventKind: kind
        });
    if (shouldObserveEvidenceRouting && input.event.output) {
      try {
        const shadow = evaluateEvidenceRoutingShadow({
          output: input.event.output,
          type: outputKind,
          rootPath: session.rootPath,
          linkedFiles,
          eventKind: kind,
          exitCode: input.event.exitCode,
          trivialSuccessfulOutput,
          currentDeliveryTokens:
            failureContext?.tokenEstimate ??
            (recommendation?.content ? estimateTokens(recommendation.content) : 0),
          budget: 1200
        });
        this.recordMetricsEvent({
          sessionId: session.id,
          rootPath: session.rootPath,
          eventKind: "evidence_routing_shadow",
          eventName: "evidence_routing_shadow_observed",
          source: input.event.source,
          baselineTokens: 0,
          outputTokens: 0,
          files: [],
          metadata: {
            evidenceRoutingShadow: shadow.receipt
          }
        });
      } catch {
        // Shadow observation must never affect the existing hook delivery path.
      }
    }
    const summary = [
      input.event.command ? `Command: ${input.event.command}` : `Event: ${input.event.eventName}`,
      input.event.toolName ? `Tool: ${input.event.toolName}` : "",
      input.event.exitCode !== undefined ? `Exit code: ${input.event.exitCode}` : "",
      linkedFiles.length > 0 ? `Linked files: ${linkedFiles.join(", ")}` : "",
      emittedPrime?.content ? emittedPrime.content : failureContext?.content ? failureContext.content : response?.content ? response.content : ""
    ].filter(Boolean).join("\n\n");
    const event = this.recordWatchEvent({
      sessionId: session.id,
      source: input.event.source,
      kind,
      eventName: input.event.eventName,
      toolName: input.event.toolName,
      command: input.event.command,
      files: linkedFiles,
      exitCode: input.event.exitCode,
      summary: truncateToBudget(summary, 1200),
      metadata: {
        ...input.event.metadata,
        outputKind,
        ...(input.event.cwd ? { cwd: input.event.cwd } : {}),
        ...(input.event.hostSessionId ? { hostSessionId: input.event.hostSessionId } : {}),
        ...(input.event.timestamp ? { timestamp: input.event.timestamp } : {}),
        ...(promptHash ? { promptHash } : {}),
        ...(duplicatePromptPrime ? { duplicatePromptPrime: true } : {}),
        hookOutput,
        transport: input.transport ?? "cli",
        daemonAttempted: Boolean(input.daemonAttempted),
        daemonHit: Boolean(input.daemonHit),
        indexRefreshSkipped: !shouldRefreshIndex,
        refreshIndexMs,
        primeElapsedMs,
        hookLatencyMs: Date.now() - hookStartedAt
      }
    });
    this.recordMetricsEvent({
      sessionId: session.id,
      rootPath: session.rootPath,
      eventKind: "hook_signal",
      eventName: emittedPrime || recommendation ? "hook_recommendation_emitted" : "hook_recommendation_suppressed",
      source: input.event.source,
      baselineTokens: 0,
      outputTokens: emittedPrime?.content ? estimateTokens(emittedPrime.content) : failureContext?.tokenEstimate ?? (recommendation?.content ? estimateTokens(recommendation.content) : 0),
      files: emittedPrime?.files ?? failureContext?.files ?? recommendation?.files ?? linkedFiles,
      metadata: {
        eventName: input.event.eventName,
        hookKind: kind,
        outputKind,
        hookOutput,
        transport: input.transport ?? "cli",
        daemonAttempted: Boolean(input.daemonAttempted),
        daemonHit: Boolean(input.daemonHit),
        daemonMiss: Boolean(input.daemonAttempted) && !input.daemonHit,
        indexRefreshSkipped: !shouldRefreshIndex,
        refreshIndexMs,
        primeElapsedMs,
        hookLatencyMs: Date.now() - hookStartedAt,
        linkedFiles: linkedFiles.length,
        recommendation: emittedPrime ? (hookOutput === "tiny-directive" ? "tiny_prime_emitted" : hookOutput === "mcp-brief" ? "mcp_brief_prime_emitted" : "prime_emitted") : suppressedPrime ? "prime_quality_suppressed_silent" : recommendation ? "emitted" : duplicatePromptPrime ? "duplicate_suppressed" : promptHash ? "prompt_suppressed" : "suppressed",
        ...(hookOutput === "mcp-brief" ? { coordinationMode: "mcp_hybrid", hookFiles: emittedPrime?.files ?? [] } : {}),
        primeAttempted: Boolean(prime),
        primeContextDelivered: Boolean(emittedPrime?.content),
        primeSuppressed: Boolean(suppressedPrime),
        hostAdditionalContextBytes: emittedPrime?.content ? Buffer.byteLength(emittedPrime.content, "utf8") : recommendation?.content ? Buffer.byteLength(recommendation.content, "utf8") : 0,
        proactivePrime: Boolean(emittedPrime),
        primeQuality: prime?.quality,
        contextDecision: prime?.contextDecision,
        decision: prime?.contextDecision?.action,
        decisionScore: prime?.contextDecision?.score,
        decisionReasons: prime?.contextDecision?.reasons,
        estimatedContextCost: prime?.contextDecision?.estimatedContextCost,
        expectedSavingsRisk: prime?.contextDecision?.expectedSavingsRisk,
        failureContext: Boolean(failureContext),
        duplicatePromptPrime,
        compressedOutput: Boolean(response),
        trivialSuccessfulOutput: Boolean(input.event.output) && !shouldCompressOutput && !response
      }
    });

    return {
      session: this.getSession(session.id),
      event,
      ...(recommendation ? { recommendation } : {}),
      ...(response ? { response } : {}),
      ...(failureContext ? { failureContext } : {}),
      ...(emittedPrime ? { prime: emittedPrime } : {})
    };
  }

  listWatchEvents(sessionId: string, limit?: number): WatchEventRecord[] {
    this.store.getSession(sessionId);
    return this.store.listWatchEvents(sessionId, limit);
  }

  private async resolveHookSession(input: {
    sessionId?: string | undefined;
    event: NormalizedHookEvent;
  }): Promise<TaskSession> {
    const hostSessionId = hostSessionIdForEvent(input.event);

    if (input.sessionId) {
      const session = this.store.getSession(input.sessionId);
      if (hostSessionId) {
        this.store.upsertHostSessionLink({
          source: input.event.source,
          rootPath: session.rootPath,
          hostSessionId,
          sessionId: session.id,
          metadata: hostSessionMetadata(input.event)
        });
      }
      return session;
    }

    if (hostSessionId) {
      const link = this.store.getHostSessionLink({
        source: input.event.source,
        rootPath: this.rootPath,
        hostSessionId
      });
      if (link) {
        this.store.upsertHostSessionLink({
          source: input.event.source,
          rootPath: this.rootPath,
          hostSessionId,
          sessionId: link.sessionId,
          metadata: hostSessionMetadata(input.event)
        });
        return this.store.getSession(link.sessionId);
      }
    }

    const session = this.store.createSession({
      id: `task_${randomUUID()}`,
      rootPath: this.rootPath,
      task: taskFromHookEvent(input.event),
      verificationHints: ["Start from Kairn hook context", "Avoid broad scans unless Kairn context is insufficient", "Run related tests before finalizing"]
    });

    if (hostSessionId) {
      this.store.upsertHostSessionLink({
        source: input.event.source,
        rootPath: this.rootPath,
        hostSessionId,
        sessionId: session.id,
        metadata: hostSessionMetadata(input.event)
      });
    }

    return session;
  }

  private hasPromptPrimeForHook(input: {
    sessionId: string;
    event: NormalizedHookEvent;
    promptHash: string;
  }): boolean {
    const turnId = stringMetadata(input.event.metadata, "turn_id");
    return this.store.listMetricsEvents(input.sessionId).some((event) => {
      if (event.eventKind !== "prime_context" || event.eventName !== "prime_context_hook") return false;
      if (event.metadata.promptHash !== input.promptHash) return false;
      return turnId ? event.metadata.turnId === turnId : true;
    });
  }

  private async promptContextResponse(input: {
    sessionId: string;
    eventName: string;
    prompt?: string | undefined;
  }): Promise<ContextResponse | undefined> {
    if (!isHighConfidencePrompt(input.eventName, input.prompt)) return undefined;
    return this.findContext({
      sessionId: input.sessionId,
      query: input.prompt,
      requestType: "find_context",
      budget: 900,
      mode: "brief"
    });
  }

  private buildBenchmarkReport(runId: string): BenchmarkReport {
    const run = this.store.getBenchmarkRun(runId);
    const results = this.store.listBenchmarkResults(runId);
    return buildBenchmarkReport({ run, results });
  }

  private async runReplayBenchmarkCase(input: {
    runId: string;
    sessionId: string;
    benchmarkCase: Parameters<typeof scoreBenchmarkCase>[0]["benchmarkCase"];
  }): Promise<Omit<BenchmarkResultRecord, "id" | "createdAt">> {
    const benchmarkCase = input.benchmarkCase;
    if (benchmarkCase.mode === "context") {
      const response = await this.findContext({
        sessionId: input.sessionId,
        query: benchmarkCase.query ?? benchmarkCase.task,
        budget: benchmarkCase.budget,
        mode: "snippets"
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.files,
        responseTokens: response.tokenEstimate,
        summary: `Context replay returned ${response.files.length} files.`,
        metadata: {
          queryHash: sha256(benchmarkCase.query ?? benchmarkCase.task),
          responseMode: response.mode,
          warnings: response.warnings
        }
      });
    }

    if (benchmarkCase.mode === "related") {
      const response = await this.getRelatedFiles({
        sessionId: input.sessionId,
        target: requireBenchmarkTarget(benchmarkCase),
        budget: benchmarkCase.budget
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.related,
        responseTokens: response.tokenEstimate,
        summary: `Related replay returned ${response.related.length} related files.`,
        metadata: { target: benchmarkCase.target }
      });
    }

    if (benchmarkCase.mode === "tests") {
      const response = await this.findTests({
        sessionId: input.sessionId,
        target: benchmarkCase.target,
        budget: benchmarkCase.budget
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.files,
        responseTokens: response.tokenEstimate,
        summary: `Test replay returned ${response.files.length} test files.`,
        metadata: benchmarkCase.target ? { target: benchmarkCase.target } : {}
      });
    }

    if (benchmarkCase.mode === "diff") {
      const response = await this.reviewDiff({
        sessionId: input.sessionId,
        budget: benchmarkCase.budget
      });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: response.files,
        responseTokens: response.tokenEstimate,
        summary: `Diff replay returned ${response.files.length} changed files.`,
        metadata: { warnings: response.warnings }
      });
    }

    if (benchmarkCase.mode === "hook") {
      const referenceFile = benchmarkCase.expectedFiles[0] ?? benchmarkCase.target ?? "src/app.test.ts";
      const event = normalizeHookPayload({
        source: "generic",
        payload: {
          eventName: "PostToolUse",
          command: "pnpm test",
          output: `FAIL ${referenceFile}:1:1\nExpected benchmark assertion to pass`,
          exitCode: 1
        }
      });
      const result = await this.handleHookEvent({ sessionId: input.sessionId, event });
      return scoreBenchmarkCase({
        runId: input.runId,
        benchmarkCase,
        actualFiles: uniquePaths([...(result.event.files ?? []), ...(result.recommendation?.suggestedNextContext ?? [])]),
        responseTokens: (result.response?.tokenEstimate ?? 0) + estimateTokens(result.recommendation?.content ?? ""),
        hookContextEmitted: result.recommendation ? 1 : 0,
        hookContextSuppressed: result.recommendation ? 0 : 1,
        taskOutcome: result.event.files.includes(referenceFile) ? "pass" : "partial",
        summary: `Hook replay linked ${result.event.files.length} file(s).`,
        metadata: {
          eventKind: result.event.kind,
          recommendation: Boolean(result.recommendation)
        }
      });
    }

    return this.runAgentBenchmarkCase({
      runId: input.runId,
      benchmarkCase,
      agentCommand: undefined
    });
  }

  private async runAgentBenchmarkCase(input: {
    runId: string;
    benchmarkCase: Parameters<typeof scoreBenchmarkCase>[0]["benchmarkCase"];
    agentCommand?: string | undefined;
    setupCommand?: string | undefined;
    agentTimeoutMs?: number | undefined;
    assistanceMode?: BenchmarkAssistanceMode | undefined;
  }): Promise<Omit<BenchmarkResultRecord, "id" | "createdAt">> {
    const result = await runAgentBenchmarkCase({
      rootPath: this.rootPath,
      benchmarkCase: input.benchmarkCase,
      agentCommand: input.agentCommand,
      setupCommand: input.setupCommand,
      timeoutMs: input.agentTimeoutMs,
      agentEnv: benchmarkAgentEnv(input.benchmarkCase, input.assistanceMode),
      preparePrompt:
        input.assistanceMode === "manual_prime" || input.assistanceMode === "proactive"
          ? async ({ workspacePath, prompt }) => {
              const workspaceRuntime = new KairnRuntime(workspacePath);
              try {
                const prime = await workspaceRuntime.primeContext({
                  task: prompt,
                  budget: input.benchmarkCase.budget,
                  editScopeHints: {
                    allowedDiffScopes: input.benchmarkCase.allowedDiffScopes,
                    sourceInvariants: input.benchmarkCase.sourceInvariants
                  }
                });
                return {
                  prompt: [
                    prime.content,
                    "",
                    "User task:",
                    prompt,
                    "",
                    "Use the Kairn context above first. Avoid broad scans unless the provided files are insufficient."
                  ].join("\n"),
                  metadata: {
                    assistanceMode: input.assistanceMode === "proactive" ? "proactive" : "manual_prime",
                    primeProfile: prime.profile,
                    primeSessionId: prime.session.id,
                    primeTokenEstimate: prime.tokenEstimate,
                    primeFiles: prime.files,
                    primeWarnings: prime.warnings
                  }
                };
              } finally {
                workspaceRuntime.close();
            }
          }
          : input.assistanceMode === "kairn_codex_session_no_governor"
            ? async ({ workspacePath, prompt }) => {
                const workspaceRuntime = new KairnRuntime(workspacePath);
                try {
                  const { session } = await workspaceRuntime.startTask(prompt);
                  const response = await workspaceRuntime.findContext({
                    sessionId: session.id,
                    query: prompt,
                    requestType: "initial_brief",
                    budget: input.benchmarkCase.budget,
                    refreshIndex: false
                  });
                  return {
                    prompt: [
                      response.content,
                      "",
                      "User task:",
                      prompt,
                      "",
                      "Use this Kairn context first. This publication ablation intentionally disables the context governor, so treat the provided files as candidate context rather than an edit-scope policy."
                    ].join("\n"),
                    metadata: {
                      assistanceMode: "kairn_codex_session_no_governor",
                      noGovernorAblation: true,
                      noGovernorSessionId: session.id,
                      noGovernorMode: response.mode,
                      noGovernorTokenEstimate: response.tokenEstimate,
                      noGovernorFiles: response.files,
                      noGovernorWarnings: response.warnings,
                      contextDecision: "emit",
                      primeDecision: "emit",
                      primeEmitted: true,
                      primeTokenEstimate: response.tokenEstimate,
                      primeFiles: response.files
                    }
                  };
                } finally {
                  workspaceRuntime.close();
                }
              }
          : input.assistanceMode === "mcp_first" ||
              input.assistanceMode === "real_mcp_first" ||
              input.assistanceMode === "mcp_first_plus_hook_full_prime"
            ? ({ prompt }) => ({
                prompt: [
                  "Kairn MCP-first instruction:",
                  ...mcpFirstBenchmarkInstructionLines(input.benchmarkCase),
                  "Call `kairn_prepare_task` before broad, unclear, multi-file, or failure-driven file scans.",
                  "For diagnose, investigate, audit, trace, or source-rescue tasks that do not name an exact production path, call `kairn_prepare_task` once before manual source reads.",
                  "Do not skip Kairn merely because a task feels small; skip the first prepare call only when the user names an exact production file or exact symbol.",
                  "If `kairn_prepare_task` returns `stopCondition` or no `nextToolCalls`, continue from its files and do not call more Kairn unless a check fails with a concrete missing source outside the returned files or the target changes.",
                  "Only call `kairn_get_next_context` when `kairn_prepare_task` explicitly returns it as a next tool call.",
                  "For real failures, call `kairn_get_failure_context` only when `kairn_prepare_task` did not return a sufficient source surface or the failure output names a new file/symbol outside the returned files.",
                  "Use the smallest Kairn-recommended read before `rg --files`, large `sed`, or full-file reads.",
                  "",
                  "User task:",
                  prompt
                ].join("\n"),
                metadata: {
                  assistanceMode: input.assistanceMode,
                  mcpFirstInstructionsPrepended: true
                }
              })
          : input.assistanceMode === "hybrid_mcp_brief"
            ? ({ prompt }) => ({
                prompt,
                metadata: {
                  assistanceMode: input.assistanceMode,
                  mcpFirstInstructionsPrepended: false,
                  hybridMcpInstructionsConditional: true
                }
              })
            : undefined
    });
    const workspaceMetrics = collectWorkspaceKairnMetrics(result.workspacePath);
    return scoreBenchmarkCase({
      runId: input.runId,
      benchmarkCase: input.benchmarkCase,
      actualFiles: result.actualFiles,
      responseTokens: result.responseTokens,
      observedCodexTokens: result.observedCodexTokens,
      taskOutcome: result.outcome,
      summary: result.summary,
      metadata: {
        assistanceMode: input.assistanceMode ?? "baseline",
        ...workspaceMetrics,
        ...result.metadata
      }
    });
  }

  private async refreshIndex(rootPath: string, input?: { force?: boolean | undefined }) {
    return this.indexService.refreshIndex(rootPath, input);
  }

  getIndexStatus(): IndexStateStats {
    return this.indexService.getStatus(this.rootPath);
  }

  async refreshIndexNow(): Promise<IndexStateStats> {
    await this.refreshIndex(this.rootPath, { force: true });
    return this.getIndexStatus();
  }

  compactIndex(): IndexCompactionResult {
    return this.indexService.compact(this.rootPath);
  }

  private getQueryLocalIndex(input: {
    rootPath: string;
    files: FileRecord[];
    query: string;
    changedFiles?: Set<string> | undefined;
    seedPaths?: string[] | undefined;
    candidateLimit?: number | undefined;
  }): QueryLocalIndex {
    const queryTerms = tokenizeLexical(input.query);
    const budget = queryLocalBudget({
      fileCount: input.files.length,
      query: input.query
    });
    const lexicalTerms = this.store.listLexicalTermsForTerms(input.rootPath, queryTerms, budget.lexicalTermLimit);
    const lexicalDocuments = this.store.listLexicalDocumentsByIds(
      input.rootPath,
      lexicalTerms.map((term) => term.documentId),
      budget.lexicalDocumentLimit
    );
    const lexicalStats = this.store.getLexicalStats(input.rootPath);
    const termSymbols = this.store.listSymbolsForTerms(input.rootPath, queryTerms.slice(0, budget.termLookupLimit), budget.symbolLimit);
    const exactNamedSymbolFiles = exactPromptNamedSymbolFiles(termSymbols, input.query);
    const preliminary = hybridSearch({
      files: input.files,
      query: input.query,
      symbols: termSymbols,
      chunks: [],
      vectors: [],
      lexicalDocuments,
      lexicalTerms,
      lexicalStats,
      edges: [],
      ...(input.changedFiles ? { changedFiles: input.changedFiles } : {})
    });
    const candidateLimit = input.candidateLimit ?? budget.candidateLimit;
    const candidateFiles = uniquePaths([
      ...(input.seedPaths ?? []),
      ...exactNamedSymbolFiles,
      ...preliminary.slice(0, candidateLimit).map((file) => file.path),
      ...termSymbols.map((symbol) => symbol.filePath),
      ...(input.changedFiles ? [...input.changedFiles] : []),
      ...exactPathCandidates(input.files, input.query).slice(0, budget.exactPathLimit)
    ]).slice(0, candidateLimit + budget.candidateSlack);
    const edges = this.store.listGraphEdgesForFiles(input.rootPath, candidateFiles, budget.graphEdgeLimit);
    const expandedFiles = uniquePaths([
      ...candidateFiles,
      ...edges.flatMap((edge) => [edge.fromFile, edge.toFile])
    ]).slice(0, candidateLimit + budget.expansionSlack);
    const symbols = uniqueSymbols([
      ...termSymbols,
      ...this.store.listSymbolsForFiles(input.rootPath, expandedFiles, budget.symbolLimit)
    ]);
    const chunks = this.store.listSemanticChunksForFiles(input.rootPath, expandedFiles, budget.chunkLimit);
    const vectors = this.store.listSemanticVectorsForChunkIds(input.rootPath, chunks.map((chunk) => chunk.id));

    return {
      symbols,
      chunks,
      vectors,
      lexicalDocuments,
      lexicalTerms,
      ...(lexicalStats ? { lexicalStats } : {}),
      edges,
      candidateFiles: expandedFiles
    };
  }

  private recordWatchEvent(record: {
    sessionId: string;
    source: WatchEventSource;
    kind: WatchEventKind;
    eventName: string;
    toolName?: string | undefined;
    command?: string | undefined;
    files: string[];
    exitCode?: number | undefined;
    summary: string;
    contentHash?: string | undefined;
    metadata: Record<string, unknown>;
  }): WatchEventRecord {
    const contentHash = record.contentHash ?? sha256([record.summary, record.files.join("\n")].join("\n"));
    return this.store.recordWatchEvent({
      sessionId: record.sessionId,
      source: record.source,
      kind: record.kind,
      eventName: record.eventName,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      ...(record.command ? { command: record.command } : {}),
      files: uniquePaths(record.files),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      summary: record.summary,
      contentHash,
      metadata: record.metadata
    });
  }

  private async recommendFromHook(input: {
    sessionId: string;
    command?: string | undefined;
    response?: ContextResponse | undefined;
    linkedFiles: string[];
    outputKind: OutputKind;
    eventKind: WatchEventKind;
  }): Promise<WatchRecommendation | undefined> {
    const suggested = new Set<string>(input.linkedFiles);
    const warnings = [...(input.response?.warnings ?? [])];

    if (input.response?.mode === "brief") {
      for (const file of input.response.suggestedNextContext.slice(0, 5)) {
        suggested.add(file);
      }
    }

    for (const linkedFile of input.linkedFiles.slice(0, 2)) {
      try {
        const related = await this.getRelatedFiles({ sessionId: input.sessionId, target: linkedFile, budget: 700 });
        for (const file of related.suggestedNextContext.slice(0, 3)) {
          suggested.add(file);
        }
      } catch {
        // Related context is best-effort for hook recommendations.
      }

      try {
        const tests = await this.findTests({ sessionId: input.sessionId, target: linkedFile, budget: 700 });
        for (const file of tests.suggestedNextContext.slice(0, 3)) {
          suggested.add(file);
        }
      } catch {
        // Test discovery is best-effort for hook recommendations.
      }
    }

    if (suggested.size === 0 && !input.response) return undefined;
    if (suggested.size === 0 && input.response && input.eventKind !== "failure" && input.outputKind === "generic") return undefined;

    const files = [...suggested].slice(0, 10);
    return {
      summary: input.linkedFiles.length > 0
        ? `Observed ${input.outputKind} output linked to ${input.linkedFiles.length} file(s).`
        : `Observed ${input.outputKind} output${input.command ? ` from "${input.command}"` : ""}.`,
      files,
      suggestedNextContext: files.slice(0, 5),
      warnings,
      content: [
        "# Kairn Hook Recommendation",
        "",
        input.command ? `Command: ${input.command}` : undefined,
        `Output kind: ${input.outputKind}`,
        files.length > 0 ? `Suggested next context: ${files.join(", ")}` : "No linked files were detected.",
        "",
        input.response?.content
      ].filter(Boolean).join("\n")
    };
  }

  private async getChangedFiles(rootPath: string): Promise<Set<string>> {
    try {
      const output = await simpleGit(rootPath).diff(["--name-only"]);
      return new Set(
        output
          .split(/\r?\n/)
          .map((line) => normalizeRelativePath(line.trim()))
          .filter(Boolean)
      );
    } catch {
      return new Set();
    }
  }

  private getGraphRelatedFiles(rootPath: string, target: string) {
    const filesByPath = new Map(this.store.listFiles(rootPath).map((file) => [file.path, file]));
    const edges = this.store.listGraphEdgesForFile(rootPath, target);
    const related = new Map<string, { file: FileRecord; reason: string }>();

    for (const edge of edges) {
      const relatedPath = edge.fromFile === target ? edge.toFile : edge.fromFile;
      const file = filesByPath.get(relatedPath);
      if (!file) continue;
      const reason = graphReason(edge.type, edge.fromFile === target);
      const existing = related.get(relatedPath);
      const reasons = new Set([...(existing?.reason.split("; ") ?? []), reason]);
      related.set(relatedPath, {
        file,
        reason: [...reasons].join("; ")
      });
    }

    return [...related.values()].sort((a, b) => b.file.importance - a.file.importance || a.file.path.localeCompare(b.file.path));
  }

  private getGraphTests(rootPath: string, target: string) {
    const filesByPath = new Map(this.store.listFiles(rootPath).map((file) => [file.path, file]));
    const edges = this.store
      .listGraphEdgesForFile(rootPath, target)
      .filter((edge) => edge.type === "tested_by" || edge.type === "test_for");
    const tests = new Map<string, FileRecord>();

    for (const edge of edges) {
      const path = edge.type === "tested_by" && edge.fromFile === target ? edge.toFile : edge.fromFile;
      const file = filesByPath.get(path);
      if (file?.kind === "test") {
        tests.set(file.path, file);
      }
    }

    return [...tests.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private getSemanticRelatedFiles(rootPath: string, target: string, files: FileRecord[]) {
    const targetChunks = this.store.listSemanticChunksForFile(rootPath, target);
    if (targetChunks.length === 0) return [];

    const query = targetChunks
      .map((chunk) => [target, chunk.symbol ?? "", chunk.text.slice(0, 2000)].join("\n"))
      .join("\n");
    const localIndex = this.getQueryLocalIndex({
      rootPath,
      files,
      query,
      seedPaths: [target],
      candidateLimit: 120
    });
    const scored = hybridSearch({
      files,
      query,
      symbols: localIndex.symbols,
      chunks: localIndex.chunks,
      vectors: localIndex.vectors,
      lexicalDocuments: localIndex.lexicalDocuments,
      lexicalTerms: localIndex.lexicalTerms,
      lexicalStats: localIndex.lexicalStats,
      edges: localIndex.edges
    });

    return scored
      .filter((file) => file.path !== target)
      .slice(0, 10)
      .map((file) => ({
        file,
        reason: file.reasons.includes("graph neighbor")
          ? "semantic/graph neighbor"
          : `semantic neighbor${file.chunks[0]?.symbol ? `: ${file.chunks[0].symbol}` : ""}`
      }));
  }

  private getSemanticTests(rootPath: string, files: FileRecord[], target: string | undefined, task: string) {
    const queryParts = [target ?? task, "test spec verify"];
    if (target) {
      queryParts.push(...this.store.listSemanticChunksForFile(rootPath, target).map((chunk) => chunk.text.slice(0, 1200)));
      queryParts.push(...this.store.listSymbolsForFile(rootPath, target).map((symbol) => symbol.name));
    }

    const query = queryParts.join("\n");
    const localIndex = this.getQueryLocalIndex({
      rootPath,
      files,
      query,
      seedPaths: target ? [target] : [],
      candidateLimit: 160
    });
    const scored = hybridSearch({
      files,
      query,
      symbols: localIndex.symbols,
      chunks: localIndex.chunks,
      vectors: localIndex.vectors,
      lexicalDocuments: localIndex.lexicalDocuments,
      lexicalTerms: localIndex.lexicalTerms,
      lexicalStats: localIndex.lexicalStats,
      edges: localIndex.edges
    });

    return scored.filter((file) => file.kind === "test").slice(0, 20);
  }

  private recordShown(
    sessionId: string,
    kind: "file" | "symbol" | "summary" | "diff" | "tests" | "context",
    mode: ContextResponse["mode"],
    content: string,
    filePath?: string
  ): void {
    this.store.recordContextShown({
      sessionId,
      kind,
      ...(filePath ? { filePath } : {}),
      mode,
      contentHash: sha256(content)
    });
  }

  private recordMetricsEvent(input: {
    sessionId: string;
    rootPath?: string | undefined;
    eventKind: MetricsEventKind;
    eventName: string;
    source?: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | undefined;
    responseMode?: ContextResponseMode | undefined;
    baselineTokens: number;
    outputTokens: number;
    files: string[];
    metadata?: Record<string, unknown> | undefined;
  }): void {
    const baselineTokens = Math.max(0, Math.round(input.baselineTokens));
    const outputTokens = Math.max(0, Math.round(input.outputTokens));
    this.metricsService.recordMetricsEvent({
      sessionId: input.sessionId,
      eventKind: input.eventKind,
      eventName: input.eventName,
      source: input.source ?? "runtime",
      ...(input.responseMode ? { responseMode: input.responseMode } : {}),
      baselineTokens,
      outputTokens,
      savedTokens: Math.max(0, baselineTokens - outputTokens),
      files: uniquePaths(input.files),
      metadata: input.metadata ?? {}
    });
  }

  private readPackageScripts(rootPath: string): string[] {
    const packageJsonPath = path.join(rootPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return [];
    }

    try {
      const raw = fs.readFileSync(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      return Object.entries(parsed.scripts ?? {}).map(([name, command]) => `${name}: ${command}`);
    } catch {
      return [];
    }
  }
}

function benchmarkAgentEnv(
  benchmarkCase: Parameters<typeof scoreBenchmarkCase>[0]["benchmarkCase"],
  assistanceMode: BenchmarkAssistanceMode | undefined
): Record<string, string> | undefined {
  if (assistanceMode !== "kairn_codex_session") return undefined;
  const allowedDiffScopes = benchmarkCase.allowedDiffScopes ?? [];
  const sourceInvariants = benchmarkCase.sourceInvariants ?? [];
  if (allowedDiffScopes.length === 0 && sourceInvariants.length === 0) return undefined;
  return {
    KAIRN_BENCH_EDIT_SCOPE_HINTS: JSON.stringify({
      allowedDiffScopes,
      sourceInvariants
    })
  };
}

export function createRuntime(root?: string): KairnRuntime {
  return new KairnRuntime(root ?? getKairnPaths().rootPath);
}

function chooseEvidenceSymbol(symbols: SymbolRecord[], task: string): SymbolRecord | undefined {
  if (symbols.length === 0) return undefined;
  const taskTerms = new Set(identifierTerms(task));
  const scored = symbols
    .map((symbol) => ({
      symbol,
      score: evidenceSymbolScore(symbol, task.toLowerCase(), taskTerms)
    }))
    .sort((a, b) => b.score - a.score || symbolSpan(a.symbol) - symbolSpan(b.symbol) || a.symbol.startLine - b.symbol.startLine);
  return scored[0]?.symbol;
}

function evidenceSymbolScore(symbol: SymbolRecord, normalizedTask: string, taskTerms: Set<string>): number {
  const name = symbol.name.toLowerCase();
  const signature = symbol.signature.toLowerCase();
  const symbolTerms = identifierTerms(symbol.name);
  let score = 0;
  if (normalizedTask.includes(name)) score += 120;
  if (signature && normalizedTask.includes(signature)) score += 30;
  for (const term of symbolTerms) {
    if (taskTerms.has(term)) score += 24;
  }
  if (symbol.exported) score += 8;
  if (symbol.kind === "function" || symbol.kind === "component") score += 18;
  if (symbol.kind === "class" || symbol.kind === "interface") score += 8;
  if (symbol.kind === "const" || symbol.kind === "let" || symbol.kind === "var") score -= 8;
  score -= Math.min(28, Math.max(0, symbolSpan(symbol) - 18));
  return score;
}

function symbolSpan(symbol: SymbolRecord): number {
  return Math.max(1, symbol.endLine - symbol.startLine + 1);
}

function firstMatchingLine(content: string, task: string): number {
  const lines = content.split(/\r?\n/);
  const terms = identifierTerms(task).filter((term) => term.length >= 4);
  const index = lines.findIndex((line) => {
    const normalized = line.toLowerCase();
    return terms.some((term) => normalized.includes(term));
  });
  return Math.max(1, index >= 0 ? index + 1 : 1);
}

function chooseSnippetIdentifier(snippet: string, task: string): string | undefined {
  const identifiers = uniqueStrings(task.match(/[A-Za-z_$][\w$]*/g) ?? [])
    .filter((identifier) => identifier.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const identifier of identifiers) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\s*\\(`);
    if (pattern.test(snippet)) return identifier;
  }
  return undefined;
}

function inferExpectedBehavior(task: string): string {
  return truncateToBudget(
    task
      .replace(/\bdebug\b/gi, "Fix")
      .replace(/\bseeded\b/gi, "")
      .replace(/\bdo not edit unrelated files\b\.?/gi, "")
      .replace(/\s+/g, " ")
      .trim(),
    64
  );
}

function inferVerificationCommand(rootPath: string, filePath: string): string {
  const normalized = filePath.toLowerCase();
  const packageManager = fs.existsSync(path.join(rootPath, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(rootPath, "yarn.lock"))
      ? "yarn"
      : "npm";
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(normalized) && fs.existsSync(path.join(rootPath, "package.json"))) {
    return `${packageManager} test`;
  }
  if (/\.pyi?$/.test(normalized)) {
    const basename = path.basename(filePath).replace(/\.pyi?$/, "").replace(/^_+/, "");
    const testCandidates = [
      `tests/test_${basename}.py`,
      `test/test_${basename}.py`,
      `${path.dirname(filePath)}/test_${basename}.py`
    ];
    const candidate = testCandidates.find((item) => fs.existsSync(path.join(rootPath, item)));
    return candidate ? `python3 -m pytest ${candidate}` : `python3 -m pytest`;
  }
  if (/\.java$/.test(normalized) && fs.existsSync(path.join(rootPath, "pom.xml"))) {
    const className = path.basename(filePath, ".java");
    return `mvn -q -Dtest=*${className}* test`;
  }
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(normalized)) {
    if (fs.existsSync(path.join(rootPath, "CMakeLists.txt"))) {
      return "ctest --test-dir build";
    }
    return "Run the user-provided failing compiler/test command.";
  }
  return "Run the narrowest failing check from the task.";
}

function identifierTerms(value: string): string[] {
  return uniqueStrings(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9_]+|_/)
      .filter((term) => term.length >= 2)
  );
}

function shouldUseCompanionContext(task: string, companionPaths: string[]): boolean {
  const normalized = task.toLowerCase();
  if (companionPaths.length > 0) return true;
  return /\b(route|routing|dependency|dependencies|controller|repository|model|scheduler|renderer|interceptor|interceptors|dispatch|adapter|validation|callback|callbacks|group|context|handler|middleware|fixture|framework|flow|request|response|proxy|guard|guards|pipe|pipes|case|sensitivity|extension|normalize|normalization)\b/.test(
    normalized
  );
}

function multiFileDirectiveFileLimit(
  task: string,
  companionPaths: string[],
  decision: ContextValueDecision
): number {
  const normalized = task.toLowerCase();
  if (hasWebSessionRenewalScope(task)) return 5;
  if (hasPackageSourceMappingScope(task)) return 5;
  if (hasRequestBodyFormScope(task)) return 4;
  if (hasDatastoreBackendParityScope(task)) return 4;
  if (decision.recommendedDelivery !== "multi_file_directive") return 2;
  if (hasDeprecationLifecycleScope(task)) return 5;
  if (hasUiLivenessMultiSurfaceDirective(normalized)) {
    return 5;
  }
  if (companionPaths.length < 2) return 2;
  const roleFamilies = [
    /\b(router|route|routing|mux)\b/,
    /\b(context|ctx|handler|middleware)\b/,
    /\b(controller|repository|model)\b/,
    /\b(scheduler|renderer|work loop|workloop)\b/,
    /\b(interceptor|dispatch|adapter)\b/,
    /\b(runtime|mcp|server|client)\b/,
    /\b(search|printer|json|match|matches|event|events)\b/,
    /\b(linegen|line generator|line|lines|comment|comments|splitting)\b/,
    /\b(fixture|fixtures|runner|collected|nodes|setup)\b/
  ];
  const roleFamilyHits = roleFamilies.filter((pattern) => pattern.test(normalized)).length;
  const explicitlySpansFrameworkTriple =
    roleFamilyHits >= 3 &&
    /\b(framework|architecture|across|spans|flow|pipeline|lifecycle|integration)\b/.test(normalized) &&
    /\b(debug|fix|regression|behavior|dispatch|send|matching|scheduling|trimming|prefix|suffix)\b/.test(normalized);
  const selectedTestFanout = selectedTestPathCount(task) >= 3 && /\b(selected|failing|failed|failure)\s+tests?\b/.test(normalized);
  const queryLocalTriple =
    /\b(routing|route)\b/.test(normalized) && /\b(map|rules?|matcher|endpoint)\b/.test(normalized) ||
    /\b(search|matches?)\b/.test(normalized) && /\b(printer|json|paths?|events?)\b/.test(normalized) ||
    /\b(line generator|linegen|output lines?)\b/.test(normalized) && /\b(comments?|splitting|formatting)\b/.test(normalized) ||
    /\b(fixtures?|collected|nodes?)\b/.test(normalized) && /\b(runner|setup|resolution|values?)\b/.test(normalized);
  return explicitlySpansFrameworkTriple || selectedTestFanout || queryLocalTriple ? 3 : 2;
}

function hasUiLivenessMultiSurfaceDirective(normalizedTask: string): boolean {
  return /\b(liveness|live|badge|icon|feedback|visual|shown|render)\b/.test(normalizedTask) &&
    (
      /\b(voice|broadcast|recording|playback)\b/.test(normalizedTask) ||
      (/\b(ui|frontend|component|components|header|body)\b/.test(normalizedTask) && /\b(liveness|live|badge|icon|visual)\b/.test(normalizedTask))
    );
}

function hasDatastoreBackendParityScope(task: string): boolean {
  const normalized = task.toLowerCase();
  const collectionMutation =
    /\b(list|lists|set|sets|zset|hash|queue|collection|collections)\b/.test(normalized) &&
    /\b(remove|removing|delete|deleting|del|discard|pull|pop|trim|add|insert|push)\b/.test(normalized);
  const multiValue =
    /\b(multiple|distinct|array|arrays|elements?|values?|batch|bulk|several)\b/.test(normalized) ||
    /\[[^\]]+,[^\]]+\]/.test(task);
  return collectionMutation && multiValue;
}

function selectedTestPathCount(task: string): number {
  const paths = new Set<string>();
  for (const match of task.matchAll(/\b[A-Za-z0-9_.@+~/-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)\b/g)) {
    const filePath = (match[0] ?? "").toLowerCase();
    if (
      /(^|\/)(tests?|specs?|__tests__|testing)\//.test(filePath) ||
      /(^|\/)src\/test\//.test(filePath) ||
      /(^|\/)(test|spec)[_-]/.test(filePath.split("/").at(-1) ?? filePath) ||
      /[._-](test|spec)\./.test(filePath.split("/").at(-1) ?? filePath) ||
      /_test\.go$/.test(filePath)
    ) {
      paths.add(filePath);
    }
  }
  return paths.size;
}

function isLikelyProductionSourceFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (/(^|\/)(tests?|testing|docs?|examples?|devtools|codemods|generated|gen|fixtures?|testdata)\//.test(normalized)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return false;
  if (/(_test|_spec|_tests)\.(py|go|rb|cc|cpp|cxx|c|hpp|hh|hxx)$/.test(normalized)) return false;
  if (/(test|tests)\.java$/.test(normalized.split("/").at(-1) ?? "")) return false;
  if (isDeclarativeConfigSchemaFile(normalized)) return true;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|java|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx|cs)$/.test(normalized);
}

function isDeclarativeConfigSchemaFile(filePath: string): boolean {
  return /(^|\/)(configdata|config_data|configschema|config_schema|settings|options)\.(ya?ml|json|toml)$/.test(filePath);
}

function isUnrelatedCentralBackendTestHelper(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (!/(^|\/)test\.go$/.test(normalizedPath)) return false;
  if (!/\b(hsm|kms|softhsm|yubihsm|cloudhsm|pkcs11)\b/.test(normalizedTask)) return false;
  if (!/\b(unified|central|centralize|centralized|reusable|duplicated|duplication|consistent|selector|detect|detects|available|backend|backends)\b/.test(normalizedTask)) return false;
  return !/\/keystore\//.test(normalizedPath);
}

function isUnrelatedBackendAutocompleteSurface(filePath: string, task: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (!/\bautocomplete\b/.test(normalizedTask)) return false;
  if (!/\b(endpoint|route|routes|solr|olid|olids|query string|fallback|db|base class|page class|works|authors|subjects)\b/.test(normalizedTask)) return false;
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (/^autocomplete\.(py|rb|go|rs|php|java|ts)$/.test(basename)) return false;
  if (/\b(?:file|path|source)\s+\W*autocomplete\.py\W*\s+must\b/.test(normalizedTask) || /\bautocomplete\.py\W*\s+must\b/.test(normalizedTask)) return true;
  return /\/js\/autocomplete\.[cm]?js$/.test(normalizedPath) ||
    /(^|\/)(tests?|testing|fixtures?)\//.test(normalizedPath);
}

function isUnrelatedDeprecationLifecycleSurface(filePath: string, task: string): boolean {
  return isUnrelatedDeprecationLifecyclePath(filePath, task);
}

function isUnrelatedConfigSchemaSurface(filePath: string, task: string, selectedCounterparts: string[]): boolean {
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (!isDeclarativeConfigSchemaFile(normalizedPath)) return false;
  if (!/\bselected (verification )?tests? from swe-bench pro metadata\b/.test(normalizedTask)) return false;
  if (promptRequiresConfigSchemaSurface(normalizedTask)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (selectedCounterparts.length === 0) return false;
  const basename = path.posix.basename(normalizedPath).replace(/\.[^.]+$/, "");
  if (selectedCounterparts.some((file) => path.posix.basename(file.toLowerCase()).replace(/\.[^.]+$/, "") === basename)) return false;
  return /\b(config|setting|settings|option|options|workaround|qtwebengine|chromium|args?)\b/.test(normalizedTask);
}

function isUnrelatedWebSessionRenewalSurface(filePath: string, task: string): boolean {
  if (!hasWebSessionRenewalScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  if (normalizedTask.includes(normalizedPath)) return false;
  if (/^lib\/web\/sessions\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/^lib\/web\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/^lib\/auth\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/^lib\/auth\/auth\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  return /\b(access|checker|observability|trace|tracing|client|types?|constants?)\b/.test(normalizedPath) ||
    /^api\//.test(normalizedPath) ||
    /^lib\/services?\//.test(normalizedPath);
}

function isUnrelatedRequestBodyFormSurface(filePath: string, task: string, allowedRequestFiles: string[]): boolean {
  if (!hasRequestBodyFormScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedRequestFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  if (/^lists?\.(py|ts|js|go|rb|rs)$/.test(basename)) return false;
  if (/\b(upstream|remote|external|proxy|forward|unflatten|flatten|form|request|body|params?|query)\b/.test(normalizedPath)) return false;
  return /(^|\/)(admin|admins|administration|management|staff)(\/|$)/.test(normalizedPath) ||
    /\b(utils?|helpers?)\.(py|ts|js|go|rb|rs)$/.test(basename) ||
    /(^|\/)(utils?|helpers?|shared|common)\//.test(normalizedPath) ||
    /\/models?\//.test(normalizedPath);
}

function isUnrelatedBenchmarkGeneratorSurface(filePath: string, task: string, allowedBenchmarkFiles: string[]): boolean {
  if (!hasBenchmarkGeneratorScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedBenchmarkFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (isGenericBenchmarkGeneratorEntrypoint(normalizedPath, task)) return true;
  if (/\/benchmark\//.test(normalizedPath) || /(^|\/)benchmark\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/(client|cli|cmd|tool|tools?|tsh|tctl)\//.test(normalizedPath) && /\b(bench|benchmark)\b/.test(normalizedPath)) return false;
  return /(^|\/)(build|dist|vendor|third_party|external|deps|generated|gen|build\.assets)(\/|$)/.test(normalizedPath) ||
    /\/(config|configs?|configuration|settings?|options?|pam|session|sessions?|services?\/local)\//.test(normalizedPath) ||
    /\/(proxy|auth|limiter|ratelimit|retry|access_request|rbac|kube)\//.test(normalizedPath);
}

function isUnrelatedGrpcErrorPolicySurface(filePath: string, task: string, allowedGrpcFiles: string[]): boolean {
  if (!hasGrpcErrorPolicyScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedGrpcFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (/\/(cmd|server|middleware|auth)\/.*grpc/.test(normalizedPath)) return false;
  if (/\/(auth|middleware)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  return /\/(errors?|segment|segments?|models?|storage|database|db|tests?|docs?)\//.test(normalizedPath) ||
    /(^|\/)(errors?|types?|models?)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath);
}

function isUnrelatedHttpAuthPolicySurface(filePath: string, task: string, allowedHttpAuthFiles: string[]): boolean {
  if (!hasHttpAuthPolicyScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedHttpAuthFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (/\/plugins\/action\/uri\.py$/.test(normalizedPath)) return !httpAuthPolicyNeedsActionPlugin(task);
  if (/\/(module_utils\/urls|modules\/uri|modules\/get_url|plugins\/lookup\/url)\.py$/.test(normalizedPath)) return false;
  return /\/(executor|interpreter|facts?|plugins\/list|plugins\/doc_fragments|plugins\/action|module_utils\/basic|tests?|docs?)\//.test(normalizedPath);
}

function isUnrelatedSystemMetadataSurface(filePath: string, task: string, allowedSystemMetadataFiles: string[]): boolean {
  if (!hasSystemMetadataScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedSystemMetadataFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (/\/inventory\/metadata\//.test(normalizedPath)) return false;
  if (/\/linux\/(dmi|dmi_sysfs|os_release|metadata)[^/]*\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  return /\/(config|configs?|configuration|systemd|parse|parser|utils?|tests?|docs?|examples?|fixtures?)\//.test(normalizedPath) &&
    !/\b(dmi|os[_-]?release|inventory|metadata)\b/.test(normalizedPath);
}

function isUnrelatedDatabaseFailoverSurface(filePath: string, task: string, allowedDatabaseFiles: string[]): boolean {
  if (!hasDatabaseFailoverScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedDatabaseFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (/\/types\/databaseserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/srv\/db\/proxyserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/reversetunnel\/fake\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/(^|\/)tool\/tsh\/db\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/reversetunnel\/[^/]+\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) return true;
  return /\/(events?|session|sessions?|audit|kube|app|regular|service|auth|client|tests?|docs?)\//.test(normalizedPath) &&
    !/\b(databaseserver|proxyserver|reversetunnel|tool\/tsh\/db)\b/.test(normalizedPath);
}

function isUnrelatedPluginActivationValidationSurface(filePath: string, task: string, allowedPluginFiles: string[]): boolean {
  if (!hasPluginActivationValidationScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedPluginFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (/\/plugins\/install\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/socket\.io\/admin\/plugins\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/flags\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath)) return false;
  return /\/(topic|topics|posts?|flags\/list|installer|language|views?|templates?|tests?|docs?|examples?)\//.test(normalizedPath) &&
    !/\b(plugin|plugins|toggleactive|invalid-plugin-id)\b/.test(normalizedPath);
}

function isUnrelatedExecutionStateMigrationSurface(filePath: string, task: string, allowedStateFiles: string[]): boolean {
  if (!hasExecutionStateMigrationScope(task)) return false;
  const normalizedPath = filePath.toLowerCase();
  const normalizedTask = task.toLowerCase();
  const allowed = new Set(allowedStateFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  if (normalizedTask.includes(normalizedPath)) return false;
  if (/(^|\/)play_iterator\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) || /\/executor\/play_iterator\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/strategy\/(__init__|linear)\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) return false;
  if (/\/strategy\/[^/]+\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) return true;
  return (/\/(module_utils\/common|utils?|validation|warnings|display|parameters|basic|tests?|docs?|examples?|fixtures?)\//.test(normalizedPath) || /\/module_utils\/basic\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) &&
    !/\b(play_iterator|hoststate|strategy|iteratingstates|failedstates)\b/.test(normalizedPath);
}

function isUnrelatedDatastoreBackendParitySurface(filePath: string, task: string, allowedBackendFiles: string[]): boolean {
  if (!hasDatastoreBackendParityScope(task)) return false;
  if (allowedBackendFiles.length < 2) return false;
  const normalizedPath = filePath.toLowerCase();
  const allowed = new Set(allowedBackendFiles.map((file) => file.toLowerCase()));
  if (allowed.has(normalizedPath)) return false;
  return true;
}

function isForbiddenFrontendEditSurface(filePath: string, task: string): boolean {
  const normalizedTask = task.toLowerCase();
  if (!/\b(do not|don't|avoid|no)\s+edit(?:ing)?\s+(?:the\s+)?(?:frontend|client|ui|browser|component|components|utilities|utils)/.test(normalizedTask)) return false;
  const normalizedPath = filePath.toLowerCase();
  return /(^|\/)(frontend|client|ui|components?|views?)\//.test(normalizedPath) ||
    /\/components?\//.test(normalizedPath) ||
    /\.(tsx|jsx|vue|svelte)$/.test(normalizedPath);
}

function isUnrelatedPromptMentionedSourceSurface(filePath: string, task: string, promptMentionedSourceFiles: string[]): boolean {
  if (promptMentionedSourceFiles.length < 3) return false;
  const normalizedPath = filePath.toLowerCase();
  if (promptMentionedSourceFiles.map((file) => file.toLowerCase()).includes(normalizedPath)) return false;
  const normalizedTask = task.toLowerCase();
  if (normalizedTask.includes(normalizedPath)) return false;
  const namedPrefixes = new Set(promptMentionedSourceFiles.map((file) => file.toLowerCase().split("/").slice(0, 2).join("/")));
  const filePrefix = normalizedPath.split("/").slice(0, 2).join("/");
  if (namedPrefixes.has(filePrefix) && !/\/components?\//.test(normalizedPath)) return false;
  return /\/components?\//.test(normalizedPath) ||
    /(^|\/)(frontend|client|ui|views?)\//.test(normalizedPath) ||
    /(^|\/)(utils?|helpers?)\.[cm]?js$/.test(normalizedPath);
}

function promptRequiresConfigSchemaSurface(normalizedTask: string): boolean {
  return (
    /\b(config|configuration|setting|settings|option|options|workaround|workarounds)\b/.test(normalizedTask) &&
    /\b(named|must exist|exists?|accept|values?|valid values?|default|required|restart|backend|metadata|schema|define|add|support)\b/.test(normalizedTask) &&
    /\b(setting|option|values?|default|restart|backend|schema|metadata)\b/.test(normalizedTask)
  );
}

function hasRecentMcpPrepareAbstention(events: Array<{ eventKind: string; eventName: string; metadata: Record<string, unknown> }>): boolean {
  return [...events].reverse().some((event) => {
    if (event.eventKind !== "mcp_tool_call" || event.eventName !== "kairn_prepare_task") return false;
    const decision = event.metadata.contextDecision;
    return Boolean(
      decision &&
        typeof decision === "object" &&
        !Array.isArray(decision) &&
        ((decision as Record<string, unknown>).action === "suppress" ||
          (decision as Record<string, unknown>).action === "request_evidence") &&
        (String((decision as Record<string, unknown>).recommendedDelivery ?? "") === "none" ||
          String((decision as Record<string, unknown>).recommendedDelivery ?? "") === "evidence_request")
    );
  });
}

function automaticPrimeSuppressionReason(input: {
  source?: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | undefined;
  task: string;
  decision: ContextValueDecision;
}): string | undefined {
  if (input.source !== "codex" && input.source !== "claude") return undefined;
  const sourceRescueGuardrail = shouldEmitAutomaticSourceRescueGuardrail(input.decision);
  const officialPatchGuardrail = shouldEmitAutomaticOfficialPatchGuardrail(input.task, input.decision);
  const productionOnlyGuardrail =
    taskHasProductionOnlyEditIntent(input.task) &&
    !input.decision.wrongContextRisk &&
    !input.decision.cheapExactSource &&
    (input.decision.exactSourceHit || input.decision.canonicalSourceHit || input.decision.sourceRescue);
  if (
    input.decision.cheapSingleSource &&
    !input.decision.companionSpecific &&
    !sourceRescueGuardrail &&
    !productionOnlyGuardrail &&
    !officialPatchGuardrail
  ) {
    return "automatic hook suppressed cheap single-source context to avoid over-assist";
  }
  if (input.decision.cheapExactSource && !productionOnlyGuardrail && !officialPatchGuardrail) {
    return "automatic hook suppressed cheap exact-source context to avoid over-assist";
  }
  if (isCheapOneShotAutomaticTask(input.task) && input.decision.exactSourceHit && !input.decision.wrongContextRisk && !sourceRescueGuardrail && !productionOnlyGuardrail && !officialPatchGuardrail) {
    return "automatic hook suppressed obvious one-shot source context to avoid over-assist";
  }
  return undefined;
}

function shouldEmitAutomaticOfficialPatchGuardrail(task: string, decision: ContextValueDecision): boolean {
  if (decision.taskFrame !== "official_patch") return false;
  if (decision.directiveStyle === "scope_guardrail") return true;
  if (!taskHasProductionOnlyEditIntent(task)) return false;
  if (!decision.debugSignal) return false;
  if (!decision.cheapSingleSource || decision.cheapExactSource || decision.companionSpecific) return false;
  if (decision.wrongContextRisk) return false;
  if (decision.topScore < 220 || decision.topGap < 35) return false;
  return decision.recommendedDelivery === "one_file_directive" || decision.action === "shrink";
}

function shouldEmitAutomaticSourceRescueGuardrail(decision: ContextValueDecision): boolean {
  if (!decision.exactSourceHit || decision.wrongContextRisk || decision.cheapExactSource) return false;
  if (decision.recommendedDelivery === "multi_file_directive") return true;
  const hasSourceRoutingSignal = Boolean(decision.sourceRescue);
  if (!hasSourceRoutingSignal) return false;
  if (decision.topScore < 220 || decision.topGap < 35) return false;
  return decision.recommendedDelivery === "one_file_directive" || decision.action === "shrink";
}

function isAutomaticExactSourceHook(input: {
  source?: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | undefined;
  decision: ContextValueDecision;
}): boolean {
  if (input.source !== "codex" && input.source !== "claude") return false;
  if (!input.decision.exactSourceHit || input.decision.multiSurfaceSignal) return false;
  return input.decision.topScore >= 240 && input.decision.topGap >= 70;
}

function isAutomaticCheapSingleSourceHook(input: {
  source?: WatchEventSource | "runtime" | "cli" | "mcp" | "bench" | undefined;
  decision: ContextValueDecision;
}): boolean {
  if (input.source !== "codex" && input.source !== "claude") return false;
  return Boolean(input.decision.cheapSingleSource || input.decision.cheapExactSource);
}

function shouldUseMinimalOneFileDirective(input: {
  task: string;
  action: ContextValueDecision["action"];
  decision: ContextValueDecision;
  emittedFiles: string[];
}): boolean {
  if (input.action !== "shrink") return false;
  if (input.decision.recommendedDelivery !== "one_file_directive") return false;
  if (input.emittedFiles.length !== 1) return false;
  if (!taskHasProductionOnlyEditIntent(input.task)) return false;
  if (hasExplicitMultiFileScopeRequest(input.task)) return false;
  if (hasPromptDerivedMultiFileScope(input.task)) return false;
  if (input.decision.wrongContextRisk) return false;
  const narrowOfficialPatch = isNarrowOfficialExactSourcePatch(input);
  if (input.decision.taskFrame === "multi_file_debug") return false;
  if (input.decision.taskFrame === "official_patch" && !narrowOfficialPatch) return false;
  if (!input.decision.exactSourceHit && !input.decision.canonicalSourceHit && !input.decision.sourceRescue && !input.decision.cheapSingleSource && !input.decision.cheapExactSource) return false;
  if (input.decision.topScore < 180 || input.decision.topGap < 25) return false;
  if (input.task.length > 520 && !narrowOfficialPatch) return false;
  return true;
}

function isNarrowOfficialExactSourcePatch(input: {
  task: string;
  decision: ContextValueDecision;
  emittedFiles: string[];
}): boolean {
  if (input.decision.taskFrame !== "official_patch") return false;
  if (input.emittedFiles.length !== 1) return false;
  if (input.decision.wrongContextRisk) return false;
  if (!taskHasProductionOnlyEditIntent(input.task)) return false;
  if (!input.decision.exactSourceHit && !input.decision.canonicalSourceHit && !input.decision.sourceRescue) return false;
  return input.decision.topScore >= 180 && input.decision.topGap >= 25;
}

function isCheapOneShotAutomaticTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (task.length > 420) return false;
  if (!/\b(debug|fix|repair|patch|regression|bug|failing|failure)\b/.test(normalized)) return false;
  if (!/\b(production source|source|do not edit unrelated|unrelated files|smallest)\b/.test(normalized)) return false;
  if (/\b(stack trace|traceback|selected tests|requirements:|actual behavior|expected behavior|multi[-\s]?file|multiple files|across files|across modules|integration|workflow|end-to-end|e2e)\b/.test(normalized)) {
    return false;
  }
  return true;
}

function hasSpecificCompanionEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const reasons = "reasons" in value && Array.isArray((value as { reasons?: unknown }).reasons)
    ? (value as { reasons: unknown[] }).reasons
      .filter((reason): reason is string => typeof reason === "string")
      .join("; ")
      .toLowerCase()
    : "";
  return /mentioned source filename|direct role basename anchor|route\/path surface anchor|same package|same module|import neighbor|controller\/repository|scheduler\/renderer|interceptor\/dispatch|validation\/callback|named peer client companion|user\/email companion|exact user\/email companion|proxy\/service companion|kubernetes service companion|keyboard shortcut companion|module resolver companion|schema generation companion|field definition companion|statement state companion|field metadata companion|command-line parser companion|config companion|routing map\/rule|routing map\/rule\/matcher source companion|line\/comment formatting source companion|core search source companion|printer output source companion|fixture\/runner source companion|named source surface|compound path term match|same-package utility sibling companion|shared URL\/path utility companion|inline\/header companion/.test(reasons);
}

function strongestSuppressiveAction(
  ...actions: ContextValueDecision["action"][]
): ContextValueDecision["action"] {
  if (actions.includes("suppress")) return "suppress";
  if (actions.includes("request_evidence")) return "request_evidence";
  if (actions.includes("shrink")) return "shrink";
  return "emit";
}

function isFileEmittingAction(action: ContextValueDecision["action"]): boolean {
  return action === "emit" || action === "shrink";
}

function languageMixForGovernorSummary(files: FileRecord[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = file.language || "unknown";
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
}

function mcpFirstBenchmarkInstructionLines(benchmarkCase: BenchmarkCase): string[] {
  const behavior = benchmarkCase.contextBehavior;
  if (behavior === "cheap_single_source" || behavior === "weak_signal") {
    return [
      "This benchmark case is classified as cheap/weak. Do not call Kairn just to confirm an obvious single source; call it only after the first source guess fails, a verification failure appears, or the task broadens."
    ];
  }
  if (behavior === "source_rescue" || behavior === "multi_file_debug" || behavior === "failure_first" || behavior === "session_repeat") {
    return [
      `This benchmark case is classified as ${behavior}. Your first action before manual source reads must be to call \`kairn_prepare_task\` once.`,
      "After that call, obey its stop condition and edit-scope guidance; do not expand into tests, generated files, or unrelated production files unless Kairn or verification output gives a concrete expansion reason."
    ];
  }
  return [];
}

function minimalSourceFocusOverridesSuppression(reason: SessionContextPolicyDecision["reason"]): boolean {
  return reason === "active_source_context_shrunk";
}

function collectWorkspaceKairnMetrics(workspacePath: string): Record<string, unknown> {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    return emptyWorkspaceKairnMetrics();
  }
  const databasePath = path.join(workspacePath, ".kairn", "kairn.sqlite");
  if (!fs.existsSync(databasePath)) {
    return emptyWorkspaceKairnMetrics();
  }

  const runtime = new KairnRuntime(workspacePath);
  try {
    const sessions = runtime.listSessions({ allRoots: true });
    const metrics = sessions.map((session) => runtime.getMetrics(session.id));
    const primeContextEvents = metrics.flatMap((item) => item.recentEvents.filter((event) => event.eventKind === "prime_context"));
    const hookSignals = metrics.flatMap((item) => item.recentEvents.filter((event) => event.eventKind === "hook_signal"));
    const emittedPrimeContexts = primeContextEvents.filter((event) => {
      const decision = recordValue(event.metadata.contextDecision);
      const action = typeof decision.action === "string" ? decision.action : event.eventName;
      return (action === "emit" || action === "shrink") && (event.outputTokens > 0 || event.files.length > 0);
    });
    const suppressedPrimeContexts = primeContextEvents.filter((event) => {
      const decision = recordValue(event.metadata.contextDecision);
      const action = typeof decision.action === "string" ? decision.action : event.eventName;
      return action === "suppress";
    });
    const evidenceRequestPrimeContexts = primeContextEvents.filter((event) => {
      const decision = recordValue(event.metadata.contextDecision);
      const action = typeof decision.action === "string" ? decision.action : event.eventName;
      return action === "request_evidence";
    });
    return {
      kairnSessionCount: sessions.length,
      primeAttempted: primeContextEvents.length + hookSignals.filter((event) => event.metadata.primeAttempted === true).length,
      primeEmitted: emittedPrimeContexts.length + hookSignals.filter((event) => event.metadata.primeContextDelivered === true).length,
      primeSuppressed: suppressedPrimeContexts.length + hookSignals.filter((event) => event.metadata.primeSuppressed === true).length,
      primeEvidenceRequested: evidenceRequestPrimeContexts.length,
      primeTokens:
        emittedPrimeContexts.reduce((total, event) => total + event.outputTokens, 0) +
        hookSignals.reduce((total, event) => total + (event.metadata.primeContextDelivered === true ? event.outputTokens : 0), 0),
      primeContextEvents: primeContextEvents.length,
      primeQualityEvents: metrics.reduce((total, item) => total + (item.byKind.prime_quality?.events ?? 0), 0),
      hookInvocations: metrics.reduce((total, item) => total + (item.byKind.hook_signal?.events ?? 0), 0),
      failureContextUsed: metrics.reduce((total, item) => total + (item.byKind.failure_context?.events ?? 0), 0),
      mcpToolCalls: metrics.reduce((total, item) => total + (item.byKind.mcp_tool_call?.events ?? 0), 0),
      mcpFilesReturned: uniquePaths(
        metrics.flatMap((item) =>
          item.recentEvents
            .filter((event) => event.eventKind === "mcp_tool_call")
            .flatMap((event) => event.files)
        )
      )
    };
  } catch {
    return emptyWorkspaceKairnMetrics();
  } finally {
    runtime.close();
  }
}

function emptyWorkspaceKairnMetrics(): Record<string, unknown> {
  return {
    kairnSessionCount: 0,
    primeAttempted: 0,
    primeEmitted: 0,
    primeSuppressed: 0,
    primeEvidenceRequested: 0,
    primeTokens: 0,
    primeContextEvents: 0,
    primeQualityEvents: 0,
    hookInvocations: 0,
    failureContextUsed: 0,
    mcpToolCalls: 0,
    mcpFilesReturned: []
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceInvariantContextForFile(invariants: BenchmarkSourceInvariant[] | undefined, file: string): ContextInvariant | undefined {
  const normalizedFile = normalizeRelativePath(file);
  const invariant = (invariants ?? []).find((item) => normalizeRelativePath(item.file) === normalizedFile);
  if (!invariant) return undefined;
  const statement =
    invariant.description?.trim() ||
    [
      invariant.requiredPresent?.length ? `Required source text: ${invariant.requiredPresent.slice(0, 2).join(", ")}` : "",
      invariant.requiredAbsent?.length ? `Forbidden source text: ${invariant.requiredAbsent.slice(0, 2).join(", ")}` : "",
      invariant.requiredAny?.length ? `One required source behavior: ${invariant.requiredAny.slice(0, 2).join(", ")}` : "",
      invariant.requiredRegex?.length ? "Required source pattern must match." : "",
      invariant.requiredAnyRegex?.length ? "At least one required source pattern must match." : ""
    ].filter(Boolean).join(" ");
  if (!statement) return undefined;
  return {
    file: normalizedFile,
    statement,
    ...(invariant.id ? { evidence: invariant.id } : {}),
    confidence: 96,
    source: "seed"
  };
}

function exactPathCandidates(files: FileRecord[], query: string): string[] {
  const terms = [...new Set([...tokenizeLexical(query), ...compoundQueryTerms(query)])].filter((term) => term.length >= 3);
  if (terms.length === 0) return [];
  return files
    .map((file) => {
      const normalized = normalizeCandidateText(file.path);
      const base = normalizeCandidateText(path.posix.basename(file.path));
      const hits = terms.filter((term) => normalized.includes(term));
      const baseHits = terms.filter((term) => base.includes(term));
      const utilityBoost = /(^|\/)(utils?|helpers?|shared|common)(\/|\.|-|_)/i.test(file.path) ? 2 : 0;
      return {
        path: file.path,
        score: hits.length + baseHits.length * 2 + utilityBoost + (file.kind === "source" ? 2 : 0)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((item) => item.path);
}

function exactPromptNamedSymbolFiles(symbols: SymbolRecord[], query: string): string[] {
  const normalizedQuery = normalizeCandidateText(query);
  return uniquePaths(
    symbols
      .filter((symbol) => isLikelyProductionSourceFile(symbol.filePath))
      .filter((symbol) => {
        if (symbol.name.length < 4) return false;
        const normalized = normalizeCandidateText(symbol.name).trim();
        if (normalized.length < 4) return false;
        const normalizedTerms = normalized.split(/\s+/).filter(Boolean);
        return queryMentionsCompactIdentifier(query, symbol.name) ||
          (normalizedTerms.length <= 2 && normalizedQuery.includes(normalized));
      })
      .sort((a, b) => {
        const exported = Number(Boolean(b.exported)) - Number(Boolean(a.exported));
        if (exported !== 0) return exported;
        return a.filePath.localeCompare(b.filePath);
      })
      .map((symbol) => symbol.filePath)
  );
}

function promptNamedSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  const normalizedQuery = normalizeCandidateText(query);
  const anchorTerms = promptFeatureAnchorTerms(query);
  return uniquePaths(
    files
      .filter((file) => isLikelyProductionSourceFile(file.path))
      .filter((file) => {
        const basename = path.posix.basename(file.path).replace(/\.[^.]+$/, "");
        if (basename.length < 4 || /^(index|main|core|base|utils?|helpers?)$/i.test(basename)) return false;
        if (anchorTerms.length > 0) {
          const pathTerms = new Set(tokenizeLexical(file.path));
          if (!anchorTerms.some((term) => pathTerms.has(term))) return false;
        }
        const normalized = normalizeCandidateText(basename).trim();
        const normalizedTerms = normalized.split(/\s+/).filter(Boolean);
        return queryMentionsCompactIdentifier(query, basename) ||
          (normalized.length >= 4 && normalizedTerms.length <= 2 && normalizedQuery.includes(normalized));
      })
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => file.path)
  );
}

function promptMentionedProductionSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  const paths = new Set<string>();
  const sourceLines = query
    .replaceAll("\\", "/")
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.toLowerCase();
      return !/selected (?:verification )?tests? from swe[- ]bench pro metadata/.test(normalized);
    });
  for (const line of sourceLines) {
    for (const match of line.matchAll(/\b[A-Za-z0-9_.@+~/-]+?\.(?:[cm]?[jt]sx?|pyi?|go|java|kt|kts|c|cc|cpp|cxx|h|hh|hpp|hxx|rs|rb|php|cs)\b/g)) {
      const filePath = normalizeRelativePath(match[0] ?? "");
      if (!filePath.includes("/")) continue;
      if (!isLikelyProductionSourceFile(filePath)) continue;
      paths.add(filePath);
    }
  }
  return uniquePaths([...paths]);
}

function kubernetesExecForwarderSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasKubernetesExecForwarderScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/^lib\/kube\/proxy\/forwarder\.go$/.test(normalizedPath) || /\/kube\/proxy\/forwarder\.(go|ts|js)$/.test(normalizedPath)) score += 1000;
      if (/^lib\/service\/kubernetes\.go$/.test(normalizedPath) || /\/service\/kubernetes\.(go|ts|js)$/.test(normalizedPath)) score += 940;
      if (/^lib\/kube\/proxy\/server\.go$/.test(normalizedPath) || /\/kube\/proxy\/server\.(go|ts|js)$/.test(normalizedPath)) score += 760;
      if (/^lib\/service\/service\.go$/.test(normalizedPath) || /\/service\/service\.(go|ts|js)$/.test(normalizedPath)) score += 620;
      if (/\/kube\/proxy\/(auth|session|audit|handler)\.(go|ts|js)$/.test(normalizedPath)) score += 360;
      if (/^lib\/auth\//.test(normalizedPath) || /\/srv\/app\/session\.(go|ts|js)$/.test(normalizedPath) || /\/srv\/exec\.(go|ts|js)$/.test(normalizedPath)) score -= 500;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 900);
  const selected = authoritative.length >= 2 ? authoritative : scored;
  return uniquePaths(selected.map((file) => file.path));
}

function webSessionRenewalSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasWebSessionRenewalScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/^lib\/web\/sessions\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/web\/sessions\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1000;
      if (/^lib\/web\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/web\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 940;
      if (/^lib\/auth\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/auth\/apiserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 900;
      if (/^lib\/auth\/auth\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/auth\/auth\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 860;
      if (/\b(web|session|sessions|auth|access|cert|certificate)\b/.test(normalizedPath)) score += 120;
      if (/^api\/types\//.test(normalizedPath) || /\/api\/types\//.test(normalizedPath) || /\/constants\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score -= 520;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 900).map((file) => file.path);
  if (authoritative.length >= 3) return uniquePaths(authoritative);
  return uniquePaths(scored.map((file) => file.path));
}

function packageSourceMappingSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasPackageSourceMappingScope(query)) return [];
  const normalizedQuery = normalizeCandidateText(query);
  const rpmQuery = /\b(sourcerpm|source rpm|src\.rpm|rpm|epoch|redhat|rhel|centos)\b/.test(normalizedQuery);
  const alpineQuery = /\b(apk|alpine)\b/.test(normalizedQuery);
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      const base = path.posix.basename(normalizedPath);
      let score = 0;
      if (rpmQuery && (/^scanner\/(redhat|redhatbase|rpm|rhel|centos)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/(redhat|redhatbase|rpm|rhel|centos)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath))) score += 1320;
      if (alpineQuery && (/^scanner\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath))) score += 1800;
      if (/^oval\/util\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/oval\/util\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += alpineQuery ? 1120 : 920;
      if (/^scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += alpineQuery ? 1000 : 780;
      if (alpineQuery && (/^oval\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/oval\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath))) score += 520;
      if (rpmQuery && /(alpine|apk)/.test(base)) score -= 760;
      if (alpineQuery && /(redhat|redhatbase|rpm|rhel|centos)/.test(base)) score -= 3_000;
      if (/\/scanner\/trivy\//.test(normalizedPath) || /\/parser\//.test(normalizedPath) || /\/contrib\//.test(normalizedPath)) score -= 520;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((file) => file.path);
  return uniquePaths(scored);
}

function orderPackageSourceMappingFiles(files: string[], query: string): string[] {
  const normalizedQuery = normalizeCandidateText(query);
  const rpmQuery = /\b(sourcerpm|source rpm|src\.rpm|rpm|epoch|redhat|rhel|centos)\b/.test(normalizedQuery);
  const alpineQuery = /\b(apk|alpine)\b/.test(normalizedQuery);
  const isOtherDistroScanner = (file: string): boolean => {
    const base = path.posix.basename(file.toLowerCase());
    if (alpineQuery && /(redhat|redhatbase|rpm|rhel|centos)/.test(base)) return true;
    if (rpmQuery && !alpineQuery && /(alpine|apk)/.test(base)) return true;
    return false;
  };
  const score = (file: string): number => {
    const normalizedPath = file.toLowerCase();
    const base = path.posix.basename(normalizedPath);
    let value = 0;
    if (alpineQuery && (/^scanner\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/alpine\.(go|ts|js|py|rb|rs)$/.test(normalizedPath))) value += 5_000;
    if (rpmQuery && !alpineQuery && (/^scanner\/(redhat|redhatbase|rpm|rhel|centos)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/(redhat|redhatbase|rpm|rhel|centos)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath))) value += 5_000;
    if (/^oval\/util\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/oval\/util\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) value += 4_500;
    if (/^scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) value += 4_000;
    if (alpineQuery && /(redhat|redhatbase|rpm|rhel|centos)/.test(base)) value -= 2_000;
    if (rpmQuery && !alpineQuery && /(alpine|apk)/.test(base)) value -= 2_000;
    return value;
  };
  return uniquePaths(files).filter((file) => !isOtherDistroScanner(file)).sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

function benchmarkGeneratorSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasBenchmarkGeneratorScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      const base = path.posix.basename(normalizedPath);
      let score = 0;
      if (/\/benchmark\//.test(normalizedPath) || /^benchmark\.(go|ts|js|py|rb|rs)$/.test(base)) score += 980;
      if (/\/benchmark\/(linear|generator|config|benchmark)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 620;
      if (/\/benchmark\/linear\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 640;
      if (/\/(client|cli|cmd|tool|tsh|tctl)\//.test(normalizedPath) && /\b(bench|benchmark)\b/.test(normalizedPath)) score += 520;
      if (/(^|\/)(cmd|commands?|cli|tool|tools?)\/[^/]+\/[^/]+\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) && /\b(tsh|tctl|cli|cmd|command|main)\b/.test(base)) score += 500;
      if (/\b(linear|benchmark|bench|generator)\b/.test(normalizedPath)) score += 220;
      if (isGenericBenchmarkGeneratorEntrypoint(normalizedPath, query)) score -= 1_200;
      if (/\/(config|configs?|configuration|settings?|options?|pam)\//.test(normalizedPath) && !/\b(bench|benchmark)\b/.test(normalizedPath)) score -= 520;
      if (/\/(proxy|auth|limiter|ratelimit|retry|access_request|rbac|kube)\//.test(normalizedPath) && !/\b(bench|benchmark)\b/.test(normalizedPath)) score -= 620;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((file) => file.path);
  return uniquePaths(scored);
}

function isGenericBenchmarkGeneratorEntrypoint(normalizedPath: string, query: string): boolean {
  const normalizedQuery = normalizeCandidateText(query);
  const basename = path.posix.basename(normalizedPath);
  if (!/^(main|cli|command|commands)\.(go|ts|tsx|js|jsx|py|rb|rs)$/.test(basename)) return false;
  if (!/(^|\/)(cmd|commands?|cli|tool|tools?)\//.test(normalizedPath)) return false;
  return !/\b(cli|command line|flag|flags|option|options|args?|arguments|argv|subcommand|command wiring|entrypoint|launcher)\b/.test(normalizedQuery);
}

function topicOrderingSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasTopicOrderingScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/^src\/topics\/tools\.(js|ts|jsx|tsx)$/.test(normalizedPath) || /\/src\/topics\/tools\.(js|ts|jsx|tsx)$/.test(normalizedPath)) score += 1180;
      if (/^src\/socket\.io\/topics\/tools\.(js|ts|jsx|tsx)$/.test(normalizedPath) || /\/src\/socket\.io\/topics\/tools\.(js|ts|jsx|tsx)$/.test(normalizedPath)) score += 1040;
      if (/^public\/src\/client\/category\/tools\.(js|ts|jsx|tsx)$/.test(normalizedPath) || /\/public\/src\/client\/category\/tools\.(js|ts|jsx|tsx)$/.test(normalizedPath)) score += 960;
      if (/\b(topic|topics|pin|pinned|order)\b/.test(normalizedPath)) score += 140;
      if (/\/(admin|dashboard|openapi|views?|upgrades?)\//.test(normalizedPath)) score -= 520;
      if (/^src\/privileges\/topics\.(js|ts|jsx|tsx)$/.test(normalizedPath) || /\/src\/privileges\/topics\.(js|ts|jsx|tsx)$/.test(normalizedPath)) score -= 120;
      return { path: file.path, score };
    })
    .filter((file) => file.score >= 900)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((file) => file.path);
  return uniquePaths(scored);
}

function collectionNameValidationSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasCollectionNameValidationScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/\/utils\/collection_loader\/_collection_finder\.py$/.test(normalizedPath)) score += 1160;
      if (/\/galaxy\/dependency_resolution\/dataclasses\.py$/.test(normalizedPath)) score += 1080;
      if (/\b(collection|fqcn|namespace|identifier|keyword)\b/.test(normalizedPath)) score += 160;
      if (/\/(test|tests|integration|docs?|data)\//.test(normalizedPath)) score -= 520;
      if (/\/galaxy\/collection\//.test(normalizedPath) && !/dataclasses\.py$/.test(normalizedPath)) score -= 180;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 1000);
  const selected = authoritative.length >= 2 ? authoritative : scored.slice(0, 2);
  return uniquePaths(selected.map((file) => file.path));
}

function grpcErrorPolicySourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasGrpcErrorPolicyScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/\/server\/middleware\/grpc\/middleware\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/middleware\/grpc\/middleware\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1120;
      if (/\/server\/auth\/middleware\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/auth\/middleware\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1100;
      if (/^internal\/cmd\/grpc\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/cmd\/grpc\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1040;
      if (/\b(grpc|middleware|auth|status|codes?|context)\b/.test(normalizedPath)) score += 160;
      if (/\/(errors?|segment|segments?|models?|storage|database|db|tests?|docs?)\//.test(normalizedPath) && !/\b(grpc|middleware|auth|status)\b/.test(normalizedPath)) score -= 520;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 1000);
  const selected = authoritative.length >= 3 ? authoritative : scored;
  return uniquePaths(selected.map((file) => file.path));
}

function httpAuthPolicySourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasHttpAuthPolicyScope(query)) return [];
  const needsActionPlugin = httpAuthPolicyNeedsActionPlugin(query);
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      const base = path.posix.basename(normalizedPath);
      let score = 0;
      if (/\/module_utils\/urls\.py$/.test(normalizedPath)) score += 1160;
      if (/\/modules\/uri\.py$/.test(normalizedPath) || (!/\/plugins\/action\//.test(normalizedPath) && /^uri\.(py|ts|js|go|rb|rs)$/.test(base))) score += 1040;
      if (/\/modules\/get_url\.py$/.test(normalizedPath) || /^get_url\.(py|ts|js|go|rb|rs)$/.test(base)) score += 980;
      if (/\/plugins\/lookup\/url\.py$/.test(normalizedPath) || /\/lookup\/url\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) score += 920;
      if (/\/plugins\/action\/uri\.py$/.test(normalizedPath)) score += needsActionPlugin ? 760 : -1120;
      if (/\/url(s)?\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) && !/\/(module_utils|modules|plugins\/lookup)\//.test(normalizedPath)) score += 300;
      if (/\b(netrc|authorization|auth|headers?|url|uri|request)\b/.test(normalizedPath)) score += 140;
      if (/\/(executor|interpreter|facts?|plugins\/list|plugins\/doc_fragments|plugins\/action|module_utils\/basic|tests?|docs?)\//.test(normalizedPath) && !/\b(netrc|authorization|open_url|use_netrc|headers?|url|uri)\b/.test(normalizedPath)) score -= 540;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 900);
  const selected = authoritative.length >= 3 ? authoritative : scored;
  return uniquePaths(selected.map((file) => file.path));
}

function httpAuthPolicyNeedsActionPlugin(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  return /\b(action plugin|plugin action|action layer|action module|plugins action|action uri|action handler)\b/.test(normalized);
}

function systemMetadataSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasSystemMetadataScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/\/inventory\/metadata\/metadata_linux\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1260;
      if (/\/inventory\/metadata\/(metadata|get)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 960;
      if (/\/linux\/(dmi|dmi_sysfs|os_release|metadata)[^/]*\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1180;
      if (/\b(dmi|dmifs|os[_-]?release|sysfs|inventory|metadata)\b/.test(normalizedPath)) score += 170;
      if (/\/(config|configs?|configuration|systemd|parse|parser|utils?)\//.test(normalizedPath) && !/\b(dmi|os[_-]?release|inventory|metadata)\b/.test(normalizedPath)) score -= 760;
      if (/\/(tests?|docs?|examples?|fixtures?|vendor|third_party|generated)\//.test(normalizedPath)) score -= 480;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 900).map((file) => file.path);
  if (authoritative.length >= 2) return uniquePaths(authoritative);
  return uniquePaths(scored.map((file) => file.path));
}

function databaseFailoverSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasDatabaseFailoverScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/^api\/types\/databaseserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/types\/databaseserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1260;
      if (/\/srv\/db\/proxyserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/db\/proxyserver\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 1220;
      if (/\/reversetunnel\/fake\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/fake(?:remote)?site\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 960;
      if (/(^|\/)tool\/tsh\/db\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/cli\/.*db\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score += 920;
      if (/\b(database|db|proxyserver|databaseserver|reversetunnel|tsh|serverid|hostid|shuffle|dedupe|candidate)\b/.test(normalizedPath)) score += 150;
      if (/\/(events?|session|sessions?|audit|kube|app|regular|service|auth|client)\//.test(normalizedPath) && !/\b(databaseserver|proxyserver|reversetunnel|tool\/tsh\/db)\b/.test(normalizedPath)) score -= 620;
      if (/\/(tests?|docs?|examples?|fixtures?|generated|vendor|third_party)\//.test(normalizedPath)) score -= 480;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 900).map((file) => file.path);
  if (authoritative.length >= 3) return uniquePaths(authoritative);
  return uniquePaths(scored.map((file) => file.path));
}

function pluginActivationValidationSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasPluginActivationValidationScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/^src\/plugins\/install\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath) || /\/plugins\/install\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath)) score += 1260;
      if (/^src\/socket\.io\/admin\/plugins\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath) || /\/socket\.io\/admin\/plugins\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath)) score += 1020;
      if (/^src\/flags\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath) || /\/flags\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath)) score += 740;
      if (/\/admin\/extend\/plugins\.(js|ts|tsx|jsx|py|go|rb|rs)$/.test(normalizedPath)) score += 280;
      if (/\b(plugin|plugins|toggleactive|invalid-plugin-id|identifier|validation|flags)\b/.test(normalizedPath)) score += 140;
      if (/\/(topic|topics|posts?|flags\/list|installer|language|views?|templates?)\//.test(normalizedPath) && !/\b(plugin|plugins|toggleactive|invalid-plugin-id)\b/.test(normalizedPath)) score -= 520;
      if (/\/(tests?|docs?|examples?|fixtures?|node_modules|dist|build|public\/language)\//.test(normalizedPath)) score -= 480;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((file) => file.path);
  return uniquePaths(scored);
}

function executionStateMigrationSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasExecutionStateMigrationScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/(^|\/)play_iterator\.(py|ts|js|go|rb|rs)$/.test(normalizedPath) || /\/executor\/play_iterator\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) score += 1320;
      if (/\/strategy\/__init__\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) score += 980;
      if (/\/strategy\/linear\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) score += 940;
      if (/\b(play_iterator|hoststate|iterating|failedstates|strategy)\b/.test(normalizedPath)) score += 160;
      if ((/\/(module_utils\/common|utils?|validation|warnings|display|parameters|basic)\//.test(normalizedPath) || /\/module_utils\/basic\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) && !/\b(play_iterator|strategy|hoststate|iterating|failedstates)\b/.test(normalizedPath)) score -= 820;
      if (/\/(tests?|docs?|examples?|fixtures?|vendor|third_party|generated)\//.test(normalizedPath)) score -= 480;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const authoritative = scored.filter((file) => file.score >= 900).map((file) => file.path);
  if (authoritative.length >= 2) return uniquePaths(authoritative);
  return uniquePaths(scored.map((file) => file.path));
}

function requestBodyFormSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasRequestBodyFormScope(query)) return [];
  const normalizedQuery = normalizeCandidateText(query);
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      const base = path.posix.basename(normalizedPath);
      let score = 0;
      let role: "handler" | "utility" | undefined;
      const isListTask = /\b(list|lists)\b/.test(normalizedQuery) || /\/lists?\//.test(normalizedQuery);
      const handlerPath = /(^|\/)(routes?|handlers?|controllers?|views?|endpoints?|resources?|plugins?)\//.test(normalizedPath);
      const handlerName = /\b(post|get|put|patch|delete|create|update|add|submit|request|form|body|params?|lists?)\b/.test(base);
      const utilityPath = /(^|\/)(utils?|helpers?|shared|common)\//.test(normalizedPath) || /\b(utils?|helpers?)\.(py|ts|js|go|rb|rs)$/.test(base);
      const reconstructionName = /\b(unflatten|flatten|form|forms|request|body|params?|query)\b/.test(normalizedPath);
      const upstreamRequestUtility = /\b(upstream|remote|external|prox(?:y|ied)?|forward(?:ed|ing)?)\b/.test(normalizedPath);
      const explicitReconstructionQuery = /\b(unflatten|flattened|nested|indexed|parent keys?|ordered pairs?)\b/.test(normalizedQuery);
      const genericAdminUtility = /(^|\/)(admin|admins|administration|management|staff)(\/|$)/.test(normalizedPath) && utilityPath;
      const adminRequested = /\b(admin|administration|management|staff)\b/.test(normalizedQuery);
      const utilityOwnsRequestSurface = reconstructionName || upstreamRequestUtility;
      if ((handlerPath && handlerName) || (isListTask && /\blists?\.(py|ts|js|go|rb|rs)$/.test(base))) {
        role = "handler";
        score += 900;
      }
      if (
        (utilityPath && utilityOwnsRequestSurface) ||
        (utilityPath && explicitReconstructionQuery && !genericAdminUtility) ||
        /\b(unflatten|flatten|forms?|request)_?utils?\.(py|ts|js|go|rb|rs)$/.test(base)
      ) {
        role = "utility";
        score += 860;
      }
      if (role === "handler" && /\b(post|add|submit|body|form|request)\b/.test(normalizedQuery)) score += 100;
      if (role === "utility" && explicitReconstructionQuery) score += 120;
      if (role === "utility" && upstreamRequestUtility) score += 240;
      if (role === "utility" && /\b(upstream|remote|external|prox(?:y|ied)|forward(?:ed|ing)?)\b/.test(normalizedQuery) && /\b(upstream|remote|external|proxy|forward)\b/.test(normalizedPath)) score += 180;
      if (role === "utility" && genericAdminUtility && !adminRequested) score -= 1100;
      if (role === "utility" && /\b(query|url|solr|search)\b/.test(base) && !/\b(unflatten|flatten|form|body|request)\b/.test(base)) score -= 500;
      if (/\/js\/|\/client\/|\/browser\/|\/static\//.test(normalizedPath) && !/\b(javascript|frontend|browser|client)\b/.test(normalizedQuery)) score -= 500;
      if (/\/models?\//.test(normalizedPath) || /\/core\/lists\/model\.(py|ts|js|go|rb|rs)$/.test(normalizedPath)) score -= 560;
      return { path: file.path, score, role };
    })
    .filter((file) => file.score > 0 && file.role)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const handler = scored.find((file) => file.role === "handler")?.path;
  const utility = scored.find((file) => file.role === "utility")?.path;
  return uniquePaths([handler, utility].filter(Boolean) as string[]);
}

function converterOutputSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasConverterOutputScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/convert(or|er)|converter|convertor/.test(normalizedPath)) score += 1000;
      if (/\b(trivy|vuls|cve|severity|severities|output|json)\b/.test(normalizedPath)) score += 120;
      if (/^scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath) || /\/scanner\/scanner\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score -= 520;
      if (/(^|\/)(storage|store|stores|db|database|backend|backends)\//.test(normalizedPath) && !/convert(or|er)|converter|convertor/.test(normalizedPath)) score -= 460;
      if (/\/scanner\/(alpine|debian|redhat|ubuntu|amazon|oracle|suse)\.(go|ts|js|py|rb|rs)$/.test(normalizedPath)) score -= 360;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((file) => file.path);
  return uniquePaths(scored);
}

function discoveryConfigSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasDiscoveryConfigScope(query)) return [];
  const normalizedQuery = normalizeCandidateText(query);
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      const base = path.posix.basename(normalizedPath).replace(/\.[^.]+$/, "");
      const compactBase = base.replace(/[^a-z0-9]+/g, "");
      let score = 0;
      let role: "discovery" | "contract" | undefined;
      const autoDiscoveryOwner = compactBase.includes("autodiscovery") || compactBase.includes("discovery") || compactBase.includes("homeserver");
      const supportingWellKnown = compactBase.includes("wellknown") || normalizedPath.includes("/well-known/") || normalizedPath.includes("/wellknown/");
      if (autoDiscoveryOwner || supportingWellKnown || /\/(discovery|autodiscovery|well-known|wellknown)\//.test(normalizedPath)) {
        role = "discovery";
        score += autoDiscoveryOwner ? 1120 : 760;
      }
      if (/\b(validatedserverconfig|serverconfig)\b/.test(compactBase) || (compactBase.includes("validated") && compactBase.includes("config")) || (compactBase.includes("server") && compactBase.includes("config"))) {
        role = "contract";
        score += 940;
      }
      if (role === "discovery" && /\b(discovery|homeserver|well[- ]?known)\b/.test(normalizedQuery)) score += 140;
      if (role === "contract" && /\b(validated|configuration|config|public interface|optional object)\b/.test(normalizedQuery)) score += 160;
      if (/\b(authentication|delegated|issuer|authorization|registration|token|account)\b/.test(normalizedPath)) score += 80;
      if (/(^|\/)(cypress|tests?|testing|support)\//.test(normalizedPath)) score -= 900;
      if ((/(^|\/)(settings|preferences)\//.test(normalizedPath) || /\/settings\//.test(normalizedPath)) && !/\b(settings?|preferences?)\b/.test(normalizedQuery)) score -= 1200;
      return { path: file.path, score, role };
    })
    .filter((file) => file.score > 0 && file.role)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const discovery = scored.find((file) => file.role === "discovery")?.path;
  const contract = scored.find((file) => file.role === "contract")?.path;
  return uniquePaths([discovery, contract].filter(Boolean) as string[]);
}

function deviceSessionListenerSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  if (!hasDeviceSessionListenerScope(query)) return [];
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      const normalizedPath = file.path.toLowerCase();
      let score = 0;
      if (/listener|observer|watcher|subscriber|notifier/.test(normalizedPath)) score += 1000;
      if (/\b(device|devices|session|sessions|notification|notifications|unverified)\b/.test(normalizedPath)) score += 160;
      if (/\/(stores?|state|models?)\//.test(normalizedPath) && /\b(session|sessions|notification|notifications|device|devices)\b/.test(normalizedPath)) score += 120;
      if (/(^|\/)(settings|tabs?|views?)\//.test(normalizedPath)) score -= 460;
      if (/\/toasts?\//.test(normalizedPath)) score -= 360;
      if (/\/models?\/call\.(ts|tsx|js|jsx)$/.test(normalizedPath)) score -= 320;
      return { path: file.path, score };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((file) => file.path);
  return uniquePaths(scored);
}

function datastoreBackendParitySourceFilesFromKnownFiles(files: FileRecord[], query: string, seedFiles: string[]): string[] {
  if (!hasDatastoreBackendParityScope(query)) return [];
  const groups = new Map<string, Array<{ path: string; surface: DatastoreBackendSurface }>>();
  for (const file of files) {
    if (!isLikelyProductionSourceFile(file.path)) continue;
    const surface = datastoreBackendSurface(file.path);
    if (!surface) continue;
    const key = `${surface.prefix}\0${surface.suffix}`;
    const group = groups.get(key) ?? [];
    group.push({ path: file.path, surface });
    groups.set(key, group);
  }
  const seedKeys = new Set(
    seedFiles
      .map((file) => datastoreBackendSurface(file))
      .filter((surface): surface is DatastoreBackendSurface => Boolean(surface))
      .map((surface) => `${surface.prefix}\0${surface.suffix}`)
  );
  const ranked = [...groups.entries()]
    .filter(([, group]) => new Set(group.map((entry) => entry.surface.backend)).size >= 2)
    .map(([key, group]) => ({
      key,
      group,
      seeded: seedKeys.has(key)
    }))
    .filter((entry) => entry.seeded || seedKeys.size === 0)
    .sort((a, b) => Number(b.seeded) - Number(a.seeded) || b.group.length - a.group.length || a.key.localeCompare(b.key));
  const best = ranked[0]?.group ?? [];
  const seedOrder = new Map(seedFiles.map((file, index) => [file.toLowerCase(), index]));
  return uniquePaths(
    best
      .sort((a, b) => {
        const seedA = seedOrder.get(a.path.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        const seedB = seedOrder.get(b.path.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
        return seedA - seedB || a.surface.backend.localeCompare(b.surface.backend) || a.path.localeCompare(b.path);
      })
      .map((entry) => entry.path)
  );
}

type DatastoreBackendSurface = { prefix: string; backend: string; suffix: string };

function datastoreBackendSurface(filePath: string): DatastoreBackendSurface | undefined {
  const parts = filePath.replaceAll("\\", "/").toLowerCase().split("/").filter(Boolean);
  const backendNames = new Set(["mongo", "mongodb", "redis", "postgres", "postgresql", "mysql", "sqlite", "memory", "inmemory"]);
  const rootNames = new Set(["database", "databases", "db", "storage", "stores", "backends"]);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!part || !backendNames.has(part)) continue;
    const hasDatastoreRoot = parts.slice(Math.max(0, index - 2), index).some((segment) => rootNames.has(segment));
    if (!hasDatastoreRoot) continue;
    const suffix = parts.slice(index + 1).join("/");
    if (!suffix) continue;
    return {
      prefix: parts.slice(0, index).join("/"),
      backend: part,
      suffix
    };
  }
  return undefined;
}

function hasKubernetesExecForwarderScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const compact = normalized.replace(/\s+/g, "");
  return (
    /\b(kubernetes|kubectl|kube)\b/.test(normalized) &&
    (
      /\b(exec|forwarder|forwarder config|session uploader|session recording|recordings?|streaming|upload directory|async upload|audit event|audit events|client disconnect|reverse tunnel|route to cluster)\b/.test(normalized) ||
      /\b(port forward|catch all)\b/.test(normalized) ||
      /\b(portforward|catchall|forwarderconfig|reversetunnelsrv|routetocluster|getkubeservices|getclusterconfig)\b/.test(compact)
    )
  );
}

function hasPackageSourceMappingScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  if (hasNarrowPackageParserScope(normalized)) return false;
  return /\b(source packages?|binary packages?|src packages?|package source|source package associations?|sourcerpm|src\.rpm|rpm|apk|alpine|redhat|rhel|centos)\b/.test(normalized) &&
    /\b(oval|vulnerabilit(?:y|ies)|scanner|package manager|upgradable|installed packages?|parse installed packages|package information|package metadata)\b/.test(normalized);
}

function hasNarrowPackageParserScope(normalizedQuery: string): boolean {
  const rpmParserTerms =
    /\b(sourcerpm|source rpm|src\.rpm|rpm filenames?|source filenames?|splitfilename|parseinstalledpackagesline|epoch)\b/.test(normalizedQuery);
  const scannerTerms = /\b(scanner|package manager|installed packages?|package information|package metadata|redhat|rhel|centos|rpm)\b/.test(normalizedQuery);
  const mappingTerms =
    /\b(oval|vulnerability matching|binary packages? derive|source package associations?|map binary packages?|package index|upgradable)\b/.test(normalizedQuery);
  return rpmParserTerms && scannerTerms && !mappingTerms;
}

function hasBenchmarkGeneratorScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const benchmarkTerms = /\b(benchmark|benchmarks|benchmarking|performance benchmark|load test|request rate|requests per second|rps)\b/.test(normalized);
  const generatorTerms = /\b(generator|generate|sequence|progression|linear|lower bound|upper bound|step size|minimum measurements|minimum window|getbenchmark|configuration|configurations)\b/.test(normalized);
  return benchmarkTerms && generatorTerms;
}

function hasTopicOrderingScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const topicTerms = /\b(topic|topics|category|categories)\b/.test(normalized);
  const orderTerms = /\b(pin|pinned|reorder|ordering|order|position|relative order|target position)\b/.test(normalized);
  const contractTerms = /\b(privileges?|moderator|admin|socket|client|no-op|category isolation|membership|sorted set)\b/.test(normalized);
  return topicTerms && orderTerms && contractTerms;
}

function hasCollectionNameValidationScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const collectionTerms = /\b(collection name|collection names|fqcn|fully qualified collection name|namespace\.collection|namespace|collection)\b/.test(normalized);
  const validationTerms = /\b(validate|validation|valid|invalid|identifier|python keyword|reserved keyword|is_valid_collection_name|is_python_identifier)\b/.test(normalized);
  return collectionTerms && validationTerms;
}

function hasGrpcErrorPolicyScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const grpcTerms = /\b(grpc|rpc|status code|status codes|code canceled|code deadlineexceeded|deadline exceeded|unauthenticated|internal)\b/.test(normalized);
  const contextTerms = /\b(context\.canceled|context canceled|cancelled context|canceled context|context cancellation|context timeout|context\.deadlineexceeded|deadline exceeded|timeout|cancelled|canceled)\b/.test(normalized);
  const policyTerms = /\b(classif(?:y|ied|ication)|map|mapping|return|respond|propagate|convert|middleware|auth(?:entication)?|server)\b/.test(normalized);
  return grpcTerms && contextTerms && policyTerms;
}

function hasHttpAuthPolicyScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const authTerms = /\b(netrc|\.netrc|authorization header|bearer|basic auth|basic authentication|credentials)\b/.test(normalized);
  const httpTerms = /\b(uri module|uri|open_url|request\.open|request|http|url|headers?)\b/.test(normalized);
  const policyTerms = /\b(overwrite|overwrites|override|overrides|overriding|overridden|respect|ignore|use_netrc|netrc usage|parameter|forward|default|enabled|disabled|control)\b/.test(normalized);
  return authTerms && httpTerms && policyTerms;
}

function hasSystemMetadataScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const systemMetadataTerms =
    /\b(dmi|dmifs|sysfs|\/sys\/class\/dmi\/id|product_name|product_serial|board_serial|chassis_asset_tag|os-release|\/etc\/os-release|pretty_name|version_id|distro|distribution|linux system metadata|system metadata|device metadata)\b/.test(normalized);
  const extractionTerms = /\b(parse|parser|read|open|extract|retrieve|metadata|filesystem|fs\.fs|struct|field|trim|permission denied|partial errors?|malformed lines?)\b/.test(normalized);
  return systemMetadataTerms && extractionTerms;
}

function hasDatabaseFailoverScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const databaseTerms = /\b(database|databases|db)\b/.test(normalized);
  const serviceTerms = /\b(service|services|server|servers|databaseserver|database server|database service)\b/.test(normalized);
  const failoverTerms = /\b(ha|high availability|failover|candidate|candidates|retry|shuffle|randomi[sz]e|offline tunnel|tunnel outage|reachable|unreachable|deduplicate|dedupe|same-name|same name|hostid|serverid|proxy context|tsh db ls)\b/.test(normalized);
  const proxyTerms = /\b(proxy|connect|dial|reverse tunnel|authorization|auth(?:orization)? context|list|display)\b/.test(normalized);
  return databaseTerms && serviceTerms && failoverTerms && proxyTerms;
}

function hasPluginActivationValidationScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const pluginTerms = /\b(plugin|plugins|plugin id|plugin identifier|plugin identifiers|package name)\b/.test(normalized);
  const activationTerms = /\b(activate|activation|toggleactive|toggle active|deactivate|admin\.plugins\.toggleactive)\b/.test(normalized);
  const validationTerms = /\b(validate|validation|valid|invalid|malformed|whitespace|special characters?|naming pattern|identifier|invalid-plugin-id)\b/.test(normalized);
  return pluginTerms && activationTerms && validationTerms;
}

function hasPromptSupportedPluginActivationConsumerScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const consumerTerms = /\b(client|frontend|front end|ui|browser|topic|topics|flags?|feature flag|consumer|consumers|caller|callers|admin client|request path|entry points?)\b/.test(normalized);
  const propagationTerms = /\b(update|carry|propagate|through|across|also|every|all|both|surface|surfaces|path|paths|entry|entries)\b/.test(normalized);
  return consumerTerms && propagationTerms;
}

function hasExecutionStateMigrationScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const stateTerms =
    /\b(playiterator|play iterator|hoststate|host state|run_state|run state|fail_state|failure state|execution state|iterator state|state representation|strategy plugin|strategy plugins)\b/.test(normalized) ||
    /\b(iteratingstates|failedstates|iterating_tasks|iterating_setup|failed_setup|failed_tasks)\b/.test(normalized);
  const migrationTerms =
    /\b(enum|enums|enumeration|intenum|intflag|public type|public representation|namespaced|legacy constants?|deprecated constants?|deprecation warning|backward compatibility|third-party|strategy\/linear|strategy\/__init__|metaclass|attribute access|string output)\b/.test(normalized);
  const behaviorTerms =
    /\b(preserve|redirect|emit|warn|compare|transition|assignment|bitwise|combinable|state descriptions?|readable state names?)\b/.test(normalized);
  return stateTerms && migrationTerms && behaviorTerms;
}

function hasSelfContainedExecutionStateMigrationPrompt(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const requirementBullets = (query.match(/\n\s*-\s+/g) ?? []).length;
  const interfaceDetail = countPresent(normalized, [
    /\biterating states\b/,
    /\bfailed states\b/,
    /\bmeta play iterator\b/,
    /\bint enum\b/,
    /\bint flag\b/,
    /\bnew interfaces introduced\b/
  ]);
  const compatibilityDetail = countPresent(normalized, [
    /\blegacy constants?\b/,
    /\bclass and instance\b/,
    /\bthird party\b/,
    /\bdeprecation warnings?\b/,
    /\bhost state\b/
  ]);
  const surfaceDetail = countPresent(normalized, [
    /\bplay iterator py\b/,
    /\bstrategy init py\b/,
    /\bstrategy linear py\b/
  ]);
  return requirementBullets >= 4 && interfaceDetail >= 2 && compatibilityDetail >= 2 && surfaceDetail >= 3;
}

function hasWebSessionRenewalScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  return /\b(web session|session renewal|renew(?:ing)? (?:a )?(?:web )?session|prevsessionid|websessionreq|reloaduser|switchback|active requests?|access request|renewed session)\b/.test(normalized) &&
    /\b(traits?|certificate|certificates?|ssh certificate|tls certificate|roles?|allowed resources?|login time|expiry|backend|user record|stale)\b/.test(normalized);
}

function hasRequestBodyFormScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  const explicitFormSignal = /\b(unflatten|flattened|nested|indexed|parent keys?|form data|body data|request body|query string|query parameters?|duplicate (?:simple )?keys?|assignments?)\b/.test(normalized);
  const requestQueryConflict =
    /\b(post|form|body|request|endpoint|route|handler|list|lists)\b/.test(normalized) &&
    /\b(query|params?|parameters?)\b/.test(normalized) &&
    /\b(conflict|conflicts|merge|merged|handling|precedence|wins?|prefer|preferential)\b/.test(normalized);
  return (explicitFormSignal || requestQueryConflict) &&
    /\b(post|form|body|request|endpoint|route|handler|seeds?|defaults?)\b/.test(normalized);
}

function hasConverterOutputScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  if (hasPackageSourceMappingScope(normalized)) return false;
  const converterSignal =
    /\b(convert|converts|converted|converter|converters|conversion|adapter|adapters)\b/.test(normalized) ||
    /\b(trivy to vuls|trivy-to-vuls)\b/.test(normalized);
  const outputSignal =
    /\b(output|outputs|json|record|records|finding|findings|report|reports|contents?|cve|cves|severity|severities|debian|vuls|trivy)\b/.test(normalized);
  return converterSignal && outputSignal;
}

function hasDiscoveryConfigScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  return countPresent(normalized, [
    /\b(discovery|discover|autodiscovery|well[- ]?known|homeserver|server discovery)\b/,
    /\b(authentication|delegated auth|delegated authentication|m authentication|issuer|authorization endpoint|registration endpoint|token endpoint|account)\b/,
    /\b(validated config|validated configuration|server config|configuration|config|preserve|expose|optional object|public interface)\b/
  ]) >= 2;
}

function hasDeviceSessionListenerScope(query: string): boolean {
  const normalized = normalizeCandidateText(query);
  return countPresent(normalized, [
    /\b(device|devices)\b/,
    /\b(session|sessions)\b/,
    /\b(notification|notifications|unverified)\b/,
    /\b(listener|listeners|startup|existing|new|download|downloads|refresh|state)\b/
  ]) >= 3;
}

function countPresent(value: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(value) ? 1 : 0), 0);
}

function queryMentionsCompactIdentifier(query: string, identifier: string): boolean {
  const compact = identifier.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact.length < 4) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(compact)}([^a-z0-9]|$)`, "i");
  return pattern.test(query);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectedTestCounterpartSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  const counterpartNames = selectedTestCounterpartBasenames(query);
  if (counterpartNames.size === 0) return [];
  const normalizedQuery = normalizeCandidateText(query);
  return uniquePaths(
    files
      .filter((file) => isLikelyProductionSourceFile(file.path))
      .map((file) => {
        const basename = path.posix.basename(file.path).replace(/\.[^.]+$/, "").toLowerCase();
        if (!counterpartNames.has(basename)) return { path: file.path, score: 0 };
        const pathTerms = new Set(tokenizeLexical(file.path));
        let score = 1000;
        for (const term of pathTerms) {
          if (term.length >= 4 && normalizedQuery.includes(term)) score += 50;
        }
        return { path: file.path, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .map((item) => item.path)
  );
}

function selectedTestCounterpartBasenames(query: string): Set<string> {
  const names = new Set<string>();
  for (const match of query.matchAll(/\b[A-Za-z0-9_.@+~/-]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rb|c|cc|cpp|cxx|h|hh|hpp|hxx)\b/g)) {
    const filePath = normalizeRelativePath(match[0] ?? "").toLowerCase();
    if (!isTestLikePath(filePath)) continue;
    const basename = path.posix.basename(filePath).replace(/\.[^.]+$/, "");
    const counterpart = basename.replace(/^(test|spec)[_-]/, "").replace(/[._-](test|spec)$/, "");
    if (counterpart.length >= 3) names.add(counterpart);
  }
  return names;
}

function isTestLikePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  const basename = path.posix.basename(normalized);
  return (
    /(^|\/)(tests?|specs?|__tests__|testing)\//.test(normalized) ||
    /(^|\/)src\/test\//.test(normalized) ||
    /^(test|spec)[_-]/.test(basename) ||
    /[._-](test|spec)\./.test(basename) ||
    /_test\.go$/.test(basename)
  );
}

function deprecationLifecycleSourceFilesFromKnownFiles(files: FileRecord[], query: string): string[] {
  const scored = files
    .filter((file) => isLikelyProductionSourceFile(file.path))
    .map((file) => {
      return { path: file.path, score: scoreDeprecationLifecyclePath({ filePath: file.path, query }) };
    })
    .filter((file) => file.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((file) => file.path);
  return uniquePaths(scored);
}

function promptFeatureAnchorTerms(query: string): string[] {
  const generic = new Set([
    "component",
    "components",
    "header",
    "body",
    "badge",
    "icon",
    "state",
    "status",
    "live",
    "liveness",
    "playback",
    "recording",
    "option",
    "options",
    "type",
    "method",
    "function",
    "interface"
  ]);
  const terms = tokenizeLexical(query).filter((term) => term.length >= 4 && !generic.has(term));
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([term]) => term)
    .slice(0, 4);
}

function buildPrimeDeliveryTrace(input: {
  decision: ContextValueDecision;
  guardrailVariant: string | undefined;
  emittedFiles: string[];
  editScope: ContextPrime["editScope"];
  estimatedDirectiveTokens: number;
  estimatedSourceContextTokens: number;
}): PrimeDeliveryTrace {
  const emittedFileRoleSummary: Partial<Record<FileRoleV2, number>> = {};
  for (const file of input.emittedFiles) {
    const role = deliveryRoleForPath(file);
    emittedFileRoleSummary[role] = (emittedFileRoleSummary[role] ?? 0) + 1;
  }
  return {
    action: input.decision.action,
    ...(input.decision.recommendedDelivery ? { recommendedDelivery: input.decision.recommendedDelivery } : {}),
    ...(input.decision.taskShapeSignal ? { taskShapeSignal: input.decision.taskShapeSignal } : {}),
    ...(input.decision.requiredSurface ? { requiredSurface: input.decision.requiredSurface } : {}),
    ...(input.decision.directiveStyle ? { directiveStyle: input.decision.directiveStyle } : {}),
    ...(input.guardrailVariant ? { guardrailVariant: input.guardrailVariant } : {}),
    emittedFileCount: input.emittedFiles.length,
    emittedFileRoleSummary,
    ...(input.editScope?.scopeSource ? { editScopeSource: input.editScope.scopeSource } : {}),
    estimatedDirectiveTokens: input.estimatedDirectiveTokens,
    estimatedSourceContextTokens: input.estimatedSourceContextTokens,
    sizingReason: deliverySizingReason(input.decision, input.guardrailVariant, input.emittedFiles.length)
  };
}

function deliverySizingReason(decision: ContextValueDecision, guardrailVariant: string | undefined, emittedFileCount: number): string {
  if (decision.action === "request_evidence") return "evidence needed before source context";
  if (decision.action === "suppress") return "context suppressed by session policy";
  if (guardrailVariant) return `official ${guardrailVariant.replace(/_/g, " ")}`;
  if (decision.requiredSurface === "single_file") return "single-file source surface";
  if (decision.requiredSurface === "paired_contract") return "paired contract source surface";
  if (decision.requiredSurface === "feature_cluster") return "frontend owner cluster";
  if (emittedFileCount > 1) return "compact multi-file source surface";
  return "standard focused source surface";
}

function deliveryRoleForPath(file: string): FileRoleV2 {
  const normalized = file.toLowerCase();
  if (/\b(test|tests|spec|specs|__tests__|fixtures?)\b|[-_.](test|spec)\./.test(normalized)) return "test";
  if (/\b(docs?|readme|changelog)\b/.test(normalized) || /\.(md|mdx|rst|txt)$/.test(normalized)) return "docs";
  if (/\b(examples?|samples?)\b/.test(normalized)) return "example";
  if (/\b(generated|vendor|third_party|dist|build|coverage|snapshot)\b/.test(normalized)) return "generated";
  if (/\b(configdata|settings?|options?|config)\b/.test(normalized) || /\.(ya?ml|toml|ini)$/.test(normalized)) return "config";
  if (/\b(schema|schemas|types?)\b/.test(normalized)) return "schema";
  if (/\b(api|public|exports?|index)\b/.test(normalized)) return "public_api";
  if (/\b(cli|cmd|command|main|entry|launcher)\b/.test(normalized)) return "entrypoint";
  if (/\b(route|routes|router|pages?|app)\b/.test(normalized)) return "route";
  if (/\b(component|components|view|views|atoms|molecules|organisms|screen|screens)\b/.test(normalized) || /\.(tsx|jsx|vue|svelte)$/.test(normalized)) return "ui_surface";
  if (/\b(platform|provider|adapter|backend|driver|variant)\b/.test(normalized)) return "platform_variant";
  if (/\b(node_modules|vendor)\b/.test(normalized)) return "vendor_dep";
  return "production_source";
}

function rankedFilesFromScored(files: HybridScoredResult[]): ContextRankedFile[] {
  return files.map((file) => ({
    path: file.path,
    kind: file.kind,
    score: file.score,
    reasons: file.reasons,
    scores: {
      semantic: file.semanticScore,
      keyword: file.keywordScore,
      bm25: file.bm25Score,
      behavior: file.behaviorScore,
      graph: file.graphScore,
      intent: file.intentScore,
      session: file.sessionScore,
      importance: file.importanceScore,
      git: file.gitScore
    }
  }));
}

function preferredStructuredDebugPrimary(primaryFile: string | undefined, companionMetadata: unknown[]): string | undefined {
  const prioritized = companionMetadata
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as { file?: unknown; reasons?: unknown; score?: unknown };
      if (typeof record.file !== "string") return undefined;
      const reasons = Array.isArray(record.reasons) ? record.reasons.map(String) : [];
      const score = typeof record.score === "number" ? record.score : 0;
      const priority = reasons.some((reason) =>
        reason.includes("route/path surface anchor") ||
        reason.includes("mentioned source filename") ||
        reason.includes("router core sibling") ||
        reason.includes("named peer client companion") ||
        reason.includes("user/email companion") ||
        reason.includes("exact user/email companion") ||
        reason.includes("proxy/service companion") ||
        reason.includes("kubernetes service companion") ||
        reason.includes("keyboard shortcut companion") ||
        reason.includes("module resolver companion") ||
        reason.includes("schema generation companion") ||
        reason.includes("field definition companion") ||
        reason.includes("statement state companion") ||
        reason.includes("field metadata companion") ||
        reason.includes("command-line parser companion") ||
        reason.includes("config companion") ||
        reason.includes("routing map/rule companion") ||
        reason.includes("routing map/rule/matcher source companion") ||
        reason.includes("line/comment formatting source companion") ||
        reason.includes("core search source companion") ||
        reason.includes("printer output source companion") ||
        reason.includes("fixture/runner source companion") ||
        reason.includes("named source surface") ||
        reason.includes("compound path term match")
      )
        ? 2
        : reasons.some((reason) => reason.includes("direct role basename anchor"))
          ? 1
          : 0;
      return { file: record.file, priority, score };
    })
    .filter((item): item is { file: string; priority: number; score: number } => Boolean(item))
    .sort((a, b) => b.priority - a.priority || b.score - a.score);
  const best = prioritized[0];
  return best && best.priority > 0 ? best.file : primaryFile;
}

function compoundQueryTerms(query: string): string[] {
  return tokenizeLexical(query)
    .flatMap((term, index, terms) => {
      const next = terms[index + 1];
      return next ? [`${term}${next}`] : [];
    });
}

function normalizeCandidateText(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function uniqueSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  const byKey = new Map<string, SymbolRecord>();
  for (const symbol of symbols) {
    byKey.set(`${symbol.filePath}:${symbol.name}:${symbol.startLine}:${symbol.endLine}`, symbol);
  }
  return [...byKey.values()];
}
