import fs from "node:fs";
import path from "node:path";
import type {
  BenchmarkAssistanceMode,
  BenchmarkComparison,
  BenchmarkContextBehavior,
  BenchmarkEnduranceReport,
  BenchmarkEnduranceRepeatReport,
  BenchmarkProofReport,
  BenchmarkReport
} from "../types.js";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import { runBenchmarkEndurance, runBenchmarkEnduranceRepeats } from "./endurance.js";
import { runBenchmarkMcpSmoke, type BenchmarkMcpSmokeReport } from "./mcpSmoke.js";
import { buildSweProOfficialEvalReport, type SweProOfficialEvalReport } from "./sweProOfficial.js";
import { sha256 } from "../utils/hash.js";

export type CampaignStage = "proxy" | "live" | "official" | "all";
export type CampaignCleanupMode = "never" | "on_success" | "always";
export type CampaignEntryKind = "proxy" | "proof" | "endurance" | "mcp_smoke" | "official_eval" | "control";
export type CampaignEntryStatus = "planned" | "passed" | "failed" | "skipped";
export type CampaignProxyClassification =
  | "would_over_assist"
  | "wrong_surface_risk"
  | "scope_too_broad"
  | "evidence_needed"
  | "valid_guardrail"
  | "suppression_expected"
  | "proxy_pass";

const CAMPAIGN_ENTRY_KINDS = new Set<CampaignEntryKind>(["proxy", "proof", "endurance", "mcp_smoke", "official_eval", "control"]);
const CAMPAIGN_STAGES = new Set<CampaignStage>(["proxy", "live", "official", "all"]);
const CLEANUP_MODES = new Set<CampaignCleanupMode>(["never", "on_success", "always"]);

export type CampaignManifest = {
  id: string;
  name: string;
  description?: string | undefined;
  defaults?: {
    model?: string | undefined;
    parallel?: number | undefined;
    agentTimeoutMs?: number | undefined;
    turnTimeoutMs?: number | undefined;
    workdir?: string | undefined;
    cleanup?: CampaignCleanupMode | undefined;
    commands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
    setupCommands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
  } | undefined;
  pauseRules?: {
    maxQualityDrops?: number | undefined;
    maxScopeViolations?: number | undefined;
    maxRepeatedFailureClass?: number | undefined;
    maxTokenRegressionClass?: number | undefined;
    stopOnHarnessFailure?: boolean | undefined;
  } | undefined;
  entries: CampaignEntry[];
};

export type CampaignEntry = {
  id: string;
  kind: CampaignEntryKind;
  label?: string | undefined;
  tags?: string[] | undefined;
  root?: string | undefined;
  suite?: string | undefined;
  input?: string | undefined;
  rowIds?: string[] | undefined;
  evaluatorResultsPath?: string | undefined;
  officialRunnerCommand?: string | undefined;
  task?: string | undefined;
  budget?: number | undefined;
  detail?: "compact" | "full" | undefined;
  modes?: BenchmarkAssistanceMode[] | undefined;
  repeat?: number | undefined;
  timeoutMs?: number | undefined;
  expectedFailureClass?: string | undefined;
  contextBehavior?: BenchmarkContextBehavior | undefined;
  commands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
  setupCommands?: Partial<Record<BenchmarkAssistanceMode, string>> | undefined;
};

export type CampaignRunOptions = {
  manifestPath: string;
  outDir: string;
  stage?: CampaignStage | undefined;
  parallel?: number | undefined;
  resume?: boolean | undefined;
  only?: string | undefined;
  dryRun?: boolean | undefined;
  onProgress?: ((message: string) => void) | undefined;
};

export type CampaignArtifact = {
  entryId: string;
  kind: CampaignEntryKind;
  stage: CampaignStage;
  status: CampaignEntryStatus;
  tags: string[];
  startedAt: string;
  endedAt: string;
  artifactPath: string;
  workerPacketPath?: string | undefined;
  commands: string[];
  report?: unknown;
  classifications: string[];
  error?: string | undefined;
  workspacePaths: string[];
  metrics: CampaignEntryMetrics;
};

export type CampaignEntryMetrics = {
  qualityPassed: boolean;
  observedTokens?: number | undefined;
  baselineTokens?: number | undefined;
  savedTokens?: number | undefined;
  savingsRate?: number | undefined;
  cleanPassPass: boolean;
  tokenRegression: boolean;
  qualityDrop: boolean;
  qualityRescue: boolean;
  harmfulAssist: boolean;
  scopeViolations: number;
  mcpCalls: number;
  mcpUsefulAttribution: number;
  elapsedMs: number;
};

export type CampaignReport = {
  id: string;
  name: string;
  generatedAt: string;
  manifestPath: string;
  outDir: string;
  stage: CampaignStage;
  dryRun: boolean;
  parallel: number;
  paused: boolean;
  pauseReasons: string[];
  artifacts: CampaignArtifact[];
  rows: CampaignResultRow[];
  aggregate: CampaignAggregate;
  outputs: CampaignOutputPaths;
};

export type CampaignResultRow = {
  entryId: string;
  kind: CampaignEntryKind;
  stage: CampaignStage;
  status: CampaignEntryStatus;
  tags: string;
  qualityPassed: boolean;
  observedTokens?: number | undefined;
  baselineTokens?: number | undefined;
  savedTokens?: number | undefined;
  savingsRate?: number | undefined;
  cleanPassPass: boolean;
  tokenRegression: boolean;
  qualityDrop: boolean;
  qualityRescue: boolean;
  harmfulAssist: boolean;
  scopeViolations: number;
  mcpCalls: number;
  mcpUsefulAttribution: number;
  classifications: string;
  elapsedMs: number;
};

export type CampaignAggregate = {
  entries: number;
  completedEntries: number;
  failedEntries: number;
  qualityPassRate: number;
  cleanPassPassRows: number;
  tokenRegressionRows: number;
  qualityRescueRows: number;
  harmfulRows: number;
  scopeViolations: number;
  mcpCalls: number;
  mcpUsefulAttribution: number;
  medianSavedTokens: number;
  medianSavingsRate: number;
  medianElapsedMsByStage: Record<string, number>;
  repeatedFailureClasses: Array<{ classification: string; count: number; examples: string[] }>;
  pauseRuleStatus: {
    paused: boolean;
    reasons: string[];
  };
};

export type CampaignOutputPaths = {
  manifestPath: string;
  summaryPath: string;
  resultsCsvPath: string;
  failuresCsvPath: string;
  proxyResultsCsvPath: string;
  workerPacketsDir: string;
  rawDir: string;
  workDir: string;
};

export type CampaignCleanupReport = {
  outDir: string;
  dryRun: boolean;
  removed: string[];
  skipped: string[];
};

