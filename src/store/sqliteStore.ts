import Database from "better-sqlite3";
import type {
  CommandRecord,
  ContextShownRecord,
  DiffRecord,
  FileRecord,
  SessionStatus,
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

  listFiles(rootPath: string): FileRecord[] {
    const rows = this.db
      .prepare("select * from file_inventory where root_path = ? order by path asc")
      .all(rootPath) as FileRow[];

    return rows.map(mapFileRow);
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

function parseJsonList(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
