import path from "node:path";
import type { FileRecord, GraphEdgeRecord, ParsedFile, RepoGraph } from "../types.js";
import { resolveImportCandidates } from "../retrieval/readSource.js";

export function buildRepoGraph(input: {
  rootPath: string;
  files: FileRecord[];
  parsedFiles: ParsedFile[];
}): RepoGraph {
  const fileByPath = new Map(input.files.map((file) => [file.path, file]));
  const edgeMap = new Map<string, GraphEdgeRecord>();

  for (const parsedFile of input.parsedFiles) {
    for (const specifier of parsedFile.imports) {
      for (const candidate of resolveImportCandidates(parsedFile.filePath, specifier)) {
        if (!fileByPath.has(candidate)) continue;

        addEdge(edgeMap, {
          rootPath: input.rootPath,
          fromFile: parsedFile.filePath,
          toFile: candidate,
          type: "imports",
          metadata: { specifier }
        });
        addEdge(edgeMap, {
          rootPath: input.rootPath,
          fromFile: candidate,
          toFile: parsedFile.filePath,
          type: "imported_by",
          metadata: { specifier }
        });
      }
    }
  }

  addTestEdges(edgeMap, input.rootPath, input.files);
  addParentRouteEdges(edgeMap, input.rootPath, input.files);

  return {
    rootPath: input.rootPath,
    files: input.files,
    parsedFiles: input.parsedFiles,
    symbols: input.parsedFiles.flatMap((file) => file.symbols),
    edges: [...edgeMap.values()].sort(
      (a, b) =>
        a.fromFile.localeCompare(b.fromFile) ||
        a.toFile.localeCompare(b.toFile) ||
        a.type.localeCompare(b.type)
    )
  };
}

export function graphEdgesForFile(edges: GraphEdgeRecord[], target: string): GraphEdgeRecord[] {
  return edges.filter((edge) => edge.fromFile === target || edge.toFile === target);
}

function addTestEdges(edgeMap: Map<string, GraphEdgeRecord>, rootPath: string, files: FileRecord[]): void {
  const sourceFiles = files.filter((file) => file.kind !== "test");
  const testFiles = files.filter((file) => file.kind === "test");

  for (const test of testFiles) {
    for (const source of sourceFiles) {
      if (!isLikelyTestFor(test.path, source.path)) continue;

      addEdge(edgeMap, {
        rootPath,
        fromFile: test.path,
        toFile: source.path,
        type: "test_for",
        metadata: { reason: "filename/path proximity" }
      });
      addEdge(edgeMap, {
        rootPath,
        fromFile: source.path,
        toFile: test.path,
        type: "tested_by",
        metadata: { reason: "filename/path proximity" }
      });
    }
  }
}

function addParentRouteEdges(edgeMap: Map<string, GraphEdgeRecord>, rootPath: string, files: FileRecord[]): void {
  const routes = files.filter((file) => isNextRouteFile(file.path));
  const filesByDirectory = new Map<string, FileRecord[]>();

  for (const file of files) {
    const directory = path.posix.dirname(file.path);
    filesByDirectory.set(directory, [...(filesByDirectory.get(directory) ?? []), file]);
  }

  for (const route of routes) {
    const directory = path.posix.dirname(route.path);
    for (const candidate of filesByDirectory.get(directory) ?? []) {
      if (candidate.path === route.path || candidate.kind === "test") continue;
      addEdge(edgeMap, {
        rootPath,
        fromFile: candidate.path,
        toFile: route.path,
        type: "parent_route",
        metadata: { reason: "same Next route segment" }
      });
    }
  }
}

function addEdge(edgeMap: Map<string, GraphEdgeRecord>, edge: GraphEdgeRecord): void {
  edgeMap.set(`${edge.fromFile}->${edge.toFile}:${edge.type}`, edge);
}

function isLikelyTestFor(testPath: string, sourcePath: string): boolean {
  const testDirectory = path.posix.dirname(testPath);
  const sourceDirectory = path.posix.dirname(sourcePath);
  const sourceBase = path.posix.basename(sourcePath).replace(/\.[^.]+$/, "").toLowerCase();
  const testBase = path.posix.basename(testPath).toLowerCase();

  return (
    testBase.includes(sourceBase) ||
    testPath.toLowerCase().includes(sourceBase) ||
    testDirectory === sourceDirectory ||
    testDirectory.endsWith("__tests__") && path.posix.dirname(testDirectory) === sourceDirectory
  );
}

function isNextRouteFile(filePath: string): boolean {
  const base = path.posix.basename(filePath);
  return filePath.startsWith("app/") && ["page.tsx", "page.ts", "layout.tsx", "layout.ts"].includes(base);
}
