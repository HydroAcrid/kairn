# v0.2C-S Model-Based Semantic Candidates

Status: implementation complete enough for frozen candidate-gate evaluation; promotion is not yet approved.

## Contract

Kairn's permanent evidence path is:

`structural parsers → independent candidate generators → local semantic retrieval → calibrated file ranker → deterministic governor`

Parsers extract objective facts. The local embedding model supplies semantic similarity. The logistic file ranker estimates required-source probability. Deterministic policy owns hard pins, generated/vendor exclusions, delivery, budgets, repeated-context suppression, and abstention.

No regular expression, filename token, task token, benchmark identity, repository identity, or fixture identity may create semantic relevance. `pnpm check:semantic-architecture` enforces the semantic-serving boundary.

## Runtime

The preferred model is `jina-code-v2-q8`, pinned to upstream revision `516f4baf13dec4ddddda8631e019b5737c8bc250`. BGE small remains the evaluated fallback candidate. Both use immutable manifests, CPU-only ONNX inference, local tokenizers, checksummed atomic installation, normalized embeddings, and compact int8 repository storage.

```bash
kairn model status
kairn model install
kairn model verify
kairn model remove
kairn enable --offline
```

Retrieval performs no network call. A missing, corrupt, incompatible, or stale model/index falls back visibly to exact path, precise failure, exact symbol, BM25, git, session, and graph evidence.

## Candidate Flow

1. Hard-pin exact paths and precise failure references.
2. Independently rank semantic, BM25, exact-symbol, git, and session candidates.
3. Search the full available semantic embedding index.
4. Collapse semantic documents to files by maximum normalized cosine similarity.
5. Fuse non-hard rankings with reciprocal-rank fusion.
6. Keep at most 64 initial candidates.
7. Add only direct graph and source/test neighbors, capped at 128.
8. Build `evidence-features-v4` for the bounded union. The v4 schema retains
   real semantic similarity and adds objective parser-graph precision,
   independent-seed consensus, bounded support, supporting-seed strength, and
   independent retrieval evidence as model inputs. Probe-seed facts are passed
   through from candidate generation instead of being recomputed from only the
   first 64 files; none of these facts directly assigns relevance.
9. Rank files with the calibrated logistic artifact when enabled.
10. Let deterministic policy select content, path hint, request-evidence, suppression, or abstention.

`legacy` and `shadow` remain rollback modes through v0.3. Semantic mode never uses the old hashed vectors as relevance evidence.

## Frozen Evidence

Tracked checkpoints:

- `benchmarks/checkpoints/v02c-semantic-baseline-cf43ef8.json`
- `benchmarks/checkpoints/v02c-semantic-model-selection-v4-d5aa740.json`
- `benchmarks/checkpoints/v02c-semantic-holdout-v4-566f912.json`
- `benchmarks/semantic/oracle38-cases-v1.json`
- `artifacts/ranker-corpus-intake.reviewed-v35.json`
- `artifacts/lineage-registry.reviewed-v35.json`

The reviewed intake is pinned by SHA-256
`bcfe94973f9e93964a2bd0473addb3c1f43a0b4fed1168de690214db36629fa6`.
The 38-case manifest freezes the cases whose required production source
existed in the checkout used by the legacy baseline. The raw 165-case
candidate intake is not a valid recall oracle because it predates the
reviewed required-source labels.

Legacy public-oracle baseline:

- strict full required-source Recall@64: 26/38 = 68.42%;
- strict full required-source Recall@128: 31/38 = 81.58%;
- zero-positive cases at 128: 3.

Frozen v4 model selection:

| Model | Recall@1 | Recall@5 | MRR | Median query latency |
| --- | ---: | ---: | ---: | ---: |
| Jina code | 100% | 100% | 1.000 | 29.543 ms |
| BGE small | 70% | 100% | 0.833 | 14.434 ms |

Fresh Jina v4 holdout:

