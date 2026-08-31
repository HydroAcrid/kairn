# Kairn v0.2C ecological Codex pilot

This track measures Vanilla Codex versus Codex with Kairn through released
local hooks. It is deliberately separate from the deferred four-arm
ReasonBlocks experiment and cannot produce a ReasonBlocks comparison claim.

## Frozen runtime

- `@openai/codex@0.145.0`
- npm integrity `sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ==`
- model `gpt-5.6-sol` (the subscription-compatible explicit model ID)
- reasoning effort `medium`
- standard service tier; Fast mode off
- ChatGPT subscription authentication in a dedicated local `CODEX_HOME`

Install and verify the pinned CLI without making a model request:

```bash
pnpm codex:pilot:install
export KAIRN_CODEX_PILOT_HOME="$PWD/.kairn/codex-pilot-home"
.kairn/tools/codex-0.145.0/node_modules/.bin/codex login
```

The harness rejects `OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_API_KEY`, and
`REASONBLOCKS_API_KEY`. Authentication files are never copied into campaign
artifacts.

## Sealed task contract

`codex-pilot.v1` accepts one dedicated smoke repository or 15 unique pilot
repositories: one per Python, TypeScript, Go, Java, and C++ crossed with source
localization, failure-first debugging, and persistent three-turn work. Every
task requires a full immutable commit, digest-pinned container, production
source oracle, required touch list, allowed diff scope, source invariant,
explicit noise pattern, and offline setup/verifier commands. The lineage
registry must give smoke repositories `live_smoke` and pilot repositories
`pilot`; corpus lineages cannot be reused.

`codex-pilot.v2` adds a sealed Kairn identity for the semantic release
candidate. It pins semantic candidate mode, the Jina model manifest, calibrated
ranker mode, the bundled v185 checksum, and `evidence-features-v5`. The harness
rejects environment overrides, verifies the installed model receipt, builds a
real semantic index before launching Codex, and records the full identity in
the campaign and public-evidence manifests. A v1 plan cannot accidentally be
reported as a semantic release-candidate run.

The non-runnable curation registry is
`benchmarks/plans/codex-v02c.task-curation.json`. A `.sealed.json` plan must not
be created until its repository and verifier have actually been checked.

The semantic smoke plan is
`benchmarks/plans/codex-v02c.semantic-rc.smoke.sealed.json`. Its immutable
`sindresorhus/p-map` checkout and already-aborted-signal verifier were checked
inside the digest-pinned Node container with networking disabled: the verifier
fails on the sealed source commit and passes after the minimal production fix.
The earlier `.candidate.json` file remains as the explicitly unsealed curation
record.

## Staged execution

```bash
kairn bench codex-pilot \
  --plan benchmarks/plans/codex-v02c.semantic-rc.smoke.sealed.json \
  --out artifacts/codex-v02c-semantic-rc-smoke \
  --seed 20260722 \
  --stage smoke \
  --codex-command .kairn/tools/codex-0.145.0/node_modules/.bin/codex

kairn bench codex-pilot \
  --plan benchmarks/plans/codex-v02c.pilot.sealed.json \
  --out artifacts/codex-v02c-pilot \
  --seed 20260722 \
  --stage first_repeat \
  --resume \
  --codex-command .kairn/tools/codex-0.145.0/node_modules/.bin/codex

kairn bench codex-pilot \
  --plan benchmarks/plans/codex-v02c.pilot.sealed.json \
  --out artifacts/codex-v02c-pilot \
  --seed 20260722 \
  --stage complete \
  --resume \
  --codex-command .kairn/tools/codex-0.145.0/node_modules/.bin/codex
```

The first repeat is 30 attempts. `complete` is refused until those attempts
form 15 trace-valid pairs under the same plan, Kairn commit, ranker artifact,
Codex pin, and seed. It then adds repeats two and three for 90 total attempts.
An invalid arm causes the whole pair to be regenerated on resume, up to three
recorded generations.

Setup and final verification run in digest-pinned containers with networking
disabled. Codex itself retains network access for subscription inference.
Linux/WSL `strace` records repository `openat`, `openat2`, and `execve` activity;
Kairn hook descendants and `.kairn`/`.codex` internals are excluded from agent
file-access metrics.

Raw JSONL and syscall traces stay local. The publishable
`public-codex-pilot-evidence.v1.json` contains observed token decomposition,
quality/recall/context metrics, every invalid or negative result, language and
scenario strata, and deterministic paired-bootstrap intervals. Token deltas
are computed only for pairs where both attempts pass verification, required
touches, invariants, and diff scopes. The artifact is labeled preliminary
ecological evidence and never includes dollar conversion or ReasonBlocks
results.
