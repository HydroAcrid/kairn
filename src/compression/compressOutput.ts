import type { OutputKind } from "../types.js";
import { truncateToBudget } from "../utils/tokens.js";

export function compressOutput(output: string, type: OutputKind, budget = 1200): string {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const important = selectImportantLines(lines, type);
  const summary = [
    `# ${type} output summary`,
    "",
    `Input lines: ${lines.length}`,
    `Selected lines: ${important.length}`,
    "",
    "## Important Output",
    important.length > 0 ? important.join("\n") : "No obvious errors or warnings detected.",
    "",
    "## Tail",
    lines.slice(-20).join("\n")
  ].join("\n");

  return truncateToBudget(summary, budget);
}

function selectImportantLines(lines: string[], type: OutputKind): string[] {
  const commonPattern = /(error|failed|failure|exception|warning|timeout|cannot|expected|received|not found)/i;
  const typePatterns: Record<OutputKind, RegExp> = {
    test: /(fail|failed|passing|expected|received|describe|it\(|test\(|snapshot|assert)/i,
    lint: /(error|warning|eslint|rule|line\s+\d+)/i,
    typecheck: /(error TS\d+|type |assignable|property|argument|cannot find)/i,
    generic: commonPattern
  };

  const pattern = typePatterns[type] ?? commonPattern;
  return lines.filter((line) => pattern.test(line) || commonPattern.test(line)).slice(0, 120);
}
