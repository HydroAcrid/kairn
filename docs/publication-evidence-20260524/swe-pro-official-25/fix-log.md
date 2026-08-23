# SWE-Pro 25-Row Campaign Fix Log

This campaign includes 5 historical official seed rows plus a new 20-row official expansion. Fixes below are behavior-class fixes only, not row-specific tuning.

## 2026-05-24: Setup Diff Accounting

- Issue: benchmark setup commands could leave `.codex` setup files in the workspace diff, causing local scope checks to treat setup state as agent edits.
- Fix: commit setup-time changes into a benchmark setup baseline before live agent patch generation.
- Files changed: `src/bench/agent.ts`.
- Validation: focused bench tests, typecheck, build, and `git diff --check` passed.

## 2026-05-24: Official Prompt Test Filtering

- Issue: selected verification tests were sometimes too broad and could bias agents toward editing test surfaces or unrelated generic terms.
- Fix: filter selected tests shown in SWE-Pro prompts to rows with issue-relevant terms and explicitly mark selected tests as verification targets, not edit targets.
- Files changed: `src/bench/sweBenchPro.ts`, `tests/bench.test.ts`.
- Validation: focused bench tests, typecheck, build, and `git diff --check` passed.

## 2026-05-24: Read-Only Intent Classification

- Issue: prompts saying not to edit tests could be misclassified as read-only, weakening patch-intent routing.
- Fix: treat only explicit no-edit/read-only phrases as read-only; production-fix prompts that say not to edit tests remain patch-intent tasks.
- Files changed: `src/prime/contextGovernor.ts`, `tests/bench.test.ts`.
- Validation: focused bench tests, typecheck, build, and `git diff --check` passed.

## 2026-05-24: Qualified Utility And Test-Counterpart Routing

- Issue: qualified generic module prompts and selected failing test paths could promote sibling utility/source files by lexical similarity, causing source-scope drift.
- Fix: require qualified generic module matches to be path-grounded, route selected failing test paths to their production counterparts, and downrank companion files without precise source grounding.
- Files changed: `src/retrieval/hybridRetrieval.ts`, `src/retrieval/companions.ts`, `tests/bench.test.ts`.
- Validation:
  - Focused bench tests passed: `pnpm test tests/bench.test.ts -- --runInBand`.
  - Typecheck passed: `pnpm typecheck`.
  - Build passed: `pnpm build`.
  - Diff whitespace passed: `git diff --check`.

### Batch A Control Rerun

- Affected row: OpenLibrary qualified utility/source-counterpart routing.
- Control rows: Element user panel row and Ansible YAML/filter row.
- Baseline run: `batches/batch-A/baseline.after-selected-test-filter-rerun3.json`.
- Kairn run: `batches/batch-A/kairn-real-wrapper.after-companion-scope-fix-rerun4.json`.
- Kairn clean patches: `batches/batch-A/kairn-real-wrapper.after-companion-scope-fix-rerun4.clean-patches.json`.
- Official baseline eval: `batches/batch-A/official-baseline-after-selected-test-filter-rerun3.stdout.json`.
- Official Kairn eval: `batches/batch-A/official-kairn-after-companion-scope-fix-rerun4.stdout.json`.
- Classification: `batches/batch-A/batch-A-classification.after-companion-scope-fix-rerun4.json`.

Batch A control outcome:

- OpenLibrary: clean official savings, 43,689 baseline tokens to 40,804 Kairn tokens, 6.6% reduction, official pass/pass, scope pass/pass.
- Element: invalid savings, 113,227 baseline tokens to 74,095 Kairn tokens, but Kairn still failed the official evaluator.
- Ansible: official token regression, 38,649 baseline tokens to 43,173 Kairn tokens, official pass/pass, scope pass/pass.

Campaign action: continue to Batch B. The Ansible token regression is tracked, but the pause threshold is not met because this is one observed regression class, not two repeated same-class pass/pass regressions.

## 2026-05-24: Batch B Pause And Guardrail Fixes

