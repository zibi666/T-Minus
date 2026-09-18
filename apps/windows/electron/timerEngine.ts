// 计时引擎（§3 计时状态与恢复规则）
// 原则：持久化的是状态机 + 基准字段；展示值永远现场计算；绝不用 tick 累加写库。
// 进程内存活期间用单调时钟（process.hrtime）测量间隔，防御系统时间被改（§3.6）。
// 番茄钟默认值/夹紧/阶段判定/统计口径一律来自 src/shared/contract.ts（跨端单一来源）。
import { LocalDB, uuid, safeParse } from './db';
import { remainingDays } from './dateLogic';
import { localDateKey } from '../src/shared/format';
import { TimerDTO, RunState, CreateTimerInput, UpdateTimerPatch, RecordDTO, TimerMeta, DayStatDTO, UpdateResultDTO, TimerConfigView } from '../src/shared/types';
import {
  MONO_GUARD_MS, PARTIAL_SETTLE_MIN_MS, PHASE_FOCUS, PHASE_BREAK, PHASE_LONG_BREAK, RECORD, RUN_STATE,
  TIMER_TYPES, SYNC_TABLE_COLUMNS,
  PomodoroPhase, NormalizedPomodoro, isPomodoroConfig, normalizePomodoro, phasePresetMs,
  isLongBreakDue, tagColorFor, contribute, sumContribution, EMPTY_CONTRIBUTION,
  buildPomodoroConfig, buildPreciseConfig, DEFAULT_TIMER_COLOR, Contribution
} from '../src/shared/contract';

interface RunJson {
  // PRECISE
  target_at?: number;
  remaining_at_pause?: number;
  // STOPWATCH
  accumulated_ms?: number;
  segment_started_at?: number;
  // 手动分段：已完成分段时长列表（PRECISE=各轮实际用时；STOPWATCH=各 lap 用时）
  segments_ms?: number[];
  // POMODORO（阶段状态存 run_json 参与同步，与 Android 逐字对齐）
  phase?: PomodoroPhase;
  phase_ends_at?: number;
  completed_focus?: number;
}

/** timer_item 行（sql.js 边界处归一，避免 any 散落到引擎内部） */
export interface TimerRow {
  id: string;
  user_id: string | null;
  name: string;
  type: string;
  color: string | null;
  starred: number;
  pinned: number;
  remark: string | null;
  config_json: string | null;
  run_state: string;
  session_id: string | null;
  run_json: string | null;
  version: number;
  updated_at: number;
  deleted: number;
  origin_device_id: string | null;
}

interface Runtime {
  row: TimerRow;
  segStartMonoNs: bigint | null; // 当前段起点（单调时钟）
  segStartRemainingMs?: number;  // PRECISE：段起点剩余
  segStartElapsedMs?: number;    // STOPWATCH：段起点累计
}

/** 更新结果：配置是否被接受回传，避免表单静默保存后什么都没发生 */
export type UpdateResult = UpdateResultDTO;

