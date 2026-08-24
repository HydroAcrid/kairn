// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPublicEvidenceCases,
  repositoryUrl,
  scenarioPrompt,
  selectScenarioTasks,
  type Language,
  type PublicEvidenceCase,
  type Scenario
} from "./build-public-evidence-intake.js";

type Lineage = {
  id: string;
  role: "train" | "calibration" | "holdout";
};

type LineageRegistry = {
  schemaVersion: "lineage-registry.v1";
  lineages: Lineage[];
};

type HoldoutAssignment = {
  scenario: Scenario;
  row: PublicEvidenceCase;
};

export type DetachedHoldoutSelection = {
  assignments: HoldoutAssignment[];
  repositoriesByLanguage: Record<Language, string[]>;
};

const LANGUAGES: Language[] = ["python", "typescript", "go", "java", "cpp"];
const SCENARIOS: Scenario[] = ["source_localization", "failure_first", "long_session"];
const LINEAGE_TARGETS: Record<Language, number> = {
  python: 3,
  typescript: 2,
  go: 2,
  java: 2,
  cpp: 1
};
const CASES_PER_SCENARIO = 2;

export function selectDetachedHoldout(
  pool: PublicEvidenceCase[],
  excludedLineageIds: ReadonlySet<string>
): DetachedHoldoutSelection {
  const canonicalExcluded = new Set([...excludedLineageIds].map(canonicalLineage));
  const optionsByLanguage = new Map<Language, Array<{
    repositories: string[];
    scenarios: Record<Scenario, PublicEvidenceCase[]>;
  }>>();
  for (const language of LANGUAGES) {
    const rows = pool
      .filter((row) =>
        row.language === language &&
        !canonicalExcluded.has(canonicalLineage(repositoryUrl(row.repository)))
      )
      .sort((left, right) =>
        left.repository.localeCompare(right.repository) ||
        left.sourceId.localeCompare(right.sourceId)
      );
    const repositories = [...new Set(rows.map((row) => row.repository))].sort();
    const options: Array<{
      repositories: string[];
      scenarios: Record<Scenario, PublicEvidenceCase[]>;
    }> = [];
    for (const candidateRepositories of combinations(repositories, LINEAGE_TARGETS[language])) {
      try {
        const candidateRows = rows.filter((row) => candidateRepositories.includes(row.repository));
        options.push({
          repositories: candidateRepositories,
          scenarios: selectScenarioTasks(candidateRows, CASES_PER_SCENARIO)
        });
      } catch {
        // Continue until a general scenario-complete lineage set is found.
      }
    }
    if (options.length === 0) {
      const availability = repositories.map((repository) => {
        const repositoryRows = rows.filter((row) => row.repository === repository);
        return {
          repository,
          cases: repositoryRows.length,
          failureFirstEligible: repositoryRows.filter((row) => row.failureReferences.length > 0).length,
          longSessionEligible: repositoryRows.filter((row) => row.changedFiles.length >= 2).length
        };
      });
      throw new Error(
        `${language}: no fresh lineage-disjoint holdout satisfies ` +
        `${CASES_PER_SCENARIO} cases for every scenario; availability=${JSON.stringify(availability)}`
      );
    }
    optionsByLanguage.set(language, options);
  }

  const selectedByLanguage = new Map<Language, {
    repositories: string[];
    scenarios: Record<Scenario, PublicEvidenceCase[]>;
  }>();
  const occupied = new Set<string>();
  const searchOrder = [...LANGUAGES].sort((left, right) =>
    optionsByLanguage.get(left)!.length - optionsByLanguage.get(right)!.length ||
    LANGUAGES.indexOf(left) - LANGUAGES.indexOf(right)
  );
  const selectDisjoint = (index: number): boolean => {
    if (index >= searchOrder.length) return true;
    const language = searchOrder[index]!;
    for (const option of optionsByLanguage.get(language) ?? []) {
      const lineages = option.repositories.map((repository) => canonicalLineage(repositoryUrl(repository)));
      if (lineages.some((lineage) => occupied.has(lineage))) continue;
      lineages.forEach((lineage) => occupied.add(lineage));
      selectedByLanguage.set(language, option);
      if (selectDisjoint(index + 1)) return true;
      selectedByLanguage.delete(language);
      lineages.forEach((lineage) => occupied.delete(lineage));
    }
    return false;
  };
  if (!selectDisjoint(0)) {
    throw new Error(
      `no cross-language lineage-disjoint holdout exists; options=${JSON.stringify(
        Object.fromEntries(LANGUAGES.map((language) => [language, optionsByLanguage.get(language)!.length]))
      )}`
    );
  }

  const assignments: HoldoutAssignment[] = [];
  const repositoriesByLanguage = {} as Record<Language, string[]>;
  for (const language of LANGUAGES) {
    const selected = selectedByLanguage.get(language)!;
    repositoriesByLanguage[language] = selected.repositories;
    for (const scenario of SCENARIOS) {
      for (const row of selected.scenarios[scenario]) assignments.push({ scenario, row });
    }
  }

  const sourceIds = assignments.map((item) => item.row.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("detached holdout cases must be unique across scenarios");
  }
  return { assignments, repositoriesByLanguage };
}

