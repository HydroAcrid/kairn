import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_EVIDENCE_ARTIFACT,
  EVIDENCE_FEATURE_SCHEMA_HASH,
  predictEvidenceRelevance,
  validateEvidenceRankerArtifact
} from "../src/retrieval/evidenceModel.js";
import { rankEvidenceResults } from "../src/retrieval/evidenceRanker.js";
import {
  buildEvidenceCandidates,
  buildEvidenceRetrievalQueries,
  extractEvidenceTaskSignals,
  selectEvidenceSymbolTerms
} from "../src/retrieval/evidenceSignals.js";
import { scoreFiles } from "../src/retrieval/scoreResults.js";
import type {
  FileKind,
  FileRecord,
  GraphEdgeRecord,
  HybridScoredResult,
  SymbolRecord
} from "../src/types.js";

describe("evidence task signals and candidates", () => {
  it("extracts paths, diagnostics, identifiers, and source intent without fixture identities", () => {
    const signals = extractEvidenceTaskSignals(
      'Debug Billing::settlePayment in pkg/payments.py after File "/repo/pkg/payments.py", line 42 raised ValueError'
    );

    expect(signals.explicitPaths).toEqual(["/repo/pkg/payments.py", "pkg/payments.py"]);
    expect(signals.failureReferences).toEqual(["/repo/pkg/payments.py"]);
    expect(signals.identifiers).toContain("settlepayment");
    expect(signals.identifiers).toContain("billingsettlepayment");
    expect(signals.preferredIdentifiers).toEqual(
      expect.arrayContaining(["settlepayment", "billingsettlepayment", "valueerror"])
    );
    expect(signals.intent).toBe("source");
  });

  it("puts quoted identifiers ahead of code-like and prose fallback terms", () => {
    const signals = extractEvidenceTaskSignals(
      "Investigate commonTerm01 and request handling before repairing `resolveCriticalState`"
    );

    expect(signals.preferredIdentifiers[0]).toBe("resolvecriticalstate");
    expect(signals.preferredIdentifiers).toContain("commonterm01");
    expect(signals.identifiers).toContain("request");
  });

  it("treats failing-check bug reports as production-source intent", () => {
    const signals = extractEvidenceTaskSignals(
      "Initial failing checks: TestNeighborPages. Bug: adjacent sections return incorrect pages."
    );

    expect(signals.preferredIdentifiers[0]).toBe("testneighborpages");
    expect(signals.failureIdentifiers).toEqual(["testneighborpages"]);
    expect(signals.intent).toBe("source");
  });

  it("keeps a named failing check ahead of noisy log identifiers", () => {
    const noisyLog = Array.from({ length: 80 }, (_, index) => `responseField${index}: value${index}`).join("\n");
    const signals = extractEvidenceTaskSignals([
      "Initial failing checks:",
      "- TestCookieFilter",
      "Unable to redact a Cookie field from request logs",
      noisyLog
    ].join("\n"));

    expect(signals.preferredIdentifiers[0]).toBe("testcookiefilter");
    expect(signals.failureIdentifiers).toEqual(["testcookiefilter"]);
    expect(signals.preferredIdentifiers.indexOf("testcookiefilter")).toBeLessThan(40);
  });

  it("downgrades a broad failing suite instead of treating every check as hard evidence", () => {
    const broadSuite = Array.from({ length: 9 }, (_, index) => `- TestUnrelated${index}`).join("\n");
    const signals = extractEvidenceTaskSignals([
      "Initial failing checks:",
      broadSuite,
      "Allow `TokenFilter` to preserve empty containers."
    ].join("\n"));

    expect(signals.failureIdentifiers).toEqual([]);
    expect(signals.preferredIdentifiers[0]).toBe("tokenfilter");
    expect(signals.preferredIdentifiers).not.toContain("testunrelated0");
    expect(signals.queryTerms).not.toContain("testunrelated0");
  });

  it("keeps issue templates, URLs, code fences, and string data out of the focused retrieval query", () => {
    const query = [
      "Parser drops the final production segment",
      "<!-- Please include a reproduction -->",
      "See https://example.invalid/reports/VeryNoisyIdentifier",
      "```ts",
      "const request = 'notASymbol';",
      "```",
      "Repair `SegmentParser` without changing the public API."
    ].join("\n");
    const retrievalQueries = buildEvidenceRetrievalQueries(query);
    const signals = extractEvidenceTaskSignals(query);

    expect(retrievalQueries[0]).toContain("Parser drops the final production segment");
    expect(retrievalQueries[0]).not.toContain("notASymbol");
    expect(retrievalQueries.join(" ")).not.toContain("VeryNoisyIdentifier");
    expect(signals.preferredIdentifiers[0]).toBe("segmentparser");
    expect(signals.preferredIdentifiers).not.toContain("notasymbol");
  });

  it("balances symbol lookup terms so long code output cannot crowd out the task narrative", () => {
    const noisyOutput = Array.from({ length: 80 }, (_, index) => `UIWidgetState${index}`).join(" ");
    const signals = extractEvidenceTaskSignals([
      "Recursive discovery ignores configured ignore paths.",
      "Output:",
      noisyOutput
    ].join("\n"));
    const selected = selectEvidenceSymbolTerms(signals, 12);

    expect(selected).toContain("recursive");
    expect(selected).toContain("ignore");
    expect(selected.filter((term) => term.startsWith("uiwidgetstate")).length).toBeLessThan(8);
  });

  it("gives concise structured prompts extra bounded symbol capacity", () => {
    const signals = extractEvidenceTaskSignals("Resolve a delayed policy lookup");
    signals.preferredIdentifiers = Array.from({ length: 12 }, (_, index) => `preferred${index}`);
    signals.queryTerms = Array.from({ length: 12 }, (_, index) => `query${index}`);
    signals.identifiers = Array.from({ length: 12 }, (_, index) => `general${index}`);

    const selected = selectEvidenceSymbolTerms(signals, 24);

    expect(selected).toContain("preferred10");
    expect(selected).toContain("query4");
    expect(selected).toContain("general4");
  });

  it("does not let repeated prompt terms inflate path scores", () => {
    const root = "/repo";
    const source = file(root, "src/widget-state.ts", "source", 200);
    const once = scoreFiles([source], "widget state");
    const repeated = scoreFiles([source], "widget widget widget state state");

    expect(repeated[0]?.score).toBe(once[0]?.score);
    expect(repeated[0]?.reasons).toEqual(once[0]?.reasons);
  });

  it("reserves hard candidate capacity for an exact failing-check symbol", () => {
    const root = "/repo";
    const failingTest = file(root, "pkg/filter_test.go", "test", 400);
    const production = file(root, "pkg/filter.go", "source", 800);
    const distractors = Array.from({ length: 90 }, (_, index) =>
      file(root, `src/common-${String(index).padStart(3, "0")}.go`, "source", 9_000)
    );
    const candidates = buildEvidenceCandidates({
      files: [...distractors, failingTest, production],
      query: [
        "Initial failing checks:",
        "- TestCookieFilter",
        ...distractors.map((_, index) => `CommonSymbol${index}`)
      ].join("\n"),
      symbols: [
        symbol(root, failingTest.path, "TestCookieFilter"),
        ...distractors.map((record, index) => symbol(root, record.path, `CommonSymbol${index}`))
      ],
      edges: [edge(root, failingTest.path, production.path, "test_for")],
      legacyResults: [],
      initialLimit: 64,
      enrichedLimit: 128
    });

    const failingCandidate = candidates.candidates.find((candidate) => candidate.path === failingTest.path);
    const sourceCandidate = candidates.candidates.find((candidate) => candidate.path === production.path);
    expect(failingCandidate?.reasons).toEqual(expect.arrayContaining(["failure_reference", "exact_symbol"]));
    expect(failingCandidate?.features.failureReference).toBe(1);
    expect(sourceCandidate?.reasons).toEqual(expect.arrayContaining(["graph_neighbor", "source_test_pair"]));
  });

  it("keeps task source symbols in the bounded union when a broad suite is listed", () => {
    const root = "/repo";
    const source = file(root, "src/TokenFilter.java", "source", 200);
    const failingTests = Array.from({ length: 70 }, (_, index) =>
      file(root, `src/test/TestUnrelated${String(index).padStart(2, "0")}.java`, "test", 20_000)
    );
    const candidates = buildEvidenceCandidates({
      files: [...failingTests, source],
      query: [
        "Initial failing checks:",
        ...failingTests.map((_, index) => `- TestUnrelated${String(index).padStart(2, "0")}`),
        "Allow `TokenFilter` to preserve empty containers."
      ].join("\n"),
      symbols: [
        symbol(root, source.path, "TokenFilter"),
        ...failingTests.map((record, index) => symbol(root, record.path, `TestUnrelated${String(index).padStart(2, "0")}`))
      ],
      edges: [],
      legacyResults: [],
      initialLimit: 64,
      enrichedLimit: 64
    });

    expect(candidates.signals.failureIdentifiers).toEqual([]);
    expect(candidates.candidates[0]?.path).toBe(source.path);
    expect(candidates.candidates[0]?.reasons).toContain("exact_symbol");
  });

  it("orders exact-symbol candidates by task identifier strength before file importance", () => {
    const root = "/repo";
    const target = file(root, "src/critical.ts", "source", 200);
    const distractors = Array.from({ length: 90 }, (_, index) =>
      file(root, `src/common-${String(index).padStart(3, "0")}.ts`, "source", 20_000)
    );
    const candidates = buildEvidenceCandidates({
      files: [...distractors, target],
      query: `Investigate ${distractors.map((_, index) => `CommonSymbol${index}`).join(" ")} before repairing \`resolveCriticalState\``,
      symbols: [
        symbol(root, target.path, "resolveCriticalState"),
        ...distractors.map((record, index) => symbol(root, record.path, `CommonSymbol${index}`))
      ],
      edges: [],
      legacyResults: [],
      initialLimit: 64,
      enrichedLimit: 64
    });

    expect(candidates.candidates[0]?.path).toBe(target.path);
    expect(candidates.candidates[0]?.reasons).toContain("exact_symbol");
  });

  it("does not promote ordinary prose words to exact-symbol evidence", () => {
    const root = "/repo";
    const source = file(root, "src/request.ts", "source", 900);
    const candidates = buildEvidenceCandidates({
      files: [source],
      query: "Investigate request behavior",
      symbols: [symbol(root, source.path, "request")],
      edges: [],
      legacyResults: []
    });

    expect(candidates.candidates[0]?.reasons).not.toContain("exact_symbol");
  });

  it("reserves candidate capacity for lexically matched production source", () => {
    const root = "/repo";
    const source = file(root, "src/parser.ts", "source", 900);
    const documentation = Array.from({ length: 80 }, (_, index) =>
      file(root, `docs/parser-${String(index).padStart(3, "0")}.md`, "doc", 700)
    );
    const candidates = buildEvidenceCandidates({
      files: [...documentation, source],
      query: "Bug: the request parser returns incorrect output",
      symbols: [],
      edges: [],
      legacyResults: [
        ...documentation.map((record, index) => scored(record, { bm25Score: 100 - index })),
        scored(source, { bm25Score: 0.1 })
      ],
      initialLimit: 64,
      enrichedLimit: 64
    });

    const initial = candidates.candidates.map((candidate) => candidate.path);
    expect(initial).toContain(source.path);
    expect(candidates.candidates.find((candidate) => candidate.path === source.path)?.reasons).toEqual(
      expect.arrayContaining(["lexical", "production_source", "role_match"])
    );
  });

  it("promotes a direct production import from a strong seed into candidate@64", () => {
    const root = "/repo";
    const seed = file(root, "src/entry.ts", "source", 900);
    const dependency = file(root, "src/zzzz-dependency.ts", "source", 300);
    const distractors = Array.from({ length: 80 }, (_, index) =>
      file(root, `src/entry-noise-${String(index).padStart(3, "0")}.ts`, "source", 900)
    );
    const candidates = buildEvidenceCandidates({
      files: [seed, dependency, ...distractors],
      query: "Fix the production implementation in src/entry.ts",
      symbols: [],
      edges: [edge(root, seed.path, dependency.path, "imports")],
      legacyResults: [
        scored(seed, { bm25Score: 100 }),
        ...distractors.map((record, index) => scored(record, { bm25Score: 90 - index / 100 }))
      ],
      initialLimit: 64,
      enrichedLimit: 128
    });

    const directImport = candidates.candidates.find((candidate) => candidate.path === dependency.path);
    expect(candidates.candidates.slice(0, 64).map((candidate) => candidate.path)).toContain(dependency.path);
    expect(directImport?.reasons).toContain("graph_neighbor");
  });

  it("does not displace a retrieval-backed import while promoting direct imports", () => {
    const root = "/repo";
    const seeds = Array.from({ length: 80 }, (_, index) =>
      file(root, `packages/seed-${String(index).padStart(3, "0")}/index.ts`, "source", 900)
    );
    const retrievalBacked = file(root, "shared/retrieval-backed.ts", "source", 300);
    const directImports = Array.from({ length: 20 }, (_, index) =>
      file(root, `shared/direct-import-${String(index).padStart(3, "0")}.ts`, "source", 300)
    );
    const candidates = buildEvidenceCandidates({
      files: [...seeds, retrievalBacked, ...directImports],
      query: "Fix the production seed regression",
      symbols: [],
      edges: [
        edge(root, seeds[0]!.path, retrievalBacked.path, "imports"),
        ...directImports.map((dependency, index) =>
          edge(root, seeds[index + 1]!.path, dependency.path, "imports")
        )
      ],
      legacyResults: [
        ...seeds.map((record, index) => scored(record, { bm25Score: 200 - index })),
        scored(retrievalBacked, { bm25Score: 100 })
      ],
      initialLimit: 64,
      enrichedLimit: 128
    });

    expect(candidates.candidates.slice(0, 64).map((candidate) => candidate.path)).toContain(retrievalBacked.path);
    expect(candidates.candidates.find((candidate) => candidate.path === retrievalBacked.path)?.reasons)
      .toContain("graph_neighbor");
  });

  it("keeps most source-intent candidate capacity for retrieved production files", () => {
    const root = "/repo";
    const production = Array.from({ length: 80 }, (_, index) =>
      file(root, `src/service-${String(index).padStart(3, "0")}.ts`, "source", 900)
    );
    const tests = Array.from({ length: 24 }, (_, index) =>
      file(root, `tests/service-${String(index).padStart(3, "0")}.test.ts`, "test", 900)
    );
    const candidates = buildEvidenceCandidates({
      files: [...production, ...tests],
      query: "Debug the production service regression",
      symbols: [],
      edges: [],
      legacyResults: [
        ...tests.map((record, index) => scored(record, { bm25Score: 200 - index })),
        ...production.map((record, index) => scored(record, { bm25Score: 100 - index }))
      ],
      initialLimit: 64,
      enrichedLimit: 64
    });

    expect(candidates.candidates.filter((candidate) => candidate.features.productionSource === 1).length)
      .toBeGreaterThanOrEqual(56);
  });

  it("retains multiple rounds of independent evidence under source intent", () => {
    const root = "/repo";
    const roleLeaders = Array.from({ length: 80 }, (_, index) =>
      file(root, `src/service-${String(index).padStart(3, "0")}.ts`, "source", 900)
    );
    const basenameMatches = Array.from({ length: 3 }, (_, index) =>
      file(root, `packages/module-${index}/shared.ts`, "source", 900)
    );
    const candidates = buildEvidenceCandidates({
      files: [...roleLeaders, ...basenameMatches],
      query: "Fix shared.ts in production",
      symbols: [],
      edges: [],
      legacyResults: [
        ...roleLeaders.map((record, index) => scored(record, { bm25Score: 200 - index })),
        ...basenameMatches.map((record, index) => scored(record, { bm25Score: 3 - index }))
      ],
      initialLimit: 64,
      enrichedLimit: 64
    });

    expect(candidates.candidates.map((candidate) => candidate.path)).toContain(basenameMatches[2]!.path);
  });

  it("treats matching natural-language file stems as bounded basename evidence", () => {
    const root = "/repo";
    const target = file(root, "src/rules/validators.py", "source", 500);
    const distractors = Array.from({ length: 80 }, (_, index) =>
      file(root, `src/service-${String(index).padStart(3, "0")}.py`, "source", 900)
    );
    const candidates = buildEvidenceCandidates({
      files: [...distractors, target],
      query: "Validation errors from validators omit the provided value",
      symbols: [],
      edges: [],
      legacyResults: distractors.map((record, index) => scored(record, { bm25Score: 200 - index })),
      initialLimit: 64,
      enrichedLimit: 64
    });

    expect(candidates.candidates.find((candidate) => candidate.path === target.path)?.reasons)
      .toContain("basename");
  });

  it("reserves a small production lane for cross-extension file-stem evidence", () => {
    const root = "/repo";
    const target = file(root, "src/request-normalizer.ts", "source", 300);
    const fixtures = Array.from({ length: 8 }, (_, index) =>
      file(root, `test/fixture-${index}/request-normalizer.js`, "test", 900)
    );
    const candidates = buildEvidenceCandidates({
      files: [...fixtures, target],
      query: "Failure at /installed/package/lib/request-normalizer.js:20:4",
      symbols: [],
      edges: [],
      legacyResults: fixtures.map((record, index) => scored(record, { bm25Score: 20 - index })),
      initialLimit: 4,
      enrichedLimit: 4
    });

    expect(candidates.candidates.map((candidate) => candidate.path)).toContain(target.path);
  });

  it("does not infer filename stems from fenced reproduction code", () => {
    const root = "/repo";
    const codeOnlyMatch = file(root, "src/throwable-supplier.ts", "source", 500);
    const candidates = buildEvidenceCandidates({
      files: [codeOnlyMatch],
      query: [
        "Compiler loses type information for local values.",
        "```java",
        "interface ThrowableSupplier<T> { T apply(); }",
        "```"
      ].join("\n"),
      symbols: [],
      edges: [],
      legacyResults: [],
      initialLimit: 8,
      enrichedLimit: 8
    });

    expect(candidates.candidates.find((candidate) => candidate.path === codeOnlyMatch.path)?.reasons)
      .not.toContain("basename");
  });

  it("does not let an ambiguous basename consume the exact-path budget", () => {
    const root = "/repo";
    const source = file(root, "packages/parser/src/parser/expression.js", "source", 900);
    const packageFiles = Array.from({ length: 80 }, (_, index) =>
      file(root, `packages/module-${String(index).padStart(3, "0")}/package.json`, "config", 400)
    );
    const candidates = buildEvidenceCandidates({
      files: [...packageFiles, source],
      query: "Bug: expression parsing fails when package.json config is present",
      symbols: [],
      edges: [],
      legacyResults: [
        ...packageFiles.map((record, index) => scored(record, { bm25Score: 100 - index })),
        scored(source, { bm25Score: 0.1 })
      ],
      initialLimit: 64,
      enrichedLimit: 64
    });

    expect(candidates.candidates.map((candidate) => candidate.path)).toContain(source.path);
    expect(candidates.candidates
      .filter((candidate) => candidate.path.endsWith("package.json"))
      .every((candidate) => !candidate.reasons.includes("exact_path"))).toBe(true);
  });

  it("builds a bounded, one-hop candidate union and typed feature vectors", () => {
    const root = "/repo";
    const source = file(root, "pkg/payments.py", "source", 2400);
    const test = file(root, "tests/test_payments.py", "test", 1800);
    const generated = file(root, "generated/payments.py", "source", 3000);
    const candidates = buildEvidenceCandidates({
      files: [source, test, generated],
      query: 'Debug settlePayment: File "/repo/pkg/payments.py", line 42',
      symbols: [symbol(root, source.path, "settlePayment")],
      edges: [edge(root, test.path, source.path, "test_for")],
      legacyResults: [
        scored(source, { bm25Score: 8, keywordScore: 12 }),
        scored(test, { bm25Score: 4 }),
        scored(generated, { keywordScore: 20 })
      ],
      changedFiles: new Set([source.path])
    });

    expect(candidates.candidates.length).toBeLessThanOrEqual(128);
    const sourceCandidate = candidates.candidates.find((candidate) => candidate.path === source.path);
    expect(sourceCandidate?.reasons).toEqual(
      expect.arrayContaining(["failure_reference", "exact_path", "basename", "exact_symbol", "git_diff", "production_source"])
    );
    expect(sourceCandidate?.features.exactPath).toBe(1);
    expect(sourceCandidate?.features.failureReference).toBe(1);
    expect(sourceCandidate?.features.generatedVendor).toBe(0);
    expect(candidates.candidates.find((candidate) => candidate.path === generated.path)?.features.generatedVendor).toBe(1);
  });

  it("preserves an exact inventory-only path while enforcing the 64/128 candidate caps", () => {
    const root = "/repo";
    const target = file(root, "zz-target/shared.ts", "source", 900);
    const basenameMatches = Array.from({ length: 140 }, (_, index) =>
      file(root, `packages/package-${String(index).padStart(3, "0")}/shared.ts`, "source", 700)
    );
    const neighbors = Array.from({ length: 160 }, (_, index) =>
      file(root, `neighbors/neighbor-${String(index).padStart(3, "0")}.ts`, "source", 500)
    );
    const candidates = buildEvidenceCandidates({
      files: [...basenameMatches, ...neighbors, target],
      query: "Fix zz-target/shared.ts in production source",
      // The exact target intentionally has no symbol, lexical, chunk, or
      // semantic evidence: only cheap inventory metadata is available.
      symbols: [],
      legacyResults: [],
      edges: neighbors.map((neighbor) => edge(root, target.path, neighbor.path, "imports")),
      initialLimit: 64,
      enrichedLimit: 128
    });

    expect(candidates.candidates).toHaveLength(128);
    expect(candidates.candidates.slice(0, 64).map((candidate) => candidate.path)).toContain(target.path);
    expect(candidates.candidates.find((candidate) => candidate.path === target.path)?.reasons).toEqual(
      expect.arrayContaining(["exact_path", "basename"])
    );
    expect(candidates.candidates.slice(64).every((candidate) => candidate.reasons.includes("graph_neighbor"))).toBe(true);
  });

  it("round-robins graph enrichment so a high-degree seed cannot starve a precise source/test companion", () => {
    const root = "/repo";
    const highDegreeSeed = file(root, "a/high-degree.ts", "source", 900);
    const laterTestSeed = file(root, "z/service.test.ts", "test", 900);
    const productionCompanion = file(root, "z/service.ts", "source", 900);
    const noisyNeighbors = Array.from({ length: 140 }, (_, index) =>
      file(root, `neighbors/noisy-${String(index).padStart(3, "0")}.ts`, "source", 500)
    );
    const candidates = buildEvidenceCandidates({
      files: [highDegreeSeed, laterTestSeed, productionCompanion, ...noisyNeighbors],
      query: "Debug the high degree and service candidates",
      symbols: [],
      legacyResults: [
        scored(highDegreeSeed, { bm25Score: 12 }),
        scored(laterTestSeed, { bm25Score: 11 })
      ],
      edges: [
        ...noisyNeighbors.map((neighbor) => edge(root, highDegreeSeed.path, neighbor.path, "imports")),
        edge(root, laterTestSeed.path, productionCompanion.path, "test_for")
      ],
      initialLimit: 64,
      enrichedLimit: 128
    });

    expect(candidates.candidates).toHaveLength(128);
    expect(candidates.candidates.find((candidate) => candidate.path === productionCompanion.path)?.reasons).toEqual(
      expect.arrayContaining(["graph_neighbor", "source_test_pair", "production_source"])
    );
    expect(candidates.candidates.slice(0, 64).map((candidate) => candidate.path)).toContain(productionCompanion.path);
  });

  it("promotes a retrieval-backed direct import without promoting arbitrary import fanout", () => {
    const root = "/repo";
    const seed = file(root, "src/router.ts", "source", 900);
    const target = file(root, "src/segment-parser.ts", "source", 800);
    const noise = Array.from({ length: 80 }, (_, index) =>
      file(root, `src/noise-${String(index).padStart(3, "0")}.ts`, "source", 700)
    );
    const candidates = buildEvidenceCandidates({
      files: [seed, target, ...noise],
      query: "Debug malformed segments during routing",
      symbols: [],
      legacyResults: [
        scored(seed, { bm25Score: 1 }),
        scored(target, { bm25Score: 0.4 })
      ],
      edges: [
        edge(root, seed.path, target.path, "imports"),
        ...noise.map((neighbor) => edge(root, seed.path, neighbor.path, "imports"))
      ],
      initialLimit: 1,
      enrichedLimit: 82
    });

    expect(candidates.candidates[0]?.path).toBe(target.path);
    expect(candidates.candidates[0]?.reasons).toContain("graph_neighbor");
    expect(candidates.candidates.slice(0, 1).map((candidate) => candidate.path)).not.toContain(noise[0]!.path);
  });

  it("promotes a retrieval-backed production neighbor from a strong seed package", () => {
    const root = "/repo";
    const seed = file(root, "pkg/service.ts", "source", 900);
    const packageNeighbor = file(root, "pkg/resource-transform.ts", "source", 800);
    const distractors = Array.from({ length: 80 }, (_, index) =>
      file(root, `modules/module-${String(index).padStart(3, "0")}/service.ts`, "source", 700)
    );
    const candidates = buildEvidenceCandidates({
      files: [seed, packageNeighbor, ...distractors],
      query: "Debug resource configuration in the service package",
      symbols: [],
      legacyResults: [
        scored(seed, { bm25Score: 10 }),
        ...distractors.map((record, index) => scored(record, { bm25Score: 9 - index / 100 })),
        scored(packageNeighbor, { bm25Score: 0.01 })
      ],
      edges: [],
      initialLimit: 64,
      enrichedLimit: 64
    });

    expect(candidates.candidates.map((candidate) => candidate.path)).toContain(packageNeighbor.path);
    expect(candidates.candidates.find((candidate) => candidate.path === packageNeighbor.path)?.reasons)
      .toContain("graph_neighbor");
  });
});