export async function runCampaign(options: CampaignRunOptions): Promise<CampaignReport> {
  const manifest = loadCampaignManifest(options.manifestPath);
  const stage = options.stage ?? "all";
  validateCampaignManifest(manifest);
  validateStage(stage);
  const outDir = path.resolve(options.outDir);
  const outputs = campaignOutputPaths(outDir);
  fs.mkdirSync(outputs.rawDir, { recursive: true });
  fs.mkdirSync(outputs.workerPacketsDir, { recursive: true });
  fs.mkdirSync(outputs.workDir, { recursive: true });
  const parallel = Math.max(1, Math.floor(options.parallel ?? manifest.defaults?.parallel ?? 3));
  const entries = manifest.entries.filter((entry) => entryMatchesStage(entry, stage)).filter((entry) => matchesOnly(entry, options.only));
  const artifacts: CampaignArtifact[] = [];
  let paused = false;
  let pauseReasons: string[] = [];
  const runEntries = entries.map((entry) => async () => {
    if (paused) {
      const artifact = skippedArtifact({ manifest, entry, stage, outputs, reason: "campaign paused before entry started" });
      artifacts.push(artifact);
      return artifact;
    }
    const artifact = await runCampaignEntry({
      manifest,
      entry,
      stage,
      outputs,
      resume: Boolean(options.resume),
      dryRun: Boolean(options.dryRun),
      onProgress: options.onProgress
    });
    artifacts.push(artifact);
    const pause = evaluatePauseRules(manifest, artifacts);
    if (pause.paused) {
      paused = true;
      pauseReasons = pause.reasons;
    }
    return artifact;
  });
  await runCampaignTaskPool(runEntries, parallel);
  const finalArtifacts = orderedArtifacts(entries, artifacts);
  const rows = finalArtifacts.map(artifactToRow);
  const aggregate = aggregateCampaignRows(rows, finalArtifacts, manifest);
  const report: CampaignReport = {
    id: manifest.id,
    name: manifest.name,
    generatedAt: new Date().toISOString(),
    manifestPath: path.resolve(options.manifestPath),
    outDir,
    stage,
    dryRun: Boolean(options.dryRun),
    parallel,
    paused: aggregate.pauseRuleStatus.paused,
    pauseReasons: aggregate.pauseRuleStatus.reasons,
    artifacts: finalArtifacts,
    rows,
    aggregate,
    outputs
  };
  writeCampaignOutputs({ manifest, report });
  return report;
}

export function summarizeCampaign(outDir: string): CampaignReport {
  const summaryPath = campaignOutputPaths(path.resolve(outDir)).summaryPath;
  if (!fs.existsSync(summaryPath)) throw new Error(`No campaign summary found at ${summaryPath}`);
  return JSON.parse(fs.readFileSync(summaryPath, "utf8")) as CampaignReport;
}

export function cleanupCampaign(outDir: string, input: { dryRun?: boolean | undefined } = {}): CampaignCleanupReport {
  const absoluteOutDir = path.resolve(outDir);
  const workDir = campaignOutputPaths(absoluteOutDir).workDir;
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(workDir)) {
    return { outDir: absoluteOutDir, dryRun: Boolean(input.dryRun), removed, skipped };
  }
  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    const target = path.join(workDir, entry.name);
    if (!entry.isDirectory() || !entry.name.startsWith("campaign-")) {
      skipped.push(target);
      continue;
    }
    if (!input.dryRun) fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { outDir: absoluteOutDir, dryRun: Boolean(input.dryRun), removed, skipped };
}

export function loadCampaignManifest(manifestPath: string): CampaignManifest {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Campaign manifest must be a JSON object.");
  return parsed as CampaignManifest;
}

export function validateCampaignManifest(manifest: CampaignManifest): void {
  if (!manifest.id) throw new Error("Campaign manifest requires id.");
  if (!manifest.name) throw new Error("Campaign manifest requires name.");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) throw new Error("Campaign manifest requires entries.");
  if (manifest.defaults?.cleanup && !CLEANUP_MODES.has(manifest.defaults.cleanup)) throw new Error(`Unsupported cleanup mode: ${manifest.defaults.cleanup}`);
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry.id) throw new Error("Campaign entry requires id.");
    if (ids.has(entry.id)) throw new Error(`Duplicate campaign entry id: ${entry.id}`);
    ids.add(entry.id);
    if (!CAMPAIGN_ENTRY_KINDS.has(entry.kind)) throw new Error(`${entry.id}: unsupported campaign entry kind: ${entry.kind}`);
    if (entry.kind === "proxy" && !entry.task) throw new Error(`${entry.id}: proxy entry requires task.`);
    if ((entry.kind === "proof" || entry.kind === "control") && !entry.suite) throw new Error(`${entry.id}: proof/control entry requires suite.`);
    if (entry.kind === "endurance" && !entry.suite) throw new Error(`${entry.id}: endurance entry requires suite.`);
    if (entry.kind === "mcp_smoke" && !entry.task) throw new Error(`${entry.id}: mcp_smoke entry requires task.`);
    if (entry.kind === "official_eval" && !entry.input) throw new Error(`${entry.id}: official_eval entry requires input.`);
    for (const mode of entry.modes ?? []) {
      if (!isBenchmarkAssistanceMode(mode)) throw new Error(`${entry.id}: unsupported campaign mode: ${mode}`);
    }
  }
}

