import { describe, expect, it } from "vitest";
import { hybridSearch } from "../src/retrieval/hybridRetrieval.js";
import { decideResponse } from "../src/retrieval/responseRouter.js";
import { embedText, cosineSimilarity } from "../src/semantic/vector.js";
import { indexRepo } from "../src/indexer/indexRepo.js";
import type { FileRecord, GraphEdgeRecord, SemanticChunkRecord, SemanticVectorRecord, SymbolRecord } from "../src/types.js";
import { createFixtureRepo } from "./helpers.js";

describe("semantic indexing", () => {
  it("creates symbol-aware chunks and file summary chunks", async () => {
    const root = createFixtureRepo();
    const index = await indexRepo(root);

    expect(index.semanticChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/app.ts",
          kind: "symbol",
          symbol: "renderDashboard"
        }),
        expect.objectContaining({
          filePath: "app/dashboard/DashboardCard.tsx",
          kind: "symbol",
          symbol: "DashboardCard"
        }),
        expect.objectContaining({
          filePath: "package.json",
          kind: "file_summary"
        })
      ])
    );
    expect(index.semanticChunks.every((chunk) => chunk.tokenEstimate <= 2100)).toBe(true);
    expect(index.semanticVectors).toHaveLength(index.semanticChunks.length);
  });
});

describe("lexical vectors", () => {
  it("produces deterministic vectors and matches camelCase terms", () => {
    const first = embedText("DashboardMetrics renders pipeline health");
    const second = embedText("DashboardMetrics renders pipeline health");
    const related = embedText("dashboard metrics pipeline");
    const unrelated = embedText("oauth token storage");

    expect(first).toEqual(second);
    expect(cosineSimilarity(first, related)).toBeGreaterThan(cosineSimilarity(first, unrelated));
  });

  it("handles empty queries", () => {
    expect(embedText("")).toEqual(Array.from({ length: 256 }, () => 0));
  });
});

