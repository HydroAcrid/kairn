# Kairn SWE-Bench Pro Pilot Report - 2026-05-10

## Summary

This was the first real SWE-Bench Pro pilot using the official public dataset rows plus the official Docker evaluator path. The earlier Hugging Face rows API concern was resolved by downloading the full Parquet split, but another important evaluator detail surfaced: the `test_patch` field is not reliable as a direct `git apply` input for the selected sample. The correct setup path is the dataset's `before_repo_set_cmd`, with the referenced test commit fetched explicitly.

The headline result is mixed:

- Kairn state/preflight passed on the selected full-data sample.
- Official Docker evaluation now works locally after Docker Desktop was started.
- Ansible passed official evaluation for both baseline and hook-mode patches, but the active hook suppressed itself, so no Kairn savings claim is valid.
- OpenLibrary showed that Kairn can emit active context after the suppression fix and reduce tokens, but the official evaluator failed. That is invalid savings and negative evidence for one-file shrink on multi-file SWE tasks.

## Sources

- Dataset: `ScaleAI/SWE-bench_Pro`, full Parquet split at `data/test-00000-of-00001.parquet`.
- Evaluator: `scaleapi/SWE-bench_Pro-os`, local Docker evaluator with `--use_local_docker`.
- Docker image repository: `jefzda/sweap-images:<dockerhub_tag>`.

## Artifacts

| Artifact | Purpose |
| --- | --- |
| `/tmp/swe-bench-pro-test.parquet` | Full public test split downloaded from Hugging Face |
| `/tmp/kairn-swe-pro-full-pass3-rows.json` | Three full rows extracted from Parquet |
| `/tmp/kairn-swe-pro-full-pass3-20260510/` | Regenerated suite/matrix from full data |
| `/tmp/kairn-swe-pro-full-pass3-matrix-20260510.json` | Full-data repo-matrix preflight |
| `/tmp/kairn-swe-pro-full-pass3-evaluator-suite.json` | Suite using `before_repo_set_cmd` instead of direct `test_patch` |
| `/tmp/kairn-swe-pro-ansible-patchgen-live-20260510.json` | Initial Ansible baseline/hook proof; hook accidentally disabled by `--ignore-user-config` |
| `/tmp/kairn-swe-pro-ansible-hook-active-20260510.json` | Active-hook Ansible rerun |
| `/tmp/kairn-swe-pro-openlibrary-patchgen-live-20260510.json` | OpenLibrary baseline vs suppressed hook |
| `/tmp/kairn-swe-pro-openlibrary-hook-active-shrink-20260510.json` | OpenLibrary active shrink-context rerun |
| `/tmp/kairn-swe-pro-ansible-official-eval-*` | Official Docker evaluator outputs for Ansible |
| `/tmp/kairn-swe-pro-openlibrary-official-eval-*` | Official Docker evaluator outputs for OpenLibrary |

## Preflight

| Case | Repo | Language | State Gate | Retrieval Gate | Expected Production Files |
| --- | --- | --- | --- | --- | --- |
| Ansible keyword collection validation | `ansible/ansible` | Python | Pass | Pass | `lib/ansible/galaxy/dependency_resolution/dataclasses.py`, `lib/ansible/utils/collection_loader/_collection_finder.py` |
| Teleport kube proxy forwarding | `gravitational/teleport` | Go | Pass | Pass | `lib/kube/proxy/forwarder.go` and related service files |
| OpenLibrary list POST parsing | `internetarchive/openlibrary` | Python | Pass | Pass | `openlibrary/plugins/openlibrary/lists.py`, `openlibrary/plugins/upstream/utils.py` |

## Live Results

| Case | Mode | Observed Tokens | Hook Active | Prime Emitted | Production Files Touched | Official Docker Eval | Valid Kairn Savings |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| Ansible | Baseline | 56,418 | No | No | Yes | Pass | N/A |
| Ansible | Active hook | 59,846 | Yes | No | Yes | Pass | No, hook suppressed |
| OpenLibrary | Baseline | 40,048 | No | No | Yes | Fail | N/A |
| OpenLibrary | Active hook, suppressed | 112,036 | Yes | No | Yes | Pass | No, hook suppressed |
| OpenLibrary | Active hook, shrink after fix | 33,490 | Yes | Yes | Yes | Fail | No, quality failed |

## Structured Debug Follow-Up

After the one-file shrink failure, Kairn added a structured-debug shrink path:

- Context responses now carry structured ranked-file scores so prime quality does not depend on markdown score parsing.
- `multi_file_directive` keeps the normal `shrink` action but emits up to two production files, one invariant, and one small verification hint.
- SWE-Pro pilot generation now prefers `before_repo_set_cmd`, fetches the referenced test commit, commits selected test files, and writes raw JSONL rows for the official evaluator.
- Route/named-source routing now promotes production filename mentions like `dataclasses.py` and route surfaces like `/lists/add` without treating selected test paths as exact source prompts.
- Structured-debug shrink now orders the active source before helper/utility companions.

Follow-up artifacts:

| Artifact | Purpose |
| --- | --- |
| `/tmp/kairn-swe-pro-structured-debug-v2-20260510/` | Regenerated Ansible/OpenLibrary pilot suite with `before_repo_set_cmd` setup |
| `/tmp/kairn-swe-pro-structured-debug-v2-matrix-20260510.json` | Preflight after retaining compact requirements/invariants |
| `/tmp/kairn-swe-pro-openlibrary-structured-debug-live-v3-20260510.json` | Corrected OpenLibrary baseline vs active hook proof |
| `/tmp/kairn-swe-pro-openlibrary-hook-official-v3-20260510/` | Official evaluator output for the hook patch |
| `/tmp/kairn-swe-pro-openlibrary-baseline-official-v3-20260510/` | Official evaluator output for the baseline patch |

Structured-debug preflight:

| Case | Prompt Shape | Returned Files | Preflight Gate |
| --- | --- | --- | --- |
| Ansible | Distilled matrix query | `dataclasses.py`, `validation.py` | Fail; missed `_collection_finder.py` |
| Ansible | Full hook prompt | `_collection_finder.py`, `dataclasses.py` | Pass as prompt-delivery evidence |
| OpenLibrary | Distilled matrix query | `upstream/utils.py`, `lists.py` | Pass |
| OpenLibrary | Full hook prompt | `lists.py`, `upstream/utils.py` | Pass |

Corrected OpenLibrary live proof:

| Mode | Observed Tokens | Quality Gate | Required Files | Hook Active | Official Eval | Interpretation |
| --- | ---: | --- | --- | --- | --- | --- |
| Baseline | 49,304 | Pass locally | Yes | No | Fail | Local harness was too permissive |
| Hook full-prime adaptive shrink | 42,338 | Pass locally | Yes | Yes, `primeEmitted=1` | Fail | 14.13% directional savings, not valid SWE-Pro savings |

Official evaluator failure for both patches was `test_from_input_with_data`: neither patch populated `key`, body `name`, and `seeds` correctly. This confirms the gating rule: no SWE-Pro token reduction should be counted as valid savings without an official Docker evaluator pass.

The important implementation result is still positive but narrower: Kairn now delivers the right two-file structured-debug context. The product/evidence issue is that the live proof harness must treat official evaluator failure as negative evidence even when the local required-file gate passes.

## What Changed During The Pilot

Two controller fixes were implemented:

- `exactPathMentioned` no longer treats test/docs/generated paths as a reason to suppress source context.
- Debug/failure prompts with retrieved production files now shrink to a focused directive when score extraction is missing or zero, instead of silently suppressing.

Verification after these changes:

- `pnpm test -- tests/runtime.test.ts tests/bench.test.ts tests/watch.test.ts tests/mcp.test.ts`
- `pnpm typecheck`
- `pnpm build`

## Findings

### 1. SWE-Pro Setup Needs First-Class Support

Directly applying `test_patch` failed with corrupt patch errors on the selected rows. The official evaluator uses `before_repo_set_cmd`, which checks out selected test files from the issue/fix commit. Kairn's SWE-Pro adapter should generate benchmark seed setup from that command, including an explicit `git fetch origin <test_commit> --depth 1`.

### 2. Suppressed Hooks Must Not Be Counted

The Ansible active-hook run had `hookCompleted=1`, `primeEmitted=0`, and official eval passed. That is not Kairn-assisted. The OpenLibrary suppressed-hook run passed official eval but used far more tokens; because no context was emitted, it is variance/passive evidence, not a Kairn win.

### 3. One-File Shrink Can Be Too Narrow For SWE-Pro

After the fallback fix, OpenLibrary emitted active Kairn context and reduced tokens from 40,048 to 33,490, but the official evaluator failed. The failure was `test_from_input_with_data`: the generated fix did not correctly parse body data into `key`, `name`, and `seeds`. The prompt needed both production files and a stronger invariant, not a one-file directive.

### 4. Exact Source And Companion Decisions Need A SWE-Style Mode

SWE-Pro tasks often include selected test files, requirements, and multiple production files. Kairn should distinguish:

- test path mentions: do not suppress source context,
- production path mentions: shrink only for cheap exact-source tasks,
- multi-production-file golden patches: return a capped source set plus invariant,
- low score extraction but strong companion evidence: shrink to a small multi-file directive, not one file.

## Next Changes

1. Add an official SWE-Pro setup mode to `sweBenchPro.ts`:
   - prefer `before_repo_set_cmd` over `test_patch`,
   - fetch the referenced test commit,
   - commit selected test files in disposable patch-generation workspaces so `git diff` contains only solution changes.

2. Add a `swe_pro_debug` or structured-debug delivery policy:
   - max two production files when companion evidence is strong,
   - include one invariant derived from requirements/test names,
   - avoid test/doc fanout,
   - never suppress because selected test paths are named.

3. Improve score fallback:
   - if extracted ranked scores are zero but retrieval returns source files plus high companion scores, classify the context as low-confidence shrink, not suppress.
   - for multi-file tasks, shrink should include primary plus one companion, not only the primary.

4. Keep official-eval gating:
   - token reductions count only when the official Docker evaluator passes,
   - suppressed hooks are passive evidence,
   - active context that fails official eval is negative evidence.

## Current Recommendation

Do not make SWE-Pro product claims yet. The pilot proves the harness can reach official Docker evaluation and that Kairn can influence token use, but the current automatic policy is not robust enough for SWE-Pro-style multi-file tasks. The next target is structured-debug multi-file shrink: small enough to save tokens, but not so narrow that the agent misses the real invariant.
