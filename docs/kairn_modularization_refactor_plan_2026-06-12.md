# Kairn Modularization Refactor Plan

Date: 2026-06-12

## Summary

Kairn is now proving useful behavior, but the implementation is becoming expensive to maintain. The core runtime, retrieval, governor, formatter, and campaign harness have accumulated too many responsibilities in a small number of large files. This makes every routing or sizing fix riskier than it needs to be.

The goal of this refactor is not to change Kairn's behavior. The goal is to split the current monolithic files into explicit, testable modules so future governance improvements can be made safely and quickly.

This should happen after the current governance-routing PR reaches its evidence gate, or as a separate draft PR if the current PR remains blocked by long-running official tests.

## Current Pressure Points

The largest files are carrying multiple layers at once:

- `src/runtime/KairnRuntime.ts`: runtime orchestration, setup, delivery policy, traces, source-surface logic, and mode-specific behavior.
- `src/retrieval/hybridRetrieval.ts`: candidate scoring, role signals, task-shape rules, downranking, graph/test relationships, and behavior-class fixes.
- `src/prime/contextGovernor.ts`: governor decision rules, task-shape interpretation, required-surface selection, and suppression/shrink/emit behavior.
- `src/prime/formatPrime.ts`: final directive formatting plus guardrail, source-map, evidence-request, and context body decisions.
- `src/bench/campaign.ts`: manifest parsing, scheduling, proxy checks, live proof execution, artifacts, summaries, pause rules, and cleanup.

The risk is no longer just file size. The risk is that routing, sizing, and evidence code are intertwined enough that a small improvement can accidentally change unrelated behavior.

## Refactor Principles

- Preserve behavior first. Refactor without changing public claims, benchmark numbers, or default CLI behavior.
- Move code by responsibility, not by convenience.
- Keep module boundaries aligned with Kairn's product model: retrieval finds candidates, governance decides what belongs, formatting emits the directive, runtime coordinates execution, campaign measures outcomes.
- Every extraction should come with tests or existing tests proving behavior is unchanged.
- Avoid making a new abstraction unless it removes real coupling.
- Do not introduce row-specific or repo-specific benchmark logic during the refactor.
- Keep public-safe reporting separate from raw/debug artifacts.

## Target Architecture

### Runtime Layer

Purpose: coordinate setup, indexing, mode selection, delivery, and telemetry without owning the details of scoring or directive generation.

Proposed modules:

- `src/runtime/KairnRuntime.ts`
  - Keep as the public runtime facade.
  - Delegate to smaller runtime services.
- `src/runtime/runtimeConfig.ts`
  - Resolve runtime mode, root, session, budget, and feature flags.
- `src/runtime/runtimeTrace.ts`
  - Build sanitized trace metadata for benchmark/debug artifacts.
- `src/runtime/sourceSurface.ts`
  - Convert retrieval/governor output into edit scope, read-only scope, emitted source roles, and scope warnings.
- `src/runtime/deliveryPolicy.ts`
  - Apply final mode-specific policy: emit, shrink, suppress, evidence request, MCP behavior.
- `src/runtime/sessionState.ts`
  - Encapsulate active files, prior established context, quiet decisions, and stale/repeated context checks.

Desired result: `KairnRuntime.ts` becomes a readable orchestration facade instead of the place where every policy lives.

### Retrieval Layer

Purpose: score and rank candidate files/snippets using general repo and task signals.

Proposed modules:

- `src/retrieval/hybridRetrieval.ts`
  - Keep public retrieval entrypoint.
  - Compose scorers and normalizers.
- `src/retrieval/scoring/baseSignals.ts`
  - Name/path/symbol/text relevance.
- `src/retrieval/scoring/roleSignals.ts`
  - Production/test/doc/generated/config/style role weighting.
- `src/retrieval/scoring/testCounterpartSignals.ts`
  - Generic test weakening and path-specific test-to-source routing.
- `src/retrieval/scoring/commandContractSignals.ts`
  - Command/export/flag/converter/launcher ownership.
- `src/retrieval/scoring/lifecyclePolicySignals.ts`
  - Deprecation/removal/version/policy metadata ownership.
- `src/retrieval/scoring/frontendOwnershipSignals.ts`
  - Component/route/store/action/listener/device ownership and broad-container penalties.
- `src/retrieval/scoring/packageSourceSignals.ts`
  - Package-source/vulnerability mapping vs narrow parser tasks.
- `src/retrieval/scoring/downrankSignals.ts`
  - Storage/backend/helper/style/generated penalties.
- `src/retrieval/candidateRoles.ts`
  - Shared candidate role derivation used by retrieval and governor.

Desired result: a new behavior class gets a scorer module and tests, not another conditional block inside `hybridRetrieval.ts`.

### Governor Layer

Purpose: decide what the agent should receive now, based on ranked candidates, task shape, session state, and confidence.

Proposed modules:

- `src/prime/contextGovernor.ts`
  - Keep public governor entrypoint.
  - Delegate task-shape and required-surface decisions.
