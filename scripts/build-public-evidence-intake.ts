// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Language = "python" | "typescript" | "go" | "java" | "cpp";
type Scenario = "source_localization" | "failure_first" | "long_session";
type Split = "train" | "calibration" | "holdout";

export type PublicEvidenceCase = {
  sourceId: string;
  sourceUrl: string;
  repository: string;
  repositoryRef: string;
  language: Language;
  prompt: string;
  productionPatchFiles: string[];
  changedFiles: string[];
  failureReferences: string[];
};

const DATASET_SOURCES = [
  {
    id: "swe-bench-verified",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    language: "python" as const,
    sourceUrl: "https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified"
  },
  {
    id: "swe-bench-multilingual",
    dataset: "SWE-bench/SWE-bench_Multilingual",
    split: "test",
    sourceUrl: "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multilingual"
  },
  {
    id: "swe-bench-pro-public-slice",
    dataset: "ScaleAI/SWE-bench_Pro",
    split: "test",
    maxRows: 100,
    sourceUrl: "https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro"
  }
] as const;

const MULTI_SWE_SOURCES = [
  { language: "cpp" as const, filename: "catchorg__Catch2_dataset.jsonl" },
  { language: "cpp" as const, filename: "fmtlib__fmt_dataset.jsonl" },
  { language: "cpp" as const, filename: "nlohmann__json_dataset.jsonl" },
  { language: "cpp" as const, filename: "simdjson__simdjson_dataset.jsonl" },
  { language: "cpp" as const, filename: "yhirose__cpp-httplib_dataset.jsonl" },
  { language: "java" as const, filename: "apache__dubbo_dataset.jsonl" },
  { language: "java" as const, filename: "fasterxml__jackson-core_dataset.jsonl" },
  { language: "java" as const, filename: "mockito__mockito_dataset.jsonl" }
] as const;

const MULTILINGUAL_CPP_REPOSITORIES = new Set(["fmtlib/fmt", "nlohmann/json"]);

const LINEAGE_TARGETS: Record<Split, Record<Language, number>> = {
  train: { python: 6, typescript: 4, go: 4, java: 3, cpp: 3 },
  calibration: { python: 3, typescript: 2, go: 2, java: 2, cpp: 1 },
  holdout: { python: 3, typescript: 2, go: 2, java: 2, cpp: 1 }
};

const CASES_PER_CELL: Record<Split, number> = { train: 6, calibration: 3, holdout: 2 };
const LANGUAGES: Language[] = ["python", "typescript", "go", "java", "cpp"];
const SPLITS: Split[] = ["train", "calibration", "holdout"];
const SCENARIOS: Scenario[] = ["source_localization", "failure_first", "long_session"];

