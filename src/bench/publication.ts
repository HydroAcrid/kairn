import fs from "node:fs";
import path from "node:path";
import type {
  BenchmarkAssistClassification,
  BenchmarkAssistanceStatus,
  BenchmarkComparison,
  BenchmarkContextBehavior,
  BenchmarkEnduranceReport,
  BenchmarkEnduranceRepeatReport,
  BenchmarkMatrixReport,
  BenchmarkProofReport,
  BenchmarkReport
} from "../types.js";
import { KairnRuntime } from "../runtime/KairnRuntime.js";
import { runBenchmarkEndurance, runBenchmarkEnduranceRepeats } from "./endurance.js";
import { runBenchmarkMcpSmoke, type BenchmarkMcpSmokeReport } from "./mcpSmoke.js";
import { runBenchmarkRepoMatrix } from "./matrix.js";
import { buildSweAtlasQnaPilot, fetchSweAtlasQnaRows, loadSweAtlasQnaRows, writeSweAtlasQnaPilot, type SweAtlasQnaPilot } from "./sweAtlasQna.js";
import { buildSweBenchProPilot, fetchSweBenchProRows, loadSweBenchProRows, writeSweBenchProPilot, type SweBenchProPilot } from "./sweBenchPro.js";

export type PublicationEntryKind =
  | "matrix"
  | "proof"
  | "endurance"
  | "mcp_smoke"
  | "swe_atlas_qna_pilot"
  | "swe_pro_pilot";

export type PublicationMode =
  | "baseline"
  | "kairn_codex_session"
  | "real_mcp_first"
  | "hybrid_mcp_brief"
  | "hook_full_prime"
  | "manual_prime";

const PUBLICATION_ENTRY_KINDS = new Set<PublicationEntryKind>([
  "matrix",
  "proof",
  "endurance",
  "mcp_smoke",
  "swe_atlas_qna_pilot",
  "swe_pro_pilot"
]);

const PUBLICATION_MODES = new Set<PublicationMode>([
  "baseline",
  "kairn_codex_session",
  "real_mcp_first",
  "hybrid_mcp_brief",
  "hook_full_prime",
  "manual_prime"
]);

export type PublicationPlan = {
  id: string;
  name: string;
  description?: string | undefined;
  defaults?: {
    model?: string | undefined;
    repeat?: number | undefined;
    agentTimeoutMs?: number | undefined;
    turnTimeoutMs?: number | undefined;
    workdir?: string | undefined;
    modes?: PublicationMode[] | undefined;
    commands?: Partial<Record<PublicationMode, string>> | undefined;
    setupCommands?: Partial<Record<Exclude<PublicationMode, "baseline" | "manual_prime">, string>> | undefined;
  } | undefined;
  entries?: PublicationPlanEntry[] | undefined;
  tasks?: PublicationPlanEntry[] | undefined;
};

export type PublicationPlanEntry = {
  id: string;
  kind: PublicationEntryKind;
  label?: string | undefined;
  repoId?: string | undefined;
  repoUrl?: string | undefined;
  commit?: string | undefined;
  language?: string | undefined;
  sizeClass?: string | undefined;
  taskClass?: string | undefined;
  contextBehavior?: BenchmarkContextBehavior | undefined;
  root?: string | undefined;
  matrix?: string | undefined;
  suite?: string | undefined;
  input?: string | undefined;
  outDir?: string | undefined;
  workdir?: string | undefined;
  task?: string | undefined;
  modes?: PublicationMode[] | undefined;
  repeat?: number | undefined;
  timeoutMs?: number | undefined;
  budget?: number | undefined;
  detail?: "compact" | "full" | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  fetchLength?: number | undefined;
  languages?: string[] | undefined;
  repos?: string[] | undefined;
  categories?: string[] | undefined;
  officialEvaluatorPassed?: boolean | undefined;
  officialEvaluationRequired?: boolean | undefined;
  commands?: Partial<Record<PublicationMode, string>> | undefined;
  setupCommands?: Partial<Record<Exclude<PublicationMode, "baseline" | "manual_prime">, string>> | undefined;
};

export type PublicationRunOptions = {
  planPath: string;
  outDir: string;
  model?: string | undefined;
  repeat?: number | undefined;
  resume?: boolean | undefined;
  only?: string | undefined;
  dryRun?: boolean | undefined;
  onProgress?: ((message: string) => void) | undefined;
};

export type PublicationEntryArtifact = {
  entryId: string;
  kind: PublicationEntryKind;
  status: "planned" | "passed" | "failed" | "skipped";
  entryMetadata: {
    label?: string | undefined;
    repoId?: string | undefined;
    repoUrl?: string | undefined;
    commit?: string | undefined;
    language?: string | undefined;
    sizeClass?: string | undefined;
    taskClass?: string | undefined;
    contextBehavior?: BenchmarkContextBehavior | undefined;
  };
  artifactPath?: string | undefined;
  startedAt: string;
  endedAt: string;
  commands: string[];
  report?: unknown;
  error?: string | undefined;
};

export type PublicationResultRow = {
  entryId: string;
  kind: PublicationEntryKind;
  repoId: string;
  language: string;
  sizeClass: string;
  taskClass: string;
  behavior: string;
  mode: string;
  qualityPassed: boolean;
  observedTokens?: number | undefined;
  baselineTokens?: number | undefined;
  savedTokens?: number | undefined;
  savingsRate?: number | undefined;
  validSavings: number;
  passiveSavings: number;
  invalidSavings: number;
  assistanceStatus?: BenchmarkAssistanceStatus | undefined;
  assistClassification?: BenchmarkAssistClassification | undefined;
  active: boolean;
  claimEligible: boolean;
  mcpCalls: number;
  repeatedFilesAvoided: number;
  repeatedSnippetsAvoided: number;
  scopeViolations: number;
  overAssist: boolean;
  harmfulAssist: boolean;
  missedOpportunity: boolean;
  correctAbstention: boolean;
  failurePattern?: string | undefined;
};

