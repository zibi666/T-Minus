// §3/§4/§6 的本地执行核心：所有业务修改 = 本地写入 + pending_ops 同事务入队。
// 状态迁移一律委托 core/Machine.ets（纯函数、可在 node 里断言），本文件只管持久化与排队；
// 番茄钟判定/夹紧/统计口径走 core/Contract.ets。语义对齐 Android TimerRepository.kt 与 Windows timerEngine.ts。
import { util } from '@kit.ArkTS';
import { systemDateTime } from '@kit.BasicServicesKit';
import {
  NormalizedPomodoro, RUN_IDLE, RUN_PAUSED, RUN_RUNNING,
  TYPE_DATE, TYPE_PRECISE, TYPE_STOPWATCH, Contribution,
  buildPomodoroConfig, buildPreciseConfig, columnsOf, contribute, isPomodoroConfig, normalizePomodoro,
  numAt, objAt, parseConfig, recordId, strAt, sumContribution, tagColorFor
} from '../core/Contract';
import { dayKey, parseRun, runToJsonString } from '../core/Engine';
import * as M from '../core/Machine';
import { LocalDb } from './Db';
import { AuthStore } from './AuthStore';
import { Milestone, PendingOp, SyncRow, Tag, TimerItem, TimerRecord, TimerTag, rawRowObject, rowPayloadJson } from './Rows';

function uuid(): string {
  return util.generateRandomUUID(true);
}

/** 单调时钟（含深度睡眠，等价 Android elapsedRealtime） */
function monoNow(): number {
  return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
}

/** §3.6 单调基准：仅内存态，进程重启后按持久化字段懒重建 */
class MonoBaseline {
  monoStart: number = 0;
  wallStart: number = 0;
  remainingAtStart: number = 0;
  elapsedAtStart: number = 0;

  constructor(monoStart: number, wallStart: number, remainingAtStart: number, elapsedAtStart: number) {
    this.monoStart = monoStart;
    this.wallStart = wallStart;
    this.remainingAtStart = remainingAtStart;
    this.elapsedAtStart = elapsedAtStart;
  }
}

/** 到点结算结果（供 tick 循环发通知/重排提醒） */
export class Settled {
  timer: TimerItem;
  kind: string;
  phase: string | null;

  constructor(timer: TimerItem, kind: string, phase: string | null) {
    this.timer = timer;
    this.kind = kind;
    this.phase = phase;
  }
}

export class DayStat {
  day: string = '';
  focusMs: number = 0;
  rounds: number = 0;
  marks: number = 0;

  constructor(day: string, focusMs: number, rounds: number, marks: number) {
    this.day = day;
    this.focusMs = focusMs;
    this.rounds = rounds;
    this.marks = marks;
  }
}

export class ImportSummary {
  timer_item: number = 0;
  tag: number = 0;
  timer_tag: number = 0;
  milestone: number = 0;
  timer_record: number = 0;
  error: string = '';
}

export class Repo {
  db: LocalDb;
  auth: AuthStore;
  private monoBaselines: Map<string, MonoBaseline> = new Map<string, MonoBaseline>();
  /** 写互斥的 Promise 尾串行链：后到的写挂在链尾，同一时刻只有一个「读旧行 → 改 → 写」在飞 */
  private writeTail: Promise<void> = Promise.resolve();

  constructor(db: LocalDb, auth: AuthStore) {
    this.db = db;
    this.auth = auth;
  }

  // ---- 写互斥（对齐 Android TimerRepository.repoMutex）----

  /**
   * 变更串行锁：所有「读旧行 → 改 → 写 version+1」的入口都必须持锁，只保护 settleDue 是不够的——
   * 用户在阶段到点那一秒点结束/分段/跳过，会与到点推进各写一条记录、或把已经 stopped 的行留在
   * running；UI 开关（置顶/标签）带着陈旧 run_json 整行回写也会复活旧阶段。
   * 实现与 LocalDb.exclusive 同一套尾串行技巧：不依赖定时器、不忙等，异常不会毒化队列。
   * 不可重入：持锁方法内部只能调无锁私有方法（putItem/doXxx 一族），再走 withWriteLock 会把
   * 后一次排队到自己后面，await 它就死锁。层次：本锁在外、Db.inTransaction 在内
   * （全库只有 Repo 使用事务，不存在反向嵌套，无锁序环路）。
   * 同时供同步层 applyChange 与业务写入互斥：远端行若落在「读旧行 → 改 → 写」中间，
   * 陈旧快照整行回写会复活已结束的阶段（与业务入口同锁，语义同上）。
   */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(() => fn());
    this.writeTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---- 写入原语 ----