export async function buildPublicEvidenceIntake(): Promise<{
  intake: Record<string, unknown>;
  registry: Record<string, unknown>;
  summary: Record<string, unknown>;
}> {
  const cases: PublicEvidenceCase[] = [];
  for (const source of DATASET_SOURCES) {
    const rows = await fetchDatasetRows(source.dataset, source.split, "maxRows" in source ? source.maxRows : undefined);
    rows.forEach((row, index) => {
      const normalized = normalizeSweBenchRow(row, {
        sourceId: `${source.id}:${index}`,
        sourceUrl: `${source.sourceUrl}/viewer/default/${source.split}?row=${index}`,
        ...("language" in source ? { fixedLanguage: source.language } : {})
      });
      if (normalized) cases.push(normalized);
    });
  }
  for (const source of MULTI_SWE_SOURCES) {
    const sourceUrl = `https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench/resolve/main/${source.language}/${source.filename}`;
    const response = await fetchChecked(sourceUrl);
    const rows = (await response.text()).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
    rows.forEach((row, index) => {
      const normalized = normalizeMultiSweRow(row, {
        sourceId: `multi-swe-${source.language}:${source.filename}:${index}`,
        sourceUrl,
        language: source.language
      });
      if (normalized) cases.push(normalized);
    });
  }

  const uniqueCases = deduplicateCases(cases);
  const assignments: Array<{ split: Split; scenario: Scenario; row: PublicEvidenceCase }> = [];
  const lineageRoles = new Map<string, Split>();
  for (const language of LANGUAGES) {
    const languageRows = uniqueCases.filter((item) => item.language === language);
    const partition = partitionLanguageLineages(language, languageRows);
    for (const split of SPLITS) {
      for (const repository of partition[split]) lineageRoles.set(repository, split);
      const selected = selectScenarioTasks(
        languageRows.filter((item) => partition[split].includes(item.repository)),
        CASES_PER_CELL[split]
      );
      for (const scenario of SCENARIOS) {
        selected[scenario].forEach((row) => assignments.push({ split, scenario, row }));
      }
    }
  }

  const intakeCases = assignments
    .sort((left, right) =>
      SPLITS.indexOf(left.split) - SPLITS.indexOf(right.split) ||
      LANGUAGES.indexOf(left.row.language) - LANGUAGES.indexOf(right.row.language) ||
      SCENARIOS.indexOf(left.scenario) - SCENARIOS.indexOf(right.scenario) ||
      left.row.sourceId.localeCompare(right.row.sourceId)
    )
    .map((item, index) => ({
      id: `v02c-${item.split}-${item.row.language}-${item.scenario}-${String(index + 1).padStart(3, "0")}`,
      split: item.split,
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
  const usedLineages = new Set(intakeCases.map((item) => item.repositoryLineageId));
  if (usedLineages.size !== lineageRoles.size || [...lineageRoles.keys()].some((repository) => !usedLineages.has(repositoryUrl(repository)))) {
    throw new Error("selected cases must exercise every assigned repository lineage");
  }

  const registry = {
    schemaVersion: "lineage-registry.v1",
    lineages: [...lineageRoles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([repository, role]) => ({ id: repositoryUrl(repository), role }))
  };
  const intake = {
    schemaVersion: "ranker-corpus-intake.v1",
    corpusId: "kairn-evidence-v02c-20260722",
    featureSchemaVersion: "evidence-features-v2",
    sealed: false,
    sampleOnly: false,
    lineageRegistry: "lineage-registry.v1.json",
    sources: [
      ...DATASET_SOURCES.map((source) => String(source.sourceUrl)),
      "https://huggingface.co/datasets/ByteDance-Seed/Multi-SWE-bench"
    ],
    curationStatus: "public_candidates_selected_noise_labels_pending",
    cases: intakeCases
  };
  const summary = {
    schemaVersion: "ranker-corpus-intake-summary.v1",
    candidatePoolSize: uniqueCases.length,
    selectedCases: intakeCases.length,
    selectedLineages: lineageRoles.size,
    cells: Object.fromEntries(SPLITS.flatMap((split) => LANGUAGES.flatMap((language) =>
      SCENARIOS.map((scenario) => [
        `${split}/${language}/${scenario}`,
        assignments.filter((item) => item.split === split && item.row.language === language && item.scenario === scenario).length
      ])
    ))),
    lineages: Object.fromEntries(SPLITS.map((split) => [split, [...lineageRoles.values()].filter((role) => role === split).length])),
    nextAction: "Run draft materialization, review required-source recall, and curate at least six explicit noise files per case before sealing."
  };
  return { intake, registry, summary };
}

function partitionLanguageLineages(
  language: Language,
  rows: PublicEvidenceCase[]
): Record<Split, string[]> {
  const grouped = groupByRepository(rows);
  const repositories = [...grouped.keys()].filter((repository) => grouped.get(repository)!.length > 0).sort();
  const requiredLineages = SPLITS.reduce((total, split) => total + LINEAGE_TARGETS[split][language], 0);
  if (repositories.length < requiredLineages) {
    throw new Error(`${language}: need ${requiredLineages} public repository lineages, found ${repositories.length}`);
  }
  const holdoutOptions = combinations(repositories, LINEAGE_TARGETS.holdout[language]);
  for (const holdout of holdoutOptions) {
    if (!canFill(groupRows(grouped, holdout), CASES_PER_CELL.holdout)) continue;
    const afterHoldout = repositories.filter((repository) => !holdout.includes(repository));
    for (const calibration of combinations(afterHoldout, LINEAGE_TARGETS.calibration[language])) {
      if (!canFill(groupRows(grouped, calibration), CASES_PER_CELL.calibration)) continue;
      const afterCalibration = afterHoldout.filter((repository) => !calibration.includes(repository));
      for (const train of combinations(afterCalibration, LINEAGE_TARGETS.train[language])) {
        if (!canFill(groupRows(grouped, train), CASES_PER_CELL.train)) continue;
        return { train, calibration, holdout };
      }
    }
  }
  throw new Error(`${language}: no lineage-disjoint partition satisfies all scenario quotas`);
}

function canFill(rows: PublicEvidenceCase[], perScenario: number): boolean {
  try {
    selectScenarioTasks(rows, perScenario);
    return true;
  } catch {
    return false;
  }
}

function selectScenarioTasks(
  rows: PublicEvidenceCase[],
  perScenario: number
): Record<Scenario, PublicEvidenceCase[]> {
  const ordered = [...rows].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const selected = new Set<string>();
  const result: Record<Scenario, PublicEvidenceCase[]> = {
    source_localization: [],
    failure_first: [],
    long_session: []
  };
  const eligible = (row: PublicEvidenceCase, scenario: Scenario): boolean =>
    scenario === "source_localization" ||
    (scenario === "failure_first" && row.failureReferences.length > 0) ||
    (scenario === "long_session" && row.changedFiles.length >= 2);
  const take = (scenario: Scenario): void => {
    for (const row of ordered) {
      if (result[scenario].length >= perScenario) break;
      if (!selected.has(row.sourceId) && eligible(row, scenario)) {
        result[scenario].push(row);
        selected.add(row.sourceId);
      }
    }
    if (result[scenario].length !== perScenario) throw new Error(`insufficient ${scenario} cases`);
  };
  (["long_session", "failure_first", "source_localization"] as Scenario[]).forEach(take);

  const byRepository = groupByRepository(ordered);
  const missing = [...byRepository.keys()]
    .filter((repository) => !Object.values(result).flat().some((row) => row.repository === repository))
    .sort();
  const coverMissing = (missingIndex: number): boolean => {
    if (missingIndex >= missing.length) return true;
    const repository = missing[missingIndex]!;
    const counts = new Map<string, number>();
    Object.values(result).flat().forEach((row) => counts.set(row.repository, (counts.get(row.repository) ?? 0) + 1));
    for (const candidate of byRepository.get(repository) ?? []) {
      if (selected.has(candidate.sourceId)) continue;
      for (const scenario of SCENARIOS) {
        if (!eligible(candidate, scenario)) continue;
        for (let index = 0; index < result[scenario].length; index += 1) {
          const donor = result[scenario][index]!;
          if ((counts.get(donor.repository) ?? 0) <= 1) continue;
          result[scenario][index] = candidate;
          selected.delete(donor.sourceId);
          selected.add(candidate.sourceId);
          if (coverMissing(missingIndex + 1)) return true;
          selected.delete(candidate.sourceId);
          selected.add(donor.sourceId);
          result[scenario][index] = donor;
        }
      }
    }
    return false;
  };
  if (!coverMissing(0)) throw new Error("could not cover every assigned repository lineage");
  return result;
}

function normalizeSweBenchRow(
  value: unknown,
  source: { sourceId: string; sourceUrl: string; fixedLanguage?: Language }
): PublicEvidenceCase | undefined {
  const row = asRecord(value);
  const repository = text(row.repo);
  const repositoryRef = text(row.base_commit);
  const prompt = text(row.problem_statement);
  const patch = text(row.patch);
  if (!repository || !isCommit(repositoryRef) || !prompt || !patch) return undefined;
  const changedFiles = patchFiles(patch);
  const language = source.fixedLanguage ?? (
    MULTILINGUAL_CPP_REPOSITORIES.has(repository) ? "cpp" : inferLanguage(changedFiles)
  );
  if (!language || language === "python" && source.fixedLanguage !== "python") return undefined;
  const productionPatchFiles = productionFiles(changedFiles, language);
  if (productionPatchFiles.length === 0) return undefined;
  return {
    sourceId: `${source.sourceId}:${text(row.instance_id) ?? repositoryRef}`,
    sourceUrl: source.sourceUrl,
    repository,
    repositoryRef,
    language,
    prompt,
    productionPatchFiles,
    changedFiles,
    failureReferences: failureReferences(row.FAIL_TO_PASS ?? row.fail_to_pass)
  };
}

function normalizeMultiSweRow(
  value: unknown,
  source: { sourceId: string; sourceUrl: string; language: "java" | "cpp" }
): PublicEvidenceCase | undefined {
  const row = asRecord(value);
  const org = text(row.org);
  const repo = text(row.repo);
  const base = asRecord(row.base);
  const repositoryRef = text(base.sha);
  const patch = text(row.fix_patch);
  const title = text(row.title);
  const body = text(row.body);
  if (!org || !repo || !isCommit(repositoryRef) || !patch || (!title && !body)) return undefined;
  const changedFiles = patchFiles(patch);
  const productionPatchFiles = productionFiles(changedFiles, source.language);
  if (productionPatchFiles.length === 0) return undefined;
  const fixedTests = asRecord(row.fixed_tests);
  return {
    sourceId: source.sourceId,
    sourceUrl: source.sourceUrl,
    repository: `${org}/${repo}`,
    repositoryRef,
    language: source.language,
    prompt: [title, body].filter(Boolean).join("\n\n"),
    productionPatchFiles,
    changedFiles,
    failureReferences: Object.keys(fixedTests).sort()
  };
}

export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const candidate = (match[2] ?? match[1] ?? "").trim().replace(/^"|"$/g, "");
    if (candidate && candidate !== "/dev/null" && !candidate.includes("/../")) files.add(candidate);
  }
  return [...files].sort();
}

function productionFiles(files: string[], language: Language): string[] {
  const extensions: Record<Language, RegExp> = {
    python: /\.pyi?$/i,
    typescript: /\.(?:[cm]?[jt]sx?)$/i,
    go: /\.go$/i,
    java: /\.java$/i,
    cpp: /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i
  };
  return files.filter((file) =>
    extensions[language].test(file) &&
    !/(^|\/)(?:test|tests|testing|spec|specs|docs?|examples?|fixtures?|vendor|third_party|generated)(\/|$)/i.test(file) &&
    !/(^|\/)(?:single_include|amalgamat(?:ed|ion)|dist|build)(\/|$)/i.test(file) &&
    !/(?:_test\.go|test\.java|tests?\.(?:c|cc|cpp|cxx)|\.(?:test|spec)\.[cm]?[jt]sx?)$/i.test(file) &&
    !/(^|\/)\.[^/]+\.(?:[cm]?[jt]s|json|ya?ml)$/i.test(file) &&
    !/(?:^|\/)readme(?:\.|$)/i.test(file)
  );
}

function inferLanguage(files: string[]): Language | undefined {
  const scores: Record<Exclude<Language, "python">, number> = { typescript: 0, go: 0, java: 0, cpp: 0 };
  for (const file of files) {
    if (/\.(?:[cm]?[jt]sx?)$/i.test(file)) scores.typescript += 1;
    if (/\.go$/i.test(file)) scores.go += 1;
    if (/\.java$/i.test(file)) scores.java += 1;
    if (/\.(?:cc|cpp|cxx|hh|hpp|hxx)$/i.test(file)) scores.cpp += 1;
  }
  return (Object.entries(scores) as Array<[Exclude<Language, "python">, number]>)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .find(([, count]) => count > 0)?.[0];
}

function scenarioPrompt(row: PublicEvidenceCase, scenario: Scenario): string {
  if (scenario !== "failure_first") return row.prompt;
  return `Initial failing checks:\n${row.failureReferences.map((item) => `- ${item}`).join("\n")}\n\n${row.prompt}`;
}

function failureReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter((item): item is string => Boolean(item)).sort();
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(text).filter((item): item is string => Boolean(item)).sort();
  } catch {
    // Some public datasets store a single shell/test selector rather than JSON.
  }
  return raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).sort();
}

