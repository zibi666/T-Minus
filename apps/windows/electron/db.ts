// 本地数据库层（§4 数据模型）
// M1 采用 sql.js（WASM SQLite）：零原生编译依赖、保留真实 SQL 表结构；
// M2 接入同步时可平滑替换为 better-sqlite3（仅本文件为适配点）。
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';

export function uuid(): string {
  return crypto.randomUUID();
}

/** 启动快照保留代：.bak 最新，越往后越早；主库损坏时按顺序回退 */
const SNAPSHOT_SUFFIXES = ['.bak', '.bak.1', '.bak.2'];

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
  /** 上一次 flush() 是否落盘失败（失败会进 5s 退避重试）。退出前据此判断能否安全结束进程 */
  flushFailed = false;
  /** 退避重试终于落地时回调一次（供 before-quit 延迟退出后重新触发 app.quit） */
  onFlushSettled: (() => void) | null = null;

  /** init() 之前被调用属于编程错误，直接抛而不是静默产出脏数据 */
  private get must(): SqlJsDatabase {
    if (!this.db) throw new Error('LocalDB 尚未 init()');
    return this.db;
  }

  constructor(private filePath: string) {}

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    this.db = this.openReadable(SQL);
    this.must.run(DDL);
    this.migrate();
    this.flush();
    this.rotateSnapshot();
  }

  /**
   * 轮换启动快照：保留最近 SNAPSHOT_SUFFIXES.length 代，
   * 让「主库被外部损坏」至少能回到前几次启动时的已知可读状态。
   */
  private rotateSnapshot(): void {
    try {
      for (let i = SNAPSHOT_SUFFIXES.length - 1; i >= 1; i--) {
        const older = `${this.filePath}${SNAPSHOT_SUFFIXES[i]}`;
        const newer = `${this.filePath}${SNAPSHOT_SUFFIXES[i - 1]}`;
        fs.rmSync(older, { force: true });
        if (fs.existsSync(newer)) fs.renameSync(newer, older);
      }
      fs.copyFileSync(this.filePath, `${this.filePath}${SNAPSHOT_SUFFIXES[0]}`);
    } catch (e) {
      console.error('[db] 快照轮换失败:', e);
    }
  }

  /** 主库读不进来就退回启动快照；全都读不进则把坏文件留存后开空库，绝不静默丢数据 */
  private openReadable(SQL: SqlJsStatic): SqlJsDatabase {
    // 快照按代轮换（.bak 最新，.bak.1 / .bak.2 更早）：主库被写坏时最多能回退三代，
    // 而不是像早年那样只有一份、每次启动都被覆盖成最新态
    for (const p of [this.filePath, ...SNAPSHOT_SUFFIXES.map((s) => `${this.filePath}${s}`)]) {
      if (!fs.existsSync(p)) continue;
      let buf: Buffer;
      try {
        buf = fs.readFileSync(p);
      } catch (e) {
        console.error('[db] 数据库文件不可读:', p, e);
        continue;
      }
      // sql.js 对 0 字节/被截断的文件不抛错，会静默开一个空库 —— 那会让完好的 .bak 失去回退机会。
      // 先校验 SQLite 文件头（"SQLite format 3\0"），不合法就当不可读，继续试下一个候选。
      if (buf.length < 16 || buf.toString('latin1', 0, 16) !== 'SQLite format 3\0') {
        console.error('[db] 数据库文件不是有效的 SQLite 库（0 字节或文件头损坏）:', p);
        continue;
      }
      try {
        const db = new SQL.Database(buf);
        if (p !== this.filePath) console.warn('[db] 主库不可读，已回退到启动快照:', p);
        return db;
      } catch (e) {
        console.error('[db] 数据库文件不可读:', p, e);
      }
    }
    if (fs.existsSync(this.filePath)) {
      const kept = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, kept);
        console.error('[db] 坏库文件已留存待查:', kept);
      } catch (e) {
        console.error('[db] 坏库文件留存失败:', e);
      }
    }
    return new SQL.Database();
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
    // 番茄钟统计已改由 timer_record 现场聚合，本机私有账本表作废（历史数据仍可从记录复原）。
    // 表已不存在时这句是纯 no-op，加存在性判断只是省掉每次启动都发一条无用语句
    if (this.all("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pomo_journal'").length > 0) {
      this.must.run('DROP TABLE pomo_journal');
    }
    // 账号可见域按 user_id 过滤（scope()），不给 user_id 建索引会让 list/dailyStats 全表扫
    this.must.run('CREATE INDEX IF NOT EXISTS idx_record_ended ON timer_record(ended_at)');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_timer_tag_timer ON timer_tag(timer_id)');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_timer_item_user ON timer_item(user_id)');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_record_user ON timer_record(user_id)');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_tag_user ON tag(user_id)');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_timer_tag_user ON timer_tag(user_id)');
    this.must.run('CREATE INDEX IF NOT EXISTS idx_milestone_user ON milestone(user_id)');
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
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      // 写临时文件再原子改名：直接覆盖式写整库时，断电/杀进程会留下截断文件，下次启动直接读不进来
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(this.must.export()));
      fs.renameSync(tmp, this.filePath);
      if (this.flushFailed) {
        this.flushFailed = false;
        const cb = this.onFlushSettled;
        this.onFlushSettled = null;
        cb?.();
      }
    } catch (e) {
      // saveSoon 经 setTimeout 触发到这里：.db 被杀毒/备份软件短暂占用(EPERM)、磁盘满等
      // 瞬时错误不能变成主进程未捕获异常。保住内存库，退避后重试落盘
      console.error('[db] flush 失败，5s 后重试：', e);
      this.flushFailed = true;
      this.saveTimer = setTimeout(() => this.flush(), 5000);
    }
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
