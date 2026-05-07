import Database from "better-sqlite3";
import type {
  BenchmarkCaseMode,
  BenchmarkResultRecord,
  BenchmarkRunMode,
  BenchmarkRunRecord,
  BenchmarkRunStatus,
  BenchmarkTaskOutcome,
  CommandRecord,
  ContextShownRecord,
  DiffRecord,
  EvalObservationRecord,
  EvalRunMode,
  EvalRunRecord,
  EvalRunStatus,
  FileRecord,
  GraphEdgeRecord,
  HostSessionLinkRecord,
  MetricsEventRecord,
  SemanticChunkRecord,
  SemanticVectorRecord,
  SessionStatus,
  SymbolRecord,
  TaskSession,
  WatchEventRecord,
  WatchEventSource
} from "../types.js";
import { deserializeVector, serializeVector } from "../semantic/vector.js";
import { nowIso } from "../utils/time.js";

type SessionRow = {
  id: string;
  root_path: string;
  task: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  risks_json: string;
  verification_hints_json: string;
};

type FileRow = {
  root_path: string;
  path: string;
  language: string;
  kind: FileRecord["kind"];
  size: number;
  hash: string;
  importance: number;
  updated_at: string;
};

type SymbolRow = {
  root_path: string;
  file_path: string;
  name: string;
  kind: SymbolRecord["kind"];
  exported: 0 | 1;
  start_line: number;
  end_line: number;
  signature: string;
};

type GraphEdgeRow = {
  root_path: string;
  from_file: string;
  to_file: string;
  type: GraphEdgeRecord["type"];
  metadata_json: string;
};

type SemanticChunkRow = {
  root_path: string;
  id: string;
  file_path: string;
  kind: SemanticChunkRecord["kind"];
  symbol: string | null;
  start_line: number | null;
  end_line: number | null;
  text: string;
  hash: string;
  token_estimate: number;
};

type SemanticVectorRow = {
  root_path: string;
  chunk_id: string;
  dimensions: number;
  vector_json: string;
};

type ContextShownRow = {
  id: number;
  session_id: string;
  kind: ContextShownRecord["kind"];
  file_path: string | null;
  symbol: string | null;
  mode: ContextShownRecord["mode"];
  content_hash: string;
  created_at: string;
};

type CommandRow = {
  id: number;
  session_id: string;
  type: CommandRecord["type"];
  summary: string;
  created_at: string;
};

type DiffRow = {
  id: number;
  session_id: string;
  files_json: string;
  summary: string;
  created_at: string;
};

type WatchEventRow = {
  id: number;
  session_id: string;
  source: WatchEventRecord["source"];
  kind: WatchEventRecord["kind"];
  event_name: string;
  tool_name: string | null;
  command: string | null;
  files_json: string;
  exit_code: number | null;
  summary: string;
  content_hash: string;
  metadata_json: string;
  created_at: string;
};

type HostSessionLinkRow = {
  source: WatchEventSource;
  root_path: string;
  host_session_id: string;
  session_id: string;
  first_seen_at: string;
  last_seen_at: string;
  metadata_json: string;
};

type MetricsEventRow = {
  id: number;
  session_id: string;
  root_path: string;
  event_kind: MetricsEventRecord["eventKind"];
  event_name: string;
  source: MetricsEventRecord["source"];
  response_mode: MetricsEventRecord["responseMode"] | null;
  baseline_tokens: number;
  output_tokens: number;
  saved_tokens: number;
  files_json: string;
  metadata_json: string;
  created_at: string;
};

type EvalRunRow = {
  id: string;
  session_id: string | null;
  root_path: string;
  task: string;
  label: string;
  mode: EvalRunMode;
  status: EvalRunStatus;
  started_at: string;
  ended_at: string | null;
  metadata_json: string;
};

type EvalObservationRow = {
  id: number;
  run_id: string;
  session_id: string | null;
  kind: EvalObservationRecord["kind"];
  summary: string;
  metrics_json: string;
  files_json: string;
  content_hash: string;
  created_at: string;
};

type BenchmarkRunRow = {
  id: string;
  root_path: string;
  suite_id: string;
  suite_name: string;
  mode: BenchmarkRunMode;
  status: BenchmarkRunStatus;
  started_at: string;
  ended_at: string | null;
  metadata_json: string;
};

