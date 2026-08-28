// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { inspectBenchmarkCache, quarantineBenchmarkCacheFinding } from "../src/bench/cacheInspection.js";
import {
  benchmarkCachePolicy,
  enforceBenchmarkCacheRetention,
  inspectBenchmarkCacheRetention
} from "../src/bench/cacheRetention.js";

const root = path.resolve(".");
const cacheRoot = path.join(root, "artifacts", "ranker-checkouts");
const quarantineId = process.argv.includes("--quarantine")
  ? process.argv[process.argv.indexOf("--quarantine") + 1]
  : undefined;
const maxBytesValue = process.argv.includes("--max-bytes")
  ? process.argv[process.argv.indexOf("--max-bytes") + 1]
  : undefined;
const maxBytes = maxBytesValue === undefined ? undefined : Number(maxBytesValue);
if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
  throw new Error("--max-bytes must be a positive safe integer");
}
const policy = benchmarkCachePolicy({
  ...process.env,
  ...(maxBytes ? { KAIRN_BENCHMARK_CACHE_MAX_BYTES: String(maxBytes) } : {})
});
const findings = inspectBenchmarkCache(root);
if (quarantineId) {
  const finding = findings.find((item) => item.id === quarantineId);
  if (!finding) throw new Error(`unknown cache finding '${quarantineId}'`);
  const target = quarantineBenchmarkCacheFinding(root, finding);
  process.stdout.write(`${JSON.stringify({ quarantined: finding.path, recoverableAt: target }, null, 2)}\n`);
} else {
  const retention = process.argv.includes("--prune")
    ? enforceBenchmarkCacheRetention(cacheRoot, { policy })
    : { status: inspectBenchmarkCacheRetention(cacheRoot, policy), evictions: [] };
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "benchmark-cache-inspection.v2",
    findingCount: findings.length,
    findings,
    retention: retention.status,
    evictions: retention.evictions
  }, null, 2)}\n`);
}