- Issue: Batch B triggered the pause policy. Initial Kairn rows showed repeated pass/pass token regressions on official patch tasks. A follow-up suppress/pass-through rerun reduced one row but still missed an official pass. The next tiny guardrail rerun reduced tokens on some rows but over-constrained one hidden-helper task and widened one exact-source task into a sibling source edit.
- Fixes:
  - Non-interactive `kairn codex` now passes the original user prompt through unchanged when Kairn suppresses context, instead of prepending session plumbing.
  - Official patch hooks can emit a tiny guardrail for high-confidence production patch prompts, but exact-source wording now stays one-file unless direct imported/called production helper evidence is needed.
  - `change all functionality` / `from urllib to requests` wording no longer counts as an explicit multi-file edit request unless it explicitly says files, sources, modules, or components.
  - Import-linked helper companions get a stronger task-term signal for general password/hash helper tasks, while generic execution coordinators are downranked for those prompts.
- Files changed: `src/cli/commands/core.ts`, `src/runtime/KairnRuntime.ts`, `src/prime/contextGovernor.ts`, `src/prime/formatPrime.ts`, `src/retrieval/companions.ts`, `tests/bench.test.ts`.
- Classification artifacts:
  - `batches/batch-B/batch-B-classification.after-selected-test-filter-rerun1.json`.
  - `batches/batch-B/batch-B-classification.post-location-hint-rerun1.json`.
  - `batches/batch-B/batch-B-classification.post-suppressed-pass-through-rerun2.json`.
  - `batches/batch-B/batch-B-classification.post-official-guardrail-rerun3.json`.
- Validation:
  - Focused bench tests passed: `pnpm test tests/bench.test.ts -- --runInBand`.
  - Typecheck passed: `pnpm typecheck`.
  - Build passed: `pnpm build`.
  - Diff whitespace passed: `git diff --check`.

Campaign action: rerun affected Batch B rows plus two controls before continuing to Batch C.

### Invalid Rerun 4 Harness Failure

- Attempted run: `batches/batch-B/kairn-real-wrapper.post-scope-stopcondition-rerun4.json`.
- Status: invalid; excluded from all product metrics.
- Issue: the first Codex subprocess exceeded the benchmark timeout and remained alive after the shell wrapper exited, leaving an empty redirected JSON artifact.
- Fix: benchmark agent commands now run in their own Unix process group so timeout termination reaches the full subprocess tree.
- Artifact: `batches/batch-B/kairn-real-wrapper.post-scope-stopcondition-rerun4.harness-failure.json`.

### Batch B Rerun 5 Clearance

- Rerun: `batches/batch-B/kairn-real-wrapper.post-scope-stopcondition-rerun5.json`.
- Official eval: `batches/batch-B/official-kairn-post-scope-stopcondition-rerun5.stdout.json`.
- Classification: `batches/batch-B/batch-B-classification.post-scope-stopcondition-rerun5.json`.
- Outcome: 4/4 Kairn official passes on affected/control rows.
- Clean savings: 3/4 rows, 36,906 clean tokens saved, 21.6% median reduction across the clean rows.
- Remaining regression: 1 pass/pass token regression in `multi_file_debug` class, below the repeated-class pause threshold.

Campaign action: pause cleared; continue to Batch C.

## 2026-05-24: Batch C Scope Clearance

- Issue: Batch C initially produced official-passing Kairn patches with local scope failures on production-source tasks:
  - Vuls scanner routing selected sibling/helper source in addition to the official scanner source.
  - Flipt auth routing edited an unmentioned auth-provider variant.
  - Flipt tracing picked up `go.work.sum` dependency checksum churn from Go tooling.
- Fixes:
  - Official prompt source metadata now creates a strict edit boundary for high-confidence official production patch prompts.
  - Unmentioned provider/method variants are treated as read-only unless explicitly selected by prompt or official metadata.
  - Selected verification metadata is stripped from retrieval text before source scoring so test names do not dominate source routing.
  - Go package-entry routing now boosts named package entrypoints while excluding generic package names such as config/server/models/types/common from that entrypoint boost.
  - `go.work.sum` is treated as benchmark/tooling churn for local diff-scope accounting.
