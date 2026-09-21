// 纯状态机（§3.3/§3.5/§3.6）：只吃「type + config_json + run_json + 墙钟/单调量」，
// 吐出新的运行态与需要落库的记录意图，不碰数据库、不碰 @kit——
// 因此 tools/harmony-engine-test.mjs 能在 node 里直接断言迁移序列（对齐 Windows engine.test.cjs）。
// 语义与 Android data/TimerRepository.kt、Windows electron/timerEngine.ts 逐条一致。
import {
  MONO_GUARD_MS, NormalizedPomodoro, PARTIAL_SETTLE_MIN_MS, PHASE_BREAK, PHASE_FOCUS, PHASE_LONG_BREAK,
  RECORD_POMODORO_BREAK, RECORD_POMODORO_FOCUS, RECORD_PRECISE, RECORD_SEGMENT, RECORD_STOPWATCH,
  RUN_IDLE, RUN_PAUSED, RUN_RUNNING, TYPE_DATE, TYPE_PRECISE, TYPE_STOPWATCH,
  isLongBreakDue, isPomodoroConfig, normalizePomodoro, numAt, parseConfig, phasePresetMs,
  autoPhaseStamp, manualStamp, isRecordable, nextPhaseOf, Stamp
} from './Contract';
import { RunJson, parseRun } from './Engine';

/** 一条要写入 timer_record 的意图 */
export class RecIntent {
  startedAt: number = 0;
  endedAt: number = 0;
  durationSec: number = 0;
  recordType: string = RECORD_SEGMENT;
  /** 非空 → 记录 id 由 (timer, session, 阶段, 已完成专注数) 推出，让多端重复结算折叠成一条 */
  phaseKey: string = '';
  completedFocus: number = 0;

  constructor(startedAt: number, endedAt: number, durationSec: number, recordType: string,
    phaseKey?: string, completedFocus?: number) {
    this.startedAt = startedAt;
    this.endedAt = endedAt;
    this.durationSec = durationSec;
    this.recordType = recordType;
    if (phaseKey !== undefined) this.phaseKey = phaseKey;
    if (completedFocus !== undefined) this.completedFocus = completedFocus;
  }
}

export class Transition {
  /** 落库后的 run_state */
  runState: string = RUN_IDLE;
  /** 落库后的 run_json 结构 */
  run: RunJson = new RunJson();
  /** true → 调用方生成新 session_id（每次从 idle 进入 running） */
  newSession: boolean = false;
  /** true → 调用方把 session_id 置空（到点完成） */
  clearSession: boolean = false;
  /** 需要写入的记录 */
  records: RecIntent[] = [];

  /** 唯一的记录出口：时刻/取整走契约 Stamp，不可记账的脏段在这里拦掉（规则只在契约里写一次） */
  addRecord(st: Stamp, recordType: string, phaseKey?: string, completedFocus?: number): void {
    if (!isRecordable(st)) return;
    this.records.push(new RecIntent(st.startedAt, st.endedAt, st.durationSec, recordType, phaseKey, completedFocus));
  }
  /** 需要重建单调基准（进入/续接 running） */
  baselineRemaining: number = 0;
  baselineElapsed: number = 0;
  setBaseline: boolean = false;
  /** 需要作废单调基准（pause/stop/reset/到点） */
  dropBaseline: boolean = false;
  /** 结算类型与推进后的阶段（供通知文案） */
  settledKind: string | null = null;
  settledPhase: string | null = null;
  /** 是否由 no-op 提前返回（例如 preset 缺失、非番茄钟跳阶段） */
  noop: boolean = false;

  static nochange(): Transition {
    const t = new Transition();
    t.noop = true;
    return t;
  }
}

function cloneRun(r: RunJson): RunJson {
  const c = new RunJson();
  c.target_at = r.target_at;
  c.remaining_at_pause = r.remaining_at_pause;
  c.accumulated_ms = r.accumulated_ms;
  c.segment_started_at = r.segment_started_at;
  c.phase = r.phase;
  c.phase_ends_at = r.phase_ends_at;
  c.completed_focus = r.completed_focus;
  c.segments_ms = r.segments_ms.slice(0);
  return c;
}

function sum(arr: number[]): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

function pomoOf(configJson: string | null): NormalizedPomodoro {
  return normalizePomodoro(parseConfig(configJson));
}

function isPomo(type: string, configJson: string | null): boolean {
  return isPomodoroConfig(type, parseConfig(configJson));
}

