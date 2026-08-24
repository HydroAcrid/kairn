// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "scripts", "benchmarks"];
const JAVASCRIPT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const PYTHON_EXTENSIONS = new Set([".py"]);
const fix = process.argv.includes("--fix");

const files = ROOTS.flatMap((root) => walk(path.resolve(root))).sort();
const missing = [];

for (const file of files) {
  const extension = path.extname(file);
  const marker = PYTHON_EXTENSIONS.has(extension)
    ? "# SPDX-License-Identifier: Apache-2.0"
    : "// SPDX-License-Identifier: Apache-2.0";
  const current = fs.readFileSync(file, "utf8");
  if (firstLogicalLines(current).includes(marker)) continue;
  missing.push(path.relative(process.cwd(), file).replace(/\\/g, "/"));
  if (fix) fs.writeFileSync(file, insertHeader(current, marker));
}

if (missing.length > 0 && !fix) {
  console.error(`Missing Apache-2.0 SPDX headers in ${missing.length} source/script file(s):`);
  for (const file of missing) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log(`${fix ? "Updated" : "Validated"} ${files.length} Apache-2.0 source/script header(s).`);
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__pycache__") found.push(...walk(target));
      continue;
    }
    const extension = path.extname(entry.name);
    if (entry.isFile() && (JAVASCRIPT_EXTENSIONS.has(extension) || PYTHON_EXTENSIONS.has(extension))) found.push(target);
  }
  return found;
}

function firstLogicalLines(value) {
  return value.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 3);
}

function insertHeader(value, marker) {
  const bom = value.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? value.slice(1) : value;
  if (body.startsWith("#!")) {
    const newline = body.indexOf("\n");
    if (newline < 0) return `${bom}${body}\n${marker}\n`;
    return `${bom}${body.slice(0, newline + 1)}${marker}\n${body.slice(newline + 1)}`;
  }
  return `${bom}${marker}\n\n${body}`;
}