  private async enqueue(table: string, opType: string, rowId: string, payload: string,
    baseVersion: number | null, isRun: boolean, now: number): Promise<void> {
    if (this.auth.token() === null) return; // 未登录只落本地，登录后由 SyncManager 补交
    const o = new PendingOp();
    o.operation_id = uuid();
    o.table_name = table;
    o.op_type = opType;
    o.row_id = rowId;
    o.row_payload = payload;
    o.base_version = baseVersion;
    o.is_run = isRun;
    o.created_at = now;
    o.state = 'queued';
    await this.db.enqueue(o);
  }

  private async putItem(old: TimerItem, next: TimerItem, isRun: boolean): Promise<TimerItem> {
    await this.db.upsertRow(next);
    await this.enqueue('timer_item', 'update', next.id, rowPayloadJson(next), old.version, isRun, next.updated_at);
    return next;
  }

  private async putRecord(r: TimerRecord, opType: string, baseVersion: number | null): Promise<void> {
    await this.db.upsertRow(r);
    await this.enqueue('timer_record', opType, r.id, rowPayloadJson(r), baseVersion, false, r.updated_at);
  }

  private async putGeneric(row: SyncRow, opType: string, baseVersion: number | null): Promise<void> {
    await this.db.upsertRow(row);
    await this.enqueue(row.table(), opType, row.rowId(), rowPayloadJson(row), baseVersion, false, Date.now());
  }

  private isPomodoro(t: TimerItem): boolean {
    return isPomodoroConfig(t.type, parseConfig(t.config_json));
  }

  private pomoOf(t: TimerItem): NormalizedPomodoro {
    return normalizePomodoro(parseConfig(t.config_json));
  }

  private copyItem(o: TimerItem): TimerItem {
    return o.cloneFrom(o);
  }

  /** 同步拉回远程变更后作废本地单调基准：他端可能重置/续接了段，旧基准会把新目标时刻改坏 */
  onRemoteApplied(timerId: string): void {
    this.monoBaselines.delete(timerId);
  }

  /**
   * 把一次状态迁移落库：运行态 + 记录 + 单调基准。
   * 记录用 old 的 session_id（与双端一致——刚被清空的 session 仍要留在已完成的那条记录上）。
   * 记录插入/行写入/入队原本是三次独立 exec：包进同一事务，任一步失败整体回滚，不留半条迁移
   * （settleDue/guardMonoClock 与用户路径统一走这里，全部拿到事务保护）。
   */
  private async writeTransition(old: TimerItem, tr: M.Transition): Promise<TimerItem> {
    const now = Date.now();
    const e = await this.db.inTransaction<TimerItem>(async (): Promise<TimerItem> => {
      for (let i = 0; i < tr.records.length; i++) {
        const rec = tr.records[i];
        await this.insertRecordRaw(old, rec.startedAt, rec.endedAt, rec.durationSec, rec.recordType,
          rec.phaseKey, rec.completedFocus);
      }
      const next = this.copyItem(old);
      next.run_json = runToJsonString(tr.run);
      next.run_state = tr.runState;
      if (tr.newSession) next.session_id = uuid();
      if (tr.clearSession) next.session_id = null;
      next.version = old.version + 1;
      next.updated_at = now;
      await this.putItem(old, next, true);
      return next;
    });
    // 基准更新放在事务成功提交之后：提交失败（回滚）时内存基准不与库内已回滚的状态脱节
    if (tr.setBaseline) {
      this.monoBaselines.set(old.id, new MonoBaseline(monoNow(), now, tr.baselineRemaining, tr.baselineElapsed));
    }
    if (tr.dropBaseline) this.monoBaselines.delete(old.id);
    return e;
  }

  // ---- 元数据 CRUD ----

