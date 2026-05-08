import { describe, expect, it } from "vitest";
import { indexRepo } from "../src/indexer/indexRepo.js";
import { compactParsedSymbols } from "../src/indexer/symbolCompaction.js";
import { parseSourceFile } from "../src/parser/parseFile.js";
import { classifyFile, detectLanguage } from "../src/scanner/classifyFile.js";
import type { FileRecord, ParsedFile, SymbolRecord } from "../src/types.js";
import { createFixtureRepo } from "./helpers.js";
import fs from "node:fs";
import path from "node:path";

describe("cross-language parser adapters", () => {
  it("extracts TypeScript symbols and imports", () => {
    const parsed = parseSourceFile({
      rootPath: "/repo",
      filePath: "src/example.ts",
      language: "typescript",
      content: [
        "import { helper } from './helper';",
        "export function runTask() { return helper(); }",
        "export class Runner {}",
        "export interface RunnerProps { name: string }",
        "export type RunnerMode = 'fast';",
        "export const RunnerValue = 1;",
        "export default function DefaultRunner() { return null; }"
      ].join("\n")
    });

    expect(parsed.imports).toEqual(["./helper"]);
    expect(parsed.symbols.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.exported}`)).toEqual(
      expect.arrayContaining([
        "function:runTask:true",
        "class:Runner:true",
        "interface:RunnerProps:true",
        "type:RunnerMode:true",
        "const:RunnerValue:true",
        "function:DefaultRunner:true"
      ])
    );
  });

  it("extracts TSX component symbols", () => {
    const parsed = parseSourceFile({
      rootPath: "/repo",
      filePath: "src/DashboardCard.tsx",
      language: "typescript",
      content: [
        "import React from 'react';",
        "export const DashboardCard = () => <section />;",
        "const helperValue = 1;"
      ].join("\n")
    });

    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "DashboardCard",
          kind: "component",
          exported: true
        }),
        expect.objectContaining({
          name: "helperValue",
          kind: "const",
          exported: false
        })
      ])
    );
  });

  it("marks broken supported files without throwing", () => {
    const parsed = parseSourceFile({
      rootPath: "/repo",
      filePath: "src/broken.ts",
      language: "typescript",
      content: "export function broken( {"
    });

    expect(parsed.hasErrors).toBe(true);
  });

  it("skips unsupported file types", () => {
    const parsed = parseSourceFile({
      rootPath: "/repo",
      filePath: "README.md",
      language: "markdown",
      content: "# Kairn"
    });

    expect(parsed.symbols).toEqual([]);
    expect(parsed.imports).toEqual([]);
    expect(parsed.hasErrors).toBe(false);
  });

  it("extracts Python functions, classes, async functions, and imports", () => {
    const parsed = parseSourceFile({
      rootPath: "/repo",
      filePath: "click/utils.py",
      language: "python",
      content: [
        "import os",
        "from click.termui import echo",
        "",
        "class LazyFile:",
        "    def close(self):",
        "        return None",
        "",
        "async def async_echo():",
        "    return echo",
        "",
        "def term_len(value):",
        "    return len(value)",
        ""
      ].join("\n")
    });

    expect(parsed.imports).toEqual(expect.arrayContaining(["os", "click.termui"]));
    expect(parsed.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`)).toEqual(
      expect.arrayContaining(["LazyFile:class", "close:function", "async_echo:function", "term_len:function"])
    );
  });

  it("extracts Java packages, imports, classes, interfaces, enums, methods, and constructors", () => {
    const parsed = parseSourceFile({
      rootPath: "/repo",
      filePath: "src/main/java/org/apache/commons/lang3/StringUtils.java",
      language: "java",
      content: [
        "package org.apache.commons.lang3;",
        "import java.util.List;",
        "",
        "public class StringUtils {",
        "  public StringUtils() {}",
        "  public static boolean isBlank(final CharSequence cs) { return true; }",
        "}",
        "interface CharSequenceUtils {}",
        "enum BlankState { BLANK }",
        ""
      ].join("\n")
    });

    expect(parsed.imports).toEqual(expect.arrayContaining(["package:org.apache.commons.lang3", "java.util.List"]));
    expect(parsed.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`)).toEqual(
      expect.arrayContaining([
        "StringUtils:class",
        "StringUtils:function",
        "isBlank:function",
        "CharSequenceUtils:interface",
        "BlankState:type"
      ])
    );
  });

  it("extracts C and C++ includes, namespaces, classes, structs, and functions", () => {
    const cpp = parseSourceFile({
      rootPath: "/repo",
      filePath: "include/fmt/base.h",
      language: "cpp",
      content: [
        "#include <string>",
        "#include \"fmt/format.h\"",
        "namespace fmt {",
        "class basic_string_view {",
        " public:",
        "  bool starts_with(string_view other) const { return true; }",
        "};",
        "struct format_context {};",
        "bool starts_with(int value) { return value > 0; }",
        "}",
        ""
      ].join("\n")
    });
    const c = parseSourceFile({
      rootPath: "/repo",
      filePath: "src/core.c",
      language: "c",
      content: [
        "#include \"core.h\"",
        "struct buffer { int len; };",
        "int starts_with(int value) { return value; }",
        ""
      ].join("\n")
    });

    expect(cpp.imports).toEqual(expect.arrayContaining(["string", "fmt/format.h"]));
    expect(cpp.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`)).toEqual(
      expect.arrayContaining([
        "fmt:type",
        "basic_string_view:class",
        "format_context:class",
        "starts_with:function"
      ])
    );
    expect(c.imports).toContain("core.h");
    expect(c.symbols.map((symbol) => `${symbol.name}:${symbol.kind}`)).toEqual(
      expect.arrayContaining(["buffer:class", "starts_with:function"])
    );
  });

  it("classifies Python, Java, and C++ source/test files", () => {
    expect(detectLanguage("click/utils.py")).toBe("python");
    expect(detectLanguage("src/main/java/org/example/App.java")).toBe("java");
    expect(detectLanguage("include/fmt/base.h")).toBe("cpp");
    expect(detectLanguage("src/core.cpp")).toBe("cpp");
    expect(classifyFile("tests/test_utils.py")).toBe("test");
    expect(classifyFile("src/test/java/org/example/StringUtilsTest.java")).toBe("test");
    expect(classifyFile("test/base_test.cc")).toBe("test");
    expect(classifyFile("src/main/java/org/example/StringUtils.java")).toBe("source");
  });

  it("indexes cross-language symbol chunks and graph test edges", async () => {
    const root = createFixtureRepo();
    write(root, "click/utils.py", "def term_len(value):\n    return len(value)\n");
    write(root, "tests/test_utils.py", "from click.utils import term_len\n\ndef test_term_len():\n    assert term_len('x') == 1\n");
    write(root, "src/main/java/org/example/StringUtils.java", "package org.example;\npublic class StringUtils { public static boolean isBlank(String value) { return true; } }\n");
    write(root, "src/test/java/org/example/StringUtilsTest.java", "package org.example;\nclass StringUtilsTest {}\n");
    write(root, "include/fmt/base.h", "namespace fmt { class basic_string_view { bool starts_with(string_view other) const { return true; } }; }\n");
    write(root, "test/base_test.cc", "#include \"fmt/base.h\"\nint main() { return 0; }\n");

    const index = await indexRepo(root);

    expect(index.semanticChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: "click/utils.py", kind: "symbol", symbol: "term_len" }),
        expect.objectContaining({ filePath: "src/main/java/org/example/StringUtils.java", kind: "symbol", symbol: "isBlank" }),
        expect.objectContaining({ filePath: "include/fmt/base.h", kind: "symbol", symbol: "starts_with" })
      ])
    );
    expect(index.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromFile: "tests/test_utils.py", toFile: "click/utils.py", type: "test_for" }),
        expect.objectContaining({
          fromFile: "src/test/java/org/example/StringUtilsTest.java",
          toFile: "src/main/java/org/example/StringUtils.java",
          type: "test_for"
        })
      ])
    );
  });

  it("compacts large-repo symbols by dropping low-value local variables while preserving structural symbols", () => {
    const rootPath = "/repo";
    const file = fileRecord(rootPath, "src/module.ts");
    const parsed: ParsedFile = {
      rootPath,
      filePath: file.path,
      language: "typescript",
      imports: [],
      hasErrors: false,
      symbols: [
        symbol(rootPath, file.path, "runTask", "function", false),
        symbol(rootPath, file.path, "ExportedValue", "const", true),
        symbol(rootPath, file.path, "LOCAL_LIMIT", "const", false),
        ...Array.from({ length: 180 }, (_, index) => symbol(rootPath, file.path, `localValue${index}`, "const", false))
      ]
    };

    const compacted = compactParsedSymbols({
      files: [file, ...Array.from({ length: 900 }, (_, index) => fileRecord(rootPath, `src/filler-${index}.ts`))],
      parsedFiles: [parsed]
    })[0]!;
    const names = compacted.symbols.map((item) => item.name);

    expect(names).toEqual(expect.arrayContaining(["runTask", "ExportedValue", "LOCAL_LIMIT"]));
    expect(names).not.toContain("localValue0");
    expect(compacted.symbols.length).toBeLessThanOrEqual(120);
  });
});

function fileRecord(rootPath: string, filePath: string): FileRecord {
  return {
    rootPath,
    path: filePath,
    language: "typescript",
    kind: "source",
    size: 100,
    hash: filePath,
    importance: 4,
    updatedAt: "2026-05-08T00:00:00.000Z"
  };
}

function symbol(
  rootPath: string,
  filePath: string,
  name: string,
  kind: SymbolRecord["kind"],
  exported: boolean
): SymbolRecord {
  return {
    rootPath,
    filePath,
    name,
    kind,
    exported,
    startLine: 1,
    endLine: 1,
    signature: `${exported ? "export " : ""}${kind} ${name}`
  };
}

function write(root: string, filePath: string, content: string): void {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}
