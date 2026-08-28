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

Each successful isolated case is written to an atomic per-case resume journal.
`--resume` refuses to reuse progress unless the Kairn commit, reviewed-intake
hash, and ordered case set are identical. After both final artifacts are
durable, Kairn replaces those case journals with a small receipt containing
the artifact paths and SHA-256 hashes. Repeating the same completed command
validates and reuses that receipt instead of retaining duplicate case rows.

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
- all 95 fresh decisions passed immutable-context, candidate-membership,
  minimum-negative, and positive/noise-overlap validation;
- the final strict merge contains 135 complete decisions and zero pending;
- two absent official-patch paths received explicitly reviewed nearby
  implementation oracles rather than being counted as retrieval hits;
- no decision was filled automatically, and no detached holdout case entered
  the review queue.

The partial review application is explicit and fail-closed. It updates only the
135 IDs declared by the materialization report, preserves all 30 detached
holdout rows unchanged, and always emits an unsealed intake. Its reviewed
train/calibration derivative contains 812 explicit negative labels and 12
required-source oracle cases. A partial application cannot be mistaken for a
promotion corpus or passed through the full sealing path.

These review counts are data-readiness results, not a new retrieval or ranker
benchmark. The next comparison occurs after the reviewed train/calibration
intake is rematerialized against the unchanged semantic serving path.

### Reviewed ranker refresh

The 135 reviewed train/calibration cases were rematerialized at commit
`e1d7c44` with an explicit offline 512-candidate diagnostic probe. Public
serving remains bounded at 64 initial and 128 enriched candidates. The
diagnostic contains 1,068 labeled rows: 812 reviewed negatives, 17
required-source positives, and 239 verified-patch positives. The detached
30-case holdout remains unopened.

The reviewed model is a mixed result on the same 45-case calibration split:

| Diagnostic | Prior v166 model | Reviewed v170 model |
|---|---:|---:|
| Required-file recall@5 | 76.39% | 69.44% |
| Required-file MRR | 0.4634 | 0.4380 |
| Expected calibration error | 0.0315 | 0.0356 |
| Strict full recall@128 | 95.56% | 97.78% |
| Generated/vendor top-one violations | 0 | 0 |

The reviewed required-source diagnostic provides a narrower positive result.
Across the 10 train/calibration cases with independently reviewed source
oracles, raw initial recall@64 is 50% and bounded-union recall@128 is 100%.
Ranking the same 128-file union with the prior model reaches 60% strict full
recall@64 and 70.59% required-file recall@64. The reviewed model reaches 70%
and 82.35%, respectively. This is train/calibration diagnostic evidence, not
holdout or promotion evidence.

The model is therefore not promoted. The improvement in reviewed-source
ranking does not offset the calibration ranking regression, and the 99%
candidate gate is still unmet. Balanced semantic/graph lane ablations also
failed to improve the full corpus and were not retained. Paid Claude and
ReasonBlocks runs remain blocked while the next iteration addresses general
semantic/structural representation rather than adding filename, task-term, or
benchmark-specific rules.

## Long-Run Durability

Resumable corpus work now uses a compact atomic progress header and one
immutable atomic file per completed case. It remains backward-compatible with
the former monolithic progress format and migrates it on the next successful
write. This prevents each completed case from serializing and replacing the
entire growing corpus journal.

## Frozen Candidate-Coverage Follow-up

The rankability audit selected candidate generation as the next mechanism to
repair. A fresh reconstruction at audit-tip commit `56d82fd` established the
current serving baseline on the same frozen 38-case / 72-required-file oracle:
30/38 strict full recall at 64, 37/38 at 128, 59/72 required-file recall at 64,
and 69/72 at 128. This later current-code baseline is distinct from the
historical `0360c32` journal used by the rankability audit and must not be
combined with it.

The only incomplete case at 128 was a TypeScript source-localization task in a
repository with dynamic database dispatch. Imported member calls such as
`db.getObject(...)` were not preserved as parser facts, so graph construction
could not distinguish the concrete modules implementing the invoked member
from the other modules installed behind the dispatcher.

Commit `fa03e923b83e5df6c87a4d017f0102962e733f28` adds a general structural
mechanism: JavaScript and TypeScript parsing records imported module member
calls, and graph construction adds bounded call edges only to imported
concrete modules that define those members. It adds no filename, task-term,
repository-specific, regular-expression relevance, or semantic-scoring rule.
A broader graph-importer fusion experiment recovered the target but displaced
two required Go files; that fusion change was reverted and is not part of the
frozen candidate.

The isolated mechanism produced this same-cohort result:

