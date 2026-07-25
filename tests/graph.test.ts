import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRepoGraph } from "../src/graph/buildGraph.js";
import { indexRepo } from "../src/indexer/indexRepo.js";
import { parseSourceFile } from "../src/parser/parseFile.js";
import type { FileRecord } from "../src/types.js";
import { createFixtureRepo } from "./helpers.js";

describe("buildRepoGraph", () => {
  it("builds direct import, direct test, index, and parent route edges", async () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/app.ts", "source"),
      file(rootPath, "src/user/index.ts", "source"),
      file(rootPath, "src/app.test.ts", "test"),
      file(rootPath, "app/dashboard/page.tsx", "route"),
      file(rootPath, "app/dashboard/DashboardCard.tsx", "component")
    ];
    const sources = new Map([
      ["src/app.ts", "import { formatUser } from './user';\nexport function renderDashboard() { return formatUser('Kevin'); }"],
      ["src/user/index.ts", "export function formatUser(name: string) { return name; }"],
      ["src/app.test.ts", "import { renderDashboard } from './app';\ntest('renderDashboard', () => {});"],
      ["app/dashboard/page.tsx", "import { DashboardCard } from './DashboardCard';\nexport default function Page() { return <DashboardCard />; }"],
      ["app/dashboard/DashboardCard.tsx", "export const DashboardCard = () => <section />;"]
    ]);
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({ rootPath, files, parsedFiles });

    expect(edgeTypes(graph.edges, "src/app.ts", "src/user/index.ts")).toContain("imports");
    expect(edgeTypes(graph.edges, "src/app.test.ts", "src/app.ts")).toContain("test_for");
    expect(edgeTypes(graph.edges, "app/dashboard/DashboardCard.tsx", "app/dashboard/page.tsx")).toContain(
      "parent_route"
    );
  });

  it("does not create test edges by comparing every source to every test", async () => {
    const rootPath = "/repo";
    const files = [
      ...Array.from({ length: 200 }, (_, index) => file(rootPath, `src/module-${index}.ts`, "source")),
      file(rootPath, "src/local-url.ts", "source"),
      file(rootPath, "src/local-url.test.ts", "test")
    ];
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: record.kind === "test" ? "import './local-url';\ntest('local url', () => {});" : `export const value${record.path.length} = 1;`
      })
    ));

    const graph = buildRepoGraph({ rootPath, files, parsedFiles });
    const testEdges = graph.edges.filter((edge) => edge.type === "test_for");

    expect(testEdges).toHaveLength(1);
    expect(testEdges[0]).toEqual(expect.objectContaining({
      fromFile: "src/local-url.test.ts",
      toFile: "src/local-url.ts",
      metadata: expect.objectContaining({ reason: "exact test/source basename" })
    }));
    expect(edgeTypes(graph.edges, "src/local-url.test.ts", "src/local-url.ts")).toContain("imports");
  });

  it("does not turn a shared directory or partial basename into a test/source relationship", async () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "pkg/session.go", "source"),
      file(rootPath, "pkg/session_refresh_deferred_test.go", "test")
    ];
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: record.kind === "test"
          ? "package pkg\n\nfunc TestRefreshDeferred(t *testing.T) {}"
          : "package pkg\n\nfunc RunSession() {}"
      })
    ));

    const graph = buildRepoGraph({ rootPath, files, parsedFiles });

    expect(edgeTypes(graph.edges, files[1]!.path, files[0]!.path)).not.toContain("test_for");
  });

  it("adds TypeScript language-service reference edges without replacing tree-sitter edges", async () => {
    const root = createFixtureRepo();
    const index = await indexRepo(root);

    expect(edgeTypes(index.graph.edges, "src/user.ts", "src/app.ts")).toContain("reference");
    expect(edgeTypes(index.graph.edges, "src/app.ts", "src/user.ts")).toContain("imports");
  });

  it("links Go module imports and test symbols to direct production sources", async () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "cmd/server/main.go", "source"),
      file(rootPath, "internal/store/store.go", "source"),
      file(rootPath, "internal/store/behavior_test.go", "test")
    ];
    const sources = new Map([
      [
        "cmd/server/main.go",
        'package main\nimport "example.com/acme/project/internal/store"\nfunc main() { _ = store.Store{} }\n'
      ],
      [
        "internal/store/store.go",
        "package store\ntype Store struct{}\nfunc (s *Store) Save() error { return nil }\n"
      ],
      [
        "internal/store/behavior_test.go",
        "package store\nfunc TestSave() {}\n"
      ]
    ]);
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({
      rootPath,
      files,
      parsedFiles,
      goModules: [{ directory: ".", modulePath: "example.com/acme/project" }]
    });

    expect(edgeTypes(graph.edges, "cmd/server/main.go", "internal/store/store.go")).toContain("imports");
    expect(edgeTypes(graph.edges, "internal/store/behavior_test.go", "internal/store/store.go")).toContain("test_for");
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        fromFile: "internal/store/behavior_test.go",
        toFile: "internal/store/store.go",
        type: "test_for",
        metadata: expect.objectContaining({
          reason: "Go test symbol matches source symbol",
          testSymbol: "TestSave",
          sourceSymbol: "Save"
        })
      })
    );
  });

  it("links sibling adapter modules that implement the same callable surface", async () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/storage/memory/main.js", "source"),
      file(rootPath, "src/storage/postgres/main.js", "source"),
      file(rootPath, "src/storage/redis/main.js", "source"),
      file(rootPath, "src/other/main.js", "source")
    ];
    const adapter = (owner: string) => [
      `const ${owner} = module.exports;`,
      `${owner}.read = async function (key) { return key; };`,
      `${owner}.write = async function (key, value) { return value; };`,
      `${owner}.remove = async function (key) { return key; };`
    ].join("\n");
    const sources = new Map([
      ["src/storage/memory/main.js", adapter("memory")],
      ["src/storage/postgres/main.js", adapter("postgres")],
      ["src/storage/redis/main.js", adapter("redis")],
      ["src/other/main.js", "export function unrelated() { return true; }"]
    ]);
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({ rootPath, files, parsedFiles });

    expect(edgeTypes(
      graph.edges,
      "src/storage/memory/main.js",
      "src/storage/postgres/main.js"
    )).toContain("implementation");
    expect(edgeTypes(
      graph.edges,
      "src/storage/memory/main.js",
      "src/storage/redis/main.js"
    )).toContain("implementation");
    expect(graph.edges.some((edge) =>
      edge.type === "implementation" && edge.toFile === "src/other/main.js"
    )).toBe(false);
  });

  it("links parser-observed local type references to unique declarations", async () => {
    const rootPath = "/repo";
    const javaFiles: FileRecord[] = [
      {
        ...file(rootPath, "src/main/java/org/example/TypeExtractor.java", "source"),
        language: "java"
      },
      {
        ...file(rootPath, "src/main/java/org/example/ResolverFacade.java", "source"),
        language: "java"
      }
    ];
    const sources = new Map([
      [
        javaFiles[0]!.path,
        "package org.example;\npublic class TypeExtractor {}\n"
      ],
      [
        javaFiles[1]!.path,
        "package org.example;\npublic class ResolverFacade { TypeExtractor extractor; }\n"
      ]
    ]);
    const parsedFiles = await Promise.all(javaFiles.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({ rootPath, files: javaFiles, parsedFiles });

    expect(edgeTypes(
      graph.edges,
      "src/main/java/org/example/ResolverFacade.java",
      "src/main/java/org/example/TypeExtractor.java"
    )).toContain("type_reference");
  });

  it("prefers one production declaration over duplicate test-fixture declarations", async () => {
    const rootPath = "/repo";
    const productionPath = "src/main/java/org/example/TypeExtractor.java";
    const fixturePath = "src/test/test_sourcecode/legacy/src/main/java/org/example/TypeExtractor.java";
    const facadePath = "src/main/java/org/example/ResolverFacade.java";
    const javaFiles: FileRecord[] = [
      { ...file(rootPath, productionPath, "source"), language: "java" },
      { ...file(rootPath, fixturePath, "test"), language: "java" },
      { ...file(rootPath, facadePath, "source"), language: "java" }
    ];
    const sources = new Map([
      [productionPath, "package org.example;\npublic class TypeExtractor {}\n"],
      [fixturePath, "package org.example;\npublic class TypeExtractor {}\n"],
      [facadePath, "package org.example;\npublic class ResolverFacade { TypeExtractor extractor; }\n"]
    ]);
    const parsedFiles = await Promise.all(javaFiles.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({ rootPath, files: javaFiles, parsedFiles });

    expect(edgeTypes(graph.edges, facadePath, productionPath)).toContain("type_reference");
    expect(edgeTypes(graph.edges, facadePath, fixturePath)).not.toContain("type_reference");
  });

  it("links parser-observed Go qualified types to declarations in imported local packages", async () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "internal/configs/removed.go", "source"),
      file(rootPath, "internal/terraform/transform.go", "source")
    ];
    const sources = new Map([
      [
        "internal/configs/removed.go",
        "package configs\ntype Removed struct{}\n"
      ],
      [
        "internal/terraform/transform.go",
        [
          "package terraform",
          'import "example.com/project/internal/configs"',
          "type Attacher interface { Attach(*configs.Removed) }"
        ].join("\n")
      ]
    ]);
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({
      rootPath,
      files,
      parsedFiles,
      goModules: [{ directory: ".", modulePath: "example.com/project" }]
    });

    expect(edgeTypes(
      graph.edges,
      "internal/terraform/transform.go",
      "internal/configs/removed.go"
    )).toContain("type_reference");
    expect(parsedFiles.find((parsed) => parsed.filePath.endsWith("transform.go"))?.references)
      .toContain("configs.Removed");
  });

  it("links bounded families of files that call the same unique local function", async () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "internal/runtime/marks.go", "source"),
      file(rootPath, "internal/runtime/marks_test.go", "test"),
      file(rootPath, "internal/runtime/plan.go", "source"),
      file(rootPath, "internal/runtime/apply.go", "source")
    ];
    const sources = new Map([
      [
        "internal/runtime/marks.go",
        "package runtime\nfunc dedupePathMarks() {}\n"
      ],
      [
        "internal/runtime/marks_test.go",
        "package runtime\nfunc TestMarks() { dedupePathMarks() }\n"
      ],
      [
        "internal/runtime/plan.go",
        "package runtime\nfunc plan() { dedupePathMarks() }\n"
      ],
      [
        "internal/runtime/apply.go",
        "package runtime\nfunc apply() { dedupePathMarks() }\n"
      ]
    ]);
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({ rootPath, files, parsedFiles });

    expect(parsedFiles.find((parsed) => parsed.filePath.endsWith("marks_test.go"))?.calls)
      .toContain("dedupePathMarks");
    expect(edgeTypes(
      graph.edges,
      "internal/runtime/marks_test.go",
      "internal/runtime/marks.go"
    )).toContain("call");
    expect(edgeTypes(
      graph.edges,
      "internal/runtime/marks_test.go",
      "internal/runtime/plan.go"
    )).toContain("shared_call_target");
    expect(edgeTypes(
      graph.edges,
      "internal/runtime/apply.go",
      "internal/runtime/marks_test.go"
    )).toContain("shared_call_target");
  });

  it("links dynamic module dispatchers to local implementations and their installers", async () => {
    const rootPath = "/repo";
    const files = [
      file(rootPath, "src/storage/index.js", "source"),
      file(rootPath, "src/storage/memory.js", "source"),
      file(rootPath, "src/storage/postgres.js", "source"),
      file(rootPath, "src/storage/memory/main.js", "source"),
      file(rootPath, "src/storage/postgres/main.js", "source"),
      file(rootPath, "src/features/index.js", "source"),
      file(rootPath, "src/features/remove.js", "source"),
      file(rootPath, "src/controllers/admin.js", "source")
    ];
    const sources = new Map([
      ["src/storage/index.js", "module.exports = require(`./${backend}`);"],
      [
        "src/storage/memory.js",
        "const adapter = module.exports;\nrequire('./memory/main')(adapter);"
      ],
      [
        "src/storage/postgres.js",
        "const adapter = module.exports;\nrequire('./postgres/main')(adapter);"
      ],
      ["src/storage/memory/main.js", "module.exports = function install(adapter) {};"],
      ["src/storage/postgres/main.js", "module.exports = function install(adapter) {};"],
      [
        "src/features/index.js",
        "const features = module.exports;\nrequire('./remove')(features);"
      ],
      ["src/features/remove.js", "module.exports = function install(features) {};"],
      ["src/controllers/admin.js", "const features = require('../features');"]
    ]);
    const parsedFiles = await Promise.all(files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    ));

    const graph = buildRepoGraph({ rootPath, files, parsedFiles });

    expect(edgeTypes(
      graph.edges,
      "src/storage/index.js",
      "src/storage/memory.js"
    )).toContain("module_installation");
    expect(edgeTypes(
      graph.edges,
      "src/storage/index.js",
      "src/storage/memory/main.js"
    )).toContain("module_installation");
    expect(edgeTypes(
      graph.edges,
      "src/storage/index.js",
      "src/storage/postgres/main.js"
    )).toContain("module_installation");
    expect(edgeTypes(
      graph.edges,
      "src/features/index.js",
      "src/features/remove.js"
    )).toContain("module_installation");
    expect(edgeTypes(
      graph.edges,
      "src/controllers/admin.js",
      "src/features/remove.js"
    )).toContain("module_installation");
  });

  it("falls back gracefully when tsconfig is broken", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kairn-broken-tsconfig-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{ not valid json");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const value = 1;\n");

    const index = await indexRepo(root);

    expect(index.graph.files.map((fileRecord) => fileRecord.path)).toContain("src/a.ts");
    expect(index.graph.symbols.map((symbol) => symbol.name)).toContain("value");
  });
});

function file(rootPath: string, filePath: string, kind: FileRecord["kind"]): FileRecord {
  return {
    rootPath,
    path: filePath,
    language: filePath.endsWith(".go") ? "go" : "typescript",
    kind,
    size: 10,
    hash: filePath,
    importance: 5,
    updatedAt: "2026-05-05T00:00:00.000Z"
  };
}

function edgeTypes(edges: { fromFile: string; toFile: string; type: string }[], fromFile: string, toFile: string) {
  return edges.filter((edge) => edge.fromFile === fromFile && edge.toFile === toFile).map((edge) => edge.type);
}
