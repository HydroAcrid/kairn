import Database from "better-sqlite3";
import type {
  CommandRecord,
  ContextShownRecord,
  DiffRecord,
  FileRecord,
  GraphEdgeRecord,
  SessionStatus,
  SymbolRecord,
  TaskSession
} from "../types.js";
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
  }): void {
    const deleteFiles = this.db.prepare("delete from file_inventory where root_path = ?");
    const deleteSymbols = this.db.prepare("delete from symbols where root_path = ?");
    const deleteEdges = this.db.prepare("delete from graph_edges where root_path = ?");
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

    const tx = this.db.transaction(() => {
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
      risks: parseJsonList(row.risks_json),
      verificationHints: parseJsonList(row.verification_hints_json)
    };
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

      create index if not exists context_shown_session_idx on context_shown(session_id);
      create index if not exists command_records_session_idx on command_records(session_id);
      create index if not exists diff_observations_session_idx on diff_observations(session_id);
      create index if not exists symbols_root_file_idx on symbols(root_path, file_path, name);
      create index if not exists graph_edges_root_from_idx on graph_edges(root_path, from_file);
      create index if not exists graph_edges_root_to_idx on graph_edges(root_path, to_file);
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

function parseJsonList(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