/** idle/paused → running；每次进入都算新 session */
export function start(type: string, configJson: string | null, now: number): Transition {
  const cfg = parseConfig(configJson);
  const t = new Transition();
  t.newSession = true;
  t.setBaseline = true;
  if (isPomodoroConfig(type, cfg)) {
    const p = pomoOf(configJson);
    const r = new RunJson();
    r.phase = PHASE_FOCUS;
    r.phase_ends_at = now + p.work_ms;
    r.completed_focus = 0;
    t.run = r;
    t.runState = RUN_RUNNING;
    t.baselineRemaining = p.work_ms;
    return t;
  }
  if (type === TYPE_PRECISE) {
    const preset = numAt(cfg, 'preset_ms');
    if (preset === null) return Transition.nochange();
    const r = new RunJson();
    r.target_at = now + preset;
    t.run = r;
    t.runState = RUN_RUNNING;
    t.baselineRemaining = preset;
    return t;
  }
  if (type === TYPE_STOPWATCH) {
    const r = new RunJson();
    r.accumulated_ms = 0;
    r.segment_started_at = now;
    t.run = r;
    t.runState = RUN_RUNNING;
    t.baselineElapsed = 0;
    return t;
  }
  return Transition.nochange();
}

export function pause(type: string, configJson: string | null, runJson: string | null, now: number): Transition {
  const r = cloneRun(parseRun(runJson));
  const t = new Transition();
  t.dropBaseline = true;
  if (isPomo(type, configJson)) {
    r.remaining_at_pause = Math.max(0, (r.phase_ends_at ?? now) - now);
  } else if (type === TYPE_PRECISE) {
    r.remaining_at_pause = Math.max(0, (r.target_at ?? now) - now);
  } else if (type === TYPE_STOPWATCH) {
    r.accumulated_ms = (r.accumulated_ms ?? 0) + Math.max(0, now - (r.segment_started_at ?? now));
    r.segment_started_at = null;
  } else {
    return Transition.nochange();
  }
  t.run = r;
  t.runState = RUN_PAUSED;
  return t;
}

export function resume(type: string, configJson: string | null, runJson: string | null, now: number): Transition {
  const r = cloneRun(parseRun(runJson));
  const t = new Transition();
  t.setBaseline = true;
  if (isPomo(type, configJson)) {
    const rem = r.remaining_at_pause ?? 0;
    r.phase_ends_at = now + rem;
    r.remaining_at_pause = null;
    t.baselineRemaining = rem;
  } else if (type === TYPE_PRECISE) {
    const rem = r.remaining_at_pause ?? 0;
    r.target_at = now + rem;
    r.remaining_at_pause = null;
    t.baselineRemaining = rem;
  } else if (type === TYPE_STOPWATCH) {
    const acc = r.accumulated_ms ?? 0;
    r.segment_started_at = now;
    t.baselineElapsed = acc;
  } else {
    return Transition.nochange();
  }
  t.run = r;
  t.runState = RUN_RUNNING;
  return t;
}

/**
 * 分段：精确倒计时打点不中断（保留 target_at/session），正计时记一个 lap 继续；
 * 番茄钟无手动打点（返回 no-op）。暂停态同样可结算。
 */
export function segment(type: string, configJson: string | null, runJson: string | null,
  runState: string, now: number): Transition {
  if (isPomo(type, configJson)) return Transition.nochange();
  if (runState !== RUN_RUNNING && runState !== RUN_PAUSED) return Transition.nochange();
  const cfg = parseConfig(configJson);
  const r = cloneRun(parseRun(runJson));
  const t = new Transition();
  const running = runState === RUN_RUNNING;
  if (type === TYPE_PRECISE) {
    const preset = numAt(cfg, 'preset_ms');
    if (preset === null) return Transition.nochange();
    const totalElapsed = running
      ? preset - Math.max(0, (r.target_at ?? now) - now)
      : preset - (r.remaining_at_pause ?? 0);
    const seg = totalElapsed - sum(r.segments_ms);
    if (seg <= 0) return Transition.nochange(); // 无新分段（防重复打点）
    r.segments_ms.push(seg);
    t.addRecord(manualStamp(now, seg), RECORD_SEGMENT);
    t.run = r;
    t.runState = runState;
    return t;
  }
  if (type === TYPE_STOPWATCH) {
    const total = running
      ? (r.accumulated_ms ?? 0) + Math.max(0, now - (r.segment_started_at ?? now))
      : (r.accumulated_ms ?? 0);
    const lap = total - sum(r.segments_ms);
    if (lap <= 0) return Transition.nochange();
    r.segments_ms.push(lap);
    t.addRecord(manualStamp(now, lap), RECORD_SEGMENT);
    r.accumulated_ms = total;
    if (running) {
      r.segment_started_at = now;
      t.setBaseline = true;
      t.baselineElapsed = total;
    }
    t.run = r;
    t.runState = runState;
    return t;
  }
  return Transition.nochange();
}

