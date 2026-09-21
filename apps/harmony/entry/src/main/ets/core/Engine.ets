// 展示层引擎（与 apps/android/.../core/Core.kt 的 Engine/Fmt/Types 对齐）。
// 只负责「由持久化字段 + 当前墙钟推导读数」与状态迁移所需的纯计算，任何显示值都不回写数据库；
// 业务语义（默认值/夹紧/统计口径）一律在 core/Contract.ets，不在这里重复决定。
// 本文件禁止 import @kit/@ohos：Machine/Repo 的行为单测要在 node 里直接加载它（时区算法在 core/Time.ets）。
import {
  PHASE_FOCUS, RUN_PAUSED, RUN_RUNNING, TYPE_PRECISE, TYPE_STOPWATCH,
  isPomodoroConfig, normalizePomodoro, numAt, parseConfig, phasePresetMs
} from './Contract';

export class RunJson {
  target_at: number | null = null;
  remaining_at_pause: number | null = null;
  accumulated_ms: number | null = null;
  segment_started_at: number | null = null;
  phase: string | null = null;
  phase_ends_at: number | null = null;
  completed_focus: number = 0;
  segments_ms: number[] = [];
}

/** run_json 文本 → 结构；坏数据一律退化成空快照（与双端 safeParse 同策略） */
export function parseRun(jsonStr: string | null): RunJson {
  const r = new RunJson();
  const cfg = parseConfig(jsonStr);
  if (cfg === null) {
    return r;
  }
  r.target_at = numAt(cfg, 'target_at');
  r.remaining_at_pause = numAt(cfg, 'remaining_at_pause');
  r.accumulated_ms = numAt(cfg, 'accumulated_ms');
  r.segment_started_at = numAt(cfg, 'segment_started_at');
  r.phase = strOrNull(cfg, 'phase');
  r.phase_ends_at = numAt(cfg, 'phase_ends_at');
  const cf = numAt(cfg, 'completed_focus');
  r.completed_focus = cf === null ? 0 : cf;
  const segs = cfg['segments_ms'];
  if (segs !== undefined && Array.isArray(segs)) {
    const arr = segs as number[];
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] === 'number') r.segments_ms.push(arr[i]);
    }
  }
  return r;
}

function strOrNull(cfg: Record<string, Object>, key: string): string | null {
  const v: Object | undefined = cfg[key];
  return typeof v === 'string' ? (v as string) : null;
}

/** 结构 → run_json 文本。null 字段不写出（与 Android explicitNulls=false、Windows JSON.stringify 同形）。
 *  completed_focus / segments_ms 只在非默认值时写出：避免空闲行写为 `{"completed_focus":0,"segments_ms":[]}`
 *  而 Windows/Android 写 null，同一行在三端之间同步时会因字节差异反复触发版本上推。
 *  注意：测试可能传入普通对象而非 RunJson 实例，需防御 undefined。 */
export function runToJson(r: RunJson): Record<string, Object> {
  const o: Record<string, Object> = {};
  if (r.target_at !== null && r.target_at !== undefined) o['target_at'] = r.target_at;
  if (r.remaining_at_pause !== null && r.remaining_at_pause !== undefined) o['remaining_at_pause'] = r.remaining_at_pause;
  if (r.accumulated_ms !== null && r.accumulated_ms !== undefined) o['accumulated_ms'] = r.accumulated_ms;
  if (r.segment_started_at !== null && r.segment_started_at !== undefined) o['segment_started_at'] = r.segment_started_at;
  if (r.phase !== null && r.phase !== undefined) o['phase'] = r.phase;
  if (r.phase_ends_at !== null && r.phase_ends_at !== undefined) o['phase_ends_at'] = r.phase_ends_at;
  if (r.completed_focus !== undefined && r.completed_focus !== 0) o['completed_focus'] = r.completed_focus;
  if (r.segments_ms !== undefined && r.segments_ms.length > 0) o['segments_ms'] = r.segments_ms;
  return o;
}

export function runToJsonString(r: RunJson): string {
  return JSON.stringify(runToJson(r));
}

