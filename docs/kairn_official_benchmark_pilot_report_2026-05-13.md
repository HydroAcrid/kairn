# Kairn Official Benchmark Pilot Report - 2026-05-13

## Summary

This pass added official-benchmark harness support and ran the first SWE-Atlas/QnA preflight. MCP was also tested through the real stdio server path.

Main result: Kairn's normal debug/source-routing strengths transfer to some official QnA tasks, but runtime/onboarding QnA is harder than patch-style retrieval. The next official-benchmark work should focus on procedural exploration plus source grounding, not more one-shot retrieval scoring.

## Implemented

- `kairn bench swe-atlas-qna-pilot`
  - Fetches public `ScaleAI/SWE-Atlas-QnA` rows or consumes local JSON/JSONL.
  - Writes a live suite and repo-matrix preflight file.
  - Uses reference answers only offline to extract expected source files.
  - Does not include reference answers or golden file paths in agent prompts.
  - Groups matrix cases by repo/commit so repeated rows reuse one clone/index.

- `kairn bench mcp-smoke`
  - Starts the real Kairn MCP stdio server.
  - Lists tools and calls `kairn_start_task`, `kairn_prepare_task`, and `kairn_get_metrics`.
  - Reports start files, stop conditions, and actual MCP tool-call metrics.

- General retrieval/harness fixes
  - Treat `gen/` as generated/noisy across scanning, retrieval, MCP, metrics, and benchmark scoring.
  - Add QnA `minExpectedHits` scoring so source-grounding tasks can require one correct source hit while still reporting missing companions.
  - Add QnA answer-grounding quality gates for live runs: enough expected source mentions and no repository file modifications.
  - Canonicalize Docker-style QnA reference paths such as `/app/scapy/...` back to repo-relative paths.
  - Add per-repo matrix timeout metadata and a 120s default preflight guard.
  - Add official task classification metadata: task class, evaluator, Kairn applicability, metric eligibility, live risk, reasons, and recommended modes.
  - Rank QnA expected files by prompt terms for offline scoring.
  - Add protocol-flow source scoring for remote/socket/command routing prompts.
  - Add package-role scoring for Go package anchors and framework management commands.

## Results

SWE-Atlas/QnA 6-task smoke:

| Pass | Result |
| --- | ---: |
| Initial importer bug | 0 / 6 cloned correctly |
| After repo URL normalization | 0 / 5 scorable cases |
| After QnA scoring/noise/protocol fixes | 3 / 5 scorable cases |

SWE-Atlas/QnA 30-task preflight:

| Metric | Result |
| --- | ---: |
| Rows fetched | 30 |
| Scorable QnA cases | 23 |
| Distinct repo/commit targets | 10 |
| Quality-passing cases | 9 / 23 |
| State-bounded repos | 10 / 10 |

SWE-Atlas/QnA 20-task preflight after QnA grounding/timeout changes:

| Metric | Result |
| --- | ---: |
| Rows fetched | 20 |
| Scorable QnA cases | 15 |
| Distinct repo/commit targets | 8 |
| Quality-passing cases | 6 / 15 |
| State-bounded repos | 8 / 8 |
| Repo timeout failures | 0 |

Small live QnA smoke on two preflight candidates:

| Mode | Quality | Observed token result |
| --- | --- | --- |
| baseline | failed | One MinIO runtime task timed out; Scapy answer missed expected source grounding |
| hook full-prime | failed | Lower observed tokens on Scapy, but invalid because quality failed |
| real MCP-first | failed | MCP called once per case, but savings invalid because quality failed |

Official classification smoke:

| Sample | Distribution |
| --- | --- |
| SWE-Atlas/QnA 8-row sample | 4 runtime-procedural, 1 multi-file debug, 3 weak-signal |
| SWE-Pro 4-row sample | 4 patch-verification / strong applicability |

MCP smoke with built CLI:

| Metric | Result |
| --- | --- |
| Tools listed | 13 |
| Start file | `src/parser/parseFile.ts` |
| Stop condition | `source_evidence_sufficient` |
| MCP tool calls recorded | 2 |

## Findings

- QnA reference answers often cite many files. Kairn should not be judged as failing just because it returns one correct source file and misses secondary explanatory files.
- Runtime/onboarding QnA prompts are often procedural: "run it, observe logs, explain behavior." Static source retrieval alone is insufficient.
- The live smoke confirmed this: the MinIO row asks the agent to simulate distributed disk loss and recovery, which is not a cheap source-routing task and timed out under the 180s live-agent guard.
- Reference-answer path extraction must be treated as benchmark harness logic, not ground truth. The Scapy row exposed a Docker checkout prefix (`app/scapy/...`) that needed canonicalization before live scoring was meaningful.
- The QnA sample contains many rows that are not clean headline Kairn metrics. These should be reported as runtime/procedural stress tests, not averaged into source-routing effectiveness.
- Large UI monorepos still expose latency and canonical-surface weaknesses. `wp-calypso` exceeded the 5s prime gate.
- Some official rows have no extractable source paths in the reference answer. These are live-answer candidates, not repo-matrix candidates.
- The 30-task QnA preflight produced repeated `Aborted()` stderr/stdout noise during large-repo WASM parsing. It did not fail the run, but it should be investigated before making official benchmark runs routine.

## Scientific Rerun - 2026-05-13

