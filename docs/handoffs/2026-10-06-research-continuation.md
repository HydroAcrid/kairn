# Kairn research handoff — October 6, 2026

## Start here

The semantic Codex A/B campaign finished on September 5. All 90 attempts are
preserved, valid, and quality-passing. No run is active. The next proposed work
is one bounded experiment to reduce low-value interventions and expensive
outliers. That experiment has **not** been implemented or started.

Kairn helps the agent reach relevant code and avoid repeated exploration.
The completed pilot supports that behavior, but it does not establish lower
total usage or faster completion across all tasks. Keep product claims plain
and quantified, with their baseline and limitations.

Read this file and `benchmarks/checkpoints/v02c-codex-pilot-9cbda05.json`
before reading the long historical chat or July handoff.

## Verified source and ownership

Verified on October 6 before this documentation change:

| Item | State |
| --- | --- |
| WSL checkout | `/home/kevin_dotel/projects/kairn` |
| Windows workspace | `\\wsl.localhost\Ubuntu\home\kevin_dotel\projects\kairn` |
| Research branch | `codex/v0.2c-calibrated-ranker` |
| Last implementation/evidence commit | `05dd4c16cefaefddabfef9579229b3b6baa48661` |
| Local and remote research branch | Matching, clean, pushed |
| Remote main | `9051beb6e857fde98720bf2a6718ba42143a094f` |
| Completed campaign implementation | `9cbda059b8889d5340e5d5b7667b60fa7119ac5c` |
| Active benchmarks / subagents | None |

The user gave standing permission to push green checkpoints. Preserve branch
history and unrelated work. This handoff does not authorize publication,
merging, messaging other tasks, or starting a new paid campaign.

The app currently exposes a connected Mac host and a dormant task named
`Create new Kairn website` at `/Users/kevindotel/Documents/Projects/kairn`.
Its latest report concerns other project design work, so it is not a current
Kairn Git-state receipt. The Mac checkout, dirty files, and running builds were
not inspected. Inspect them before pulling, switching, or sharing ownership.
No message was sent to that task and no Mac files were changed.

There are several older WSL worktrees. Their existence does not mean they are
active or safe to remove. Use `git worktree list --porcelain` and inspect each
target before cleanup. The main-eval, semantic-stable, selector, iteration,
and readiness checkouts contain older work; do not continue from them by
accident.

## Shipping product and research are separate

- Local package metadata is `usekairn@0.2.0-beta.2`, Apache-2.0.
- The September 23 shared notes identify npm `beta` as beta.2 and the source
  repository as private. Registry and website status were not rechecked today.
- The semantic research branch has not been merged into main or released.
- Calibrated-by-default promotion remains blocked.
- `kairn report` leads with estimated context saved and keeps that estimate
  separate from provider-observed model tokens and billing.
- Agent setup support is not proof of equivalent efficacy on every client.

The intended architecture remains structural facts, independent candidate
lanes, real local embeddings, a learned file ranker, then delivery policy.
Objective path/symbol/failure parsing is allowed. Regex, filenames, task words,
repository names, fixture names, and special-case symbol bonuses must not
create semantic relevance.

## What finished

The local Jina semantic generator was frozen at `e0c0dfb`. An inference-runtime
identity fix prevents native and WebAssembly embeddings from being mixed.
The balanced development cohort retained all 22 required files inside rank
64. Native and fallback package paths and offline retrieval were tested.

Two later query/fusion experiments regressed ranking and were reverted with
history preserved (`20bdede`, `23e924e`). Their negative receipt is
`benchmarks/checkpoints/v02c-semantic-ab-rejected-37e5b33.json`.

The frozen generator then rematerialized 135 train/calibration cases. A
pairwise logistic refresh improved some ranking/calibration diagnostics, but
required-source Recall@64 stayed 70.59% on the separate 10-case/17-file
diagnostic. It was rejected for promotion. See
`benchmarks/checkpoints/v02c-ranker-refresh-v186-23e924e.json`.

Keep the cohorts distinct: the 15-case/22-file balanced development cohort,
the 10-case/17-file required-source diagnostic, the 45-case/72-file weak-patch
calibration cohort, and the old 38-case candidate oracle are different
populations. Do not combine their percentages.

The installed-model receipt bug was fixed at `9cbda05`. Compatible existing
models now refresh their receipt instead of retaining an obsolete manifest
hash. The live pilot used that exact pushed implementation throughout.

## Complete live pilot result

Campaign: `codex-v02c-semantic-pilot`.

