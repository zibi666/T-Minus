// 跨端契约单一来源（与 apps/android/.../core/Contract.kt 逐字段镜像）。
// 默认值、夹紧边界、config_json 字段落位、isPomodoro 判定、色板只在这里定义一次；
// 两端由 shared/contract/fixtures/contract.json 表驱动测试共同校验。

export const MONO_GUARD_MS = 2000;

export const DEFAULTS = {
  work_ms: 25 * 60000,
  break_ms: 5 * 60000,
  long_break_ms: 15 * 60000,
  rounds: 4
};

/** 夹紧边界：越界一律夹回，双端必须一致（fixture 测试逐条断言） */
export const CLAMPS = {
  work_ms: [60000, 180 * 60000] as const,
  break_ms: [30000, 60 * 60000] as const,
  long_break_ms: [30000, 240 * 60000] as const,
  rounds: [1, 12] as const
};

export type PomodoroPhase = 'focus' | 'break' | 'long_break';
export const PHASE_FOCUS: PomodoroPhase = 'focus';
export const PHASE_BREAK: PomodoroPhase = 'break';
export const PHASE_LONG_BREAK: PomodoroPhase = 'long_break';

/** timer_record.record_type 全集。POMODORO_FOCUS/BREAK 让阶段成为事实而非时长猜测。 */
export const RECORD = {
  PRECISE: 'PRECISE',
  SEGMENT: 'SEGMENT',
  STOPWATCH: 'STOPWATCH',
  POMODORO_FOCUS: 'POMODORO_FOCUS',
  POMODORO_BREAK: 'POMODORO_BREAK'
} as const;
export type RecordType = (typeof RECORD)[keyof typeof RECORD];

/** 计时器色板（v3 规范 §1.3 的 8 色；两端唯一来源，Android 由 ContractTest 断言同一组十六进制） */
export const TIMER_PALETTE = [
  '#4DC9F0', '#9381FF', '#21E0C4', '#FFB224',
  '#FF6B6B', '#5A9EFF', '#F472B6', '#A3E635'
];
export const DEFAULT_TIMER_COLOR = TIMER_PALETTE[0];
/** 标签色板：按名称 charCode 求和取模（双端同算法，见 fixture tag_colors 用例） */
export const TAG_PALETTE = TIMER_PALETTE;

export const MIN_PRESET_MS = 1000;
export const MAX_PRESET_MS = 365 * 86400000;

/** 提前结束/跳阶段时的最小结算时长：不足则视为误触，不写记录（双端同一阈值） */
export const PARTIAL_SETTLE_MIN_MS = 5000;

export const RUN_STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused'
} as const;

export const TIMER_TYPES = ['DATE_COUNTDOWN', 'PRECISE_COUNTDOWN', 'STOPWATCH'] as const;

/**
 * 同步表白名单（与 backend RowStore.COLUMNS、Android 实体逐列一致）。
 * syncClient 应用远程行与引擎导入备份都从这里取，Windows 端只此一份。
 */
