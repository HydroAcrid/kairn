import path from "node:path";
import type { FileRecord, GraphEdgeRecord, ParsedFile, RepoGraph } from "../types.js";
import { resolveImportCandidates } from "../retrieval/readSource.js";
import { budgetGraphEdges } from "./budget.js";

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
    edges: budgetGraphEdges({ edges: [...edgeMap.values()], files: input.files })
  };
}

export function graphEdgesForFile(edges: GraphEdgeRecord[], target: string): GraphEdgeRecord[] {
  return edges.filter((edge) => edge.fromFile === target || edge.toFile === target);
}

function addTestEdges(edgeMap: Map<string, GraphEdgeRecord>, rootPath: string, files: FileRecord[]): void {
  const sourceFiles = files.filter((file) => file.kind !== "test");
  const testFiles = files.filter((file) => file.kind === "test");
  const sourceByBase = new Map<string, FileRecord[]>();
  const sourceByDirectory = new Map<string, FileRecord[]>();

  for (const source of sourceFiles) {
    const sourceBase = baseNameWithoutExtension(source.path);
    sourceByBase.set(sourceBase, [...(sourceByBase.get(sourceBase) ?? []), source]);
    const directory = path.posix.dirname(source.path);
    sourceByDirectory.set(directory, [...(sourceByDirectory.get(directory) ?? []), source]);
  }

  for (const test of testFiles) {
    const candidates = candidateSourcesForTest(test, sourceByBase, sourceByDirectory);

    for (const source of candidates) {
      addEdge(edgeMap, {
        rootPath,
        fromFile: test.path,
        toFile: source.path,
        type: "test_for",
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
  const normalizedTest = testPath.toLowerCase();
  const normalizedSource = sourcePath.toLowerCase();

  return (
    testBase.includes(sourceBase) ||
    testPath.toLowerCase().includes(sourceBase) ||
    testDirectory === sourceDirectory ||
    testDirectory.endsWith("__tests__") && path.posix.dirname(testDirectory) === sourceDirectory ||
    testDirectory.endsWith("/tests") && normalizedTest.includes(sourceBase) ||
    normalizedTest.includes("/src/test/java/") && normalizedSource.includes("/src/main/java/") && testBase.includes(sourceBase)
  );
}

function candidateSourcesForTest(
  test: FileRecord,
  sourceByBase: Map<string, FileRecord[]>,
  sourceByDirectory: Map<string, FileRecord[]>
): FileRecord[] {
  const testDirectory = path.posix.dirname(test.path);
  const mappedDirectory = sourceDirectoryForTestDirectory(testDirectory);
  const testBase = baseNameWithoutExtension(test.path)
    .replace(/(^test[-_.])|([-_.]test$)|([-_.]spec$)|(^test_)/g, "")
    .replace(/test$/i, "")
    .toLowerCase();
  const candidates = new Map<string, FileRecord>();

  for (const source of sourceByBase.get(testBase) ?? []) {
    candidates.set(source.path, source);
  }

  for (const source of sourceByDirectory.get(mappedDirectory) ?? []) {
    if (isLikelyTestFor(test.path, source.path)) {
      candidates.set(source.path, source);
    }
  }

  for (const source of sourceByDirectory.get(testDirectory) ?? []) {
    if (isLikelyTestFor(test.path, source.path)) {
      candidates.set(source.path, source);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path))
    .slice(0, 12);
}

function sourceDirectoryForTestDirectory(testDirectory: string): string {
  if (testDirectory.endsWith("/__tests__")) return path.posix.dirname(testDirectory);
  if (testDirectory.endsWith("/tests")) return path.posix.dirname(testDirectory);
  if (testDirectory.includes("/src/test/java/")) {
    return testDirectory.replace("/src/test/java/", "/src/main/java/");
  }
  return testDirectory;
}

function baseNameWithoutExtension(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.(test|spec)?\.?[^.]+$/i, "").toLowerCase();
}

function isNextRouteFile(filePath: string): boolean {
  const base = path.posix.basename(filePath);
  return filePath.startsWith("app/") && ["page.tsx", "page.ts", "layout.tsx", "layout.ts"].includes(base);
}
