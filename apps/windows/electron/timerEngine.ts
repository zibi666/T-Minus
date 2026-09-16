// 计时引擎（§3 计时状态与恢复规则）
// 原则：持久化的是状态机 + 基准字段；展示值永远现场计算；绝不用 tick 累加写库。
// 进程内存活期间用单调时钟（process.hrtime）测量间隔，防御系统时间被改（§3.6）。
import { LocalDB, uuid, safeParse } from './db';
import { remainingDays } from './dateLogic';
import { TimerDTO, RunState, CreateTimerInput, UpdateTimerPatch, RecordDTO } from '../src/shared/types';

interface RunJson {
  // PRECISE
  target_at?: number;
  remaining_at_pause?: number;
  // STOPWATCH
  accumulated_ms?: number;
  segment_started_at?: number;
  // 手动分段：已完成分段时长列表（PRECISE=各轮实际用时；STOPWATCH=各 lap 用时）
  segments_ms?: number[];
}

interface Runtime {
  row: any;
  segStartMonoNs: bigint | null; // 当前段起点（单调时钟）
  segStartRemainingMs?: number;  // PRECISE：段起点剩余
  segStartElapsedMs?: number;    // STOPWATCH：段起点累计
}

const MONO_GUARD_MS = 2000;

/** 标签色板（按名称哈希取色，全端一致） */
const TAG_COLORS = ['#4DC9F0', '#9381FF', '#21E0C4', '#FFB224', '#FF6B6B', '#5A9EFF', '#3DDB97', '#FF9F43'];

export class TimerEngine {
  private timers = new Map<string, Runtime>();
  /** timerId → 标签名列表（tag / timer_tag 联表内存映射，refreshTags 重建） */
  private tagsByTimer = new Map<string, string[]>();
  /** 精确倒计时到点回调（main 用于发通知） */
  onFinish: ((row: any) => void) | null = null;
  /** 同步入队钩子（main 注入 SyncClient.enqueue）；null = 未登录不同步 */
  queueOp: ((op: { table: string; opType: 'create' | 'update' | 'delete'; row: any; baseVersion?: number | null; isRun?: boolean }) => void) | null = null;
  /** 当前登录用户 id（创建行时写入 user_id） */
  currentUserId: string | null = null;

  constructor(private db: LocalDB, private deviceId: string) {}

