# Kairn Beta Stabilization And Evidence Update 2026-05-19

## Summary

This pass prioritized beta readiness over more broad benchmark rows:

- package install/update/remove smoke,
- wizard/doctor/telemetry/Codex/MCP setup smoke,
- a small non-qutebrowser SWE-Pro official expansion,
- one fresh-ish MCP endurance suite in a different language family,
- and two general harness fixes found during the run.

## Private Beta Package

Local tarball smoke on macOS with Node 24 passed:

- `npm pack`,
- global install from tarball,
- reinstall/update from the same tarball,
- `kairn --version`,
- multi-target `setup wizard` for Codex, VS Code MCP, Claude Code MCP, and Gemini MCP,
- `doctor --target vscode --json`,
- `telemetry status`,
- `telemetry enable --destination supabase`,
- `beta report --json` with automatic telemetry flush,
- `setup remove --delete-state --json`,
- global uninstall.

Remaining beta checks:

- native Windows smoke,
- WSL smoke,
- one user-level MCP client smoke outside Codex.

## SWE-Pro Expansion

Artifacts:

- `docs/publication-evidence-20260519/swe-pro-expansion/swe-pro-expansion-summary.json`
- raw generated artifacts are intentionally ignored unless compact summaries are explicitly added.

Initial four-row non-qutebrowser expansion was stopped because the remaining pilot rows were broad and slow; two baseline rows failed or timed out before useful proof artifacts were produced.

A tractable three-row non-qutebrowser slice was generated from the local official SWE-Pro helper export:

- Vuls: `contrib/trivy/pkg/converter.go`
- NodeBB: `src/controllers/admin/uploads.js`
- Flipt: `internal/server/auth/middleware.go`

Official evaluator result:

| Result | Count |
| --- | ---: |
| Baseline official passes | 2/3 |
| Kairn official passes | 3/3 |
| Quality rescue rows | 1 |
| Clean pass/pass savings rows | 0 |
| Official pass/pass but local scope-invalid rows | 2 |

Interpretation:

- This is positive pass-rate/quality-rescue evidence.
- It is not clean SWE-Pro savings evidence yet because savings require both official evaluator pass and local scope discipline pass.
- The next SWE-Pro step is scope-discipline recheck on official pass/pass rows plus additional one-file rows with valid Docker images.

### 2026-05-20 Scope Recheck

Artifacts:

- `docs/publication-evidence-20260520/swe-pro-scope-recheck/scope-recheck-summary.json`
- `docs/publication-evidence-20260520/swe-pro-scope-recheck/proof.json`
- `docs/publication-evidence-20260520/swe-pro-scope-recheck/kairn-scope-recheck-patches-official-ids.json`

General fix made:

- Broadened production-source-only detection from only `fix the production source` to benchmark/user phrasing such as `fix the issue in production source` plus `do not edit unrelated files`.
- Strengthened edit-scope wording so the model is told to edit only the initial source scope first, not tests, docs, generated files, or sibling files.
- Preserved legitimate multi-file relocation behavior so true cross-file tasks are not forced into one-file scope.

Scope recheck result:

| Result | Count |
| --- | ---: |
| Kairn local quality/scope passes | 3/3 |
| Kairn official evaluator passes | 3/3 |
| Clean active pass/pass savings rows | 0 |
| Scope-rescue official-pass rows | 1 |
| Quality-rescue official-pass rows | 1 |
| Clean pass/pass neutral/passive rows | 1 |

Interpretation:

- This closes the scope-discipline failure found in the 2026-05-19 SWE-Pro expansion.
- It is stronger official credibility evidence: Kairn now produced three one-file production patches, all accepted by the official evaluator.
- It is still not a clean SWE-Pro savings headline. One pass/pass row was passive/neutral, one row is scope rescue, and one row is quality rescue.
- The next SWE-Pro evidence step is fresh one-file rows where both baseline and Kairn pass official eval and local scope, so clean savings can be measured without rescue caveats.

## MCP Endurance

Added:

- `examples/bench/endurance-commons-text.json`

Post-fix run:

- artifact: `docs/publication-evidence-20260519/endurance-commons-text-mcp-repeat1.after-setup-accounting.json`
- baseline failed final verification,
- real MCP-first passed final verification,
- MCP returned one useful production file,
- final scope violations: 0,
- classification: quality rescue, not pass/pass savings.

Interpretation:

- This supports the product claim that MCP can rescue longer source-rescue sessions.
- It does not support a savings headline because baseline failed quality.
- A repeat-3 pass/pass endurance slice is still needed for a clean savings row.

## General Fixes Made

### SWE-Pro Loader Robustness

`loadSweBenchProRows` now accepts the official helper export shape:

- infers `repo_language` when missing,
- accepts uppercase `FAIL_TO_PASS` and `PASS_TO_PASS` arrays,
- accepts array-valued `selected_test_files_to_run`,
- maps `image_name` into `dockerhub_tag` when needed.

This removes brittle one-off row conversion for future official slices.

### Endurance Setup Accounting

Endurance mode now records setup-owned changed files and hashes, then excludes unchanged setup files from agent touched-file and diff-scope accounting.

This prevents MCP/Codex setup files such as `.codex/config.toml`, `.codex/hooks.json`, and `AGENTS.md` from invalidating benchmark scope unless the agent later changes them.

## Next Actions

1. Run native Windows and WSL package smoke with a real user machine.
2. Rerun a small SWE-Pro scope-discipline slice on official pass/pass rows.
3. Run repeat-3 endurance on a fresh or less-used repo where both baseline and Kairn can pass.
4. Keep private beta rollout moving in parallel; more real install feedback is now more valuable than another broad one-shot matrix.
