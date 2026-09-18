// 本地数据库层（§4 数据模型）
// M1 采用 sql.js（WASM SQLite）：零原生编译依赖、保留真实 SQL 表结构；
// M2 接入同步时可平滑替换为 better-sqlite3（仅本文件为适配点）。
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

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
  color TEXT,
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
  row_id TEXT,
  row_payload TEXT NOT NULL,
  base_version INTEGER,
  is_run INTEGER DEFAULT 0,
  created_at INTEGER,
  state TEXT DEFAULT 'queued'
);
CREATE INDEX IF NOT EXISTS idx_timer_item_deleted ON timer_item(deleted);
CREATE INDEX IF NOT EXISTS idx_record_timer ON timer_record(timer_id);
CREATE INDEX IF NOT EXISTS idx_pending_row ON pending_ops(table_name, row_id, state);
`;

/** JSON 列统一入口：坏数据一律退化成空对象（调用方给出具体列形状类型） */
function safeParse<T extends object = Record<string, unknown>>(json: string | null): T {
  try {
    return json ? (JSON.parse(json) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/** 一行数据库结果（sql.js 把列名原样作键返回） */
export type Row = Record<string, unknown>;

export class LocalDB {
  private db: SqlJsDatabase | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  /** init() 之前被调用属于编程错误，直接抛而不是静默产出脏数据 */
  private get must(): SqlJsDatabase {
    if (!this.db) throw new Error('LocalDB 尚未 init()');
    return this.db;
  }

  constructor(private filePath: string) {}

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    const existing = fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath) : null;
    this.db = existing ? new SQL.Database(existing) : new SQL.Database();
    this.must.run(DDL);
    this.migrate();
    this.flush();
  }

  /** 轻量 schema 迁移（旧库升级）：CREATE TABLE IF NOT EXISTS 不会给已存在表加列，用 ALTER 补 */
  private migrate(): void {
    const cols = this.all('PRAGMA table_info(pending_ops)').map((c) => String(c.name));
    if (!cols.includes('row_id')) {
      this.must.run('ALTER TABLE pending_ops ADD COLUMN row_id TEXT');
      // 回填 row_id（从 row_payload 解析 id），供 dirty 精确匹配（替代 LIKE 模糊匹配）
      for (const r of this.all('SELECT operation_id, row_payload FROM pending_ops WHERE row_id IS NULL')) {
        const id = safeParse<{ id?: unknown }>(String(r.row_payload ?? null)).id;
        if (id != null) this.must.run('UPDATE pending_ops SET row_id = ? WHERE operation_id = ?', [String(id), String(r.operation_id)]);
      }
    }
    // 番茄钟统计已改由 timer_record 现场聚合，本机私有账本表作废（历史数据仍可从记录复原）
    this.must.run('DROP TABLE IF EXISTS pomo_journal');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_record_ended ON timer_record(ended_at)');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_timer_tag_timer ON timer_tag(timer_id)');
  }

  run(sql: string, params: unknown[] = []): void {
    this.must.run(sql, params);
    this.saveSoon();
  }

  all(sql: string, params: unknown[] = []): Row[] {
    const stmt = this.must.prepare(sql);
    stmt.bind(params);
    const rows: Row[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  get(sql: string, params: unknown[] = []): Row | null {
    return this.all(sql, params)[0] ?? null;
  }

  transaction(fn: () => void): void {
    this.must.run('BEGIN');
    try {
      fn();
      this.must.run('COMMIT');
    } catch (e) {
      this.must.run('ROLLBACK');
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
    fs.writeFileSync(this.filePath, Buffer.from(this.must.export()));
  }

  getMeta(key: string): string | null {
    const row = this.get('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, value]
    );
  }
}

export { safeParse };
