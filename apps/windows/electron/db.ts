// 本地数据库层（§4 数据模型）
// M1 采用 sql.js（WASM SQLite）：零原生编译依赖、保留真实 SQL 表结构；
// M2 接入同步时可平滑替换为 better-sqlite3（仅本文件为适配点）。
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const initSqlJs: any = require('sql.js');

export function uuid(): string {
  return crypto.randomUUID();
}

/** §4.1 通用同步列已在各表落实；M2 服务端 change_seq 游标接入前，先落本地结构 */
const DDL = `
CREATE TABLE IF NOT EXISTS timer_item (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color TEXT DEFAULT '#E5484D',
  starred INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  config_json TEXT NOT NULL,
  run_state TEXT DEFAULT 'idle',
  session_id TEXT,
  run_json TEXT,
  version INTEGER DEFAULT 1,
  updated_at INTEGER,
  deleted INTEGER DEFAULT 0,
  origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS tag (
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, color TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS timer_tag (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT NOT NULL, tag_id TEXT NOT NULL,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS milestone (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT NOT NULL, note TEXT,
  marked_at INTEGER, version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS timer_record (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT NOT NULL, session_id TEXT,
  started_at INTEGER, ended_at INTEGER, duration_sec INTEGER, record_type TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pending_ops (
  operation_id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  op_type TEXT NOT NULL,
  row_payload TEXT NOT NULL,
  base_version INTEGER,
  is_run INTEGER DEFAULT 0,
  created_at INTEGER,
  state TEXT DEFAULT 'queued'
);
CREATE INDEX IF NOT EXISTS idx_timer_item_deleted ON timer_item(deleted);
CREATE INDEX IF NOT EXISTS idx_record_timer ON timer_record(timer_id);
`;

function safeParse(json: string | null): any {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

export class LocalDB {
  private db: any;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private filePath: string) {}

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    this.db = fs.existsSync(this.filePath)
      ? new SQL.Database(fs.readFileSync(this.filePath))
      : new SQL.Database();
    this.db.run(DDL);
    this.flush();
  }

  run(sql: string, params: any[] = []): void {
    this.db.run(sql, params);
    this.saveSoon();
  }

  all(sql: string, params: any[] = []): any[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  get(sql: string, params: any[] = []): any | null {
    return this.all(sql, params)[0] ?? null;
  }

  transaction(fn: () => void): void {
    this.db.run('BEGIN');
    try {
      fn();
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.saveSoon();
  }

  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(this.db.export()));
  }

  getMeta(key: string): string | null {
    const row = this.get('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value]
    );
  }
}

export { safeParse };