const s = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const n = (v: unknown, fallback = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

function rowOf(raw: Record<string, unknown>): TimerRow {
  return {
    id: String(raw.id),
    user_id: s(raw.user_id),
    name: String(raw.name ?? ''),
    type: String(raw.type ?? ''),
    color: s(raw.color),
    starred: n(raw.starred),
    pinned: n(raw.pinned),
    remark: s(raw.remark),
    config_json: s(raw.config_json),
    run_state: String(raw.run_state ?? 'idle'),
    session_id: s(raw.session_id),
    run_json: s(raw.run_json),
    version: n(raw.version, 1),
    updated_at: n(raw.updated_at),
    deleted: n(raw.deleted),
    origin_device_id: s(raw.origin_device_id)
  };
}

export class TimerEngine {
  private timers = new Map<string, Runtime>();
  /** timerId → 标签名列表（tag / timer_tag 联表内存映射，refreshTags 重建） */
  private tagsByTimer = new Map<string, string[]>();
  /** 精确倒计时到点回调（main 用于发通知） */
  onFinish: ((row: TimerRow) => void) | null = null;
  /** 番茄钟阶段切换回调（main 用于发通知：专注完成→休息） */
  onFinishPomodoro: ((row: TimerRow, nextPhase: PomodoroPhase) => void) | null = null;
  /** 同步入队钩子（main 注入 SyncClient.enqueue）；null = 未登录不同步 */
  queueOp: ((op: { table: string; opType: 'create' | 'update' | 'delete'; row: Record<string, unknown>; baseVersion?: number | null; isRun?: boolean }) => void) | null = null;
  /** 当前登录用户 id（创建行时写入 user_id） */
  currentUserId: string | null = null;

  constructor(private db: LocalDB, private deviceId: string) {}

  private monoNs(): bigint {
    return process.hrtime.bigint();
  }
  private monoDeltaMs(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  // ---------- 契约适配（全部转发到 contract.ts，本文件不再持有默认值/夹紧规则） ----------

  private cfgOf(row: TimerRow): TimerConfigView {
    return safeParse<TimerConfigView>(row.config_json);
  }

  private runOf(row: TimerRow): RunJson {
    return safeParse<RunJson>(row.run_json);
  }

  private isPomo(row: TimerRow): boolean {
    return isPomodoroConfig(row.type, this.cfgOf(row));
  }

  private pomoOf(row: TimerRow): NormalizedPomodoro {
    return normalizePomodoro(this.cfgOf(row));
  }

  /**
   * 从持久化字段推导单调基准（load / reloadRow 共用，两处语义必须一致）：
   * 跨重启没有更可信的来源，只能以当前墙钟为准重建，之后由 tick() 的守卫纠偏。
   */
  private reseatBaseline(rt: Runtime): void {
    rt.segStartMonoNs = null;
    rt.segStartRemainingMs = undefined;
    rt.segStartElapsedMs = undefined;
    const row = rt.row;
    if (row.run_state !== 'running') return;
    const run = this.runOf(row);
    const nowWall = Date.now();
    if (row.type === 'PRECISE_COUNTDOWN') {
      const deadline = this.isPomo(row) ? (run.phase_ends_at ?? run.target_at) : run.target_at;
      if (deadline) {
        rt.segStartRemainingMs = Math.max(0, deadline - nowWall);
        rt.segStartMonoNs = this.monoNs();
      }
    } else if (row.type === 'STOPWATCH') {
      const acc = run.accumulated_ms ?? 0;
      rt.segStartElapsedMs = acc + (run.segment_started_at ? Math.max(0, nowWall - run.segment_started_at) : 0);
      rt.segStartMonoNs = this.monoNs();
    }
  }

  /** 启动加载：running 状态以持久化字段恢复；跨重启无单调基准，按 §3.1 已知边界处理 */
  load(): void {
    this.loadTags();
    this.timers.clear();
    for (const raw of this.db.all('SELECT * FROM timer_item')) {
      const row = rowOf(raw);
      const rt: Runtime = { row, segStartMonoNs: null };
      this.timers.set(row.id, rt);
      this.reseatBaseline(rt);
    }
  }

  /** 同步拉回远程变更后刷新运行时基线（§5.3 应用规则） */
  reloadRow(id: string): void {
    const raw = this.db.get('SELECT * FROM timer_item WHERE id = ?', [id]);
    if (!raw) {
      this.timers.delete(id);
      return;
    }
    const row = rowOf(raw);
    const rt = this.timers.get(id);
    if (rt) {
      rt.row = row;
      this.reseatBaseline(rt); // 他端可能重置/续接了段，本地旧基准必须作废
    } else if (!row.deleted) {
      const created: Runtime = { row, segStartMonoNs: null };
      this.timers.set(id, created);
      this.reseatBaseline(created);
    }
  }

  list(): TimerDTO[] {
    return [...this.timers.values()].filter((rt) => !rt.row.deleted).map((rt) => this.dto(rt));
  }

  get(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    return rt && !rt.row.deleted ? this.dto(rt) : null;
  }

  // ---------- 状态机（§3.3 / §3.4） ----------

  start(id: string, payload?: { durationMs?: number }): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    if (rt.row.run_state === RUN_STATE.RUNNING) return this.dto(rt); // 防御：已在运行不重复 start
    const nowWall = Date.now();
    const sessionId = uuid(); // 每次进入 running 生成新 session（§3.1）
    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      if (this.isPomo(rt.row)) {
        // 番茄钟：从 focus 阶段全新开始（completed_focus 归零，无限循环）
        const p = this.pomoOf(rt.row);
        rt.row.run_json = JSON.stringify({ phase: PHASE_FOCUS, phase_ends_at: nowWall + p.work_ms, completed_focus: 0 });
        rt.segStartRemainingMs = p.work_ms;
        rt.segStartMonoNs = this.monoNs();
      } else {
        const cfg = this.cfgOf(rt.row);
        const dur = Math.round(payload?.durationMs ?? cfg.preset_ms ?? 0);
        if (dur <= 0) return null;
        rt.row.run_json = JSON.stringify({ target_at: nowWall + dur, segments_ms: [] });
        rt.segStartRemainingMs = dur;
        rt.segStartMonoNs = this.monoNs();
      }
    } else if (rt.row.type === 'STOPWATCH') {
      rt.row.run_json = JSON.stringify({ accumulated_ms: 0, segment_started_at: nowWall, segments_ms: [] });
      rt.segStartElapsedMs = 0;
      rt.segStartMonoNs = this.monoNs();
    } else {
      return this.dto(rt); // DATE_COUNTDOWN 无运行状态
    }
    rt.row.run_state = RUN_STATE.RUNNING;
    rt.row.session_id = sessionId;
    this.persistRun(rt);
    return this.dto(rt);
  }

  pause(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.run_state !== RUN_STATE.RUNNING || !rt.segStartMonoNs) return null;
    const run = this.runOf(rt.row);
    const segs = Array.isArray(run.segments_ms) ? run.segments_ms : [];
    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      const remaining = Math.max(0, Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(rt.segStartMonoNs)));
      // 番茄钟暂停保留 phase/completed_focus（resume 时续接），普通倒计时保留 segments_ms
      if (this.isPomo(rt.row)) {
        rt.row.run_json = JSON.stringify({ remaining_at_pause: remaining, phase: run.phase ?? PHASE_FOCUS, completed_focus: run.completed_focus ?? 0 });
      } else {
        rt.row.run_json = JSON.stringify({ remaining_at_pause: remaining, segments_ms: segs });
      }
    } else if (rt.row.type === 'STOPWATCH') {
      const elapsed = Math.round(rt.segStartElapsedMs! + this.monoDeltaMs(rt.segStartMonoNs));
      rt.row.run_json = JSON.stringify({ accumulated_ms: elapsed, segments_ms: segs });
    }
    rt.row.run_state = RUN_STATE.PAUSED;
    rt.segStartMonoNs = null;
    this.persistRun(rt);
    return this.dto(rt);
  }

  resume(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.run_state !== RUN_STATE.PAUSED) return null;
    const nowWall = Date.now();
    const run = this.runOf(rt.row);
    const segs = Array.isArray(run.segments_ms) ? run.segments_ms : [];
    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      const rem = run.remaining_at_pause ?? 0; // 暂停存剩余，继续时重算截止时间（§3.3）
      if (this.isPomo(rt.row)) {
        rt.row.run_json = JSON.stringify({ phase: run.phase ?? PHASE_FOCUS, phase_ends_at: nowWall + rem, completed_focus: run.completed_focus ?? 0 });
      } else {
        rt.row.run_json = JSON.stringify({ target_at: nowWall + rem, segments_ms: segs });
      }
      rt.segStartRemainingMs = rem;
      rt.segStartMonoNs = this.monoNs();
    } else if (rt.row.type === 'STOPWATCH') {
      const acc = run.accumulated_ms ?? 0; // 继续不改累计，只开新段（§3.4）
      rt.row.run_json = JSON.stringify({ accumulated_ms: acc, segment_started_at: nowWall, segments_ms: segs });
      rt.segStartElapsedMs = acc;
      rt.segStartMonoNs = this.monoNs();
    }
    rt.row.run_state = RUN_STATE.RUNNING;
    this.persistRun(rt);
    return this.dto(rt);
  }

  /** 归零：不记账（区别于 stop 的「如实结算已进行时长」） */
  reset(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt) return null;
    rt.row.run_state = RUN_STATE.IDLE;
    rt.row.session_id = null;
    rt.row.run_json = null;
    rt.segStartMonoNs = null;
    this.persistRun(rt);
    return this.dto(rt);
  }

  /**
   * 结束并如实结算（与 Android stop 同语义，三类可运行计时统一走这一个入口）：
   * - 正计时：整段累计写 STOPWATCH 记录；
   * - 普通倒计时：已进行时长写 PRECISE 记录；
   * - 番茄钟：当前阶段已进行时长写 POMODORO_FOCUS / POMODORO_BREAK；
   *   不足 PARTIAL_SETTLE_MIN_MS 视为误触，丢弃不记账。
   * 暂停态同样按暂停时刻的进度结算，不丢数据。
   */
  stop(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    const row = rt.row;
    if (row.run_state === RUN_STATE.IDLE) return this.dto(rt); // 防御：IDLE 不产生幽灵记录
    const nowWall = Date.now();
    const run = this.runOf(row);
    const mono = rt.segStartMonoNs;

    if (row.type === 'STOPWATCH') {
      const total = mono && row.run_state === RUN_STATE.RUNNING
        ? Math.round(rt.segStartElapsedMs! + this.monoDeltaMs(mono))
        : Math.round(run.accumulated_ms ?? 0);
      if (total >= PARTIAL_SETTLE_MIN_MS) this.insertRecord(rt, nowWall - total, nowWall, Math.round(total / 1000), RECORD.STOPWATCH);
      return this.reset(id);
    }

    if (row.type !== 'PRECISE_COUNTDOWN') return this.dto(rt); // DATE 无运行状态

    if (this.isPomo(row)) {
      const p = this.pomoOf(row);
      const phase = run.phase ?? PHASE_FOCUS;
      const preset = phasePresetMs(p, phase);
      const remaining = mono && row.run_state === RUN_STATE.RUNNING
        ? Math.max(0, Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(mono)))
        : Math.max(0, run.remaining_at_pause ?? 0);
      const elapsed = Math.max(0, preset - remaining);
      if (elapsed >= PARTIAL_SETTLE_MIN_MS) {
        this.insertRecord(rt, nowWall - elapsed, nowWall, Math.round(elapsed / 1000),
          phase === PHASE_FOCUS ? RECORD.POMODORO_FOCUS : RECORD.POMODORO_BREAK);
      }
      return this.reset(id);
    }

    const preset = Math.max(1, Math.round(this.cfgOf(row).preset_ms ?? 0));
    const remaining = mono && row.run_state === RUN_STATE.RUNNING
      ? Math.max(0, Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(mono)))
      : Math.max(0, run.remaining_at_pause ?? 0);
    const elapsed = Math.max(0, preset - remaining);
    if (elapsed >= PARTIAL_SETTLE_MIN_MS) this.insertRecord(rt, nowWall - elapsed, nowWall, Math.round(elapsed / 1000), RECORD.PRECISE);
    return this.reset(id);
  }

  /**
   * 手动分段 / 打点（v3 规范 §2）：
   * - 精确倒计时：不打断、不重置倒计时，仅记录本段时长（段时长 = 总已过 − 已完成段之和）；session 不变；
   * - 正计时：记一个 lap（上段时长），继续累计不中断；
   * - 暂停态同样可结算；番茄钟无手动打点（用 skipPhase 跳阶段）。
   */
  segment(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    if (this.isPomo(rt.row)) return this.dto(rt);
    const running = rt.row.run_state === RUN_STATE.RUNNING && !!rt.segStartMonoNs;
    const paused = rt.row.run_state === RUN_STATE.PAUSED;
    if (!running && !paused) return null;
    const nowWall = Date.now();
    const run = this.runOf(rt.row);
    const segs = Array.isArray(run.segments_ms) ? run.segments_ms.slice() : [];

    if (rt.row.type === 'PRECISE_COUNTDOWN') {
      const preset = Math.max(1, Math.round(this.cfgOf(rt.row).preset_ms ?? 0));
      const totalElapsed = running
        ? Math.max(0, preset - Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(rt.segStartMonoNs!)))
        : Math.max(0, preset - Math.round(run.remaining_at_pause ?? 0));
      const seg = totalElapsed - segs.reduce((a, b) => a + b, 0);
      if (seg <= 0) return this.dto(rt);
      segs.push(seg);
      this.insertRecord(rt, nowWall - seg, nowWall, Math.round(seg / 1000), RECORD.SEGMENT);
      // 运行中：target_at 与内部单调基准原样保留 → 倒计时无缝继续；暂停中：保留 remaining_at_pause
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
      this.insertRecord(rt, nowWall - lap, nowWall, Math.round(lap / 1000), RECORD.SEGMENT);
      rt.row.run_json = running
        ? JSON.stringify({ accumulated_ms: total, segment_started_at: nowWall, segments_ms: segs })
        : JSON.stringify({ accumulated_ms: total, segments_ms: segs });
    } else {
      return this.dto(rt);
    }
    this.persistRun(rt);
    return this.dto(rt);
  }

  /** 跳过当前番茄钟阶段（对齐 Android skipPhase）：不足阈值的误触丢弃记账 */
  skipPhase(id: string): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted || rt.row.run_state !== RUN_STATE.RUNNING || !rt.segStartMonoNs) return null;
    if (!this.isPomo(rt.row)) return null;
    const run = this.runOf(rt.row);
    const p = this.pomoOf(rt.row);
    const phase = run.phase ?? PHASE_FOCUS;
    const isFocus = phase === PHASE_FOCUS;
    const preset = phasePresetMs(p, phase);
    const remaining = Math.max(0, Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(rt.segStartMonoNs)));
    const elapsed = Math.max(0, preset - remaining);
    const nowWall = Date.now();
    if (elapsed >= PARTIAL_SETTLE_MIN_MS) {
      this.insertRecord(rt, nowWall - elapsed, nowWall, Math.round(elapsed / 1000),
        isFocus ? RECORD.POMODORO_FOCUS : RECORD.POMODORO_BREAK);
    }
    this.beginNextPhase(rt, p, phase, run.completed_focus ?? 0, nowWall);
    this.persistRun(rt);
    return this.dto(rt);
  }

  /** 周期调用：到点结算 + 单调时钟守卫（§3.6）。主进程驱动，窗口关闭到托盘也推进 */
  tick(): void {
    const nowWall = Date.now();
    for (const rt of this.timers.values()) {
      if (rt.row.deleted || rt.row.run_state !== RUN_STATE.RUNNING || !rt.segStartMonoNs) continue;
      const monoDelta = this.monoDeltaMs(rt.segStartMonoNs);
      const row = rt.row;

      if (row.type === 'STOPWATCH') {
        // 秒表同样受系统时间跳变影响（段起点存的是墙钟），按单调累计纠偏
        const run = this.runOf(row);
        const elapsedByMono = Math.round(rt.segStartElapsedMs! + monoDelta);
        const elapsedByWall = Math.round((run.accumulated_ms ?? 0) + Math.max(0, nowWall - (run.segment_started_at ?? nowWall)));
        if (Math.abs(elapsedByMono - elapsedByWall) > MONO_GUARD_MS) {
          rt.row.run_json = JSON.stringify({ accumulated_ms: elapsedByMono, segment_started_at: nowWall, segments_ms: run.segments_ms });
          rt.segStartElapsedMs = elapsedByMono;
          rt.segStartMonoNs = this.monoNs();
          console.warn('[clock-adjusted] 系统时间变动，秒表已按单调时钟修正:', row.name);
        }
        continue;
      }

      if (row.type !== 'PRECISE_COUNTDOWN') continue;
      const remainingByMono = rt.segStartRemainingMs! - monoDelta;
      const run = this.runOf(row);
      const isPomo = this.isPomo(row);
      const remainingByWall = (isPomo ? (run.phase_ends_at ?? run.target_at ?? 0) : (run.target_at ?? 0)) - nowWall;
      if (Math.abs(remainingByMono - remainingByWall) > MONO_GUARD_MS) {
        // 系统时间被修改：以单调时钟差值修正内部基准（番茄钟保留 phase，普通倒计时保留分段）
        rt.row.run_json = isPomo
          ? JSON.stringify({ phase: run.phase ?? PHASE_FOCUS, phase_ends_at: nowWall + Math.max(0, remainingByMono), completed_focus: run.completed_focus ?? 0 })
          : JSON.stringify({ target_at: nowWall + Math.max(0, remainingByMono), segments_ms: run.segments_ms });
        rt.segStartRemainingMs = remainingByMono;
        rt.segStartMonoNs = this.monoNs();
        console.warn('[clock-adjusted] 系统时间变动，已按单调时钟修正:', row.name);
      }
      if (remainingByMono <= 0) {
        if (isPomo) this.advancePomodoro(rt);
        else this.finishPrecise(rt);
      }
    }
  }

  // ---------- CRUD ----------

  create(input: CreateTimerInput): TimerDTO | null {
    const type = input.type;
    if (!input.name || !(TIMER_TYPES as readonly string[]).includes(type)) return null;
    const now = Date.now();
    const raw = input.config ?? {};
    let config: Record<string, unknown>;
    if (type === 'DATE_COUNTDOWN') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.target_date ?? '')) return null;
      config = {
        schema_version: 1,
        target_date: raw.target_date,
        timezone_id: raw.timezone_id || Intl.DateTimeFormat().resolvedOptions().timeZone,
        include_today: !!raw.include_today
      };
    } else if (type === 'PRECISE_COUNTDOWN') {
      // 番茄钟一次写入落定（旧实现只存 preset_ms，要渲染层再补一次 update）
      if (raw.pomodoro) {
        config = buildPomodoroConfig(raw.pomodoro);
      } else {
        const preset = Math.round(raw.preset_ms ?? 0);
        if (preset <= 0) return null; // 缺时长就拒绝创建，不能让夹紧兜底值造出一个 1 秒计时
        config = buildPreciseConfig(preset);
      }
    } else {
      config = { schema_version: 1 };
    }
    const id = uuid();
    this.db.run(
      `INSERT INTO timer_item (id, user_id, name, type, color, starred, pinned, remark, config_json,
        run_state, session_id, run_json, version, updated_at, deleted, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, 1, ?, 0, ?)`,
      [id, this.currentUserId, input.name, type, input.color || DEFAULT_TIMER_COLOR, input.starred ? 1 : 0, input.pinned ? 1 : 0,
        input.remark || '', JSON.stringify(config), now, this.deviceId]
    );
    const rt: Runtime = { row: rowOf(this.db.get('SELECT * FROM timer_item WHERE id = ?', [id]) ?? {}), segStartMonoNs: null };
    this.timers.set(id, rt);
    this.queueOp?.({ table: 'timer_item', opType: 'create', row: { ...rt.row }, baseVersion: 0, isRun: false });
    return this.dto(rt);
  }

  update(id: string, patch: UpdateTimerPatch): UpdateResult {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return { ok: false, timer: null, message: '计时不存在' };
    const row = rt.row;
    const wasPomo = this.isPomo(row);
    if (patch.name !== undefined) row.name = String(patch.name).slice(0, 100) || row.name;
    if (patch.color !== undefined) row.color = patch.color;
    if (patch.remark !== undefined) row.remark = patch.remark;
    if (patch.starred !== undefined) row.starred = patch.starred ? 1 : 0;
    if (patch.pinned !== undefined) row.pinned = patch.pinned ? 1 : 0;

    let configRejected: string | undefined;
    if (patch.config !== undefined) {
      let next: TimerConfigView = { ...patch.config };
      if (row.type === 'PRECISE_COUNTDOWN') {
        const nextIsPomo = isPomodoroConfig(row.type, next);
        next = nextIsPomo
          ? { ...next, ...buildPomodoroConfig(next.pomodoro) }
          : next.preset_ms !== undefined
            ? { ...next, ...buildPreciseConfig(Math.round(next.preset_ms)) }
            : next;
        // 形态切换（番茄钟 ↔ 普通倒计时）走下面的清运行态分支；同一形态下改时长才拒绝
        const switchingKind = nextIsPomo !== this.isPomo(row);
        if (!switchingKind && row.run_state !== RUN_STATE.IDLE && next.preset_ms !== this.cfgOf(row).preset_ms) {
          configRejected = '运行中不能修改时长，请先结束或重置';
        } else {
          row.config_json = JSON.stringify(next);
        }
      } else {
        row.config_json = JSON.stringify(next);
      }
    }

    // 番茄钟 ↔ 普通倒计时切换后旧 run_json（phase_ends_at 等）与新配置不兼容 → 清空运行态
    const nowPomo = this.isPomo(row);
    let runCleared = false;
    if (wasPomo !== nowPomo) {
      row.run_state = RUN_STATE.IDLE;
      row.run_json = null;
      row.session_id = null;
      rt.segStartMonoNs = null;
      runCleared = true;
    }

    const baseVersion = row.version;
    row.version = baseVersion + 1;
    row.updated_at = Date.now();
    this.db.run(
      `UPDATE timer_item SET name=?, color=?, starred=?, pinned=?, remark=?, config_json=?, run_state=?, run_json=?, session_id=?, version=?, updated_at=? WHERE id=?`,
      [row.name, row.color, row.starred, row.pinned, row.remark, row.config_json, row.run_state, row.run_json, row.session_id, row.version, row.updated_at, id]
    );
    this.queueOp?.({ table: 'timer_item', opType: 'update', row: { ...row }, baseVersion, isRun: runCleared });
    return { ok: !configRejected, timer: this.dto(rt), message: configRejected };
  }

  /** 软删除墓碑（M2 同步 ready）。联动的 timer_tag 关系一并打墓碑，避免活行永久残留 */
  remove(id: string): boolean {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return false;
    const baseVersion = rt.row.version;
    rt.row.deleted = 1;
    rt.row.version = baseVersion + 1;
    rt.row.updated_at = Date.now();
    const now = rt.row.updated_at;
    this.db.run('UPDATE timer_item SET deleted=1, version=?, updated_at=? WHERE id=?', [rt.row.version, now, id]);
    this.queueOp?.({ table: 'timer_item', opType: 'delete', row: { ...rt.row }, baseVersion, isRun: false });
    for (const link of this.db.all('SELECT id, tag_id, version FROM timer_tag WHERE timer_id = ? AND deleted = 0', [id])) {
      const linkVersion = n(link.version, 1);
      this.db.run('UPDATE timer_tag SET deleted=1, version=?, updated_at=? WHERE id=?', [linkVersion + 1, now, String(link.id)]);
      this.queueOp?.({
        table: 'timer_tag', opType: 'delete', baseVersion: linkVersion, isRun: false,
        row: { id: String(link.id), timer_id: id, tag_id: String(link.tag_id), version: linkVersion + 1, updated_at: now, deleted: 1, origin_device_id: this.deviceId }
      });
    }
    this.refreshTags();
    return true;
  }

  // ---------- 记录与统计 ----------

  /** 近期计时记录（只读，供历史页；ended_at 倒序） */
  listRecentRecords(limit = 300): RecordDTO[] {
    const rows = this.db.all(
      'SELECT * FROM timer_record WHERE deleted = 0 ORDER BY ended_at DESC LIMIT ?',
      [Math.max(1, Math.min(1000, Math.round(limit)))]
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      timerId: String(r.timer_id),
      sessionId: r.session_id == null ? null : String(r.session_id),
      startedAt: n(r.started_at),
      endedAt: n(r.ended_at),
      durationSec: n(r.duration_sec),
      recordType: String(r.record_type ?? '')
    }));
  }

  /** 按本地自然日聚合的专注统计（全部由已同步的 timer_record 现场推导，不再有本地私有账本） */
  dailyStats(): DayStatDTO[] {
    const pomo = new Map<string, { isPomo: boolean; cfg: NormalizedPomodoro }>();
    for (const r of this.db.all('SELECT id, type, config_json FROM timer_item')) {
      const cfg = safeParse(r.config_json == null ? null : String(r.config_json));
      pomo.set(String(r.id), { isPomo: isPomodoroConfig(String(r.type), cfg), cfg: normalizePomodoro(cfg) });
    }
    const fallback = normalizePomodoro({});
    const byDay = new Map<string, Contribution>();
    for (const r of this.db.all('SELECT timer_id, ended_at, duration_sec, record_type FROM timer_record WHERE deleted = 0')) {
      const t = pomo.get(String(r.timer_id)) ?? { isPomo: false, cfg: fallback };
      const c = contribute(
        { durationSec: n(r.duration_sec), recordType: String(r.record_type ?? '') },
        t.isPomo,
        t.cfg
      );
      const day = localDateKey(n(r.ended_at));
      byDay.set(day, sumContribution(byDay.get(day) ?? EMPTY_CONTRIBUTION, c));
    }
    return [...byDay.entries()].map(([day, c]) => ({ day, ...c }));
  }

  /** 删除计时记录（软删除墓碑，随同步收敛到服务端）；返回实际删除数 */
  deleteRecords(ids: string[]): number {
    let count = 0;
    const now = Date.now();
    for (const id of ids) {
      const raw = this.db.get('SELECT * FROM timer_record WHERE id = ?', [String(id)]);
      if (!raw) continue;
      const row = raw as Record<string, unknown>;
      if (n(row.deleted) === 1) continue;
      const newVersion = n(row.version, 1) + 1;
      this.db.run('UPDATE timer_record SET deleted=1, version=?, updated_at=? WHERE id=?', [newVersion, now, String(id)]);
      this.queueOp?.({
        table: 'timer_record', opType: 'delete', baseVersion: n(row.version, 1), isRun: false,
        row: { ...row, deleted: 1, version: newVersion, updated_at: now }
      });
      count++;
    }
    return count;
  }

  /** 全部计时元数据（含已删除，供历史页保留已删计时的记录并标注） */
  listMetas(): TimerMeta[] {
    return this.db.all('SELECT id, name, color, type, config_json, deleted FROM timer_item').map((r: Record<string, unknown>) => {
      const config = safeParse<TimerConfigView>(r.config_json == null ? null : String(r.config_json));
      const type = String(r.type) as TimerMeta['type'];
      return {
        id: String(r.id),
        name: String(r.name ?? ''),
        color: String(r.color ?? DEFAULT_TIMER_COLOR),
        type,
        config,
        deleted: n(r.deleted) === 1
      } satisfies TimerMeta;
    });
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
    return this.db.all('SELECT id, name, color FROM tag WHERE deleted = 0 ORDER BY name').map((r: Record<string, unknown>) => ({
      id: String(r.id), name: String(r.name ?? ''), color: String(r.color ?? DEFAULT_TIMER_COLOR)
    }));
  }

  /** 设置某计时的标签集合（按名对齐；新名建 tag，缺的建 link，多的打墓碑） */
  setTimerTags(id: string, names: string[]): TimerDTO | null {
    const rt = this.timers.get(id);
    if (!rt || rt.row.deleted) return null;
    const clean = [...new Set(names.map((x) => String(x).trim().slice(0, 20)).filter(Boolean))].slice(0, 8);
    const now = Date.now();

    const keepTagIds = new Set<string>();
    for (const name of clean) {
      let tag = this.db.get('SELECT * FROM tag WHERE name = ? AND deleted = 0', [name]);
      if (!tag) {
        const color = tagColorFor(name);
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
      const link = this.db.get('SELECT id FROM timer_tag WHERE timer_id = ? AND tag_id = ? AND deleted = 0', [id, tagId]);
      if (!link) {
        const lid = uuid();
        this.db.run(
          'INSERT INTO timer_tag (id, user_id, timer_id, tag_id, version, updated_at, deleted, origin_device_id) VALUES (?, ?, ?, ?, 1, ?, 0, ?)',
          [lid, this.currentUserId, id, tagId, now, this.deviceId]
        );
        this.queueOp?.({
          table: 'timer_tag', opType: 'create', baseVersion: 0, isRun: false,
          row: { id: lid, user_id: this.currentUserId, timer_id: id, tag_id: tagId, version: 1, updated_at: now, deleted: 0, origin_device_id: this.deviceId }
        });
      }
    }

    const existing = this.db.all('SELECT id, tag_id, version FROM timer_tag WHERE timer_id = ? AND deleted = 0', [id]);
    for (const row of existing) {
      const tagId = String(row.tag_id);
      if (keepTagIds.has(tagId)) continue;
      const linkVersion = n(row.version, 1);
      this.db.run('UPDATE timer_tag SET deleted=1, version=?, updated_at=? WHERE id=?', [linkVersion + 1, now, String(row.id)]);
      this.queueOp?.({
        table: 'timer_tag', opType: 'delete', baseVersion: linkVersion, isRun: false,
        row: { id: String(row.id), timer_id: id, tag_id: tagId, version: linkVersion + 1, updated_at: now, deleted: 1, origin_device_id: this.deviceId }
      });
    }

    this.refreshTags();
    return this.dto(rt);
  }

  // ---------- 里程碑（milestone 表，计时中的重要时刻标记，参与同步） ----------

  /** 某计时的里程碑（marked_at 倒序） */
  listMilestones(timerId: string): Array<{ id: string; note: string; markedAt: number }> {
    return this.db.all(
      'SELECT id, note, marked_at FROM milestone WHERE timer_id = ? AND deleted = 0 ORDER BY marked_at DESC',
      [String(timerId)]
    ).map((r: Record<string, unknown>) => ({ id: String(r.id), note: String(r.note ?? ''), markedAt: n(r.marked_at) }));
  }

  /** 添加里程碑（当前时刻 + 备注，走同步） */
  addMilestone(timerId: string, note: string): { id: string; note: string; markedAt: number } | null {
    const rt = this.timers.get(timerId);
    if (!rt || rt.row.deleted) return null;
    const clean = String(note ?? '').trim().slice(0, 100);
    const id = uuid();
    const now = Date.now();
    this.db.run(
      `INSERT INTO milestone (id, user_id, timer_id, note, marked_at, version, updated_at, deleted, origin_device_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)`,
      [id, this.currentUserId, timerId, clean, now, now, this.deviceId]
    );
    this.queueOp?.({
      table: 'milestone', opType: 'create', baseVersion: 0, isRun: false,
      row: { id, user_id: this.currentUserId, timer_id: timerId, note: clean, marked_at: now, version: 1, updated_at: now, deleted: 0, origin_device_id: this.deviceId }
    });
    return { id, note: clean, markedAt: now };
  }

  /** 删除里程碑（软删除墓碑，随同步收敛） */
  removeMilestone(id: string): boolean {
    const raw = this.db.get('SELECT * FROM milestone WHERE id = ?', [String(id)]);
    if (!raw) return false;
    const row = raw as Record<string, unknown>;
    if (n(row.deleted) === 1) return false;
    const now = Date.now();
    const newVersion = n(row.version, 1) + 1;
    this.db.run('UPDATE milestone SET deleted=1, version=?, updated_at=? WHERE id=?', [newVersion, now, String(id)]);
    this.queueOp?.({
      table: 'milestone', opType: 'delete', baseVersion: n(row.version, 1), isRun: false,
      row: { ...row, deleted: 1, version: newVersion, updated_at: now }
    });
    return true;
  }

  // ---------- 导入备份 ----------

  /** 导入备份：INSERT OR REPLACE 各表 + 入队同步（已登录时）+ 刷新内存运行时。返回各表计数。 */
  importData(payload: unknown): { ok: boolean; counts: Record<string, number>; message?: string } {
    const p = payload as Record<string, unknown> | null;
    if (!p || p.app !== 'TimeMark' || !p.schema_version) {
      return { ok: false, counts: {}, message: '不是有效的 TimeMark 备份文件' };
    }
    const COLS = SYNC_TABLE_COLUMNS;
    const counts: Record<string, number> = {};
    const queued: Array<{ table: string; row: Record<string, unknown> }> = [];
    this.db.transaction(() => {
      for (const table of Object.keys(COLS)) {
        const rows = Array.isArray(p[table]) ? p[table] as Record<string, unknown>[] : [];
        const cols = COLS[table];
        let done = 0;
        for (const row of rows) {
          if (!row || row.id == null) continue;
          const values = cols.map((c) => (row[c] !== undefined ? row[c] : null));
          this.db.run(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, values);
          queued.push({ table, row });
          done++;
        }
        counts[table] = done;
      }
    });
    for (const q of queued) {
      const deleted = n(q.row.deleted) === 1;
      this.queueOp?.({ table: q.table, opType: deleted ? 'delete' : 'create', row: q.row, baseVersion: null, isRun: false });
    }
    this.load(); // 重建内存运行时（含单调基准）
    this.refreshTags();
    return { ok: true, counts };
  }

  // ---------- 内部 ----------

  /** 普通精确倒计时到点：整段 preset 记 PRECISE */
  private finishPrecise(rt: Runtime): void {
    const nowWall = Date.now();
    const preset = Math.max(1, Math.round(this.cfgOf(rt.row).preset_ms ?? 0));
    this.insertRecord(rt, nowWall - preset, nowWall, Math.round(preset / 1000), RECORD.PRECISE);
    rt.row.run_state = RUN_STATE.IDLE;
    rt.row.session_id = null;
    rt.row.run_json = null;
    rt.segStartMonoNs = null;
    this.persistRun(rt);
    this.onFinish?.(rt.row);
  }

  /** 番茄钟阶段自然到点推进：focus→break/long_break→focus 无限循环（引擎驱动，后台/托盘也推进） */
  private advancePomodoro(rt: Runtime): void {
    const nowWall = Date.now();
    const run = this.runOf(rt.row);
    const p = this.pomoOf(rt.row);
    const phase = run.phase ?? PHASE_FOCUS;
    const preset = phasePresetMs(p, phase);
    // 阶段完成记录：把阶段写进 record_type，统计与历史页不再靠时长猜
    this.insertRecord(rt, nowWall - preset, nowWall, Math.round(preset / 1000),
      phase === PHASE_FOCUS ? RECORD.POMODORO_FOCUS : RECORD.POMODORO_BREAK);
    const next = this.beginNextPhase(rt, p, phase, run.completed_focus ?? 0, nowWall);
    rt.row.run_state = RUN_STATE.RUNNING; // 无限循环，保持 running
    this.persistRun(rt);
    this.onFinishPomodoro?.(rt.row, next);
  }

  /** 计算并写入下一阶段（skipPhase 与 advancePomodoro 共用，保证两端一致）；返回进入的阶段 */
  private beginNextPhase(rt: Runtime, p: NormalizedPomodoro, phase: PomodoroPhase, completedFocus: number, nowWall: number): PomodoroPhase {
    const isFocus = phase === PHASE_FOCUS;
    const completed = completedFocus + (isFocus ? 1 : 0);
    const nextPhase: PomodoroPhase = isFocus
      ? (isLongBreakDue(p, completed) ? PHASE_LONG_BREAK : PHASE_BREAK)
      : PHASE_FOCUS;
    const nextPreset = phasePresetMs(p, nextPhase);
    rt.row.run_json = JSON.stringify({ phase: nextPhase, phase_ends_at: nowWall + nextPreset, completed_focus: completed } satisfies RunJson);
    rt.segStartRemainingMs = nextPreset;
    rt.segStartMonoNs = this.monoNs();
    return nextPhase;
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
    const cfg = this.cfgOf(row);
    const running = row.run_state === RUN_STATE.RUNNING && !!rt.segStartMonoNs;
    const paused = row.run_state === RUN_STATE.PAUSED;
    const base: TimerDTO = {
      id: row.id,
      name: row.name,
      type: row.type as TimerDTO['type'],
      color: row.color ?? DEFAULT_TIMER_COLOR,
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
      return base;
    }

    const rj = this.runOf(row);
    if (row.type === 'PRECISE_COUNTDOWN') {
      if (running) base.remainingMs = Math.max(0, Math.round(rt.segStartRemainingMs! - this.monoDeltaMs(rt.segStartMonoNs!)));
      else if (paused) base.remainingMs = rj.remaining_at_pause ?? 0;
      if (this.isPomo(row)) {
        // 番茄钟：暴露阶段/轮次派生值（阶段状态在 run_json 里，参与同步）
        const phase = rj.phase ?? PHASE_FOCUS;
        const completed = rj.completed_focus ?? 0;
        base.pomoPhase = phase;
        base.pomoRound = phase === PHASE_FOCUS ? completed + 1 : completed;
        if (!running && !paused) base.remainingMs = phasePresetMs(this.pomoOf(row), phase);
      } else if (Array.isArray(rj.segments_ms) && rj.segments_ms.length > 0) {
        base.segmentsMs = rj.segments_ms;
      }
      return base;
    }

    if (row.type === 'STOPWATCH') {
      if (running) base.elapsedMs = Math.round(rt.segStartElapsedMs! + this.monoDeltaMs(rt.segStartMonoNs!));
      else if (paused) base.elapsedMs = rj.accumulated_ms ?? 0;
      else base.elapsedMs = 0;
      if (Array.isArray(rj.segments_ms) && rj.segments_ms.length > 0) base.segmentsMs = rj.segments_ms;
    }
    return base;
  }
}