export type PublicationAggregate = {
  entries: number;
  resultRows: number;
  qualityPassRate: number;
  medianValidSavingsRate: number;
  modes: Record<string, PublicationModeAggregate>;
  byTaskClass: Record<string, PublicationModeAggregate>;
  classifications: Partial<Record<BenchmarkAssistClassification, number>>;
  failurePatterns: Array<{ pattern: string; count: number; examples: string[] }>;
  successCriteria: {
    qualityWithinFivePoints: boolean;
    activeMedianSavingsAtLeast15: boolean;
    noRepeatedHarmfulPattern: boolean;
    hasMcpEvidence: boolean;
    hasEnduranceAfterTurnOneEvidence: boolean;
  };
};

export type PublicationModeAggregate = {
  rows: number;
  qualityPasses: number;
  activeRows: number;
  passiveRows: number;
  validSavingsRows: number;
  validSavings: number;
  passiveSavings: number;
  invalidSavings: number;
  medianSavingsRate: number;
  overAssistRows: number;
  harmfulRows: number;
  missedOpportunityRows: number;
  correctAbstentionRows: number;
  mcpCalls: number;
  repeatedFilesAvoided: number;
  scopeViolations: number;
};

export type PublicationReport = {
  id: string;
  name: string;
  generatedAt: string;
  planPath: string;
  outDir: string;
  dryRun: boolean;
  model: string;
  repeat: number;
  artifacts: PublicationEntryArtifact[];
  rows: PublicationResultRow[];
  aggregate: PublicationAggregate;
  outputs: {
    summaryPath: string;
    resultsCsvPath: string;
    failuresCsvPath: string;
    manifestPath: string;
    markdownPath: string;
  };
};

export async function runPublicationCampaign(options: PublicationRunOptions): Promise<PublicationReport> {
  const plan = loadPublicationPlan(options.planPath);
  const model = options.model ?? plan.defaults?.model ?? "gpt-5.4-mini";
  const repeat = Math.max(1, Math.floor(options.repeat ?? plan.defaults?.repeat ?? 3));
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const entries = publicationEntries(plan).filter((entry) => matchesOnly(entry, options.only));
  validatePublicationPlan({ plan, entries });
  const artifacts: PublicationEntryArtifact[] = [];
  for (const entry of entries) {
    artifacts.push(await runPublicationEntry({
      plan,
      entry,
      outDir,
      model,
      repeat,
      resume: Boolean(options.resume),
      dryRun: Boolean(options.dryRun),
      onProgress: options.onProgress
    }));
  }
  const rows = artifacts.flatMap((artifact) => artifactToRows(artifact, entryById(entries, artifact.entryId)));
  const aggregate = aggregatePublicationRows(rows);
  const outputs = publicationOutputPaths(outDir);
  const report: PublicationReport = {
    id: plan.id,
    name: plan.name,
    generatedAt: new Date().toISOString(),
    planPath: path.resolve(options.planPath),
    outDir,
    dryRun: Boolean(options.dryRun),
    model,
    repeat,
    artifacts,
    rows,
    aggregate,
    outputs
  };
  writePublicationOutputs(report);
  return report;
}

export function loadPublicationPlan(planPath: string): PublicationPlan {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(planPath), "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Publication plan must be a JSON object.");
  const plan = parsed as PublicationPlan;
  if (!plan.id || !plan.name) throw new Error("Publication plan requires id and name.");
  publicationEntries(plan);
  return plan;
}

export function validatePublicationPlan(input: { plan: PublicationPlan; entries?: PublicationPlanEntry[] | undefined }): void {
  const entries = input.entries ?? publicationEntries(input.plan);
  if (entries.length === 0) throw new Error("Publication plan must include at least one entry.");
  const ids = new Set<string>();
  for (const mode of input.plan.defaults?.modes ?? []) {
    if (!PUBLICATION_MODES.has(mode)) throw new Error(`Unsupported publication mode: ${mode}`);
  }
  for (const entry of entries) {
    if (!entry.id) throw new Error("Publication entry requires id.");
    if (!PUBLICATION_ENTRY_KINDS.has(entry.kind)) throw new Error(`Unsupported publication entry kind: ${entry.kind}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate publication entry id: ${entry.id}`);
    ids.add(entry.id);
    for (const mode of entry.modes ?? []) {
      if (!PUBLICATION_MODES.has(mode)) throw new Error(`${entry.id}: unsupported publication mode: ${mode}`);
    }
    const modes = publicationModes(input.plan, entry);
    if ((entry.kind === "proof" || entry.kind === "endurance") && !modes.includes("baseline")) {
      throw new Error(`${entry.id}: proof/endurance entries require baseline mode.`);
    }
    if (entry.kind === "matrix" && !entry.matrix) throw new Error(`${entry.id}: matrix entry requires matrix.`);
    if (entry.kind === "proof" && (!entry.root || !entry.suite)) throw new Error(`${entry.id}: proof entry requires root and suite.`);
    if (entry.kind === "endurance" && (!entry.root || !entry.suite)) throw new Error(`${entry.id}: endurance entry requires root and suite.`);
    if (entry.kind === "mcp_smoke" && (!entry.root || !entry.task)) throw new Error(`${entry.id}: mcp_smoke entry requires root and task.`);
  }
}