type BenchmarkResultRow = {
  id: number;
  run_id: string;
  case_id: string;
  case_mode: BenchmarkCaseMode;
  score: number;
  expected_file_recall: number;
  top_k_hit_rate: number;
  unexpected_file_rate: number;
  response_tokens: number;
  observed_codex_tokens: number | null;
  hook_context_emitted: number;
  hook_context_suppressed: number;
  task_outcome: BenchmarkTaskOutcome;
  expected_files_json: string;
  actual_files_json: string;
  excluded_files_json: string;
  summary: string;
  recommendations_json: string;
  metadata_json: string;
  created_at: string;
};

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertFiles(files: FileRecord[]): void {
    const stmt = this.db.prepare(`
      insert into file_inventory (
        root_path, path, language, kind, size, hash, importance, updated_at
      ) values (
        @rootPath, @path, @language, @kind, @size, @hash, @importance, @updatedAt
      )
      on conflict(root_path, path) do update set
        language = excluded.language,
        kind = excluded.kind,
        size = excluded.size,
        hash = excluded.hash,
        importance = excluded.importance,
        updated_at = excluded.updated_at
    `);

    const tx = this.db.transaction((records: FileRecord[]) => {
      for (const record of records) {
        stmt.run(record);
      }
    });

    tx(files);
  }

  replaceIndex(input: {
    rootPath: string;
    files: FileRecord[];
    symbols: SymbolRecord[];
    edges: GraphEdgeRecord[];
    semanticChunks?: SemanticChunkRecord[];
    semanticVectors?: SemanticVectorRecord[];
  }): void {
    const deleteFiles = this.db.prepare("delete from file_inventory where root_path = ?");
    const deleteSymbols = this.db.prepare("delete from symbols where root_path = ?");
    const deleteEdges = this.db.prepare("delete from graph_edges where root_path = ?");
    const deleteChunks = this.db.prepare("delete from semantic_chunks where root_path = ?");
    const deleteVectors = this.db.prepare("delete from semantic_vectors where root_path = ?");
    const insertFile = this.db.prepare(`
      insert into file_inventory (
        root_path, path, language, kind, size, hash, importance, updated_at
      ) values (
        @rootPath, @path, @language, @kind, @size, @hash, @importance, @updatedAt
      )
    `);
    const insertSymbol = this.db.prepare(`
      insert into symbols (
        root_path, file_path, name, kind, exported, start_line, end_line, signature
      ) values (
        @rootPath, @filePath, @name, @kind, @exported, @startLine, @endLine, @signature
      )
    `);
    const insertEdge = this.db.prepare(`
      insert into graph_edges (
        root_path, from_file, to_file, type, metadata_json
      ) values (
        @rootPath, @fromFile, @toFile, @type, @metadataJson
      )
    `);
    const insertChunk = this.db.prepare(`
      insert into semantic_chunks (
        root_path, id, file_path, kind, symbol, start_line, end_line, text, hash, token_estimate
      ) values (
        @rootPath, @id, @filePath, @kind, @symbol, @startLine, @endLine, @text, @hash, @tokenEstimate
      )
    `);
    const insertVector = this.db.prepare(`
      insert into semantic_vectors (
        root_path, chunk_id, dimensions, vector_json
      ) values (
        @rootPath, @chunkId, @dimensions, @vectorJson
      )
    `);

    const tx = this.db.transaction(() => {
      deleteVectors.run(input.rootPath);
      deleteChunks.run(input.rootPath);
      deleteEdges.run(input.rootPath);
      deleteSymbols.run(input.rootPath);
      deleteFiles.run(input.rootPath);

      for (const file of input.files) {
        insertFile.run(file);
      }

      for (const symbol of input.symbols) {
        insertSymbol.run({
          ...symbol,
          exported: symbol.exported ? 1 : 0
        });
      }

      for (const edge of input.edges) {
        insertEdge.run({
          ...edge,
          metadataJson: JSON.stringify(edge.metadata)
        });
      }

      for (const chunk of input.semanticChunks ?? []) {
        insertChunk.run({
          ...chunk,
          symbol: chunk.symbol ?? null,
          startLine: chunk.startLine ?? null,
          endLine: chunk.endLine ?? null
        });
      }

      for (const vector of input.semanticVectors ?? []) {
        insertVector.run({
          ...vector,
          vectorJson: serializeVector(vector.vector)
        });
      }
    });

    tx();
  }

  listFiles(rootPath: string): FileRecord[] {
    const rows = this.db
      .prepare("select * from file_inventory where root_path = ? order by path asc")
      .all(rootPath) as FileRow[];

    return rows.map(mapFileRow);
  }

  listSymbols(rootPath: string): SymbolRecord[] {
    const rows = this.db
      .prepare("select * from symbols where root_path = ? order by file_path asc, start_line asc, name asc")
      .all(rootPath) as SymbolRow[];

    return rows.map(mapSymbolRow);
  }

  listSymbolsForFile(rootPath: string, filePath: string): SymbolRecord[] {
    const rows = this.db
      .prepare("select * from symbols where root_path = ? and file_path = ? order by start_line asc, name asc")
      .all(rootPath, filePath) as SymbolRow[];

    return rows.map(mapSymbolRow);
  }

  findSymbol(rootPath: string, filePath: string, name: string): SymbolRecord | undefined {
    const row = this.db
      .prepare("select * from symbols where root_path = ? and file_path = ? and name = ? order by start_line asc limit 1")
      .get(rootPath, filePath, name) as SymbolRow | undefined;

    return row ? mapSymbolRow(row) : undefined;
  }

  listGraphEdges(rootPath: string): GraphEdgeRecord[] {
    const rows = this.db
      .prepare("select * from graph_edges where root_path = ? order by from_file asc, to_file asc, type asc")
      .all(rootPath) as GraphEdgeRow[];

    return rows.map(mapGraphEdgeRow);
  }

  listGraphEdgesForFile(rootPath: string, filePath: string): GraphEdgeRecord[] {
    const rows = this.db
      .prepare(`
        select * from graph_edges
        where root_path = ? and (from_file = ? or to_file = ?)
        order by from_file asc, to_file asc, type asc
      `)
      .all(rootPath, filePath, filePath) as GraphEdgeRow[];

    return rows.map(mapGraphEdgeRow);
  }

  listSemanticChunks(rootPath: string): SemanticChunkRecord[] {
    const rows = this.db
      .prepare("select * from semantic_chunks where root_path = ? order by file_path asc, kind asc, id asc")
      .all(rootPath) as SemanticChunkRow[];

    return rows.map(mapSemanticChunkRow);
  }

  listSemanticChunksForFile(rootPath: string, filePath: string): SemanticChunkRecord[] {
    const rows = this.db
      .prepare("select * from semantic_chunks where root_path = ? and file_path = ? order by kind asc, id asc")
      .all(rootPath, filePath) as SemanticChunkRow[];

    return rows.map(mapSemanticChunkRow);
  }

  listSemanticVectors(rootPath: string): SemanticVectorRecord[] {
    const rows = this.db
      .prepare("select * from semantic_vectors where root_path = ? order by chunk_id asc")
      .all(rootPath) as SemanticVectorRow[];

    return rows.map(mapSemanticVectorRow);
  }

  createSession(input: {
    id: string;
    rootPath: string;
    task: string;
    risks?: string[];
    verificationHints?: string[];
  }): TaskSession {
    const timestamp = nowIso();

    this.db
      .prepare(`
        insert into sessions (
          id, root_path, task, status, created_at, updated_at, risks_json, verification_hints_json
        ) values (?, ?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.rootPath,
        input.task,
        timestamp,
        timestamp,
        JSON.stringify(input.risks ?? []),
        JSON.stringify(input.verificationHints ?? [])
      );

    return this.getSession(input.id);
  }

  getSession(sessionId: string): TaskSession {
    const row = this.db.prepare("select * from sessions where id = ?").get(sessionId) as
      | SessionRow
      | undefined;

    if (!row) {
      throw new Error(`Unknown Kairn session: ${sessionId}`);
    }

    return {
      id: row.id,
      rootPath: row.root_path,
      task: row.task,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      filesShown: this.listContextShown(row.id).filter((record) => record.filePath),
      symbolsShown: this.listContextShown(row.id).filter((record) => record.symbol),
      commandsRun: this.listCommands(row.id),
      diffsObserved: this.listDiffs(row.id),
      watchEvents: this.listWatchEvents(row.id),
      risks: parseJsonList(row.risks_json),
      verificationHints: parseJsonList(row.verification_hints_json)
    };
  }

  listSessions(input?: { rootPath?: string | undefined; limit?: number | undefined }): TaskSession[] {
    const rows = this.db
      .prepare(`
        select * from sessions
        ${input?.rootPath ? "where root_path = ?" : ""}
        order by updated_at desc, created_at desc
        ${input?.limit ? "limit ?" : ""}
      `)
      .all(...(input?.rootPath && input?.limit ? [input.rootPath, input.limit] : input?.rootPath ? [input.rootPath] : input?.limit ? [input.limit] : [])) as SessionRow[];

    return rows.map((row) => this.getSession(row.id));
  }

  recordContextShown(record: Omit<ContextShownRecord, "id" | "createdAt">): void {
    this.db
      .prepare(`
        insert into context_shown (
          session_id, kind, file_path, symbol, mode, content_hash, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.sessionId,
        record.kind,
        record.filePath ?? null,
        record.symbol ?? null,
        record.mode,
        record.contentHash,
        nowIso()
      );

    this.touchSession(record.sessionId);
  }

  listContextShown(sessionId: string): ContextShownRecord[] {
    const rows = this.db
      .prepare("select * from context_shown where session_id = ? order by created_at asc")
      .all(sessionId) as ContextShownRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      ...(row.file_path ? { filePath: row.file_path } : {}),
      ...(row.symbol ? { symbol: row.symbol } : {}),
      mode: row.mode,
      contentHash: row.content_hash,
      createdAt: row.created_at
    }));
  }

  recordCommand(record: Omit<CommandRecord, "id" | "createdAt">): void {
    this.db
      .prepare("insert into command_records (session_id, type, summary, created_at) values (?, ?, ?, ?)")
      .run(record.sessionId, record.type, record.summary, nowIso());
    this.touchSession(record.sessionId);
  }

  listCommands(sessionId: string): CommandRecord[] {
    const rows = this.db
      .prepare("select * from command_records where session_id = ? order by created_at asc")
      .all(sessionId) as CommandRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      summary: row.summary,
      createdAt: row.created_at
    }));
  }

  recordDiff(record: Omit<DiffRecord, "id" | "createdAt">): void {
    this.db
      .prepare("insert into diff_observations (session_id, files_json, summary, created_at) values (?, ?, ?, ?)")
      .run(record.sessionId, JSON.stringify(record.files), record.summary, nowIso());
    this.touchSession(record.sessionId);
  }

  listDiffs(sessionId: string): DiffRecord[] {
    const rows = this.db
      .prepare("select * from diff_observations where session_id = ? order by created_at asc")
      .all(sessionId) as DiffRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      files: parseJsonList(row.files_json),
      summary: row.summary,
      createdAt: row.created_at
    }));
  }

  recordWatchEvent(record: Omit<WatchEventRecord, "id" | "createdAt">): WatchEventRecord {
    const timestamp = nowIso();
    const result = this.db
      .prepare(`
        insert into watch_events (
          session_id, source, kind, event_name, tool_name, command, files_json, exit_code,
          summary, content_hash, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.sessionId,
        record.source,
        record.kind,
        record.eventName,
        record.toolName ?? null,
        record.command ?? null,
        JSON.stringify(record.files),
        record.exitCode ?? null,
        record.summary,
        record.contentHash,
        JSON.stringify(record.metadata),
        timestamp
      );
    this.touchSession(record.sessionId);

    return {
      ...record,
      id: Number(result.lastInsertRowid),
      createdAt: timestamp
    };
  }

  listWatchEvents(sessionId: string, limit?: number): WatchEventRecord[] {
    const rows = this.db
      .prepare(`
        select * from watch_events
        where session_id = ?
        order by created_at desc, id desc
        ${limit ? "limit ?" : ""}
      `)
      .all(...(limit ? [sessionId, limit] : [sessionId])) as WatchEventRow[];

    return rows.map(mapWatchEventRow).reverse();
  }

  getHostSessionLink(input: {
    source: WatchEventSource;
    rootPath: string;
    hostSessionId: string;
  }): HostSessionLinkRecord | undefined {
    const row = this.db
      .prepare(`
        select * from host_session_links
        where source = ? and root_path = ? and host_session_id = ?
      `)
      .get(input.source, input.rootPath, input.hostSessionId) as HostSessionLinkRow | undefined;

    return row ? mapHostSessionLinkRow(row) : undefined;
  }

  upsertHostSessionLink(record: {
    source: WatchEventSource;
    rootPath: string;
    hostSessionId: string;
    sessionId: string;
    metadata?: Record<string, unknown>;
  }): HostSessionLinkRecord {
    const timestamp = nowIso();
    this.db
      .prepare(`
        insert into host_session_links (
          source, root_path, host_session_id, session_id, first_seen_at, last_seen_at, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(source, root_path, host_session_id) do update set
          session_id = excluded.session_id,
          last_seen_at = excluded.last_seen_at,
          metadata_json = excluded.metadata_json
      `)
      .run(
        record.source,
        record.rootPath,
        record.hostSessionId,
        record.sessionId,
        timestamp,
        timestamp,
        JSON.stringify(record.metadata ?? {})
      );

    return this.getHostSessionLink(record)!;
  }

  recordMetricsEvent(record: Omit<MetricsEventRecord, "id" | "createdAt">): MetricsEventRecord {
    const timestamp = nowIso();
    const result = this.db
      .prepare(`
        insert into metrics_events (
          session_id, root_path, event_kind, event_name, source, response_mode,
          baseline_tokens, output_tokens, saved_tokens, files_json, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.sessionId,
        record.rootPath,
        record.eventKind,
        record.eventName,
        record.source,
        record.responseMode ?? null,
        record.baselineTokens,
        record.outputTokens,
        record.savedTokens,
        JSON.stringify(record.files),
        JSON.stringify(record.metadata),
        timestamp
      );
    this.touchSession(record.sessionId);

    return {
      ...record,
      id: Number(result.lastInsertRowid),
      createdAt: timestamp
    };
  }

  listMetricsEvents(sessionId: string, limit?: number): MetricsEventRecord[] {
    const rows = this.db
      .prepare(`
        select * from metrics_events
        where session_id = ?
        order by created_at desc, id desc
        ${limit ? "limit ?" : ""}
      `)
      .all(...(limit ? [sessionId, limit] : [sessionId])) as MetricsEventRow[];

    return rows.map(mapMetricsEventRow).reverse();
  }

  createEvalRun(record: Omit<EvalRunRecord, "startedAt">): EvalRunRecord {
    const timestamp = nowIso();
    this.db
      .prepare(`
        insert into eval_runs (
          id, session_id, root_path, task, label, mode, status, started_at, ended_at, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.sessionId ?? null,
        record.rootPath,
        record.task,
        record.label,
        record.mode,
        record.status,
        timestamp,
        record.endedAt ?? null,
        JSON.stringify(record.metadata)
      );

    if (record.sessionId) this.touchSession(record.sessionId);
    return {
      ...record,
      startedAt: timestamp
    };
  }

  getEvalRun(runId: string): EvalRunRecord {
    const row = this.db.prepare("select * from eval_runs where id = ?").get(runId) as EvalRunRow | undefined;
    if (!row) {
      throw new Error(`Unknown Kairn eval run: ${runId}`);
    }
    return mapEvalRunRow(row);
  }

  listEvalRuns(input: { rootPath?: string | undefined; sessionId?: string | undefined; limit?: number | undefined } = {}): EvalRunRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.rootPath) {
      conditions.push("root_path = ?");
      params.push(input.rootPath);
    }
    if (input.sessionId) {
      conditions.push("session_id = ?");
      params.push(input.sessionId);
    }
    if (input.limit) {
      params.push(input.limit);
    }

    const rows = this.db
      .prepare(`
        select * from eval_runs
        ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
        order by started_at desc, id desc
        ${input.limit ? "limit ?" : ""}
      `)
      .all(...params) as EvalRunRow[];

    return rows.map(mapEvalRunRow);
  }

  updateEvalRunStatus(runId: string, status: EvalRunStatus): EvalRunRecord {
    const endedAt = status === "active" ? null : nowIso();
    this.db
      .prepare("update eval_runs set status = ?, ended_at = ? where id = ?")
      .run(status, endedAt, runId);
    return this.getEvalRun(runId);
  }

  recordEvalObservation(record: Omit<EvalObservationRecord, "id" | "createdAt">): EvalObservationRecord {
    const timestamp = nowIso();
    const result = this.db
      .prepare(`
        insert into eval_observations (
          run_id, session_id, kind, summary, metrics_json, files_json, content_hash, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.runId,
        record.sessionId ?? null,
        record.kind,
        record.summary,
        JSON.stringify(record.metrics),
        JSON.stringify(record.files),
        record.contentHash,
        timestamp
      );

    if (record.sessionId) this.touchSession(record.sessionId);
    return {
      ...record,
      id: Number(result.lastInsertRowid),
      createdAt: timestamp
    };
  }

  listEvalObservations(input: { runId?: string | undefined; sessionId?: string | undefined; limit?: number | undefined }): EvalObservationRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.runId) {
      conditions.push("run_id = ?");
      params.push(input.runId);
    }
    if (input.sessionId) {
      conditions.push("session_id = ?");
      params.push(input.sessionId);
    }
    if (input.limit) {
      params.push(input.limit);
    }

    const rows = this.db
      .prepare(`
        select * from eval_observations
        ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
        order by created_at desc, id desc
        ${input.limit ? "limit ?" : ""}
      `)
      .all(...params) as EvalObservationRow[];

    return rows.map(mapEvalObservationRow).reverse();
  }

  createBenchmarkRun(record: Omit<BenchmarkRunRecord, "startedAt">): BenchmarkRunRecord {
    const timestamp = nowIso();
    this.db
      .prepare(`
        insert into benchmark_runs (
          id, root_path, suite_id, suite_name, mode, status, started_at, ended_at, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.rootPath,
        record.suiteId,
        record.suiteName,
        record.mode,
        record.status,
        timestamp,
        record.endedAt ?? null,
        JSON.stringify(record.metadata)
      );

    return {
      ...record,
      startedAt: timestamp
    };
  }

  getBenchmarkRun(runId: string): BenchmarkRunRecord {
    const row = this.db.prepare("select * from benchmark_runs where id = ?").get(runId) as BenchmarkRunRow | undefined;
    if (!row) {
      throw new Error(`Unknown Kairn benchmark run: ${runId}`);
    }
    return mapBenchmarkRunRow(row);
  }

  listBenchmarkRuns(input: { rootPath?: string | undefined; limit?: number | undefined } = {}): BenchmarkRunRecord[] {
    const params: unknown[] = [];
    const where = input.rootPath ? "where root_path = ?" : "";
    if (input.rootPath) params.push(input.rootPath);
    if (input.limit) params.push(input.limit);

    const rows = this.db
      .prepare(`
        select * from benchmark_runs
        ${where}
        order by started_at desc, id desc
        ${input.limit ? "limit ?" : ""}
      `)
      .all(...params) as BenchmarkRunRow[];

    return rows.map(mapBenchmarkRunRow);
  }

  updateBenchmarkRunStatus(runId: string, status: BenchmarkRunStatus): BenchmarkRunRecord {
    const endedAt = status === "active" ? null : nowIso();
    this.db
      .prepare("update benchmark_runs set status = ?, ended_at = ? where id = ?")
      .run(status, endedAt, runId);
    return this.getBenchmarkRun(runId);
  }

  recordBenchmarkResult(record: Omit<BenchmarkResultRecord, "id" | "createdAt">): BenchmarkResultRecord {
    const timestamp = nowIso();
    const result = this.db
      .prepare(`
        insert into benchmark_results (
          run_id, case_id, case_mode, score, expected_file_recall, top_k_hit_rate,
          unexpected_file_rate, response_tokens, observed_codex_tokens,
          hook_context_emitted, hook_context_suppressed, task_outcome,
          expected_files_json, actual_files_json, excluded_files_json,
          summary, recommendations_json, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.runId,
        record.caseId,
        record.caseMode,
        record.score,
        record.expectedFileRecall,
        record.topKHitRate,
        record.unexpectedFileRate,
        record.responseTokens,
        record.observedCodexTokens ?? null,
        record.hookContextEmitted,
        record.hookContextSuppressed,
        record.taskOutcome,
        JSON.stringify(record.expectedFiles),
        JSON.stringify(record.actualFiles),
        JSON.stringify(record.excludedFiles),
        record.summary,
        JSON.stringify(record.recommendations),
        JSON.stringify(record.metadata),
        timestamp
      );

    return {
      ...record,
      id: Number(result.lastInsertRowid),
      createdAt: timestamp
    };
  }

  listBenchmarkResults(runId: string): BenchmarkResultRecord[] {
    const rows = this.db
      .prepare("select * from benchmark_results where run_id = ? order by created_at asc, id asc")
      .all(runId) as BenchmarkResultRow[];

    return rows.map(mapBenchmarkResultRow);
  }

  private touchSession(sessionId: string): void {
    this.db.prepare("update sessions set updated_at = ? where id = ?").run(nowIso(), sessionId);
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        root_path text not null,
        task text not null,
        status text not null check (status in ('active', 'completed', 'abandoned')),
        created_at text not null,
        updated_at text not null,
        risks_json text not null default '[]',
        verification_hints_json text not null default '[]'
      );

      create table if not exists context_shown (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        kind text not null,
        file_path text,
        symbol text,
        mode text not null,
        content_hash text not null,
        created_at text not null
      );

      create table if not exists file_inventory (
        root_path text not null,
        path text not null,
        language text not null,
        kind text not null,
        size integer not null,
        hash text not null,
        importance integer not null,
        updated_at text not null,
        primary key (root_path, path)
      );

      create table if not exists symbols (
        root_path text not null,
        file_path text not null,
        name text not null,
        kind text not null,
        exported integer not null check (exported in (0, 1)),
        start_line integer not null,
        end_line integer not null,
        signature text not null
      );

      create table if not exists graph_edges (
        root_path text not null,
        from_file text not null,
        to_file text not null,
        type text not null,
        metadata_json text not null default '{}'
      );

      create table if not exists semantic_chunks (
        root_path text not null,
        id text not null,
        file_path text not null,
        kind text not null,
        symbol text,
        start_line integer,
        end_line integer,
        text text not null,
        hash text not null,
        token_estimate integer not null,
        primary key (root_path, id)
      );

      create table if not exists semantic_vectors (
        root_path text not null,
        chunk_id text not null,
        dimensions integer not null,
        vector_json text not null,
        primary key (root_path, chunk_id)
      );

      create table if not exists command_records (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        type text not null,
        summary text not null,
        created_at text not null
      );

      create table if not exists diff_observations (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        files_json text not null,
        summary text not null,
        created_at text not null
      );

      create table if not exists watch_events (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        source text not null,
        kind text not null,
        event_name text not null,
        tool_name text,
        command text,
        files_json text not null,
        exit_code integer,
        summary text not null,
        content_hash text not null,
        metadata_json text not null default '{}',
        created_at text not null
      );

      create table if not exists host_session_links (
        source text not null,
        root_path text not null,
        host_session_id text not null,
        session_id text not null references sessions(id) on delete cascade,
        first_seen_at text not null,
        last_seen_at text not null,
        metadata_json text not null default '{}',
        primary key (source, root_path, host_session_id)
      );

      create table if not exists metrics_events (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        root_path text not null,
        event_kind text not null,
        event_name text not null,
        source text not null,
        response_mode text,
        baseline_tokens integer not null,
        output_tokens integer not null,
        saved_tokens integer not null,
        files_json text not null,
        metadata_json text not null default '{}',
        created_at text not null
      );

      create table if not exists eval_runs (
        id text primary key,
        session_id text references sessions(id) on delete set null,
        root_path text not null,
        task text not null,
        label text not null,
        mode text not null check (mode in ('baseline', 'kairn', 'manual')),
        status text not null check (status in ('active', 'completed', 'abandoned')),
        started_at text not null,
        ended_at text,
        metadata_json text not null default '{}'
      );

      create table if not exists eval_observations (
        id integer primary key autoincrement,
        run_id text not null references eval_runs(id) on delete cascade,
        session_id text references sessions(id) on delete set null,
        kind text not null,
        summary text not null,
        metrics_json text not null default '{}',
        files_json text not null default '[]',
        content_hash text not null,
        created_at text not null
      );

      create table if not exists benchmark_runs (
        id text primary key,
        root_path text not null,
        suite_id text not null,
        suite_name text not null,
        mode text not null check (mode in ('replay', 'agent', 'hybrid')),
        status text not null check (status in ('active', 'completed', 'abandoned')),
        started_at text not null,
        ended_at text,
        metadata_json text not null default '{}'
      );

      create table if not exists benchmark_results (
        id integer primary key autoincrement,
        run_id text not null references benchmark_runs(id) on delete cascade,
        case_id text not null,
        case_mode text not null,
        score real not null,
        expected_file_recall real not null,
        top_k_hit_rate real not null,
        unexpected_file_rate real not null,
        response_tokens integer not null,
        observed_codex_tokens integer,
        hook_context_emitted integer not null,
        hook_context_suppressed integer not null,
        task_outcome text not null,
        expected_files_json text not null default '[]',
        actual_files_json text not null default '[]',
        excluded_files_json text not null default '[]',
        summary text not null,
        recommendations_json text not null default '[]',
        metadata_json text not null default '{}',
        created_at text not null
      );

      create index if not exists context_shown_session_idx on context_shown(session_id);
      create index if not exists command_records_session_idx on command_records(session_id);
      create index if not exists diff_observations_session_idx on diff_observations(session_id);
      create index if not exists watch_events_session_idx on watch_events(session_id);
      create index if not exists watch_events_session_kind_idx on watch_events(session_id, kind, created_at);
      create index if not exists host_session_links_session_idx on host_session_links(session_id);
      create index if not exists metrics_events_session_idx on metrics_events(session_id, created_at);
      create index if not exists metrics_events_session_kind_idx on metrics_events(session_id, event_kind, created_at);
      create index if not exists eval_runs_root_idx on eval_runs(root_path, started_at);
      create index if not exists eval_runs_session_idx on eval_runs(session_id, started_at);
      create index if not exists eval_observations_run_idx on eval_observations(run_id, created_at);
      create index if not exists eval_observations_session_idx on eval_observations(session_id, created_at);
      create index if not exists benchmark_runs_root_idx on benchmark_runs(root_path, started_at);
      create index if not exists benchmark_results_run_idx on benchmark_results(run_id, created_at);
      create index if not exists benchmark_results_case_idx on benchmark_results(case_id, run_id);
      create index if not exists symbols_root_file_idx on symbols(root_path, file_path, name);
      create index if not exists graph_edges_root_from_idx on graph_edges(root_path, from_file);
      create index if not exists graph_edges_root_to_idx on graph_edges(root_path, to_file);
      create index if not exists semantic_chunks_root_file_idx on semantic_chunks(root_path, file_path);
      create index if not exists semantic_vectors_root_chunk_idx on semantic_vectors(root_path, chunk_id);
    `);
  }
}

function mapFileRow(row: FileRow): FileRecord {
  return {
    rootPath: row.root_path,
    path: row.path,
    language: row.language,
    kind: row.kind,
    size: row.size,
    hash: row.hash,
    importance: row.importance,
    updatedAt: row.updated_at
  };
}

function mapSymbolRow(row: SymbolRow): SymbolRecord {
  return {
    rootPath: row.root_path,
    filePath: row.file_path,
    name: row.name,
    kind: row.kind,
    exported: row.exported === 1,
    startLine: row.start_line,
    endLine: row.end_line,
    signature: row.signature
  };
}

function mapGraphEdgeRow(row: GraphEdgeRow): GraphEdgeRecord {
  return {
    rootPath: row.root_path,
    fromFile: row.from_file,
    toFile: row.to_file,
    type: row.type,
    metadata: parseJsonObject(row.metadata_json)
  };
}

function mapSemanticChunkRow(row: SemanticChunkRow): SemanticChunkRecord {
  return {
    rootPath: row.root_path,
    id: row.id,
    filePath: row.file_path,
    kind: row.kind,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.start_line ? { startLine: row.start_line } : {}),
    ...(row.end_line ? { endLine: row.end_line } : {}),
    text: row.text,
    hash: row.hash,
    tokenEstimate: row.token_estimate
  };
}

function mapSemanticVectorRow(row: SemanticVectorRow): SemanticVectorRecord {
  return {
    rootPath: row.root_path,
    chunkId: row.chunk_id,
    dimensions: row.dimensions,
    vector: deserializeVector(row.vector_json)
  };
}

function mapWatchEventRow(row: WatchEventRow): WatchEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    kind: row.kind,
    eventName: row.event_name,
    ...(row.tool_name ? { toolName: row.tool_name } : {}),
    ...(row.command ? { command: row.command } : {}),
    files: parseJsonList(row.files_json),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    summary: row.summary,
    contentHash: row.content_hash,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at
  };
}

function mapHostSessionLinkRow(row: HostSessionLinkRow): HostSessionLinkRecord {
  return {
    source: row.source,
    rootPath: row.root_path,
    hostSessionId: row.host_session_id,
    sessionId: row.session_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    metadata: parseJsonObject(row.metadata_json)
  };
}

function mapMetricsEventRow(row: MetricsEventRow): MetricsEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    rootPath: row.root_path,
    eventKind: row.event_kind,
    eventName: row.event_name,
    source: row.source,
    ...(row.response_mode ? { responseMode: row.response_mode } : {}),
    baselineTokens: row.baseline_tokens,
    outputTokens: row.output_tokens,
    savedTokens: row.saved_tokens,
    files: parseJsonList(row.files_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at
  };
}

function mapEvalRunRow(row: EvalRunRow): EvalRunRecord {
  return {
    id: row.id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    rootPath: row.root_path,
    task: row.task,
    label: row.label,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    metadata: parseJsonObject(row.metadata_json)
  };
}

function mapEvalObservationRow(row: EvalObservationRow): EvalObservationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    kind: row.kind,
    summary: row.summary,
    metrics: parseJsonObject(row.metrics_json),
    files: parseJsonList(row.files_json),
    contentHash: row.content_hash,
    createdAt: row.created_at
  };
}

function mapBenchmarkRunRow(row: BenchmarkRunRow): BenchmarkRunRecord {
  return {
    id: row.id,
    rootPath: row.root_path,
    suiteId: row.suite_id,
    suiteName: row.suite_name,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    metadata: parseJsonObject(row.metadata_json)
  };
}

function mapBenchmarkResultRow(row: BenchmarkResultRow): BenchmarkResultRecord {
  return {
    id: row.id,
    runId: row.run_id,
    caseId: row.case_id,
    caseMode: row.case_mode,
    score: row.score,
    expectedFileRecall: row.expected_file_recall,
    topKHitRate: row.top_k_hit_rate,
    unexpectedFileRate: row.unexpected_file_rate,
    responseTokens: row.response_tokens,
    ...(row.observed_codex_tokens !== null ? { observedCodexTokens: row.observed_codex_tokens } : {}),
    hookContextEmitted: row.hook_context_emitted,
    hookContextSuppressed: row.hook_context_suppressed,
    taskOutcome: row.task_outcome,
    expectedFiles: parseJsonList(row.expected_files_json),
    actualFiles: parseJsonList(row.actual_files_json),
    excludedFiles: parseJsonList(row.excluded_files_json),
    summary: row.summary,
    recommendations: parseJsonList(row.recommendations_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at
  };
}

function parseJsonList(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
