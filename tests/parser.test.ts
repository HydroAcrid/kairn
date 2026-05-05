import { describe, expect, it } from "vitest";
import { parseSourceFile } from "../src/parser/parseFile.js";

describe("parseSourceFile", () => {
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
});
