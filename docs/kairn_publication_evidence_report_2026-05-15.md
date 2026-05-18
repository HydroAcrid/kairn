# Kairn Publication Evidence Campaign v2

Status: campaign in progress; deterministic gates passed, the fresh repeat-5 live slice completed, and the latest behavior-class fix removed the repeated Java over-assist pattern before the frozen rerun.

This campaign freezes Kairn for a publication-grade validation pass. It separates controlled benchmark evidence, official benchmark evidence, SWE-ContextBench context-reuse evidence, SWE-Atlas/QnA source-grounding evidence, and private beta telemetry.

## Frozen Bundle

- Plan: `examples/bench/publication-plan-v2.json`
- Evidence directory: `docs/publication-evidence-20260515/`
- Manifest: `docs/publication-evidence-20260515/publication-manifest.json`
- Dry-run report: `docs/publication-evidence-20260515/kairn_publication_evidence_report_2026-05-15.md`
- Results CSV: `docs/publication-evidence-20260515/publication-results.csv`
- Failures CSV: `docs/publication-evidence-20260515/publication-failures.csv`
- Private beta telemetry summary: `docs/private-beta-telemetry-summary-20260515.md`

## Implemented Campaign Scope

- Fresh unseen preflight: `repo-matrix-fresh-holdout-v4`.
- Fresh repeat-5 one-shot live proof: `seeded-fresh-holdout-v2`.
- Endurance repeat-3: Requests 10-turn and FastAPI.
- MCP smoke: local protocol delivery check.
- SWE-Pro official evaluator gate: selected row ids are recorded, but savings are blocked unless official evaluator JSON is attached and passes.
- SWE-ContextBench pilot: related-task metadata adapter with base/related grouping and source-reuse preflight artifacts.
- SWE-Atlas/QnA: retained as source-grounding and evidence-request support, not the main token-savings proof.

## Claim Rules

- Active savings count only when quality passes, Kairn assistance is active, scope discipline passes, and official evaluator requirements are satisfied.
- Suppressed/passive savings are reported separately as abstention evidence.
- SWE-Pro savings are invalid until official Docker evaluator results pass.
- Private beta telemetry is supporting evidence only; it is sanitized and excludes prompts, source, paths, filenames, diffs, repo names, branch names, and raw command output.

## Next Live Commands

Dry run:

```sh
kairn bench publication --plan examples/bench/publication-plan-v2.json --out-dir docs/publication-evidence-20260515 --dry-run
```

Run one frozen slice first:

```sh
kairn bench publication --plan examples/bench/publication-plan-v2.json --out-dir docs/publication-evidence-20260515 --only fresh-unseen-v4-preflight
```

Then continue with repeat-5 and endurance only if preflight passes.

## Campaign Log

### Deterministic Gates

- Fresh unseen v4 preflight passed: 9/9 repos and 9/9 behavior cases.
- Local MCP smoke passed: Kairn MCP listed tools, returned compact context, and recorded tool-call metrics.
- SWE-ContextBench pilot passed: 3 related-task pairs across Vite, httpcore, and GORM.
- SWE-Atlas/QnA source-grounding gate passed as supporting evidence; runtime/procedural rows remain separated from source-grounded rows.
- SWE-Pro official-evaluator gate now loads JSONL rows correctly, but remains non-countable until official evaluator JSON is attached and passes.

### Live Findings So Far

- The first full fresh repeat-5 attempt was stopped early because Kairn-assisted modes failed setup in disposable workspaces: the harness called `kairn setup` through `PATH`, which is invalid when testing local unreleased builds.
- General fix: publication commands now resolve `{kairn}` or leading `kairn` to the local built CLI (`node dist/cli.js`) or a configured `KAIRN_BENCH_KAIRN_CMD`.
- A timeout issue was also found: shell timeouts could leave Codex child processes alive. Live agent commands now run with process-group timeout cleanup.
- Live continuation repeat-2 on Zod, Pydantic, and Chi:
  - `kairn_codex_session`: quality passed; median per-case wins were strong on Pydantic (~67%) and Chi (~68%), but Zod cheap one-shot still over-assisted.
  - `real_mcp_first`: quality passed overall but over-assisted on cheap/source-rescue tasks; this confirmed MCP should not be evaluated as a blanket one-shot mode.