describe("hybridSearch", () => {
  it("finds semantically relevant files even when the path and symbols do not match the query", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/view.ts", "source"),
      file(rootPath, "src/oauth.ts", "source")
    ];
    const chunks = [
      chunk(rootPath, "src/view.ts", "BillingPortal", "export function BillingPortal() { return 'payment invoices receipts'; }"),
      chunk(rootPath, "src/oauth.ts", "TokenStore", "export function TokenStore() { return 'refresh token oauth'; }")
    ];
    const vectors = chunks.map((record) => vector(rootPath, record));
    const results = hybridSearch({
      files,
      query: "payment invoices",
      symbols: [],
      chunks,
      vectors,
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("src/view.ts");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["semantic match: BillingPortal"]));
  });

  it("adds graph and git reasons when nearby files are relevant", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/app.ts", "source"),
      file(rootPath, "src/app.test.ts", "test")
    ];
    const symbols = [symbol(rootPath, "src/app.ts", "renderDashboard")];
    const edges: GraphEdgeRecord[] = [
      {
        rootPath,
        fromFile: "src/app.ts",
        toFile: "src/app.test.ts",
        type: "tested_by",
        metadata: {}
      }
    ];
    const results = hybridSearch({
      files,
      query: "render dashboard tests",
      symbols,
      chunks: [],
      vectors: [],
      edges,
      changedFiles: new Set(["src/app.test.ts"])
    });

    const testResult = results.find((result) => result.path === "src/app.test.ts");
    expect(testResult?.reasons).toEqual(expect.arrayContaining(["graph neighbor", "changed in diff"]));
  });

  it("prioritizes UI files for mobile layout intent over broad job-domain backend files", () => {
    const fixture = jobTrackerFixture();
    const results = hybridSearch({
      ...fixture,
      query: "job tracker mobile layout",
      changedFiles: new Set()
    });

    expect(results.slice(0, 3).map((result) => result.path)).toEqual(
      expect.arrayContaining([
        "src/app/private/jobs/JobsApplicationsTable.tsx",
        "src/app/private/jobs/JobsDashboardTabs.tsx"
      ])
    );
    expect(results[0]?.intentScore).toBeGreaterThan(0);
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["ui intent file"]));
    const uiIndex = results.findIndex((result) => result.path === "src/app/private/jobs/JobsApplicationsTable.tsx");
    const parserIndex = results.findIndex((result) => result.path === "src/lib/jobs/parser.ts");
    expect(parserIndex === -1 || uiIndex < parserIndex).toBe(true);
  });

  it("keeps backend files first for parser and Gmail intent", () => {
    const fixture = jobTrackerFixture();
    const results = hybridSearch({
      ...fixture,
      query: "gmail job parser rental application",
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("src/lib/jobs/parser.ts");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["backend intent file"]));
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["backend filename intent match"]));
  });

  it("keeps data/access files first for owner scoping API intent", () => {
    const fixture = jobTrackerFixture();
    const results = hybridSearch({
      ...fixture,
      query: "job tracker owner scoping api",
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path)).toContain("src/lib/jobs/access.ts");
    expect(results.slice(0, 3).map((result) => result.path)).toContain("src/lib/jobs/repository.ts");
  });

  it("prioritizes workflow review queue surfaces over broad Gmail sync files", () => {
    const fixture = jobTrackerFixture();
    const results = hybridSearch({
      ...fixture,
      query: "gmail_job_sync_attempts sync attempts review queue retry ignore add to tracker needs_review requeued",
      changedFiles: new Set()
    });
    const topFive = results.slice(0, 5).map((result) => result.path);

    expect(topFive).toEqual(
      expect.arrayContaining([
        "src/app/private/jobs/JobsReviewPanel.tsx",
        "src/app/api/jobs/sync-attempts/route.ts",
        "src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts",
        "src/lib/jobs/repository.ts"
      ])
    );
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["workflow intent file"]));
    expect(results[0]?.reasons.some((reason) => reason.includes("workflow"))).toBe(true);
    const lastExpectedIndex = Math.max(
      ...[
        "src/app/private/jobs/JobsReviewPanel.tsx",
        "src/app/api/jobs/sync-attempts/route.ts",
        "src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts",
        "src/lib/jobs/repository.ts"
      ].map((filePath) => results.findIndex((result) => result.path === filePath))
    );
    for (const noisyFile of [
      "src/lib/jobs/gmail.ts",
      "src/lib/jobs/types.ts",
      "src/lib/jobs/parser.ts",
      "supabase/migrations/20260502000000_job_tracker_resumable_sync_attempts.sql"
    ]) {
      const noisyIndex = results.findIndex((result) => result.path === noisyFile);
      expect(noisyIndex === -1 || noisyIndex > lastExpectedIndex).toBe(true);
    }
  });

  it("boosts tests only when tests are requested", () => {
    const fixture = jobTrackerFixture();
    const results = hybridSearch({
      ...fixture,
      query: "job tracker tests",
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("src/app/private/jobs/JobsApplicationsTable.test.tsx");
    expect(results.slice(0, 5).map((result) => result.path)).toContain("src/app/private/jobs/JobsApplicationsTable.tsx");
  });

  it("does not treat product verification domain queries as test intent", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "domains/verification/service.ts", "source"),
      file(rootPath, "workers/verification/worker.ts", "source"),
      file(rootPath, "domains/verification/service.test.ts", "test")
    ];
    const chunks = [
      chunk(rootPath, "domains/verification/service.ts", "VerificationService", "verification worker queue retry metrics service"),
      chunk(rootPath, "workers/verification/worker.ts", "VerificationWorker", "worker queue retry metrics"),
      chunk(rootPath, "domains/verification/service.test.ts", "VerificationServiceTest", "test verification service")
    ];
    const results = hybridSearch({
      files,
      query: "verification worker queue retry metrics",
      symbols: [],
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.kind).not.toBe("test");
    expect(results.slice(0, 2).map((result) => result.path)).toEqual(
      expect.arrayContaining(["domains/verification/service.ts", "workers/verification/worker.ts"])
    );
  });

  it("detects game UI component intent for wheel and settings queries", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "components/punishment/PunishmentWheel.tsx", "component"),
      file(rootPath, "components/ChallengeSettingsCard.tsx", "component"),
      file(rootPath, "components/OwnerSettingsModal.tsx", "component"),
      file(rootPath, "lib/punishment/repository.ts", "source")
    ];
    const chunks = [
      chunk(rootPath, "components/punishment/PunishmentWheel.tsx", "PunishmentWheel", "punishment wheel roulette UI component"),
      chunk(rootPath, "components/ChallengeSettingsCard.tsx", "ChallengeSettingsCard", "challenge settings card UI"),
      chunk(rootPath, "components/OwnerSettingsModal.tsx", "OwnerSettingsModal", "owner settings modal"),
      chunk(rootPath, "lib/punishment/repository.ts", "PunishmentRepository", "punishment data repository")
    ];
    const results = hybridSearch({
      files,
      query: "punishment wheel challenge settings",
      symbols: [],
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path)).toEqual(
      expect.arrayContaining(["components/punishment/PunishmentWheel.tsx", "components/ChallengeSettingsCard.tsx"])
    );
  });

  it("caps broad domain terms so job alone does not dominate scoring", () => {
    const fixture = jobTrackerFixture();
    const results = hybridSearch({
      ...fixture,
      query: "job",
      changedFiles: new Set()
    });

    expect(results[0]?.keywordScore).toBeLessThan(15);
    expect(results[0]?.reasons.some((reason) => reason.includes("broad"))).toBe(true);
  });
});

