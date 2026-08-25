# Kairn v0.2 Monday Beta Release Plan

## Release decision

Monday is a public beta update, not the calibrated semantic promotion and not the v0.3 evidence publication. The release is allowed to ship the safer deterministic candidate generator, unified local runtime, easier enable flow, and quality-gated reporting while semantic retrieval continues in explicit shadow preview.

## User contract

```text
npm install -g usekairn@beta
cd <repository>
kairn enable
kairn doctor
```

The useful path remains local, accountless, offline-capable, reversible, and compatible with detected supported agents. Normal enable does not install a model. Telemetry is off until explicitly enabled. `kairn disable` removes only Kairn-owned integration entries; `--delete-state` also removes local state.

## Launch blockers

All must be green on the exact release commit:

1. Unified history contains both `74ddb15` and `660bce7`; worktree is clean, signed, pushed, and protected CI is green.
2. TypeScript typecheck, full tests, build, semantic architecture guard, license headers, notices, secrets, and package-content checks pass.
3. The packed `usekairn` tarball installs into a clean consumer project; version, dry-run, deterministic enable, and complete disable pass.
4. Hosted clean-install/setup smoke passes on Ubuntu, macOS, and Windows. Tier A passes on Ubuntu and macOS. Tier B passes with the pinned Jina artifact, proving operation only.
5. `kairn report` and `kairn report --share` label estimated context separately from provider tokens and withhold claims from quality-incomplete sessions.
6. The npm workflow uses two manually separated runs: first build and inspect a checksummed artifact, then dispatch publication with that build run ID, commit, and SHA-256. Publication uses npm OIDC trusted publishing and only the `beta` dist-tag. npm rejects GitHub Actions provenance for private source repositories, so this private-repository beta publishes without provenance; provenance returns when the source repository is public. This is the approval boundary because the current private-repository GitHub plan does not support required environment reviewers.
7. The install command is verified against the registry artifact after publication. `latest` is unchanged.

Any failed gate is a no-go. Infrastructure failures are fixed or disclosed; they are never converted into Kairn effectiveness losses or wins.

## Release sequence

### Candidate freeze

- Freeze `0.2.0-beta.1` on the unified branch.
- Generate the tarball and SHA-256 checksum.
- Record the commit, package digest, Node/pnpm versions, and gate outputs.
- Install the exact tarball in a new temporary consumer and repository.

### Hosted validation

- Open a pull request from `codex/v0.2-unified-release`.
- Require open-source integrity, cross-platform setup/package smoke, benchmark Tier A, DCO, dependency review, and secret scanning.
- Run Tier B manually with its immutable cached model. Do not open the holdout and do not call Claude or ReasonBlocks.

### Publish

- Dispatch `npm beta two-step release` from `main` with `action=build` and `version=0.2.0-beta.1`.
- Download its artifact and verify the recorded SHA-256, package identity, contents, and source commit.
- Manually dispatch the same workflow with `action=publish`, the verified build run ID, full commit SHA, and exact tarball SHA-256. The publish run refuses any other workflow, branch, commit, failed build, package identity, version line, or checksum.
- Keep trusted publishing restricted to `HydroAcrid/kairn` and `npm-beta.yml`, with only `npm publish` allowed. The private-repository beta explicitly sets `--provenance=false` because npm can auto-enable provenance when GitHub OIDC is available and then reject private source visibility; do not replace OIDC with a long-lived npm token.
- Wait for the npm registry to expose the new `beta` tag, verify that `latest` is unchanged, then install globally on a clean machine and run `kairn --version`, `kairn enable --dry-run`, `kairn enable`, `kairn doctor`, and `kairn disable`.

### Public update

- Lead with local repository evidence and token efficiency, not generic agent memory.
- Say “all detected supported agents,” not “every agent.”
- Describe semantic retrieval as an evaluator preview, not the default product.
- Publish no new effectiveness percentage from Tier A/B. Existing numbers remain legacy/pre-ranker unless generated from a frozen valid evidence artifact.
- Give testers one lightweight request: use Kairn normally, then paste `kairn report --share` and one sentence about what felt useful or confusing.

## Rollback

- Do not move `latest`; Monday uses the `beta` dist-tag.
- If the registry artifact fails post-publish smoke, move `beta` back to the last known-good version and publish the incident in release notes.
- Users can reinstall the previous beta and run `kairn doctor --fix`, or fully remove the integration with `kairn disable`.
- Semantic preview can be disabled by rerunning normal `kairn enable`; the deterministic generator remains the release default.

## What follows Monday

Resume the v0.2C effectiveness program from frozen artifacts: rankability audit on identical 128-file pools, mechanism-level reranker specification, calibration run, and only then the detached holdout and paid four-arm smoke. v0.3 remains the calibrated-by-default, 600-attempt, provenance-backed evidence release.