This rerun converted the official pilots into behavior-classified samples before live spend.

SWE-Atlas/QnA classified sample:

| Metric | Result |
| --- | ---: |
| Rows fetched | 30 |
| Metric-eligible cases after classifier filter | 12 |
| Distinct repo/commit targets | 8 |
| Quality-passing preflight cases | 3 / 12 |
| State-bounded repos | 8 / 8 |

QnA task distribution in the 30-row sample:

| Class | Count |
| --- | ---: |
| runtime-procedural | 14 |
| multi-file debug | 9 |
| weak-signal | 4 |
| failure-first debug | 2 |
| source rescue | 1 |

SWE-Pro classified sample:

| Pass | Quality-passing preflight |
| --- | ---: |
| Initial strict all-golden-files scoring | 6 / 12 |
| Candidate-selection scoring with `minExpectedHits: 1` | 11 / 12 |

The SWE-Pro scoring change is a harness correction, not a product win. Preflight should answer "is this worth live spend?" A patch case that finds one golden production file can be a valid live candidate even when it still reports missing companions. Official evaluator acceptance remains required before counting token savings.

Small qutebrowser SWE-Pro live smoke:

| Mode | Kairn active? | Quality under old required-file gate | Observed tokens | Finding |
| --- | --- | --- | ---: | --- |
| baseline | no | pass | 40,329 | Baseline already found/touched the required production files. |
| hook full-prime | no | pass | 71,449 | Hooks did not actually activate in this raw Codex command path, so this is not Kairn evidence. |
| real MCP-first | no | partial | 48,025 | Codex made zero actual MCP calls; token delta is not MCP evidence. |
| `kairn codex` wrapper, before cap fix | yes | pass | 44,271 | Active Kairn, but not baseline-beating. |
| `kairn codex` wrapper, after cap fix | yes | pass | 47,816 | Removing the third companion file did not fix the live over-assist. |

Post-run diff-scope inspection showed both wrapper runs edited unrelated files:

- `qutebrowser/browser/qtnetworkdownloads.py`
- `tests/unit/utils/test_qtlog.py`

Those runs should not be counted as quality wins for official patch-generation evidence. The harness now supports one-shot `allowedDiffScopes`, and generated SWE-Pro cases restrict edits to the expected production patch files. With that gate, the qutebrowser wrapper runs are negative evidence: active context did not prevent broad drift.

Implemented from this rerun:

- `bench prove --out <path>` writes recoverable proof JSON after each completed mode and at the end.
- `bench prove` now emits stderr progress for mode/case start and completion, so long live runs are not opaque.
- `bench prove` supports `--kairn-codex-session-command` to test the actual session-bound wrapper path.
- Workspace metric collection now counts direct `prime_context` events, not only hook signals, so wrapper-emitted Kairn context is classified as active assistance.
- Multi-file directive delivery is capped at two production files unless the prompt explicitly spans three framework role families.
- Generated SWE-Pro one-shot cases include `allowedDiffScopes` for expected production patch files.
- Live-agent one-shot scoring now fails semantic validation when edits escape allowed diff scopes.
- Repo-matrix exclusion matching now treats directory exclusions such as `tests/` as nested path segments, not only root prefixes.

Current official-benchmark conclusion:

Kairn is now better instrumented for official benchmark work, but this rerun was not a new live token-saving win. It exposed the next real quality target: for official patch tasks, Kairn must reduce broad edit drift, not just surface the right source files. Until official evaluator and diff-scope gates pass, lower token counts or required-file touches are not enough.

## Artifacts

- `/tmp/kairn-swe-atlas-qna-20260513-v6/`
- `/tmp/kairn-swe-atlas-qna-matrix-20260513-v6.json`
- `/tmp/kairn-swe-atlas-qna-20260513-v8/`
- `/tmp/kairn-swe-atlas-qna-matrix-20260513-v8.json`
- `/tmp/kairn-swe-atlas-qna-live-smoke-proof-20260513.json`
- `/tmp/kairn-swe-atlas-qna-classified-20260513/`
- `/tmp/kairn-swe-pro-classified-20260513/`
- `/tmp/kairn-mcp-smoke-built-20260513.json`
- `/tmp/kairn-scientific-qna-20260513-v1/`
- `/tmp/kairn-scientific-qna-matrix-metric-20260513-v2.json`
- `/tmp/kairn-scientific-swepro-20260513-v2/`
- `/tmp/kairn-scientific-swepro-matrix-metric-20260513-v2.json`
- `/tmp/kairn-swepro-qute-onecase-live-proof-out-20260513.json`
- `/tmp/kairn-swepro-qute-onecase-kairn-codex-live-report-20260513.json`
- `/tmp/kairn-swepro-qute-onecase-kairn-codex-live-after-cap-20260513.json`

## Next

1. Improve official patch-task edit discipline: source directive should explicitly say "only these production files are in scope" and failure/context follow-ups should reinforce diff scope.
2. Rerun qutebrowser with the new diff-scope gate only after the prompt/directive is tightened enough to avoid unrelated edits.
3. Use the 11/12 SWE-Pro preflight candidates for live spend only through `kairn_codex_session` and real MCP paths that actually activate.
4. Improve QnA source grounding beyond reference-file mentions: count source files actually cited in the answer and compare them against accepted source surfaces.
5. Investigate the WASM parser `Aborted()` noise on large mixed repos.