- General fix: MCP cheap one-shot handling now returns a suppressed guardrail with no file payload or next-tool calls. MCP remains part of the campaign for broad, failure-driven, multi-file, and endurance slices.
- General accounting fix: Kairn passing quality when baseline fails is now classified as `quality_rescue`, not `over_assist`; savings claims remain separate.
- Fresh repeat-5 later exposed one real general over-assist class: the tiny edit-scope guardrail said to run a focused check before finalizing. On simple one-shot tasks this could trigger extra verification/search even though the benchmark harness verifies externally.
- General fix: shrink/directive output now says `Verification hint: if you verify inside this turn, use the narrowest relevant compile/test command and avoid broad suite output.` This keeps verification scoped without commanding extra work.
- Focused post-fix repeat-2 recheck on Vite, Chi, Java, Rich, and Pydantic:
  - `kairn_codex_session`: quality passed all rows.
  - Median active savings: 65.66%; latest aggregate savings: 148,897 observed Codex tokens / 76.25%.
  - Java moved from repeated over-assist to consistent active win: 2/2 valid assists, median 27% savings.
- Frozen fresh repeat-5 rerun after the verification-hint fix: `docs/publication-evidence-20260515/fresh-repeat5-final-v4/`.
  - Baseline median observed Codex tokens: 176,988.
  - `kairn_codex_session` median observed Codex tokens: 73,174.
  - Median active savings: 103,814 tokens / 58.66%.
  - Latest observed aggregate: 115,656 tokens saved / 63.10%.
  - Kairn quality passed 5/5 reports and 40/40 case runs.
  - Harmful assists: 0. Repeated over-assist pattern: 0.
  - One non-repeated Zod row was classified as over-assist when baseline happened to solve cheaply; the same case also had 2 valid assists and 2 quality rescues across repeat-5, so this is variance evidence rather than a behavior-class failure.

### Fresh Repeat-5 Case Results

| Case | Class mix | Baseline median | Kairn median | Median savings | Repeat classification |
| --- | --- | ---: | ---: | ---: | --- |
| spdlog `should_log` | source rescue | 34,802 | 6,804 | 85.8% | 5 valid assists |
| Chi `URLParam` latest value | source rescue / quality rescue | 20,318 | 4,352 | 53.3% | 1 valid assist, 4 quality rescues |
| Zap `AtomicLevel.Enabled` | source rescue | 14,215 | 6,205 | 48.7% | 5 valid assists |
| Commons Text `CaseUtils` delimiter | source rescue | 13,472 | 7,006 | 52.7% | 5 valid assists |
| Pydantic `to_snake` kebab case | source rescue | 14,463 | 6,415 | 50.8% | 5 valid assists |
| Rich `cell_len` cache | source rescue | 13,528 | 6,291 | 62.5% | 5 valid assists |
| Vite `injectQuery` relative URL | source rescue / quality rescue | 44,177 | 13,822 | 69.2% | 5 quality rescues |
| Zod `isObject` arrays | cheap/source rescue boundary | 23,310 | 13,466 | 42.2% | 2 valid assists, 2 quality rescues, 1 over-assist |

### Requests Endurance Repeat-3

Full Requests 10-turn endurance run: `docs/publication-evidence-20260515/requests-endurance-repeat3-v1/`.

