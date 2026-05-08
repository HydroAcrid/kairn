import type { FileRecord, InitResult } from "../../types.js";
import { ensureKairnDir } from "../../config/paths.js";
import { indexRepo } from "../../indexer/indexRepo.js";
import type { RuntimeDeps } from "../deps.js";

export class IndexService {
  constructor(private readonly deps: RuntimeDeps) {}

  async init(): Promise<InitResult> {
    const paths = ensureKairnDir(this.deps.rootPath);
    const index = await indexRepo(this.deps.rootPath);
    this.deps.store.replaceIndex({
      rootPath: this.deps.rootPath,
      files: index.graph.files,
      symbols: index.graph.symbols,
      edges: index.graph.edges,
      semanticChunks: index.semanticChunks,
      semanticVectors: index.semanticVectors,
      lexicalDocuments: index.lexical.documents,
      lexicalTerms: index.lexical.terms,
      lexicalStats: index.lexical.stats
    });

    return {
      rootPath: paths.rootPath,
      kairnDir: paths.kairnDir,
      configPath: paths.configPath,
      databasePath: paths.databasePath,
      scan: index.scan,
      graph: index.graph,
      semantic: {
        chunks: index.semanticChunks.length,
        vectors: index.semanticVectors.length
      }
    };
  }

  async refreshIndex(rootPath: string): Promise<FileRecord[]> {
    const index = await indexRepo(rootPath);
    this.deps.store.replaceIndex({
      rootPath,
      files: index.graph.files,
      symbols: index.graph.symbols,
      edges: index.graph.edges,
      semanticChunks: index.semanticChunks,
      semanticVectors: index.semanticVectors,
      lexicalDocuments: index.lexical.documents,
      lexicalTerms: index.lexical.terms,
      lexicalStats: index.lexical.stats
    });
    return index.graph.files;
  }
}
