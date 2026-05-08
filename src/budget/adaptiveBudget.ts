import type { PrimeProfile } from "../types.js";

export type RepoScale = "small" | "medium" | "large" | "huge";

export type BudgetProfile = {
  fileCount: number;
  symbolCount: number;
  chunkCount: number;
  maxStateMb: number;
  scale: RepoScale;
  statePressure: number;
};

export type LexicalIndexBudget = {
  maxSymbolDocuments: number;
  maxChunkDocuments: number;
  maxLexicalTerms: number;
  chunksPerFileDocument: number;
};

export type SymbolCompactionBudget = {
  compact: boolean;
  dropLowValueLocalVariables: boolean;
  maxSymbolsPerFile: number;
};

export type QueryLocalBudget = {
  candidateLimit: number;
  exactPathLimit: number;
  candidateSlack: number;
  expansionSlack: number;
  symbolLimit: number;
  graphEdgeLimit: number;
  chunkLimit: number;
  lexicalTermLimit: number;
  lexicalDocumentLimit: number;
  termLookupLimit: number;
};

export type InventoryBudget = {
  maxInventoryFiles: number;
  maxFileBytes: number;
};

export function createBudgetProfile(input: {
  fileCount: number;
  symbolCount?: number | undefined;
  chunkCount?: number | undefined;
  maxStateMb?: number | undefined;
}): BudgetProfile {
  const fileCount = Math.max(0, input.fileCount);
  const symbolCount = Math.max(0, input.symbolCount ?? 0);
  const chunkCount = Math.max(0, input.chunkCount ?? 0);
  const maxStateMb = Math.max(32, input.maxStateMb ?? 250);
  const scale = fileCount >= 25_000 || symbolCount >= 80_000
    ? "huge"
    : fileCount >= 6_000 || symbolCount >= 20_000
      ? "large"
      : fileCount >= 800 || symbolCount >= 5_000
        ? "medium"
        : "small";

  return {
    fileCount,
    symbolCount,
    chunkCount,
    maxStateMb,
    scale,
    statePressure: clamp((fileCount / 25_000 + symbolCount / 80_000 + chunkCount / 10_000) / 3, 0, 2)
  };
}

export function inventoryBudget(input: {
  candidateCount: number;
  maxStateMb?: number | undefined;
}): InventoryBudget {
  const stateMultiplier = clamp((input.maxStateMb ?? 250) / 250, 0.6, 2.5);
  const emergencyCeiling = Math.round(60_000 * stateMultiplier);
  return {
    maxInventoryFiles: Math.min(input.candidateCount, emergencyCeiling),
    maxFileBytes: Math.round(260_000 + Math.min(240_000, (input.maxStateMb ?? 250) * 600))
  };
}

export function lexicalIndexBudget(profile: BudgetProfile): LexicalIndexBudget {
  const pressure = Math.max(0.35, profile.statePressure);
  const fileFactor = Math.sqrt(Math.max(1, profile.fileCount));
  const symbolFactor = Math.sqrt(Math.max(1, profile.symbolCount));
  const chunkFactor = Math.sqrt(Math.max(1, profile.chunkCount));

  const maxSymbolDocuments = clampInt(Math.round(symbolFactor * (profile.scale === "small" ? 95 : profile.scale === "medium" ? 72 : 48) / pressure), 800, 10_000);
  const maxChunkDocuments = profile.scale === "huge"
    ? clampInt(Math.round(chunkFactor * 3), 120, 900)
    : profile.scale === "large"
      ? clampInt(Math.round(chunkFactor * 6), 200, 1_600)
      : clampInt(Math.round(chunkFactor * 24), 600, 3_500);
  const maxLexicalTerms = clampInt(Math.round((profile.fileCount * 1.8 + maxSymbolDocuments * 4 + maxChunkDocuments * 5) / pressure), 18_000, 90_000);
  const chunksPerFileDocument = profile.scale === "small" ? 8 : profile.scale === "medium" ? 4 : profile.scale === "large" ? 2 : 1;

  return {
    maxSymbolDocuments,
    maxChunkDocuments,
    maxLexicalTerms,
    chunksPerFileDocument
  };
}