- 15 public tasks: five languages × three scenarios.
- Three repeats × two conditions = 90 attempts / 45 matched pairs.
- Conditions: vanilla Codex and Codex with Kairn hooks.
- Pinned Codex CLI `0.145.0`, model `gpt-5.6-sol`, medium reasoning,
  standard service tier, fast mode off, seed `20260722`.
- Semantic model `jina-code-v2-q8`; ranker `kairn-semantic-rc-v185`;
  feature schema `evidence-features-v5`.
- Subscription authentication; no Claude/ReasonBlocks run.

| Metric | Vanilla | Kairn | Interpretation |
| --- | ---: | ---: | --- |
| Valid attempts | 45/45 | 45/45 | Complete protocol |
| Verification, required-source, scope, and invariant passes | 45/45 | 45/45 | Quality held |
| Observed total model tokens | 21,876,901 | 22,012,193 | Kairn +0.62% overall |
| Pairs with fewer Kairn tokens | — | 29/45 | 16 regressions retained |
| Median paired token saving | — | 23,476 | Generated 95% interval: 3,014–36,847 saved |
| Median paired percentage saving | — | 3.49% | Descriptive statistic |
| Extraneous files opened | 8,768 | 827 | -90.57% |
| Explicit noise files opened | 793 | 34 | -95.71% |
| Repeated unchanged-read events | 24,513 | 520 | -97.88% |
| Total agent-run time | 7,134,621 ms | 7,526,256 ms | Kairn +5.49% |
| Total cold preparation + agent time | 7,215,270 ms | 10,021,274 ms | Kairn +38.89% |

Cold Kairn setup averaged 53.9 seconds per fresh checkout. Cold preparation
and warm operation need separate reporting. This campaign supports neither
a general speed claim nor an unconditional total-token reduction headline.

The checkpoint records `completed_positive` for the paired-median metric and
`publicationEligible: false`. Retain that historical classification, while
recognizing that its bootstrap samples the 45 repeat pairs independently;
the three repeats of each task are correlated. Before using statistical
significance in public copy, calculate uncertainty with task grouping and
confirm on new tasks. This pilot compares semantic Kairn with vanilla, not
with the deployed deterministic Kairn version.

All 75 Kairn hook invocations have matching audit events. The raw evidence
field names are counterintuitive: `positiveTokenPairs` counts savings and
`negativeTokenPairs` counts regressions. Signed deltas are Kairn minus
vanilla, so negative means fewer Kairn tokens.

File-open/repeated-read counters are syscall-derived activity measures;
they are not themselves saved model tokens. Quality passes are the recorded
verifier/source gates, not a guarantee of every aspect of output quality.

## Artifacts and exact identities

Local campaign directory:
`artifacts/codex-v02c-pilot-9cbda05/`.

The four hashes below were revalidated on October 6:

| File | SHA-256 |
| --- | --- |
| `codex-pilot-manifest.json` | `222870147077c5b0d3961d348b43c6a03db25a108f68815c1c819b480486a493` |
| `codex-pilot-attempts.jsonl` | `e5bb9f8d83b12796b828aa5039ecefd0ab988b51ed7d0c9112c8bef177dff6e5` |
| `codex-pilot-report.json` | `27ca15cf7b790b9b166c7b6e7d2f302ee6f71a7923dd5524cda3778aaf70099d` |
| `public-codex-pilot-evidence.v1.json` | `f248487eed0961544c591a9b772a8c4a1ff2e0dae983f44349d6d088884eda04` |

Plan SHA-256:
`4c03e76328d64b168086eeb07bb9eea0dcd1c6b0e2344bc5d4866d17488165cb`.
Semantic receipt SHA-256:
`d36c6ed084986e362004c43ddca67dabf5ef281617882eed9ee0e4b7dca999c0`.
Ranker checksum:
`642aeadca7e66ef6d44de7b1f1c9a76fe881ff023461589995fd6b52f89f5bad`.

Checkpoints and source are in Git. Raw transcripts, syscall traces, model
cache, embeddings, repositories, and campaign workspaces remain local;
pulling the branch on the Mac does not transfer these artifacts. Arrange a
scoped checksummed transfer if the next task needs stored traces. Keep
credentials and raw private evidence out of Git and Obsidian.

## Next work and stopping discipline

1. Diagnose the large regressions from stored traces before changing policy.
   Separate evidence usefulness, agent verification/toolchain difficulties,
   turn count, cached/uncached input, and cold indexing overhead. Some Go/Java
   agent traces reported missing toolchains or denied Docker access while the
   independent harness verifier passed; inspect their effect on extra agent
   work before blaming retrieval or training a guard.
