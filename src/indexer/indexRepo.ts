import { buildRepoGraph } from "../graph/buildGraph.js";
import { parseSourceFile } from "../parser/parseFile.js";
import { readTextFile } from "../retrieval/readSource.js";
import { scanRepo } from "../scanner/scanRepo.js";
import type { RepoGraph, ScanResult } from "../types.js";

export type RepoIndex = {
  scan: ScanResult;
  graph: RepoGraph;
};

export async function indexRepo(rootPath: string): Promise<RepoIndex> {
  const scan = await scanRepo(rootPath);
  const parsedFiles = scan.files.map((file) => {
    try {
      return parseSourceFile({
        rootPath,
        filePath: file.path,
        content: readTextFile(rootPath, file.path),
        language: file.language
      });
    } catch {
      return {
        rootPath,
        filePath: file.path,
        language: file.language,
        symbols: [],
        imports: [],
        hasErrors: true
      };
    }
  });
  const graph = buildRepoGraph({
    rootPath,
    files: scan.files,
    parsedFiles
  });

  return {
    scan,
    graph
  };
}