export const SYNC_TABLE_COLUMNS: Record<string, readonly string[]> = {
  timer_item: ['id', 'user_id', 'name', 'type', 'color', 'starred', 'pinned', 'remark',
    'config_json', 'run_state', 'session_id', 'run_json', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  tag: ['id', 'user_id', 'name', 'color', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_tag: ['id', 'user_id', 'timer_id', 'tag_id', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  milestone: ['id', 'user_id', 'timer_id', 'note', 'marked_at', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_record: ['id', 'user_id', 'timer_id', 'session_id', 'started_at', 'ended_at',
    'duration_sec', 'record_type', 'version', 'updated_at', 'deleted', 'origin_device_id']
};

function clamp(v: number | null | undefined, [lo, hi]: readonly [number, number], fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 归一后的番茄钟配置：全部字段有值且已夹紧，任何一端读到同一 config_json 都得到同一结果 */
export interface NormalizedPomodoro {
  work_ms: number;
  break_ms: number;
  long_break_ms: number;
  rounds: number;
}

/**
 * 读番茄钟配置。兼容三种历史落位：
 *   1) 规范：config.pomodoro.{work_ms,break_ms,long_break_ms,rounds}
 *   2) Android v0.4.7：长休息落在 config.long_break_ms（顶层）
 *   3) Android v0.4.6：config.{focus_ms,short_break_ms,rounds_before_long}
 * 顶层/旧字段仅在 pomodoro 内缺省时兜底，新写入一律走 buildPreciseConfig。
 */
/** 未归一的 config 片段：任何一端读到的原始 JSON 都先按这个形状取字段 */
type RawPomodoro = { work_ms?: number; break_ms?: number; long_break_ms?: number; rounds?: number };
type RawConfig = { pomodoro?: RawPomodoro | null; focus_ms?: number; short_break_ms?: number; long_break_ms?: number; rounds_before_long?: number };

export function normalizePomodoro(config: unknown): NormalizedPomodoro {
  const cfg = (config ?? {}) as RawConfig;
  const p = cfg.pomodoro ?? {};
  return {
    work_ms: clamp(p.work_ms ?? cfg.focus_ms, CLAMPS.work_ms, DEFAULTS.work_ms),
    break_ms: clamp(p.break_ms ?? cfg.short_break_ms, CLAMPS.break_ms, DEFAULTS.break_ms),
    long_break_ms: clamp(p.long_break_ms ?? cfg.long_break_ms, CLAMPS.long_break_ms, DEFAULTS.long_break_ms),
    rounds: clamp(p.rounds ?? cfg.rounds_before_long, CLAMPS.rounds, DEFAULTS.rounds)
  };
}

/** 是否番茄钟：type=PRECISE_COUNTDOWN 且存在番茄钟配置（含旧格式 focus_ms）。rounds 缺失时补默认 4 而非判否。 */
export function isPomodoroConfig(type: string, config: unknown): boolean {
  if (type !== 'PRECISE_COUNTDOWN') return false;
  const cfg = (config ?? {}) as RawConfig;
  return !!cfg.pomodoro || Number(cfg.focus_ms) > 0;
}

/** 阶段时长 */
export function phasePresetMs(p: NormalizedPomodoro, phase: PomodoroPhase | string | null | undefined): number {
  if (phase === PHASE_LONG_BREAK) return p.long_break_ms;
  if (phase === PHASE_BREAK) return p.break_ms;
  return p.work_ms;
}

/** 长休息判定：每完成 rounds 轮专注进一次长休息 */
export function isLongBreakDue(p: NormalizedPomodoro, completedFocusAfterThisRound: number): boolean {
  return completedFocusAfterThisRound > 0 && completedFocusAfterThisRound % p.rounds === 0;
}

/** 番茄钟「本阶段结束后进哪个阶段、轮次怎么变」的裁决结果 */
export interface NextPhase {
  phase: PomodoroPhase;
  completedFocus: number;
}

/**
 * 阶段推进的唯一裁决。三端各自实现一遍的话长休息节奏迟早漂移
 * （一端每 4 轮一次长休息、另一端每 5 轮，session 又互不相同，同步后无法收敛）。
 * 下一阶段的时长由 phasePresetMs(p, np.phase) 求，本函数只决定阶段与轮次计数。
 */
export function nextPhaseOf(
  p: NormalizedPomodoro,
  phase: PomodoroPhase | string | null | undefined,
  completedFocus: number
): NextPhase {
  const isFocus = phase === PHASE_FOCUS;
  const completed = completedFocus + (isFocus ? 1 : 0);
  const next: PomodoroPhase = isFocus
    ? (isLongBreakDue(p, completed) ? PHASE_LONG_BREAK : PHASE_BREAK)
    : PHASE_FOCUS;
  return { phase: next, completedFocus: completed };
}

/** 普通精确倒计时 config */
export function buildPreciseConfig(presetMs: number): Record<string, unknown> {
  return { schema_version: 1, preset_ms: clamp(presetMs, [MIN_PRESET_MS, MAX_PRESET_MS], MIN_PRESET_MS) };
}

/**
 * 番茄钟 config（canonical 落位）：long_break_ms 在 pomodoro 内（Windows/新 Android 读这里），
 * 顶层再镜像一份（v0.4.7 Android 只读顶层）——两处同写让新旧客户端都拿到同一个值。
 */
export function buildPomodoroConfig(pomo?: Partial<NormalizedPomodoro>): Record<string, unknown> {
  const n = normalizePomodoro({ pomodoro: pomo });
  return {
    schema_version: 1,
    preset_ms: n.work_ms,
    pomodoro: { work_ms: n.work_ms, break_ms: n.break_ms, long_break_ms: n.long_break_ms, rounds: n.rounds },
    long_break_ms: n.long_break_ms
  };
}

export function tagColorFor(name: string): string {
  // 逐 UTF-16 code unit 求和：Android sumOf { it.code } / 鸿蒙 charCodeAt 都是码元遍历，
  // 码点迭代会把增补平面字符（emoji）只算一次，同一名字三端会取到不同色
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return TAG_PALETTE[sum % TAG_PALETTE.length];
}

/** FNV-1a/32，逐 UTF-16 code unit 折叠（刻意不用码点迭代，避免 tagColorFor 那类跨端漂移） */
function fnv1a32(s: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 自动结算记录的去重 id：三端对「同一次阶段完成」必须算出同一个 id，
 * 于是谁先 push 都一样，服务端按 id upsert 后只剩一条 —— 多设备并行结算因此无害。
 * 只取跨设备共享的坐标（timer_id / session_id / 阶段 / 已完成专注数），
 * 刻意不含 version（各端本地计数，正是漂移来源）与 phase_ends_at（会被单调守卫改写）。
 */
export function recordId(
  timerId: string,
  sessionId: string | null | undefined,
  phaseKey: string,
  completedFocus: number
): string {
  const key = `${timerId}|${sessionId ?? ''}|${phaseKey}|${completedFocus}`;
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return 'rec-' + hex(fnv1a32(key, 2166136261)) + hex(fnv1a32(key, 2654435761));
}

/** 一条记录的时刻与时长。ended_at 决定它落在哪个自然日，因此「计划」与「检测」之别是跨端统计分歧的头号来源。 */
export interface Stamp {
  startedAt: number;
  endedAt: number;
  durationSec: number;
}

/**
 * 到点自动结算的时刻：一律以「计划截止时刻」为准，不用发现它过期时的墙钟。
 * 否则同一阶段在 A 端（一直醒着）记在今天 09:00、在 B 端（睡了一夜后补算）记在昨天夜里，
 * 按天分组后两端的「今日专注」永久不一致。
 */
export function autoPhaseStamp(deadlineMs: number, presetMs: number): Stamp {
  return { startedAt: deadlineMs - presetMs, endedAt: deadlineMs, durationSec: Math.floor(presetMs / 1000) };
}

/** 手动结束 / 跳阶段 / 打点的时刻：以操作时刻为准，段长是「实际操作了多少」 */
export function manualStamp(nowMs: number, elapsedMs: number): Stamp {
  return { startedAt: nowMs - elapsedMs, endedAt: nowMs, durationSec: Math.floor(elapsedMs / 1000) };
}

/** 不足 1 秒的脏段不写记录（阶段照常推进，只是不记账）——三端同一判据，别各写各的 <=0 */
export function isRecordable(s: Stamp): boolean {
  return s.durationSec > 0;
}

/** 一条记录对三项今日统计的贡献。统计口径只在契约里决定一次，双端求和后按天分组。 */
export interface Contribution {
  focusMs: number;
  rounds: number;
  marks: number;
}

const ZERO: Contribution = { focusMs: 0, rounds: 0, marks: 0 };

export function contribute(
  rec: { durationSec: number; recordType: string },
  timerIsPomodoro: boolean,
  p: NormalizedPomodoro
): Contribution {
  const ms = rec.durationSec * 1000;
  if (ms <= 0) return ZERO;
  switch (rec.recordType) {
    case RECORD.POMODORO_FOCUS:
      return { focusMs: ms, rounds: 1, marks: 0 };
    case RECORD.POMODORO_BREAK:
      return ZERO;
    case RECORD.SEGMENT:
      return { focusMs: 0, rounds: 0, marks: 1 };
    case RECORD.PRECISE:
    case RECORD.STOPWATCH:
      // 番茄钟的历史 PRECISE：等于休息档则视为休息段
      if (timerIsPomodoro && (ms === p.break_ms || ms === p.long_break_ms)) return ZERO;
      return { focusMs: ms, rounds: 1, marks: 0 };
    default:
      return ZERO;
  }
}

export function sumContribution(acc: Contribution, c: Contribution): Contribution {
  return { focusMs: acc.focusMs + c.focusMs, rounds: acc.rounds + c.rounds, marks: acc.marks + c.marks };
}

export const EMPTY_CONTRIBUTION: Contribution = ZERO;
