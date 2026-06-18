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
- `usekairn-darwin-x64`
- `usekairn-linux-arm64`
- `usekairn-linux-x64`
- `usekairn-win32-x64`

The launcher has no install-time download behavior. If the platform package is missing, it prints the exact reinstall command and exits.

## Release Safety

- The root source package is marked `private: true` to block accidental public JS publication.
- Platform packages fail `prepack` unless a real binary, required runtime assets, and matching `checksums.txt` are present.
- The default beta builder creates a platform binary with `pkg` and ships native/WASM runtime assets beside it under `bin/assets`.
- Cross-target builds are rejected because the SQLite native addon must match the build host. Use the CI matrix or a matching machine for each platform.
- Telemetry is opt-in and is not enabled by install.
- Install does not mutate shell profiles, project configs, Codex, Claude, Gemini, Copilot, or VS Code settings. Configuration still happens only through explicit `kairn setup ...` commands.

## Maintainer Flow

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

Dry-run pack:

```bash
npm pack --dry-run packages/npm/kairn
npm pack --dry-run .release/npm/kairn-darwin-arm64
```

Publish only with the `beta` tag until platform smoke tests pass:

```bash
npm publish packages/npm/kairn --tag beta
npm publish .release/npm/kairn-darwin-arm64 --tag beta
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
