// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { buildRankabilityInput } from "../src/bench/rankabilityInput.js";

const options = parseArgs(process.argv.slice(2));
const output = buildRankabilityInput({
  sourceManifestPath: options.sourceManifest,
  sourceReportPath: options.sourceReport,
  oracleCaseSetPath: options.oracleCaseSet,
  deterministicOracleReportPath: options.deterministicOracleReport,
  semanticOracleProgressPath: options.semanticOracleProgress,
  modelPaths: options.models,
  recordedEvaluationPaths: options.recordedEvaluations,
  repositoryCacheRoot: options.repositoryCache
});
const target = path.resolve(options.out);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(output)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  out: target,
  candidateOracleMaterialized: output.cohortCounts.candidateOracleMaterialized,
  requiredSourceCases: output.cohortCounts.requiredSourceCases,
  requiredSourceFiles: output.cohortCounts.requiredSourceFiles,
  weakPatchCalibrationCases: output.cohortCounts.weakPatchCalibrationCases
}, null, 2)}\n`);

function parseArgs(argv: string[]): {
  sourceManifest: string;
  sourceReport: string;
  oracleCaseSet: string;
  deterministicOracleReport: string;
  semanticOracleProgress: string;
  models: string[];
  recordedEvaluations: string[];
  repositoryCache: string;
  out: string;
} {
  const args = argv.filter((token) => token !== "--");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument '${key ?? ""}'`);
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) throw new Error(`${key} is required`);
    return path.resolve(value);
  };
  const models = required("--models").split(",").map((value) => path.resolve(value.trim())).filter(Boolean);
  if (models.length < 2) throw new Error("--models requires at least two model artifacts");
  const recordedEvaluations = required("--recorded-evaluations").split(",").map((value) => path.resolve(value.trim())).filter(Boolean);
  if (recordedEvaluations.length < 4) throw new Error("--recorded-evaluations requires the four frozen baseline evaluations");
  return {
    sourceManifest: required("--source-manifest"),
    sourceReport: required("--source-report"),
    oracleCaseSet: required("--oracle-case-set"),
    deterministicOracleReport: required("--deterministic-oracle-report"),
    semanticOracleProgress: required("--semantic-oracle-progress"),
    models,
    recordedEvaluations,
    repositoryCache: required("--repository-cache"),
    out: required("--out")
  };
}