  async createTimer(name: string, type: string, color: string | null, configJson: string | null,
    remark: string | null): Promise<string> {
    return this.withWriteLock<string>(async (): Promise<string> => {
      const now = Date.now();
      const e = new TimerItem();
      e.id = uuid();
      e.user_id = this.auth.uid();
      e.name = name;
      e.type = type;
      e.color = color;
      e.config_json = configJson;
      e.remark = remark;
      e.version = 1;
      e.updated_at = now;
      e.origin_device_id = this.auth.deviceId();
      await this.db.inTransaction<void>(async () => {
        await this.db.upsertRow(e);
        await this.enqueue('timer_item', 'create', e.id, rowPayloadJson(e), null, false, now);
      });
      return e.id;
    });
  }

  /**
   * 元数据更新。返回 null 表示已保存，非 null 为拒绝原因（与 Windows UpdateResult 对齐）。
   */
  async updateMeta(id: string, name: string | null, type: string | null, color: string | null,
    remark: string | null, configJson: string | null): Promise<string | null> {
    return this.withWriteLock<string | null>(async (): Promise<string | null> => {
      const old = await this.db.timerById(id);
      if (old === null) return '计时不存在';
      const now = Date.now();
      const newType = type ?? old.type;
      let newConfig = configJson ?? old.config_json;
      const oldIsPomo = old.type === TYPE_PRECISE && isPomodoroConfig(old.type, parseConfig(old.config_json));
      let rejected: string | null = null;

      if (configJson !== null) {
        const cfg = parseConfig(configJson);
        const newIsPomo = newType === TYPE_PRECISE && isPomodoroConfig(newType, cfg);
        // 时长变更后旧 run_json 与新配置不兼容 → 拒绝改时长（三端一致）
        const changesProgress = old.run_state !== RUN_IDLE &&
          (numAt(cfg, 'preset_ms') ?? 0) !== (numAt(parseConfig(old.config_json), 'preset_ms') ?? 0);
        if (changesProgress) {
          rejected = '运行中不能修改时长，请先结束或重置';
          newConfig = old.config_json;
        } else if (newIsPomo) {
          const src = objAt(cfg, 'pomodoro');
          const longInner = numAt(src, 'long_break_ms');
          newConfig = JSON.stringify(buildPomodoroConfig(
            this.pomoInput(numAt(src, 'work_ms'), numAt(src, 'break_ms'),
              longInner ?? numAt(cfg, 'long_break_ms'), numAt(src, 'rounds'))
          ));
        }
      }

      const merged = parseConfig(newConfig);
      const newIsPomo = newType === TYPE_PRECISE && isPomodoroConfig(newType, merged);
      const typeChanged = (type !== null && type !== old.type) || oldIsPomo !== newIsPomo;
      const e = this.copyItem(old);
      e.name = name ?? old.name;
      e.type = newType;
      e.color = color ?? old.color;
      e.remark = remark ?? old.remark;
      e.config_json = newConfig;
      if (typeChanged) {
        e.run_state = RUN_IDLE;
        e.run_json = null;
        e.session_id = null;
      }
      e.version = old.version + 1;
      e.updated_at = now;

      await this.db.inTransaction<void>(async () => {
        await this.putItem(old, e, typeChanged);
      });
      if (typeChanged) this.monoBaselines.delete(id);
      return rejected;
    });
  }

  private pomoInput(workMs: number | null, breakMs: number | null, longBreakMs: number | null,
    rounds: number | null): Record<string, Object> {
    const o: Record<string, Object> = {};
    if (workMs !== null) o['work_ms'] = workMs as Object;
    if (breakMs !== null) o['break_ms'] = breakMs as Object;
    if (longBreakMs !== null) o['long_break_ms'] = longBreakMs as Object;
    if (rounds !== null) o['rounds'] = rounds as Object;
    return o;
  }