async function runCampaignEntry(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  stage: CampaignStage;
  outputs: CampaignOutputPaths;
  resume: boolean;
  dryRun: boolean;
  onProgress?: ((message: string) => void) | undefined;
}): Promise<CampaignArtifact> {
  const artifactPath = path.join(input.outputs.rawDir, `${input.entry.id}.json`);
  if (input.resume && fs.existsSync(artifactPath)) {
    const existing = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as CampaignArtifact;
    if (existing.status === "passed") {
      input.onProgress?.(`[bench campaign] ${input.entry.id}: resume skipped`);
      return existing;
    }
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const commands = plannedCampaignCommands(input.manifest, input.entry);
  const workerPacketPath = writeWorkerPacket(input.manifest, input.entry, input.outputs);
  input.onProgress?.(`[bench campaign] ${input.entry.id}: start`);
  if (input.dryRun) {
    const artifact = baseArtifact({
      entry: input.entry,
      stage: input.stage,
      status: "planned",
      startedAt,
      artifactPath,
      workerPacketPath,
      commands,
      elapsedMs: Date.now() - startedMs
    });
    writeJsonAtomic(artifactPath, artifact);
    return artifact;
  }
  try {
    const report = await executeCampaignEntry({
      manifest: input.manifest,
      entry: input.entry,
      outputs: input.outputs,
      artifactPath,
      commands,
      onProgress: input.onProgress
    });
    const metrics = metricsFromReport(input.entry, report, Date.now() - startedMs);
    const artifact = baseArtifact({
      entry: input.entry,
      stage: input.stage,
      status: "passed",
      startedAt,
      artifactPath,
      workerPacketPath,
      commands,
      report,
      classifications: classificationsFromMetrics(input.entry, metrics, report),
      metrics,
      workspacePaths: workspacePathsFromReport(input.entry, report),
      elapsedMs: Date.now() - startedMs
    });
    writeJsonAtomic(artifactPath, artifact);
    removeSuccessfulPartialArtifact(artifactPath);
    input.onProgress?.(`[bench campaign] ${input.entry.id}: passed`);
    cleanupEntryWorkspaces(input.manifest, artifact);
    return artifact;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metrics = emptyMetrics(Date.now() - startedMs);
    const artifact = baseArtifact({
      entry: input.entry,
      stage: input.stage,
      status: "failed",
      startedAt,
      artifactPath,
      workerPacketPath,
      commands,
      error: message,
      classifications: ["harness_failure"],
      metrics,
      elapsedMs: Date.now() - startedMs
    });
    writeJsonAtomic(artifactPath, artifact);
    input.onProgress?.(`[bench campaign] ${input.entry.id}: failed`);
    cleanupEntryWorkspaces(input.manifest, artifact);
    return artifact;
  }
}

async function executeCampaignEntry(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  outputs: CampaignOutputPaths;
  artifactPath: string;
  commands: string[];
  onProgress?: ((message: string) => void) | undefined;
}): Promise<unknown> {
  if (input.entry.kind === "proxy") return runProxyEntry(input.manifest, input.entry);
  if (input.entry.kind === "mcp_smoke") {
    return runBenchmarkMcpSmoke({
      rootPath: rootFor(input.entry),
      task: input.entry.task!,
      budget: input.entry.budget,
      detail: input.entry.detail
    });
  }
  if (input.entry.kind === "endurance") {
    const modes = modesFor(input.manifest, input.entry);
    const args = {
      rootPath: rootFor(input.entry),
      suitePath: input.entry.suite!,
      baselineCommand: commandFor(input.manifest, input.entry, "baseline"),
      ...(modes.includes("kairn_codex_session")
        ? { kairnCodexSessionCommand: commandFor(input.manifest, input.entry, "kairn_codex_session"), kairnCodexSessionSetupCommand: setupCommandFor(input.manifest, input.entry, "kairn_codex_session") }
        : {}),
      ...(modes.includes("real_mcp_first")
        ? { realMcpFirstCommand: commandFor(input.manifest, input.entry, "real_mcp_first"), realMcpFirstSetupCommand: setupCommandFor(input.manifest, input.entry, "real_mcp_first") }
        : {}),
      ...(modes.includes("hybrid_mcp_brief")
        ? { hybridMcpBriefCommand: commandFor(input.manifest, input.entry, "hybrid_mcp_brief"), hybridMcpBriefSetupCommand: setupCommandFor(input.manifest, input.entry, "hybrid_mcp_brief") }
        : {}),
      turnTimeoutMs: input.entry.timeoutMs ?? input.manifest.defaults?.turnTimeoutMs
    };
    const repeat = Math.max(1, Math.floor(input.entry.repeat ?? 1));
    return repeat > 1 ? runBenchmarkEnduranceRepeats({ ...args, repeat }) : runBenchmarkEndurance(args);
  }
  if (input.entry.kind === "proof" || input.entry.kind === "control") {
    const runtime = new KairnRuntime(rootFor(input.entry));
    try {
      await runtime.init();
      const modes = modesFor(input.manifest, input.entry);
      return await runtime.proveBenchmark({
        suitePath: input.entry.suite!,
        baselineCommand: commandFor(input.manifest, input.entry, "baseline"),
        baselineSetupCommand: setupCommandFor(input.manifest, input.entry, "baseline"),
        ...(modes.includes("prompt_only") ? { promptOnlyCommand: commandFor(input.manifest, input.entry, "prompt_only"), promptOnlySetupCommand: setupCommandFor(input.manifest, input.entry, "prompt_only") } : {}),
        ...(modes.includes("prompt_plus_hooks") ? { promptPlusHooksCommand: commandFor(input.manifest, input.entry, "prompt_plus_hooks"), promptPlusHooksSetupCommand: setupCommandFor(input.manifest, input.entry, "prompt_plus_hooks") } : {}),
        ...(modes.includes("manual_prime") ? { manualPrimeCommand: commandFor(input.manifest, input.entry, "manual_prime"), manualPrimeSetupCommand: setupCommandFor(input.manifest, input.entry, "manual_prime") } : {}),
        ...(modes.includes("hook_full_prime") ? { hookFullPrimeCommand: commandFor(input.manifest, input.entry, "hook_full_prime"), hookFullPrimeSetupCommand: setupCommandFor(input.manifest, input.entry, "hook_full_prime") } : {}),
        ...(modes.includes("hook_tiny_directive") ? { hookTinyDirectiveCommand: commandFor(input.manifest, input.entry, "hook_tiny_directive"), hookTinyDirectiveSetupCommand: setupCommandFor(input.manifest, input.entry, "hook_tiny_directive") } : {}),
        ...(modes.includes("hook_tiny_with_failures") ? { hookTinyWithFailuresCommand: commandFor(input.manifest, input.entry, "hook_tiny_with_failures"), hookTinyWithFailuresSetupCommand: setupCommandFor(input.manifest, input.entry, "hook_tiny_with_failures") } : {}),
        ...(modes.includes("kairn_codex_session") ? { kairnCodexSessionCommand: commandFor(input.manifest, input.entry, "kairn_codex_session"), kairnCodexSessionSetupCommand: setupCommandFor(input.manifest, input.entry, "kairn_codex_session") } : {}),
        ...(modes.includes("kairn_codex_session_no_governor") ? { kairnCodexSessionNoGovernorCommand: commandFor(input.manifest, input.entry, "kairn_codex_session_no_governor"), kairnCodexSessionNoGovernorSetupCommand: setupCommandFor(input.manifest, input.entry, "kairn_codex_session_no_governor") } : {}),
        ...(modes.includes("mcp_first") ? { mcpFirstCommand: commandFor(input.manifest, input.entry, "mcp_first"), mcpFirstSetupCommand: setupCommandFor(input.manifest, input.entry, "mcp_first") } : {}),
        ...(modes.includes("real_mcp_first") ? { realMcpFirstCommand: commandFor(input.manifest, input.entry, "real_mcp_first"), realMcpFirstSetupCommand: setupCommandFor(input.manifest, input.entry, "real_mcp_first") } : {}),
        ...(modes.includes("mcp_first_plus_hook_full_prime") ? { mcpFirstPlusHookFullPrimeCommand: commandFor(input.manifest, input.entry, "mcp_first_plus_hook_full_prime"), mcpFirstPlusHookFullPrimeSetupCommand: setupCommandFor(input.manifest, input.entry, "mcp_first_plus_hook_full_prime") } : {}),
        ...(modes.includes("hybrid_mcp_brief") ? { hybridMcpBriefCommand: commandFor(input.manifest, input.entry, "hybrid_mcp_brief"), hybridMcpBriefSetupCommand: setupCommandFor(input.manifest, input.entry, "hybrid_mcp_brief") } : {}),
        agentTimeoutMs: input.entry.timeoutMs ?? input.manifest.defaults?.agentTimeoutMs,
        repeat: Math.max(1, Math.floor(input.entry.repeat ?? 1)),
        proofOutputPath: `${input.artifactPath}.partial.json`,
        onProgress: input.onProgress
      });
    } finally {
      runtime.close();
    }
  }
  if (input.entry.kind === "official_eval") {
    return buildSweProOfficialEvalReport({
      rowsPath: input.entry.input!,
      rowIds: input.entry.rowIds,
      evaluatorResultsPath: input.entry.evaluatorResultsPath,
      officialRunnerCommand: input.entry.officialRunnerCommand
    });
  }
  throw new Error(`Unsupported campaign entry kind: ${input.entry.kind}`);
}

