import { describe, expect, it } from "vitest";
import {
  CALIBRATED_EVIDENCE_POLICY_SOURCE,
  decideCalibratedEvidencePolicy
} from "../src/prime/calibratedEvidencePolicy.js";
import { buildSessionWorkingSet } from "../src/ledger/workingSet.js";
import type {
  ContextRankedFile,
  EvidenceRankerStatus,
  FileKind,
  FileRecord,
  SessionLedgerEvent
} from "../src/types.js";

describe("calibrated evidence policy", () => {
  it("delivers one intent-compatible primary plus at most two bounded companions", () => {
    const files = [
      file("src/service.ts", "source"),
      file("src/helper.ts", "source"),
      file("tests/service.test.ts", "test"),
      file("docs/service.md", "doc"),
      file("generated/service.ts", "source")
    ];
    const decision = decideCalibratedEvidencePolicy({
      task: "Fix the production source implementation",
      rankedFiles: [
        ranked("docs/service.md", "doc", 0.99, "content", ["role_match"]),
        ranked("generated/service.ts", "source", 0.98, "content", ["generated_vendor"]),
        ranked("src/service.ts", "source", 0.91, "content", ["exact_symbol", "production_source", "role_match"]),
        ranked("src/helper.ts", "source", 0.82, "content", ["graph_neighbor", "production_source"]),
        ranked("tests/service.test.ts", "test", 0.76, "path_hint", ["source_test_pair"])
      ],
      knownFiles: files,
      ranker: calibratedStatus(),
      budget: 900,
      indexMissing: false,
      indexStale: false
    });

    expect(decision.source).toBe(CALIBRATED_EVIDENCE_POLICY_SOURCE);
    expect(decision.primaryFile).toBe("src/service.ts");
    expect(decision.selections.map((selection) => selection.path)).toEqual([
      "src/service.ts",
      "src/helper.ts",
      "tests/service.test.ts"
    ]);
    expect(decision.selections).toHaveLength(3);
    expect(decision.action).toBe("emit");
    expect(decision.contextDecision.policySource).toBe(CALIBRATED_EVIDENCE_POLICY_SOURCE);
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "generated_vendor_blocked",
      "intent_role_filtered",
      "bounded_companions"
    ]));
  });

  it("suppresses unchanged repeated evidence but refreshes it after an edit", () => {
    const record = file("src/worker.go", "source");
    const rankedFile = ranked(
      record.path,
      record.kind,
      0.9,
      "content",
      ["exact_symbol", "production_source", "already_delivered"]
    );
    const base = {
      task: "Fix the production worker implementation",
      rankedFiles: [rankedFile],
      knownFiles: [record],
      ranker: calibratedStatus(),
      budget: 800,
      indexMissing: false,
      indexStale: false,
      shownFiles: [record.path]
    };

    const unchanged = decideCalibratedEvidencePolicy(base);
    expect(unchanged.action).toBe("suppress");
    expect(unchanged.selections).toEqual([]);
    expect(unchanged.reasonCodes).toContain("unchanged_evidence_suppressed");

    const changed = decideCalibratedEvidencePolicy({ ...base, changedFiles: [record.path] });
    expect(changed.action).toBe("emit");
    expect(changed.selections[0]).toMatchObject({ path: record.path, delivery: "content" });
    expect(changed.reasonCodes).toContain("changed_evidence_refreshed");
  });

  it("reconsiders shown unchanged evidence after a failed verification, then suppresses it after a later pass", () => {
    const record = file("src/worker.go", "source");
    const shown = ledgerEvent("context_shown", record.path, "2026-07-22T10:00:00.000Z");
    const failed = ledgerEvent("verification_failed", undefined, "2026-07-22T10:01:00.000Z");
    const failureState = buildSessionWorkingSet({
      sessionId: "task_sequence",
      events: [shown, failed],
      currentPhase: "verification"
    });

    const reconsidered = repeatedEvidenceDecision(record, failureState);
    expect(failureState.unresolvedFailure).toBe(true);
    expect(failureState.reconsiderableShownFiles).toEqual([record.path]);
    expect(reconsidered.action).toBe("emit");
    expect(reconsidered.selections[0]).toMatchObject({ path: record.path, delivery: "content" });
    expect(reconsidered.reasonCodes).toContain("failed_evidence_reconsidered");

    const passingState = buildSessionWorkingSet({
      sessionId: "task_sequence",
      events: [shown, failed, ledgerEvent("verification_passed", record.path, "2026-07-22T10:02:00.000Z")],
      currentPhase: "verification"
    });
    const suppressed = repeatedEvidenceDecision(record, passingState);
    expect(passingState.unresolvedFailure).toBe(false);
    expect(passingState.reconsiderableShownFiles).toEqual([]);
    expect(suppressed.action).toBe("suppress");
    expect(suppressed.reasonCodes).toContain("unchanged_evidence_suppressed");
  });

  it("uses ledger order when a failure follows a pass at the same timestamp", () => {
    const record = file("src/handler.py", "source");
    const timestamp = "2026-07-22T10:00:00.000Z";
    const state = buildSessionWorkingSet({
      sessionId: "task_same_timestamp",
      events: [
        ledgerEvent("context_shown", record.path, timestamp),
        ledgerEvent("verification_passed", record.path, timestamp),
        ledgerEvent("failure_seen", record.path, timestamp)
      ],
      currentPhase: "debugging"
    });

    expect(state.unresolvedFailure).toBe(true);
    expect(repeatedEvidenceDecision(record, state).reasonCodes).toContain("failed_evidence_reconsidered");
  });

  it("fails closed to hard-evidence path hints when the model artifact is invalid", () => {
    const source = file("src/handler.py", "source");
    const lexical = file("src/other.py", "source");
    const decision = decideCalibratedEvidencePolicy({
      task: "Debug src/handler.py:42",
      rankedFiles: [
        ranked(source.path, source.kind, 0.99, "content", ["failure_reference", "exact_path", "production_source"]),
        ranked(lexical.path, lexical.kind, 0.98, "content", ["lexical", "production_source"])
      ],
      knownFiles: [source, lexical],
      ranker: {
        ...calibratedStatus(),
        servedMode: "fallback",
        modelId: "deterministic-evidence-fallback-v1",
        fallbackReason: "checksum mismatch"
      },
      budget: 1200,
      indexMissing: false,
      indexStale: false
    });

    expect(decision.selections).toEqual([
      expect.objectContaining({ path: source.path, delivery: "path_hint" })
    ]);
    expect(decision.action).toBe("shrink");
    expect(decision.reasonCodes).toContain("invalid_ranker_fallback");
  });

  it("downgrades content under a tight budget and requests evidence for missing state", () => {
    const source = file("src/main.java", "source");
    const tight = decideCalibratedEvidencePolicy({
      task: "Fix the production source",
      rankedFiles: [ranked(source.path, source.kind, 0.92, "content", ["production_source", "role_match"])],
      knownFiles: [source],
      ranker: calibratedStatus(),
      budget: 200,
      indexMissing: false,
      indexStale: false
    });
    expect(tight.selections[0]?.delivery).toBe("path_hint");
    expect(tight.reasonCodes).toContain("content_downgraded_for_budget");

    const missing = decideCalibratedEvidencePolicy({
      task: "Find the implementation",
      rankedFiles: [],
      knownFiles: [],
      ranker: calibratedStatus(),
      budget: 800,
      indexMissing: true,
      indexStale: false
    });
    expect(missing.action).toBe("request_evidence");
    expect(missing.contextDecision.recommendedDelivery).toBe("evidence_request");
  });
});