async function runPublicationEntry(input: {
  plan: PublicationPlan;
  entry: PublicationPlanEntry;
  outDir: string;
  model: string;
  repeat: number;
  resume: boolean;
  dryRun: boolean;
  onProgress?: ((message: string) => void) | undefined;
}): Promise<PublicationEntryArtifact> {
  const startedAt = new Date().toISOString();
  const artifactPath = path.join(input.outDir, "raw", `${input.entry.id}.json`);
  const partialPath = path.join(input.outDir, "raw", `${input.entry.id}.partial.json`);
  const commands = plannedCommands(input.plan, input.entry, input.model, input.repeat);
  input.onProgress?.(`[bench publication] ${input.entry.id}: start`);
  if (input.dryRun) {
    return {
      entryId: input.entry.id,
      kind: input.entry.kind,
      status: "planned",
      entryMetadata: publicationEntryMetadata(input.entry),
      artifactPath,
      startedAt,
      endedAt: new Date().toISOString(),
      commands
    };
  }
  if (input.resume && fs.existsSync(artifactPath)) {
    const existing = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as PublicationEntryArtifact;
    if (existing.status === "passed") {
      input.onProgress?.(`[bench publication] ${input.entry.id}: skipped existing artifact`);
      return { ...existing, status: "skipped", entryMetadata: existing.entryMetadata ?? publicationEntryMetadata(input.entry) };
    }
  }

  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  try {
    const report = await executePublicationEntry(input.plan, input.entry, input.model, input.repeat, partialPath, input.onProgress);
    const artifact: PublicationEntryArtifact = {
      entryId: input.entry.id,
      kind: input.entry.kind,
      status: "passed",
      entryMetadata: publicationEntryMetadata(input.entry),
      artifactPath,
      startedAt,
      endedAt: new Date().toISOString(),
      commands,
      report
    };
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    input.onProgress?.(`[bench publication] ${input.entry.id}: passed`);
    return artifact;
  } catch (error) {
    const artifact: PublicationEntryArtifact = {
      entryId: input.entry.id,
      kind: input.entry.kind,
      status: "failed",
      entryMetadata: publicationEntryMetadata(input.entry),
      artifactPath,
      startedAt,
      endedAt: new Date().toISOString(),
      commands,
      error: error instanceof Error ? error.message : String(error)
    };
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    input.onProgress?.(`[bench publication] ${input.entry.id}: failed`);
    return artifact;
  }
}

async function executePublicationEntry(
  plan: PublicationPlan,
  entry: PublicationPlanEntry,
  model: string,
  repeat: number,
  partialPath: string,
  onProgress: ((message: string) => void) | undefined
): Promise<unknown> {
  if (entry.kind === "matrix") {
    return runBenchmarkRepoMatrix({
      matrixPath: entry.matrix!,
      workdir: entry.workdir ?? plan.defaults?.workdir
    });
  }
  if (entry.kind === "mcp_smoke") {
    return runBenchmarkMcpSmoke({
      rootPath: entry.root!,
      task: entry.task!,
      budget: entry.budget,
      detail: entry.detail
    });
  }
  if (entry.kind === "endurance") {
    const modes = publicationModes(plan, entry);
    const input = {
      rootPath: entry.root!,
      suitePath: entry.suite!,
      baselineCommand: commandFor(plan, entry, "baseline", model),
      ...(modes.includes("kairn_codex_session")
        ? {
            kairnCodexSessionCommand: commandFor(plan, entry, "kairn_codex_session", model),
            kairnCodexSessionSetupCommand: setupCommandFor(plan, entry, "kairn_codex_session")
          }
        : {}),
      ...(modes.includes("real_mcp_first")
        ? {
            realMcpFirstCommand: commandFor(plan, entry, "real_mcp_first", model),
            realMcpFirstSetupCommand: setupCommandFor(plan, entry, "real_mcp_first")
          }
        : {}),
      ...(modes.includes("hybrid_mcp_brief")
        ? {
            hybridMcpBriefCommand: commandFor(plan, entry, "hybrid_mcp_brief", model),
            hybridMcpBriefSetupCommand: setupCommandFor(plan, entry, "hybrid_mcp_brief")
          }
        : {}),
      turnTimeoutMs: entry.timeoutMs ?? plan.defaults?.turnTimeoutMs
    };
    const entryRepeat = Math.max(1, Math.floor(entry.repeat ?? repeat));
    return entryRepeat > 1 ? runBenchmarkEnduranceRepeats({ ...input, repeat: entryRepeat }) : runBenchmarkEndurance(input);
  }
  if (entry.kind === "proof") {
    const runtime = new KairnRuntime(entry.root!);
    try {
      const modes = publicationModes(plan, entry);
      await runtime.init();
      return await runtime.proveBenchmark({
        suitePath: entry.suite!,
        baselineCommand: commandFor(plan, entry, "baseline", model),
        ...(modes.includes("manual_prime") ? { manualPrimeCommand: commandFor(plan, entry, "manual_prime", model) } : {}),
        ...(modes.includes("hook_full_prime") ? { hookFullPrimeCommand: commandFor(plan, entry, "hook_full_prime", model), hookFullPrimeSetupCommand: setupCommandFor(plan, entry, "hook_full_prime") } : {}),
        ...(modes.includes("kairn_codex_session") ? { kairnCodexSessionCommand: commandFor(plan, entry, "kairn_codex_session", model), kairnCodexSessionSetupCommand: setupCommandFor(plan, entry, "kairn_codex_session") } : {}),
        ...(modes.includes("real_mcp_first") ? { realMcpFirstCommand: commandFor(plan, entry, "real_mcp_first", model), realMcpFirstSetupCommand: setupCommandFor(plan, entry, "real_mcp_first") } : {}),
        ...(modes.includes("hybrid_mcp_brief") ? { hybridMcpBriefCommand: commandFor(plan, entry, "hybrid_mcp_brief", model), hybridMcpBriefSetupCommand: setupCommandFor(plan, entry, "hybrid_mcp_brief") } : {}),
        agentTimeoutMs: entry.timeoutMs ?? plan.defaults?.agentTimeoutMs,
        repeat: Math.max(1, Math.floor(entry.repeat ?? repeat)),
        proofOutputPath: partialPath,
        onProgress
      });
    } finally {
      runtime.close();
    }
  }
  if (entry.kind === "swe_atlas_qna_pilot") {
    const rows = entry.input ? loadSweAtlasQnaRows(entry.input) : await fetchSweAtlasQnaRows({ offset: entry.offset ?? 0, length: entry.fetchLength ?? 50 });
    const pilot = buildSweAtlasQnaPilot({
      rows,
      limit: entry.limit ?? 30,
      languages: entry.languages,
      repos: entry.repos,
      categories: entry.categories
    });
    return { pilot, outputs: writeSweAtlasQnaPilot({ pilot, outDir: entry.outDir ?? path.join("examples", "bench", "swe-atlas-qna-publication") }) };
  }
  if (entry.kind === "swe_pro_pilot") {
    const rows = entry.input ? loadSweBenchProRows(entry.input) : await fetchSweBenchProRows({ offset: entry.offset ?? 0, length: entry.fetchLength ?? 50 });
    const pilot = buildSweBenchProPilot({
      rows,
      limit: entry.limit ?? 10,
      languages: entry.languages,
      repos: entry.repos
    });
    return { pilot, outputs: writeSweBenchProPilot({ pilot, outDir: entry.outDir ?? path.join("examples", "bench", "swe-pro-publication") }) };
  }
  throw new Error(`Unsupported publication entry kind: ${entry.kind}`);
}