describe("evidence model artifacts", () => {
  it("strictly validates the bundled schema and checksum", () => {
    const validated = validateEvidenceRankerArtifact(BUNDLED_EVIDENCE_ARTIFACT);

    expect(validated.featureSchemaHash).toBe(EVIDENCE_FEATURE_SCHEMA_HASH);
    expect(validated.coefficients).toHaveLength(validated.orderedFeatures.length);
  });

  it("rejects tampering and unknown artifact fields", () => {
    expect(() => validateEvidenceRankerArtifact({
      ...BUNDLED_EVIDENCE_ARTIFACT,
      intercept: BUNDLED_EVIDENCE_ARTIFACT.intercept + 1
    })).toThrow(/checksum mismatch/i);
    expect(() => validateEvidenceRankerArtifact({
      ...BUNDLED_EVIDENCE_ARTIFACT,
      unexpected: true
    })).toThrow(/unknown: unexpected/i);
  });

  it("runs dependency-free logistic and Platt inference deterministically", () => {
    const candidate = buildEvidenceCandidates({
      files: [file("/repo", "src/service.ts", "source", 1000)],
      query: "src/service.ts",
      symbols: [],
      edges: [],
      legacyResults: []
    }).candidates[0]!;

    const first = predictEvidenceRelevance(BUNDLED_EVIDENCE_ARTIFACT, candidate.features);
    const second = predictEvidenceRelevance(BUNDLED_EVIDENCE_ARTIFACT, candidate.features);
    expect(first).toEqual(second);
    expect(first.relevanceProbability).toBeGreaterThan(0.5);
    expect(first.relevanceProbability).toBeLessThanOrEqual(1);
  });
});

