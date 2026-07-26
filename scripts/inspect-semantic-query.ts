// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import {
  buildSemanticQueryCandidates,
  selectSemanticQueryViewIndexes
} from "../src/retrieval/semanticCandidates.js";
import { loadLocalEmbeddingModel } from "../src/semantic/modelRuntime.js";
import { DEFAULT_SEMANTIC_MODEL_ID } from "../src/semantic/modelRegistry.js";

const [intakeArgument, caseId] = process.argv.slice(2);
if (!intakeArgument || !caseId) {
  throw new Error(
    "usage: pnpm tsx scripts/inspect-semantic-query.ts <intake.json> <case-id>"
  );
}

const intakePath = path.resolve(intakeArgument);
const parsed = JSON.parse(fs.readFileSync(intakePath, "utf8")) as {
  cases?: Array<{ id?: string; prompt?: string }>;
};
const intakeCase = parsed.cases?.find((candidate) => candidate.id === caseId);
if (!intakeCase?.prompt) throw new Error(`Case is missing from the intake: ${caseId}`);

const modelId = process.env.KAIRN_SEMANTIC_MODEL?.trim() || DEFAULT_SEMANTIC_MODEL_ID;
const model = await loadLocalEmbeddingModel({ modelId });
const candidates = buildSemanticQueryCandidates(intakeCase.prompt);
const vectors = await model.embedQueries(candidates.map((candidate) => candidate.text));
const selected = new Set(selectSemanticQueryViewIndexes(candidates, vectors));

process.stdout.write(`${JSON.stringify({
  caseId,
  modelId,
  candidates: candidates.map((candidate, index) => ({
    index,
    selected: selected.has(index),
    kind: candidate.kind,
    structuralIndex: candidate.structuralIndex,
    text: candidate.text
  }))
}, null, 2)}\n`);