| Mode | Quality | Median tokens | Median savings | Repeat classification |
| --- | ---: | ---: | ---: | --- |
| baseline | 3/3 | 241,999 | 0% | baseline |
| `kairn_codex_session` | 2/3 | 196,734 | 9.3% | 2 valid assists, 1 harmful timeout |
| `real_mcp_first` | 3/3 | 171,625 | 33.1% | neutral in this harness; no actual MCP tool calls recorded |
| `hybrid_mcp_brief` | 3/3 | 156,088 | 35.5% | 3 valid assists |

Findings:

- The session ledger behavior did work after turn 1: Kairn repeatedly moved from context blocks to compact “source already found; do not call Kairn again unless a check fails or the target changes” guidance.
- The harmful `kairn_codex_session` row was one fix-turn timeout. Source invariant and diff scope were already satisfied, but the command timeout still correctly made the run non-countable as quality-passing active savings.
- Root cause was a general long-session invariant bug: exact-source evidence could reuse the original broad session task text instead of the current turn's concrete invariant/source metadata.
- General fix: exact-source evidence now uses the current prompt, and when benchmark/tooling source invariants are available they override stale session-derived invariants.
- Focused post-fix Requests Kairn session recheck: `docs/publication-evidence-20260515/requests-kairn-session-recheck-v1/`.
  - `kairn_codex_session`: 2/2 quality pass, 2/2 active runs, 0 harmful assists, 0 over-assists.
  - Median observed tokens: baseline 172,484 vs Kairn 118,750.
  - Median active savings: 53,734 tokens / 31.1%.
  - Repeated context avoided: 4.
  - Kairn actions: emitted 1, shrank 3, suppressed 3 per successful run, showing active after-turn-1 memory discipline.

### Scoped MCP Protocol And Live Subset

Scoped MCP proof artifacts:

- Protocol smoke: `docs/publication-evidence-20260515/mcp-protocol-smoke-v1/`
- Chi live subset: `docs/publication-evidence-20260515/mcp-live-subset-v2/raw/chi-real-mcp-live-proof.json`
- Vite live subset after fixes: `docs/publication-evidence-20260515/mcp-live-subset-v4/raw/vite-real-mcp-live-proof.json`

Findings:

- Local MCP protocol smoke passed. The server listed all Kairn MCP tools, `kairn_prepare_task` returned compact context, and `kairn_get_metrics` recorded 2 MCP tool calls.
- Chi live was pass/pass and recorded 1 real MCP call to `kairn_prepare_task`. Kairn correctly suppressed file payloads for the cheap single-source case. Tokens increased from 17,968 to 20,555, so this is correct-abstention/protocol evidence, not savings evidence.
- Vite initially exposed two general MCP evidence problems:
  - failed setup runs could accidentally read the caller repo's `.kairn` database when the disposable workspace path was empty;
  - broad source-rescue MCP prompts were not forcing a real first MCP call, and the cheap-one-shot guardrail could wrongly collapse multi-surface source-rescue context into suppression.
- General fixes:
  - workspace MCP metrics now return zero metrics when the proof workspace path is empty or invalid;
  - MCP-first benchmark prompts now explicitly require one `kairn_prepare_task` call for source-rescue, multi-file, failure-first, and session-repeat cases, while preserving abstention for cheap/weak cases;
  - MCP cheap-one-shot collapse no longer suppresses source-rescue decisions with companion or multi-surface evidence.
- Vite live after fixes recorded 1 real MCP call, returned the expected source file `packages/vite/src/client/client.ts`, returned zero noisy files, returned zero test fanout, passed source-scope discipline, and passed quality. Baseline was only partial because it edited an unrelated source file. This is a clean MCP quality-rescue proof, not an MCP token-savings proof: Kairn used 34,116 tokens versus the failed baseline's 30,735 tokens.

Interpretation:

- MCP now has clean protocol evidence and one live proof that an actual MCP call can return the right source with no noise and rescue quality.
- The campaign still needs repeat-3 or repeat-5 pass/pass MCP cases before claiming MCP token savings. The next MCP slice should use broad/failure/endurance cases where Kairn is expected to emit or shrink, not cheap one-shot tasks where correct behavior is often suppression.

