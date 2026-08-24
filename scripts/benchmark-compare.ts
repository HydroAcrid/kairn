// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { compareRankerEvaluations } from "../src/bench/rankerComparison.js";

const args = process.argv.slice(2).filter((token) => token !== "--");
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]; const value = args[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`invalid argument '${key ?? ""}'`);
  values.set(key, value);
}
const required = (key: string): string => { const value = values.get(key); if (!value) throw new Error(`${key} is required`); return value; };
const infrastructure = JSON.parse(fs.readFileSync(required("--infrastructure"), "utf8")) as { valid?: boolean; campaignFingerprint?: string };
const report = compareRankerEvaluations({
  baselinePath: required("--baseline"), candidatePath: required("--candidate"),
  infrastructureValid: infrastructure.valid === true,
  campaignFingerprint: String(infrastructure.campaignFingerprint ?? "")
});
const target = path.resolve(required("--out"));
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ out: target, classification: report.classification, regressions: report.regressions }, null, 2)}\n`);