async function runProxyEntry(manifest: CampaignManifest, entry: CampaignEntry): Promise<CampaignProxyReport> {
  const runtime = new KairnRuntime(rootFor(entry));
  try {
    await runtime.init();
    const prime = await runtime.primeContext({
      task: entry.task!,
      budget: entry.budget,
      source: "bench",
      refreshIndex: true,
      metadata: { campaignEntryId: entry.id }
    });
    const deliveryTrace = isRecord(prime.metadata?.deliveryTrace) ? prime.metadata.deliveryTrace : {};
    const editScope = isRecord(prime.editScope) ? prime.editScope : undefined;
    const emittedFileCount = Array.isArray(prime.files) ? prime.files.length : 0;
    const estimatedDirectiveTokens = numberValue(deliveryTrace.estimatedDirectiveTokens) ?? prime.tokenEstimate;
    const classifications = classifyProxy({
      action: stringValue(deliveryTrace.action),
      directiveStyle: stringValue(deliveryTrace.directiveStyle),
      requiredSurface: stringValue(deliveryTrace.requiredSurface),
      taskShapeSignal: stringValue(deliveryTrace.taskShapeSignal),
      emittedFileCount,
      strictBoundary: Boolean(editScope?.strictBoundary),
      estimatedDirectiveTokens
    });
    return {
      entryId: entry.id,
      taskHash: sha256(entry.task ?? ""),
      profile: prime.profile,
      tokenEstimate: prime.tokenEstimate,
      files: prime.files,
      taskShapeSignal: stringValue(deliveryTrace.taskShapeSignal),
      requiredSurface: stringValue(deliveryTrace.requiredSurface),
      directiveStyle: stringValue(deliveryTrace.directiveStyle),
      guardrailVariant: stringValue(deliveryTrace.guardrailVariant),
      emittedFileCount,
      emittedFileRoleSummary: recordValue(deliveryTrace.emittedFileRoleSummary),
      editScopeSource: stringValue(editScope?.scopeSource),
      initialEditFileCount: Array.isArray(editScope?.initialEditFiles) ? editScope.initialEditFiles.length : 0,
      readOnlyFileCount: Array.isArray(editScope?.readOnlyFiles) ? editScope.readOnlyFiles.length : 0,
      estimatedDirectiveTokens,
      estimatedSourceContextTokens: numberValue(deliveryTrace.estimatedSourceContextTokens),
      classifications
    };
  } finally {
    runtime.close();
  }
}

type CampaignProxyReport = {
  entryId: string;
  taskHash: string;
  profile: string;
  tokenEstimate: number;
  files: string[];
  taskShapeSignal?: string | undefined;
  requiredSurface?: string | undefined;
  directiveStyle?: string | undefined;
  guardrailVariant?: string | undefined;
  emittedFileCount: number;
  emittedFileRoleSummary?: Record<string, unknown> | undefined;
  editScopeSource?: string | undefined;
  initialEditFileCount: number;
  readOnlyFileCount: number;
  estimatedDirectiveTokens: number;
  estimatedSourceContextTokens?: number | undefined;
  classifications: CampaignProxyClassification[];
};

function classifyProxy(input: {
  action?: string | undefined;
  directiveStyle?: string | undefined;
  requiredSurface?: string | undefined;
  taskShapeSignal?: string | undefined;
  emittedFileCount: number;
  strictBoundary: boolean;
  estimatedDirectiveTokens: number;
}): CampaignProxyClassification[] {
  const classes: CampaignProxyClassification[] = [];
  if (input.action === "request_evidence" || input.requiredSurface === "evidence_needed") classes.push("evidence_needed");
  if (input.action === "suppress") classes.push("suppression_expected");
  if (input.directiveStyle === "scope_guardrail" || input.strictBoundary) classes.push("valid_guardrail");
  if (input.emittedFileCount > 6) classes.push("scope_too_broad");
  if (input.estimatedDirectiveTokens > 900) classes.push("would_over_assist");
  if (input.taskShapeSignal === "ambiguous_frontend_ownership" && input.action !== "request_evidence") classes.push("wrong_surface_risk");
  if (classes.length === 0) classes.push("proxy_pass");
  return [...new Set(classes)];
}

function metricsFromReport(entry: CampaignEntry, report: unknown, elapsedMs: number): CampaignEntryMetrics {
  if (entry.kind === "proxy") return proxyMetrics(report as CampaignProxyReport, elapsedMs);
  if (entry.kind === "mcp_smoke") return mcpSmokeMetrics(report as BenchmarkMcpSmokeReport, elapsedMs);
  if (entry.kind === "endurance") return enduranceMetrics(report as BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport, elapsedMs);
  if (entry.kind === "proof" || entry.kind === "control") return proofMetrics(report as BenchmarkProofReport, elapsedMs);
  if (entry.kind === "official_eval") return officialMetrics(report as SweProOfficialEvalReport, elapsedMs);
  return emptyMetrics(elapsedMs);
}

function proxyMetrics(report: CampaignProxyReport, elapsedMs: number): CampaignEntryMetrics {
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: !report.classifications.includes("wrong_surface_risk") && !report.classifications.includes("scope_too_broad"),
    observedTokens: report.estimatedDirectiveTokens,
    scopeViolations: report.classifications.includes("scope_too_broad") ? 1 : 0
  };
}

