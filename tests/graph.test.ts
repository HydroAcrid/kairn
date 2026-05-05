import { describe, expect, it } from "vitest";
import { buildRepoGraph } from "../src/graph/buildGraph.js";
import { parseSourceFile } from "../src/parser/parseFile.js";
import type { FileRecord } from "../src/types.js";

describe("buildRepoGraph", () => {
  it("builds import, reverse import, test, index, and parent route edges", () => {
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
    const parsedFiles = files.map((record) =>
      parseSourceFile({
        rootPath,
        filePath: record.path,
        language: record.language,
        content: sources.get(record.path) ?? ""
      })
    );

    const graph = buildRepoGraph({ rootPath, files, parsedFiles });

    expect(edgeTypes(graph.edges, "src/app.ts", "src/user/index.ts")).toContain("imports");
    expect(edgeTypes(graph.edges, "src/user/index.ts", "src/app.ts")).toContain("imported_by");
    expect(edgeTypes(graph.edges, "src/app.test.ts", "src/app.ts")).toContain("test_for");
    expect(edgeTypes(graph.edges, "src/app.ts", "src/app.test.ts")).toContain("tested_by");
    expect(edgeTypes(graph.edges, "app/dashboard/DashboardCard.tsx", "app/dashboard/page.tsx")).toContain(
      "parent_route"
    );
  });
});

function file(rootPath: string, filePath: string, kind: FileRecord["kind"]): FileRecord {
  return {
    rootPath,
    path: filePath,
    language: filePath.endsWith(".tsx") ? "typescript" : "typescript",
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