function publicationEntries(plan: PublicationPlan): PublicationPlanEntry[] {
  const entries = plan.entries ?? plan.tasks;
  if (!Array.isArray(entries)) throw new Error("Publication plan requires entries or tasks array.");
  return entries;
}

function publicationEntryMetadata(entry: PublicationPlanEntry): PublicationEntryArtifact["entryMetadata"] {
  return {
    label: entry.label,
    repoId: entry.repoId,
    repoUrl: entry.repoUrl,
    commit: entry.commit,
    language: entry.language,
    sizeClass: entry.sizeClass,
    taskClass: entry.taskClass,
    contextBehavior: entry.contextBehavior
  };
}

function artifactToRows(artifact: PublicationEntryArtifact, entry: PublicationPlanEntry): PublicationResultRow[] {
  if (artifact.status === "planned") return [];
  if ((artifact.status !== "passed" && artifact.status !== "skipped") || !artifact.report) return failureArtifactRows(artifact, entry);
  if (artifact.kind === "proof") return proofRows(artifact.report as BenchmarkProofReport, artifact, entry);
  if (artifact.kind === "endurance") return enduranceRows(artifact.report as BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport, artifact, entry);
  if (artifact.kind === "matrix") return matrixRows(artifact.report as BenchmarkMatrixReport, artifact, entry);
  if (artifact.kind === "mcp_smoke") return mcpSmokeRows(artifact.report as BenchmarkMcpSmokeReport, artifact, entry);
  if (artifact.kind === "swe_atlas_qna_pilot") return pilotRows((artifact.report as { pilot: SweAtlasQnaPilot }).pilot, artifact, entry);
  if (artifact.kind === "swe_pro_pilot") return pilotRows((artifact.report as { pilot: SweBenchProPilot }).pilot, artifact, entry);
  return [];
}

function proofRows(report: BenchmarkProofReport, artifact: PublicationEntryArtifact, entry: PublicationPlanEntry): PublicationResultRow[] {
  const rows: PublicationResultRow[] = [];
  rows.push(baseRow({
    artifact,
    entry,
    mode: "baseline",
    qualityPassed: report.baseline.results.every(resultQualityPassed),
    observedTokens: report.baseline.observed?.codexTokens,
    mcpCalls: benchmarkReportMcpCalls(report.baseline)
  }));
  const deltas: Array<[string, BenchmarkComparison["observedTokenDelta"], BenchmarkReport | undefined]> = [
    ["manual_prime", report.observedTokenDeltas.manualPrimeVsBaseline, report.manualPrime],
    ["hook_full_prime", report.observedTokenDeltas.hookFullPrimeVsBaseline, report.hookFullPrime],
    ["kairn_codex_session", report.observedTokenDeltas.kairnCodexSessionVsBaseline, report.kairnCodexSession],
    ["real_mcp_first", report.observedTokenDeltas.realMcpFirstVsBaseline, report.realMcpFirst],
    ["hybrid_mcp_brief", report.observedTokenDeltas.hybridMcpBriefVsBaseline, report.hybridMcpBrief]
  ];
  for (const [mode, delta, modeReport] of deltas) {
    if (!delta) continue;
    rows.push(rowFromDelta({ artifact, entry, mode, delta, mcpCalls: benchmarkReportMcpCalls(modeReport) }));
  }
  return rows;
}

function enduranceRows(report: BenchmarkEnduranceReport | BenchmarkEnduranceRepeatReport, artifact: PublicationEntryArtifact, entry: PublicationPlanEntry): PublicationResultRow[] {
  if ("aggregate" in report && "runs" in report) {
    return Object.values(report.aggregate).map((mode) => {
      const qualityPassed = mode.qualityPasses > 0 && mode.qualityPasses === mode.repeats;
      return baseRow({
        artifact,
        entry,
        mode: mode.mode,
        qualityPassed,
        observedTokens: mode.medianObservedCodexTokens,
        savedTokens: mode.medianSavedTokens,
        savingsRate: mode.medianSavingsRate,
        validSavings: mode.validSavingsRuns > 0 && mode.medianSavedTokens && mode.medianSavedTokens > 0 ? mode.medianSavedTokens : 0,
        assistanceStatus: mode.mode === "baseline" ? "none" : mode.activeRuns > 0 ? "active" : mode.passiveSuppressedRuns > 0 ? "passive_suppressed" : "none",
        active: mode.activeRuns > 0,
        overAssist: mode.overAssistRuns > 0,
        harmfulAssist: mode.harmfulRuns > 0,
        missedOpportunity: mode.missedOpportunityRuns > 0,
        correctAbstention: mode.correctAbstentionRuns > 0,
        repeatedFilesAvoided: repeatedFilesAvoidedForMode(report, mode.mode)
      });
    });
  }

  const baseline = report.reports.find((item) => item.mode === "baseline");
  return report.reports.map((modeReport) => {
    const delta = report.deltas[modeReport.mode];
    return baseRow({
      artifact,
      entry,
      mode: modeReport.mode,
      qualityPassed: modeReport.qualityGatePassed,
      observedTokens: modeReport.totalObservedCodexTokens,
      baselineTokens: baseline?.totalObservedCodexTokens,
      savedTokens: delta?.savedTokens,
      savingsRate: delta?.savingsRate,
      validSavings: delta?.validSavings ?? 0,
      passiveSavings: delta?.passiveSavings ?? 0,
      invalidSavings: delta?.invalidSavings ?? 0,
      assistanceStatus: modeReport.assistanceStatus,
      active: modeReport.assistanceStatus === "active",
      overAssist: Boolean(delta?.overAssist),
      harmfulAssist: Boolean(delta?.harmfulAssist),
      missedOpportunity: Boolean(delta?.missedOpportunity),
      correctAbstention: delta?.abstentionOutcome === "correct_abstention",
      mcpCalls: modeReport.assistanceActions.mcpCalls,
      repeatedFilesAvoided: modeReport.turns.reduce((total, turn) => total + turn.repeatedFilesAvoided, 0),
      repeatedSnippetsAvoided: modeReport.turns.reduce((total, turn) => total + turn.repeatedSnippetsAvoided, 0),
      scopeViolations: stringArray(modeReport.metadata?.finalDiffScopeViolations).length
    });
  });
}

