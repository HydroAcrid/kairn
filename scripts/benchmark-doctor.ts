// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { runBenchmarkDoctor, type BenchmarkDoctorProfile } from "../src/bench/benchmarkDoctor.js";

const args = parseArgs(process.argv.slice(2));
const report = runBenchmarkDoctor({
  manifestPath: args.manifest,
  profile: args.profile,
  allowDirtyFixture: args.allowDirtyFixture,
  skipModelFiles: args.skipModelFiles
});
if (args.out) {
  const target = path.resolve(args.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`Benchmark infrastructure — ${report.profile}\n\n`);
  for (const check of report.checks) process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.detail}\n`);
  process.stdout.write(`\nInfrastructure: ${report.valid ? "VALID" : "INVALID"}${report.nonEvidence ? " · NON-EVIDENCE" : ""}\n`);
}
if (!report.valid) process.exitCode = 1;

function parseArgs(argv: string[]): {
  manifest: string; profile: BenchmarkDoctorProfile; out?: string; json: boolean;
  allowDirtyFixture: boolean; skipModelFiles: boolean;
} {
  argv = argv.filter((token) => token !== "--");
  let manifest = "benchmarks/campaigns/v02c-infrastructure.json";
  let profile: BenchmarkDoctorProfile = "ranker";
  let out: string | undefined; let json = false; let allowDirtyFixture = false; let skipModelFiles = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--manifest") manifest = requiredValue(argv, ++index, token);
    else if (token === "--profile") { const value = requiredValue(argv, ++index, token); if (value !== "ranker" && value !== "live") throw new Error("--profile must be ranker or live"); profile = value; }
    else if (token === "--out") out = requiredValue(argv, ++index, token);
    else if (token === "--json") json = true;
    else if (token === "--allow-dirty-fixture") allowDirtyFixture = true;
    else if (token === "--skip-model-files") skipModelFiles = true;
    else throw new Error(`Unknown argument '${token}'.`);
  }
  return { manifest, profile, ...(out ? { out } : {}), json, allowDirtyFixture, skipModelFiles };
}
function requiredValue(argv: string[], index: number, flag: string): string { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`); return value; }
