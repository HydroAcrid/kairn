# Controlled comparison host

`anthropic_messages_host.py` is the benchmark-only, instrumented agent loop used by
`kairn bench experiment`. It is intentionally outside Kairn's npm runtime.

Install the pinned Python dependencies in an isolated environment, set
`ANTHROPIC_API_KEY`, and set `REASONBLOCKS_API_KEY` only for the two ReasonBlocks
arms. ReasonBlocks runs require `--allow-external-trajectory` and public repository
tasks. The emitted JSONL trace contains paths, hashes, ranges, counts, provider
status, and timing; it excludes raw prompts, reasoning, source, patches, and tool
output.

The five instrumented tools are `list_files`, `search_repo`, `read_file`,
`apply_patch`, and `run_verification`. Adding an uninstrumented repository-read
path invalidates the comparison protocol.

## comparison-v1 plans and offline validation

The checked-in comparison-v1 files have deliberately different trust levels:

- `plans/comparison-v1.smoke.json` is a schema-valid, one-task/one-repeat plan.
  It exists to exercise the four-arm schedule and trace accounting; it is not a
  sealed effectiveness campaign.
- `fixtures/comparison-v1.fake-agent.v1.json` drives a deterministic local
  fake-agent trace for all four arms. Its token values are test vectors, not
  measurements or product claims.
- `plans/comparison-v1.pilot.template.json` and
  `plans/comparison-v1.publication.template.json` are non-runnable descriptors.
  They set `runnable: false`, leave `unresolvedTaskManifest` null, and use a
  template schema that `kairn bench experiment` rejects.

Run the first validation stage without provider keys, Docker, a Git clone, or
network access:

```text
pnpm verify:experiment-smoke
```

The validator checks plan parsing, seeded four-arm ordering, trace integrity,
required-source recall, observed-token bucket arithmetic, provider-token
attribution, and rejection of the unresolved pilot/publication templates. It
writes no evidence artifact. `fixtureNotEvidence: true` must remain present in
its result.

The real experiment command can also freeze the smoke schedule without calling
providers:

```text
kairn bench experiment \
  --plan benchmarks/plans/comparison-v1.smoke.json \
  --out artifacts/comparison-v1-smoke-dry-run \
  --seed 20260722 \
  --dry-run
```

Do not remove `.template` from either larger descriptor or pass it to the
experiment runner. First create and independently review a sealed task
manifest, then materialize a new plan whose `tasks` array contains exactly one
task per language/scenario cell for the pilot or two per cell for publication.
The resulting runnable files should be named outside the template paths, for
example `artifacts/manifests/comparison-v1.pilot.sealed.json`. The `pilot` and
`publication` profiles invoke the runner's fixed matrix, repeat, oracle,
immutable-ref, and quality-gate validation. Until those sealed files exist,
there is no checked-in 180-attempt pilot or 600-attempt publication plan.

After sealing and provider preflight, the exact campaign shapes are:

```text
kairn bench experiment \
  --plan artifacts/manifests/comparison-v1.pilot.sealed.json \
  --out artifacts/comparison-v1-pilot \
  --seed 20260722 \
  --resume \
  --allow-external-trajectory

kairn bench experiment \
  --plan artifacts/manifests/comparison-v1.publication.sealed.json \
  --out artifacts/comparison-v1 \
  --seed 20260722 \
  --resume \
  --allow-external-trajectory
```

These commands require the preregistered provider credentials, versions,
calibrated ranker identity, immutable local Kairn runtime, local sandbox images,
and publication artifact URL enforced by the runner. Provider or service
failure invalidates an attempt; it never falls back to another arm.

Every controlled task must preregister a Docker image by immutable SHA-256
digest. The image must already exist locally: the harness uses `--pull=never`
and treats a missing image or unavailable daemon as an infrastructure failure.
Repository-provided setup commands, the failure-first command, tool-triggered
verification, and the redundant final verifier all run with:

- no network;
- a read-only container root, dropped capabilities, `no-new-privileges`, and a
  bounded PID namespace;
- only the disposable workspace mounted read/write, with `.git` over-mounted
  read-only except for the harness-owned baseline commit;
- a tmpfs-backed `/tmp` and `HOME`; and
- the invoking non-root UID/GID where the host platform exposes them.

The host-side public clone disables system and global Git configuration,
credential prompting, askpass programs, and injected `GIT_CONFIG_*` entries.
Provider credentials are never passed into the container.

The Docker daemon executes container workloads outside the Python host process,
so the host CPU/RSS fields do not measure container CPU or peak memory. Those
fields must not be presented as end-to-end resource measurements until separate
daemon/container accounting is added. This boundary also assumes a trusted,
patched Docker engine; it reduces repository-code privileges but is not a VM or
kernel isolation proof.

## v0.2C ecological Codex track

The dedicated `kairn bench codex-pilot` runner now owns this two-arm track. It
pins `@openai/codex@0.145.0` by npm integrity, uses ChatGPT subscription auth in
a dedicated non-serialized `CODEX_HOME`, rejects provider API credentials,
counterbalances fresh Vanilla/Kairn checkouts, and records observed Codex JSONL
usage plus Linux/WSL syscall evidence. Setup and final verification run in
digest-pinned containers with networking disabled.

The checked-in smoke/pilot files are non-runnable curation descriptors. Do not
rename them to `.sealed.json` until all repository commits, source oracles,
offline verifiers, lineages, and Docker digests have been independently checked.
CI uses a deterministic `codex-pilot-fake.v1` fixture; fake results are protocol
tests and never evidence.

See [the v0.2C Codex pilot protocol](../docs/codex-v02c-pilot.md) for the exact
2/30/90-attempt stages, runtime pin, invalid-pair policy, metrics, and commands.