| Candidate metric | `56d82fd` baseline | `fa03e92` candidate | Delta |
| --- | ---: | ---: | ---: |
| Strict full recall@64 | 30/38 (78.95%) | 30/38 (78.95%) | 0.00 pp |
| Required-file recall@64 | 59/72 (81.94%) | 62/72 (86.11%) | +4.17 pp |
| Strict full recall@128 | 37/38 (97.37%) | 38/38 (100%) | +2.63 pp |
| Required-file recall@128 | 69/72 (95.83%) | 72/72 (100%) | +4.17 pp |

No case moved backward. The paired case-bootstrap 95% intervals for the two
required-file improvements are 0 to +12 percentage points; the strict-full
128 interval is 0 to +7.89 points. Therefore this passes the zero-miss
bounded-pool gate but is not statistically sufficient for a public “Kairn is
better” claim. Eight cases and 11 required files remain outside served rank 64,
while every one is present by rank 128.

Focused parser/graph tests passed 91/91, TypeScript typecheck and the semantic
architecture guard passed, Tier A completed validly in 15.386 seconds, and the
offline five-language Tier B completed validly in 19.846 seconds. The full
candidate comparison reused 186,173 embeddings and created none. Raw evidence
artifacts are ignored but bound by SHA-256 in
`benchmarks/checkpoints/v02c-candidate-coverage-fa03e92.json`.

Candidate generation is now frozen. The next experiment is to rematerialize
the 135 train/calibration cases under the new index schema, review changed rows,
and evaluate the next learned reranker against v166 on identical 128-file
pools. The detached holdout and paid Claude/ReasonBlocks work remain blocked
until the served-ranker and calibration gates pass.

## Frozen Learned-Reranker Follow-up

The 135 train/calibration cases were regenerated at commit `c7622bb` with
whole-file and symbol-body semantic similarities preserved separately. Every
repository index snapshot was reused, all 558,081 embeddings were reused, and
no embedding was regenerated. The isolated run completed in 1,441,660.943 ms
(24.03 minutes), with a 10.018-second median and 16.276-second p95 per case.
The regenerated 128-file paths and all pre-existing feature values are
byte-for-byte identical to the frozen v172 comparison pool.

The strongest diagnostic uses those document-kind features with a
case-normalized pairwise logistic objective and an improved Newton/line-search
Platt calibration fit. Against v166 on the same cases and files:

| Metric | v166 | Candidate | Delta | Paired case-bootstrap 95% CI |
| --- | ---: | ---: | ---: | ---: |
| Calibration Recall@5 (45 cases / 72 files) | 76.39% | 75.00% | -1.39 pp | -6.85 to +5.26 pp |
| Calibration MRR | 0.4636 | 0.4746 | +0.0110 | -0.0260 to +0.0523 |
| Calibration Recall@64 | 97.22% | 97.22% | 0.00 pp | 0.00 to 0.00 pp |
| Required-source MRR (10 cases / 17 files) | 0.1404 | 0.1834 | +0.0430 | +0.0007 to +0.1284 |
| Required-source Recall@64 | 70.59% | 76.47% | +5.88 pp | 0.00 to +17.65 pp |

The candidate's ECE is 0.0263 and it produces no generated/vendor top-one
violations. Required-source MRR is the first learned-reranker metric whose
paired interval is above zero. Calibration Recall@5 is within the two-point
noninferiority margin and calibration MRR is directionally higher.

This is still classified `completed_negative`, not promotion-ready. The
required-source Recall@64 gate is 99%, and the candidate reaches only 76.47%.
Four cases remain outside rank 64. In each failure, 61 to 98 higher-ranked
candidates are unlabeled while only three to five reviewed negatives appear
above the required source. The learner is correctly forbidden from treating
those unlabeled candidates as irrelevant. The next mechanism is therefore a
training-only hard-negative review of the high-ranked distractors; calibration
labels remain untouched. If reviewed labels do not close the served-recall
gap, the next model experiment is a local cross-encoder, not a path, term, or
regular-expression relevance rule.

Shallow nonlinear, query-rank, and graph-rank feature probes all regressed and
were removed rather than added to serving complexity. The detached holdout,
paid Claude/ReasonBlocks runs, npm publication, and public effectiveness copy
remain blocked. Exact artifact hashes and negative-result disclosures are in
`benchmarks/checkpoints/v02c-learned-reranker-309377b.json`.

## Reviewed Hard Negatives and Cross-Encoder Diagnostic

The training-only hard-negative review inspected 30 high-ranked distractors
from the four required-source failures. Immutable source review classified 7
as clearly irrelevant, 20 as plausibly relevant, and 3 as uncertain. Only the
7 irrelevant files became negative labels; relevant and uncertain files stayed
unlabeled. The resulting v185 pairwise model improved required-file recall at
64 from 76.47% to 82.35% and strict full recall at 64 from 60% to 70%, while
calibration Recall@5 remained 75%. Required-source MRR moved backward by
0.0107, and the 99% served-recall gate still failed. This result ruled out more
unreviewed negative pressure as a responsible next step.

