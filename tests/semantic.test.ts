import { describe, expect, it } from "vitest";
import { hybridSearch } from "../src/retrieval/hybridRetrieval.js";
import { applyCompanionCandidatesToResults, findCompanionCandidates } from "../src/retrieval/companions.js";
import { classifyQueryIntent } from "../src/retrieval/queryIntent.js";
import { decideResponse } from "../src/retrieval/responseRouter.js";
import { embedText, cosineSimilarity } from "../src/semantic/vector.js";
import { indexRepo } from "../src/indexer/indexRepo.js";
import { buildLexicalIndex } from "../src/lexical/bm25.js";
import { getLanguageAdapterForPath, languageAdapters } from "../src/languages/adapters.js";
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

describe("language adapter registry", () => {
  it("keeps universal retrieval extensible across popular languages", () => {
    expect(languageAdapters.find((adapter) => adapter.id === "typescript")?.status).toBe("active");
    expect(languageAdapters.find((adapter) => adapter.id === "python")?.status).toBe("active");
    expect(languageAdapters.find((adapter) => adapter.id === "java")?.status).toBe("active");
    expect(languageAdapters.find((adapter) => adapter.id === "c-cpp")?.status).toBe("active");
    expect(languageAdapters.find((adapter) => adapter.id === "go")?.status).toBe("stub");
    expect(languageAdapters.find((adapter) => adapter.id === "rust")?.status).toBe("stub");
    expect(languageAdapters.find((adapter) => adapter.id === "ruby")?.status).toBe("stub");
    expect(getLanguageAdapterForPath("src/service.py")?.id).toBe("python");
    expect(getLanguageAdapterForPath("src/App.java")?.id).toBe("java");
    expect(getLanguageAdapterForPath("include/fmt/base.h")?.id).toBe("c-cpp");
    expect(getLanguageAdapterForPath("src/core.cpp")?.id).toBe("c-cpp");
    expect(getLanguageAdapterForPath("cmd/main.go")?.id).toBe("go");
    expect(getLanguageAdapterForPath("app/models/user.rb")?.id).toBe("ruby");
    expect(getLanguageAdapterForPath("src/lib.rs")?.id).toBe("rust");
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
  it("does not classify technical string_view identifiers as UI intent", () => {
    const intent = classifyQueryIntent("Debug basic_string_view starts_with equal-length prefix behavior");

    expect(intent.primary).not.toBe("ui");
  });

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

  it("uses BM25 exact matches for status and API identifier terms", () => {
    const fixture = jobTrackerFixture();
    const lexical = buildLexicalIndex({
      rootPath: "/repo",
      files: fixture.files,
      symbols: fixture.symbols,
      chunks: fixture.chunks
    });
    const results = hybridSearch({
      ...fixture,
      lexicalDocuments: lexical.documents,
      lexicalTerms: lexical.terms,
      lexicalStats: lexical.stats,
      query: "sourceEmailId needs_review PostToolUse FileChanged",
      changedFiles: new Set()
    });

    expect(results[0]?.bm25Score).toBeGreaterThan(0);
    expect(results.slice(0, 4).map((result) => result.path)).toEqual(
      expect.arrayContaining([
        "src/app/api/jobs/sync-attempts/[sourceEmailId]/route.ts",
        "src/app/api/jobs/sync-attempts/route.ts"
      ])
    );
    expect(results[0]?.reasons.some((reason) => reason.includes("bm25 exact match"))).toBe(true);
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

  it("deduplicates lexical document ids for parser duplicate symbol captures", () => {
    const rootPath = "/repo";
    const files = [file(rootPath, "include/fmt/base.h", "source", "cpp")];
    const symbols = [
      symbol(rootPath, "include/fmt/base.h", "starts_with"),
      symbol(rootPath, "include/fmt/base.h", "starts_with")
    ];
    const chunks = [
      chunk(rootPath, "include/fmt/base.h", "starts_with", "basic_string_view starts_with prefix"),
      chunk(rootPath, "include/fmt/base.h", "starts_with", "basic_string_view starts_with equal length")
    ];
    const lexical = buildLexicalIndex({ rootPath, files, symbols, chunks });
    const ids = lexical.documents.map((document) => document.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(lexical.terms.every((term) => ids.includes(term.documentId))).toBe(true);
  });

  it("maps behavior-heavy hashing bug descriptions to the production symbol file", () => {
    const fixture = tanStackHashFixture();
    const results = hybridSearch({
      ...fixture,
      query:
        "Debug a seeded regression in TanStack Query query-core: object query keys with the same properties in different orders no longer hash consistently. Fix the production source.",
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("packages/query-core/src/utils.ts");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["behavior symbol match: hashKey"]));
    expect(results[0]?.reasons.some((reason) => reason.includes("behavior term match"))).toBe(true);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("packages/react-query/src/__tests__/useQuery.test.tsx");
  });

  it("prioritizes Python package source over docs and examples for implementation prompts", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "click/utils.py", "source", "python"),
      file(rootPath, "tests/test_utils.py", "test", "python"),
      file(rootPath, "docs/utils.rst", "doc", "text"),
      file(rootPath, "examples/ansi.py", "source", "python")
    ];
    const symbols = [symbol(rootPath, "click/utils.py", "term_len"), symbol(rootPath, "click/utils.py", "strip_ansi")];
    const chunks = [
      chunk(rootPath, "click/utils.py", "term_len", "term_len strips ansi sequences before measuring terminal visible length"),
      chunk(rootPath, "tests/test_utils.py", "test_term_len", "test term_len ansi red color visible width"),
      chunk(rootPath, "docs/utils.rst", "term_len docs", "documentation for term_len and strip_ansi examples"),
      chunk(rootPath, "examples/ansi.py", "ansi example", "example showing term_len")
    ];
    const results = hybridSearch({
      files,
      query: "Debug Click term_len ANSI width regression in production source",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("click/utils.py");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["exact symbol match: term_len"]));
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("docs/utils.rst");
  });

  it("ignores quoted example literals and routes Django slugify regressions to source", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "django/utils/text.py", "source", "python"),
      file(rootPath, "django/template/defaultfilters.py", "source", "python"),
      file(rootPath, "tests/asgi/urls.py", "test", "python"),
      file(rootPath, "tests/modeladmin/test_checks.py", "test", "python")
    ];
    const symbols = [
      symbol(rootPath, "django/utils/text.py", "slugify"),
      symbol(rootPath, "django/template/defaultfilters.py", "slugify"),
      symbol(rootPath, "django/template/defaultfilters.py", "lower"),
      symbol(rootPath, "django/template/defaultfilters.py", "upper"),
      symbol(rootPath, "tests/asgi/urls.py", "hello"),
      symbol(rootPath, "tests/modeladmin/test_checks.py", "CheckTestCase")
    ];
    const chunks = [
      chunk(rootPath, "django/utils/text.py", "slugify", "def slugify(value, allow_unicode=False): normalize value lower strip"),
      chunk(rootPath, "django/template/defaultfilters.py", "slugify", "template filter imports django.utils.text slugify as _slugify"),
      chunk(rootPath, "tests/asgi/urls.py", "hello", "hello world test urls"),
      chunk(rootPath, "tests/modeladmin/test_checks.py", "CheckTestCase", "valid case checks")
    ];
    const results = hybridSearch({
      files,
      query:
        "Debug a seeded regression in Django slugify: uppercase input no longer lowercases. Fix the production source so slugify('Hello World') returns 'hello-world'.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("django/utils/text.py");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["behavior symbol match: slugify"]));
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("tests/asgi/urls.py");
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("tests/modeladmin/test_checks.py");
  });

  it("prioritizes Java src/main source over tests for implementation prompts", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/main/java/org/apache/commons/lang3/StringUtils.java", "source", "java"),
      file(rootPath, "src/test/java/org/apache/commons/lang3/StringUtilsEmptyBlankTest.java", "test", "java"),
      file(rootPath, "src/site/xdoc/StringUtils.xml", "doc", "xml")
    ];
    const symbols = [symbol(rootPath, "src/main/java/org/apache/commons/lang3/StringUtils.java", "isBlank")];
    const chunks = [
      chunk(rootPath, "src/main/java/org/apache/commons/lang3/StringUtils.java", "isBlank", "isBlank CharSequence whitespace blank logic"),
      chunk(rootPath, "src/test/java/org/apache/commons/lang3/StringUtilsEmptyBlankTest.java", "testIsBlank", "testIsBlank whitespace cases"),
      chunk(rootPath, "src/site/xdoc/StringUtils.xml", "StringUtils docs", "isBlank documentation")
    ];
    const results = hybridSearch({
      files,
      query: "Debug StringUtils isBlank whitespace regression fix production source",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("src/main/java/org/apache/commons/lang3/StringUtils.java");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["primary source path"]));
  });

  it("prioritizes C++ include/source files over examples for implementation prompts", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "include/fmt/base.h", "source", "cpp"),
      file(rootPath, "include/fmt/format.h", "source", "cpp"),
      file(rootPath, "test/base-test.cc", "test", "cpp"),
      file(rootPath, "examples/format.cc", "source", "cpp")
    ];
    const symbols = [
      symbol(rootPath, "include/fmt/base.h", "basic_string_view"),
      symbol(rootPath, "include/fmt/base.h", "starts_with"),
      symbol(rootPath, "include/fmt/format.h", "basic_string_view"),
      symbol(rootPath, "include/fmt/format.h", "string_view"),
      symbol(rootPath, "include/fmt/format.h", "maybe_set_debug_format")
    ];
    const chunks = [
      chunk(rootPath, "include/fmt/base.h", "starts_with", "basic_string_view starts_with equal length prefix comparison"),
      chunk(rootPath, "include/fmt/format.h", "basic_string_view", "formatting basic string view format parser debug formatting string view"),
      chunk(rootPath, "test/base-test.cc", "starts_with test", "starts_with equal length case"),
      chunk(rootPath, "examples/format.cc", "starts_with example", "example use starts_with")
    ];
    const lexical = buildLexicalIndex({ rootPath, files, symbols, chunks });
    const results = hybridSearch({
      files,
      query: "Debug fmt basic_string_view starts_with equal length regression",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      lexicalDocuments: lexical.documents,
      lexicalTerms: lexical.terms,
      lexicalStats: lexical.stats,
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("include/fmt/base.h");
    expect(results.findIndex((result) => result.path === "include/fmt/base.h")).toBeLessThan(
      results.findIndex((result) => result.path === "include/fmt/format.h")
    );
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["primary source path"]));
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("examples/format.cc");
  });

  it("rescues precise Next router utility files over broad router modules", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "packages/next/src/shared/lib/router/router.ts", "source"),
      file(rootPath, "packages/next/src/shared/lib/router/utils/is-local-url.ts", "source"),
      file(rootPath, "packages/next/src/shared/lib/router/utils/is-dynamic.ts", "source"),
      file(rootPath, "test/router/is-local-url.test.ts", "test")
    ];
    const symbols = [
      symbol(rootPath, "packages/next/src/shared/lib/router/router.ts", "Router"),
      symbol(rootPath, "packages/next/src/shared/lib/router/utils/is-local-url.ts", "isLocalURL"),
      symbol(rootPath, "packages/next/src/shared/lib/router/utils/is-dynamic.ts", "isDynamicRoute")
    ];
    const chunks = [
      chunk(rootPath, "packages/next/src/shared/lib/router/router.ts", "Router", "router navigation push replace local absolute relative url handling"),
      chunk(rootPath, "packages/next/src/shared/lib/router/utils/is-local-url.ts", "isLocalURL", "returns true for local relative URLs and false for external absolute URLs"),
      chunk(rootPath, "packages/next/src/shared/lib/router/utils/is-dynamic.ts", "isDynamicRoute", "dynamic route helper"),
      chunk(rootPath, "test/router/is-local-url.test.ts", "isLocalURLTest", "local URL test cases")
    ];
    const results = hybridSearch({
      files,
      query: "Debug Next router local URL helper regression: relative URLs should be treated as local. Fix production source.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("packages/next/src/shared/lib/router/utils/is-local-url.ts");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["precise filename match: local, url"]));
    expect(results.findIndex((result) => result.path === "packages/next/src/shared/lib/router/utils/is-local-url.ts")).toBeLessThan(
      results.findIndex((result) => result.path === "packages/next/src/shared/lib/router/router.ts")
    );
  });

  it("rescues precise utility files from path and symbol metadata even when chunks are unavailable", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "packages/next/src/shared/lib/router/router.ts", "source"),
      file(rootPath, "packages/next/src/shared/lib/router/utils/is-local-url.ts", "source"),
      file(rootPath, "packages/next/src/shared/lib/router/utils/is-dynamic.ts", "source")
    ];
    const symbols = [
      symbol(rootPath, "packages/next/src/shared/lib/router/router.ts", "Router"),
      symbol(rootPath, "packages/next/src/shared/lib/router/utils/is-local-url.ts", "isLocalURL"),
      symbol(rootPath, "packages/next/src/shared/lib/router/utils/is-dynamic.ts", "isDynamicRoute")
    ];
    const results = hybridSearch({
      files,
      query: "Debug local URL helper regression: relative URLs should be treated as local in production source.",
      symbols,
      chunks: [],
      vectors: [],
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("packages/next/src/shared/lib/router/utils/is-local-url.ts");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["utility/helper source rescue"]));
  });

  it("routes Java fixes to canonical main source before platform mirrors", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "android/guava/src/com/google/common/base/Strings.java", "source", "java"),
      file(rootPath, "guava/src/com/google/common/base/Strings.java", "source", "java"),
      file(rootPath, "guava-tests/test/com/google/common/base/StringsTest.java", "test", "java")
    ];
    const symbols = [
      symbol(rootPath, "android/guava/src/com/google/common/base/Strings.java", "isNullOrEmpty"),
      symbol(rootPath, "guava/src/com/google/common/base/Strings.java", "isNullOrEmpty"),
      symbol(rootPath, "guava-tests/test/com/google/common/base/StringsTest.java", "testIsNullOrEmpty")
    ];
    const chunks = [
      chunk(rootPath, "android/guava/src/com/google/common/base/Strings.java", "isNullOrEmpty", "android CharSequence string empty null helper"),
      chunk(rootPath, "guava/src/com/google/common/base/Strings.java", "isNullOrEmpty", "CharSequence string empty null helper"),
      chunk(rootPath, "guava-tests/test/com/google/common/base/StringsTest.java", "testIsNullOrEmpty", "test string empty null")
    ];
    const results = hybridSearch({
      files,
      query: "Debug seeded Java regression: Strings.isNullOrEmpty should return true for empty CharSequence. Fix production source and do not edit unrelated files.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("guava/src/com/google/common/base/Strings.java");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["canonical source route"]));
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("android/guava/src/com/google/common/base/Strings.java");
  });

  it("routes Go fixes to canonical source before build-tag variants", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "command.go", "source", "go"),
      file(rootPath, "command_notwin.go", "source", "go"),
      file(rootPath, "command_windows.go", "source", "go"),
      file(rootPath, "command_test.go", "test", "go")
    ];
    const symbols = [
      symbol(rootPath, "command.go", "TraverseChildren"),
      symbol(rootPath, "command_notwin.go", "TraverseChildren"),
      symbol(rootPath, "command_windows.go", "TraverseChildren")
    ];
    const chunks = [
      chunk(rootPath, "command.go", "TraverseChildren", "traverse children command routing source behavior"),
      chunk(rootPath, "command_notwin.go", "TraverseChildren", "not windows platform command behavior"),
      chunk(rootPath, "command_windows.go", "TraverseChildren", "windows platform command behavior"),
      chunk(rootPath, "command_test.go", "TestTraverseChildren", "test command traverse children")
    ];
    const results = hybridSearch({
      files,
      query: "Debug Cobra TraverseChildren source regression: parent commands should traverse child command handlers. Fix production source and do not edit unrelated files.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set(["command.go"])
    });

    expect(results[0]?.path).toBe("command.go");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["changed exact-symbol source target"]));
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("command_notwin.go");
  });

  it("routes public JS API prompts to monolithic source before tests", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lodash.js", "source", "javascript"),
      file(rootPath, "test/test-fp.js", "test", "javascript"),
      file(rootPath, "fp/_baseConvert.js", "source", "javascript")
    ];
    const symbols = [
      symbol(rootPath, "lodash.js", "isString"),
      symbol(rootPath, "test/test-fp.js", "isString"),
      symbol(rootPath, "fp/_baseConvert.js", "baseConvert")
    ];
    const chunks = [
      chunk(rootPath, "lodash.js", "isString", "exported public API isString object wrapper string tag"),
      chunk(rootPath, "test/test-fp.js", "testIsString", "tests fp isString object wrapper"),
      chunk(rootPath, "fp/_baseConvert.js", "baseConvert", "fp wrapper convert methods")
    ];
    const results = hybridSearch({
      files,
      query: "Debug lodash _.isString object wrapper regression: isString should return true for String object wrappers. Fix production source.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("lodash.js");
    expect(results[0]?.reasons).toEqual(expect.arrayContaining(["monolithic public API source"]));
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("test/test-fp.js");
  });

  it("does not treat negated test mentions as positive test intent", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/requests/sessions.py", "source", "python"),
      file(rootPath, "src/requests/adapters.py", "source", "python"),
      file(rootPath, "tests/test_requests.py", "test", "python")
    ];
    const symbols = [
      symbol(rootPath, "src/requests/sessions.py", "Session"),
      symbol(rootPath, "src/requests/sessions.py", "send"),
      symbol(rootPath, "src/requests/sessions.py", "resolve_redirects"),
      symbol(rootPath, "tests/test_requests.py", "test_HTTP_302_ALLOW_REDIRECT_GET")
    ];
    const chunks = [
      chunk(rootPath, "src/requests/sessions.py", "send", "Session.send allow_redirects resolve_redirects production source redirect handling"),
      chunk(rootPath, "src/requests/adapters.py", "send", "adapter send transport response redirect"),
      chunk(rootPath, "tests/test_requests.py", "test_HTTP_302_ALLOW_REDIRECT_GET", "test allow_redirects redirect response")
    ];
    const query = "Before editing, state the exact production source path and invariant. Session.send must call resolve_redirects when allow_redirects is true. Do not inspect tests unless source verification fails.";
    const intent = classifyQueryIntent(query);
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(intent.primary).not.toBe("test");
    expect(results[0]?.path).toBe("src/requests/sessions.py");
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("tests/test_requests.py");
  });

  it("keeps source review prompts on production files when tests share the behavior terms", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/requests/sessions.py", "source", "python"),
      file(rootPath, "src/requests/adapters.py", "source", "python"),
      file(rootPath, "src/requests/models.py", "source", "python"),
      file(rootPath, "tests/test_requests.py", "test", "python")
    ];
    const symbols = [
      symbol(rootPath, "src/requests/sessions.py", "Session"),
      symbol(rootPath, "src/requests/sessions.py", "send"),
      symbol(rootPath, "src/requests/adapters.py", "HTTPAdapter"),
      symbol(rootPath, "src/requests/models.py", "PreparedRequest"),
      symbol(rootPath, "tests/test_requests.py", "test_HTTP_302_ALLOW_REDIRECT_GET")
    ];
    const chunks = [
      chunk(rootPath, "src/requests/sessions.py", "send", "Session.send allow_redirects resolve_redirects production source redirect handling"),
      chunk(rootPath, "src/requests/adapters.py", "send", "adapter send transport redirect response"),
      chunk(rootPath, "src/requests/models.py", "PreparedRequest", "request model redirect URL response"),
      chunk(rootPath, "tests/test_requests.py", "test_HTTP_302_ALLOW_REDIRECT_GET", "test allow_redirects redirect response")
    ];
    const results = hybridSearch({
      files,
      query: "Review whether allow_redirects handling requires companion edits in adapters or models. Prefer the known source invariant. Do not edit unless the source invariant is wrong.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.kind).toBe("source");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("tests/test_requests.py");
  });

  it("adds FastAPI-style routing/dependency companions without promoting OpenAPI noise", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "fastapi/openapi/utils.py", "source", "python"),
      file(rootPath, "fastapi/routing.py", "source", "python"),
      file(rootPath, "fastapi/dependencies/utils.py", "source", "python"),
      file(rootPath, "tests/test_routing.py", "test", "python")
    ];
    const symbols = [
      symbol(rootPath, "fastapi/openapi/utils.py", "get_openapi_path"),
      symbol(rootPath, "fastapi/routing.py", "APIRoute"),
      symbol(rootPath, "fastapi/routing.py", "solve_dependencies"),
      symbol(rootPath, "fastapi/dependencies/utils.py", "solve_dependencies")
    ];
    const chunks = [
      chunk(rootPath, "fastapi/openapi/utils.py", "get_openapi_path", "openapi generation schema path operation metadata"),
      chunk(rootPath, "fastapi/routing.py", "APIRoute", "route handler path operation dependency resolution"),
      chunk(rootPath, "fastapi/dependencies/utils.py", "solve_dependencies", "dependency resolution route handler solve dependencies"),
      chunk(rootPath, "tests/test_routing.py", "test_route", "routing dependency tests")
    ];
    const ranked = hybridSearch({
      files,
      query: "Debug path operation routing dependency resolution before OpenAPI generation",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    }).slice(0, 5);
    const companions = findCompanionCandidates({
      files,
      ranked,
      query: "Debug path operation routing dependency resolution before OpenAPI generation",
      symbols,
      chunks,
      edges: [],
      limit: 2
    });
    const merged = applyCompanionCandidatesToResults(ranked, companions);

    expect(merged.slice(0, 4).map((result) => result.path)).toEqual(
      expect.arrayContaining(["fastapi/routing.py", "fastapi/dependencies/utils.py"])
    );
    expect(merged.slice(0, 4).map((result) => result.path)).not.toContain("tests/test_routing.py");
    expect(companions.some((candidate) => candidate.reasons.some((reason) => reason.includes("routing/dependency pair")))).toBe(true);
  });

  it("keeps universal Go source ahead of test/noise paths for router group prompts", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "routergroup.go", "source", "go"),
      file(rootPath, "gin.go", "source", "go"),
      file(rootPath, "context.go", "source", "go"),
      file(rootPath, "context_appengine.go", "source", "go"),
      file(rootPath, "test_helpers.go", "test", "go"),
      file(rootPath, "middleware_test.go", "test", "go"),
      file(rootPath, "examples/route.go", "source", "go")
    ];
    const chunks = [
      chunk(rootPath, "routergroup.go", "RouterGroup", "router group route registration middleware handler"),
      chunk(rootPath, "gin.go", "Engine", "engine handler routing group context"),
      chunk(rootPath, "context.go", "Context", "request context handler middleware"),
      chunk(rootPath, "context_appengine.go", "Context", "request context handler middleware appengine variant"),
      chunk(rootPath, "test_helpers.go", "test helpers", "route middleware context tests"),
      chunk(rootPath, "middleware_test.go", "TestMiddleware", "middleware route tests"),
      chunk(rootPath, "examples/route.go", "example", "route example")
    ];
    const results = hybridSearch({
      files,
      query: "Debug route group middleware handler context behavior when nested groups register routes",
      symbols: [],
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 3).map((result) => result.path)).toEqual(
      expect.arrayContaining(["routergroup.go", "gin.go", "context.go"])
    );
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("middleware_test.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("test_helpers.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("context_appengine.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("examples/route.go");
  });

  it("adds Axios interceptor/dispatch companions ahead of adapters", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/core/Axios.js", "source", "javascript"),
      file(rootPath, "lib/core/InterceptorManager.js", "source", "javascript"),
      file(rootPath, "lib/core/dispatchRequest.js", "source", "javascript"),
      file(rootPath, "lib/adapters/http.js", "source", "javascript"),
      file(rootPath, "test/specs/interceptors.spec.js", "test", "javascript")
    ];
    const symbols = [
      symbol(rootPath, "lib/core/Axios.js", "Axios"),
      symbol(rootPath, "lib/core/InterceptorManager.js", "InterceptorManager"),
      symbol(rootPath, "lib/core/dispatchRequest.js", "dispatchRequest"),
      symbol(rootPath, "lib/adapters/http.js", "httpAdapter")
    ];
    const chunks = [
      chunk(rootPath, "lib/core/Axios.js", "Axios", "request interceptor chain dispatchRequest config adapters"),
      chunk(rootPath, "lib/core/InterceptorManager.js", "InterceptorManager", "interceptor use eject manager request response"),
      chunk(rootPath, "lib/core/dispatchRequest.js", "dispatchRequest", "dispatch request transform config adapter"),
      chunk(rootPath, "lib/adapters/http.js", "httpAdapter", "node http adapter sends config"),
      chunk(rootPath, "test/specs/interceptors.spec.js", "interceptor tests", "request interceptor tests")
    ];
    const ranked = hybridSearch({
      files,
      query: "Debug request interceptor execution order before dispatchRequest sends config through adapters",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    }).slice(0, 5);
    const companions = findCompanionCandidates({
      files,
      ranked,
      query: "Debug request interceptor execution order before dispatchRequest sends config through adapters",
      symbols,
      chunks,
      edges: [],
      limit: 2
    });
    const merged = applyCompanionCandidatesToResults(ranked, companions);

    expect(merged.slice(0, 4).map((result) => result.path)).toEqual(
      expect.arrayContaining(["lib/core/Axios.js", "lib/core/InterceptorManager.js", "lib/core/dispatchRequest.js"])
    );
    expect(merged.slice(0, 4).map((result) => result.path)).not.toContain("test/specs/interceptors.spec.js");
  });

  it("routes CLI export sorting tasks to command and exporter sources before storage backends", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "cmd/flipt/export.go", "source", "go"),
      file(rootPath, "internal/ext/exporter.go", "source", "go"),
      file(rootPath, "internal/storage/fs/store/store.go", "source", "go"),
      file(rootPath, "internal/storage/sql/common/segment.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "cmd/flipt/export.go", "newExportCommand"),
      symbol(rootPath, "internal/ext/exporter.go", "NewExporter"),
      symbol(rootPath, "internal/storage/fs/store/store.go", "ListFlags"),
      symbol(rootPath, "internal/storage/sql/common/segment.go", "ListSegments")
    ];
    const chunks = [
      chunk(rootPath, "cmd/flipt/export.go", "newExportCommand", "export command flag all namespaces output"),
      chunk(rootPath, "internal/ext/exporter.go", "NewExporter", "Exporter writes namespaces flags segments variants resources"),
      chunk(rootPath, "internal/storage/fs/store/store.go", "ListFlags", "storage backend lists flags segments by key"),
      chunk(rootPath, "internal/storage/sql/common/segment.go", "ListSegments", "storage segment list order created at")
    ];
    const results = hybridSearch({
      files,
      query: "Implement --sort-by-key for the export command. NewExporter should sort namespaces flags segments and variants deterministically.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path)).toEqual(["cmd/flipt/export.go", "internal/ext/exporter.go"]);
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("internal/storage/fs/store/store.go");
  });

  it("keeps datastore backend peers together for multi-value collection mutations", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/database/mongo/list.js", "source", "javascript"),
      file(rootPath, "src/database/postgres/list.js", "source", "javascript"),
      file(rootPath, "src/database/redis/list.js", "source", "javascript"),
      file(rootPath, "src/database/mongo/sorted.js", "source", "javascript")
    ];
    const symbols = [
      symbol(rootPath, "src/database/mongo/list.js", "remove"),
      symbol(rootPath, "src/database/postgres/list.js", "remove"),
      symbol(rootPath, "src/database/redis/list.js", "remove"),
      symbol(rootPath, "src/database/mongo/sorted.js", "removeSorted")
    ];
    const chunks = [
      chunk(rootPath, "src/database/mongo/list.js", "remove", "list remove element from mongo backend"),
      chunk(rootPath, "src/database/postgres/list.js", "remove", "list remove element from postgres backend"),
      chunk(rootPath, "src/database/redis/list.js", "remove", "list remove element from redis backend"),
      chunk(rootPath, "src/database/mongo/sorted.js", "removeSorted", "sorted set remove element from mongo backend")
    ];
    const query = "List operations do not support removing multiple distinct elements in a single call.";
    const ranked = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });
    const companions = findCompanionCandidates({
      files,
      ranked,
      query,
      symbols,
      chunks,
      edges: [],
      limit: 3
    });
    const merged = applyCompanionCandidatesToResults(ranked, companions);

    expect(merged.slice(0, 3).map((result) => result.path)).toEqual(
      expect.arrayContaining([
        "src/database/mongo/list.js",
        "src/database/postgres/list.js",
        "src/database/redis/list.js"
      ])
    );
    expect(merged.slice(0, 3).map((result) => result.path)).not.toContain("src/database/mongo/sorted.js");
  });

  it("uses exporter implementation as the companion for export command sorting tasks", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "cmd/flipt/export.go", "source", "go"),
      file(rootPath, "internal/ext/exporter.go", "source", "go"),
      file(rootPath, "internal/storage/fs/store/store.go", "source", "go"),
      file(rootPath, "internal/storage/sql/common/segment.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "cmd/flipt/export.go", "newExportCommand"),
      symbol(rootPath, "internal/ext/exporter.go", "NewExporter"),
      symbol(rootPath, "internal/storage/fs/store/store.go", "ListFlags"),
      symbol(rootPath, "internal/storage/sql/common/segment.go", "ListSegments")
    ];
    const chunks = [
      chunk(rootPath, "cmd/flipt/export.go", "newExportCommand", "export command flag all namespaces output"),
      chunk(rootPath, "internal/ext/exporter.go", "NewExporter", "Exporter writes namespaces flags segments variants resources and sort by key"),
      chunk(rootPath, "internal/storage/fs/store/store.go", "ListFlags", "storage backend lists flags segments by key"),
      chunk(rootPath, "internal/storage/sql/common/segment.go", "ListSegments", "storage segment list order created at")
    ];
    const query = "Implement --sort-by-key for the export command. NewExporter should sort namespaces flags segments and variants deterministically.";
    const ranked = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });
    const companions = findCompanionCandidates({
      files,
      ranked,
      query,
      symbols,
      chunks,
      edges: [],
      limit: 2
    });

    expect(companions[0]?.file.path).toBe("internal/ext/exporter.go");
    expect(companions.map((candidate) => candidate.file.path)).not.toContain("internal/storage/sql/common/segment.go");
  });

  it("routes HSM/KMS backend test configuration tasks to keystore sources before unrelated web code", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/auth/keystore/testhelpers.go", "source", "go"),
      file(rootPath, "lib/auth/keystore/pkcs11.go", "source", "go"),
      file(rootPath, "api/utils/sshutils/test.go", "source", "go"),
      file(rootPath, "web/packages/teleport/src/lib/tdp/codec.ts", "source", "typescript"),
      file(rootPath, "web/packages/teleport/src/lib/tdp/sharedDirectoryManager.ts", "source", "typescript")
    ];
    const symbols = [
      symbol(rootPath, "lib/auth/keystore/testhelpers.go", "HSMTestConfig"),
      symbol(rootPath, "lib/auth/keystore/pkcs11.go", "SetupSoftHSMTest"),
      symbol(rootPath, "api/utils/sshutils/test.go", "TestBackends"),
      symbol(rootPath, "web/packages/teleport/src/lib/tdp/codec.ts", "validateSharedDirectory"),
      symbol(rootPath, "web/packages/teleport/src/lib/tdp/sharedDirectoryManager.ts", "SharedDirectoryManager")
    ];
    const chunks = [
      chunk(rootPath, "lib/auth/keystore/testhelpers.go", "HSMTestConfig", "HSM KMS backend test configuration TELEPORT_TEST SoftHSM YubiHSM CloudHSM AWS KMS GCP KMS environment"),
      chunk(rootPath, "lib/auth/keystore/pkcs11.go", "SetupSoftHSMTest", "pkcs11 SoftHSM backend config keystore HSM test helper"),
      chunk(rootPath, "api/utils/sshutils/test.go", "TestBackends", "test backend configuration helper for SSH utilities"),
      chunk(rootPath, "web/packages/teleport/src/lib/tdp/codec.ts", "validateSharedDirectory", "validation config shared directory codec"),
      chunk(rootPath, "web/packages/teleport/src/lib/tdp/sharedDirectoryManager.ts", "SharedDirectoryManager", "web TDP shared directory manager validation")
    ];
    const query = "Teleport HSM and KMS test configuration logic is duplicated across backend test files. Add HSMTestConfig for SoftHSM, YubiHSM, CloudHSM, AWS KMS, and GCP KMS.";
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path).sort()).toEqual(["lib/auth/keystore/pkcs11.go", "lib/auth/keystore/testhelpers.go"]);
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("web/packages/teleport/src/lib/tdp/codec.ts");
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("api/utils/sshutils/test.go");
  });

  it("keeps HSM/KMS keystore helpers as companions for backend test configuration tasks", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/auth/keystore/testhelpers.go", "source", "go"),
      file(rootPath, "lib/auth/keystore/pkcs11.go", "source", "go"),
      file(rootPath, "api/utils/sshutils/test.go", "source", "go"),
      file(rootPath, "web/packages/teleport/src/lib/tdp/codec.ts", "source", "typescript"),
      file(rootPath, "web/packages/teleport/src/lib/tdp/sharedDirectoryManager.ts", "source", "typescript")
    ];
    const symbols = [
      symbol(rootPath, "lib/auth/keystore/testhelpers.go", "HSMTestConfig"),
      symbol(rootPath, "lib/auth/keystore/pkcs11.go", "SetupSoftHSMTest"),
      symbol(rootPath, "api/utils/sshutils/test.go", "TestBackends"),
      symbol(rootPath, "web/packages/teleport/src/lib/tdp/codec.ts", "validateSharedDirectory"),
      symbol(rootPath, "web/packages/teleport/src/lib/tdp/sharedDirectoryManager.ts", "SharedDirectoryManager")
    ];
    const chunks = [
      chunk(rootPath, "lib/auth/keystore/testhelpers.go", "HSMTestConfig", "HSM KMS backend test configuration TELEPORT_TEST SoftHSM YubiHSM CloudHSM AWS KMS GCP KMS environment"),
      chunk(rootPath, "lib/auth/keystore/pkcs11.go", "SetupSoftHSMTest", "pkcs11 SoftHSM backend config keystore HSM test helper"),
      chunk(rootPath, "api/utils/sshutils/test.go", "TestBackends", "test backend configuration helper for SSH utilities"),
      chunk(rootPath, "web/packages/teleport/src/lib/tdp/codec.ts", "validateSharedDirectory", "validation config shared directory codec"),
      chunk(rootPath, "web/packages/teleport/src/lib/tdp/sharedDirectoryManager.ts", "SharedDirectoryManager", "web TDP shared directory manager validation")
    ];
    const query = "Teleport HSM and KMS test configuration logic is duplicated across backend test files. Add HSMTestConfig for SoftHSM, YubiHSM, CloudHSM, AWS KMS, and GCP KMS.";
    const ranked = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });
    const companions = findCompanionCandidates({
      files,
      ranked,
      query,
      symbols,
      chunks,
      edges: [],
      limit: 2
    });

    expect(companions[0]?.file.path).toBe("lib/auth/keystore/testhelpers.go");
    expect(companions.map((candidate) => candidate.file.path)).not.toContain("web/packages/teleport/src/lib/tdp/sharedDirectoryManager.ts");
    expect(companions.map((candidate) => candidate.file.path)).not.toContain("api/utils/sshutils/test.go");
  });

  it("routes backend autocomplete endpoint tasks to server autocomplete sources before frontend widgets", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "openlibrary/plugins/worksearch/autocomplete.py", "source", "python"),
      file(rootPath, "openlibrary/plugins/openlibrary/js/autocomplete.js", "source", "javascript"),
      file(rootPath, "openlibrary/plugins/upstream/addbook.py", "source", "python"),
      file(rootPath, "openlibrary/solr/update_work.py", "source", "python")
    ];
    const symbols = [
      symbol(rootPath, "openlibrary/plugins/worksearch/autocomplete.py", "autocomplete"),
      symbol(rootPath, "openlibrary/plugins/worksearch/autocomplete.py", "find_olid_in_string"),
      symbol(rootPath, "openlibrary/plugins/worksearch/autocomplete.py", "olid_to_key"),
      symbol(rootPath, "openlibrary/plugins/openlibrary/js/autocomplete.js", "setupAutocomplete"),
      symbol(rootPath, "openlibrary/plugins/upstream/addbook.py", "add_book"),
      symbol(rootPath, "openlibrary/solr/update_work.py", "update_work")
    ];
    const chunks = [
      chunk(rootPath, "openlibrary/plugins/worksearch/autocomplete.py", "autocomplete", "autocomplete endpoint Solr OLID fallback db_fetch works_autocomplete authors_autocomplete subjects_autocomplete"),
      chunk(rootPath, "openlibrary/plugins/openlibrary/js/autocomplete.js", "setupAutocomplete", "frontend autocomplete input dropdown browser widget"),
      chunk(rootPath, "openlibrary/plugins/upstream/addbook.py", "add_book", "upstream add book import OLID edition"),
      chunk(rootPath, "openlibrary/solr/update_work.py", "update_work", "Solr work update index document")
    ];
    const query = "Autocomplete endpoints lack unified logic and flexible OLID handling. Add an autocomplete base class, find_olid_in_string, olid_to_key, db_fetch fallback, and Solr query handling for works, authors, and subjects endpoints.";
    const ranked = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });
    const companions = findCompanionCandidates({
      files,
      ranked,
      query,
      symbols,
      chunks,
      edges: [],
      limit: 2
    });

    expect(ranked[0]?.path).toBe("openlibrary/plugins/worksearch/autocomplete.py");
    expect(ranked.slice(0, 2).map((result) => result.path)).not.toContain("openlibrary/plugins/openlibrary/js/autocomplete.js");
    expect(companions.map((candidate) => candidate.file.path)).not.toContain("openlibrary/plugins/openlibrary/js/autocomplete.js");
  });

  it("routes config-option rendering workarounds to runtime args plus schema data", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "qutebrowser/config/qtargs.py", "source", "python"),
      file(rootPath, "qutebrowser/config/configdata.yml", "config", "yaml"),
      file(rootPath, "qutebrowser/config/configdata.py", "source", "python"),
      file(rootPath, "qutebrowser/config/configfiles.py", "source", "python"),
      file(rootPath, "qutebrowser/misc/backendproblem.py", "source", "python"),
      file(rootPath, "qutebrowser/browser/webengine/webenginetab.py", "source", "python")
    ];
    const symbols = [
      symbol(rootPath, "qutebrowser/config/qtargs.py", "_qtwebengine_settings_args"),
      symbol(rootPath, "qutebrowser/config/configdata.py", "_read_yaml"),
      symbol(rootPath, "qutebrowser/config/configfiles.py", "ConfigFile"),
      symbol(rootPath, "qutebrowser/misc/backendproblem.py", "BackendProblem"),
      symbol(rootPath, "qutebrowser/browser/webengine/webenginetab.py", "WebEngineTab")
    ];
    const chunks = [
      chunk(rootPath, "qutebrowser/config/qtargs.py", "_qtwebengine_settings_args", "QtWebEngine Chromium settings args workarounds accelerated canvas rendering"),
      chunk(rootPath, "qutebrowser/config/configdata.yml", "configdata", "config data schema settings qt workarounds options"),
      chunk(rootPath, "qutebrowser/config/configdata.py", "_read_yaml", "read yaml source data into parsed config Option objects generated config artifact"),
      chunk(rootPath, "qutebrowser/config/configfiles.py", "ConfigFile", "load config files parse configuration directories"),
      chunk(rootPath, "qutebrowser/misc/backendproblem.py", "BackendProblem", "QtWebEngine backend problem diagnostic issue chromium warning"),
      chunk(rootPath, "qutebrowser/browser/webengine/webenginetab.py", "WebEngineTab", "browser webengine tab rendering page")
    ];
    const results = hybridSearch({
      files,
      query: "Fix QtWebEngine rendering glitches on Google Sheets and PDF.js by adding a Chromium workaround setting.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path).sort()).toEqual([
      "qutebrowser/config/configdata.yml",
      "qutebrowser/config/qtargs.py"
    ]);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("qutebrowser/config/configdata.py");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("qutebrowser/config/configfiles.py");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("qutebrowser/misc/backendproblem.py");

    const companions = findCompanionCandidates({
      files,
      ranked: results.filter((result) => result.path === "qutebrowser/config/qtargs.py"),
      query: "Fix QtWebEngine rendering glitches on Google Sheets and PDF.js by adding a Chromium workaround setting.",
      symbols,
      chunks,
      edges: [],
      limit: 2
    });
    expect(companions.map((candidate) => candidate.file.path)).toContain("qutebrowser/config/configdata.yml");
    expect(companions.map((candidate) => candidate.file.path)).not.toContain("qutebrowser/misc/backendproblem.py");
  });

  it("routes deprecation-by-date module tasks to validation, warning, and display surfaces", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/ansible/module_utils/basic.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/common/parameters.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/common/warnings.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/csharp/Ansible.Basic.cs", "source", "csharp"),
      file(rootPath, "lib/ansible/utils/display.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/facts/system/date_time.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/urls.py", "source", "python"),
      file(rootPath, "lib/ansible/modules/assert.py", "source", "python")
    ];
    const symbols = [
      symbol(rootPath, "lib/ansible/module_utils/basic.py", "AnsibleModule"),
      symbol(rootPath, "lib/ansible/module_utils/common/parameters.py", "validate_argument_spec"),
      symbol(rootPath, "lib/ansible/module_utils/common/warnings.py", "deprecate"),
      symbol(rootPath, "lib/ansible/module_utils/csharp/Ansible.Basic.cs", "ValidateArgumentSpec"),
      symbol(rootPath, "lib/ansible/utils/display.py", "Display"),
      symbol(rootPath, "lib/ansible/module_utils/facts/system/date_time.py", "get_date_time_facts"),
      symbol(rootPath, "lib/ansible/module_utils/urls.py", "fetch_url"),
      symbol(rootPath, "lib/ansible/modules/assert.py", "main")
    ];
    const chunks = [
      chunk(rootPath, "lib/ansible/module_utils/basic.py", "AnsibleModule", "module argument spec deprecated aliases removed in version warning"),
      chunk(rootPath, "lib/ansible/module_utils/common/parameters.py", "validate_argument_spec", "validate deprecated aliases version date parameter errors"),
      chunk(rootPath, "lib/ansible/module_utils/common/warnings.py", "deprecate", "warning deprecation removed at date removed in version"),
      chunk(rootPath, "lib/ansible/module_utils/csharp/Ansible.Basic.cs", "ValidateArgumentSpec", "deprecated_aliases removed_in_version validation runtime mirror"),
      chunk(rootPath, "lib/ansible/utils/display.py", "Display", "display deprecation warning messages"),
      chunk(rootPath, "lib/ansible/module_utils/facts/system/date_time.py", "get_date_time_facts", "system date time facts timezone epoch"),
      chunk(rootPath, "lib/ansible/module_utils/urls.py", "fetch_url", "url helper http request"),
      chunk(rootPath, "lib/ansible/modules/assert.py", "main", "assert module examples")
    ];
    const results = hybridSearch({
      files,
      query: "Support deprecation by date in modules. Deprecated aliases should validate version or date and Display should warn.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 5).map((result) => result.path)).toEqual(
      expect.arrayContaining([
        "lib/ansible/module_utils/basic.py",
        "lib/ansible/module_utils/common/parameters.py",
        "lib/ansible/module_utils/common/warnings.py",
        "lib/ansible/module_utils/csharp/Ansible.Basic.cs",
        "lib/ansible/utils/display.py"
      ])
    );
    expect(results.slice(0, 5).map((result) => result.path)).not.toContain("lib/ansible/module_utils/facts/system/date_time.py");
    expect(results.slice(0, 5).map((result) => result.path)).not.toContain("lib/ansible/module_utils/urls.py");
    expect(results.slice(0, 5).map((result) => result.path)).not.toContain("lib/ansible/modules/assert.py");
  });

  it("routes Kubernetes RBAC namespace rule tasks to resource matchers before service startup", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/utils/replace.go", "source", "go"),
      file(rootPath, "lib/service/kubernetes.go", "source", "go"),
      file(rootPath, "lib/srv/db/cloud/users/users.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "lib/utils/replace.go", "KubeResourceMatchesRegex"),
      symbol(rootPath, "lib/utils/replace.go", "MatchString"),
      symbol(rootPath, "lib/service/kubernetes.go", "initKubernetesService"),
      symbol(rootPath, "lib/srv/db/cloud/users/users.go", "GetUsers")
    ];
    const chunks = [
      chunk(rootPath, "lib/utils/replace.go", "KubeResourceMatchesRegex", "KubernetesResource kind namespace verbs get list watch create update delete wildcard MatchString regexp"),
      chunk(rootPath, "lib/service/kubernetes.go", "initKubernetesService", "kubernetes service startup proxy access point listener"),
      chunk(rootPath, "lib/srv/db/cloud/users/users.go", "GetUsers", "cloud users backend access")
    ];
    const results = hybridSearch({
      files,
      query: "Kubernetes RBAC namespace rules should grant expected resource access. A role rule with kind namespace grants get list watch resources in the namespace.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("lib/utils/replace.go");
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("lib/service/kubernetes.go");
  });

  it("routes Kubernetes exec/session uploader tasks to forwarder and service surfaces before matchers", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/kube/proxy/forwarder.go", "source", "go"),
      file(rootPath, "lib/service/kubernetes.go", "source", "go"),
      file(rootPath, "lib/auth/init.go", "source", "go"),
      file(rootPath, "lib/utils/replace.go", "source", "go"),
      file(rootPath, "lib/srv/db/cloud/users/users.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "lib/kube/proxy/forwarder.go", "ForwarderConfig"),
      symbol(rootPath, "lib/kube/proxy/forwarder.go", "ServeHTTP"),
      symbol(rootPath, "lib/kube/proxy/forwarder.go", "exec"),
      symbol(rootPath, "lib/service/kubernetes.go", "initKubernetesService"),
      symbol(rootPath, "lib/auth/init.go", "NewAuthServer"),
      symbol(rootPath, "lib/utils/replace.go", "KubeResourceMatchesRegex"),
      symbol(rootPath, "lib/srv/db/cloud/users/users.go", "GetUsers")
    ];
    const chunks = [
      chunk(
        rootPath,
        "lib/kube/proxy/forwarder.go",
        "ForwarderConfig",
        "ForwarderConfig Authz CachingAuthClient GetClusterConfig GetKubeServices ReverseTunnelSrv exec portForward catchAll audit events client disconnect"
      ),
      chunk(rootPath, "lib/service/kubernetes.go", "initKubernetesService", "Kubernetes service initializes session uploader async upload directory for session recordings"),
      chunk(rootPath, "lib/auth/init.go", "NewAuthServer", "auth server session initialization user credentials certificates"),
      chunk(rootPath, "lib/utils/replace.go", "KubeResourceMatchesRegex", "KubernetesResource kind namespace verbs get list watch create update delete wildcard MatchString regexp"),
      chunk(rootPath, "lib/srv/db/cloud/users/users.go", "GetUsers", "cloud users backend storage")
    ];
    const results = hybridSearch({
      files,
      query:
        "kubectl exec interactive sessions fail because Kubernetes service misses session uploader initialization. Forwarder should keep audit events for exec, portForward, and catchAll when the client disconnects.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path)).toEqual([
      "lib/kube/proxy/forwarder.go",
      "lib/service/kubernetes.go"
    ]);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("lib/utils/replace.go");

    const companions = findCompanionCandidates({
      files,
      ranked: results.filter((result) => result.path === "lib/kube/proxy/forwarder.go"),
      query:
        "kubectl exec interactive sessions fail because Kubernetes service misses session uploader initialization. Forwarder should keep audit events for exec, portForward, and catchAll when the client disconnects.",
      symbols,
      chunks,
      edges: [],
      limit: 2
    });
    expect(companions[0]?.file.path).toBe("lib/service/kubernetes.go");
    expect(companions.map((candidate) => candidate.file.path)).not.toContain("lib/auth/init.go");
  });

  it("routes large UI feedback/liveness tasks to visible components and hooks before models or utilities", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/voice-broadcast/components/atoms/LiveBadge.tsx", "component"),
      file(rootPath, "src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx", "component"),
      file(rootPath, "src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts", "source"),
      file(rootPath, "src/voice-broadcast/hooks/useVoiceBroadcastRecording.tsx", "source"),
      file(rootPath, "src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts", "source"),
      file(rootPath, "src/voice-broadcast/models/VoiceBroadcastPlayback.ts", "source")
    ];
    const symbols = [
      symbol(rootPath, "src/voice-broadcast/components/atoms/LiveBadge.tsx", "LiveBadge"),
      symbol(rootPath, "src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx", "VoiceBroadcastHeader"),
      symbol(rootPath, "src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts", "useVoiceBroadcastPlayback"),
      symbol(rootPath, "src/voice-broadcast/hooks/useVoiceBroadcastRecording.tsx", "useVoiceBroadcastRecording"),
      symbol(rootPath, "src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts", "VoiceBroadcastChunkEvents"),
      symbol(rootPath, "src/voice-broadcast/models/VoiceBroadcastPlayback.ts", "VoiceBroadcastPlayback")
    ];
    const chunks = [
      chunk(rootPath, "src/voice-broadcast/components/atoms/LiveBadge.tsx", "LiveBadge", "live liveness badge icon feedback recording playback state"),
      chunk(rootPath, "src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx", "VoiceBroadcastHeader", "voice broadcast header liveness icon visible state"),
      chunk(rootPath, "src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts", "useVoiceBroadcastPlayback", "playback hook live state liveness feedback"),
      chunk(rootPath, "src/voice-broadcast/hooks/useVoiceBroadcastRecording.tsx", "useVoiceBroadcastRecording", "recording hook live state liveness feedback"),
      chunk(rootPath, "src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts", "VoiceBroadcastChunkEvents", "chunk event ordering live timestamp"),
      chunk(rootPath, "src/voice-broadcast/models/VoiceBroadcastPlayback.ts", "VoiceBroadcastPlayback", "playback model chunk stream")
    ];
    const results = hybridSearch({
      files,
      query: "Fix voice broadcast liveness icon inconsistent feedback while recording and playback are active.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 5).map((result) => result.path)).toEqual(
      expect.arrayContaining([
        "src/voice-broadcast/components/atoms/LiveBadge.tsx",
        "src/voice-broadcast/components/atoms/VoiceBroadcastHeader.tsx",
        "src/voice-broadcast/hooks/useVoiceBroadcastPlayback.ts",
        "src/voice-broadcast/models/VoiceBroadcastPlayback.ts"
      ])
    );
    expect(results.slice(0, 5).map((result) => result.path)).not.toContain("src/voice-broadcast/utils/VoiceBroadcastChunkEvents.ts");
  });

  it("routes form unflatten request failures to route handlers and unflatten utilities before models", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "openlibrary/plugins/openlibrary/lists.py", "source", "python"),
      file(rootPath, "openlibrary/plugins/upstream/utils.py", "source", "python"),
      file(rootPath, "openlibrary/core/lists/model.py", "source", "python"),
      file(rootPath, "openlibrary/plugins/openlibrary/utils.py", "source", "python")
    ];
    const symbols = [
      symbol(rootPath, "openlibrary/plugins/openlibrary/lists.py", "POST"),
      symbol(rootPath, "openlibrary/plugins/upstream/utils.py", "unflatten"),
      symbol(rootPath, "openlibrary/core/lists/model.py", "List"),
      symbol(rootPath, "openlibrary/plugins/openlibrary/utils.py", "safeint")
    ];
    const chunks = [
      chunk(rootPath, "openlibrary/plugins/openlibrary/lists.py", "POST", "POST /lists/add form data body query parameters seeds defaults request handler"),
      chunk(rootPath, "openlibrary/plugins/upstream/utils.py", "unflatten", "unflatten flattened form data nested indexed keys parent defaults reconstruction"),
      chunk(rootPath, "openlibrary/core/lists/model.py", "List", "list model seed entries persistence"),
      chunk(rootPath, "openlibrary/plugins/openlibrary/utils.py", "safeint", "generic openlibrary utility helpers")
    ];
    const query = [
      "/lists/add returns 500 when POST body data conflicts with query parameters.",
      "When body data is present, do not pre-populate parent keys before unflatten.",
      "Nested indexed seeds fields should reconstruct from flattened form input."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path).sort()).toEqual([
      "openlibrary/plugins/openlibrary/lists.py",
      "openlibrary/plugins/upstream/utils.py"
    ]);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("openlibrary/core/lists/model.py");

    const companions = findCompanionCandidates({
      files,
      ranked: results.filter((result) => result.path === "openlibrary/plugins/openlibrary/lists.py"),
      query,
      symbols,
      chunks,
      edges: [],
      limit: 2
    });
    expect(companions[0]?.file.path).toBe("openlibrary/plugins/upstream/utils.py");
    expect(companions.map((candidate) => candidate.file.path)).not.toContain("openlibrary/core/lists/model.py");
  });

  it("routes Alpine source/binary package mapping to scanner and OVAL matcher surfaces", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "scanner/alpine.go", "source", "go"),
      file(rootPath, "oval/util.go", "source", "go"),
      file(rootPath, "scanner/scanner.go", "source", "go"),
      file(rootPath, "oval/alpine.go", "source", "go"),
      file(rootPath, "contrib/trivy/pkg/converter.go", "source", "go"),
      file(rootPath, "scanner/parser/generic.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "scanner/alpine.go", "parseApkInfo"),
      symbol(rootPath, "oval/util.go", "matchSourcePackage"),
      symbol(rootPath, "scanner/scanner.go", "Detect"),
      symbol(rootPath, "oval/alpine.go", "NewAlpine"),
      symbol(rootPath, "contrib/trivy/pkg/converter.go", "Convert"),
      symbol(rootPath, "scanner/parser/generic.go", "Parse")
    ];
    const chunks = [
      chunk(rootPath, "scanner/alpine.go", "parseApkInfo", "Alpine apk list output binary package source package upgradable installed package manager scanner"),
      chunk(rootPath, "oval/util.go", "matchSourcePackage", "OVAL vulnerability matching source package binary package affected ranges"),
      chunk(rootPath, "scanner/scanner.go", "Detect", "scanner dispatch package vulnerability detection source packages"),
      chunk(rootPath, "oval/alpine.go", "NewAlpine", "Alpine OVAL source vulnerability definitions"),
      chunk(rootPath, "contrib/trivy/pkg/converter.go", "Convert", "Trivy converter package output"),
      chunk(rootPath, "scanner/parser/generic.go", "Parse", "generic package parser helper")
    ];
    const query = [
      "Alpine Linux vulnerability detection incorrectly handles source vs binary packages.",
      "The scanner should parse apk list output and upgradable package information,",
      "map binary packages to source packages, and OVAL vulnerability matching should assess source packages accordingly."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 4).map((result) => result.path)).toEqual(
      expect.arrayContaining(["scanner/alpine.go", "oval/util.go", "scanner/scanner.go"])
    );
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("contrib/trivy/pkg/converter.go");
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("scanner/parser/generic.go");

    const companions = findCompanionCandidates({
      files,
      ranked: results.filter((result) => result.path === "scanner/alpine.go"),
      query,
      symbols,
      chunks,
      edges: [],
      limit: 3
    });
    expect(companions.map((candidate) => candidate.file.path)).toEqual(
      expect.arrayContaining(["oval/util.go", "scanner/scanner.go"])
    );
  });

  it("routes RPM source package parsing tasks to distro scanner owner over Alpine surfaces", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "scanner/redhatbase.go", "source", "go"),
      file(rootPath, "scanner/alpine.go", "source", "go"),
      file(rootPath, "oval/util.go", "source", "go"),
      file(rootPath, "scanner/scanner.go", "source", "go"),
      file(rootPath, "oval/alpine.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "scanner/redhatbase.go", "parseInstalledPackagesLine"),
      symbol(rootPath, "scanner/alpine.go", "parseApkInfo"),
      symbol(rootPath, "oval/util.go", "matchSourcePackage"),
      symbol(rootPath, "scanner/scanner.go", "Detect"),
      symbol(rootPath, "oval/alpine.go", "NewAlpine")
    ];
    const chunks = [
      chunk(rootPath, "scanner/redhatbase.go", "parseInstalledPackagesLine", "RPM SOURCERPM source package src.rpm epoch splitFileName redhat installed package metadata"),
      chunk(rootPath, "scanner/alpine.go", "parseApkInfo", "Alpine apk list output binary package source package"),
      chunk(rootPath, "oval/util.go", "matchSourcePackage", "OVAL vulnerability matching source package binary package affected ranges"),
      chunk(rootPath, "scanner/scanner.go", "Detect", "scanner dispatch package vulnerability detection source packages"),
      chunk(rootPath, "oval/alpine.go", "NewAlpine", "Alpine OVAL source vulnerability definitions")
    ];
    const query = [
      "Scanner fails on non-standard source RPM filenames and epoch handling.",
      "Update parseInstalledPackagesLine and splitFileName to handle SOURCERPM src.rpm values without aborting."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("scanner/redhatbase.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("scanner/alpine.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("oval/alpine.go");
  });

  it("routes benchmark generator contracts to benchmark package and CLI/client surfaces", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/benchmark/benchmark.go", "source", "go"),
      file(rootPath, "lib/benchmark/linear.go", "source", "go"),
      file(rootPath, "lib/client/bench.go", "source", "go"),
      file(rootPath, "tool/tsh/tsh.go", "source", "go"),
      file(rootPath, "lib/kube/proxy/auth.go", "source", "go"),
      file(rootPath, "lib/limiter/ratelimiter.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "lib/benchmark/benchmark.go", "Config"),
      symbol(rootPath, "lib/benchmark/linear.go", "Linear"),
      symbol(rootPath, "lib/client/bench.go", "Benchmark"),
      symbol(rootPath, "tool/tsh/tsh.go", "onBenchmark"),
      symbol(rootPath, "lib/kube/proxy/auth.go", "Authenticate"),
      symbol(rootPath, "lib/limiter/ratelimiter.go", "Limiter")
    ];
    const chunks = [
      chunk(rootPath, "lib/benchmark/benchmark.go", "Config", "benchmark configuration rate command threads minimum window measurements"),
      chunk(rootPath, "lib/benchmark/linear.go", "Linear", "linear benchmark generator lower bound upper bound step GetBenchmark request rate"),
      chunk(rootPath, "lib/client/bench.go", "Benchmark", "client benchmark command request rate configuration"),
      chunk(rootPath, "tool/tsh/tsh.go", "onBenchmark", "tsh benchmark command wiring"),
      chunk(rootPath, "lib/kube/proxy/auth.go", "Authenticate", "kubernetes proxy authentication request"),
      chunk(rootPath, "lib/limiter/ratelimiter.go", "Limiter", "rate limiter retry budget")
    ];
    const query = [
      "Add a linear benchmark generator for progressive request rate configurations.",
      "Linear.GetBenchmark should return Config values with Rate, Threads, MinimumWindow, MinimumMeasurements, and Command."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path)).toEqual([
      "lib/benchmark/linear.go",
      "lib/benchmark/benchmark.go"
    ]);
    expect(results.slice(0, 4).map((result) => result.path)).toEqual(expect.arrayContaining([
      "lib/client/bench.go",
      "tool/tsh/tsh.go"
    ]));
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("lib/kube/proxy/auth.go");
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("lib/limiter/ratelimiter.go");
  });

  it("routes pinned topic reorder tasks to client, socket, and topic tool owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "public/src/client/category/tools.js", "source", "javascript"),
      file(rootPath, "src/socket.io/topics/tools.js", "source", "javascript"),
      file(rootPath, "src/topics/tools.js", "source", "javascript"),
      file(rootPath, "public/src/admin/dashboard/topics.js", "source", "javascript"),
      file(rootPath, "src/privileges/topics.js", "source", "javascript")
    ];
    const symbols = [
      symbol(rootPath, "public/src/client/category/tools.js", "orderPinnedTopics"),
      symbol(rootPath, "src/socket.io/topics/tools.js", "SocketTopics.orderPinnedTopics"),
      symbol(rootPath, "src/topics/tools.js", "topicTools.orderPinnedTopics"),
      symbol(rootPath, "public/src/admin/dashboard/topics.js", "renderTopics"),
      symbol(rootPath, "src/privileges/topics.js", "canModerate")
    ];
    const chunks = [
      chunk(rootPath, "public/src/client/category/tools.js", "orderPinnedTopics", "client drag reorder pinned topics category socket emit target position"),
      chunk(rootPath, "src/socket.io/topics/tools.js", "SocketTopics.orderPinnedTopics", "socket order pinned topics moderator admin privileges"),
      chunk(rootPath, "src/topics/tools.js", "topicTools.orderPinnedTopics", "pinned topic ordering sorted set category membership no-op unpinned topic"),
      chunk(rootPath, "public/src/admin/dashboard/topics.js", "renderTopics", "admin dashboard topic statistics"),
      chunk(rootPath, "src/privileges/topics.js", "canModerate", "topic privileges moderator admin")
    ];
    const query = [
      "Reordering pinned topics does not respect privileges, no-op behavior for unpinned topics, and category isolation.",
      "Fix topic pinned ordering through the client, socket, and production topic tool flow."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 3).map((result) => result.path)).toEqual([
      "src/topics/tools.js",
      "src/socket.io/topics/tools.js",
      "public/src/client/category/tools.js"
    ]);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("public/src/admin/dashboard/topics.js");
  });

  it("routes collection name validation tasks to loader and dependency metadata owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/ansible/utils/collection_loader/_collection_finder.py", "source", "python"),
      file(rootPath, "lib/ansible/galaxy/dependency_resolution/dataclasses.py", "source", "python"),
      file(rootPath, "lib/ansible/galaxy/collection/__init__.py", "source", "python"),
      file(rootPath, "lib/ansible/utils/galaxy.py", "source", "python")
    ];
    const symbols = [
      symbol(rootPath, "lib/ansible/utils/collection_loader/_collection_finder.py", "is_valid_collection_name"),
      symbol(rootPath, "lib/ansible/galaxy/dependency_resolution/dataclasses.py", "_is_fqcn"),
      symbol(rootPath, "lib/ansible/galaxy/collection/__init__.py", "CollectionRequirement"),
      symbol(rootPath, "lib/ansible/utils/galaxy.py", "GalaxyAPI")
    ];
    const chunks = [
      chunk(rootPath, "lib/ansible/utils/collection_loader/_collection_finder.py", "is_valid_collection_name", "collection name validation namespace collection Python identifier keyword"),
      chunk(rootPath, "lib/ansible/galaxy/dependency_resolution/dataclasses.py", "_is_fqcn", "FQCN validation Python keyword _is_py_id _is_fqcn collection namespace"),
      chunk(rootPath, "lib/ansible/galaxy/collection/__init__.py", "CollectionRequirement", "galaxy collection install artifact"),
      chunk(rootPath, "lib/ansible/utils/galaxy.py", "GalaxyAPI", "galaxy API helper")
    ];
    const query = [
      "Collection Name Validation Accepts Python Keywords.",
      "Fully Qualified Collection Names should reject namespace or collection segments that are Python reserved keywords."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path).sort()).toEqual([
      "lib/ansible/galaxy/dependency_resolution/dataclasses.py",
      "lib/ansible/utils/collection_loader/_collection_finder.py"
    ]);
    expect(results.slice(0, 2).map((result) => result.path)).not.toContain("lib/ansible/galaxy/collection/__init__.py");
  });

  it("routes gRPC context error policy tasks to command and middleware owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "internal/cmd/grpc.go", "source", "go"),
      file(rootPath, "internal/server/auth/middleware.go", "source", "go"),
      file(rootPath, "internal/server/middleware/grpc/middleware.go", "source", "go"),
      file(rootPath, "errors/errors.go", "source", "go"),
      file(rootPath, "internal/server/segment.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "internal/cmd/grpc.go", "serveGRPC"),
      symbol(rootPath, "internal/server/auth/middleware.go", "UnaryServerInterceptor"),
      symbol(rootPath, "internal/server/middleware/grpc/middleware.go", "ErrorHandler"),
      symbol(rootPath, "errors/errors.go", "Error"),
      symbol(rootPath, "internal/server/segment.go", "Segment")
    ];
    const chunks = [
      chunk(rootPath, "internal/cmd/grpc.go", "serveGRPC", "grpc server status code middleware context cancellation"),
      chunk(rootPath, "internal/server/auth/middleware.go", "UnaryServerInterceptor", "authentication middleware unauthenticated context canceled deadline exceeded"),
      chunk(rootPath, "internal/server/middleware/grpc/middleware.go", "ErrorHandler", "gRPC middleware maps context.Canceled to codes.Canceled and context.DeadlineExceeded"),
      chunk(rootPath, "errors/errors.go", "Error", "domain errors internal error values"),
      chunk(rootPath, "internal/server/segment.go", "Segment", "segment evaluation")
    ];
    const query = [
      "Context cancellation and deadline exceeded errors are incorrectly classified as Internal or Unauthenticated in gRPC responses.",
      "Return Canceled and DeadlineExceeded from middleware/authentication when errors wrap context.Canceled or context.DeadlineExceeded."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 3).map((result) => result.path)).toEqual([
      "internal/cmd/grpc.go",
      "internal/server/auth/middleware.go",
      "internal/server/middleware/grpc/middleware.go"
    ]);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("errors/errors.go");
  });

  it("routes HTTP netrc authorization policy tasks to URL helpers and modules", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/ansible/module_utils/urls.py", "source", "python"),
      file(rootPath, "lib/ansible/modules/uri.py", "source", "python"),
      file(rootPath, "lib/ansible/modules/get_url.py", "source", "python"),
      file(rootPath, "lib/ansible/plugins/lookup/url.py", "source", "python"),
      file(rootPath, "lib/ansible/plugins/action/uri.py", "source", "python"),
      file(rootPath, "lib/ansible/executor/interpreter_discovery.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/basic.py", "source", "python")
    ];
    const symbols = [
      symbol(rootPath, "lib/ansible/module_utils/urls.py", "open_url"),
      symbol(rootPath, "lib/ansible/modules/uri.py", "main"),
      symbol(rootPath, "lib/ansible/modules/get_url.py", "main"),
      symbol(rootPath, "lib/ansible/plugins/lookup/url.py", "run"),
      symbol(rootPath, "lib/ansible/plugins/action/uri.py", "run"),
      symbol(rootPath, "lib/ansible/executor/interpreter_discovery.py", "discover_interpreter"),
      symbol(rootPath, "lib/ansible/module_utils/basic.py", "AnsibleModule")
    ];
    const chunks = [
      chunk(rootPath, "lib/ansible/module_utils/urls.py", "open_url", "Request.open open_url Authorization header netrc use_netrc HTTP request"),
      chunk(rootPath, "lib/ansible/modules/uri.py", "main", "uri module headers Authorization bearer use_netrc parameter"),
      chunk(rootPath, "lib/ansible/modules/get_url.py", "main", "get_url module URL request netrc use_netrc"),
      chunk(rootPath, "lib/ansible/plugins/lookup/url.py", "run", "lookup url plugin open_url netrc Authorization headers"),
      chunk(rootPath, "lib/ansible/plugins/action/uri.py", "run", "uri action plugin open_url netrc Authorization headers"),
      chunk(rootPath, "lib/ansible/executor/interpreter_discovery.py", "discover_interpreter", "python interpreter discovery"),
      chunk(rootPath, "lib/ansible/module_utils/basic.py", "AnsibleModule", "basic module argument parsing")
    ];
    const query = [
      "uri module uses .netrc to overwrite Authorization header even if specified.",
      "Add use_netrc to Request.open and open_url, default enabled, and forward it through uri, get_url, and url lookup."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 4).map((result) => result.path)).toEqual([
      "lib/ansible/module_utils/urls.py",
      "lib/ansible/modules/uri.py",
      "lib/ansible/modules/get_url.py",
      "lib/ansible/plugins/lookup/url.py"
    ]);
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("lib/ansible/executor/interpreter_discovery.py");
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("lib/ansible/plugins/action/uri.py");
  });

  it("routes Linux system metadata extraction tasks to inventory metadata owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/inventory/metadata/metadata_linux.go", "source", "go"),
      file(rootPath, "lib/inventory/metadata/metadata.go", "source", "go"),
      file(rootPath, "lib/inventory/metadata/get.go", "source", "go"),
      file(rootPath, "lib/config/systemd.go", "source", "go"),
      file(rootPath, "lib/utils/parse/parse.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "lib/inventory/metadata/metadata_linux.go", "DMIInfo"),
      symbol(rootPath, "lib/inventory/metadata/metadata.go", "Metadata"),
      symbol(rootPath, "lib/inventory/metadata/get.go", "Get"),
      symbol(rootPath, "lib/config/systemd.go", "SystemdFlags"),
      symbol(rootPath, "lib/utils/parse/parse.go", "ParseBool")
    ];
    const chunks = [
      chunk(rootPath, "lib/inventory/metadata/metadata_linux.go", "DMIInfo", "DMIInfoFromFS sysfs /sys/class/dmi/id product_name product_serial board_serial chassis_asset_tag OSRelease ParseOSRelease /etc/os-release"),
      chunk(rootPath, "lib/inventory/metadata/metadata.go", "Metadata", "inventory metadata API device metadata operating system distribution"),
      chunk(rootPath, "lib/inventory/metadata/get.go", "Get", "retrieve inventory metadata from platform metadata providers"),
      chunk(rootPath, "lib/config/systemd.go", "SystemdFlags", "systemd unit file environment pid file file descriptor limit"),
      chunk(rootPath, "lib/utils/parse/parse.go", "ParseBool", "generic parse helper strconv")
    ];
    const query = [
      "Add utility functions for extracting Linux system metadata.",
      "Read DMI fields from /sys/class/dmi/id and parse /etc/os-release into OSRelease fields while handling partial errors."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 3).map((result) => result.path)).toEqual([
      "lib/inventory/metadata/metadata_linux.go",
      "lib/inventory/metadata/metadata.go",
      "lib/inventory/metadata/get.go"
    ]);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("lib/config/systemd.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("lib/utils/parse/parse.go");
  });

  it("routes database service failover tasks to proxy, type, tunnel, and CLI owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "api/types/databaseserver.go", "source", "go"),
      file(rootPath, "lib/srv/db/proxyserver.go", "source", "go"),
      file(rootPath, "lib/reversetunnel/fake.go", "source", "go"),
      file(rootPath, "lib/reversetunnel/agent.go", "source", "go"),
      file(rootPath, "tool/tsh/db.go", "source", "go"),
      file(rootPath, "lib/events/auditlog.go", "source", "go"),
      file(rootPath, "lib/session/session.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "api/types/databaseserver.go", "DatabaseServerV3"),
      symbol(rootPath, "lib/srv/db/proxyserver.go", "ProxyServerConfig"),
      symbol(rootPath, "lib/reversetunnel/fake.go", "FakeRemoteSite"),
      symbol(rootPath, "lib/reversetunnel/agent.go", "Agent"),
      symbol(rootPath, "tool/tsh/db.go", "onListDatabases"),
      symbol(rootPath, "lib/events/auditlog.go", "ServerID"),
      symbol(rootPath, "lib/session/session.go", "ServerID")
    ];
    const chunks = [
      chunk(rootPath, "api/types/databaseserver.go", "SortedDatabaseServers", "DatabaseServerV3 HostID sorted database servers deduplicate database service"),
      chunk(rootPath, "lib/srv/db/proxyserver.go", "ProxyServerConfig", "database proxy server connect candidate servers shuffle retry dial reverse tunnel"),
      chunk(rootPath, "lib/reversetunnel/fake.go", "FakeRemoteSite", "OfflineTunnels ServerID simulate tunnel outage fake remote site"),
      chunk(rootPath, "lib/reversetunnel/agent.go", "Agent", "reverse tunnel agent cluster connection server id keepalive heartbeat"),
      chunk(rootPath, "tool/tsh/db.go", "onListDatabases", "tsh db ls list database services deduplicate display"),
      chunk(rootPath, "lib/events/auditlog.go", "ServerID", "audit event server id"),
      chunk(rootPath, "lib/session/session.go", "ServerID", "session server id")
    ];
    const query = [
      "Better handle HA database access when multiple database services share the same service name.",
      "Proxy should shuffle candidate database servers, retry on tunnel connection failures, deduplicate tsh db ls, and include HostID."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 4).map((result) => result.path)).toEqual([
      "api/types/databaseserver.go",
      "lib/srv/db/proxyserver.go",
      "lib/reversetunnel/fake.go",
      "tool/tsh/db.go"
    ]);
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("lib/events/auditlog.go");
    expect(results.slice(0, 4).map((result) => result.path)).not.toContain("lib/reversetunnel/agent.go");
  });

  it("routes plugin activation identifier validation to activation owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/plugins/install.js", "source", "javascript"),
      file(rootPath, "src/socket.io/admin/plugins.js", "source", "javascript"),
      file(rootPath, "src/flags.js", "source", "javascript"),
      file(rootPath, "public/src/admin/extend/plugins.js", "source", "javascript"),
      file(rootPath, "public/src/client/topic.js", "source", "javascript")
    ];
    const symbols = [
      symbol(rootPath, "src/plugins/install.js", "Plugins.toggleActive"),
      symbol(rootPath, "src/socket.io/admin/plugins.js", "Plugins.toggleActive"),
      symbol(rootPath, "src/flags.js", "Flags"),
      symbol(rootPath, "public/src/admin/extend/plugins.js", "toggleActive"),
      symbol(rootPath, "public/src/client/topic.js", "Topic")
    ];
    const chunks = [
      chunk(rootPath, "src/plugins/install.js", "Plugins.toggleActive", "Plugins.toggleActive activate deactivate plugin id invalid-plugin-id validation before state changes"),
      chunk(rootPath, "src/socket.io/admin/plugins.js", "Plugins.toggleActive", "admin.plugins.toggleActive socket plugin activation request"),
      chunk(rootPath, "src/flags.js", "Flags", "validation helpers error handling invalid identifiers"),
      chunk(rootPath, "public/src/admin/extend/plugins.js", "toggleActive", "admin UI emits admin.plugins.toggleActive"),
      chunk(rootPath, "public/src/client/topic.js", "Topic", "topic page navigation posts")
    ];
    const query = [
      "Plugin activation accepts invalid plugin identifiers without validation.",
      "Validate plugin identifiers during Plugins.toggleActive and reject malformed names with [[error:invalid-plugin-id]]."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("src/plugins/install.js");
    expect(results.slice(0, 3).map((result) => result.path)).toEqual(expect.arrayContaining([
      "src/socket.io/admin/plugins.js",
      "src/flags.js"
    ]));
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("public/src/client/topic.js");
  });

  it("routes execution state migrations to iterator and strategy owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "lib/ansible/executor/play_iterator.py", "source", "python"),
      file(rootPath, "lib/ansible/plugins/strategy/__init__.py", "source", "python"),
      file(rootPath, "lib/ansible/plugins/strategy/linear.py", "source", "python"),
      file(rootPath, "lib/ansible/plugins/strategy/debug.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/common/parameters.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/common/warnings.py", "source", "python"),
      file(rootPath, "lib/ansible/module_utils/basic.py", "source", "python"),
      file(rootPath, "lib/ansible/utils/display.py", "source", "python")
    ];
    const symbols = [
      symbol(rootPath, "lib/ansible/executor/play_iterator.py", "PlayIterator"),
      symbol(rootPath, "lib/ansible/executor/play_iterator.py", "HostState"),
      symbol(rootPath, "lib/ansible/executor/play_iterator.py", "IteratingStates"),
      symbol(rootPath, "lib/ansible/executor/play_iterator.py", "FailedStates"),
      symbol(rootPath, "lib/ansible/plugins/strategy/__init__.py", "StrategyBase"),
      symbol(rootPath, "lib/ansible/plugins/strategy/linear.py", "StrategyModule"),
      symbol(rootPath, "lib/ansible/plugins/strategy/debug.py", "StrategyModule"),
      symbol(rootPath, "lib/ansible/module_utils/common/parameters.py", "validate_argument_spec"),
      symbol(rootPath, "lib/ansible/module_utils/common/warnings.py", "deprecate"),
      symbol(rootPath, "lib/ansible/module_utils/basic.py", "AnsibleModule"),
      symbol(rootPath, "lib/ansible/utils/display.py", "Display")
    ];
    const chunks = [
      chunk(rootPath, "lib/ansible/executor/play_iterator.py", "PlayIterator", "PlayIterator HostState run_state fail_state ITERATING_TASKS FAILED_SETUP IteratingStates FailedStates MetaPlayIterator"),
      chunk(rootPath, "lib/ansible/plugins/strategy/__init__.py", "StrategyBase", "strategy plugin checks PlayIterator ITERATING_TASKS and failure states during task execution"),
      chunk(rootPath, "lib/ansible/plugins/strategy/linear.py", "StrategyModule", "linear strategy compares host run_state rescue always complete"),
      chunk(rootPath, "lib/ansible/plugins/strategy/debug.py", "StrategyModule", "debug strategy plugin displays task state"),
      chunk(rootPath, "lib/ansible/module_utils/common/parameters.py", "validate_argument_spec", "argument spec validation deprecated aliases removed in version"),
      chunk(rootPath, "lib/ansible/module_utils/common/warnings.py", "deprecate", "display deprecation warning messages"),
      chunk(rootPath, "lib/ansible/module_utils/basic.py", "AnsibleModule", "basic module argument spec and deprecation helpers"),
      chunk(rootPath, "lib/ansible/utils/display.py", "Display", "display warnings and deprecation messages")
    ];
    const query = [
      "Standardize PlayIterator state representation with public IteratingStates and FailedStates enums.",
      "Preserve legacy constants, instance attribute access, HostState string output, and third-party strategy plugin compatibility."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 3).map((result) => result.path)).toEqual(expect.arrayContaining([
      "lib/ansible/executor/play_iterator.py",
      "lib/ansible/plugins/strategy/__init__.py",
      "lib/ansible/plugins/strategy/linear.py"
    ]));
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("lib/ansible/module_utils/common/parameters.py");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("lib/ansible/module_utils/common/warnings.py");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("lib/ansible/module_utils/basic.py");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("lib/ansible/plugins/strategy/debug.py");
  });

  it("routes converter output bugs to converter implementation over scanner dispatch", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "contrib/trivy/pkg/converter.go", "source", "go"),
      file(rootPath, "scanner/scanner.go", "source", "go"),
      file(rootPath, "scanner/trivy/jar/parse.go", "source", "go"),
      file(rootPath, "storage/backend.go", "source", "go")
    ];
    const symbols = [
      symbol(rootPath, "contrib/trivy/pkg/converter.go", "Convert"),
      symbol(rootPath, "scanner/scanner.go", "Detect"),
      symbol(rootPath, "scanner/trivy/jar/parse.go", "Parse"),
      symbol(rootPath, "storage/backend.go", "Store")
    ];
    const chunks = [
      chunk(rootPath, "contrib/trivy/pkg/converter.go", "Convert", "Trivy to Vuls converter output cveContents severity Debian records JSON findings"),
      chunk(rootPath, "scanner/scanner.go", "Detect", "scanner dispatch package vulnerability detection source packages"),
      chunk(rootPath, "scanner/trivy/jar/parse.go", "Parse", "Trivy jar parser package details"),
      chunk(rootPath, "storage/backend.go", "Store", "storage backend vulnerability records")
    ];
    const query = [
      "Fix the trivy-to-vuls converter output.",
      "cveContents should not duplicate Debian severity records when conversion builds Vuls JSON findings."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("contrib/trivy/pkg/converter.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("scanner/scanner.go");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("storage/backend.go");
  });

  it("routes device session notification ownership to listener source over UI shells", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/DeviceListener.ts", "source", "typescript"),
      file(rootPath, "src/components/views/settings/devices/OtherSessionsSectionHeading.tsx", "component", "typescript"),
      file(rootPath, "src/toasts/BulkUnverifiedSessionsToast.ts", "source", "typescript"),
      file(rootPath, "src/models/Call.ts", "source", "typescript"),
      file(rootPath, "src/stores/notifications/NotificationState.ts", "source", "typescript")
    ];
    const symbols = [
      symbol(rootPath, "src/DeviceListener.ts", "DeviceListener"),
      symbol(rootPath, "src/components/views/settings/devices/OtherSessionsSectionHeading.tsx", "OtherSessionsSectionHeading"),
      symbol(rootPath, "src/toasts/BulkUnverifiedSessionsToast.ts", "BulkUnverifiedSessionsToast"),
      symbol(rootPath, "src/models/Call.ts", "Call"),
      symbol(rootPath, "src/stores/notifications/NotificationState.ts", "NotificationState")
    ];
    const chunks = [
      chunk(rootPath, "src/DeviceListener.ts", "DeviceListener", "device listener handles unverified sessions notification state after key download startup existing sessions new sessions"),
      chunk(rootPath, "src/components/views/settings/devices/OtherSessionsSectionHeading.tsx", "OtherSessionsSectionHeading", "settings devices heading other sessions UI"),
      chunk(rootPath, "src/toasts/BulkUnverifiedSessionsToast.ts", "BulkUnverifiedSessionsToast", "toast UI for bulk unverified sessions"),
      chunk(rootPath, "src/models/Call.ts", "Call", "call model voice room session"),
      chunk(rootPath, "src/stores/notifications/NotificationState.ts", "NotificationState", "notification state store")
    ];
    const query = [
      "Unverified device notifications are inconsistent for existing versus new sessions.",
      "Maintain startup device state and refresh after key downloads in the device/session notification owner."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results[0]?.path).toBe("src/DeviceListener.ts");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("src/components/views/settings/devices/OtherSessionsSectionHeading.tsx");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("src/toasts/BulkUnverifiedSessionsToast.ts");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("src/models/Call.ts");
  });

  it("routes discovery authentication config to discovery and validated config owners", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/utils/AutoDiscoveryUtils.tsx", "source", "typescript"),
      file(rootPath, "src/utils/ValidatedServerConfig.ts", "source", "typescript"),
      file(rootPath, "cypress/support/settings.ts", "source", "typescript"),
      file(rootPath, "src/components/views/settings/ServerSettings.tsx", "component", "typescript")
    ];
    const symbols = [
      symbol(rootPath, "src/utils/AutoDiscoveryUtils.tsx", "AutoDiscovery"),
      symbol(rootPath, "src/utils/ValidatedServerConfig.ts", "ValidatedServerConfig"),
      symbol(rootPath, "cypress/support/settings.ts", "settings"),
      symbol(rootPath, "src/components/views/settings/ServerSettings.tsx", "ServerSettings")
    ];
    const chunks = [
      chunk(rootPath, "src/utils/AutoDiscoveryUtils.tsx", "AutoDiscovery", "homeserver discovery builds validated configuration from m.authentication delegated authentication issuer endpoints account"),
      chunk(rootPath, "src/utils/ValidatedServerConfig.ts", "ValidatedServerConfig", "validated server config public interface delegatedAuthentication optional object issuer token endpoint authorization endpoint"),
      chunk(rootPath, "cypress/support/settings.ts", "settings", "cypress support settings test config"),
      chunk(rootPath, "src/components/views/settings/ServerSettings.tsx", "ServerSettings", "settings screen UI")
    ];
    const query = [
      "Discovery omits delegated authentication metadata advertised under m.authentication.",
      "Preserve delegatedAuthentication fields in the validated server configuration."
    ].join(" ");
    const results = hybridSearch({
      files,
      query,
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 2).map((result) => result.path)).toEqual([
      "src/utils/AutoDiscoveryUtils.tsx",
      "src/utils/ValidatedServerConfig.ts"
    ]);
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("cypress/support/settings.ts");
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("src/components/views/settings/ServerSettings.tsx");
  });

  it("keeps exact C source ahead of vendored dependency surfaces for short identifier prompts", () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "deps/lua/src/lua_cjson.c", "source", "c"),
      file(rootPath, "src/sds.c", "source", "c"),
      file(rootPath, "src/sds.h", "source", "c"),
      file(rootPath, "src/t_string.c", "source", "c")
    ];
    const symbols = [
      symbol(rootPath, "deps/lua/src/lua_cjson.c", "lua_cjson_decode"),
      symbol(rootPath, "src/sds.c", "sdsrange"),
      symbol(rootPath, "src/sds.h", "sds"),
      symbol(rootPath, "src/t_string.c", "setrangeCommand")
    ];
    const chunks = [
      chunk(rootPath, "deps/lua/src/lua_cjson.c", "lua_cjson_decode", "string range JSON decode length"),
      chunk(rootPath, "src/sds.c", "sdsrange", "SDS string range trimming length negative indexes empty ranges"),
      chunk(rootPath, "src/sds.h", "sds", "SDS string header length allocation helpers"),
      chunk(rootPath, "src/t_string.c", "setrangeCommand", "Redis string command setrange getrange SDS range operations")
    ];
    const results = hybridSearch({
      files,
      query: "Debug SDS string range trimming and length update behavior for negative indexes and empty ranges.",
      symbols,
      chunks,
      vectors: chunks.map((record) => vector(rootPath, record)),
      edges: [],
      changedFiles: new Set()
    });

    expect(results.slice(0, 3).map((result) => result.path)).toEqual(
      expect.arrayContaining(["src/sds.c", "src/sds.h"])
    );
    expect(results.slice(0, 3).map((result) => result.path)).not.toContain("deps/lua/src/lua_cjson.c");
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