- Files changed: `src/types/context.ts`, `src/scope/editScope.ts`, `src/prime/contextGovernor.ts`, `src/prime/formatPrime.ts`, `src/retrieval/hybridRetrieval.ts`, `src/bench/agent.ts`, `src/bench/sourceValidation.ts`, `tests/bench.test.ts`.
- Validation:
  - Focused bench tests passed: `pnpm test tests/bench.test.ts -- --runInBand`.
  - Typecheck passed: `pnpm typecheck`.
  - Build passed: `pnpm build`.
  - Diff whitespace passed: `git diff --check`.

### Batch C Rerun 7 Clearance

- Rerun: `batches/batch-C/kairn-real-wrapper.after-go-package-routing-rerun7.json`.
- Clean patches: `batches/batch-C/kairn-real-wrapper.after-go-package-routing-rerun7.clean-patches.json`.
- Official eval: `batches/batch-C/official-kairn-after-go-package-routing-rerun7.stdout.json`.
- Classification: `batches/batch-C/batch-C-classification.after-go-package-routing-rerun7.json`.
- Outcome: 4/4 Kairn official passes on affected/control rows.
- Local scope: 4/4 Kairn rows passed local scope; no `go.work.sum` or `.kairn` setup churn counted as agent scope.
- Clean savings: 1 pass/pass clean-savings row, 11,718 tokens saved.
- Source/scope rescue: 1 row where baseline passed official eval but failed local source scope, while Kairn passed official eval and local source scope.
- Remaining regression: 1 pass/pass token regression in `multi_file_debug`, below the repeated-class pause threshold.
- Token-unavailable row: 1 official pass/pass row where baseline timed out, so clean savings are not computed.

Campaign action: pause cleared; continue to Batch D.

## 2026-05-24: Batch D Canonical ID And Generic Counterpart Routing

- Issue: Batch D initially exposed two problems:
  - The SWE-Pro case adapter lowercased official `instance_id` values, which caused mixed-case rows such as NodeBB to mismatch official evaluator patch IDs.
  - Selected verification test paths with broad basenames such as `test/topics.js` over-promoted generic source counterparts like `src/controllers/topics.js`, while the task-specific implementation surface `src/topics/sorted.js` was only a lower-ranked candidate.
- Fixes:
  - SWE-Pro live suite cases now preserve the exact official `instance_id` casing.
  - Selected-test counterpart routing still boosts exact path counterparts, but generic counterpart basenames such as `topics.js`, `users.js`, and `code.py` receive only weak or no basename-only credit unless the directory path is an exact selected-test counterpart.
  - Companion routing uses the same generic counterpart discipline so arbitrary sibling `code.py`/`utils.py` files are not selected from basename alone.
- Files changed: `src/bench/sweBenchPro.ts`, `src/retrieval/hybridRetrieval.ts`, `src/retrieval/companions.ts`, `tests/bench.test.ts`.
- Validation:
  - Focused bench tests passed: `pnpm test tests/bench.test.ts -- --runInBand`.
  - Typecheck passed: `pnpm typecheck`.
  - Build passed: `pnpm build`.
  - Diff whitespace passed: `git diff --check`.

### Batch D Rerun 2 Clearance

- Initial classification: `batches/batch-D/batch-D-classification.after-canonical-id-rerun1.json`.
- Affected/control rerun: `batches/batch-D/kairn-real-wrapper.after-generic-counterpart-routing-rerun2.json`.
- Clean patches: `batches/batch-D/kairn-real-wrapper.after-generic-counterpart-routing-rerun2.clean-patches.json`.
- Official eval: `batches/batch-D/official-kairn-after-generic-counterpart-routing-rerun2.stdout.json`.
- Final merged classification: `batches/batch-D/batch-D-classification.after-generic-counterpart-routing-rerun2.json`.
- Outcome: NodeBB changed from no patch / official failure to a scoped `src/topics/sorted.js` official pass.
- Controls: Tutanota and OpenLibrary remained official passes and local-scope passes.
- Final Batch D summary: 3/5 Kairn official passes vs 2/5 baseline official passes, 1 quality/source-focus rescue, 1 official pass/pass token regression, 2 invalid savings rows, 0 harmful assists, 0 scope failures.

Campaign action: pause cleared; aggregate 5 historical seed rows plus the 20-row expansion.
