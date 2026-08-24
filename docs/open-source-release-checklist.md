# Open-Source Release Checklist

This checklist is release evidence, not a claim that every gate has already passed.

## Provenance and licensing

- [ ] Review source, fixtures, documentation, and bundled artifacts for ownership and redistribution rights.
- [ ] Run `pnpm check:licenses`, `pnpm check:licenses:all`, `pnpm notices:check`, and review every installed production/build/test dependency and discovered license text; separately audit platform-specific optional dependencies.
- [ ] Verify public/synthetic provenance for ranker training inputs and publish the training manifest.
- [ ] Confirm the Apache-2.0 `LICENSE`, `NOTICE`, package metadata, and DCO contribution process.
- [ ] Run `pnpm check:headers` and confirm every shipped source/script file carries its Apache-2.0 SPDX identifier.

## Privacy and security

- [ ] Run `pnpm check:secrets:history`, then manually review private endpoints and benchmark-data provenance across the release tree and reachable history.
- [ ] Run the test suite with outbound network access blocked for core CLI, index, ranker, hook, and MCP paths.
- [ ] Verify telemetry remains disabled until explicitly enabled.
- [ ] Review `npm pack --dry-run` output for unexpected files.

## Reproducibility and supply chain

- [ ] Build and test from a fresh clone with the locked Node/pnpm versions.
- [ ] Generate and review a CycloneDX SBOM with `pnpm sbom`.
- [ ] Run `pnpm verify:ranker-sample` and review the sample artifact, manifest, model card, and checksum.
- [ ] Record package checksum, source commit, lockfile hash, and bundled-model checksum.
- [ ] Publish with npm provenance and verify the package's Sigstore attestation.
- [ ] Verify `npm install -g usekairn`, the `kairn` binary, offline runtime behavior, `kairn enable`, and `kairn disable` on Linux, macOS, Windows, and WSL.

## Release evidence

- [ ] Publish signed release notes containing known limitations and migration instructions.
- [ ] Link quantitative claims to a versioned evidence artifact with denominators and quality gates.
- [ ] Preserve negative results and signed token regressions in publication artifacts.

See [release-integrity.md](release-integrity.md) for the automated evidence, its exact boundaries, and the non-publishing candidate-bundle workflow.
