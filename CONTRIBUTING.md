# Contributing to Kairn

Kairn is a local repository evidence layer for coding agents. Contributions should improve quality-preserving evidence delivery across unknown repositories rather than tune behavior for a named benchmark fixture.

## Development

Requirements:

- Node.js 20.19 or newer and below Node.js 26
- pnpm 10.31.0

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Keep changes focused, add tests for general behavior, and preserve public CLI/MCP compatibility or include an explicit migration. Kairn must remain useful offline; a core feature may not require an account, API key, or hosted Kairn service.

## Sign-off

Kairn uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/). Sign every commit with:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Use `git commit -s` to add the line. By signing off, you certify that you have the right to submit the contribution under this repository's Apache-2.0 license.

Pull-request CI checks every commit, and the trailer email must match that commit's author or committer email. To repair the latest commit, run `git commit --amend -s`; to repair several commits, use an interactive rebase and amend each one. Update the pull-request branch after reviewing the rewritten commits. Do not add another contributor's sign-off on their behalf.

The maintainer-owned history ending at `74ddb15` and `660bce7` predates adoption of this public DCO workflow and is explicitly grandfathered. The signed merge that unifies those histories and every commit after it remain subject to the check. Changing those fixed boundaries requires maintainer review as a governance change.

## Security and privacy

Do not submit credentials, private repository contents, raw model reasoning, or customer telemetry. Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
