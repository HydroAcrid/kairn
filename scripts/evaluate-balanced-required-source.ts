// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { evaluateBalancedRequiredSource, formatBalancedRequiredSourceMarkdown } from "../src/bench/balancedRequiredSource.js";

const args = process.argv.slice(2).filter((item) => item !== "--");
let cohort = "benchmarks/cohorts/v02c-balanced-required-source.v1.json";
let out = "artifacts/balanced-required-source.v185.json";
for (let index = 0; index < args.length; index += 1) {
  const item = args[index]!;
  if (item === "--cohort") cohort = requiredValue(args, ++index, item);
  else if (item === "--out") out = requiredValue(args, ++index, item);
  else throw new Error(`unknown argument '${item}'`);
}

const evaluation = evaluateBalancedRequiredSource({ cohortPath: cohort });
const target = path.resolve(out);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
fs.writeFileSync(target.replace(/\.json$/i, ".md"), formatBalancedRequiredSourceMarkdown(evaluation), "utf8");
process.stdout.write(`${JSON.stringify({
  out: target,
  status: evaluation.status,
  requiredFileRecallAt5: evaluation.metrics.requiredFileRecallAt5,
  requiredFileRecallAt64: evaluation.metrics.requiredFileRecallAt64,
  strictFullRecallAt64: evaluation.metrics.strictFullRecallAt64,
  mrr: evaluation.metrics.mrr.value,
  calibrationEce: evaluation.metrics.calibrationEce,
  decision: evaluation.stoppingDecision
}, null, 2)}\n`);

function requiredValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