export interface LiveState {
  runState: string;
  remainingMs: number;
  elapsedMs: number;
  phase: string | null;
  round: number;
  daysLeft: number | null;
  targetAt: number | null;
  due: boolean;
}

function live(runState: string, remaining: number, elapsed: number, phase: string | null,
  round: number, daysLeft: number | null, targetAt: number | null, due: boolean): LiveState {
  return {
    runState: runState, remainingMs: remaining, elapsedMs: elapsed, phase: phase,
    round: round, daysLeft: daysLeft, targetAt: targetAt, due: due
  };
}

/** §3 通用状态计算：给定行的 JSON 快照 + 当前墙钟，推导 UI 所需的全部派生量。 */
export function liveState(type: string, runState: string, runJsonStr: string | null,
  configJsonStr: string | null, now: number): LiveState {
  const run = parseRun(runJsonStr);
  const cfg = parseConfig(configJsonStr);
  if (isPomodoroConfig(type, cfg)) {
    return pomodoroLive(runState, run, cfg, now);
  }
  if (type === TYPE_PRECISE) {
    const preset = numAt(cfg, 'preset_ms') ?? 0;
    if (runState === RUN_RUNNING) {
      const rem = (run.target_at ?? now) - now;
      return live(runState, Math.max(0, rem), preset - Math.max(0, rem), null, 0, null, run.target_at, rem <= 0);
    }
    if (runState === RUN_PAUSED) {
      const rem = run.remaining_at_pause ?? 0;
      return live(runState, rem, preset - rem, null, 0, null, null, false);
    }
    return live(runState, preset, 0, null, 0, null, null, false);
  }
  if (type === TYPE_STOPWATCH) {
    const acc = run.accumulated_ms ?? 0;
    if (runState === RUN_RUNNING) {
      return live(runState, 0, acc + Math.max(0, now - (run.segment_started_at ?? now)), null, 0, null, null, false);
    }
    return live(runState, 0, acc, null, 0, null, null, false);
  }
  return live(runState, 0, 0, null, 0, null, null, false);
}

function pomodoroLive(runState: string, run: RunJson, cfg: Record<string, Object> | null, now: number): LiveState {
  const p = normalizePomodoro(cfg);
  const phase = run.phase ?? PHASE_FOCUS;
  const isFocus = phase === PHASE_FOCUS;
  const preset = phasePresetMs(p, phase);
  // 轮次：专注中显示正在进行的第 completed+1 轮，休息中显示刚完成的第 completed 轮
  const round = isFocus ? run.completed_focus + 1 : run.completed_focus;
  if (runState === RUN_RUNNING) {
    const rem = (run.phase_ends_at ?? now) - now;
    return live(runState, Math.max(0, rem), preset - Math.max(0, rem), phase, round, null, null, rem <= 0);
  }
  if (runState === RUN_PAUSED) {
    const rem = run.remaining_at_pause ?? 0;
    return live(runState, rem, preset - rem, phase, round, null, null, false);
  }
  return live(runState, preset, 0, phase, round, null, null, false);
}


/** 时长读数：h:mm:ss 或 mm:ss（与 Android Fmt.hms 一致） */
export function hms(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m < 10 ? `0${m}` : `${m}`;
  const ss = s < 10 ? `0${s}` : `${s}`;
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 毫秒 → 「25分 / 1时30分」式的简短用时（卡片副标题用） */
export function humanMin(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}时` : `${h}时${m}分`;
}

export function clockOf(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours();
  const mm = d.getMinutes();
  return `${hh < 10 ? `0${hh}` : hh}:${mm < 10 ? `0${mm}` : mm}`;
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 本地自然日键 'YYYY-MM-DD'（历史页分组、今日统计口径） */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function dayTitle(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function startOfToday(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/** 阶段中文名（详情页/通知文案） */
export function phaseLabel(phase: string | null): string {
  if (phase === 'break') return '短休息';
  if (phase === 'long_break') return '长休息';
  return '专注';
}
