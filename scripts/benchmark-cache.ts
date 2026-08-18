// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { inspectBenchmarkCache, quarantineBenchmarkCacheFinding } from "../src/bench/cacheInspection.js";

const root = path.resolve(".");
const quarantineId = process.argv.includes("--quarantine")
  ? process.argv[process.argv.indexOf("--quarantine") + 1]
  : undefined;
const findings = inspectBenchmarkCache(root);
if (quarantineId) {
  const finding = findings.find((item) => item.id === quarantineId);
  if (!finding) throw new Error(`unknown cache finding '${quarantineId}'`);
  const target = quarantineBenchmarkCacheFinding(root, finding);
  process.stdout.write(`${JSON.stringify({ quarantined: finding.path, recoverableAt: target }, null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ schemaVersion: "benchmark-cache-inspection.v1", findingCount: findings.length, findings }, null, 2)}\n`);
}