- ranks: Python 1, TypeScript 3, Go 1, Java 12, C++ 1;
- Recall@1: 60%;
- Recall@5: 80%;
- strict full Recall@64 and Recall@128: 100%;
- MRR: 0.683333;
- zero positive misses at 128: 0.

The Java rank-12 result is a disclosed negative ranking result. It is acceptable for the candidate-generation gate, not proof that the downstream ranker is ready.

Runtime at 7,500 documents:

- cold initialization: 1,051.56 ms;
- query p95: 26.763 ms;
- vector scan p95: 12.594 ms;
- combined warm upper bound: 39.357 ms;
- projected initial embedding: 20.57 minutes.

## Public Calibration Repair

The first Babel calibration attempt missed the required parser source at 64 because the large file had only a file summary and class document. The general repair added JS/TS method extraction and replaced first-symbol allocation with bounded weighted allocation across files plus even sampling within each file.

No target term, filename, symbol, repository, or issue phrase was added to retrieval policy.

On the same 24,759-file checkout, the required source moved into the real serving union at rank 12/64 with semantic similarity `0.661666`. State grew from 149,463,144 to 159,146,088 bytes.

## Promotion Gate

The resumable public-oracle materialization writes:

- `artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.json`
- `artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.report.json`
- `artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.json.progress.json`

Each successful isolated case is written atomically to the progress file.
`--resume` refuses to reuse progress unless the Kairn commit, reviewed-intake
hash, and ordered case set are identical.

```bash
CASE_IDS="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("benchmarks/semantic/oracle38-cases-v1.json","utf8"));process.stdout.write(x.caseIds.join(","))')"
KAIRN_CANDIDATE_MODE=semantic \
KAIRN_SEMANTIC_MODEL=jina-code-v2-q8 \
KAIRN_SEMANTIC_THREADS=4 \
pnpm exec tsx scripts/materialize-evidence-corpus.ts \
  --intake artifacts/ranker-corpus-intake.reviewed-v35.json \
  --out artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.json \
  --report-out artifacts/ranker-corpus.semantic-v4-oracle38-reviewed.report.json \
  --cache artifacts/ranker-checkouts \
  --draft \
  --case-id "$CASE_IDS" \
  --migrate-feature-schema \
  --resume
```

Promotion remains blocked until:

- strict full required-source Recall@64 is 38/38;
- per-language Recall@64 is at least 95%;
- zero positive cases miss at 128;
- generated/vendor top-one is zero unless objective evidence references it;
- state and runtime limits pass;
- ranker data is rebuilt against the frozen semantic union;
- downstream Recall@5, MRR, calibration, verification, and source-invariant gates pass.

The 35 reviews against the legacy union are `superseded-pending`. Claude/ReasonBlocks spend, the 180-attempt pilot, and npm beta preparation remain paused.

## Current Train/Calibration Result

The 135-case public train/calibration pass completed without opening the
detached holdout:

- 90 train cases and 45 calibration cases;
- strict reviewed-oracle full recall: 4/8 at 64 and 8/8 at 128;
- weak official-patch any-hit: 95.56% at 64 and 97.78% at 128;
- the v4 pointwise ranker reached calibration ECE 0.0263, Recall@5 77.78%,
  and MRR 0.4584.

Those numbers are diagnostic, not promotion evidence. In particular, 100%
recall at 128 does not satisfy the 64-candidate serving gate.

Additional general model experiments were screened and rejected rather than
left as serving complexity:

- a learned importer-corroboration feature received a negative coefficient
  and regressed Recall@5, MRR, and calibration;
- a pairwise objective for the existing 26 file features worsened Recall@5
  and calibration while leaving candidate recall unchanged;
- a 33M-parameter local cross-encoder took about 7.15 seconds for 64 realistic
  query/document pairs on the CPU/WASM runtime, far above the 300 ms warm
  candidate-generation gate. A smaller 17M checkpoint did not expose a
  directly usable scoring output in its pinned ONNX graph and was not wired
  into serving without a validated head;
