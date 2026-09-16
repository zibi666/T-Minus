// 服务端数据库（sql.js）：§4 表结构 + §5.2 变更日志
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SYNC_TABLES = ['timer_item', 'tag', 'timer_tag', 'milestone', 'timer_record'];

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS timer_item (
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT, type TEXT, color TEXT,
  starred INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, remark TEXT DEFAULT '',
  config_json TEXT, run_state TEXT DEFAULT 'idle', session_id TEXT, run_json TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS tag (
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS timer_tag (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT, tag_id TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS milestone (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT, note TEXT, marked_at INTEGER,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS timer_record (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT, session_id TEXT,
  started_at INTEGER, ended_at INTEGER, duration_sec INTEGER, record_type TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
);
CREATE TABLE IF NOT EXISTS change_log (
  change_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT, table_name TEXT, row_id TEXT, op_type TEXT,
  payload TEXT, origin_device_id TEXT, committed_at INTEGER
);
CREATE TABLE IF NOT EXISTS ops (
  operation_id TEXT PRIMARY KEY, user_id TEXT, response TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_change_user ON change_log(user_id, change_seq);
`;

class ServerDB {
  constructor(filePath) {
    this.filePath = filePath;
    this.saveTimer = null;
  }

  async init() {
    const SQL = await initSqlJs();
    this.db = fs.existsSync(this.filePath)
      ? new SQL.Database(fs.readFileSync(this.filePath))
      : new SQL.Database();
    // sql.js 的 run 对多语句字符串在部分版本下不稳定，逐条执行
    for (const stmt of DDL.split(';')) {
      const s = stmt.trim();
      if (s) this.db.run(s);
    }
    this.flush();
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    this.saveSoon();
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] ?? null;
  }

  getMeta(key) {
    const row = this.get('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  transaction(fn) {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.saveSoon();
      return result;
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  saveSoon() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(this.db.export()));
  }
}

module.exports = { ServerDB, SYNC_TABLES };
