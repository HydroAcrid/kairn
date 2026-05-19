# Kairn SWE-Pro Official Evaluator Plan 2026-05-19

Status: generated-patch slice completed for two qutebrowser rows.

## Goal

Turn SWE-Pro from a placeholder credibility row into a real official-evaluator slice. Kairn can only count SWE-Pro savings when the official evaluator passes, required production source is touched, scope discipline passes, and Kairn emitted or used active assistance.

## Official Path

The public SWE-Bench Pro dataset includes `repo`, `instance_id`, `base_commit`, `patch`, `test_patch`, `problem_statement`, `requirements`, `interface`, `repo_language`, `fail_to_pass`, `pass_to_pass`, `before_repo_set_cmd`, `selected_test_files_to_run`, and `dockerhub_tag`.

The official evaluator flow is:

1. Generate model patches in JSON format with `instance_id`, `patch`, and `prefix`.
2. Run `scaleapi/SWE-bench_Pro-os` `swe_bench_pro_eval.py` against the raw sample rows and patch JSON.
3. Use Modal or local Docker. For local Docker, pass `--use_local_docker`.
4. Read `eval_results.json`; only passed rows can support official SWE-Pro savings.

## Phases

### Phase 1: evaluator setup gate

- Clone or point to `scaleapi/SWE-bench_Pro-os`.
- Validate every selected row has:
  - `run_scripts/<instance_id>/run_script.sh`
  - `run_scripts/<instance_id>/parser.py`
  - `dockerfiles/base_dockerfile/<instance_id>/Dockerfile`
  - `dockerfiles/instance_dockerfile/<instance_id>/Dockerfile`
- Generate official raw sample JSONL.
- Generate patch JSON.
- Print the exact official evaluator command.

### Phase 2: gold-patch smoke

- Run 1 low-risk row with `--patch-mode gold`.
- This proves evaluator/Docker setup only.
- Gold-patch smoke must never be used as Kairn or model performance evidence.

### Phase 3: generated patch slice

- Generate baseline and `kairn_codex_session` patches for 1-2 selected rows first.
- Save patches as official JSON.
- Run official evaluator on both patch sets.
- Count only pass/pass rows with scope discipline.

### Phase 4: expand to 5-10 rows

- Expand only after the 1-2 row slice is clean.
- Prefer rows already passing deterministic source-quality and latency gates.
- Add MCP/hybrid only after session/hook evidence is understood.

## Current Implementation

Added:

- `kairn bench swe-pro-official`
- official raw sample JSONL generation
- gold/empty/provided patch JSON support
- official asset validation
- exact evaluator command output
- optional `--run` mode for local Docker/Modal execution

Current smoke result:

- 10/10 selected publication rows have official evaluator assets available locally.
- One-row qutebrowser gold-patch input generation succeeds.
- Docker Desktop initially had a stale `com.docker.backend` process and the engine socket timed out.
- After force-restarting Docker Desktop, `docker ps`, `hello-world`, and the Python Docker SDK work.
- The one-row qutebrowser gold-patch official smoke passes with evaluator accuracy 100%.
- This proves the evaluator path only; it is not a Kairn/model savings result.

Generated patch result:

- `qt-warning-filtering`: baseline failed official eval after 40,467 tokens and changed out-of-scope files. After named-source routing was tightened, `kairn_codex_session` passed official eval after 21,802 tokens and changed only `qutebrowser/utils/log.py` and `qutebrowser/utils/qtlog.py`.
- `hostblock-subdomains`: baseline failed official eval after 47,104 tokens and edited a test file. The first Kairn attempt passed the local harness after 77,768 tokens but failed official eval because it omitted the `urlutils` helper required by official tests.
- The hostblock miss exposed a general harness issue: the pilot suite limited official production patch files to two. The suite builder now keeps all production source patch files in scoring/scope metadata while still excluding golden paths from the agent prompt.
- After all-production scope, selected-test source-counterpart routing, and dynamic three-file directives, `kairn_codex_session` passed official eval for `hostblock-subdomains` after 43,313 tokens and changed only `qutebrowser/components/hostblock.py`, `qutebrowser/config/configutils.py`, and `qutebrowser/utils/urlutils.py`.
- Both generated rows count as quality-rescue evidence only, not pass/pass savings, because baseline failed official eval in both cases.

## Risks

- Docker images can be large; do not pull them accidentally.
- Apple Silicon may need `--docker-platform linux/amd64`.
- Python dependencies are separate from Kairn's Node package.
- Official evaluator pass/fail is the only acceptable SWE-Pro correctness source.

## Next Commands

Prepare a one-row gold-patch smoke without running Docker:

```bash
node dist/cli.js bench swe-pro-official \
  --input examples/bench/swe-pro-publication/swe-pro-pilot-raw.jsonl \
  --row-ids instance_qutebrowser__qutebrowser-f91ace96223cac8161c16dd061907e138fe85111-v059c6fdc75567943479b23ebca7c07b5e9a7f34c \
  --limit 1 \
  --patch-mode gold \
  --out-dir docs/publication-evidence-20260518/swe-pro-official-gold-smoke \
  --json
```

Run the smoke only after confirming Python deps and Docker storage:

```bash
node dist/cli.js bench swe-pro-official \
  --input examples/bench/swe-pro-publication/swe-pro-pilot-raw.jsonl \
  --row-ids instance_qutebrowser__qutebrowser-f91ace96223cac8161c16dd061907e138fe85111-v059c6fdc75567943479b23ebca7c07b5e9a7f34c \
  --limit 1 \
  --patch-mode gold \
  --out-dir docs/publication-evidence-20260518/swe-pro-official-gold-smoke \
  --use-local-docker \
  --docker-platform linux/amd64 \
  --run \
  --json
```
