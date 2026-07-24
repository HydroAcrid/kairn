import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KairnRuntime } from "../src/runtime/KairnRuntime.js";
import { BUNDLED_EVIDENCE_ARTIFACT } from "../src/retrieval/evidenceModel.js";
import { createFixtureRepo } from "./helpers.js";

describe("evidence ranker runtime integration", () => {
  it("seeds the bounded union from cheap full-inventory path terms", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-path-seed-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/content_map_page.go"), "package pages\n\nfunc Reconcile() {}\n", "utf8");
    for (let index = 0; index < 90; index += 1) {
      fs.writeFileSync(
        path.join(root, `docs/pages-content-${String(index).padStart(3, "0")}.md`),
        "Pages content map bug incorrect adjacent sections.\n",
        "utf8"
      );
    }
    const runtime = new KairnRuntime(root);

    try {
      const snapshot = await runtime.inspectEvidenceCandidates({
        query: "Bug: pages content map is incorrect for adjacent sections",
        limit: 64
      });
      expect(snapshot.candidates.map((candidate) => candidate.path)).toContain("src/content_map_page.go");
    } finally {
      runtime.close();
    }
  });

  it("exports bounded unlabeled feature snapshots through the serving candidate path", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root);

    try {
      const snapshot = await runtime.inspectEvidenceCandidates({
        query: "Fix the production formatUser implementation in src/user.ts",
        limit: 8
      });

      expect(snapshot.candidateLimit).toBe(8);
      expect(snapshot.candidates.length).toBeLessThanOrEqual(8);
      expect(snapshot.candidates[0]).toEqual(expect.objectContaining({
        path: "src/user.ts",
        reasons: expect.arrayContaining(["exact_path", "production_source"]),
        features: expect.objectContaining({ exactPath: 1, productionSource: 1 })
      }));
      expect(snapshot.candidates.every((candidate) => !("label" in candidate))).toBe(true);
      expect(snapshot.enrichedCandidates.length).toBeGreaterThanOrEqual(snapshot.candidates.length);
      expect(snapshot.enrichedCandidates.slice(0, snapshot.candidates.length)).toEqual(snapshot.candidates);
      expect(snapshot.enrichedCandidatePaths).toEqual(snapshot.enrichedCandidates.map((candidate) => candidate.path));
      expect(snapshot.enrichedCandidatePaths).toEqual(
        expect.arrayContaining(snapshot.initialCandidatePaths)
      );
    } finally {
      runtime.close();
    }
  });

  it("serves legacy order in shadow mode and exposes typed ranker metadata", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root, { ranker: { mode: "shadow" } });

    try {
      const { session } = await runtime.startTask("Fix src/app.ts renderDashboard production source");
      const response = await runtime.findContext({
        sessionId: session.id,
        query: "Fix src/app.ts renderDashboard production source"
      });

      expect(response.metadata?.ranker).toMatchObject({
        requestedMode: "shadow",
        servedMode: "shadow",
        modelId: "generic-evidence-v2"
      });
      expect(response.rankedFiles?.[0]).toEqual(expect.objectContaining({
        relevanceProbability: expect.any(Number),
        featureSchemaVersion: "evidence-features-v2",
        rankerMode: "shadow"
      }));

      const prime = await runtime.primeContext({
        task: "Fix src/app.ts renderDashboard production source",
        sessionId: session.id
      });
      expect(prime.metadata?.ranker).toMatchObject({
        requestedMode: "shadow",
        servedMode: "shadow",
        modelId: "generic-evidence-v2",
        featureSchemaVersion: "evidence-features-v2"
      });
    } finally {
      runtime.close();
    }
  });

  it("uses the bounded deterministic evidence policy in calibrated prime serving", async () => {
    const root = createFixtureRepo();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-valid-policy-model-"));
    const modelPath = path.join(temp, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(BUNDLED_EVIDENCE_ARTIFACT));
    const runtime = new KairnRuntime(root, { ranker: { mode: "calibrated", modelPath } });

    try {
      const { session } = await runtime.startTask("Fix src/app.ts renderDashboard production source");
      const prime = await runtime.primeContext({
        task: "Fix src/app.ts renderDashboard production source",
        sessionId: session.id
      });

      expect(prime.metadata?.ranker).toMatchObject({
        requestedMode: "calibrated",
        servedMode: "calibrated"
      });
      expect(prime.metadata?.calibratedEvidencePolicy).toMatchObject({
        source: "calibrated_evidence_policy_v1",
        contextDecision: { policySource: "calibrated_evidence_policy_v1" }
      });
      expect(prime.contextDecision?.policySource).toBe("calibrated_evidence_policy_v1");
      expect(prime.files.length).toBeLessThanOrEqual(3);
    } finally {
      runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("reemits calibrated shown evidence across a failed-verification/pass sequence", async () => {
    const root = createFixtureRepo();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-policy-sequence-model-"));
    const modelPath = path.join(temp, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(BUNDLED_EVIDENCE_ARTIFACT));
    const runtime = new KairnRuntime(root, { ranker: { mode: "calibrated", modelPath } });

    try {
      await runtime.init();
      const first = await runtime.primeContext({
        task: "Fix formatUser in the production implementation",
        budget: 900,
        source: "bench"
      });
      expect(first.files).toContain("src/user.ts");

      runtime.recordLedgerEvent({
        sessionId: first.session.id,
        kind: "verification_failed",
        filePath: "src/user.ts",
        source: "bench",
        summary: "Focused user-format verification failed."
      });
      const afterFailure = await runtime.primeContext({
        task: "Fix formatUser in the production implementation after the failed verification",
        sessionId: first.session.id,
        budget: 900,
        source: "bench"
      });
      const failedPolicy = afterFailure.metadata?.calibratedEvidencePolicy as { reasonCodes?: string[] } | undefined;
      expect(failedPolicy?.reasonCodes).toContain("failed_evidence_reconsidered");
      expect(afterFailure.files).toContain("src/user.ts");

      runtime.recordLedgerEvent({
        sessionId: first.session.id,
        kind: "verification_passed",
        filePath: "src/user.ts",
        source: "bench",
        summary: "Focused user-format verification passed."
      });
      const afterPass = await runtime.primeContext({
        task: "Verify formatUser in the production implementation after the passing check",
        sessionId: first.session.id,
        budget: 900,
        source: "bench"
      });
      const passingPolicy = afterPass.metadata?.calibratedEvidencePolicy as {
        reasonCodes?: string[];
        selections?: Array<{ path?: string }>;
      } | undefined;
      expect(passingPolicy?.reasonCodes).toContain("unchanged_evidence_suppressed");
      expect(passingPolicy?.reasonCodes).not.toContain("failed_evidence_reconsidered");
      expect(passingPolicy?.selections?.map((selection) => selection.path)).not.toContain("src/user.ts");
    } finally {
      runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs calibrated hybrid enrichment only over the bounded typed union", async () => {
    const root = createFixtureRepo();
    for (let index = 0; index < 170; index += 1) {
      const directory = path.join(root, "packages", `package-${String(index).padStart(3, "0")}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "shared.ts"), `export const value${index} = ${index};\n`);
    }
    const targetPath = "zz-target/shared.ts";
    fs.mkdirSync(path.join(root, "zz-target"), { recursive: true });
    fs.writeFileSync(path.join(root, targetPath), "export function repairShared() { return true; }\n");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-bounded-policy-model-"));
    const modelPath = path.join(temp, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(BUNDLED_EVIDENCE_ARTIFACT));
    const runtime = new KairnRuntime(root, { ranker: { mode: "calibrated", modelPath } });

    try {
      const { response } = await runtime.startTask(`Fix ${targetPath} in production source`);
      const generation = response.metadata?.candidateGeneration as {
        initialCandidates?: number;
        enrichedCandidates?: number;
        hybridScoredFiles?: number;
        initialLimit?: number;
        enrichedLimit?: number;
        graphHops?: number;
      } | undefined;

      expect(generation).toMatchObject({
        initialCandidates: 64,
        initialLimit: 64,
        enrichedLimit: 128,
        graphHops: 1
      });
      expect(generation?.enrichedCandidates).toBeLessThanOrEqual(128);
      expect(generation?.hybridScoredFiles).toBeLessThanOrEqual(128);
      expect(generation?.hybridScoredFiles).toBeLessThan(171);
      expect(response.rankedFiles?.map((file) => file.path)).toContain(targetPath);
    } finally {
      runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps a late quoted exact symbol in the bounded union despite more than 64 distractor symbols", async () => {
    const root = createFixtureRepo();
    const distractorNames = Array.from(
      { length: 80 },
      (_, index) => `commonTerm${String(index).padStart(3, "0")}`
    );
    fs.writeFileSync(
      path.join(root, "src", "symbol-noise.ts"),
      `${distractorNames.map((name) => `export function ${name}() { return true; }`).join("\n")}\n`
    );
    const targetPath = "src/critical-state.ts";
    fs.writeFileSync(
      path.join(root, targetPath),
      "export function resolveCriticalState() { return true; }\n"
    );
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-exact-symbol-model-"));
    const modelPath = path.join(temp, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(BUNDLED_EVIDENCE_ARTIFACT));
    const runtime = new KairnRuntime(root, { ranker: { mode: "calibrated", modelPath } });
    const query = `Investigate ${distractorNames.join(" ")} before repairing \`resolveCriticalState\` in production source`;

    try {
      const { response } = await runtime.startTask(query);
      const target = response.rankedFiles?.find((candidate) => candidate.path === targetPath);

      expect(target).toBeDefined();
      expect(target?.evidenceReasons).toContain("exact_symbol");
      expect((response.metadata?.candidateGeneration as { initialCandidates?: number } | undefined)?.initialCandidates)
        .toBeLessThanOrEqual(64);
    } finally {
      runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps invalid-artifact fallback evidence path-only in calibrated prime serving", async () => {
    const root = createFixtureRepo();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-policy-model-"));
    const modelPath = path.join(temp, "tampered.json");
    fs.writeFileSync(modelPath, JSON.stringify({
      ...BUNDLED_EVIDENCE_ARTIFACT,
      intercept: BUNDLED_EVIDENCE_ARTIFACT.intercept + 1
    }));
    const runtime = new KairnRuntime(root, { ranker: { mode: "calibrated", modelPath } });

    try {
      const { session } = await runtime.startTask("Debug src/app.ts:3 renderDashboard");
      const prime = await runtime.primeContext({
        task: "Debug src/app.ts:3 renderDashboard",
        sessionId: session.id
      });
      const policy = prime.metadata?.calibratedEvidencePolicy as {
        selections?: Array<{ delivery?: string }>;
      } | undefined;

      expect(prime.metadata?.ranker).toMatchObject({
        requestedMode: "calibrated",
        servedMode: "fallback"
      });
      expect(policy?.selections?.length).toBeGreaterThan(0);
      expect(policy?.selections?.every((selection) => selection.delivery === "path_hint")).toBe(true);
      expect(prime.content).not.toContain("return formatUser(name)");
    } finally {
      runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("preserves the calibrated request-evidence action when the local index is unavailable", async () => {
    const root = createFixtureRepo();
    const runtime = new KairnRuntime(root, { ranker: { mode: "calibrated" } });

    try {
      const prime = await runtime.primeContext({
        task: "Find the current production implementation",
        refreshIndex: false
      });

      expect(prime.quality?.action).toBe("request_evidence");
      expect(prime.contextDecision).toMatchObject({
        action: "request_evidence",
        policySource: "calibrated_evidence_policy_v1",
        recommendedDelivery: "evidence_request"
      });
      expect(prime.files).toEqual([]);
    } finally {
      runtime.close();
    }
  });
});
