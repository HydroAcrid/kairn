import { describe, expect, it } from "vitest";
import {
  adaptivePrimeBudget,
  createBudgetProfile,
  lexicalIndexBudget,
  queryLocalBudget,
  querySpecificity,
  symbolCompactionBudget
} from "../src/budget/adaptiveBudget.js";

describe("adaptive budget policy", () => {
  it("derives larger repo profiles from observed scale instead of fixed call-site thresholds", () => {
    expect(createBudgetProfile({ fileCount: 120 }).scale).toBe("small");
    expect(createBudgetProfile({ fileCount: 2_000 }).scale).toBe("medium");
    expect(createBudgetProfile({ fileCount: 9_000 }).scale).toBe("large");
    expect(createBudgetProfile({ fileCount: 30_000 }).scale).toBe("huge");
  });

  it("reduces lexical chunk pressure as repo scale increases while preserving symbol documents", () => {
    const small = lexicalIndexBudget(createBudgetProfile({ fileCount: 200, symbolCount: 900, chunkCount: 700 }));
    const huge = lexicalIndexBudget(createBudgetProfile({ fileCount: 30_000, symbolCount: 90_000, chunkCount: 7_500 }));

    expect(small.chunksPerFileDocument).toBeGreaterThan(huge.chunksPerFileDocument);
    expect(huge.maxSymbolDocuments).toBeGreaterThan(0);
    expect(huge.maxLexicalTerms).toBeGreaterThanOrEqual(small.maxLexicalTerms);
  });

  it("compacts symbols only when density or repo scale justifies it", () => {
    const small = symbolCompactionBudget({ fileCount: 80, rawSymbolCount: 400, parsedFileCount: 40 });
    const huge = symbolCompactionBudget({ fileCount: 30_000, rawSymbolCount: 140_000, parsedFileCount: 16_000 });

    expect(small.compact).toBe(false);
    expect(huge.compact).toBe(true);
    expect(huge.maxSymbolsPerFile).toBeLessThan(small.maxSymbolsPerFile);
  });

  it("uses query specificity to reduce broad expansion and tune prime cost", () => {
    const vague = "make this project better maybe improve stuff";
    const precise = "Debug local URL helper regression in production source";
    const vagueBudget = queryLocalBudget({ fileCount: 30_000, query: vague });
    const preciseBudget = queryLocalBudget({ fileCount: 30_000, query: precise });

    expect(querySpecificity(precise)).toBeGreaterThan(querySpecificity(vague));
    expect(preciseBudget.exactPathLimit).toBeGreaterThan(vagueBudget.exactPathLimit);
    expect(adaptivePrimeBudget({ profile: "failure_debug", task: precise, repoFileCount: 30_000 })).toBeLessThanOrEqual(900);
  });
});