/**
 * 结束：如实结算已进行时长后归零。不足 PARTIAL_SETTLE_MIN_MS 视为误触不记账。
 * 注意 session 保留（与双端一致）——只有"到点完成"才清空 session。
 */
export function stop(type: string, configJson: string | null, runJson: string | null,
  runState: string, now: number): Transition {
  if (runState === RUN_IDLE) return Transition.nochange();
  const cfg = parseConfig(configJson);
  const r = parseRun(runJson);
  const paused = runState === RUN_PAUSED;
  const t = new Transition();
  t.dropBaseline = true;
  if (isPomodoroConfig(type, cfg)) {
    const p = normalizePomodoro(cfg);
    const phase = r.phase ?? PHASE_FOCUS;
    const preset = phasePresetMs(p, phase);
    const remaining = paused ? Math.max(0, r.remaining_at_pause ?? 0) : Math.max(0, (r.phase_ends_at ?? now) - now);
    const elapsed = Math.max(0, preset - remaining);
    if (elapsed >= PARTIAL_SETTLE_MIN_MS) {
      t.addRecord(manualStamp(now, elapsed),
        phase === PHASE_FOCUS ? RECORD_POMODORO_FOCUS : RECORD_POMODORO_BREAK, phase, r.completed_focus ?? 0);
    }
  } else if (type === TYPE_PRECISE) {
    const preset = numAt(cfg, 'preset_ms');
    if (preset === null) return Transition.nochange();
    const remaining = paused ? Math.max(0, r.remaining_at_pause ?? 0) : Math.max(0, (r.target_at ?? now) - now);
    const elapsed = Math.max(0, preset - remaining);
    if (elapsed >= PARTIAL_SETTLE_MIN_MS) {
      t.addRecord(manualStamp(now, elapsed), RECORD_PRECISE, 'precise', 0);
    }
  } else if (type === TYPE_STOPWATCH) {
    const total = runState === RUN_RUNNING
      ? (r.accumulated_ms ?? 0) + Math.max(0, now - (r.segment_started_at ?? now))
      : (r.accumulated_ms ?? 0);
    if (total >= PARTIAL_SETTLE_MIN_MS) {
      t.addRecord(manualStamp(now, total), RECORD_STOPWATCH);
    }
  }
  const fresh = new RunJson();
  t.run = fresh;
  t.runState = RUN_IDLE;
  return t;
}

/** 归零：不记账（区别于 stop 的"如实结算"） */
export function reset(type: string, runJson: string | null): Transition {
  if (type === TYPE_DATE) return Transition.nochange();
  const t = new Transition();
  const r = new RunJson();
  if (type === TYPE_STOPWATCH) r.accumulated_ms = 0;
  t.run = r;
  t.runState = RUN_IDLE;
  t.dropBaseline = true;
  return t;
}

/** 番茄钟跳阶段：不足阈值的误触不记账，直接进下一阶段 */
export function skipPhase(type: string, configJson: string | null, runJson: string | null, now: number): Transition {
  if (!isPomo(type, configJson)) return Transition.nochange();
  const r = parseRun(runJson);
  const p = pomoOf(configJson);
  const phase = r.phase ?? PHASE_FOCUS;
  const isFocus = phase === PHASE_FOCUS;
  const elapsed = phasePresetMs(p, phase) - Math.max(0, (r.phase_ends_at ?? now) - now);
  const t = new Transition();
  if (elapsed >= PARTIAL_SETTLE_MIN_MS) {
    t.addRecord(manualStamp(now, elapsed),
      isFocus ? RECORD_POMODORO_FOCUS : RECORD_POMODORO_BREAK, phase, r.completed_focus ?? 0);
  }
  const np = nextPhaseOf(p, phase, r.completed_focus);
  const nextPreset = phasePresetMs(p, np.phase);
  const nr = new RunJson();
  nr.phase = np.phase;
  nr.phase_ends_at = now + nextPreset;
  nr.completed_focus = np.completedFocus;
  t.run = nr;
  t.runState = RUN_RUNNING;
  t.setBaseline = true;
  t.baselineRemaining = nextPreset;
  t.settledKind = isFocus ? RECORD_POMODORO_FOCUS : RECORD_POMODORO_BREAK;
  t.settledPhase = np.phase;
  return t;
}