function mcpSmokeMetrics(report: BenchmarkMcpSmokeReport, elapsedMs: number): CampaignEntryMetrics {
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: report.metrics.mcpToolCalls > 0,
    mcpCalls: report.metrics.mcpToolCalls,
    mcpUsefulAttribution: report.prepare.startFiles.length
  };
}

function enduranceMetrics(report: BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport, elapsedMs: number): CampaignEntryMetrics {
  if ("aggregate" in report) {
    const baseline = report.aggregate.baseline;
    const nonBaseline = Object.values(report.aggregate).filter((mode) => mode.mode !== "baseline");
    const best = nonBaseline.sort((a, b) => (b.medianSavedTokens ?? 0) - (a.medianSavedTokens ?? 0))[0];
    return {
      ...emptyMetrics(elapsedMs),
      qualityPassed: nonBaseline.every((mode) => mode.qualityPasses === mode.repeats),
      observedTokens: best?.medianObservedCodexTokens,
      baselineTokens: baseline?.medianObservedCodexTokens,
      savedTokens: best?.medianSavedTokens,
      savingsRate: best?.medianSavingsRate,
      cleanPassPass: Boolean(best && best.validSavingsRuns > 0 && best.qualityPasses === best.repeats),
      tokenRegression: Boolean(best && (best.medianSavedTokens ?? 0) < 0),
      qualityDrop: nonBaseline.some((mode) => mode.qualityPasses < (baseline?.qualityPasses ?? mode.repeats)),
      qualityRescue: nonBaseline.some((mode) => (mode.classifications.quality_rescue ?? 0) > 0),
      harmfulAssist: nonBaseline.some((mode) => mode.harmfulRuns > 0),
      scopeViolations: sum(nonBaseline.map((mode) => mode.scopeViolations)),
      mcpCalls: sum(nonBaseline.map((mode) => mode.mcpCalls)),
      mcpUsefulAttribution: sum(nonBaseline.map((mode) => mode.mcpAttributedUsefulFileCount ?? 0))
    };
  }
  const baseline = report.reports.find((mode) => mode.mode === "baseline");
  const nonBaseline = report.reports.filter((mode) => mode.mode !== "baseline");
  const best = nonBaseline.sort((a, b) => {
    const aSaved = report.deltas[a.mode]?.savedTokens ?? Number.NEGATIVE_INFINITY;
    const bSaved = report.deltas[b.mode]?.savedTokens ?? Number.NEGATIVE_INFINITY;
    return bSaved - aSaved;
  })[0];
  const delta = best ? report.deltas[best.mode] : undefined;
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: nonBaseline.every((mode) => mode.qualityGatePassed),
    observedTokens: best?.totalObservedCodexTokens,
    baselineTokens: baseline?.totalObservedCodexTokens,
    savedTokens: delta?.savedTokens,
    savingsRate: delta?.savingsRate,
    cleanPassPass: Boolean(baseline?.qualityGatePassed && best?.qualityGatePassed && (delta?.validSavings ?? 0) > 0),
    tokenRegression: Boolean(delta && (delta.savedTokens ?? 0) < 0),
    qualityDrop: nonBaseline.some((mode) => mode.qualityGatePassed === false && baseline?.qualityGatePassed === true),
    qualityRescue: nonBaseline.some((mode) => mode.qualityGatePassed === true && baseline?.qualityGatePassed === false),
    harmfulAssist: nonBaseline.some((mode) => Boolean(report.deltas[mode.mode]?.harmfulAssist)),
    scopeViolations: sum(nonBaseline.map((mode) => stringArray(mode.metadata?.finalDiffScopeViolations).length)),
    mcpCalls: sum(nonBaseline.map((mode) => mode.assistanceActions.mcpCalls)),
    mcpUsefulAttribution: sum(nonBaseline.map((mode) => numberValue(mode.metadata?.mcpAttributedUsefulFileCount) ?? 0))
  };
}

function proofMetrics(report: BenchmarkProofReport, elapsedMs: number): CampaignEntryMetrics {
  const modeReports = proofModeReports(report);
  const nonBaseline = modeReports.filter((item) => item.mode !== "baseline");
  const baselinePassed = report.baseline.results.every(resultQualityPassed);
  const qualityPassed = nonBaseline.length > 0 && nonBaseline.every((item) => item.report.results.every(resultQualityPassed));
  const delta = bestProofDelta(report);
  const savedTokens = delta?.savedTokens;
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed,
    observedTokens: nonBaseline.find((item) => item.report.observed?.codexTokens !== undefined)?.report.observed?.codexTokens,
    baselineTokens: report.baseline.observed?.codexTokens,
    savedTokens,
    savingsRate: delta?.savingsRate,
    cleanPassPass: baselinePassed && qualityPassed && (savedTokens ?? 0) > 0,
    tokenRegression: (savedTokens ?? 0) < 0,
    qualityDrop: baselinePassed && nonBaseline.some((item) => item.report.results.some((result) => !resultQualityPassed(result))),
    qualityRescue: !baselinePassed && qualityPassed,
    harmfulAssist: nonBaseline.some((item) => item.report.results.some((result) => result.metadata.assistClassification === "harmful_invalid_assist")),
    mcpCalls: sum(nonBaseline.map((item) => benchmarkReportMcpCalls(item.report)))
  };
}

function officialMetrics(report: SweProOfficialEvalReport, elapsedMs: number): CampaignEntryMetrics {
  const tokenRows = report.results
    .map((result) => result.tokenMetrics)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const baselineTokens = sum(tokenRows.map((item) => item.baselineTokens ?? 0));
  const assistedTokens = sum(tokenRows.map((item) => item.assistedTokens ?? 0));
  const savedTokens = tokenRows.length > 0 ? baselineTokens - assistedTokens : undefined;
  return {
    ...emptyMetrics(elapsedMs),
    qualityPassed: report.officialEvaluatorPassed,
    observedTokens: tokenRows.length > 0 ? assistedTokens : undefined,
    baselineTokens: tokenRows.length > 0 ? baselineTokens : undefined,
    savedTokens,
    savingsRate: savedTokens !== undefined && baselineTokens > 0 ? savedTokens / baselineTokens : undefined,
    cleanPassPass: report.officialEvaluatorPassed && (savedTokens ?? 0) > 0,
    tokenRegression: (savedTokens ?? 0) < 0,
    qualityDrop: !report.officialEvaluatorPassed
  };
}

function emptyMetrics(elapsedMs: number): CampaignEntryMetrics {
  return {
    qualityPassed: false,
    cleanPassPass: false,
    tokenRegression: false,
    qualityDrop: false,
    qualityRescue: false,
    harmfulAssist: false,
    scopeViolations: 0,
    mcpCalls: 0,
    mcpUsefulAttribution: 0,
    elapsedMs
  };
}