A controlled local cross-encoder experiment then added exactly one learned
query/file probability plus an explicit missingness field to v185. Candidate
pools, structural features, labels, repository lineages, pairwise objective,
calibration split, and deterministic failure/path priorities remained frozen.
The pinned quantized `jina-reranker-v1-tiny-en` artifact is 33.4 MB. Scoring
6,304 file documents across all 135 immutable snapshots completed in 466.97
seconds and did not access the detached holdout.

Against v185 on the identical 45-case calibration cohort and 10-case
required-source diagnostic:

| Metric | v185 | Cross-encoder feature | Delta | Paired case-bootstrap 95% CI |
| --- | ---: | ---: | ---: | ---: |
| Calibration Recall@5 | 75.00% | 76.39% | +1.39 pp | 0.00 to +4.69 pp |
| Calibration MRR | 0.4793 | 0.4790 | -0.0003 | -0.0030 to +0.0018 |
| Calibration Recall@64 | 97.22% | 97.22% | 0.00 pp | 0.00 to 0.00 pp |
| Required-source Recall@5 | 17.65% | 17.65% | 0.00 pp | 0.00 to 0.00 pp |
| Required-source Recall@64 | 82.35% | 82.35% | 0.00 pp | 0.00 to 0.00 pp |
| Required-source MRR | 0.1728 | 0.1733 | +0.0006 | -0.0001 to +0.0013 |
| Calibration ECE | 0.0317 | 0.2105 | +0.1788 | n/a |

Both models produced zero generated/vendor top-one violations. The candidate
is `completed_negative`: its only Recall@5 gain is not strictly positive under
the paired interval, it does not move the required-source served-recall gate,
and calibration fails the 0.05 maximum. The raw cross-encoder is also much
worse than the structural ranker, so neither replacement nor combination is
promotion-worthy. v185 remains the internal baseline and the cross-encoder is
not added to serving complexity.

The scoring run exposed and fixed one infrastructure defect before the learned
fit: full calibration pools previously omitted a labeled file when that file
sat outside the frozen 128-path pool. The scorer now evaluates the exact frozen
pool plus any additional reviewed rows, marks their membership explicitly, and
computes effectiveness ranks from the frozen pool only. A content and source
implementation fingerprint prevents repaired output from being spliced into an
older run.

The next experiment is data resolution, not a larger model. The current strong
required-source diagnostic has only 10 cases, no Python cases, and uneven
language/scenario coverage. Expand and review that cohort first, then rerun the
frozen rankability audit. A subsequent model-family experiment is allowed only
if the larger reviewed set can distinguish feature insufficiency from objective
or capacity failure.

## Balanced 15-cell required-source stopping result

The follow-up cohort froze one deterministic calibration case in every
language/scenario cell: 15 cases across Python, TypeScript, Go, Java, and C++,
crossed with source localization, failure-first debugging, and long sessions.
Manual public-patch review produced 22 required existing production files. New
files were recorded but excluded from retrieval recall because they do not
exist in the starting checkout.

The exact pushed campaign passed the ranker infrastructure doctor with the
pinned Node, pnpm, Python, and Jina runtimes. It reused the frozen v178 pools
and ran v185 once without rematerializing repositories, retraining a model,
opening a holdout, or calling a paid provider.

| Metric | v185 balanced result |
| --- | ---: |
| Strict full case Recall@64 | 100.00% (15/15) |
| Required-file Recall@64 | 100.00% (22/22) |
| Required-file Recall@5 | 68.18% (15/22) |
| MRR | 0.4795 |
| Calibration ECE | 0.0317 |
| Generated/vendor top-one violations | 0 |

Source-localization and failure-first cells reached 100% Recall@5. Long-session
cells reached 41.67%, and TypeScript reached 28.57%, showing that multi-file
prioritization remains the main beta risk even though every reviewed required
file is available within the served 64.

The preregistered discipline required roughly a five-point absolute
required-file Recall@64 gain, or a paired confidence interval above zero, before
continuing ranking work. Because v185 is already at the 100% Recall@64 ceiling
on this cohort, no qualifying experiment is possible. Ranking work is therefore
frozen. The next work is beta-user installation, reporting, and quality-gated
live token evidence—not another offline tuning loop.

This is retrospective development evidence, not a public effectiveness claim.
These calibration lineages contributed to model development, and v185 ranks
were inspectable while the deterministic cohort was constructed. In addition,
the old detached holdout identities were exposed during a development
inspection on 2026-08-28. That artifact is now permanently tombstoned and was
not used here. A new sealed holdout must use fresh repository lineages. Exact
hashes and the stopping decision are recorded in
`benchmarks/checkpoints/v02c-balanced-required-source-39667a4.json`.