describe("decideResponse", () => {
  it("routes explicit and discovery requests", () => {
    expect(decideResponse({ requestType: "file" }).mode).toBe("exact_code");
    expect(decideResponse({ requestType: "find_context", explicitMode: "summary" }).mode).toBe(
      "compressed_summary"
    );
    expect(decideResponse({ requestType: "find_context", query: "auth", budget: 600 }).mode).toBe("snippets");
  });

  it("warns for repeated and low-confidence context", () => {
    const decision = decideResponse({
      requestType: "find_context",
      query: "unknown",
      topScore: 4,
      repeatedFiles: 1,
      graphAvailable: false
    });

    expect(decision.warnings).toEqual(
      expect.arrayContaining([
        "Some top results were already shown in this session.",
        "No graph edges are available yet; related context is using lexical retrieval only.",
        "Retrieval confidence is low. Use a more specific file, symbol, or task query."
      ])
    );
  });
});

function file(rootPath: string, filePath: string, kind: FileRecord["kind"]): FileRecord {
  return {
    rootPath,
    path: filePath,
    language: "typescript",
    kind,
    size: 100,
    hash: filePath,
    importance: 4,
    updatedAt: "2026-05-05T00:00:00.000Z"
  };
}

function symbol(rootPath: string, filePath: string, name: string): SymbolRecord {
  return {
    rootPath,
    filePath,
    name,
    kind: "function",
    exported: true,
    startLine: 1,
    endLine: 3,
    signature: `export function ${name}()`
  };
}

function chunk(rootPath: string, filePath: string, symbolName: string, text: string): SemanticChunkRecord {
  return {
    rootPath,
    id: `${filePath}:${symbolName}`,
    filePath,
    kind: "symbol",
    symbol: symbolName,
    startLine: 1,
    endLine: 1,
    text: [`file: ${filePath}`, `symbol: ${symbolName}`, text].join("\n"),
    hash: `${filePath}:${symbolName}`,
    tokenEstimate: 20
  };
}

function vector(rootPath: string, record: SemanticChunkRecord): SemanticVectorRecord {
  return {
    rootPath,
    chunkId: record.id,
    dimensions: 256,
    vector: embedText(record.text)
  };
}

