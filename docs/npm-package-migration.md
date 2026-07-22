# npm Package Migration: `kairn` to `usekairn`

Beginning with v0.2, the canonical npm package is `usekairn`. The installed executable remains `kairn`, so repository hooks, MCP configurations, shell commands, and scripts do not need to change.

Install or upgrade with:

```sh
npm uninstall -g kairn
npm install -g usekairn
kairn --version
```

The npm registry cannot transfer installed users from one package name automatically. Existing `kairn` package installations therefore remain on their previously installed version until users install `usekairn`. A compatibility release of the old npm package should contain only a deprecation notice pointing to `usekairn`; it must not introduce a second executable name or a separate implementation line.

Local `.kairn` state and Kairn-owned agent configuration remain compatible because they invoke the unchanged `kairn` binary.