/** 精确倒计时到点：按预设整段记账并归零（清空 session） */
export function finishPrecise(type: string, configJson: string | null, endedAt: number): Transition {
  const cfg = parseConfig(configJson);
  const preset = numAt(cfg, 'preset_ms') ?? 0;
  const t = new Transition();
  t.addRecord(autoPhaseStamp(endedAt, preset), RECORD_PRECISE, 'precise', 0);
  t.run = new RunJson();
  t.runState = RUN_IDLE;
  t.clearSession = true;
  t.dropBaseline = true;
  t.settledKind = RECORD_PRECISE;
  return t;
}

/**
 * 番茄钟阶段推进：focus→break/long_break→focus 无限轮；
 * 下一阶段的 phase_ends_at 从 now 起算——漏掉的时间不补记、也不自动连跳多轮（§3.5）。
 */
export function advancePomodoro(type: string, configJson: string | null, runJson: string | null,
  phaseEnd: number, now: number): Transition {
  const p = pomoOf(configJson);
  const r = parseRun(runJson);
  const phase = r.phase ?? PHASE_FOCUS;
  const isFocus = phase === PHASE_FOCUS;
  const dur = phasePresetMs(p, phase);
  const t = new Transition();
  t.addRecord(autoPhaseStamp(phaseEnd, dur),
    isFocus ? RECORD_POMODORO_FOCUS : RECORD_POMODORO_BREAK, phase, r.completed_focus ?? 0);
  const np = nextPhaseOf(p, phase, r.completed_focus);
  const nextPreset = phasePresetMs(p, np.phase);
  const nr = new RunJson();
  nr.phase = np.phase;
  nr.phase_ends_at = now + nextPreset;
  nr.completed_focus = np.completedFocus;
  t.run = nr;
  t.runState = RUN_RUNNING;
  t.setBaseline = true;
  t.baselineRemaining = nextPreset;
  t.settledKind = isFocus ? RECORD_POMODORO_FOCUS : RECORD_POMODORO_BREAK;
  t.settledPhase = np.phase;
  return t;
}

/** 进程重启后懒重建单调基准所需的段起点剩余/累计（以当前墙钟为准） */
export function baselineFor(type: string, configJson: string | null, runJson: string | null,
  now: number): number[] {
  const r = parseRun(runJson);
  if (isPomo(type, configJson)) return [Math.max(0, (r.phase_ends_at ?? now) - now), 0];
  if (type === TYPE_PRECISE) return [Math.max(0, (r.target_at ?? now) - now), 0];
  return [0, (r.accumulated_ms ?? 0) + Math.max(0, now - (r.segment_started_at ?? now))];
}

/**
 * §3.6 单调时钟守卫：墙钟与单调钟偏差超 MONO_GUARD_MS 时用单调钟修正目标时刻。
 * 返回 null 表示无显著跳变（不需要写库）。
 */
export function guardMono(type: string, configJson: string | null, runJson: string | null, now: number,
  monoElapsed: number, wallElapsed: number, baselineRemaining: number, baselineElapsed: number): Transition | null {
  if (Math.abs(wallElapsed - monoElapsed) <= MONO_GUARD_MS) return null;
  const r = cloneRun(parseRun(runJson));
  const t = new Transition();
  if (isPomo(type, configJson)) {
    const corrected = Math.max(0, baselineRemaining - monoElapsed);
    r.phase_ends_at = now + corrected;
    t.baselineRemaining = corrected;
  } else if (type === TYPE_PRECISE) {
    const corrected = Math.max(0, baselineRemaining - monoElapsed);
    r.target_at = now + corrected;
    t.baselineRemaining = corrected;
  } else if (type === TYPE_STOPWATCH) {
    const corrected = baselineElapsed + monoElapsed;
    r.accumulated_ms = corrected;
    r.segment_started_at = now;
    t.baselineElapsed = corrected;
  } else {
    return null;
  }
  t.run = r;
  t.runState = RUN_RUNNING;
  t.setBaseline = true;
  return t;
}