function matrixRows(report: BenchmarkMatrixReport, artifact: PublicationEntryArtifact, entry: PublicationPlanEntry): PublicationResultRow[] {
  return report.repos.flatMap((repo) =>
    repo.cases.map((matrixCase) =>
      baseRow({
        artifact,
        entry: {
          ...entry,
          repoId: entry.repoId ?? repo.repo.id,
          language: entry.language ?? repo.repo.language,
          sizeClass: entry.sizeClass ?? repo.repo.sizeClass,
          taskClass: entry.taskClass ?? matrixCase.officialEvaluation?.taskClass ?? entry.taskClass,
          contextBehavior: entry.contextBehavior ?? matrixCase.officialEvaluation?.taskClass as BenchmarkContextBehavior | undefined
        },
        mode: "matrix_preflight",
        qualityPassed: matrixCase.qualityGatePassed,
        observedTokens: matrixCase.primeTokens,
        active: matrixCase.contextDecision === "emit" || matrixCase.contextDecision === "shrink",
        scopeViolations: 0,
        failurePattern: matrixCase.qualityGatePassed ? undefined : matrixCase.recommendations[0]
      })
    )
  );
}

function mcpSmokeRows(report: BenchmarkMcpSmokeReport, artifact: PublicationEntryArtifact, entry: PublicationPlanEntry): PublicationResultRow[] {
  return [
    baseRow({
      artifact,
      entry,
      mode: "mcp_smoke",
      qualityPassed: report.tools.includes("kairn_prepare_task") && report.metrics.mcpToolCalls > 0,
      mcpCalls: report.metrics.mcpToolCalls,
      active: report.metrics.mcpToolCalls > 0,
      validSavings: 0,
      failurePattern: report.metrics.mcpToolCalls > 0 ? undefined : "MCP smoke did not record a tool call"
    })
  ];
}

function pilotRows(pilot: SweAtlasQnaPilot | SweBenchProPilot, artifact: PublicationEntryArtifact, entry: PublicationPlanEntry): PublicationResultRow[] {
  const matrixRepos = pilot.matrix.repos.length;
  return [
    baseRow({
      artifact,
      entry,
      mode: "official_pilot",
      qualityPassed: matrixRepos > 0,
      observedTokens: pilot.rows,
      failurePattern: pilot.summary.warnings[0]
    })
  ];
}

function failureArtifactRows(artifact: PublicationEntryArtifact, entry: PublicationPlanEntry): PublicationResultRow[] {
  return [
    baseRow({
      artifact,
      entry,
      mode: artifact.kind,
      qualityPassed: false,
      failurePattern: artifact.error ?? artifact.status
    })
  ];
}

function rowFromDelta(input: {
  artifact: PublicationEntryArtifact;
  entry: PublicationPlanEntry;
  mode: string;
  delta: NonNullable<BenchmarkComparison["observedTokenDelta"]>;
  mcpCalls?: number | undefined;
}): PublicationResultRow {
  const missingMcpCalls = input.mode.includes("mcp") && (input.mcpCalls ?? 0) === 0;
  return baseRow({
    artifact: input.artifact,
    entry: input.entry,
    mode: input.mode,
    qualityPassed: input.delta.qualityGatePassed === true,
    observedTokens: input.delta.afterTokens,
    baselineTokens: input.delta.beforeTokens,
    savedTokens: input.delta.savedTokens,
    savingsRate: input.delta.savingsRate,
    validSavings: input.delta.validSavings ?? 0,
    passiveSavings: input.delta.passiveSavings ?? 0,
    invalidSavings: input.delta.invalidSavings ?? 0,
    assistanceStatus: input.delta.assistanceStatus,
    assistClassification: input.delta.assistClassification,
    active: input.delta.assistanceStatus === "active",
    mcpCalls: input.mcpCalls,
    overAssist: Boolean(input.delta.overAssist),
    harmfulAssist: Boolean(input.delta.harmfulAssist),
    missedOpportunity: Boolean(input.delta.missedOpportunity),
    correctAbstention: input.delta.abstentionOutcome === "correct_abstention",
    failurePattern: missingMcpCalls ? "MCP mode recorded no actual MCP calls." : input.delta.negativeEvidenceReason
  });
}

function baseRow(input: {
  artifact: PublicationEntryArtifact;
  entry: PublicationPlanEntry;
  mode: string;
  qualityPassed: boolean;
  observedTokens?: number | undefined;
  baselineTokens?: number | undefined;
  savedTokens?: number | undefined;
  savingsRate?: number | undefined;
  validSavings?: number | undefined;
  passiveSavings?: number | undefined;
  invalidSavings?: number | undefined;
  assistanceStatus?: BenchmarkAssistanceStatus | undefined;
  assistClassification?: BenchmarkAssistClassification | undefined;
  active?: boolean | undefined;
  mcpCalls?: number | undefined;
  repeatedFilesAvoided?: number | undefined;
  repeatedSnippetsAvoided?: number | undefined;
  scopeViolations?: number | undefined;
  overAssist?: boolean | undefined;
  harmfulAssist?: boolean | undefined;
  missedOpportunity?: boolean | undefined;
  correctAbstention?: boolean | undefined;
  failurePattern?: string | undefined;
}): PublicationResultRow {
  const officialSavingsBlocked =
    input.entry.officialEvaluationRequired === true &&
    input.entry.officialEvaluatorPassed !== true &&
    (input.validSavings ?? 0) > 0;
  const active = input.active ?? input.assistanceStatus === "active";
  const validSavings = officialSavingsBlocked ? 0 : input.validSavings ?? 0;
  return {
    entryId: input.artifact.entryId,
    kind: input.artifact.kind,
    repoId: input.entry.repoId ?? "unknown",
    language: input.entry.language ?? "unknown",
    sizeClass: input.entry.sizeClass ?? "unknown",
    taskClass: input.entry.taskClass ?? "unknown",
    behavior: input.entry.contextBehavior ?? "unknown",
    mode: input.mode,
    qualityPassed: input.qualityPassed,
    observedTokens: input.observedTokens,
    baselineTokens: input.baselineTokens,
    savedTokens: input.savedTokens,
    savingsRate: input.savingsRate,
    validSavings,
    passiveSavings: input.passiveSavings ?? 0,
    invalidSavings: input.invalidSavings ?? (officialSavingsBlocked ? input.validSavings ?? 0 : 0),
    assistanceStatus: input.assistanceStatus,
    assistClassification: input.assistClassification,
    active,
    claimEligible: input.qualityPassed && active && validSavings > 0 && (input.scopeViolations ?? 0) === 0,
    mcpCalls: input.mcpCalls ?? 0,
    repeatedFilesAvoided: input.repeatedFilesAvoided ?? 0,
    repeatedSnippetsAvoided: input.repeatedSnippetsAvoided ?? 0,
    scopeViolations: input.scopeViolations ?? 0,
    overAssist: Boolean(input.overAssist),
    harmfulAssist: Boolean(input.harmfulAssist),
    missedOpportunity: Boolean(input.missedOpportunity),
    correctAbstention: Boolean(input.correctAbstention),
    failurePattern: officialSavingsBlocked ? "Official evaluator pass missing; savings cannot be counted." : input.failurePattern
  };
}