- `src/prime/taskShape.ts`
  - Detect task signals such as exact-source, command-contract, lifecycle-policy, frontend-ownership, ambiguous frontend, parser-only, package-source mapping, failure-debug, and multi-file intent.
- `src/prime/requiredSurface.ts`
  - Choose `single_file`, `paired_contract`, `feature_cluster`, `policy_source`, `evidence_needed`, or `multi_surface`.
- `src/prime/governorDecision.ts`
  - Select suppress/shrink/emit/evidence-request.
- `src/prime/governorSizing.ts`
  - Pick tiny, compact, balanced, or expanded directive sizing.
- `src/prime/governorTrace.ts`
  - Produce sanitized fields such as task shape, required surface, directive style, guardrail variant, emitted file count, and sizing reason.

Desired result: task-shape inference and output-size decisions become independently testable.

### Directive Formatting Layer

Purpose: turn a governor decision into the exact text the agent sees.

Proposed modules:

- `src/prime/formatPrime.ts`
  - Keep exported formatting API.
  - Dispatch to directive formatters.
- `src/prime/directives/scopeGuardrail.ts`
  - Tiny exact-source guardrails.
- `src/prime/directives/pairedContract.ts`
  - Compact paired-source directives.
- `src/prime/directives/policySource.ts`
  - Lifecycle/deprecation policy directives.
- `src/prime/directives/frontendOwnerMap.ts`
  - Compact owner maps for frontend/component tasks.
- `src/prime/directives/evidenceRequest.ts`
  - Evidence-needed questions and missing-signal requests.
- `src/prime/directives/multiSurface.ts`
  - Multi-file context directives.
- `src/prime/directives/suppression.ts`
  - Quiet/suppressed output bodies and reason text.

Desired result: changing wording or token budget for one directive style cannot accidentally change all other directive styles.

### Campaign Harness Layer

Purpose: run fast proxy checks, targeted live checks, official proof, summaries, and cleanup without mixing all campaign mechanics together.

Proposed modules:

- `src/bench/campaign.ts`
  - Keep CLI-facing campaign entrypoint.
  - Delegate to campaign services.
- `src/bench/campaign/manifest.ts`
  - Parse and validate manifests.
- `src/bench/campaign/scheduler.ts`
  - Bounded worker pool, resume behavior, and dependency ordering.
- `src/bench/campaign/proxyRunner.ts`
  - Fast local governor/runtime checks.
- `src/bench/campaign/liveRunner.ts`
  - Live Codex/MCP/proof execution.
- `src/bench/campaign/officialRunner.ts`
  - Official evaluator integration and row-level classification.
- `src/bench/campaign/artifacts.ts`
  - Safe file layout, raw/work ignore handling, output hashes, logs.
- `src/bench/campaign/summary.ts`
  - Results aggregation, CSV/JSON/MD summaries.
- `src/bench/campaign/pauseRules.ts`
  - Harmful assist, scope violation, repeated token regression, MCP fanout, and harness failure gates.
- `src/bench/campaign/cleanup.ts`
  - Remove only campaign-owned disposable workspaces.
- `src/bench/campaign/progress.ts`
  - Progress output for JSON and non-JSON modes.

Desired result: campaign runs are easier to debug, and an apparent hang can be localized to setup, runtime init, Codex, Docker, evaluator, artifact writing, or summary generation.

## Phase Plan

### Phase 0: Baseline And Guardrails

Before moving code:

- Confirm current branch status and decide whether this is based on `main` or the draft governance-routing branch.
- Run:
  - `pnpm vitest run tests/bench.test.ts tests/runtime.test.ts tests/semantic.test.ts tests/scope.test.ts`
  - `pnpm test`
  - `pnpm typecheck`
  - `pnpm build`
  - `git diff --check`
- Capture line counts and known behavior gates.
- Mark current public evidence as unchanged.

Exit criteria:

- Clean local validation.
- No public evidence or website changes.

### Phase 1: Campaign Harness Extraction

Start here because the campaign harness is how we prove later behavior changes.

Tasks:

- Extract manifest validation into `src/bench/campaign/manifest.ts`.
- Extract artifact writing into `src/bench/campaign/artifacts.ts`.
- Extract pause rules into `src/bench/campaign/pauseRules.ts`.
- Extract scheduler/progress into `src/bench/campaign/scheduler.ts` and `progress.ts`.
- Preserve existing CLI behavior.

Tests:

- Manifest parse/reject tests.
- Pause rule tests.
- Dry-run fixture campaign.
- Mock live campaign with parallel workers.
- Existing bench tests.

Exit criteria:

- `src/bench/campaign.ts` is mainly orchestration.
- Fixture campaigns still pass.
- Progress output still works under `--json`.

### Phase 2: Directive Formatting Extraction

This is low risk because it should be mostly moving string generation.

Tasks:

- Extract directive styles from `formatPrime.ts`.
- Add snapshot-like tests for:
  - exact-source scope guardrail,
  - paired contract,
  - lifecycle policy,
  - frontend owner map,
  - evidence request,
  - suppression.
