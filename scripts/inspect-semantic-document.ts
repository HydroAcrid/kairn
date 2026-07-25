// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { parseSourceFile } from "../src/parser/parseFile.js";
import { scanRepo } from "../src/scanner/scanRepo.js";
import { buildSemanticDocuments } from "../src/semantic/documents.js";

const [rootArgument, fileArgument] = process.argv.slice(2);
if (!rootArgument || !fileArgument) {
  throw new Error("usage: pnpm tsx scripts/inspect-semantic-document.ts <repository> <relative-file>");
}

const rootPath = path.resolve(rootArgument);
const filePath = fileArgument.replaceAll("\\", "/");
const scan = await scanRepo(rootPath);
const file = scan.files.find((candidate) => candidate.path === filePath);
if (!file) throw new Error(`File is not present in the repository inventory: ${filePath}`);

const content = fs.readFileSync(path.join(rootPath, filePath), "utf8");
const parsed = await parseSourceFile({
  rootPath,
  filePath,
  language: file.language,
  content
});
const documents = buildSemanticDocuments({
  rootPath,
  graph: {
    rootPath,
    files: [file],
    parsedFiles: [parsed],
    symbols: parsed.symbols,
    edges: []
  },
  maxDocuments: 7_500
});

process.stdout.write(`${JSON.stringify({
  file: {
    path: file.path,
    kind: file.kind,
    language: file.language,
    indexTier: file.indexTier
  },
  parser: {
    hasErrors: parsed.hasErrors,
    symbols: parsed.symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.startLine,
      endLine: symbol.endLine
    })),
    imports: parsed.imports,
    references: parsed.references,
    calls: parsed.calls,
    dynamicImports: parsed.dynamicImports,
    moduleInstallers: parsed.moduleInstallers
  },
  documents: documents.map((document) => ({
    id: document.id,
    kind: document.kind,
    symbol: document.symbol,
    text: document.text
  }))
}, null, 2)}\n`);