export function aggregatePublicationRows(rows: PublicationResultRow[]): PublicationAggregate {
  const modes: Record<string, PublicationModeAggregate> = {};
  const byTaskClass: Record<string, PublicationModeAggregate> = {};
  const classifications: Partial<Record<BenchmarkAssistClassification, number>> = {};
  for (const row of rows) {
    addRowToAggregate(modes, row.mode, row);
    addRowToAggregate(byTaskClass, row.taskClass, row);
    if (row.assistClassification) {
      classifications[row.assistClassification] = (classifications[row.assistClassification] ?? 0) + 1;
    }
  }
  finalizeAggregates(modes, rows, (row, key) => row.mode === key);
  finalizeAggregates(byTaskClass, rows, (row, key) => row.taskClass === key);
  const baselineRows = rows.filter((row) => row.mode === "baseline");
  const qualityRows = rows.filter((row) => row.mode !== "baseline");
  const baselinePassRate = ratio(baselineRows.filter((row) => row.qualityPassed).length, baselineRows.length);
  const assistedPassRate = ratio(qualityRows.filter((row) => row.qualityPassed).length, qualityRows.length);
  const activeSavingsRates = rows.filter((row) => row.claimEligible && row.savingsRate !== undefined).map((row) => row.savingsRate!);
  const failures = failurePatterns(rows);
  return {
    entries: new Set(rows.map((row) => row.entryId)).size,
    resultRows: rows.length,
    qualityPassRate: ratio(qualityRows.filter((row) => row.qualityPassed).length, qualityRows.length),
    medianValidSavingsRate: median(activeSavingsRates),
    modes,
    byTaskClass,
    classifications,
    failurePatterns: failures,
    successCriteria: {
      qualityWithinFivePoints: baselineRows.length === 0 || assistedPassRate + 0.05 >= baselinePassRate,
      activeMedianSavingsAtLeast15: median(activeSavingsRates) >= 0.15,
      noRepeatedHarmfulPattern: !failures.some((failure) => /harmful/i.test(failure.pattern) && failure.count > 1),
      hasMcpEvidence: rows.some((row) => row.mcpCalls > 0 || row.mode.includes("mcp")),
      hasEnduranceAfterTurnOneEvidence: rows.some((row) => row.kind === "endurance" && row.repeatedFilesAvoided > 0)
    }
  };
}

function addRowToAggregate(target: Record<string, PublicationModeAggregate>, key: string, row: PublicationResultRow): void {
  target[key] ??= emptyModeAggregate();
  const aggregate = target[key]!;
  aggregate.rows += 1;
  if (row.qualityPassed) aggregate.qualityPasses += 1;
  if (row.active) aggregate.activeRows += 1;
  if (row.assistanceStatus === "passive_suppressed") aggregate.passiveRows += 1;
  if (row.validSavings > 0) aggregate.validSavingsRows += 1;
  aggregate.validSavings += row.validSavings;
  aggregate.passiveSavings += row.passiveSavings;
  aggregate.invalidSavings += row.invalidSavings;
  if (row.overAssist) aggregate.overAssistRows += 1;
  if (row.harmfulAssist) aggregate.harmfulRows += 1;
  if (row.missedOpportunity) aggregate.missedOpportunityRows += 1;
  if (row.correctAbstention) aggregate.correctAbstentionRows += 1;
  aggregate.mcpCalls += row.mcpCalls;
  aggregate.repeatedFilesAvoided += row.repeatedFilesAvoided;
  aggregate.scopeViolations += row.scopeViolations;
}

function emptyModeAggregate(): PublicationModeAggregate {
  return {
    rows: 0,
    qualityPasses: 0,
    activeRows: 0,
    passiveRows: 0,
    validSavingsRows: 0,
    validSavings: 0,
    passiveSavings: 0,
    invalidSavings: 0,
    medianSavingsRate: 0,
    overAssistRows: 0,
    harmfulRows: 0,
    missedOpportunityRows: 0,
    correctAbstentionRows: 0,
    mcpCalls: 0,
    repeatedFilesAvoided: 0,
    scopeViolations: 0
  };
}

function finalizeAggregates(
  aggregates: Record<string, PublicationModeAggregate>,
  rows: PublicationResultRow[],
  predicate: (row: PublicationResultRow, key: string) => boolean
): void {
  for (const [key, aggregate] of Object.entries(aggregates)) {
    const rates = rows.filter((row) => predicate(row, key)).map((row) => row.savingsRate ?? 0);
    aggregate.medianSavingsRate = median(rates);
  }
}