  private monoNs(): bigint {
    return process.hrtime.bigint();
  }
  private monoDeltaMs(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  /** 启动加载：running 状态以持久化字段恢复；跨重启无单调基准，按 §3.1 已知边界处理 */
  load(): void {
    this.loadTags();
    const rows = this.db.all('SELECT * FROM timer_item WHERE deleted = 0');
    for (const row of rows) {
      const rt: Runtime = { row, segStartMonoNs: null };
      if (row.run_state === 'running') {
        const run: RunJson = safeParse(row.run_json);
        const nowWall = Date.now();
        if (row.type === 'PRECISE_COUNTDOWN' && run.target_at) {
          rt.segStartRemainingMs = Math.max(0, run.target_at - nowWall);
          rt.segStartMonoNs = this.monoNs();
        } else if (row.type === 'STOPWATCH') {
          const acc = run.accumulated_ms ?? 0;
          rt.segStartElapsedMs = acc + (run.segment_started_at ? Math.max(0, nowWall - run.segment_started_at) : 0);
          rt.segStartMonoNs = this.monoNs();
        }
      }
      this.timers.set(row.id, rt);
    }
  }

  list(): TimerDTO[] {
    return [...this.timers.values()].filter((rt) => !rt.row.deleted).map((rt) => this.dto(rt));
  }

  get(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    return rt && !rt.row.deleted ? this.dto(rt) : null;
  }

  /** 同步拉回远程变更后刷新运行时基线（§5.3 应用规则） */
  reloadRow(id: string): void {
    const row = this.db.get('SELECT * FROM timer_item WHERE id = ?', [id]);
    if (!row) {
      this.timers.delete(id);
      return;
    }
    const rt = this.timers.get(id);
    if (rt) {
      rt.row = row;
      rt.segStartMonoNs = null;
      if (row.run_state === 'running') {
        const run: RunJson = safeParse(row.run_json);
        const nowWall = Date.now();
        if (row.type === 'PRECISE_COUNTDOWN' && run.target_at) {
          rt.segStartRemainingMs = Math.max(0, run.target_at - nowWall);
          rt.segStartMonoNs = this.monoNs();
        } else if (row.type === 'STOPWATCH') {
          const acc = run.accumulated_ms ?? 0;
          rt.segStartElapsedMs = acc + (run.segment_started_at ? Math.max(0, nowWall - run.segment_started_at) : 0);
          rt.segStartMonoNs = this.monoNs();
        }
      }
    } else if (!row.deleted) {
      this.timers.set(id, { row, segStartMonoNs: null });
    }
  }

  // ---------- 状态机（§3.3 / §3.4） ----------

  start(id: string, payload?: { durationMs?: number }): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    const nowWall = Date.now();
    const sessionId = uuid(); // 每次进入 running 生成新 session（§3.1）
    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      const cfg = safeParse(rt.row.config_json);
      const dur = Math.round(payload?.durationMs ?? cfg.preset_ms ?? 0);
      if (dur <= 0) return null;
      rt.row.run_json = JSON.stringify({ target_at: nowWall + dur });
      rt.segStartRemainingMs = dur;
      rt.segStartMonoNs = this.monoNs();
    } else if (rt.row.type === 'STOPWATCH') {
      rt.row.run_json = JSON.stringify({ accumulated_ms: 0, segment_started_at: nowWall });
      rt.segStartElapsedMs = 0;
      rt.segStartMonoNs = this.monoNs();
    } else {
      return this.dto(rt); // DATE_COUNTDOWN 无运行状态
    }
    rt.row.run_state = 'running';
    rt.row.session_id = sessionId;
    this.persistRun(rt);
    return this.dto(rt);
  }

  pause(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.run_state !== 'running' || !rt.segStartMonoNs) return null;
    const run: RunJson = safeParse(rt.row.run_json);
    const segs = Array.isArray(run.segments_ms) ? run.segments_ms : [];
    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      const remaining = Math.max(0, Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(rt.segStartMonoNs)));
      rt.row.run_json = JSON.stringify({ remaining_at_pause: remaining, segments_ms: segs });
    } else if (rt.row.type === 'STOPWATCH') {
      const elapsed = Math.round(rt.segStartElapsedMs! + this.monoDeltaMs(rt.segStartMonoNs));
      rt.row.run_json = JSON.stringify({ accumulated_ms: elapsed, segments_ms: segs });
    }
    rt.row.run_state = 'paused';
    rt.segStartMonoNs = null;
    this.persistRun(rt);
    return this.dto(rt);
  }

  resume(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.run_state !== 'paused') return null;
    const nowWall = Date.now();
    const run: RunJson = safeParse(rt.row.run_json);
    const segs = Array.isArray(run.segments_ms) ? run.segments_ms : [];
    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      const rem = run.remaining_at_pause ?? 0; // 暂停存剩余，继续时重算截止时间（§3.3）
      rt.row.run_json = JSON.stringify({ target_at: nowWall + rem, segments_ms: segs });
      rt.segStartRemainingMs = rem;
      rt.segStartMonoNs = this.monoNs();
    } else if (rt.row.type === 'STOPWATCH') {
      const acc = run.accumulated_ms ?? 0; // 继续不改累计，只开新段（§3.4）
      rt.row.run_json = JSON.stringify({ accumulated_ms: acc, segment_started_at: nowWall, segments_ms: segs });
      rt.segStartElapsedMs = acc;
      rt.segStartMonoNs = this.monoNs();
    }
    rt.row.run_state = 'running';
    this.persistRun(rt);
    return this.dto(rt);
  }

  reset(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt) return null;
    rt.row.run_state = 'idle';
    rt.row.session_id = null;
    rt.row.run_json = null;
    rt.segStartMonoNs = null;
    this.persistRun(rt);
    return this.dto(rt);
  }

  /** 正计时停止：写记录并归零（§3.4） */
  stop(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.type !== 'STOPWATCH' || rt.row.run_state === 'idle') return null;
    const run: RunJson = safeParse(rt.row.run_json);
    const total = rt.row.run_state === 'running' && rt.segStartMonoNs
      ? Math.round(rt.segStartElapsedMs! + this.monoDeltaMs(rt.segStartMonoNs))
      : Math.round(run.accumulated_ms ?? 0);
    this.insertRecord(rt, Date.now() - total, Date.now(), Math.round(total / 1000), 'STOPWATCH');
    return this.reset(id);
  }

  /**
   * 手动分段 / 提前结束结算：
   * - 精确倒计时（v3 打点语义，规范 §2）：不打断、不重置倒计时，仅记录本段时长
   *   （段时长 = 相邻打点之差 = 总已过 - 已完成段之和）；session 不变；
   * - 正计时：记一个 lap（上段时长），继续累计不中断；
   * - **暂停态同样可结算**：按暂停时刻的已进行时长记账（总已过 = preset - remaining_at_pause
   *   / accumulated_ms），如实保存"提前结束"的部分进度，不丢数据。
   */
  segment(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    const running = rt.row.run_state === 'running' && !!rt.segStartMonoNs;
    const paused = rt.row.run_state === 'paused';
    if (!running && !paused) return null;
    const nowWall = Date.now();
    const run: RunJson = safeParse(rt.row.run_json);
    const segs = Array.isArray(run.segments_ms) ? run.segments_ms.slice() : [];

    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      const cfg = safeParse(rt.row.config_json);
      const preset = Math.max(1, Math.round(cfg.preset_ms ?? 0));
      const totalElapsed = running
        ? Math.max(0, preset - Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(rt.segStartMonoNs!)))
        : Math.max(0, preset - Math.round(run.remaining_at_pause ?? 0));
      const seg = totalElapsed - segs.reduce((a, b) => a + b, 0);
      if (seg <= 0) return this.dto(rt);
      segs.push(seg);
      this.insertRecord(rt, nowWall - seg, nowWall, Math.round(seg / 1000), 'SEGMENT');
      // 运行中：target_at 与内部单调基准原样保留 → 倒计时无缝继续；
      // 暂停中：保留 remaining_at_pause，继续后逻辑不变
      rt.row.run_json = running
        ? JSON.stringify({ target_at: run.target_at, segments_ms: segs })
        : JSON.stringify({ remaining_at_pause: run.remaining_at_pause ?? 0, segments_ms: segs });
    } else if (rt.row.type === 'STOPWATCH') {
      const total = running
        ? Math.round(rt.segStartElapsedMs! + this.monoDeltaMs(rt.segStartMonoNs!))
        : Math.round(run.accumulated_ms ?? 0);
      const lap = total - segs.reduce((a, b) => a + b, 0);
      if (lap <= 0) return this.dto(rt);
      segs.push(lap);
      this.insertRecord(rt, nowWall - lap, nowWall, Math.round(lap / 1000), 'SEGMENT');
      rt.row.run_json = running
        ? JSON.stringify({ accumulated_ms: total, segment_started_at: nowWall, segments_ms: segs })
        : JSON.stringify({ accumulated_ms: total, segments_ms: segs });
    } else {
      return this.dto(rt); // DATE_COUNTDOWN 无运行状态
    }
    this.persistRun(rt);
    return this.dto(rt);
  }

  /** 周期调用：精确倒计时到点结算 + 单调时钟守卫（§3.6） */
  tick(): void {    for (const rt of this.timers.values()) {
      if (rt.row.deleted || rt.row.run_state !== 'running' || !rt.segStartMonoNs) continue;
      if (rt.row.type !== 'PRECISE_COUNTDOWN') continue;
      const monoDelta = this.monoDeltaMs(rt.segStartMonoNs);
      const remainingByMono = rt.segStartRemainingMs! - monoDelta;
      const run: RunJson = safeParse(rt.row.run_json);
      const remainingByWall = (run.target_at ?? 0) - Date.now();
      if (Math.abs(remainingByMono - remainingByWall) > MONO_GUARD_MS) {
        // 系统时间被修改：以单调时钟差值修正内部基准（保留打点分段）
        rt.row.run_json = JSON.stringify({ target_at: Date.now() + Math.max(0, remainingByMono), segments_ms: run.segments_ms });
        rt.segStartRemainingMs = remainingByMono;
        rt.segStartMonoNs = this.monoNs();
        console.warn('[clock-adjusted] 系统时间变动，已按单调时钟修正:', rt.row.name);
      }
      if (remainingByMono <= 0) this.finishPrecise(rt);
    }
  }

  // ---------- CRUD ----------

  create(input: CreateTimerInput): TimerDTO | null {
    const type = input.type;
    if (!input.name || !['DATE_COUNTDOWN', 'PRECISE_COUNTDOWN', 'STOPWATCH'].includes(type)) return null;
    const now = Date.now();
    const raw: any = input.config ?? {};
    let config: any;
    if (type === 'DATE_COUNTDOWN') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.target_date ?? '')) return null;
      config = {
        schema_version: 1,
        target_date: raw.target_date,
        timezone_id: raw.timezone_id || Intl.DateTimeFormat().resolvedOptions().timeZone,
        include_today: !!raw.include_today
      };
    } else if (type === 'PRECISE_COUNTDOWN') {
      const preset = Math.round(raw.preset_ms ?? 0);
      if (preset <= 0) return null;
      config = { schema_version: 1, preset_ms: preset };
    } else {
      config = { schema_version: 1 };
    }
    const id = uuid();
    this.db.run(
      `INSERT INTO timer_item (id, user_id, name, type, color, starred, pinned, remark, config_json,
        run_state, session_id, run_json, version, updated_at, deleted, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, 1, ?, 0, ?)`,
      [id, this.currentUserId, input.name, type, input.color || '#E5484D', input.starred ? 1 : 0, input.pinned ? 1 : 0,
        input.remark || '', JSON.stringify(config), now, this.deviceId]
    );
    const row = this.db.get('SELECT * FROM timer_item WHERE id = ?', [id]);
    const rt: Runtime = { row, segStartMonoNs: null };
    this.timers.set(id, rt);
    this.queueOp?.({ table: 'timer_item', opType: 'create', row: { ...rt.row }, baseVersion: 0, isRun: false });
    return this.dto(rt);
  }

  update(id: string, patch: UpdateTimerPatch): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    const row = rt.row;
    if (patch.name !== undefined) row.name = String(patch.name).slice(0, 100) || row.name;
    if (patch.color !== undefined) row.color = patch.color;
    if (patch.remark !== undefined) row.remark = patch.remark;
    if (patch.starred !== undefined) row.starred = patch.starred ? 1 : 0;
    if (patch.pinned !== undefined) row.pinned = patch.pinned ? 1 : 0;
    if (patch.config !== undefined) {
      // 运行中不允许改精确倒计时目标结构，避免状态悬空
      if (row.run_state === 'idle' || row.type !== 'PRECISE_COUNTDOWN') {
        row.config_json = JSON.stringify(patch.config);
      }
    }
    const baseVersion = row.version;
    row.version = baseVersion + 1;
    row.updated_at = Date.now();
    this.db.run(
      `UPDATE timer_item SET name=?, color=?, starred=?, pinned=?, remark=?, config_json=?, version=?, updated_at=? WHERE id=?`,
      [row.name, row.color, row.starred, row.pinned, row.remark, row.config_json, row.version, row.updated_at, id]
    );
    this.queueOp?.({ table: 'timer_item', opType: 'update', row: { ...row }, baseVersion, isRun: false });
    return this.dto(rt);
  }

  /** 软删除墓碑（M2 同步 ready） */
  remove(id: string): boolean {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return false;
    const baseVersion = rt.row.version;
    rt.row.deleted = 1;
    rt.row.version = baseVersion + 1;
    rt.row.updated_at = Date.now();
    this.db.run('UPDATE timer_item SET deleted=1, version=?, updated_at=? WHERE id=?', [rt.row.version, rt.row.updated_at, id]);
    this.queueOp?.({ table: 'timer_item', opType: 'delete', row: { ...rt.row }, baseVersion, isRun: false });
    return true;
  }

  allRows(): any[] {
    return this.db.all('SELECT * FROM timer_item');
  }

  /** 全部计时元数据（含已删除，供历史页保留已删计时的记录并标注） */
  listMetas(): Array<{ id: string; name: string; color: string; type: string; config: any; deleted: boolean }> {
    return this.db.all('SELECT id, name, color, type, config_json, deleted FROM timer_item').map((r: any) => ({
      id: String(r.id),
      name: String(r.name),
      color: String(r.color ?? '#E5484D'),
      type: String(r.type),
      config: safeParse(r.config_json),
      deleted: Number(r.deleted) === 1
    }));
  }

  /** 近期计时记录（只读，供历史回看与今日概览统计；ended_at 倒序） */
  listRecentRecords(limit = 300): RecordDTO[] {
    const rows = this.db.all(
      'SELECT * FROM timer_record WHERE deleted = 0 ORDER BY ended_at DESC LIMIT ?',
      [Math.max(1, Math.min(1000, Math.round(limit)))]
    );
    return rows.map((r) => ({
      id: String(r.id),
      timerId: String(r.timer_id),
      sessionId: r.session_id ?? null,
      startedAt: Number(r.started_at ?? 0),
      endedAt: Number(r.ended_at ?? 0),
      durationSec: Number(r.duration_sec ?? 0),
      recordType: String(r.record_type ?? '')
    }));
  }

  /** 删除计时记录（软删除墓碑，随同步收敛到服务端）；返回实际删除数 */
  deleteRecords(ids: string[]): number {
    let n = 0;
    const now = Date.now();
    for (const id of ids) {
      const row = this.db.get('SELECT * FROM timer_record WHERE id = ?', [String(id)]);
      if (!row || Number(row.deleted) === 1) continue;
      const newVersion = Number(row.version ?? 1) + 1;
      this.db.run('UPDATE timer_record SET deleted=1, version=?, updated_at=? WHERE id=?', [newVersion, now, String(id)]);
      this.queueOp?.({
        table: 'timer_record', opType: 'delete', baseVersion: Number(row.version ?? 1), isRun: false,
        row: { ...row, deleted: 1, version: newVersion, updated_at: now }
      });
      n++;
    }
    return n;
  }

  // ---------- 标签（tag / timer_tag，同步契约已有两表） ----------

  /** 重建 timerId → 标签名 内存映射 */
  refreshTags(): void {
    const rows = this.db.all(
      `SELECT tt.timer_id AS tid, t.name AS name
       FROM timer_tag tt JOIN tag t ON t.id = tt.tag_id
       WHERE tt.deleted = 0 AND t.deleted = 0 ORDER BY t.name`
    );
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const key = String(r.tid);
      const arr = map.get(key) ?? [];
      arr.push(String(r.name));
      map.set(key, arr);
    }
    this.tagsByTimer = map;
  }

  private loadTags(): void {
    this.refreshTags();
  }

  /** 全部标签（供表单联想与筛选） */
  listTags(): Array<{ id: string; name: string; color: string }> {
    return this.db.all('SELECT id, name, color FROM tag WHERE deleted = 0 ORDER BY name').map((r: any) => ({
      id: String(r.id), name: String(r.name), color: String(r.color ?? '#4DC9F0')
    }));
  }

  /** 设置某计时的标签集合（按名对齐；新名建 tag，缺的建 link，多的打墓碑） */
  setTimerTags(id: string, names: string[]): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    const clean = [...new Set(names.map((n) => String(n).trim().slice(0, 20)).filter(Boolean))].slice(0, 8);
    const now = Date.now();

    const keepTagIds = new Set<string>();
    for (const name of clean) {
      let tag = this.db.get('SELECT * FROM tag WHERE name = ? AND deleted = 0', [name]);
      if (!tag) {
        const color = TAG_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TAG_COLORS.length];
        const tid = uuid();
        this.db.run(
          'INSERT INTO tag (id, user_id, name, color, version, updated_at, deleted, origin_device_id) VALUES (?, ?, ?, ?, 1, ?, 0, ?)',
          [tid, this.currentUserId, name, color, now, this.deviceId]
        );
        this.queueOp?.({
          table: 'tag', opType: 'create', baseVersion: 0, isRun: false,
          row: { id: tid, user_id: this.currentUserId, name, color, version: 1, updated_at: now, deleted: 0, origin_device_id: this.deviceId }
        });
        tag = { id: tid };
      }
      const tagId = String(tag.id);
      keepTagIds.add(tagId);
      const link = this.db.get(
        'SELECT id FROM timer_tag WHERE timer_id = ? AND tag_id = ? AND deleted = 0', [String(id), tagId]
      );
      if (!link) {
        const lid = uuid();
        this.db.run(
          'INSERT INTO timer_tag (id, user_id, timer_id, tag_id, version, updated_at, deleted, origin_device_id) VALUES (?, ?, ?, ?, 1, ?, 0, ?)',
          [lid, this.currentUserId, String(id), tagId, now, this.deviceId]
        );
        this.queueOp?.({
          table: 'timer_tag', opType: 'create', baseVersion: 0, isRun: false,
          row: { id: lid, user_id: this.currentUserId, timer_id: String(id), tag_id: tagId, version: 1, updated_at: now, deleted: 0, origin_device_id: this.deviceId }
        });
      }
    }

    const existing = this.db.all(
      'SELECT id, tag_id, version FROM timer_tag WHERE timer_id = ? AND deleted = 0', [String(id)]
    );
    for (const row of existing) {
      const tagId = String(row.tag_id);
      if (keepTagIds.has(tagId)) continue;
      const newVersion = Number(row.version ?? 1) + 1;
      this.db.run('UPDATE timer_tag SET deleted=1, version=?, updated_at=? WHERE id=?', [newVersion, now, String(row.id)]);
      this.queueOp?.({
        table: 'timer_tag', opType: 'delete', baseVersion: Number(row.version ?? 1), isRun: false,
        row: { id: String(row.id), timer_id: String(id), tag_id: tagId, version: newVersion, updated_at: now, deleted: 1, origin_device_id: this.deviceId }
      });
    }

    this.refreshTags();
    return this.dto(rt);
  }

  // ---------- 内部 ----------

  private finishPrecise(rt: Runtime): void {
    const nowWall = Date.now();
    const cfg = safeParse(rt.row.config_json);
    const duration = Math.max(1, Math.round(cfg.preset_ms ?? 0));
    this.insertRecord(rt, nowWall - duration, nowWall, Math.round(duration / 1000), 'PRECISE');
    rt.row.run_state = 'idle';
    rt.row.session_id = null;
    rt.row.run_json = null;
    rt.segStartMonoNs = null;
    this.persistRun(rt);
    if (this.onFinish) this.onFinish(rt.row);
  }

  private insertRecord(rt: Runtime, startedAt: number, endedAt: number, durationSec: number, recordType: string): void {
    const recId = uuid();
    this.db.run(
      `INSERT INTO timer_record (id, user_id, timer_id, session_id, started_at, ended_at, duration_sec,
        record_type, version, updated_at, deleted, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?)`,
      [recId, this.currentUserId, rt.row.id, rt.row.session_id, startedAt, endedAt, durationSec, recordType, endedAt, this.deviceId]
    );
    this.queueOp?.({
      table: 'timer_record', opType: 'create', baseVersion: 0, isRun: false,
      row: {
        id: recId, user_id: this.currentUserId, timer_id: rt.row.id, session_id: rt.row.session_id,
        started_at: startedAt, ended_at: endedAt, duration_sec: durationSec, record_type: recordType,
        version: 1, updated_at: endedAt, deleted: 0, origin_device_id: this.deviceId
      }
    });
  }

  private persistRun(rt: Runtime): void {
    const baseVersion = rt.row.version;
    rt.row.version = baseVersion + 1;
    rt.row.updated_at = Date.now();
    this.db.run(
      'UPDATE timer_item SET run_state=?, session_id=?, run_json=?, version=?, updated_at=? WHERE id=?',
      [rt.row.run_state, rt.row.session_id, rt.row.run_json, rt.row.version, rt.row.updated_at, rt.row.id]
    );
    this.queueOp?.({ table: 'timer_item', opType: 'update', row: { ...rt.row }, baseVersion, isRun: true });
  }

  private dto(rt: Runtime): TimerDTO {
    const row = rt.row;
    const cfg = safeParse(row.config_json);
    const base: any = {
      id: row.id,
      name: row.name,
      type: row.type,
      color: row.color,
      starred: !!row.starred,
      pinned: !!row.pinned,
      remark: row.remark || '',
      config: cfg,
      runState: row.run_state as RunState,
      tags: this.tagsByTimer.get(row.id) ?? [],
      updatedAt: row.updated_at,
      version: row.version
    };
    if (row.type === 'DATE_COUNTDOWN') {
      base.targetDate = cfg.target_date;
      base.timezoneId = cfg.timezone_id;
      base.includeToday = !!cfg.include_today;
      base.daysLeft = remainingDays(cfg.target_date, cfg.timezone_id, !!cfg.include_today);
    } else if (row.type === 'PRECISE_COUNTDOWN') {
      if (row.run_state === 'running' && rt.segStartMonoNs) {
        base.remainingMs = Math.max(0, Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(rt.segStartMonoNs)));
      } else if (row.run_state === 'paused') {
        base.remainingMs = safeParse(row.run_json).remaining_at_pause ?? 0;
      }
      const segs = safeParse(row.run_json).segments_ms;
      if (Array.isArray(segs) && segs.length > 0) base.segmentsMs = segs;
    } else if (row.type === 'STOPWATCH') {
      if (row.run_state === 'running' && rt.segStartMonoNs) {
        base.elapsedMs = Math.round(rt.segStartElapsedMs! + this.monoDeltaMs(rt.segStartMonoNs));
      } else if (row.run_state === 'paused') {
        base.elapsedMs = safeParse(row.run_json).accumulated_ms ?? 0;
      } else {
        base.elapsedMs = 0;
      }
      const segs = safeParse(row.run_json).segments_ms;
      if (Array.isArray(segs) && segs.length > 0) base.segmentsMs = segs;
    }
    return base as TimerDTO;
  }
}
