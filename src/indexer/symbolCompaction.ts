import type { FileRecord, ParsedFile, SymbolKind, SymbolRecord } from "../types.js";
import { symbolCompactionBudget } from "../budget/adaptiveBudget.js";

const VARIABLE_KINDS = new Set<SymbolKind>(["const", "let", "var"]);
const STRUCTURAL_KINDS = new Set<SymbolKind>([
  "function",
  "class",
  "interface",
  "type",
  "component",
  "default"
]);

export function compactParsedSymbols(input: {
  files: FileRecord[];
  parsedFiles: ParsedFile[];
  maxStateMb?: number | undefined;
}): ParsedFile[] {
  const fileByPath = new Map(input.files.map((file) => [file.path, file]));
  const totalSymbols = input.parsedFiles.reduce((total, parsed) => total + parsed.symbols.length, 0);
  const budget = symbolCompactionBudget({
    fileCount: input.files.length,
    rawSymbolCount: totalSymbols,
    parsedFileCount: input.parsedFiles.length,
    maxStateMb: input.maxStateMb
  });

  return input.parsedFiles.map((parsed) => {
    const file = fileByPath.get(parsed.filePath);
    const symbols = compactSymbolsForFile({
      symbols: parsed.symbols,
      file,
      dropLowValueLocalVariables: budget.dropLowValueLocalVariables,
      compact: budget.compact,
      maxSymbolsPerFile: budget.maxSymbolsPerFile
    });

    return {
      ...parsed,
      symbols
    };
  });
}

function compactSymbolsForFile(input: {
  symbols: SymbolRecord[];
  file?: FileRecord | undefined;
  dropLowValueLocalVariables: boolean;
  compact: boolean;
  maxSymbolsPerFile: number;
}): SymbolRecord[] {
  if (input.symbols.length <= input.maxSymbolsPerFile && !input.compact && !input.dropLowValueLocalVariables) return input.symbols;

  return input.symbols
    .map((symbol, index) => ({
      symbol,
      index,
      score: symbolRetentionScore(symbol, input.file, input.dropLowValueLocalVariables)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, input.maxSymbolsPerFile)
    .sort((a, b) => a.symbol.startLine - b.symbol.startLine || a.index - b.index)
    .map((entry) => entry.symbol);
}

function symbolRetentionScore(symbol: SymbolRecord, file: FileRecord | undefined, dropLowValueLocalVariables: boolean): number {
  if (dropLowValueLocalVariables && isLowValueVariableSymbol(symbol)) return 0;

  let score = 10;
  if (symbol.exported) score += 120;
  if (STRUCTURAL_KINDS.has(symbol.kind)) score += 90;
  if (symbol.kind === "component") score += 30;
  if (symbol.kind === "const" && isNamedConstant(symbol.name)) score += 34;
  if (symbol.kind === "const" && /^[A-Z]/.test(symbol.name)) score += 22;
  if (symbol.kind === "let" || symbol.kind === "var") score -= dropLowValueLocalVariables ? 30 : 8;
  if (symbol.name.length <= 2) score -= 16;
  if (file?.kind === "test") score -= 12;
  if (file && isNoisyImplementationPath(file.path)) score -= 80;
  if (file?.kind === "route" || file?.kind === "component") score += 12;

  return score;
}

function isLowValueVariableSymbol(symbol: SymbolRecord): boolean {
  if (!VARIABLE_KINDS.has(symbol.kind)) return false;
  if (symbol.exported) return false;
  if (symbol.kind === "const" && (isNamedConstant(symbol.name) || /^[A-Z]/.test(symbol.name))) return false;
  return true;
}

function isNamedConstant(name: string): boolean {
  return /^[A-Z0-9_]{3,}$/.test(name);
}

function isNoisyImplementationPath(filePath: string): boolean {
  return /(^|\/)(compiled|generated|gen|fixtures?|__fixtures__|vendor|third[_-]party|dist|build|coverage|docs?|examples|demos?|devtools|codemods?|website|site|playground|storybook)\//i.test(
    filePath
  );
}