  /** 删除计时：墓碑 + 连带墓碑其标签连接（与 Windows remove() 一致） */
  async deleteTimer(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      const now = Date.now();
      const e = this.copyItem(old);
      e.deleted = true;
      e.run_state = RUN_IDLE;
      e.version = old.version + 1;
      e.updated_at = now;
      await this.db.inTransaction<void>(async () => {
        await this.putItem(old, e, false);
        const links = await this.db.timerTagsOfTimer(id);
        for (let i = 0; i < links.length; i++) {
          const l = links[i];
          const next = new TimerTag();
          next.id = l.id; next.user_id = l.user_id; next.timer_id = l.timer_id; next.tag_id = l.tag_id;
          next.version = l.version + 1; next.updated_at = now; next.deleted = true;
          next.origin_device_id = l.origin_device_id;
          await this.putGeneric(next, 'delete', l.version);
        }
      });
      this.monoBaselines.delete(id);
    });
  }

  async togglePin(id: string): Promise<void> {
    await this.toggleFlag(id, 'pinned');
  }

  async toggleStar(id: string): Promise<void> {
    await this.toggleFlag(id, 'starred');
  }

  private async toggleFlag(id: string, which: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      // 整行回写必须持锁：否则会带着陈旧 run_json 复活已结束的阶段
      const old = await this.db.timerById(id);
      if (old === null) return;
      const now = Date.now();
      const e = this.copyItem(old);
      if (which === 'pinned') e.pinned = !old.pinned;
      if (which === 'starred') e.starred = !old.starred;
      e.version = old.version + 1;
      e.updated_at = now;
      await this.db.inTransaction<void>(async () => {
        await this.putItem(old, e, false);
      });
    });
  }

  // ---- 运行状态（§3）：迁移算在 Machine，落库走 writeTransition（事务在 writeTransition 内）----

  async start(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      if (old.run_state === RUN_RUNNING) return; // 防御：已在运行不重复 start
      const tr = M.start(old.type, old.config_json, Date.now());
      if (tr.noop) return;
      await this.writeTransition(old, tr);
    });
  }

  async pause(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      if (old.run_state !== RUN_RUNNING) return; // 防御：非运行态不可暂停
      const tr = M.pause(old.type, old.config_json, old.run_json, Date.now());
      if (tr.noop) return;
      await this.writeTransition(old, tr);
    });
  }

  async resume(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      if (old.run_state !== RUN_PAUSED) return; // 防御：非暂停态不可继续
      const tr = M.resume(old.type, old.config_json, old.run_json, Date.now());
      if (tr.noop) return;
      await this.writeTransition(old, tr);
    });
  }

  /** 分段：倒计时打点不中断，正计时记 lap 继续，番茄钟无此操作 */
  async segment(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      const tr = M.segment(old.type, old.config_json, old.run_json, old.run_state, Date.now());
      if (tr.noop) return;
      await this.writeTransition(old, tr);
    });
  }

  /** 结束：如实结算已进行时长后归零；不足 PARTIAL_SETTLE_MIN_MS 视为误触不记账 */
  async stop(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      const tr = M.stop(old.type, old.config_json, old.run_json, old.run_state, Date.now());
      if (tr.noop) return;
      await this.writeTransition(old, tr);
    });
  }

  /** 归零：不记账（区别于 stop） */
  async reset(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      if (old.type === TYPE_DATE) return;
      if (old.run_state === RUN_IDLE && old.run_json === null) return; // 已 idle 且无残留不重复 commit
      const tr = M.reset(old.type, old.run_json);
      await this.writeTransition(old, tr);
    });
  }

  /** 番茄钟跳过当前阶段（不足阈值的误触不记账） */
  async skipPhase(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.timerById(id);
      if (old === null) return;
      if (old.run_state !== RUN_RUNNING) return;
      const tr = M.skipPhase(old.type, old.config_json, old.run_json, Date.now());
      if (tr.noop) return;
      await this.writeTransition(old, tr);
    });
  }

  // ---- 到点结算（§3.5）+ 单调时钟守卫（§3.6）----

  async settleDue(now: number = Date.now()): Promise<Settled[]> {
    // 与用户操作同锁：到点推进的「读旧行 → 改 → 写」中间若插进用户 stop/segment/skipPhase，
    // 会各写一条记录或把已 stopped 的行留在 running
    return this.withWriteLock<Settled[]>(async (): Promise<Settled[]> => {
      const settled: Settled[] = [];
      const running = await this.db.runningTimers();
      for (let i = 0; i < running.length; i++) {
        const t = await this.guardMonoClock(running[i], now);
        const run = parseRun(t.run_json);
        if (this.isPomodoro(t)) {
          const end = run.phase_ends_at;
          if (end === null) continue;
          if (end <= now) {
            const tr = M.advancePomodoro(t.type, t.config_json, t.run_json, end, now);
            const next = await this.writeTransition(t, tr);
            settled.push(new Settled(next, tr.settledKind ?? '', tr.settledPhase));
          }
        } else if (t.type === TYPE_PRECISE) {
          const target = run.target_at;
          if (target === null) continue;
          if (target <= now) {
            const tr = M.finishPrecise(t.type, t.config_json, target);
            const next = await this.writeTransition(t, tr);
            settled.push(new Settled(next, tr.settledKind ?? '', null));
          }
        }
      }
      return settled;
    });
  }

  /** 墙钟跳变超阈值时用单调钟修正目标时刻；无跳变则原样返回。
   *  仅由 settleDue 在持锁状态下调用（读旧行 → 算迁移 → 写库全程都在锁内）。 */
  private async guardMonoClock(t: TimerItem, now: number): Promise<TimerItem> {
    let baseline = this.monoBaselines.get(t.id);
    if (baseline === undefined) {
      const seed = M.baselineFor(t.type, t.config_json, t.run_json, now);
      baseline = new MonoBaseline(monoNow(), now, seed[0], seed[1]);
      this.monoBaselines.set(t.id, baseline);
    }
    const monoElapsed = monoNow() - baseline.monoStart;
    const wallElapsed = now - baseline.wallStart;
    const tr = M.guardMono(t.type, t.config_json, t.run_json, now, monoElapsed, wallElapsed,
      baseline.remainingAtStart, baseline.elapsedAtStart);
    if (tr === null) return t;
    return this.writeTransition(t, tr);
  }

  // ---- 记录 ----

  private async insertRecordRaw(t: TimerItem, startedAt: number, endedAt: number, durationSec: number,
    recordType: string, phaseKey: string = '', completedFocus: number = 0): Promise<void> {
    // 不足 1 秒的脏段已在 Machine 的 Transition.addRecord 里按契约判据拦掉，这里不再重复一套规则
    const r = new TimerRecord();
    // phaseKey 非空 → 确定性 id：多端并行结算同一阶段算出同一个 id，upsert 后只剩一条
    r.id = phaseKey.length > 0 ? recordId(t.id, t.session_id, phaseKey, completedFocus) : uuid();
    r.user_id = this.auth.uid();
    r.timer_id = t.id;
    r.session_id = t.session_id;
    r.started_at = startedAt;
    r.ended_at = endedAt;
    r.duration_sec = durationSec;
    r.record_type = recordType;
    r.version = 1;
    r.updated_at = Date.now();
    r.origin_device_id = this.auth.deviceId();
    await this.putRecord(r, 'create', null);
  }

  async deleteRecord(id: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const old = await this.db.recordById(id);
      if (old === null) return;
      const e = new TimerRecord();
      e.id = old.id; e.user_id = old.user_id; e.timer_id = old.timer_id; e.session_id = old.session_id;
      e.started_at = old.started_at; e.ended_at = old.ended_at; e.duration_sec = old.duration_sec;
      e.record_type = old.record_type; e.version = old.version + 1; e.updated_at = Date.now();
      e.deleted = true; e.origin_device_id = old.origin_device_id;
      await this.db.inTransaction<void>(async () => {
        await this.putRecord(e, 'delete', old.version);
      });
    });
  }

  async timerById(id: string): Promise<TimerItem | null> {
    return this.db.timerById(id);
  }

  async timers(): Promise<TimerItem[]> {
    return this.db.timers();
  }

  async recordsOfTimerSince(timerId: string, since: number): Promise<TimerRecord[]> {
    return this.db.recordsOfTimerSince(timerId, since);
  }

  /** 记录 → 按天统计（口径全在 Contract.contribute，本端只负责分组） */
  async dailyStats(): Promise<DayStat[]> {
    const timers = await this.db.allTimerRows();
    const rows = await this.db.statRecords();
    const type = new Map<string, string>();
    const cfgs = new Map<string, Record<string, Object> | null>();
    for (let i = 0; i < timers.length; i++) {
      type.set(timers[i].id, timers[i].type);
      cfgs.set(timers[i].id, parseConfig(timers[i].config_json));
    }
    const fallback = normalizePomodoro(null);
    const days: string[] = [];
    const acc = new Map<string, Contribution>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cfg = cfgs.get(r.timer_id) ?? null;
      const c = contribute(r.duration_sec, r.record_type,
        isPomodoroConfig(type.get(r.timer_id) ?? '', cfg), cfg === null ? fallback : normalizePomodoro(cfg));
      if (c.focusMs === 0 && c.rounds === 0 && c.marks === 0) continue;
      const day = dayKey(r.ended_at);
      const had = acc.get(day);
      if (had === undefined) {
        acc.set(day, { focusMs: c.focusMs, rounds: c.rounds, marks: c.marks });
        days.push(day);
      } else {
        acc.set(day, sumContribution(had, c));
      }
    }
    const out: DayStat[] = [];
    for (let i = 0; i < days.length; i++) {
      const c = acc.get(days[i]) as Contribution;
      out.push(new DayStat(days[i], c.focusMs, c.rounds, c.marks));
    }
    return out;
  }

  // ---- 里程碑（对齐 Windows timerEngine 的 addMilestone/listMilestones/deleteMilestone）----

  async milestonesOf(timerId: string): Promise<Milestone[]> {
    return this.db.milestonesOf(timerId);
  }

  /** 标记此刻：note 取用户输入并截断，marked_at 即落库时间 */
  async addMilestone(timerId: string, note: string): Promise<void> {
    await this.withWriteLock<void>(async (): Promise<void> => {
      const t = await this.db.timerById(timerId);
      if (t === null) return;
      const now = Date.now();
      const m = new Milestone();
      m.id = uuid();
      m.user_id = this.auth.uid();
      m.timer_id = timerId;
      m.note = note.trim().slice(0, 100);
      m.marked_at = now;
      m.version = 1;
      m.updated_at = now;
      m.origin_device_id = this.auth.deviceId();
      await this.db.inTransaction<void>(async () => {
        await this.putGeneric(m, 'create', null);
      });
    });
  }

  /** 返回 false 表示记录不存在或已删除（与 Windows deleteMilestone 同语义） */
  async deleteMilestone(id: string): Promise<boolean> {
    return this.withWriteLock<boolean>(async (): Promise<boolean> => {
      const old = await this.db.milestoneById(id);
      if (old === null || old.deleted) return false;
      const next = new Milestone();
      next.id = old.id; next.user_id = old.user_id; next.timer_id = old.timer_id; next.note = old.note;
      next.marked_at = old.marked_at; next.version = old.version + 1; next.updated_at = Date.now();
      next.deleted = true; next.origin_device_id = old.origin_device_id;
      await this.db.inTransaction<void>(async () => {
        await this.putGeneric(next, 'delete', old.version);
      });
      return true;
    });
  }

  // ---- 标签（对齐 Windows setTimerTags：按名匹配、只墓碑连接、标签行永不删除）----

  async tagNames(): Promise<string[]> {
    const tags = await this.db.liveTagsByName();
    const out: string[] = [];
    for (let i = 0; i < tags.length; i++) out.push(tags[i].name);
    return out;
  }

  /** 计时 → 标签名（按名字排序，与 Windows refreshTags 同口径） */
  async tagsByTimer(): Promise<Map<string, string[]>> {
    const links = await this.db.timerTagJoin();
    const byId = new Map<string, Tag>();
    const tags = await this.db.allTags();
    for (let i = 0; i < tags.length; i++) byId.set(tags[i].id, tags[i]);
    const out = new Map<string, string[]>();
    for (let i = 0; i < links.length; i++) {
      const g = byId.get(links[i].tag_id);
      if (g === undefined) continue;
      const had = out.get(links[i].timer_id);
      if (had === undefined) out.set(links[i].timer_id, [g.name]);
      else had.push(g.name);
    }
    return out;
  }

  static cleanTagNames(names: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i].trim().slice(0, 20);
      if (n.length === 0) continue;
      if (out.indexOf(n) >= 0) continue;
      out.push(n);
      if (out.length >= 8) break; // 最多 8 个，用于筛选
    }
    return out;
  }

  /** 覆盖式设置一个计时的标签：缺的补、多的墓碑；返回最终生效的名字。
   *  连接行的「读旧行 → 改 → 写」同样持锁，避免与并发写交错出重复连接。 */
  async setTimerTags(timerId: string, names: string[]): Promise<string[]> {
    const wanted = Repo.cleanTagNames(names);
    return this.withWriteLock<string[]>(async (): Promise<string[]> => {
      const now = Date.now();
      const uid = this.auth.uid();
      const device = this.auth.deviceId();
      await this.db.inTransaction<void>(async () => {
        const keepTagIds: string[] = [];
        for (let i = 0; i < wanted.length; i++) {
          let tag = await this.db.tagByName(wanted[i]);
          if (tag === null) {
            const created = new Tag();
            created.id = uuid();
            created.user_id = uid;
            created.name = wanted[i];
            created.color = tagColorFor(wanted[i]);
            created.version = 1;
            created.updated_at = now;
            created.origin_device_id = device;
            await this.putGeneric(created, 'create', null);
            tag = created;
          }
          keepTagIds.push(tag.id);
          const links = await this.db.timerTagsOfTimer(timerId);
          let exists = false;
          for (let k = 0; k < links.length; k++) {
            if (links[k].tag_id === tag.id) exists = true;
          }
          if (!exists) {
            const link = new TimerTag();
            link.id = uuid();
            link.user_id = uid;
            link.timer_id = timerId;
            link.tag_id = tag.id;
            link.version = 1;
            link.updated_at = now;
            link.origin_device_id = device;
            await this.putGeneric(link, 'create', null);
          }
        }
        const current = await this.db.timerTagsOfTimer(timerId);
        for (let i = 0; i < current.length; i++) {
          const l = current[i];
          if (keepTagIds.indexOf(l.tag_id) >= 0) continue;
          const next = new TimerTag();
          next.id = l.id; next.user_id = l.user_id; next.timer_id = l.timer_id; next.tag_id = l.tag_id;
          next.version = l.version + 1; next.updated_at = now; next.deleted = true;
          next.origin_device_id = l.origin_device_id;
          await this.putGeneric(next, 'delete', l.version);
        }
      });
      return wanted;
    });
  }

  async tagsOfTimer(timerId: string): Promise<string[]> {
    const map = await this.tagsByTimer();
    const had = map.get(timerId);
    return had === undefined ? [] : had;
  }

  // ---- 全量导出 / 导入（与 Windows electron/exporter.ts 同格式，文件可互导）----

  async exportJson(): Promise<string> {
    const items = await this.db.allTimerRows();
    const recs = await this.db.allRecords();
    const tags = await this.db.allTags();
    const links = await this.db.allTimerTags();
    const ms = await this.db.allMilestones();
    const payload: Record<string, Object> = {};
    payload['app'] = 'TimeMark' as Object;
    payload['schema_version'] = 1 as Object;
    payload['exported_at'] = Date.now() as Object;
    payload['device_id'] = this.auth.deviceId() as Object;
    payload['timer_item'] = dumpRows(items) as Object;
    payload['tag'] = dumpRows(tags) as Object;
    payload['timer_tag'] = dumpRows(links) as Object;
    payload['milestone'] = dumpRows(ms) as Object;
    payload['timer_record'] = dumpRows(recs) as Object;
    return JSON.stringify(payload, null, 2);
  }

  /**
   * 导入：校验 app/schema_version → 按列白名单 INSERT OR REPLACE（id 复用、同 id 覆盖），
   * 再把每行重新入队上传；未登录时只落本地。返回各表写入行数，失败时 error 非空。
   */
  async importJson(text: string): Promise<ImportSummary> {
    return this.withWriteLock<ImportSummary>(async (): Promise<ImportSummary> => {
      const s = new ImportSummary();
      let root: Record<string, Object>;
      try {
        root = JSON.parse(text) as Record<string, Object>;
      } catch (e) {
        s.error = '备份文件不是合法 JSON';
        return s;
      }
      if (root === undefined || root === null || strAt(root, 'app') !== 'TimeMark' ||
        (numAt(root, 'schema_version') ?? 0) !== 1) {
        s.error = '不是有效的 TimeMark 备份文件';
        return s;
      }
      const tables: string[] = ['timer_item', 'tag', 'timer_tag', 'milestone', 'timer_record'];
      const imported: SyncRowBox[] = [];
      await this.db.inTransaction<void>(async () => {
        for (let i = 0; i < tables.length; i++) {
          const table = tables[i];
          const cols = columnsOf(table);
          if (cols === null) continue;
          const rows = root[table];
          if (rows === undefined || !Array.isArray(rows)) continue;
          const arr = rows as Object[];
          for (let j = 0; j < arr.length; j++) {
            const row = arr[j] as Record<string, Object>;
            if (strAt(row, 'id') === null) continue;
            const values: (string | number | null)[] = [];
            for (let k = 0; k < cols.length; k++) {
              values.push(cellOf(row, cols[k]));
            }
            const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
            await this.db.exec(sql, values);
            const deleted = cellOf(row, 'deleted') === 1;
            imported.push(new SyncRowBox(table, strAt(row, 'id') ?? '', deleted));
            if (table === 'timer_item') s.timer_item++;
            else if (table === 'tag') s.tag++;
            else if (table === 'timer_tag') s.timer_tag++;
            else if (table === 'milestone') s.milestone++;
            else s.timer_record++;
          }
        }
      });
      // 导入即视为本地变更：全部重新入队，登录状态下会推向服务端
      for (let i = 0; i < imported.length; i++) {
        const it = imported[i];
        const row = await this.rowOfTable(it.table, it.id);
        if (row === null) continue;
        await this.enqueue(it.table, it.deleted ? 'delete' : 'create', it.id, rowPayloadJson(row), null, false, Date.now());
      }
      return s;
    });
  }

  private async rowOfTable(table: string, id: string): Promise<SyncRow | null> {
    if (table === 'timer_item') return this.db.timerById(id);
    if (table === 'timer_record') return this.db.recordById(id);
    if (table === 'tag') return this.db.tagById(id);
    if (table === 'milestone') return this.db.milestoneById(id);
    if (table === 'timer_tag') return this.db.timerTagById(id);
    return null;
  }

  /** 构建 config_json：番茄钟输出 canonical 落位，夹紧与默认值由契约决定 */
  buildConfigJson(logicalType: string, targetDate: string | null, presetMin: number | null,
    focusMin: number | null, shortMin: number | null, longMin: number | null, rounds: number | null,
    timezoneId: string): string {
    if (logicalType === 'POMODORO') {
      const o: Record<string, Object> = {};
      o['work_ms'] = (focusMin ?? 25) * 60000 as Object;
      o['break_ms'] = (shortMin ?? 5) * 60000 as Object;
      o['long_break_ms'] = (longMin ?? 15) * 60000 as Object;
      o['rounds'] = (rounds ?? 4) as Object;
      return JSON.stringify(buildPomodoroConfig(o));
    }
    if (logicalType === TYPE_PRECISE) {
      return JSON.stringify(buildPreciseConfig((presetMin ?? 25) * 60000));
    }
    if (logicalType === TYPE_DATE) {
      const o: Record<string, Object> = {};
      o['schema_version'] = 1 as Object;
      o['target_date'] = (targetDate ?? '') as Object;
      o['timezone_id'] = timezoneId as Object;
      o['include_today'] = false as Object;
      return JSON.stringify(o);
    }
    if (logicalType === TYPE_STOPWATCH) {
      const sw: Record<string, Object> = {};
      sw['schema_version'] = 1 as Object;
      return JSON.stringify(sw);
    }
    return '{}';
  }
}

/** 单元格 → 可写值：布尔归 0/1，数字/字符串原样，其余（含缺失）为 null */
function cellOf(row: Record<string, Object>, col: string): string | number | null {
  const v: Object | undefined = row[col];
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return (v as boolean) ? 1 : 0;
  if (typeof v === 'number') return v as number;
  if (typeof v === 'string') return v as string;
  return null;
}

class SyncRowBox {
  table: string;
  id: string;
  deleted: boolean;

  constructor(table: string, id: string, deleted: boolean) {
    this.table = table;
    this.id = id;
    this.deleted = deleted;
  }
}

function dumpRows(rows: SyncRow[]): Object[] {
  const out: Object[] = [];
  for (let i = 0; i < rows.length; i++) out.push(rawRowObject(rows[i]) as Object);
  return out;
}
