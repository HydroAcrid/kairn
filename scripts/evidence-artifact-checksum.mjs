// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const artifact = JSON.parse(input);
delete artifact.checksum;
process.stdout.write(createHash("sha256").update(stableStringify(artifact)).digest("hex"));

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