function jobTrackerFixture(): {
  files: FileRecord[];
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  vectors: SemanticVectorRecord[];
  edges: GraphEdgeRecord[];
} {
  const rootPath = "/repo";
  const files = [
    file(rootPath, "src/app/private/jobs/JobsApplicationsTable.tsx", "component"),
    file(rootPath, "src/app/private/jobs/JobsDashboardTabs.tsx", "component"),
    file(rootPath, "src/app/private/jobs/JobsReviewPanel.tsx", "component"),
    file(rootPath, "src/app/api/jobs/sync-attempts/route.ts", "route"),
    file(rootPath, "src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts", "route"),
    file(rootPath, "src/app/private/jobs/JobsApplicationsTable.test.tsx", "test"),
    file(rootPath, "src/lib/jobs/types.ts", "source"),
    file(rootPath, "src/lib/jobs/gmail.ts", "source"),
    file(rootPath, "src/lib/jobs/parser.ts", "source"),
    file(rootPath, "src/lib/jobs/repository.ts", "source"),
    file(rootPath, "src/lib/jobs/ingest.ts", "source"),
    file(rootPath, "src/lib/jobs/access.ts", "source"),
    file(rootPath, "supabase/migrations/20260502000000_job_tracker_resumable_sync_attempts.sql", "schema")
  ];
  const symbols = [
    symbol(rootPath, "src/app/private/jobs/JobsApplicationsTable.tsx", "JobsApplicationsTable"),
    symbol(rootPath, "src/app/private/jobs/JobsApplicationsTable.tsx", "mobileDetailAppId"),
    symbol(rootPath, "src/app/private/jobs/JobsApplicationsTable.tsx", "mobileFiltersOpen"),
    symbol(rootPath, "src/app/private/jobs/JobsDashboardTabs.tsx", "JobsDashboardTabs"),
    symbol(rootPath, "src/app/private/jobs/JobsDashboardTabs.tsx", "mobileBottomTabs"),
    symbol(rootPath, "src/app/private/jobs/JobsReviewPanel.tsx", "JobsReviewPanel"),
    symbol(rootPath, "src/app/api/jobs/sync-attempts/route.ts", "GET"),
    symbol(rootPath, "src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts", "PATCH"),
    symbol(rootPath, "src/lib/jobs/types.ts", "JobStatus"),
    symbol(rootPath, "src/lib/jobs/types.ts", "GmailJobSyncAttemptStatus"),
    symbol(rootPath, "src/lib/jobs/gmail.ts", "listGmailMessages"),
    symbol(rootPath, "src/lib/jobs/parser.ts", "parseJobEmailRules"),
    symbol(rootPath, "src/lib/jobs/parser.ts", "NON_JOB_APPLICATION_PHRASES"),
    symbol(rootPath, "src/lib/jobs/repository.ts", "getJobDashboardData"),
    symbol(rootPath, "src/lib/jobs/repository.ts", "applyJobApplicationFilters"),
    symbol(rootPath, "src/lib/jobs/repository.ts", "listGmailJobSyncAttempts"),
    symbol(rootPath, "src/lib/jobs/repository.ts", "updateGmailJobSyncAttempt"),
    symbol(rootPath, "src/lib/jobs/ingest.ts", "ingestJobsFromGmail"),
    symbol(rootPath, "src/lib/jobs/access.ts", "resolveJobsAccess")
  ];
  const chunks = [
    chunk(
      rootPath,
      "src/app/private/jobs/JobsApplicationsTable.tsx",
      "JobsApplicationsTable",
      "mobile layout bottom sheet drawer filters cards responsive job tracker application list"
    ),
    chunk(
      rootPath,
      "src/app/private/jobs/JobsDashboardTabs.tsx",
      "JobsDashboardTabs",
      "mobile bottom tabs responsive layout applications review analytics tools"
    ),
    chunk(rootPath, "src/app/private/jobs/JobsReviewPanel.tsx", "JobsReviewPanel", "review queue decision cards retry ignore add to tracker needs_review requeued"),
    chunk(rootPath, "src/app/api/jobs/sync-attempts/route.ts", "GET", "sync attempts review queue route needs_review ignored requeued sourceEmailId"),
    chunk(
      rootPath,
      "src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts",
      "PATCH",
      "sync attempts action route retry ignore add to tracker sourceEmailId requeued"
    ),
    chunk(rootPath, "src/app/private/jobs/JobsApplicationsTable.test.tsx", "JobsApplicationsTableMobileTest", "tests mobile job tracker card layout"),
    chunk(rootPath, "src/lib/jobs/types.ts", "JobStatus", "job statuses applied rejected interview assessment offer ghosted needs_review"),
    chunk(rootPath, "src/lib/jobs/gmail.ts", "listGmailMessages", "gmail messages sync state history list fetch"),
    chunk(rootPath, "src/lib/jobs/parser.ts", "parseJobEmailRules", "gmail parser rental application non job application phrase email parsing"),
    chunk(rootPath, "src/lib/jobs/repository.ts", "getJobDashboardData", "repository owner scoping api data filters job dashboard records"),
    chunk(rootPath, "src/lib/jobs/repository.ts", "listGmailJobSyncAttempts", "repository gmail_job_sync_attempts review queue retry ignored needs_review requeued sourceEmailId"),
    chunk(rootPath, "src/lib/jobs/ingest.ts", "ingestJobsFromGmail", "gmail sync ingest parser attempts job application events"),
    chunk(rootPath, "src/lib/jobs/access.ts", "resolveJobsAccess", "owner scoping allowed emails admin api access session"),
    chunk(
      rootPath,
      "supabase/migrations/20260502000000_job_tracker_resumable_sync_attempts.sql",
      "gmail_job_sync_attempts",
      "create table gmail_job_sync_attempts status inserted duplicate skipped error needs_review requeued"
    )
  ];
  const edges: GraphEdgeRecord[] = [
    {
      rootPath,
      fromFile: "src/app/private/jobs/JobsApplicationsTable.test.tsx",
      toFile: "src/app/private/jobs/JobsApplicationsTable.tsx",
      type: "test_for",
      metadata: {}
    },
    {
      rootPath,
      fromFile: "src/app/private/jobs/JobsDashboardTabs.tsx",
      toFile: "src/app/private/jobs/JobsApplicationsTable.tsx",
      type: "imports",
      metadata: {}
    },
    {
      rootPath,
      fromFile: "src/lib/jobs/repository.ts",
      toFile: "src/lib/jobs/types.ts",
      type: "imports",
      metadata: {}
    },
    {
      rootPath,
      fromFile: "src/lib/jobs/ingest.ts",
      toFile: "src/lib/jobs/parser.ts",
      type: "imports",
      metadata: {}
    }
  ];

  return {
    files,
    symbols,
    chunks,
    vectors: chunks.map((record) => vector(rootPath, record)),
    edges
  };
}