function classificationsFromMetrics(entry: CampaignEntry, metrics: CampaignEntryMetrics, report: unknown): string[] {
  if (entry.kind === "proxy") return (report as CampaignProxyReport).classifications;
  const classes: string[] = [];
  if (metrics.cleanPassPass) classes.push("clean_passpass");
  if (metrics.tokenRegression) classes.push("official_token_regression");
  if (metrics.qualityDrop) classes.push("quality_drop");
  if (metrics.qualityRescue) classes.push("quality_rescue");
  if (metrics.harmfulAssist) classes.push("harmful_invalid_assist");
  if (metrics.scopeViolations > 0) classes.push("scope_violation");
  if (metrics.mcpCalls > 0) classes.push(metrics.mcpUsefulAttribution > 0 ? "mcp_useful_attribution" : "mcp_missing_attribution");
  if (classes.length === 0) classes.push(metrics.qualityPassed ? "pass" : "neutral");
  return classes;
}

function aggregateCampaignRows(rows: CampaignResultRow[], artifacts: CampaignArtifact[], manifest: CampaignManifest): CampaignAggregate {
  const qualityRows = rows.filter((row) => row.status === "passed" || row.status === "skipped");
  const repeated = repeatedFailureClasses(rows);
  const pause = evaluatePauseRules(manifest, artifacts);
  return {
    entries: rows.length,
    completedEntries: rows.filter((row) => row.status === "passed" || row.status === "skipped").length,
    failedEntries: rows.filter((row) => row.status === "failed").length,
    qualityPassRate: qualityRows.length > 0 ? qualityRows.filter((row) => row.qualityPassed).length / qualityRows.length : 0,
    cleanPassPassRows: rows.filter((row) => row.cleanPassPass).length,
    tokenRegressionRows: rows.filter((row) => row.tokenRegression).length,
    qualityRescueRows: rows.filter((row) => row.qualityRescue).length,
    harmfulRows: rows.filter((row) => row.harmfulAssist).length,
    scopeViolations: sum(rows.map((row) => row.scopeViolations)),
    mcpCalls: sum(rows.map((row) => row.mcpCalls)),
    mcpUsefulAttribution: sum(rows.map((row) => row.mcpUsefulAttribution)),
    medianSavedTokens: median(rows.map((row) => row.savedTokens).filter(isNumber)),
    medianSavingsRate: median(rows.map((row) => row.savingsRate).filter(isNumber)),
    medianElapsedMsByStage: medianElapsedByStage(rows),
    repeatedFailureClasses: repeated,
    pauseRuleStatus: pause
  };
}

function evaluatePauseRules(manifest: CampaignManifest, artifacts: CampaignArtifact[]): { paused: boolean; reasons: string[] } {
  const rules = manifest.pauseRules ?? {};
  const rows = artifacts.map(artifactToRow);
  const reasons: string[] = [];
  if (rules.maxQualityDrops !== undefined && rows.filter((row) => row.qualityDrop).length > rules.maxQualityDrops) reasons.push("quality drop limit exceeded");
  if (rules.maxScopeViolations !== undefined && sum(rows.map((row) => row.scopeViolations)) > rules.maxScopeViolations) reasons.push("scope violation limit exceeded");
  if (rules.maxTokenRegressionClass !== undefined && rows.filter((row) => row.tokenRegression).length > rules.maxTokenRegressionClass) reasons.push("token regression limit exceeded");
  if (rules.maxRepeatedFailureClass !== undefined) {
    const repeated = repeatedFailureClasses(rows).filter((item) => item.count > rules.maxRepeatedFailureClass!);
    for (const item of repeated) reasons.push(`repeated failure class: ${item.classification}`);
  }
  if (rules.stopOnHarnessFailure && artifacts.some((artifact) => artifact.classifications.includes("harness_failure"))) reasons.push("harness failure");
  return { paused: reasons.length > 0, reasons };
}

function writeCampaignOutputs(input: { manifest: CampaignManifest; report: CampaignReport }): void {
  const outputs = input.report.outputs;
  writeJsonAtomic(outputs.manifestPath, input.manifest);
  writeJsonAtomic(outputs.summaryPath, sanitizedCampaignReport(input.report));
  fs.writeFileSync(outputs.resultsCsvPath, campaignRowsCsv(input.report.rows));
  fs.writeFileSync(outputs.failuresCsvPath, campaignRowsCsv(input.report.rows.filter((row) => row.status === "failed" || row.qualityDrop || row.harmfulAssist || row.scopeViolations > 0)));
  fs.writeFileSync(outputs.proxyResultsCsvPath, campaignRowsCsv(input.report.rows.filter((row) => row.kind === "proxy")));
}

function sanitizedCampaignReport(report: CampaignReport): CampaignReport {
  return {
    ...report,
    manifestPath: path.basename(report.outputs.manifestPath),
    outDir: ".",
    artifacts: report.artifacts.map((artifact) => {
      const sanitized: CampaignArtifact = {
        entryId: artifact.entryId,
        kind: artifact.kind,
        stage: artifact.stage,
        status: artifact.status,
        tags: artifact.tags,
        startedAt: artifact.startedAt,
        endedAt: artifact.endedAt,
        artifactPath: `raw/${path.basename(artifact.artifactPath)}`,
        ...(artifact.workerPacketPath ? { workerPacketPath: `worker-packets/${path.basename(artifact.workerPacketPath)}` } : {}),
        commands: [],
        classifications: artifact.classifications,
        ...(artifact.error ? { error: redactLocalPaths(artifact.error) } : {}),
        workspacePaths: [],
        metrics: artifact.metrics
      };
      return sanitized;
    }),
    outputs: {
      manifestPath: path.basename(report.outputs.manifestPath),
      summaryPath: path.basename(report.outputs.summaryPath),
      resultsCsvPath: path.basename(report.outputs.resultsCsvPath),
      failuresCsvPath: path.basename(report.outputs.failuresCsvPath),
      proxyResultsCsvPath: path.basename(report.outputs.proxyResultsCsvPath),
      workerPacketsDir: path.basename(report.outputs.workerPacketsDir),
      rawDir: path.basename(report.outputs.rawDir),
      workDir: path.basename(report.outputs.workDir)
    }
  };
}