function failurePatterns(rows: PublicationResultRow[]): Array<{ pattern: string; count: number; examples: string[] }> {
  const grouped = new Map<string, { count: number; examples: string[] }>();
  for (const row of rows) {
    const pattern = row.failurePattern ??
      (row.harmfulAssist ? "harmful assist" : row.overAssist ? "over-assist" : row.scopeViolations > 0 ? "scope violation" : !row.qualityPassed ? "quality gate failed" : "");
    if (!pattern) continue;
    const existing = grouped.get(pattern) ?? { count: 0, examples: [] };
    existing.count += 1;
    if (existing.examples.length < 5) existing.examples.push(`${row.entryId}:${row.mode}`);
    grouped.set(pattern, existing);
  }
  return [...grouped.entries()]
    .map(([pattern, value]) => ({ pattern, ...value }))
    .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
}

function writePublicationOutputs(report: PublicationReport): void {
  report.aggregate = aggregatePublicationRows(report.rows);
  fs.writeFileSync(report.outputs.summaryPath, `${JSON.stringify({ ...report, rows: undefined, artifacts: undefined }, null, 2)}\n`);
  fs.writeFileSync(report.outputs.resultsCsvPath, rowsToCsv(report.rows));
  fs.writeFileSync(report.outputs.failuresCsvPath, rowsToCsv(report.rows.filter((row) => row.failurePattern || row.harmfulAssist || row.overAssist || !row.qualityPassed)));
  fs.writeFileSync(report.outputs.manifestPath, `${JSON.stringify(publicationManifest(report), null, 2)}\n`);
  fs.writeFileSync(report.outputs.markdownPath, formatPublicationMarkdown(report));
}

function publicationOutputPaths(outDir: string): PublicationReport["outputs"] {
  return {
    summaryPath: path.join(outDir, "publication-summary.json"),
    resultsCsvPath: path.join(outDir, "publication-results.csv"),
    failuresCsvPath: path.join(outDir, "publication-failures.csv"),
    manifestPath: path.join(outDir, "publication-manifest.json"),
    markdownPath: path.join(outDir, "kairn_publication_evidence_report_2026-05-14.md")
  };
}

function publicationManifest(report: PublicationReport): Record<string, unknown> {
  return {
    id: report.id,
    name: report.name,
    generatedAt: report.generatedAt,
    planPath: report.planPath,
    model: report.model,
    repeat: report.repeat,
    dryRun: report.dryRun,
    artifacts: report.artifacts.map((artifact) => ({
      entryId: artifact.entryId,
      kind: artifact.kind,
      status: artifact.status,
      entryMetadata: artifact.entryMetadata,
      artifactPath: artifact.artifactPath,
      commands: artifact.commands
    }))
  };
}

function formatPublicationMarkdown(report: PublicationReport): string {
  return [
    "# Kairn Publication Evidence Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Plan: ${report.planPath}`,
    `Model: ${report.model}`,
    `Dry run: ${report.dryRun}`,
    "",
    "## Summary",
    "",
    `- Entries: ${report.aggregate.entries}`,
    `- Result rows: ${report.aggregate.resultRows}`,
    `- Quality pass rate: ${percent(report.aggregate.qualityPassRate)}`,
    `- Median valid active savings: ${percent(report.aggregate.medianValidSavingsRate)}`,
    `- Active median savings >= 15%: ${report.aggregate.successCriteria.activeMedianSavingsAtLeast15}`,
    `- MCP evidence present: ${report.aggregate.successCriteria.hasMcpEvidence}`,
    `- Endurance repeat evidence present: ${report.aggregate.successCriteria.hasEnduranceAfterTurnOneEvidence}`,
    "",
    "## Entry Results",
    "",
    markdownTable(
      ["Entry", "Repo", "Task Class", "Mode", "Quality", "Valid Savings", "Classification", "Failure Pattern"],
      report.rows.map((row) => [
        row.entryId,
        row.repoId,
        row.taskClass,
        row.mode,
        row.qualityPassed ? "pass" : "fail",
        String(Math.round(row.validSavings)),
        row.assistClassification ?? row.assistanceStatus ?? "",
        row.failurePattern ?? ""
      ])
    ),
    "",
    "## Mode Results",
    "",
    markdownTable(
      ["Mode", "Rows", "Quality", "Active", "Valid Savings", "Passive", "Invalid", "MCP Calls", "Over", "Harmful", "Missed", "Abstain", "Scope Violations"],
      Object.entries(report.aggregate.modes).map(([mode, item]) => [
        mode,
        String(item.rows),
        percent(ratio(item.qualityPasses, item.rows)),
        String(item.activeRows),
        String(Math.round(item.validSavings)),
        String(Math.round(item.passiveSavings)),
        String(Math.round(item.invalidSavings)),
        String(item.mcpCalls),
        String(item.overAssistRows),
        String(item.harmfulRows),
        String(item.missedOpportunityRows),
        String(item.correctAbstentionRows),
        String(item.scopeViolations)
      ])
    ),
    "",
    "## Task Class Results",
    "",
    markdownTable(
      ["Task Class", "Rows", "Quality", "Active", "Median Savings", "Harmful", "Missed"],
      Object.entries(report.aggregate.byTaskClass).map(([taskClass, item]) => [
        taskClass,
        String(item.rows),
        percent(ratio(item.qualityPasses, item.rows)),
        String(item.activeRows),
        percent(item.medianSavingsRate),
        String(item.harmfulRows),
        String(item.missedOpportunityRows)
      ])
    ),
    "",
    "## Failure Patterns",
    "",
    report.aggregate.failurePatterns.length
      ? markdownTable(
          ["Pattern", "Count", "Examples"],
          report.aggregate.failurePatterns.map((item) => [item.pattern, String(item.count), item.examples.join(", ")])
        )
      : "No repeated failure patterns recorded.",
    "",
    "## Improvement Recommendations",
    "",
    ...publicationRecommendations(report).map((item) => `- ${item}`),
    "",
    "## Claim Rules",
    "",
    "- Active savings count only when quality passes, Kairn assistance is active, scope violations are zero, and official evaluator requirements are met.",
    "- Suppressed/passive savings are reported separately as abstention evidence.",
    "- Official SWE-Pro savings are invalid until the official evaluator passes.",
    ""
  ].join("\n");
}

