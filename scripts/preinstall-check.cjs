#!/usr/bin/env node

const [majorRaw, minorRaw] = process.versions.node.split(".");
const major = Number.parseInt(majorRaw ?? "0", 10);
const minor = Number.parseInt(minorRaw ?? "0", 10);
const supported = !Number.isNaN(major) && !Number.isNaN(minor) && major < 26 && (major > 20 || (major === 20 && minor >= 19));

if (!supported) {
  console.error("");
  console.error("Kairn private beta requires Node 20.19 or newer, below Node 26.");
  console.error(`Current Node version: ${process.version}`);
  console.error("");
  console.error("Recommended fix with nvm:");
  console.error("  nvm install 24");
  console.error("  nvm use 24");
  console.error("  npm install -g ./kairn-0.1.4.tgz");
  console.error("");
  console.error("Node 22 or 24 LTS is the recommended beta path.");
  console.error("");
  process.exit(1);
}
