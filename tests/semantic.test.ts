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