export function buildDetachedHoldoutArtifacts(input: {
  pool: PublicEvidenceCase[];
  existingRegistry: LineageRegistry;
  registryFilename: string;
  expectedPoolSha256?: string;
}): {
  intake: Record<string, unknown>;
  registry: LineageRegistry;
  summary: Record<string, unknown>;
} {
  validateRegistry(input.existingRegistry);
  const existingLineages = new Set(input.existingRegistry.lineages.map((item) => canonicalLineage(item.id)));
  const selection = selectDetachedHoldout(input.pool, existingLineages);
  const freshLineages = [...new Set(
    Object.values(selection.repositoriesByLanguage).flat().map(repositoryUrl)
  )].sort();
  if (freshLineages.some((lineage) => existingLineages.has(canonicalLineage(lineage)))) {
    throw new Error("detached holdout must not reuse an existing repository lineage");
  }

  const orderedAssignments = [...selection.assignments].sort((left, right) =>
    LANGUAGES.indexOf(left.row.language) - LANGUAGES.indexOf(right.row.language) ||
    SCENARIOS.indexOf(left.scenario) - SCENARIOS.indexOf(right.scenario) ||
    left.row.sourceId.localeCompare(right.row.sourceId)
  );
  const cases = orderedAssignments.map((item, index) => ({
    id: `v02c-detached-holdout-${item.row.language}-${item.scenario}-${String(index + 1).padStart(3, "0")}`,
    split: "holdout",
    language: item.row.language,
    scenario: item.scenario,
    repositoryLineageId: repositoryUrl(item.row.repository),
    repositoryUrl: repositoryUrl(item.row.repository),
    repositoryRef: item.row.repositoryRef,
    publicSourceUrl: item.row.sourceUrl,
    dataOrigin: "public_patch",
    prompt: scenarioPrompt(item.row, item.scenario),
    requiredSourceFiles: [],
    officialPatchSourceFiles: item.row.productionPatchFiles,
    verifiedObservedReadTouchFiles: [],
    qualityVerified: false,
    explicitNoiseFiles: []
  }));
  const registry: LineageRegistry = {
    schemaVersion: "lineage-registry.v1",
    lineages: [
      ...input.existingRegistry.lineages,
      ...freshLineages.map((id) => ({ id, role: "holdout" as const }))
    ].sort((left, right) => left.id.localeCompare(right.id))
  };
  const poolSha256 = sha256(stablePoolPayload(input.pool));
  if (input.expectedPoolSha256 && poolSha256 !== input.expectedPoolSha256) {
    throw new Error(
      `public source pool changed: expected ${input.expectedPoolSha256}, received ${poolSha256}`
    );
  }
  const intake = {
    schemaVersion: "ranker-corpus-intake.v1",
    corpusId: "kairn-evidence-v02c-detached-holdout-20260727",
    featureSchemaVersion: "evidence-features-v4",
    sealed: false,
    sampleOnly: false,
    lineageRegistry: input.registryFilename,
    sources: [
      "https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified",
      "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual",
      "https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro",
      "https://huggingface.co/datasets/SWE-bench-Live/MultiLang",
      "https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench"
    ],
    sourcePoolSha256: poolSha256,
    curationStatus: "detached_holdout_selected_oracle_and_noise_review_pending",
    cases
  };
  const summary = {
    schemaVersion: "detached-holdout-intake-summary.v1",
    sourcePoolSha256: poolSha256,
    candidatePoolSize: input.pool.length,
    excludedLineages: existingLineages.size,
    selectedCases: cases.length,
    selectedLineages: freshLineages.length,
    repositoriesByLanguage: selection.repositoriesByLanguage,
    cells: Object.fromEntries(LANGUAGES.flatMap((language) =>
      SCENARIOS.map((scenario) => [
        `${language}/${scenario}`,
        orderedAssignments.filter((item) =>
          item.row.language === language && item.scenario === scenario
        ).length
      ])
    )),
    sourceIds: orderedAssignments.map((item) => item.row.sourceId),
    nextAction:
      "Independently review source oracles without ranker output; freeze the model before materializing or evaluating this holdout."
  };
  return { intake, registry, summary };
}