- Keep token budgets and wording unchanged unless a test exposes drift.

Exit criteria:

- `formatPrime.ts` is a dispatcher plus shared helpers.
- Output for existing tests is unchanged except where tests explicitly approve formatting cleanup.

### Phase 3: Governor Decision Extraction

This is higher leverage and should be done after formatting is stable.

Tasks:

- Extract task-shape detection into `taskShape.ts`.
- Extract required-surface selection into `requiredSurface.ts`.
- Extract sizing into `governorSizing.ts`.
- Extract sanitized decision trace into `governorTrace.ts`.
- Keep `contextGovernor.ts` as the policy orchestrator.

Tests:

- Exact-source official patch stays tiny/suppressible.
- Multi-file implied prompt stays multi-surface.
- Command/export task selects paired contract.
- Lifecycle/deprecation task selects policy source.
- Ambiguous frontend requests evidence.
- Frontend owner task selects owner map.
- Narrow RPM parser remains single-file.
- Package-source/vulnerability mapping remains multi-surface.

Exit criteria:

- Governor behavior is unchanged on current fixture suite.
- Adding a new task shape no longer requires editing unrelated governor logic.

### Phase 4: Retrieval Scoring Extraction

This is the riskiest phase because it touches ranking behavior. It should be done in small modules with focused tests after each extraction.

Tasks:

- Extract candidate role derivation.
- Extract scoring modules one at a time:
  - role signals,
  - test counterpart signals,
  - command/converter signals,
  - lifecycle policy signals,
  - frontend ownership signals,
  - package-source signals,
  - downrank signals.
- Keep final score composition in one clear place.
- Add debug trace for score contributions where safe.

Tests:

- Existing semantic tests.
- Routing tests for each behavior class.
- Proxy campaign over known risk rows.

Exit criteria:

- `hybridRetrieval.ts` reads as a composition pipeline.
- Each scorer has focused tests.
- Known benchmark behavior does not regress.

### Phase 5: Runtime Service Extraction

This should happen after governor and formatting boundaries are cleaner.

Tasks:

- Extract runtime config/session state.
- Extract source-surface construction.
- Extract delivery policy and trace metadata.
- Preserve public runtime API.

Tests:

- Runtime tests.
- MCP smoke.
- Codex hook dry-run.
- Local `kairn prime` behavior.

Exit criteria:

- `KairnRuntime.ts` becomes a facade.
- Runtime mode behavior is easier to inspect.

## Evidence And Testing Strategy

This refactor should use a two-level proof strategy.

### Refactor Proof

For every phase:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `git diff --check`
- Focused tests for moved code.
- Fixture campaign if campaign/runtime behavior is touched.

### Behavior Proof

Only after all modules are extracted:

- Run a small proxy-first campaign over known risk rows.
- Run a small live Codex campaign if proxy passes.
- Run MCP smoke and one MCP/endurance check.
- Do not update public claims unless fresh official evidence confirms behavior.

## Non-Goals

- No semantic slicing rollout in this refactor.
- No new public claims.
- No website evidence updates.
- No benchmark-specific hacks.
- No CLI behavior changes unless needed for internal debug visibility.
- No broad rewrite of algorithms before module boundaries are clean.

## Risks

- Moving retrieval scoring can subtly change ordering even if logic looks identical.
- Splitting directive formatting can accidentally change token budgets.
- Runtime extraction can break mode-specific behavior if shared state is moved incorrectly.
- Campaign extraction can hide failures if summaries and raw artifacts drift apart.

Mitigations:

- Move one responsibility at a time.
- Use existing tests before adding new behavior.
- Keep output snapshots or precise assertions around directive styles.
- Keep campaign summaries generated from artifacts, not duplicated state.
- Do not merge large extraction phases without full validation.

## Recommended Branching

Use a separate refactor branch after the current governance-routing PR is resolved:

```bash
git checkout main
git pull
git checkout -b refactor/modularize-runtime-governor-campaign
```

If the current governance-routing PR remains draft for a while, start the refactor as a draft branch off that PR only if the goal is local maintainability and not immediate merge.

Recommended PR structure:

1. PR 1: campaign harness extraction.
2. PR 2: directive formatting extraction.
3. PR 3: governor decision extraction.
4. PR 4: retrieval scoring extraction.
5. PR 5: runtime service extraction.

Avoid one giant refactor PR. It will be hard to review and hard to bisect.

## Acceptance Criteria

The refactor is successful when:

- `KairnRuntime.ts`, `hybridRetrieval.ts`, `contextGovernor.ts`, `formatPrime.ts`, and `campaign.ts` are materially smaller and read as orchestration layers.
- Existing behavior tests pass.
- Fixture campaign tests pass.
- A small proxy-first campaign still catches known bad routing/sizing classes.
- MCP smoke still works.
- No public evidence or product claims changed due to refactor alone.
- Future fixes can target a named module instead of editing several monoliths at once.

## Immediate Next Step

Finish or pause the current governance-routing evidence gate, then start with Phase 1: campaign harness extraction. That gives us better visibility before touching the routing and runtime layers again.