function publicationRecommendations(report: PublicationReport): string[] {
  const recommendations: string[] = [];
  if (!report.aggregate.successCriteria.qualityWithinFivePoints) {
    recommendations.push("Quality pass rate fell more than five percentage points below baseline; treat savings as blocked until failure patterns are addressed.");
  }
  if (!report.aggregate.successCriteria.activeMedianSavingsAtLeast15) {
    recommendations.push("Active median savings did not reach 15%; inspect missed opportunities and over-assist classes before increasing live spend.");
  }
  if (!report.aggregate.successCriteria.hasMcpEvidence) {
    recommendations.push("No real MCP evidence was recorded; run the MCP smoke or a live MCP subset before making MCP claims.");
  }
  if (!report.aggregate.successCriteria.hasEnduranceAfterTurnOneEvidence) {
    recommendations.push("No repeated-context endurance evidence was recorded; run a 6-10 turn suite before making long-session claims.");
  }
  for (const failure of report.aggregate.failurePatterns.slice(0, 3)) {
    recommendations.push(`Investigate repeated pattern "${failure.pattern}" across ${failure.count} row(s).`);
  }
  return recommendations.length > 0 ? recommendations : ["No immediate publication blockers were detected in this evidence bundle."];
}

function rowsToCsv(rows: PublicationResultRow[]): string {
  const headers = [
    "entryId",
    "kind",
    "repoId",
    "language",
    "sizeClass",
    "taskClass",
    "behavior",
    "mode",
    "qualityPassed",
    "observedTokens",
    "baselineTokens",
    "savedTokens",
    "savingsRate",
    "validSavings",
    "passiveSavings",
    "invalidSavings",
    "assistanceStatus",
    "assistClassification",
    "active",
    "claimEligible",
    "mcpCalls",
    "repeatedFilesAvoided",
    "scopeViolations",
    "overAssist",
    "harmfulAssist",
    "missedOpportunity",
    "correctAbstention",
    "failurePattern"
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue((row as unknown as Record<string, unknown>)[header])).join(","))
  ].join("\n") + "\n";
}

function plannedCommands(plan: PublicationPlan, entry: PublicationPlanEntry, model: string, repeat: number): string[] {
  if (entry.kind === "matrix") return [`kairn bench matrix --matrix ${entry.matrix}${entry.workdir ? ` --workdir ${entry.workdir}` : ""}`];
  if (entry.kind === "mcp_smoke") return [`kairn bench mcp-smoke --root ${entry.root} --task ${JSON.stringify(entry.task)}`];
  if (entry.kind === "swe_atlas_qna_pilot") return [`kairn bench swe-atlas-qna-pilot --limit ${entry.limit ?? 30}`];
  if (entry.kind === "swe_pro_pilot") return [`kairn bench swe-pro-pilot --limit ${entry.limit ?? 10}`];
  const modes = publicationModes(plan, entry);
  return [
    `${entry.kind} repeat=${entry.repeat ?? repeat}`,
    ...modes.map((mode) => `${mode}: ${commandFor(plan, entry, mode, model)}`)
  ];
}

function commandFor(plan: PublicationPlan, entry: PublicationPlanEntry, mode: PublicationMode, model: string): string {
  const command = entry.commands?.[mode] ?? plan.defaults?.commands?.[mode] ?? defaultCommand(mode, model);
  return command.replaceAll("{model}", model);
}

function setupCommandFor(plan: PublicationPlan, entry: PublicationPlanEntry, mode: Exclude<PublicationMode, "baseline" | "manual_prime">): string | undefined {
  return entry.setupCommands?.[mode] ?? plan.defaults?.setupCommands?.[mode] ?? defaultSetupCommand(mode);
}

function defaultCommand(mode: PublicationMode, model: string): string {
  const base = `codex -a never exec --model ${model} --sandbox danger-full-access --disable hooks {prompt}`;
  if (mode === "kairn_codex_session") {
    return `kairn codex --root {root} --model ${model} --sandbox danger-full-access {prompt}`;
  }
  if (mode === "hook_full_prime" || mode === "hybrid_mcp_brief") {
    return `codex -a never exec --model ${model} --sandbox danger-full-access --enable hooks {prompt}`;
  }
  return base;
}

function defaultSetupCommand(mode: Exclude<PublicationMode, "baseline" | "manual_prime">): string | undefined {
  if (mode === "real_mcp_first") return "kairn setup codex --root {root} --mode mcp-first >/dev/null";
  if (mode === "hybrid_mcp_brief") return "kairn setup codex --root {root} --mode hybrid --session {session} >/dev/null";
  if (mode === "hook_full_prime") return "kairn setup codex --root {root} --mode savings --hook-output full-prime >/dev/null";
  return undefined;
}

function publicationModes(plan: PublicationPlan, entry: PublicationPlanEntry): PublicationMode[] {
  return entry.modes ?? plan.defaults?.modes ?? ["baseline", "kairn_codex_session", "real_mcp_first"];
}

function matchesOnly(entry: PublicationPlanEntry, only: string | undefined): boolean {
  if (!only) return true;
  return entry.id === only || entry.kind === only || entry.repoId === only || entry.taskClass === only || entry.contextBehavior === only;
}

function entryById(entries: PublicationPlanEntry[], id: string): PublicationPlanEntry {
  const entry = entries.find((item) => item.id === id);
  if (!entry) throw new Error(`Missing publication entry ${id}`);
  return entry;
}

function resultQualityPassed(result: BenchmarkReport["results"][number]): boolean {
  return result.taskOutcome === "pass" && result.metadata.qualityGatePassed !== false;
}

function benchmarkReportMcpCalls(report: BenchmarkReport | undefined): number {
  return report?.results.reduce((total, result) => {
    return total + numberMetadata(result.metadata.actualMcpToolCalls ?? result.metadata.mcpToolCalls);
  }, 0) ?? 0;
}

function numberMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function repeatedFilesAvoidedForMode(report: BenchmarkEnduranceRepeatReport, mode: string): number {
  return report.runs.reduce((total, run) => {
    const modeReport = run.reports.find((item) => item.mode === mode);
    return total + (modeReport?.turns.reduce((sum, turn) => sum + turn.repeatedFilesAvoided, 0) ?? 0);
  }, 0);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