function stablePoolPayload(pool: PublicEvidenceCase[]): string {
  return JSON.stringify([...pool].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  ));
}

function validateRegistry(value: LineageRegistry): void {
  if (value.schemaVersion !== "lineage-registry.v1" || !Array.isArray(value.lineages)) {
    throw new Error("existing registry must use lineage-registry.v1");
  }
  const ids = value.lineages.map((item) => canonicalLineage(item.id));
  if (new Set(ids).size !== ids.length) throw new Error("existing registry contains duplicate lineages");
  for (const item of value.lineages) {
    if (!["train", "calibration", "holdout"].includes(item.role)) {
      throw new Error(`unsupported lineage role for ${item.id}`);
    }
  }
}

function canonicalLineage(value: string): string {
  return value.replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase();
}

function combinations<T>(values: T[], count: number): T[][] {
  if (count === 0) return [[]];
  const output: T[][] = [];
  const visit = (start: number, selected: T[]): void => {
    if (selected.length === count) {
      output.push([...selected]);
      return;
    }
    for (let index = start; index <= values.length - (count - selected.length); index += 1) {
      selected.push(values[index]!);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return output;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: string[]): {
  existingRegistry: string;
  out: string;
  registryOut: string;
  summaryOut: string;
  expectedPoolSha256?: string;
} {
  const values = new Map<string, string>();
  const args = argv.filter((token) => token !== "--");
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
  const expectedPoolSha256 = values.get("--expected-pool-sha256");
  if (expectedPoolSha256 && !/^[a-f0-9]{64}$/i.test(expectedPoolSha256)) {
    throw new Error("--expected-pool-sha256 must be a SHA-256 digest");
  }
  return {
    existingRegistry: required("--existing-registry"),
    out: required("--out"),
    registryOut: required("--registry-out"),
    summaryOut: required("--summary-out"),
    ...(expectedPoolSha256 ? { expectedPoolSha256: expectedPoolSha256.toLowerCase() } : {})
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const targets = parseArgs(process.argv.slice(2));
  loadPublicEvidenceCases({ includeDetachedSources: true })
    .then((pool) => {
      const existingRegistry = JSON.parse(fs.readFileSync(targets.existingRegistry, "utf8")) as LineageRegistry;
      const artifacts = buildDetachedHoldoutArtifacts({
        pool,
        existingRegistry,
        registryFilename: path.relative(path.dirname(targets.out), targets.registryOut).replace(/\\/g, "/"),
        ...(targets.expectedPoolSha256
          ? { expectedPoolSha256: targets.expectedPoolSha256 }
          : {})
      });
      for (const target of [targets.out, targets.registryOut, targets.summaryOut]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
      }
      fs.writeFileSync(targets.out, `${JSON.stringify(artifacts.intake, null, 2)}\n`, "utf8");
      fs.writeFileSync(targets.registryOut, `${JSON.stringify(artifacts.registry, null, 2)}\n`, "utf8");
      fs.writeFileSync(targets.summaryOut, `${JSON.stringify(artifacts.summary, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ ...artifacts.summary, outputs: targets }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
