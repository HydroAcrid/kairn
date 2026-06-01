export type OfficialPairClassification =
  | "clean_savings"
  | "official_token_regression"
  | "neutral_pass_pass"
  | "official_pass_token_unavailable"
  | "quality_rescue"
  | "quality_drop"
  | "both_failed"
  | "scope_failure";

export type OfficialPairRowInput = {
  id: string;
  baselineOfficialPass: boolean;
  kairnOfficialPass: boolean;
  baselineScopePass?: boolean | undefined;
  kairnScopePass?: boolean | undefined;
  baselineTokens?: number | undefined;
  kairnTokens?: number | undefined;
  emittedFileCount?: number | undefined;
};

export type OfficialPairRowResult = OfficialPairRowInput & {
  classification: OfficialPairClassification;
  savedTokens?: number | undefined;
  reductionPct?: number | undefined;
};

export type OfficialPairAggregate = {
  totalRows: number;
  baselinePasses: number;
  kairnPasses: number;
  passPassRows: number;
  passPassRowsWithTokenData: number;
  cleanSavingsRows: number;
  officialTokenRegressions: number;
  qualityRescues: number;
  qualityDrops: number;
  missingTokenPassPassRows: number;
  cleanSavingsMedianReductionPct?: number | undefined;
  passPassMedianReductionPct?: number | undefined;
  emittedFileCounts: number[];
  validationErrors: string[];
  classifications: Partial<Record<OfficialPairClassification, number>>;
  rows: OfficialPairRowResult[];
};

export function classifyOfficialPairRow(row: OfficialPairRowInput): OfficialPairRowResult {
  const scopePass = row.baselineScopePass !== false && row.kairnScopePass !== false;
  if (row.baselineOfficialPass && row.kairnOfficialPass && !scopePass) {
    return { ...row, classification: "scope_failure" };
  }
  if (row.baselineOfficialPass && row.kairnOfficialPass) {
    if (row.baselineTokens === undefined || row.kairnTokens === undefined) {
      return { ...row, classification: "official_pass_token_unavailable" };
    }
    const savedTokens = row.baselineTokens - row.kairnTokens;
    const reductionPct = row.baselineTokens > 0
      ? Number(((savedTokens / row.baselineTokens) * 100).toFixed(1))
      : 0;
    if (savedTokens > 0) return { ...row, classification: "clean_savings", savedTokens, reductionPct };
    if (savedTokens < 0) return { ...row, classification: "official_token_regression", savedTokens, reductionPct };
    return { ...row, classification: "neutral_pass_pass", savedTokens, reductionPct };
  }
  if (!row.baselineOfficialPass && row.kairnOfficialPass) return { ...row, classification: "quality_rescue" };
  if (row.baselineOfficialPass && !row.kairnOfficialPass) return { ...row, classification: "quality_drop" };
  return { ...row, classification: "both_failed" };
}

export function summarizeOfficialPairRows(rows: OfficialPairRowInput[]): OfficialPairAggregate {
  const classified = rows.map(classifyOfficialPairRow);
  const classifications: Partial<Record<OfficialPairClassification, number>> = {};
  for (const row of classified) {
    classifications[row.classification] = (classifications[row.classification] ?? 0) + 1;
  }
  const passPassRows = classified.filter((row) => row.baselineOfficialPass && row.kairnOfficialPass && row.classification !== "scope_failure");
  const passPassRowsWithTokenData = passPassRows.filter((row) => row.baselineTokens !== undefined && row.kairnTokens !== undefined);
  const cleanSavingsRows = classified.filter((row) => row.classification === "clean_savings");
  const passPassReductionValues = passPassRowsWithTokenData
    .map((row) => row.reductionPct)
    .filter((value): value is number => typeof value === "number");
  const cleanSavingsReductionValues = cleanSavingsRows
    .map((row) => row.reductionPct)
    .filter((value): value is number => typeof value === "number");
  const validationErrors: string[] = [];
  const missingTokenPassPassRows = classified.filter((row) => row.classification === "official_pass_token_unavailable");
  for (const row of missingTokenPassPassRows) {
    validationErrors.push(`${row.id}: pass/pass official row lacks complete token data`);
  }
  return {
    totalRows: classified.length,
    baselinePasses: classified.filter((row) => row.baselineOfficialPass).length,
    kairnPasses: classified.filter((row) => row.kairnOfficialPass).length,
    passPassRows: passPassRows.length,
    passPassRowsWithTokenData: passPassRowsWithTokenData.length,
    cleanSavingsRows: cleanSavingsRows.length,
    officialTokenRegressions: classified.filter((row) => row.classification === "official_token_regression").length,
    qualityRescues: classified.filter((row) => row.classification === "quality_rescue").length,
    qualityDrops: classified.filter((row) => row.classification === "quality_drop").length,
    missingTokenPassPassRows: missingTokenPassPassRows.length,
    ...(cleanSavingsReductionValues.length > 0 ? { cleanSavingsMedianReductionPct: median(cleanSavingsReductionValues) } : {}),
    ...(passPassReductionValues.length > 0 ? { passPassMedianReductionPct: median(passPassReductionValues) } : {}),
    emittedFileCounts: classified.map((row) => row.emittedFileCount).filter((value): value is number => typeof value === "number"),
    validationErrors,
    classifications,
    rows: classified
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
  return Number(value.toFixed(1));
}