function redactLocalPaths(value: string): string {
  return value.replace(/\/Users\/[^/\s]+\/[^\s"']+/g, "<path>");
}

function campaignRowsCsv(rows: CampaignResultRow[]): string {
  const header = [
    "entry_id",
    "kind",
    "stage",
    "status",
    "tags",
    "quality_passed",
    "observed_tokens",
    "baseline_tokens",
    "saved_tokens",
    "savings_rate",
    "clean_passpass",
    "token_regression",
    "quality_drop",
    "quality_rescue",
    "harmful_assist",
    "scope_violations",
    "mcp_calls",
    "mcp_useful_attribution",
    "classifications",
    "elapsed_ms"
  ];
  return `${[header, ...rows.map((row) => [
    row.entryId,
    row.kind,
    row.stage,
    row.status,
    row.tags,
    String(row.qualityPassed),
    optionalNumber(row.observedTokens),
    optionalNumber(row.baselineTokens),
    optionalNumber(row.savedTokens),
    optionalNumber(row.savingsRate),
    String(row.cleanPassPass),
    String(row.tokenRegression),
    String(row.qualityDrop),
    String(row.qualityRescue),
    String(row.harmfulAssist),
    String(row.scopeViolations),
    String(row.mcpCalls),
    String(row.mcpUsefulAttribution),
    row.classifications,
    String(row.elapsedMs)
  ])].map((line) => line.map(csvCell).join(",")).join("\n")}\n`;
}

function artifactToRow(artifact: CampaignArtifact): CampaignResultRow {
  return {
    entryId: artifact.entryId,
    kind: artifact.kind,
    stage: artifact.stage,
    status: artifact.status,
    tags: artifact.tags.join(";"),
    qualityPassed: artifact.metrics.qualityPassed,
    observedTokens: artifact.metrics.observedTokens,
    baselineTokens: artifact.metrics.baselineTokens,
    savedTokens: artifact.metrics.savedTokens,
    savingsRate: artifact.metrics.savingsRate,
    cleanPassPass: artifact.metrics.cleanPassPass,
    tokenRegression: artifact.metrics.tokenRegression,
    qualityDrop: artifact.metrics.qualityDrop,
    qualityRescue: artifact.metrics.qualityRescue,
    harmfulAssist: artifact.metrics.harmfulAssist,
    scopeViolations: artifact.metrics.scopeViolations,
    mcpCalls: artifact.metrics.mcpCalls,
    mcpUsefulAttribution: artifact.metrics.mcpUsefulAttribution,
    classifications: artifact.classifications.join(";"),
    elapsedMs: artifact.metrics.elapsedMs
  };
}

function baseArtifact(input: {
  entry: CampaignEntry;
  stage: CampaignStage;
  status: CampaignEntryStatus;
  startedAt: string;
  artifactPath: string;
  workerPacketPath: string;
  commands: string[];
  report?: unknown | undefined;
  error?: string | undefined;
  classifications?: string[] | undefined;
  metrics?: CampaignEntryMetrics | undefined;
  workspacePaths?: string[] | undefined;
  elapsedMs: number;
}): CampaignArtifact {
  return {
    entryId: input.entry.id,
    kind: input.entry.kind,
    stage: stageForEntry(input.entry, input.stage),
    status: input.status,
    tags: input.entry.tags ?? [],
    startedAt: input.startedAt,
    endedAt: new Date().toISOString(),
    artifactPath: input.artifactPath,
    workerPacketPath: input.workerPacketPath,
    commands: input.commands,
    ...(input.report !== undefined ? { report: input.report } : {}),
    ...(input.error ? { error: input.error } : {}),
    classifications: input.classifications ?? [],
    workspacePaths: input.workspacePaths ?? [],
    metrics: input.metrics ?? emptyMetrics(input.elapsedMs)
  };
}

function skippedArtifact(input: {
  manifest: CampaignManifest;
  entry: CampaignEntry;
  stage: CampaignStage;
  outputs: CampaignOutputPaths;
  reason: string;
}): CampaignArtifact {
  const now = new Date().toISOString();
  return baseArtifact({
    entry: input.entry,
    stage: input.stage,
    status: "skipped",
    startedAt: now,
    artifactPath: path.join(input.outputs.rawDir, `${input.entry.id}.json`),
    workerPacketPath: path.join(input.outputs.workerPacketsDir, `${input.entry.id}.json`),
    commands: plannedCampaignCommands(input.manifest, input.entry),
    error: input.reason,
    classifications: ["campaign_paused"],
    elapsedMs: 0
  });
}

function plannedCampaignCommands(manifest: CampaignManifest, entry: CampaignEntry): string[] {
  if (entry.kind === "proxy") return [`kairn prime --root ${rootFor(entry)} --task <task>`];
  if (entry.kind === "mcp_smoke") return [`kairn bench mcp-smoke --root ${rootFor(entry)} --task <task>`];
  if (entry.kind === "official_eval") return [entry.officialRunnerCommand ?? "kairn bench swe-pro-official/eval aggregation"];
  const modes = modesFor(manifest, entry);
  return modes.map((mode) => `${mode}: ${commandFor(manifest, entry, mode)}`);
}

function writeWorkerPacket(manifest: CampaignManifest, entry: CampaignEntry, outputs: CampaignOutputPaths): string {
  const packetPath = path.join(outputs.workerPacketsDir, `${entry.id}.json`);
  const packet = {
    campaignId: manifest.id,
    entryId: entry.id,
    kind: entry.kind,
    tags: entry.tags ?? [],
    root: entry.root,
    suite: entry.suite,
    stage: stageForEntry(entry, "all"),
    command: `kairn bench campaign run --manifest ${outputs.manifestPath} --out-dir ${path.dirname(outputs.summaryPath)} --only ${entry.id} --parallel 1`,
    commands: plannedCampaignCommands(manifest, entry)
  };
  writeJsonAtomic(packetPath, packet);
  return packetPath;
}

function cleanupEntryWorkspaces(manifest: CampaignManifest, artifact: CampaignArtifact): void {
  const cleanup = manifest.defaults?.cleanup ?? "never";
  if (cleanup === "never") return;
  if (cleanup === "on_success" && artifact.status !== "passed") return;
  for (const workspace of artifact.workspacePaths) {
    if (workspace.includes(`${path.sep}campaign-`) || workspace.includes(`${path.sep}kairn-bench-`)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

function workspacePathsFromReport(entry: CampaignEntry, report: unknown): string[] {
  if (entry.kind === "proof" || entry.kind === "control") {
    return uniqueStrings(
      proofModeReports(report as BenchmarkProofReport).flatMap((item) =>
        item.report.results.map((result) => stringValue(result.metadata.workspacePath)).filter((value): value is string => Boolean(value))
      )
    );
  }
  if (entry.kind === "endurance") {
    const enduranceReport = report as BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport;
    if ("aggregate" in enduranceReport) {
      return uniqueStrings(enduranceReport.runs.flatMap((run) => run.reports.map((mode) => mode.workspacePath)));
    }
    return uniqueStrings(enduranceReport.reports.map((mode) => mode.workspacePath));
  }
  return [];
}

function campaignOutputPaths(outDir: string): CampaignOutputPaths {
  return {
    manifestPath: path.join(outDir, "campaign-manifest.json"),
    summaryPath: path.join(outDir, "campaign-summary.json"),
    resultsCsvPath: path.join(outDir, "results.csv"),
    failuresCsvPath: path.join(outDir, "failures.csv"),
    proxyResultsCsvPath: path.join(outDir, "proxy-results.csv"),
    workerPacketsDir: path.join(outDir, "worker-packets"),
    rawDir: path.join(outDir, "raw"),
    workDir: path.join(outDir, "work")
  };
}

function validateStage(stage: CampaignStage): void {
  if (!CAMPAIGN_STAGES.has(stage)) throw new Error(`Unsupported campaign stage: ${stage}`);
}

function entryMatchesStage(entry: CampaignEntry, stage: CampaignStage): boolean {
  if (stage === "all") return true;
  return stageForEntry(entry, stage) === stage;
}

function stageForEntry(entry: CampaignEntry, _requested: CampaignStage): CampaignStage {
  if (entry.kind === "proxy") return "proxy";
  if (entry.kind === "official_eval") return "official";
  return "live";
}

function modesFor(manifest: CampaignManifest, entry: CampaignEntry): BenchmarkAssistanceMode[] {
  return entry.modes ?? (manifest.defaults?.commands ? Object.keys(manifest.defaults.commands).filter(isBenchmarkAssistanceMode) : ["baseline", "kairn_codex_session"]);
}

function commandFor(manifest: CampaignManifest, entry: CampaignEntry, mode: BenchmarkAssistanceMode): string {
  const model = manifest.defaults?.model ?? "gpt-5.4-mini";
  const command = entry.commands?.[mode] ?? manifest.defaults?.commands?.[mode];
  if (!command) throw new Error(`${entry.id}: missing command for mode ${mode}`);
  return command.replaceAll("{model}", model);
}

function setupCommandFor(manifest: CampaignManifest, entry: CampaignEntry, mode: BenchmarkAssistanceMode): string | undefined {
  return entry.setupCommands?.[mode] ?? manifest.defaults?.setupCommands?.[mode];
}

function rootFor(entry: CampaignEntry): string {
  return path.resolve(entry.root ?? process.cwd());
}

function matchesOnly(entry: CampaignEntry, only: string | undefined): boolean {
  if (!only) return true;
  return entry.id === only || entry.kind === only || (entry.tags ?? []).includes(only) || entry.contextBehavior === only;
}

export async function runCampaignTaskPool<T>(tasks: Array<() => Promise<T>>, parallel: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(parallel)), tasks.length) }, () => worker()));
  return results;
}