2. Write one preregistered general value-guard/abstention experiment, with
   exact inputs, artifact identity, evaluation cohort, quality gates, and
   stopping rule. The earlier chat proposed this experiment; no guard model,
   training data, threshold selection, or implementation exists yet.
3. Use general confidence, evidence cost, repository/session state, and
   incremental information signals. Preserve exact user paths, precise
   failures, source access, stale-index handling, and delivery budgets.
   Do not label the 45 observed pairs as a utility-training dataset: they
   establish outcomes, not causal labels for individual interventions.
4. Prove the mechanism on the smallest useful reproducer and focused tests.
   Reuse immutable inventory/embeddings. Run the expensive corpus only when
   a distinct mechanism fingerprint changes and the small reproducer passes.
5. Evaluate any candidate on new lineage-disjoint live tasks with the same
   settings across arms. Disclose every miss, regression, and invalid
   attempt. Require quality preservation and meaningful token improvement;
   report aggregate cost and task-grouped uncertainty alongside the median.
6. If the single experiment does not produce a meaningful gain, freeze
   ranking work and focus on beta feedback, installation, reporting, and
   actual user evidence. Do not start another open-ended tuning loop.

The historical detached holdout is contaminated/tombstoned. Some older
campaign JSON still says `sealed_detached`; this is a known stale-status
conflict, not permission to reopen it. Resolve the manifest status before
any future holdout command and create fresh lineage-disjoint evidence for
promotion. The original four-arm 180-attempt pilot and 600-attempt campaign
have not occurred.

## Environment and useful files

The default WSL shell may select Node 18 and lack pnpm. Use the pinned
environment before commands:

```bash
cd /home/kevin_dotel/projects/kairn
export PATH=/home/kevin_dotel/.nvm/versions/node/v24.18.0/bin:/home/kevin_dotel/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
node --version
pnpm --version
python3 --version
git status -sb
git log -1 --oneline
```

Pinned runtimes: Node 24.18.0, pnpm 10.31.0, Python 3.12.13. Those WSL
paths exist today. Configure native equivalents on macOS; do not copy WSL
paths or binary artifacts into the Mac environment.

Relevant entry points:

- `src/bench/codexPilot.ts` — orchestration, trace gates, report, bootstrap.
- `src/bench/codexPilotUsage.ts` — observed usage accounting.
- `src/prime/contextGovernor.ts`, `src/prime/contextValue.ts` — delivery/value
  policy to inspect before introducing another abstraction.
- `src/retrieval/evidenceRanker.ts`, `src/retrieval/semanticCandidates.ts` —
  frozen ranker and candidate serving path.
- `src/semantic/modelRuntime.ts`, `modelManager.ts`, `documents.ts` —
  inference/runtime identity, receipts, and semantic document construction.
- `scripts/benchmark-cache.ts` — bounded benchmark cache management.
- `tests/codexPilot.test.ts` — focused pilot/report tests.
- `docs/v02c-semantic-candidates.md` — detailed research history.

The latest September checks passed 12 focused pilot tests, typecheck,
semantic architecture checks, and artifact arithmetic/hashes. October 6
handoff preparation rechecked Git, process state, and all four artifact
hashes; it did not rerun the paid campaign or the full test suite.

Useful focused checks after an actual code change:

```bash
pnpm verify:codex-pilot-smoke
pnpm typecheck
pnpm check:semantic-architecture
```

Do not run the sealed campaign command again merely to inspect its report.
It is already complete. New code requires a new campaign identity and output
directory, not reuse of the completed implementation fingerprint.

September storage measurements were 16 GB for the repository working set,
6.8 GB for the checkout cache under its 8 GB cap, 3.3 GB for the campaign,
and 937 MB for `.kairn`. These are dated measurements, not an October size
audit. Keep LRU, deduplication, resumability, and safe cleanup in place.

Docker Desktop was repaired on September 5 by recoverably quarantining stale
runtime socket directories under Windows application data. Images and
repositories were retained. Docker's current readiness was not tested for
this documentation task; check it before a live verifier run. Do not reset
Docker or delete unknown directories as a routine prerequisite.

## Prompt for the next chat

> Read the Kairn Obsidian Project Index, Current State, and October 6 research
> handoff, then `docs/handoffs/2026-10-06-research-continuation.md`. Verify the
> current checkout and preserve unrelated changes. The 90-attempt semantic
> Codex A/B is finished; use its stored artifacts to diagnose the large token
> regressions and make one concrete preregistration for a general value guard.
> Keep the frozen retriever/ranker, contaminated holdout, beta release, and
> publication gates as documented. Explain the proposed improvement in plain
> language with a measurable success and stopping rule before starting a new
> expensive campaign.
