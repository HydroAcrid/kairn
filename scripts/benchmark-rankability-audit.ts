// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { buildRankabilityAudit } from "../src/bench/rankabilityAudit.js";

const args = process.argv.slice(2).filter((token) => token !== "--");
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]; const value = args[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`invalid argument '${key ?? ""}'`);
  values.set(key, value);
}
const required = (key: string): string => { const found = values.get(key); if (!found) throw new Error(`${key} is required`); return found; };
const audit = buildRankabilityAudit({ rowsPath: required("--rows"), modelPaths: required("--models").split(",").map((item) => item.trim()) });
const target = path.resolve(required("--out")); fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ out: target, caseCount: audit.caseCount, reviewedOracleCaseCount: audit.reviewedOracleCaseCount, failureCounts: audit.failureCounts }, null, 2)}\n`);