function deduplicateCases(rows: PublicEvidenceCase[]): PublicEvidenceCase[] {
  const byKey = new Map<string, PublicEvidenceCase>();
  for (const row of rows.sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
    const key = `${row.repository.toLowerCase()}:${row.repositoryRef}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function groupByRepository(rows: PublicEvidenceCase[]): Map<string, PublicEvidenceCase[]> {
  const grouped = new Map<string, PublicEvidenceCase[]>();
  for (const row of rows) {
    const values = grouped.get(row.repository) ?? [];
    values.push(row);
    grouped.set(row.repository, values);
  }
  return grouped;
}

function groupRows(grouped: Map<string, PublicEvidenceCase[]>, repositories: string[]): PublicEvidenceCase[] {
  return repositories.flatMap((repository) => grouped.get(repository) ?? []);
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

async function fetchDatasetRows(dataset: string, split: string, maxRows?: number): Promise<unknown[]> {
  const rows: unknown[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total && offset < (maxRows ?? Number.POSITIVE_INFINITY)) {
    const pageLength = Math.min(100, (maxRows ?? Number.POSITIVE_INFINITY) - offset);
    const query = new URLSearchParams({ dataset, config: "default", split, offset: String(offset), length: String(pageLength) });
    const response = await fetchChecked(`https://datasets-server.huggingface.co/rows?${query}`);
    const payload = asRecord(await response.json());
    const page = Array.isArray(payload.rows) ? payload.rows : [];
    total = typeof payload.num_rows_total === "number" ? payload.num_rows_total : offset + page.length;
    for (const entry of page) rows.push(asRecord(entry).row);
    if (page.length === 0) break;
    offset += page.length;
  }
  return rows;
}

async function fetchChecked(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { "user-agent": "Kairn-v0.2C-public-corpus-builder" } });
  if (!response.ok) throw new Error(`public dataset fetch failed: ${response.status} ${response.statusText} (${url})`);
  return response;
}

function repositoryUrl(repository: string): string {
  return `https://github.com/${repository.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "")}`;
}

function isCommit(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseArgs(argv: string[]): { out: string; registryOut: string; summaryOut: string } {
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
  return { out: required("--out"), registryOut: required("--registry-out"), summaryOut: required("--summary-out") };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const targets = parseArgs(process.argv.slice(2));
  buildPublicEvidenceIntake()
    .then(({ intake, registry, summary }) => {
      for (const target of Object.values(targets)) fs.mkdirSync(path.dirname(target), { recursive: true });
      const materializableIntake = {
        ...intake,
        lineageRegistry: path.relative(path.dirname(targets.out), targets.registryOut).replace(/\\/g, "/")
      };
      fs.writeFileSync(targets.out, `${JSON.stringify(materializableIntake, null, 2)}\n`, "utf8");
      fs.writeFileSync(targets.registryOut, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
      fs.writeFileSync(targets.summaryOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ ...summary, outputs: targets }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