function orderedArtifacts(entries: CampaignEntry[], artifacts: CampaignArtifact[]): CampaignArtifact[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.entryId, artifact]));
  return entries.map((entry) => byId.get(entry.id)).filter((item): item is CampaignArtifact => Boolean(item));
}

function repeatedFailureClasses(rows: CampaignResultRow[]): Array<{ classification: string; count: number; examples: string[] }> {
  const counts = new Map<string, { count: number; examples: string[] }>();
  for (const row of rows) {
    for (const classification of row.classifications.split(";").filter(Boolean)) {
      if (classification === "pass" || classification === "proxy_pass" || classification === "clean_passpass" || classification === "mcp_useful_attribution") continue;
      const existing = counts.get(classification) ?? { count: 0, examples: [] };
      existing.count += 1;
      if (existing.examples.length < 5) existing.examples.push(row.entryId);
      counts.set(classification, existing);
    }
  }
  return [...counts.entries()].map(([classification, value]) => ({ classification, ...value })).filter((item) => item.count > 1);
}

function medianElapsedByStage(rows: CampaignResultRow[]): Record<string, number> {
  const grouped = new Map<string, number[]>();
  for (const row of rows) grouped.set(row.stage, [...(grouped.get(row.stage) ?? []), row.elapsedMs]);
  return Object.fromEntries([...grouped.entries()].map(([stage, values]) => [stage, median(values)]));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function removeSuccessfulPartialArtifact(artifactPath: string): void {
  const partialPath = `${artifactPath}.partial.json`;
  if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
}

function optionalNumber(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? "" : String(value);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resultQualityPassed(result: BenchmarkReport["results"][number]): boolean {
  return result.taskOutcome === "pass" && result.metadata.qualityGatePassed !== false;
}

function benchmarkReportMcpCalls(report: BenchmarkReport | undefined): number {
  return report?.results.reduce((total, result) => {
    return total + (numberValue(result.metadata.actualMcpToolCalls) ?? numberValue(result.metadata.mcpToolCalls) ?? 0);
  }, 0) ?? 0;
}

function proofModeReports(report: BenchmarkProofReport): Array<{ mode: BenchmarkAssistanceMode; report: BenchmarkReport }> {
  const entries: Array<[BenchmarkAssistanceMode, BenchmarkReport | undefined]> = [
    ["baseline", report.baseline],
    ["prompt_only", report.promptOnly],
    ["prompt_plus_hooks", report.promptPlusHooks],
    ["manual_prime", report.manualPrime],
    ["hook_full_prime", report.hookFullPrime],
    ["hook_tiny_directive", report.hookTinyDirective],
    ["hook_tiny_with_failures", report.hookTinyWithFailures],
    ["kairn_codex_session", report.kairnCodexSession],
    ["kairn_codex_session_no_governor", report.kairnCodexSessionNoGovernor],
    ["mcp_first", report.mcpFirst],
    ["real_mcp_first", report.realMcpFirst],
    ["mcp_first_plus_hook_full_prime", report.mcpFirstPlusHookFullPrime],
    ["hybrid_mcp_brief", report.hybridMcpBrief],
    ["passive_hooks", report.passiveHooks],
    ["proactive", report.proactive]
  ];
  return entries.flatMap(([mode, modeReport]) => (modeReport ? [{ mode, report: modeReport }] : []));
}

function bestProofDelta(report: BenchmarkProofReport): BenchmarkComparison["observedTokenDelta"] | undefined {
  return Object.values(report.observedTokenDeltas)
    .filter((delta): delta is NonNullable<typeof delta> => Boolean(delta))
    .sort((a, b) => (b.savedTokens ?? Number.NEGATIVE_INFINITY) - (a.savedTokens ?? Number.NEGATIVE_INFINITY))[0];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isBenchmarkAssistanceMode(value: string): value is BenchmarkAssistanceMode {
  return [
    "baseline",
    "prompt_only",
    "prompt_plus_hooks",
    "manual_prime",
    "hook_full_prime",
    "hook_tiny_directive",
    "hook_tiny_with_failures",
    "kairn_codex_session",
    "kairn_codex_session_no_governor",
    "mcp_first",
    "real_mcp_first",
    "mcp_first_plus_hook_full_prime",
    "hybrid_mcp_brief",
    "passive_hooks",
    "proactive"
  ].includes(value);
}
