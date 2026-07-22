#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

const [baseSha, headSha] = process.argv.slice(2);
if (!isSha(baseSha) || !isSha(headSha)) {
  process.stderr.write("Usage: node scripts/check-dco.mjs <base-sha> <head-sha>\n");
  process.exit(2);
}

const commits = git(["rev-list", "--reverse", `${baseSha}..${headSha}`])
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean);
const failures = [];

for (const commit of commits) {
  const [authorName, authorEmail, committerName, committerEmail, ...bodyParts] = git([
    "show",
    "-s",
    "--format=%an%x00%ae%x00%cn%x00%ce%x00%B",
    commit,
  ]).split("\0");
  const body = bodyParts.join("\0");
  const signoffs = [...body.matchAll(/^Signed-off-by:\s*(.+?)\s*<([^<>\s]+)>\s*$/gimu)];
  const contributorEmails = new Set([authorEmail, committerEmail].map((value) => value?.trim().toLowerCase()));
  if (!signoffs.some((match) => contributorEmails.has(match[2].toLowerCase()))) {
    failures.push({ commit, authorName, authorEmail, committerName, committerEmail });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(
      `${failure.commit.slice(0, 12)} is missing a valid Signed-off-by trailer matching `
      + `${failure.authorName} <${failure.authorEmail}> or ${failure.committerName} <${failure.committerEmail}>.\n`,
    );
  }
  process.stderr.write("Add the trailer with `git commit --amend -s` and update the pull-request branch.\n");
  process.exit(1);
}

process.stdout.write(`DCO sign-off verified for ${commits.length} commit${commits.length === 1 ? "" : "s"}.\n`);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trimEnd();
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/iu.test(value);
}
