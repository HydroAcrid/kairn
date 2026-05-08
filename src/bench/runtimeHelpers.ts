import type { BenchmarkCaseMode, BenchmarkRunMode } from "../types.js";

export function benchmarkCaseApplies(caseMode: BenchmarkCaseMode, runMode: BenchmarkRunMode): boolean {
  if (runMode === "replay") return caseMode !== "agent";
  if (runMode === "agent") return caseMode === "agent";
  return true;
}

export function requireBenchmarkTarget(benchmarkCase: { id: string; target?: string | undefined; expectedFiles: string[] }): string {
  const target = benchmarkCase.target ?? benchmarkCase.expectedFiles[0];
  if (!target) {
    throw new Error(`Benchmark case ${benchmarkCase.id} requires a target or expected file.`);
  }
  return target;
}