export function symbolCompactionBudget(input: {
  fileCount: number;
  rawSymbolCount: number;
  parsedFileCount: number;
  maxStateMb?: number | undefined;
}): SymbolCompactionBudget {
  const profile = createBudgetProfile({
    fileCount: input.fileCount,
    symbolCount: input.rawSymbolCount,
    maxStateMb: input.maxStateMb
  });
  const averageSymbolsPerParsedFile = input.rawSymbolCount / Math.max(1, input.parsedFileCount);
  const compact = profile.scale !== "small" || averageSymbolsPerParsedFile > 180;
  const scaleCap = profile.scale === "huge" ? 80 : profile.scale === "large" ? 120 : profile.scale === "medium" ? 220 : 360;
  const densityCap = averageSymbolsPerParsedFile > 0
    ? Math.round(Math.max(48, Math.min(scaleCap, Math.sqrt(averageSymbolsPerParsedFile) * 10)))
    : scaleCap;

  return {
    compact,
    dropLowValueLocalVariables: profile.scale !== "small" || averageSymbolsPerParsedFile > 120,
    maxSymbolsPerFile: compact ? densityCap : scaleCap
  };
}

export function queryLocalBudget(input: {
  fileCount: number;
  query: string;
  maxStateMb?: number | undefined;
}): QueryLocalBudget {
  const profile = createBudgetProfile({ fileCount: input.fileCount, maxStateMb: input.maxStateMb });
  const specificity = querySpecificity(input.query);
  const broadness = 1 - specificity;
  const scaleReduction = profile.scale === "huge" ? 0.55 : profile.scale === "large" ? 0.72 : profile.scale === "medium" ? 0.9 : 1.15;
  const candidateLimit = clampInt(Math.round((120 + broadness * 180 + specificity * 70) * scaleReduction), 90, 420);
  const exactPathLimit = clampInt(Math.round(24 + specificity * 60), 24, 90);

  return {
    candidateLimit,
    exactPathLimit,
    candidateSlack: clampInt(Math.round(candidateLimit * 0.35), 32, 160),
    expansionSlack: clampInt(Math.round(candidateLimit * (profile.scale === "huge" ? 0.8 : 1.6)), 80, 700),
    symbolLimit: clampInt(Math.round(candidateLimit * (profile.scale === "huge" ? 22 : 42)), 4_000, 24_000),
    graphEdgeLimit: clampInt(Math.round(candidateLimit * (profile.scale === "huge" ? 90 : 160)), 8_000, 60_000),
    chunkLimit: clampInt(Math.round(candidateLimit * (profile.scale === "huge" ? 18 : 34)), 2_500, 14_000),
    lexicalTermLimit: clampInt(Math.round(candidateLimit * 95), 12_000, 50_000),
    lexicalDocumentLimit: clampInt(Math.round(candidateLimit * 120), 12_000, 60_000),
    termLookupLimit: clampInt(Math.round(12 + specificity * 24), 12, 40)
  };
}

export function adaptivePrimeBudget(input: {
  profile: Exclude<PrimeProfile, "auto">;
  task: string;
  repoFileCount: number;
}): number {
  const specificity = querySpecificity(input.task);
  const scale = createBudgetProfile({ fileCount: input.repoFileCount }).scale;
  const base = profileBaseBudget(input.profile);
  const scaleAdjustment = scale === "huge" ? 0.78 : scale === "large" ? 0.88 : scale === "medium" ? 0.96 : 1.05;
  const specificityAdjustment = input.profile === "failure_debug" ? 0.85 + specificity * 0.25 : 0.8 + specificity * 0.35;
  return clampInt(Math.round(base * scaleAdjustment * specificityAdjustment), 360, 1_300);
}

export function querySpecificity(query: string): number {
  const tokens = query
    .replace(/`[^`]*`|'[^']*'|"[^"]*"/g, " identifier ")
    .split(/[^A-Za-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return 0;

  let score = 0;
  score += tokens.filter((token) => token.length >= 5).length * 0.06;
  score += tokens.filter((token) => /[A-Z][a-z]+[A-Z]|[_./-]/.test(token)).length * 0.12;
  score += /\b(debug|failing|failure|regression|stack|trace|assert|test|error)\b/i.test(query) ? 0.18 : 0;
  score += /\b(file|function|class|method|symbol|api|route|parser|layout|mobile|url|hash|slug|blank|prefix)\b/i.test(query) ? 0.16 : 0;
  score -= /\b(stuff|things|better|improve|quality|cleanup|clean up)\b/i.test(query) ? 0.3 : 0;
  return clamp(score, 0, 1);
}

function profileBaseBudget(profile: Exclude<PrimeProfile, "auto">): number {
  switch (profile) {
    case "ui":
      return 700;
    case "workflow":
      return 900;
    case "backend":
      return 1100;
    case "failure_debug":
      return 900;
    case "test":
      return 900;
    case "generic":
      return 800;
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