function file(rootPath: string, filePath: string, kind: FileRecord["kind"], language = "typescript"): FileRecord {
  return {
    rootPath,
    path: filePath,
    language,
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

function tanStackHashFixture(): {
  files: FileRecord[];
  symbols: SymbolRecord[];
  chunks: SemanticChunkRecord[];
  vectors: SemanticVectorRecord[];
  edges: GraphEdgeRecord[];
} {
  const rootPath = "/repo";
  const files = [
    file(rootPath, "packages/query-core/src/utils.ts", "source"),
    file(rootPath, "packages/query-core/src/__tests__/utils.test.tsx", "test"),
    file(rootPath, "packages/react-query/src/__tests__/useQuery.test.tsx", "test"),
    file(rootPath, "packages/preact-query/src/__tests__/useQuery.test.tsx", "test"),
    file(rootPath, "packages/query-core/src/query.ts", "source")
  ];
  const symbols = [
    symbol(rootPath, "packages/query-core/src/utils.ts", "hashKey"),
    symbol(rootPath, "packages/query-core/src/utils.ts", "hashQueryKeyByOptions"),
    symbol(rootPath, "packages/query-core/src/utils.ts", "partialMatchKey"),
    symbol(rootPath, "packages/query-core/src/query.ts", "Query"),
    symbol(rootPath, "packages/react-query/src/__tests__/useQuery.test.tsx", "useQuery"),
    symbol(rootPath, "packages/preact-query/src/__tests__/useQuery.test.tsx", "useQuery")
  ];
  const chunks = [
    chunk(
      rootPath,
      "packages/query-core/src/utils.ts",
      "hashKey",
      "Default query and mutation keys hash function. Hashes the value into a stable hash. Object.keys(val).sort().reduce object key order stable consistently."
    ),
    chunk(
      rootPath,
      "packages/query-core/src/utils.ts",
      "partialMatchKey",
      "Checks if key b partially matches with key a for query keys and mutation keys."
    ),
    chunk(
      rootPath,
      "packages/query-core/src/__tests__/utils.test.tsx",
      "hashKey tests",
      "should hash objects with sorted keys consistently same properties different order expect hashKey key1 equals hashKey key2"
    ),
    chunk(
      rootPath,
      "packages/react-query/src/__tests__/useQuery.test.tsx",
      "useQuery",
      "useQuery query client query cache keys options queryFn queryKey many query tests"
    ),
    chunk(
      rootPath,
      "packages/preact-query/src/__tests__/useQuery.test.tsx",
      "useQuery",
      "useQuery query client query cache keys options queryFn queryKey many query tests"
    ),
    chunk(rootPath, "packages/query-core/src/query.ts", "Query", "query state fetch status observers data errors")
  ];

  return {
    files,
    symbols,
    chunks,
    vectors: chunks.map((record) => vector(rootPath, record)),
    edges: [
      {
        rootPath,
        fromFile: "packages/query-core/src/__tests__/utils.test.tsx",
        toFile: "packages/query-core/src/utils.ts",
        type: "test_for",
        metadata: {}
      }
    ]
  };
}
