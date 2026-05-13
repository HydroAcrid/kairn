import type { FileRecord, IndexCompactionResult, IndexStateStats, InitResult } from "../../types.js";
import { ensureKairnDir } from "../../config/paths.js";
import { loadIndexingConfig } from "../../config/indexing.js";
import { captureIndexFreshnessMetadata, evaluateIndexFreshness } from "../../indexer/freshness.js";
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
    this.deps.store.upsertIndexMetadata(captureIndexFreshnessMetadata({
      rootPath: this.deps.rootPath,
      fileCount: index.graph.files.length
    }));
    const stats = this.ensureStateWithinHardLimit(this.deps.rootPath);

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
      },
      state: stats
    };
  }

  async refreshIndex(rootPath: string, input?: { force?: boolean | undefined }): Promise<FileRecord[]> {
    const existing = this.deps.store.listFiles(rootPath);
    const freshness = evaluateIndexFreshness({
      rootPath,
      stored: this.deps.store.getIndexMetadata(rootPath)
    });
    if (!input?.force && existing.length > 0 && !freshness.stale) {
      return existing;
    }
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
    this.deps.store.upsertIndexMetadata(captureIndexFreshnessMetadata({
      rootPath,
      fileCount: index.graph.files.length
    }));
    this.ensureStateWithinHardLimit(rootPath);
    return index.graph.files;
  }

  getStatus(rootPath = this.deps.rootPath): IndexStateStats {
    const stats = this.deps.store.getIndexStateStats(rootPath, loadIndexingConfig(rootPath));
    return {
      ...stats,
      freshness: evaluateIndexFreshness({
        rootPath,
        stored: this.deps.store.getIndexMetadata(rootPath)
      })
    };
  }

  compact(rootPath = this.deps.rootPath): IndexCompactionResult {
    return this.deps.store.compactIndex(rootPath, loadIndexingConfig(rootPath));
  }

  private ensureStateWithinHardLimit(rootPath: string): IndexStateStats {
    const config = loadIndexingConfig(rootPath);
    let stats = this.deps.store.getIndexStateStats(rootPath, config);
    if (stats.totalSizeBytes > stats.maxStateBytes) {
      this.deps.store.compactIndex(rootPath, config);
      stats = this.deps.store.getIndexStateStats(rootPath, config);
    }
    if (stats.totalSizeBytes > stats.hardMaxStateBytes) {
      throw new Error(
        `Kairn index state exceeded hard limit (${formatBytes(stats.totalSizeBytes)} > ${formatBytes(stats.hardMaxStateBytes)}). Run kairn index compact --root ${rootPath} or reduce indexing limits.`
      );
    }
    return stats;
  }
}

function formatBytes(value: number): string {
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}
