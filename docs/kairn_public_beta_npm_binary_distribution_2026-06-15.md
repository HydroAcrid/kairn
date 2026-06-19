# Kairn Public Beta npm Binary Distribution

## Summary

The public beta install path should be:

```bash
npm install -g usekairn@beta
```

The public `usekairn` npm package must stay a small launcher. It should not publish the current source-built `dist/cli.js` implementation as the public package. The launcher resolves a platform-specific optional dependency package and executes that package's Kairn binary.

## Package Shape

- `usekairn`: public launcher package with the `kairn` bin shim.
- `usekairn-darwin-arm64`
- `usekairn-linux-arm64`
- `usekairn-linux-x64`
- Intel Mac is deferred for the first npm beta until the x64 macOS binary smoke is stable.
- Native Windows is deferred for the first npm beta. Windows users should use WSL or the private beta fallback until the native binary smoke is stable.

The launcher has no install-time download behavior. If the platform package is missing, it prints the exact reinstall command and exits.

## Current Beta Status

Published on 2026-06-19:

- `usekairn@0.1.2`
- `usekairn-darwin-arm64@0.1.2`
- `usekairn-linux-x64@0.1.2`
- `usekairn-linux-arm64@0.1.2`

The verified public install path is:

```bash
npm install -g usekairn@beta
```

Smoke install passed on macOS arm64. `kairn --version` reported `0.1.2`, target `darwin-arm64`, channel `npm-beta`, and platform package `usekairn-darwin-arm64`.

npm also assigned `latest` to `0.1.2` during the first publish even though the publish command used `--tag beta`. Keep docs and beta emails pointed at `usekairn@beta`; do not advertise default `npm install -g usekairn` until the release is intentionally promoted.

## Release Safety

- The root source package is marked `private: true` to block accidental public JS publication.
- Platform packages fail `prepack` unless a real binary, required runtime assets, and matching `checksums.txt` are present.
- The default beta builder creates a platform binary with `pkg` and ships native/WASM runtime assets beside it under `bin/assets`.
- Cross-target builds are rejected because the SQLite native addon must match the build host. Use the CI matrix or a matching machine for each platform.
- Telemetry is opt-in and is not enabled by install.
- Install does not mutate shell profiles, project configs, Codex, Claude, Gemini, Copilot, or VS Code settings. Configuration still happens only through explicit `kairn setup ...` commands.

## Maintainer Flow

### First public beta publish

The first npm beta should be published manually from CI-built tarballs. This avoids long-lived publish tokens and lets npm 2FA create the package names cleanly. Future releases should move to npm Trusted Publishing after the package names exist.

Run the GitHub Actions workflow:

```bash
gh workflow run npm-beta-binary-packages.yml --repo HydroAcrid/kairn --ref main
```

Wait for the workflow to pass, then download all package artifacts:

```bash
run_id="<workflow-run-id>"
mkdir -p .release/manual-publish
gh run download "$run_id" --repo HydroAcrid/kairn --dir .release/manual-publish
find .release/manual-publish -maxdepth 3 -type f -name "*.tgz" | sort
```

Publish platform packages first, then the launcher last. Use a fresh OTP if the previous code expires:

```bash
OTP=123456

npm publish .release/manual-publish/npm-platform-darwin-arm64/usekairn-darwin-arm64-0.1.2.tgz --tag beta --otp "$OTP"
npm publish .release/manual-publish/npm-platform-linux-x64/usekairn-linux-x64-0.1.2.tgz --tag beta --otp "$OTP"
npm publish .release/manual-publish/npm-platform-linux-arm64/usekairn-linux-arm64-0.1.2.tgz --tag beta --otp "$OTP"
npm publish .release/manual-publish/npm-launcher-usekairn/usekairn-0.1.2.tgz --tag beta --otp "$OTP"
```

Verify the beta packages:

```bash
npm view usekairn dist-tags versions --json
npm view usekairn-darwin-arm64 version --json
npm view usekairn-linux-x64 version --json
npm view usekairn-linux-arm64 version --json
```

Smoke install with a temporary global prefix:

```bash
tmp="$(mktemp -d)"
export NPM_CONFIG_PREFIX="$tmp/prefix"
npm install -g usekairn@beta
"$tmp/prefix/bin/kairn" --version
mkdir -p "$tmp/repo"
printf 'export const value = 1;\n' > "$tmp/repo/index.ts"
"$tmp/prefix/bin/kairn" doctor --root "$tmp/repo" --json
"$tmp/prefix/bin/kairn" index refresh --root "$tmp/repo" --json
```

After this first publish, configure npm Trusted Publishing for all four packages and switch CI back to automated `npm publish --tag beta` without `NPM_TOKEN`.

Validate package metadata:

```bash
pnpm release:validate-npm
```

Build a binary on a matching host:

```bash
pnpm release:build-binary -- --target darwin-arm64 --out .release/binaries/darwin-arm64/kairn
```

Or stage a prebuilt binary when testing an alternate builder:

```bash
KAIRN_RELEASE_BINARY_PATH=/path/to/kairn pnpm release:build-binary -- --target darwin-arm64 --out .release/binaries/darwin-arm64/kairn
```

Stage the platform package. If `.release/binaries/darwin-arm64/assets` exists, it is copied into `bin/assets` automatically:

```bash
pnpm release:stage-platform -- --target darwin-arm64 --binary .release/binaries/darwin-arm64/kairn --out-dir .release/npm
```

Local dry-run pack:

```bash
npm pack --dry-run packages/npm/kairn
npm pack --dry-run .release/npm/kairn-darwin-arm64
```

Local direct publishing is only for emergency/manual releases. Publish platform packages before the launcher:

```bash
npm publish .release/npm/kairn-darwin-arm64 --tag beta
npm publish packages/npm/kairn --tag beta
```

## Smoke Test

Use a temp global prefix and the packed local packages:

```bash
export NPM_CONFIG_PREFIX="$(mktemp -d)"
npm install -g ./usekairn-0.1.2.tgz ./usekairn-darwin-arm64-0.1.2.tgz
kairn --version
kairn doctor --root /tmp
kairn index refresh --root /path/to/fixture --json
```

Then run a fixture setup and MCP smoke before publishing:

```bash
kairn setup wizard --root /path/to/fixture --choice mcp --yes --no-index
kairn bench mcp-smoke --root /path/to/fixture --task "Find the main source file" --json
```

## Notes

Binary packaging is IP friction, not absolute protection. Determined users can still inspect behavior. The real product protection is speed, evidence, trust, support, iteration, and the quality of Kairn's context execution control.
