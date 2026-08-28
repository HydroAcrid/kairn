import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeBenchmarkRun, registerRunArtifact, verifyRegisteredArtifacts } from "../src/bench/artifactLedger.js";
import { benchmarkInfrastructureEvidenceHash, runBenchmarkDoctor } from "../src/bench/benchmarkDoctor.js";
import { inspectBenchmarkCache, quarantineBenchmarkCacheFinding } from "../src/bench/cacheInspection.js";
import {
  benchmarkCachePolicy,
  enforceBenchmarkCacheRetention,
  inspectBenchmarkCacheRetention,
  leaseBenchmarkCacheEntry,
  registerBenchmarkCacheEntry,
  type BenchmarkCachePolicy
} from "../src/bench/cacheRetention.js";
import {
  assertStageDoesNotOpenHoldout,
  classifyBenchmarkRun,
  derivePipelineCacheKeys,
  loadBenchmarkCampaign
} from "../src/bench/campaign.js";
import { compareRankerEvaluations } from "../src/bench/rankerComparison.js";

describe("benchmark infrastructure contracts", () => {
  it("loads the pinned v0.2C campaign without opening holdout", () => {
    const campaign = loadBenchmarkCampaign("benchmarks/campaigns/v02c-infrastructure.json");
    expect(campaign.caseIds.train).toHaveLength(90);
    expect(campaign.caseIds.calibration).toHaveLength(45);
    expect(campaign.caseIds.holdout).toHaveLength(0);
    expect(campaign.artifacts.find((item) => item.kind === "holdout")?.allowedStages).toEqual(["holdout"]);
    expect(campaign.holdoutSafety.status).toBe("contaminated");
    expect(() => assertStageDoesNotOpenHoldout(campaign, "calibration")).not.toThrow();
    expect(() => assertStageDoesNotOpenHoldout(campaign, "holdout")).toThrow("contaminated");
  });

  it("loads the rankability campaign and keeps detached holdout inaccessible", () => {
    const campaign = loadBenchmarkCampaign("benchmarks/campaigns/v02c-rankability-audit.json");
    expect(campaign.campaign.source.branch).toBe("codex/v0.2c-rankability-audit");
    expect(campaign.artifacts.find((item) => item.id === "rankability-input")?.allowedStages).toEqual(["rankability"]);
    expect(campaign.artifacts.filter((item) => item.kind === "model")).toHaveLength(2);
    expect(() => assertStageDoesNotOpenHoldout(campaign, "rankability")).not.toThrow();
  });

  it("invalidates only cache layers downstream of a changed dependency", () => {
    const base = cacheInput();
    const first = derivePipelineCacheKeys(base);
    const reportingOnly = derivePipelineCacheKeys({ ...base });
    expect(reportingOnly).toEqual(first);
    const training = derivePipelineCacheKeys({ ...base, trainingConfigHash: "training-b" });
    expect(training.inventory).toBe(first.inventory);
    expect(training.embeddings).toBe(first.embeddings);
    expect(training.candidates).toBe(first.candidates);
    expect(training.model).not.toBe(first.model);
    const fusion = derivePipelineCacheKeys({ ...base, candidateGeneratorHash: "fusion-b" });
    expect(fusion.inventory).toBe(first.inventory);
    expect(fusion.embeddings).toBe(first.embeddings);
    expect(fusion.candidates).not.toBe(first.candidates);
    const documents = derivePipelineCacheKeys({ ...base, documentSchema: "documents-b" });
    expect(documents.inventory).toBe(first.inventory);
    expect(documents.embeddings).not.toBe(first.embeddings);
  });

  it("keeps infrastructure failures separate from valid negative results", () => {
    expect(classifyBenchmarkRun({ infrastructureValid: false, dataValid: true, qualityPassed: true, candidateDelta: 1, rankingDelta: 1, noninferiorityMargin: 0.02 }))
      .toBe("infrastructure_invalid");
    expect(classifyBenchmarkRun({ infrastructureValid: true, dataValid: false, qualityPassed: true, candidateDelta: 1, rankingDelta: 1, noninferiorityMargin: 0.02 }))
      .toBe("data_invalid");
    expect(classifyBenchmarkRun({ infrastructureValid: true, dataValid: true, qualityPassed: false, candidateDelta: 0, rankingDelta: -0.01, noninferiorityMargin: 0.02 }))
      .toBe("completed_negative");
    expect(classifyBenchmarkRun({ infrastructureValid: true, dataValid: true, qualityPassed: true, candidateDelta: 0, rankingDelta: 0, noninferiorityMargin: 0.02 }))
      .toBe("completed_noninferior");
  });

  it("keeps canonical infrastructure evidence stable across generated timestamps", () => {
    const fixture = writeFixtureCampaign({ leakLineage: false });
    const report = runBenchmarkDoctor({
      manifestPath: fixture.manifest,
      profile: "ranker",
      repositoryRoot: fixture.root,
      allowDirtyFixture: true,
      skipModelFiles: true,
      execute: fakeExecute
    });
    expect(benchmarkInfrastructureEvidenceHash({ ...report, generatedAt: "2026-08-27T00:00:00.000Z" }))
      .toBe(benchmarkInfrastructureEvidenceHash({ ...report, generatedAt: "2026-08-28T00:00:00.000Z" }));
  });

  it("reports the current v170 regression only on the identical v166 cohort", () => {
    const comparison = compareRankerEvaluations({
      baselinePath: "artifacts/ranker-calibration.semantic-v170-with-v166-candidate.json",
      candidatePath: "artifacts/ranker-calibration.semantic-v170-reviewed-probe512-candidate.json",
      infrastructureValid: true,
      campaignFingerprint: "a".repeat(64)
    });
    expect(comparison.data.caseCount).toBe(45);
    expect(comparison.deltas.recallAt5).toBeLessThan(0);
    expect(comparison.classification).toBe("completed_negative");
    expect(comparison.regressions.some((item) => item.startsWith("Recall@5 regressed"))).toBe(true);
  });

  it("rejects comparison reports from different candidate cohorts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-comparison-"));
    const baseline = evaluation("baseline", "a".repeat(64));
    const candidate = evaluation("candidate", "b".repeat(64));
    const left = path.join(root, "left.json"); const right = path.join(root, "right.json");
    fs.writeFileSync(left, JSON.stringify(baseline)); fs.writeFileSync(right, JSON.stringify(candidate));
    expect(() => compareRankerEvaluations({ baselinePath: left, candidatePath: right, infrastructureValid: true, campaignFingerprint: "c".repeat(64) }))
      .toThrow("same frozen cohort");
  });

  it("fails closed on corrupt campaign artifacts and split leakage", () => {
    const fixture = writeFixtureCampaign({ leakLineage: true });
    const report = runBenchmarkDoctor({
      manifestPath: fixture.manifest,
      profile: "ranker",
      repositoryRoot: fixture.root,
      allowDirtyFixture: true,
      skipModelFiles: true,
      execute: fakeExecute
    });
    expect(report.valid).toBe(false);
    expect(report.checks.find((item) => item.id === "data_isolation")?.detail).toContain("crosses");
    const parsed = JSON.parse(fs.readFileSync(fixture.manifest, "utf8")) as { artifacts: Array<{ id: string; sha256: string }> };
    parsed.artifacts.find((item) => item.id === "rows")!.sha256 = "f".repeat(64);
    fs.writeFileSync(fixture.manifest, JSON.stringify(parsed));
    expect(() => loadBenchmarkCampaign(fixture.manifest)).toThrow("hash mismatch");
  });

  it("keeps Docker, image pins, provider keys, and trajectory consent in the live-only preflight", () => {
    const fixture = writeFixtureCampaign({ leakLineage: false });
    const ranker = runBenchmarkDoctor({
      manifestPath: fixture.manifest, profile: "ranker", repositoryRoot: fixture.root,
      allowDirtyFixture: true, skipModelFiles: true, execute: fakeExecute
    });
    expect(ranker.checks.some((item) => item.id === "docker")).toBe(false);
    const live = runBenchmarkDoctor({
      manifestPath: fixture.manifest, profile: "live", repositoryRoot: fixture.root,
      allowDirtyFixture: true, skipModelFiles: true, execute: fakeExecute, environment: {}
    });
    expect(live.valid).toBe(false);
    expect(live.checks.filter((item) => ["docker", "docker_images", "anthropic", "reasonblocks", "trajectory_consent"].includes(item.id)).every((item) => item.status === "fail"))
      .toBe(true);
  });

  it("binds resume and registered artifacts to one campaign fingerprint", () => {
    const fixture = writeFixtureCampaign({ leakLineage: false });
    const initialized = initializeBenchmarkRun({
      manifestPath: fixture.manifest, stage: "tier_a", artifactsRoot: path.join(fixture.root, "artifacts", "runs"),
      runId: "fixture-run", sourceCommit: "a".repeat(40)
    });
    const output = path.join(initialized.runDirectory, "logs", "result.json");
    fs.writeFileSync(output, "{}\n");
    registerRunArtifact({
      runDirectory: initialized.runDirectory, runManifest: initialized.manifest, id: "result", filePath: output,
      schema: "fixture.v1", producer: ["fixture"], inputs: [], startedAt: new Date(0).toISOString()
    });
    expect(verifyRegisteredArtifacts(initialized.runDirectory).artifacts).toHaveLength(1);
    fs.writeFileSync(output, "changed\n");
    expect(() => verifyRegisteredArtifacts(initialized.runDirectory)).toThrow("missing or corrupt");
    expect(() => initializeBenchmarkRun({
      manifestPath: fixture.manifest, stage: "tier_a", artifactsRoot: path.join(fixture.root, "artifacts", "runs"),
      runId: "fixture-run", sourceCommit: "b".repeat(40)
    })).toThrow("resume mismatch");
  });

  it("quarantines only an explicitly selected recoverable cache finding", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-cache-"));
    fs.mkdirSync(path.join(root, "artifacts", "work"), { recursive: true });
    const partial = path.join(root, "artifacts", "work", "case.partial-1");
    fs.writeFileSync(partial, "partial");
    const findings = inspectBenchmarkCache(root);
    expect(findings).toHaveLength(1);
    const target = quarantineBenchmarkCacheFinding(root, findings[0]!);
    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
    expect(target).toContain("cache-quarantine");
  });

  it("detects incomplete and corrupt repository index snapshot pairs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-index-cache-"));
    const snapshots = path.join(root, "artifacts", "ranker-checkouts", "repository-index-snapshots");
    fs.mkdirSync(snapshots, { recursive: true });
    const orphanDatabase = path.join(snapshots, `${"a".repeat(64)}.sqlite`);
    fs.writeFileSync(orphanDatabase, "database");
    const corruptDatabase = path.join(snapshots, `${"b".repeat(64)}.sqlite`);
    fs.writeFileSync(corruptDatabase, "database");
    fs.writeFileSync(`${corruptDatabase}.manifest.json`, JSON.stringify({
      cacheKey: "b".repeat(64),
      databaseSha256: "0".repeat(64)
    }));
    const orphanManifest = path.join(snapshots, `${"c".repeat(64)}.sqlite.manifest.json`);
    fs.writeFileSync(orphanManifest, "{}");

    const findings = inspectBenchmarkCache(root);
    expect(findings.map((finding) => finding.path)).toEqual(expect.arrayContaining([
      path.relative(root, orphanDatabase).replace(/\\/g, "/"),
      path.relative(root, `${corruptDatabase}.manifest.json`).replace(/\\/g, "/"),
      path.relative(root, orphanManifest).replace(/\\/g, "/")
    ]));
  });

  it("uses a bounded eight-GiB cache policy by default", () => {
    const policy = benchmarkCachePolicy({});
    expect(policy).toMatchObject({
      schemaVersion: "benchmark-cache-policy.v1",
      maxBytes: 8 * 1024 ** 3,
      targetBytes: Math.floor(8 * 1024 ** 3 * 0.8),
      warningBytes: Math.floor(8 * 1024 ** 3 * 0.8)
    });
  });

  it("evicts least-recently-used entries to the low-water mark", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-cache-lru-"));
    const policy: BenchmarkCachePolicy = {
      schemaVersion: "benchmark-cache-policy.v1",
      maxBytes: 60_000,
      targetBytes: 40_000,
      warningBytes: 40_000,
      minimumFreeBytes: 1
    };
    try {
      const files = ["old.bin", "middle.bin", "new.bin"].map((name) => path.join(root, name));
      for (const target of files) fs.writeFileSync(target, Buffer.alloc(20_000));
      registerBenchmarkCacheEntry(root, { id: "old", kind: "repository", paths: [files[0]!] }, new Date(1_000));
      registerBenchmarkCacheEntry(root, { id: "middle", kind: "repository", paths: [files[1]!] }, new Date(2_000));
      registerBenchmarkCacheEntry(root, { id: "new", kind: "repository", paths: [files[2]!] }, new Date(3_000));

      const result = enforceBenchmarkCacheRetention(root, { policy, now: new Date(4_000) });
      expect(result.evictions.map((item) => item.id)).toEqual(["old", "middle"]);
      expect(fs.existsSync(files[0]!)).toBe(false);
      expect(fs.existsSync(files[1]!)).toBe(false);
      expect(fs.existsSync(files[2]!)).toBe(true);
      expect(result.status.totalBytes).toBeLessThanOrEqual(policy.maxBytes);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never evicts an actively leased cache entry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-cache-lease-"));
    const policy: BenchmarkCachePolicy = {
      schemaVersion: "benchmark-cache-policy.v1",
      maxBytes: 50_000,
      targetBytes: 30_000,
      warningBytes: 30_000,
      minimumFreeBytes: 1
    };
    try {
      const protectedPath = path.join(root, "protected.bin");
      const disposablePath = path.join(root, "disposable.bin");
      fs.writeFileSync(protectedPath, Buffer.alloc(20_000));
      fs.writeFileSync(disposablePath, Buffer.alloc(30_000));
      registerBenchmarkCacheEntry(root, { id: "protected", kind: "repository", paths: [protectedPath] }, new Date(1_000));
      registerBenchmarkCacheEntry(root, { id: "disposable", kind: "repository", paths: [disposablePath] }, new Date(2_000));
      const lease = leaseBenchmarkCacheEntry(root, "protected", 60_000, new Date(3_000));

      const result = enforceBenchmarkCacheRetention(root, { policy, now: new Date(4_000) });
      expect(result.evictions.map((item) => item.id)).toContain("disposable");
      expect(fs.existsSync(protectedPath)).toBe(true);
      expect(fs.existsSync(disposablePath)).toBe(false);
      expect(inspectBenchmarkCacheRetention(root, policy, new Date(4_000)).protectedBytes).toBeGreaterThan(0);
      lease.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts legacy snapshot pairs into the bounded ledger", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-cache-legacy-"));
    const snapshots = path.join(root, "repository-index-snapshots");
    fs.mkdirSync(snapshots, { recursive: true });
    const key = "a".repeat(64);
    const database = path.join(snapshots, `${key}.sqlite`);
    const bytes = Buffer.from("legacy repository index");
    fs.writeFileSync(database, bytes);
    fs.writeFileSync(`${database}.manifest.json`, JSON.stringify({
      formatVersion: 1,
      cacheKey: key,
      sourceRootPath: "/old/root",
      databaseSha256: crypto.createHash("sha256").update(bytes).digest("hex")
    }));
    try {
      const status = inspectBenchmarkCacheRetention(root, {
        schemaVersion: "benchmark-cache-policy.v1",
        maxBytes: 1_000_000,
        targetBytes: 800_000,
        warningBytes: 800_000,
        minimumFreeBytes: 1
      });
      expect(status.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: `repository_index_snapshot:${key}`,
          kind: "repository_index_snapshot"
        })
      ]));
      expect(fs.existsSync(path.join(root, "cache-ledger.v1.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps repeated cache writes bounded instead of growing with case count", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-cache-bounded-growth-"));
    const policy: BenchmarkCachePolicy = {
      schemaVersion: "benchmark-cache-policy.v1",
      maxBytes: 180_000,
      targetBytes: 120_000,
      warningBytes: 120_000,
      minimumFreeBytes: 1
    };
    try {
      for (let index = 0; index < 50; index += 1) {
        const target = path.join(root, `${String(index).padStart(3, "0")}.bin`);
        fs.writeFileSync(target, Buffer.alloc(16_000, index));
        registerBenchmarkCacheEntry(root, {
          id: `case:${String(index).padStart(3, "0")}`,
          kind: "semantic_embedding_snapshot",
          paths: [target]
        }, new Date(index * 1_000));
        enforceBenchmarkCacheRetention(root, { policy, now: new Date(index * 1_000 + 1) });
      }
      const status = inspectBenchmarkCacheRetention(root, policy, new Date(60_000));
      expect(status.totalBytes).toBeLessThanOrEqual(policy.maxBytes);
      expect(status.entryCount).toBeLessThan(50);
      expect(fs.existsSync(path.join(root, "049.bin"))).toBe(true);
      expect(fs.existsSync(path.join(root, "000.bin"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function cacheInput() {
  return {
    repositoryCommit: "repo", parserSchema: "parser", documentSchema: "documents",
    semanticModelManifest: "model", tokenizerHash: "tokenizer", candidateGeneratorHash: "fusion",
    candidateConfigHash: "config", reviewHash: "reviews", featureSchemaHash: "features", trainingConfigHash: "training"
  };
}

function evaluation(modelId: string, manifestHash: string) {
  return {
    schemaVersion: "ranker-probe-evaluation.v1", evaluationSplit: "calibration", referenceKind: "required_source",
    model: { id: modelId, featureSchemaVersion: "v" },
    inputs: { manifest: { sha256: manifestHash }, report: { sha256: "c".repeat(64) } }, targetCaseCount: 1,
    metrics: {
      currentStrictFullRecallAt128: 1, rankedStrictFullRecallAt64: 1, rankedRequiredFileRecallAt5: 1,
      rankedRequiredFileMrr: 1, expectedCalibrationError: 0, generatedVendorTopOneViolations: []
    }, cases: [{ id: "case" }]
  };
}

function writeFixtureCampaign(options: { leakLineage: boolean }): { root: string; manifest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-campaign-"));
  fs.mkdirSync(path.join(root, ".git")); fs.mkdirSync(path.join(root, "node_modules", "tsx"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "vitest")); fs.mkdirSync(path.join(root, "node_modules", "onnxruntime-web"));
  fs.mkdirSync(path.join(root, "benchmarks")); fs.mkdirSync(path.join(root, "artifacts"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const rows = [
    { caseGroupId: "train-a", split: "train", repositoryLineageId: "lineage-a" },
    { caseGroupId: "cal-a", split: "calibration", repositoryLineageId: options.leakLineage ? "lineage-a" : "lineage-b" }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  const rowsPath = path.join(root, "artifacts", "rows.jsonl"); const holdoutPath = path.join(root, "artifacts", "holdout.json");
  fs.writeFileSync(rowsPath, rows); fs.writeFileSync(holdoutPath, JSON.stringify({ cases: [] }));
  const manifest = path.join(root, "benchmarks", "campaign.json");
  fs.writeFileSync(manifest, JSON.stringify({
    schemaVersion: "benchmark-campaign.v1", campaignId: "fixture-campaign", nonEvidence: true,
    source: { branch: "fixture", baseCommit: "a".repeat(40) },
    runtime: { nodeMajor: 24, pnpm: "10.31.0", python: "3.12" },
    semantic: { modelId: "jina-code-v2-q8", upstreamRevision: "516f4baf13dec4ddddda8631e019b5737c8bc250", documentSchemaVersion: "semantic-documents-v5", candidateLimit: 64, enrichedCandidateLimit: 128 },
    cases: { artifactId: "rows", expectedCounts: { train: 1, calibration: 1, holdout: 0 }, splitField: "split", idField: "caseGroupId", format: "jsonl_rows" },
    holdout: { status: "sealed_detached", artifactId: "holdout", openedEvaluationId: null },
    artifacts: [
      { id: "rows", kind: "training_rows", path: "artifacts/rows.jsonl", sha256: digest(rowsPath), parents: [], allowedStages: ["tier_a", "calibration"] },
      { id: "holdout", kind: "holdout", path: "artifacts/holdout.json", sha256: digest(holdoutPath), parents: [], allowedStages: ["holdout"] }
    ],
    gates: { boundedPoolRequiredSourceMissesAt128: 0, servedRecallAt64Overall: 0.99, servedRecallAt64PerLanguage: 0.95, expectedCalibrationErrorMax: 0.05, generatedVendorTopOneMax: 0 }
  }));
  return { root, manifest };
}

function fakeExecute(command: string, args: string[]): string {
  if (command === "pnpm") return "10.31.0\n";
  if (command === "python3") return "Python 3.12.7\n";
  if (command === "git" && args[0] === "branch") return "fixture\n";
  if (command === "git" && args[0] === "status") return " M fixture\n";
  if (command === "git" && args[0] === "rev-parse" && args.includes("@{u}")) return "origin/fixture\n";
  if (command === "git" && args[0] === "rev-list") return "0\t0\n";
  return "";
}
function digest(filePath: string): string { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
