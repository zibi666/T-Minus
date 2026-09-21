// 本地库（§4 数据模型）。表结构与 Windows electron/db.ts 逐列一致；
// 业务写一律经 Repo 的「本地事务 + pending_ops 同事务入队」，本文件只提供执行原语。
import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { columnsOf } from '../core/Contract';
import { orderedValues, PendingOp, SyncRow, TimerItem, TimerRecord, Tag, TimerTag, Milestone, ValueType } from './Rows';

const DB_NAME = 'timemark.db';

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS timer_item (
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
)`,
  `CREATE TABLE IF NOT EXISTS tag (
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, color TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
)`,
  `CREATE TABLE IF NOT EXISTS timer_tag (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT NOT NULL, tag_id TEXT NOT NULL,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
)`,
  `CREATE TABLE IF NOT EXISTS milestone (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT NOT NULL, note TEXT,
  marked_at INTEGER, version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
)`,
  `CREATE TABLE IF NOT EXISTS timer_record (
  id TEXT PRIMARY KEY, user_id TEXT, timer_id TEXT NOT NULL, session_id TEXT,
  started_at INTEGER, ended_at INTEGER, duration_sec INTEGER, record_type TEXT,
  version INTEGER DEFAULT 1, updated_at INTEGER, deleted INTEGER DEFAULT 0, origin_device_id TEXT
)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS pending_ops (
  operation_id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  op_type TEXT NOT NULL,
  row_id TEXT,
  row_payload TEXT NOT NULL,
  base_version INTEGER,
  is_run INTEGER DEFAULT 0,
  created_at INTEGER,
  state TEXT DEFAULT 'queued'
)`,
  `CREATE INDEX IF NOT EXISTS idx_timer_item_deleted ON timer_item(deleted)`,
  `CREATE INDEX IF NOT EXISTS idx_record_timer ON timer_record(timer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_record_ended ON timer_record(ended_at)`,
  `CREATE INDEX IF NOT EXISTS idx_timer_tag_timer ON timer_tag(timer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_row ON pending_ops(table_name, row_id, state)`
];

/** 结果集读列的统一入口：空列与类型漂移都在这里收口 */
export class RsReader {
  rs: relationalStore.ResultSet;

  constructor(rs: relationalStore.ResultSet) {
    this.rs = rs;
  }

  private idx(col: string): number {
    return this.rs.getColumnIndex(col);
  }

  isNull(col: string): boolean {
    const i = this.idx(col);
    return i < 0 || this.rs.isColumnNull(i);
  }

  str(col: string): string | null {
    if (this.isNull(col)) return null;
    return this.rs.getString(this.idx(col));
  }

  strOr(col: string, fallback: string): string {
    const v = this.str(col);
    return v === null ? fallback : v;
  }

  num(col: string): number {
    if (this.isNull(col)) return 0;
    return this.rs.getLong(this.idx(col));
  }

  numOrNull(col: string): number | null {
    return this.isNull(col) ? null : this.rs.getLong(this.idx(col));
  }

  bool(col: string): boolean {
    return this.num(col) !== 0;
  }
}

export class LocalDb {
  private store: relationalStore.RdbStore | null = null;
  private tail: Promise<void> = Promise.resolve();

  private constructor(store: relationalStore.RdbStore) {
    this.store = store;
  }

  static async open(ctx: common.Context): Promise<LocalDb> {
    const config: relationalStore.StoreConfig = {
      name: DB_NAME,
      securityLevel: relationalStore.SecurityLevel.S1
    };
    const store = await relationalStore.getRdbStore(ctx, config);
    const db = new LocalDb(store);
    for (let i = 0; i < DDL.length; i++) {
      await store.executeSql(DDL[i]);
    }
    // 旧库升级：番茄钟不再是独立 type（与 Android Room MIGRATION_1_2 同一动作）
    await store.executeSql("UPDATE timer_item SET type = 'PRECISE_COUNTDOWN' WHERE type = 'POMODORO'");
    return db;
  }

  private get s(): relationalStore.RdbStore {
    if (this.store === null) {
      throw new Error('LocalDb 尚未 open()');
    }
    return this.store;
  }

  /** 单执行序串行化：所有写都排队，避免秒级 tick 与用户操作在同一连接上交错 */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive<T>(async () => {
      this.s.beginTransaction();
      try {
        const r = await fn();
        this.s.commit();
        return r;
      } catch (e) {
        this.s.rollBack();
        throw e as Error;
      }
    });
  }

  async exec(sql: string, args: ValueType[] = []): Promise<void> {
    await this.s.executeSql(sql, args);
  }

  async query<T>(sql: string, map: (r: RsReader) => T, args: ValueType[] = []): Promise<T[]> {
    const rs = await this.s.querySql(sql, args);
    const out: T[] = [];
    try {
      while (rs.goToNextRow()) {
        out.push(map(new RsReader(rs)));
      }
    } finally {
      rs.close();
    }
    return out;
  }

  async queryOne<T>(sql: string, map: (r: RsReader) => T, args: ValueType[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, map, args);
    return rows.length > 0 ? rows[0] : null;
  }

  async scalar(sql: string, args: ValueType[] = []): Promise<number> {
    const v = await this.queryOne<number>(sql, (r) => r.num('v'), args);
    return v === null ? 0 : v;
  }

  /** 列顺序取自同步白名单，保证写入与上载荷同一形状 */
  async upsertRow(row: SyncRow): Promise<void> {
    const cols = columnsOf(row.table());
    if (cols === null) {
      throw new Error(`未知同步表: ${row.table()}`);
    }
    const sql = `INSERT OR REPLACE INTO ${row.table()} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    await this.exec(sql, orderedValues(row));
  }

  // ---- timer_item ----

  private static mapItem(r: RsReader): TimerItem {
    const e = new TimerItem();
    e.id = r.strOr('id', '');
    e.user_id = r.str('user_id');
    e.name = r.strOr('name', '');
    e.type = r.strOr('type', 'PRECISE_COUNTDOWN');
    e.color = r.str('color');
    e.starred = r.bool('starred');
    e.pinned = r.bool('pinned');
    e.remark = r.str('remark');
    e.config_json = r.str('config_json');
    e.run_state = r.strOr('run_state', 'idle');
    e.session_id = r.str('session_id');
    e.run_json = r.str('run_json');
    e.version = r.num('version');
    e.updated_at = r.num('updated_at');
    e.deleted = r.bool('deleted');
    e.origin_device_id = r.str('origin_device_id');
    return e;
  }

  async timers(): Promise<TimerItem[]> {
    return this.query<TimerItem>(
      'SELECT * FROM timer_item WHERE deleted = 0 ORDER BY pinned DESC, starred DESC, updated_at DESC',
      (r) => LocalDb.mapItem(r));
  }

  async timerById(id: string): Promise<TimerItem | null> {
    return this.queryOne<TimerItem>('SELECT * FROM timer_item WHERE id = ?', (r) => LocalDb.mapItem(r), [id]);
  }

  async runningTimers(): Promise<TimerItem[]> {
    return this.query<TimerItem>("SELECT * FROM timer_item WHERE deleted = 0 AND run_state = 'running'", (r) => LocalDb.mapItem(r));
  }

  async allTimerRows(): Promise<TimerItem[]> {
    return this.query<TimerItem>('SELECT * FROM timer_item', (r) => LocalDb.mapItem(r));
  }

  // ---- timer_record ----

  private static mapRecord(r: RsReader): TimerRecord {
    const e = new TimerRecord();
    e.id = r.strOr('id', '');
    e.user_id = r.str('user_id');
    e.timer_id = r.strOr('timer_id', '');
    e.session_id = r.str('session_id');
    e.started_at = r.num('started_at');
    e.ended_at = r.num('ended_at');
    e.duration_sec = r.num('duration_sec');
    e.record_type = r.strOr('record_type', 'SEGMENT');
    e.version = r.num('version');
    e.updated_at = r.num('updated_at');
    e.deleted = r.bool('deleted');
    e.origin_device_id = r.str('origin_device_id');
    return e;
  }

  async recordsOfTimerSince(timerId: string, since: number): Promise<TimerRecord[]> {
    return this.query<TimerRecord>(
      'SELECT * FROM timer_record WHERE timer_id = ? AND deleted = 0 AND ended_at >= ? ORDER BY ended_at DESC',
      (r) => LocalDb.mapRecord(r), [timerId, since]);
  }

  async allRecords(): Promise<TimerRecord[]> {
    return this.query<TimerRecord>('SELECT * FROM timer_record', (r) => LocalDb.mapRecord(r));
  }

  /** 统计投影：只取聚合用到的列（与 Android observeStatRows 同形） */
  async statRecords(): Promise<TimerRecord[]> {
    return this.query<TimerRecord>('SELECT timer_id, ended_at, record_type, duration_sec FROM timer_record WHERE deleted = 0',
      (r) => LocalDb.mapRecord(r));
  }

  /** 历史页用：整行 + 未删除 + 按结束时间倒序 */
  async liveRecords(): Promise<TimerRecord[]> {
    return this.query<TimerRecord>('SELECT * FROM timer_record WHERE deleted = 0 ORDER BY ended_at DESC',
      (r) => LocalDb.mapRecord(r));
  }

  async recordById(id: string): Promise<TimerRecord | null> {
    return this.queryOne<TimerRecord>('SELECT * FROM timer_record WHERE id = ?', (r) => LocalDb.mapRecord(r), [id]);
  }

  // ---- 其余同步表 ----

  private static mapTag(r: RsReader): Tag {
    const e = new Tag();
    e.id = r.strOr('id', ''); e.user_id = r.str('user_id'); e.name = r.strOr('name', '');
    e.color = r.str('color'); e.version = r.num('version'); e.updated_at = r.num('updated_at');
    e.deleted = r.bool('deleted'); e.origin_device_id = r.str('origin_device_id');
    return e;
  }

  private static mapTimerTag(r: RsReader): TimerTag {
    const e = new TimerTag();
    e.id = r.strOr('id', ''); e.user_id = r.str('user_id'); e.timer_id = r.strOr('timer_id', '');
    e.tag_id = r.strOr('tag_id', ''); e.version = r.num('version'); e.updated_at = r.num('updated_at');
    e.deleted = r.bool('deleted'); e.origin_device_id = r.str('origin_device_id');
    return e;
  }

  private static mapMilestone(r: RsReader): Milestone {
    const e = new Milestone();
    e.id = r.strOr('id', ''); e.user_id = r.str('user_id'); e.timer_id = r.strOr('timer_id', '');
    e.note = r.strOr('note', ''); e.marked_at = r.num('marked_at'); e.version = r.num('version');
    e.updated_at = r.num('updated_at'); e.deleted = r.bool('deleted');
    e.origin_device_id = r.str('origin_device_id');
    return e;
  }

  async allTags(): Promise<Tag[]> {
    return this.query<Tag>('SELECT * FROM tag', (r) => LocalDb.mapTag(r));
  }

  async allTimerTags(): Promise<TimerTag[]> {
    return this.query<TimerTag>('SELECT * FROM timer_tag', (r) => LocalDb.mapTimerTag(r));
  }

  async allMilestones(): Promise<Milestone[]> {
    return this.query<Milestone>('SELECT * FROM milestone', (r) => LocalDb.mapMilestone(r));
  }

  /** 未删除的标签，按名字排序（与 Windows listTags 同口径） */
  async liveTagsByName(): Promise<Tag[]> {
    return this.query<Tag>('SELECT * FROM tag WHERE deleted = 0 ORDER BY name', (r) => LocalDb.mapTag(r));
  }

  async tagByName(name: string): Promise<Tag | null> {
    return this.queryOne<Tag>("SELECT * FROM tag WHERE name = ? AND deleted = 0", (r) => LocalDb.mapTag(r), [name]);
  }

  async tagById(id: string): Promise<Tag | null> {
    return this.queryOne<Tag>('SELECT * FROM tag WHERE id = ?', (r) => LocalDb.mapTag(r), [id]);
  }

  async timerTagById(id: string): Promise<TimerTag | null> {
    return this.queryOne<TimerTag>('SELECT * FROM timer_tag WHERE id = ?', (r) => LocalDb.mapTimerTag(r), [id]);
  }

  async timerTagsOfTimer(timerId: string): Promise<TimerTag[]> {
    return this.query<TimerTag>("SELECT * FROM timer_tag WHERE timer_id = ? AND deleted = 0",
      (r) => LocalDb.mapTimerTag(r), [timerId]);
  }

  /** 计时↔标签连接（列表/详情展示用，按标签名排序） */
  async timerTagJoin(): Promise<TimerTag[]> {
    return this.query<TimerTag>(
      'SELECT tt.* FROM timer_tag tt JOIN tag g ON g.id = tt.tag_id WHERE tt.deleted = 0 AND g.deleted = 0 ORDER BY g.name',
      (r) => LocalDb.mapTimerTag(r));
  }

  async milestonesOf(timerId: string): Promise<Milestone[]> {
    return this.query<Milestone>('SELECT * FROM milestone WHERE timer_id = ? AND deleted = 0 ORDER BY marked_at DESC',
      (r) => LocalDb.mapMilestone(r), [timerId]);
  }

  async milestoneById(id: string): Promise<Milestone | null> {
    return this.queryOne<Milestone>('SELECT * FROM milestone WHERE id = ?', (r) => LocalDb.mapMilestone(r), [id]);
  }

  /** 登录后认领无主数据（与 Android adoptOrphans 一致） */
  async adoptOrphans(uid: string): Promise<void> {
    const tables: string[] = ['timer_item', 'timer_record', 'tag', 'timer_tag', 'milestone'];
    for (let i = 0; i < tables.length; i++) {
      await this.exec(`UPDATE ${tables[i]} SET user_id = ? WHERE user_id IS NULL`, [uid]);
    }
  }

  // ---- pending_ops（仅本地，§4.5）----

  async enqueue(op: PendingOp): Promise<void> {
    await this.exec(
      'INSERT OR REPLACE INTO pending_ops (operation_id, table_name, op_type, row_id, row_payload, base_version, is_run, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [op.operation_id, op.table_name, op.op_type, op.row_id, op.row_payload,
        op.base_version, op.is_run ? 1 : 0, op.created_at, op.state]);
  }

  async queuedOps(limit: number): Promise<PendingOp[]> {
    return this.query<PendingOp>(
      `SELECT * FROM pending_ops WHERE state = 'queued' ORDER BY created_at LIMIT ${limit}`, (r) => {
        const o = new PendingOp();
        o.operation_id = r.strOr('operation_id', '');
        o.table_name = r.strOr('table_name', '');
        o.op_type = r.strOr('op_type', '');
        o.row_id = r.strOr('row_id', '');
        o.row_payload = r.strOr('row_payload', '{}');
        o.base_version = r.numOrNull('base_version');
        o.is_run = r.bool('is_run');
        o.created_at = r.num('created_at');
        o.state = r.strOr('state', 'queued');
        return o;
      });
  }

  async deleteOp(opId: string): Promise<void> {
    await this.exec('DELETE FROM pending_ops WHERE operation_id = ?', [opId]);
  }

  /** 登出时清空待发队列（里面是上一个账号的写，换账号再推只会往新账号名下搬） */
  async clearOps(): Promise<void> {
    await this.exec('DELETE FROM pending_ops');
  }

  async dirtyCount(table: string, rowId: string): Promise<number> {
    return this.scalar("SELECT COUNT(*) AS v FROM pending_ops WHERE table_name = ? AND row_id = ? AND state = 'queued'",
      [table, rowId]);
  }

  async queuedCount(): Promise<number> {
    return this.scalar("SELECT COUNT(*) AS v FROM pending_ops WHERE state = 'queued'");
  }

  // ---- meta ----

  async metaGet(key: string): Promise<string | null> {
    return this.queryOne<string>('SELECT value AS v FROM meta WHERE key = ?', (r) => r.strOr('v', ''), [key]);
  }

  async metaSet(key: string, value: string): Promise<void> {
    await this.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
  }
}