### Scoped MCP Endurance Repeat-3

Repeat-3 MCP artifacts:

- Summary: `docs/publication-evidence-20260515/mcp-repeat-subset-v1/mcp-repeat3-summary.json`
- Requests raw runs:
  - `docs/publication-evidence-20260515/mcp-repeat-subset-v1/raw/requests-real-mcp-repeat2.json`
  - `docs/publication-evidence-20260515/mcp-repeat-subset-v1/raw/requests-real-mcp-repeat3-extra.json`
- FastAPI raw runs:
  - `docs/publication-evidence-20260515/mcp-repeat-subset-v1/raw/fastapi-real-mcp-repeat2.json`
  - `docs/publication-evidence-20260515/mcp-repeat-subset-v1/raw/fastapi-real-mcp-repeat3-extra.json`

Results:

| Suite | Repeats | Baseline quality | MCP quality | Pass/pass savings rows | Median pass/pass savings | MCP calls | MCP useful files |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Requests 10-turn | 3 | 2/3 | 3/3 | 2/3 | 36.75% | 1, 1, 3 | `src/requests/sessions.py` |
| FastAPI 4-turn | 3 | 3/3 | 3/3 | 3/3 | 64.72% | 1, 1, 1 | `fastapi/routing.py` |

Combined pass/pass rows:

- Pass/pass rows: 5.
- Median pass/pass savings: 50.79%.
- Aggregate pass/pass savings: 382,234 tokens / 50.07%.
- MCP returned exactly the active production source in every run.
- Harmful MCP runs: 0.
- Over-assist MCP runs: 0.

Additional evidence:

- One Requests repeat was a quality-rescue row: baseline failed by touching `tests/test_requests.py` during repeated-context turns, while MCP passed. It is not counted as pass/pass savings, but it is positive quality evidence.
- In every run, MCP established source on the first diagnose/source-rescue turn and then switched subsequent turns to `continue_known_source` guidance.
- One Requests quality-rescue run had 3 MCP tool calls: `kairn_prepare_task`, `kairn_read_file`, and `kairn_find_context`, all clustered at the start and all returning only `src/requests/sessions.py`. This is still sparse over a 10-turn session and did not create file fanout.

Interpretation:

- MCP now has repeat-3 endurance evidence on two repos with actual recorded MCP tool calls.
- This is the first clean MCP token-savings claim in the campaign: 5 pass/pass rows, median 50.79% savings, with no harmful or over-assist rows.
- The strongest product lesson is that MCP is working best as a long-session source/invariant latch: call once at the beginning, then carry forward the active source and stop asking unless failure or scope changes.

### Current Interpretation

- The governor upgrade is holding for source-rescue in session mode across mixed fresh repos.
- Cheap/source-rescue boundary tasks still have variance: Kairn can rescue quality or save heavily, but can over-assist when baseline already solves unusually cheaply. The current run shows this is not repeated enough to justify another rule yet.
- Endurance evidence now supports the long-session story after the current-turn invariant fix: Kairn can stay active after turn 1 while emitting less context.
- MCP/hybrid now has clean protocol evidence and repeat-3 endurance evidence with actual tool calls. It is now reasonable to claim MCP savings for long-session source-rescue/debug workflows, not just protocol delivery.
- Next campaign work should continue to SWE-Pro official evaluation and a broader fresh MCP holdout, not more tuning on Requests/FastAPI unless a new repeated failure appears.

## Verification

- `pnpm test`: passed, 253 tests.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- `npm pack --pack-destination /tmp/kairn-evidence-v2-pack`: passed for `kairn-0.1.2.tgz`.
- temp-prefix install smoke: passed, `kairn --version` returned `0.1.2`; `kairn doctor --json` executed successfully with expected warnings for unconfigured generic `/tmp`.
