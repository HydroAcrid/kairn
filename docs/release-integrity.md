# Release integrity

Kairn's repository-local integrity checks produce reviewable evidence; they do not by themselves complete a legal audit, publish a package, sign release notes, or prove npm provenance.

## Pull-request and main-branch checks

The `Open-source integrity` workflow uses Node.js 24 and pnpm 10.31.0 to run typechecking, tests, a production build, secret scanning, production-license inventory, generated-notice drift checks, a CycloneDX SBOM, model reproducibility, an offline runtime smoke, and an npm package-contents review.

A separate Linux/macOS/Windows matrix builds the package and runs `kairn enable` twice followed by `kairn disable` in an isolated temporary repository and home directory. It checks idempotency, semantic preservation of unrelated JSON configuration, exact preservation of source/text files, and removal of Kairn-owned files. This is a filesystem integration smoke; it does not prove discovery against every real installed agent or cover WSL, which remains a release-candidate gate.

The offline smoke preloads a guard that records and rejects common Node HTTP, HTTPS, TCP, TLS, DNS, UDP, and `fetch` entry points. It runs local indexing and retrieval with telemetry disabled. A release candidate must additionally be tested under an operating-system-level outbound-network block because native addons or subprocesses are outside this guard's boundary.

## Dependency evidence

```sh
pnpm --silent check:licenses > licenses.prod.json
pnpm --silent check:licenses:all > licenses.all.json
pnpm notices:generate
pnpm notices:check
pnpm --silent sbom > sbom.cdx.json
```

`check:licenses` produces a stable, path-free production inventory with the lockfile hash, package versions, declared licenses, and discovered package-root license-file hashes. `check:licenses:all` adds the installed build/test toolchain for audit input. Both fail for unresolved license declarations. `THIRD_PARTY_NOTICES.md` contains only the current install's locked production dependency inventory and discovered license/notice texts and is shipped in the npm tarball.

`verify:supply-chain-reports` requires the license report and SBOM to contain the same exact component set and rejects unresolved declarations or leaked local install paths.

The generated inventory is review input, not legal approval. Platform-specific optional dependencies that are not installed on the generating machine, dependency source provenance, fixtures, models, and non-npm assets still require explicit review before release.

## Model reproducibility

`pnpm verify:ranker-sample` exports the checked-in public/synthetic sample twice, compares every output byte, recomputes the model checksum, and verifies the training-data hash. The sample demonstrates a reproducible toolchain only; it is not a promoted production model and supplies no quality claim.

## DCO

Pull requests run `scripts/check-dco.mjs` across every commit in the PR range. Each commit must contain a syntactically valid `Signed-off-by` trailer whose email matches the commit author or committer. See [CONTRIBUTING.md](../CONTRIBUTING.md) for remediation instructions.

## Candidate release bundle

The manually dispatchable/tag-triggered `Release integrity bundle (no publish)` workflow reruns the integrity gates and uploads a 30-day candidate bundle containing:

- the npm tarball;
- Apache license, notice, and third-party notices;
- normalized production-license and CycloneDX SBOM reports;
- the reproducible sample model, manifest, and model card;
- `release-integrity.json` with the source commit, lockfile hash, sizes, and SHA-256 hashes;
- `SHA256SUMS`, including the integrity manifest.

The workflow intentionally has read-only repository permissions. Promotion still requires maintainer review, package/release signing, npm provenance publication and verification, and the remaining gates in [open-source-release-checklist.md](open-source-release-checklist.md).

`pnpm verify:release-checksums` independently checks deterministic manifest generation and proves that verification rejects a modified payload.
`pnpm verify:package-contents` asserts that the CLI, legal notices, benchmark host/sample, and reproducible trainer/checksum helper are present while common secret/cache paths are absent.