describe("evidence ranker modes", () => {
  const root = "/repo";
  const source = file(root, "src/service.ts", "source", 1200);
  const test = file(root, "tests/service.test.ts", "test", 900);
  const legacy = [
    scored(test, { score: 900, bm25Score: 6 }),
    scored(source, { score: 200, keywordScore: 4 })
  ];
  const input = {
    files: [source, test],
    query: "Fix src/service.ts ServiceHandler production source",
    symbols: [symbol(root, source.path, "ServiceHandler")],
    chunks: [],
    edges: [edge(root, test.path, source.path, "test_for")],
    legacyResults: legacy
  };

  it("keeps legacy order while shadow mode adds typed evidence", () => {
    const result = rankEvidenceResults(input, { mode: "shadow" });

    expect(result.files.map((file) => file.path)).toEqual(legacy.map((file) => file.path));
    expect(result.files.find((file) => file.path === source.path)?.relevanceProbability).toBeTypeOf("number");
    expect(result.files.find((file) => file.path === source.path)?.evidenceReasons).toContain("exact_path");
    expect(result.status).toMatchObject({ servedMode: "shadow", modelId: "generic-evidence-v1" });
  });

  it("serves calibrated probability order while preserving legacy component fields", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-valid-ranker-"));
    const modelPath = path.join(temp, "model.json");
    fs.writeFileSync(modelPath, JSON.stringify(BUNDLED_EVIDENCE_ARTIFACT));
    try {
      const result = rankEvidenceResults(input, { mode: "calibrated", modelPath });

      expect(result.files[0]?.path).toBe(source.path);
      expect(result.files[0]?.score).toBe(200);
      expect(result.files[0]?.keywordScore).toBe(4);
      expect(result.files[0]?.rankerMode).toBe("calibrated");
      expect(result.files[0]?.delivery).toMatch(/content|path_hint/);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("does not present the hand-authored bundled bootstrap as calibrated serving", () => {
    const result = rankEvidenceResults(input, { mode: "calibrated" });

    expect(result.status).toMatchObject({
      requestedMode: "calibrated",
      servedMode: "fallback",
      modelId: "deterministic-evidence-fallback-v1"
    });
    expect(result.status.fallbackReason).toContain("explicit promoted local model artifact");
  });

  it("fails closed to deterministic evidence order for an invalid local artifact", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-ranker-"));
    const modelPath = path.join(temp, "tampered.json");
    fs.writeFileSync(modelPath, JSON.stringify({
      ...BUNDLED_EVIDENCE_ARTIFACT,
      intercept: 500
    }));

    try {
      const result = rankEvidenceResults(input, { mode: "calibrated", modelPath });
      expect(result.status.servedMode).toBe("fallback");
      expect(result.status.fallbackReason).toMatch(/checksum mismatch/i);
      expect(result.files[0]?.path).toBe(source.path);
      expect(result.files[0]?.rankerModelId).toBe("deterministic-evidence-fallback-v1");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

function file(rootPath: string, filePath: string, kind: FileKind, size: number): FileRecord {
  return {
    rootPath,
    path: filePath,
    language: path.extname(filePath).slice(1) || "unknown",
    kind,
    size,
    hash: `${filePath}-hash`,
    importance: kind === "source" ? 50 : 20,
    updatedAt: "2026-07-22T00:00:00.000Z"
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
    endLine: 10,
    signature: `function ${name}()`
  };
}

function edge(
  rootPath: string,
  fromFile: string,
  toFile: string,
  type: GraphEdgeRecord["type"]
): GraphEdgeRecord {
  return { rootPath, fromFile, toFile, type, metadata: {} };
}

function scored(
  record: FileRecord,
  overrides: Partial<Pick<HybridScoredResult, "score" | "bm25Score" | "keywordScore" | "semanticScore">> = {}
): HybridScoredResult {
  return {
    ...record,
    score: overrides.score ?? 100,
    reasons: ["legacy result"],
    semanticScore: overrides.semanticScore ?? 0,
    keywordScore: overrides.keywordScore ?? 0,
    bm25Score: overrides.bm25Score ?? 0,
    behaviorScore: 0,
    graphScore: 0,
    intentScore: 0,
    sessionScore: 0,
    importanceScore: record.importance,
    gitScore: 0,
    chunks: []
  };
}