function file(filePath: string, kind: FileKind): FileRecord {
  return {
    rootPath: "/repo",
    path: filePath,
    language: filePath.split(".").pop() ?? "unknown",
    kind,
    size: 1200,
    hash: `${filePath}-hash`,
    importance: 40,
    updatedAt: "2026-07-22T00:00:00.000Z"
  };
}

function ranked(
  filePath: string,
  kind: FileKind,
  probability: number,
  delivery: "content" | "path_hint",
  evidenceReasons: NonNullable<ContextRankedFile["evidenceReasons"]>
): ContextRankedFile {
  return {
    path: filePath,
    kind,
    score: Math.round(probability * 1000),
    reasons: [],
    relevanceProbability: probability,
    probabilityGap: 0.1,
    rankerModelId: "test-model",
    featureSchemaVersion: "evidence-features-v1",
    evidenceReasons,
    delivery,
    rankerMode: "calibrated"
  };
}

function calibratedStatus(): EvidenceRankerStatus {
  return {
    requestedMode: "calibrated",
    servedMode: "calibrated",
    modelId: "test-model",
    featureSchemaVersion: "evidence-features-v1"
  };
}

function ledgerEvent(
  kind: SessionLedgerEvent["kind"],
  filePath: string | undefined,
  createdAt: string
): SessionLedgerEvent {
  return {
    sessionId: "task_sequence",
    kind,
    ...(filePath ? { filePath } : {}),
    contentHash: `${kind}-hash`,
    tokenEstimate: 0,
    source: "bench",
    summary: kind,
    metadata: {},
    createdAt
  };
}

function repeatedEvidenceDecision(
  record: FileRecord,
  state: ReturnType<typeof buildSessionWorkingSet>
) {
  return decideCalibratedEvidencePolicy({
    task: "Fix the production implementation after verification",
    rankedFiles: [ranked(record.path, record.kind, 0.9, "content", [
      "exact_symbol",
      "production_source",
      "already_delivered"
    ])],
    knownFiles: [record],
    ranker: calibratedStatus(),
    budget: 800,
    indexMissing: false,
    indexStale: false,
    shownFiles: [record.path],
    sessionState: {
      unresolvedFailure: state.unresolvedFailure,
      reconsiderShownFiles: state.reconsiderableShownFiles
    }
  });
}
