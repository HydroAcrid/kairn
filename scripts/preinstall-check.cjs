#!/usr/bin/env node

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (Number.isNaN(major) || major < 20 || major >= 26) {
  console.error("");
  console.error("Kairn private beta requires Node 20 through 25.");
  console.error(`Current Node version: ${process.version}`);
  console.error("");
  console.error("Recommended fix with nvm:");
  console.error("  nvm install 22");
  console.error("  nvm use 22");
  console.error("  npm install -g ./kairn-0.1.0.tgz");
  console.error("");
  console.error("Node 20 or 22 LTS is still the recommended beta path.");
  console.error("");
  process.exit(1);
}