- diagonal and affine embedding adapters improved weighted pair loss but did
  not add any independently recalled required source at 64;
- equal-weight RRF across semantic and graph lanes reduced strict recall to
  1/8, while learned lane-rank, graph-message, and semantic/graph interaction
  selectors produced only train-lineage gains or calibration regressions;
- the pinned CodeRank alternative passed local runtime integrity but lost to
  Jina on the unchanged selection set: Recall@1 was 80% versus 90%, and MRR
  was 0.875 versus 0.95. It therefore did not justify a public-corpus reindex.

No regex, path-token promotion, filename bonus, graph quota, or fixed importer
quota replaced these failures. Jina remains the selected model, and the 128-file
bounded union remains the stable evidence pool for the next training-data pass.
The next work expands independently reviewed train/calibration required-source
labels and deterministic train-only synthetic prompt variants, then retrains the
standard L2-logistic ranker. The detached holdout remains sealed. No new serving
mechanism is promoted unless it improves separate calibration lineages and
retains the runtime and calibration gates.

The synthetic-data path uses bounded deterministic views of existing public
train prompts. It preserves the parent repository, commit, labels, language,
and scenario; adds no target path or new factual claim to the prompt; and never
creates calibration or holdout variants. Parent selection is stable within each
language/scenario cell and independent of ranker output. Production corpus
validation continues to require the fixed 165 natural cases and treats these
train-only variants as additional grouped examples, not replacements for the
public matrix.

The first bounded synthetic pass materialized 30 views across all five
languages and three scenarios with 100% embedding-cache reuse. One view was
excluded before fitting because no positive source label entered its 512-file
probe pool. Adding the remaining 29 train-only views to the unchanged 135-case
train/calibration corpus produced the following calibration result:

| Metric | v4 baseline | With synthetic train views | Delta |
| --- | ---: | ---: | ---: |
| Required-file Recall@5 | 77.78% | 79.17% | +1.39 pp |
| Required-file MRR | 0.458434 | 0.458421 | -0.000013 |
| Expected calibration error | 0.026324 | 0.027175 | +0.000851 |
| Generated/vendor top-one violations | 0 | 0 | 0 |

This is a small positive calibration result, not promotion or holdout evidence.
The detached holdout remains unopened. The persistent misses are still in the
TypeScript candidate pool: one required file is absent from the 512-file probe,
and another ranks 146th. Further work therefore targets general semantic
candidate recall rather than adding path, filename, or issue-specific ranking
rules.

## Semantic-Union Review Refresh

The frozen semantic candidate union changes which explicit negative files are
available to the file ranker. Review carry-forward is therefore conservative:
a prior decision is reused only when every reviewed label still has the same
meaning in the current candidate union. Required source paths that are created
by the official patch are tracked separately because they cannot be candidates
before the task is solved.

The refresh operates only on the 135 train and calibration cases. The 30-case
holdout remains detached and unopened. Tooling now verifies that a partial
materialization declares its selected case IDs and exactly matches the
materialized manifest and report before a review queue is built.

Current audited progress:

- 40 of 135 decisions were safely carried from the prior review;
- 95 cases required fresh negative review because prior negative files were no
  longer present in the semantic candidate union;
- the first 10 fresh decisions passed immutable-context and candidate-membership
  validation, bringing the total to 50 complete and 85 pending;
- no case is pending because a required source label was lost;
- no decision was filled automatically, and no detached holdout case entered
  the review queue.

These review counts are data-readiness results, not a new retrieval or ranker
benchmark. The next ranker comparison occurs only after all 135 decisions are
complete and the train/calibration datasets are rematerialized.

## Long-Run Durability

Resumable corpus work now uses a compact atomic progress header and one
immutable atomic file per completed case. It remains backward-compatible with
the former monolithic progress format and migrates it on the next successful
write. This prevents each completed case from serializing and replacing the
entire growing corpus journal.
