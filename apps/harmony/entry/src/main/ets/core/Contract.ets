// 跨端契约单一来源（与 apps/windows/src/shared/contract.ts、apps/android/.../core/Contract.kt 逐字段镜像）。
// 默认值、夹紧边界、config_json 字段落位、isPomodoro 判定、色板只在这里定义一次；
// 三端由 shared/contract/fixtures/contract.json 表驱动测试共同校验。
// 本文件必须保持纯逻辑（不得 import @kit/@ohos），否则契约 runner 无法在 node 里加载。

export const MONO_GUARD_MS: number = 2000;

export const DEFAULT_WORK_MS: number = 25 * 60000;
export const DEFAULT_BREAK_MS: number = 5 * 60000;
export const DEFAULT_LONG_BREAK_MS: number = 15 * 60000;
export const DEFAULT_ROUNDS: number = 4;

/** 夹紧边界：越界一律夹回，三端必须一致（fixture 测试逐条断言） */
export const WORK_MIN: number = 60000;
export const WORK_MAX: number = 180 * 60000;
export const BREAK_MIN: number = 30000;
export const BREAK_MAX: number = 60 * 60000;
export const LONG_BREAK_MIN: number = 30000;
export const LONG_BREAK_MAX: number = 240 * 60000;
export const ROUNDS_MIN: number = 1;
export const ROUNDS_MAX: number = 12;

export const PRESET_MIN_MS: number = 1000;
export const PRESET_MAX_MS: number = 365 * 86400000;

/** 提前结束/跳阶段时的最小结算时长：不足则视为误触，不写记录（三端同一阈值） */
export const PARTIAL_SETTLE_MIN_MS: number = 5000;

export const PHASE_FOCUS: string = 'focus';
export const PHASE_BREAK: string = 'break';
export const PHASE_LONG_BREAK: string = 'long_break';

/** timer_record.record_type 全集。POMODORO_FOCUS/BREAK 让阶段成为事实而非时长猜测。 */
export const RECORD_PRECISE: string = 'PRECISE';
export const RECORD_SEGMENT: string = 'SEGMENT';
export const RECORD_STOPWATCH: string = 'STOPWATCH';
export const RECORD_POMODORO_FOCUS: string = 'POMODORO_FOCUS';
export const RECORD_POMODORO_BREAK: string = 'POMODORO_BREAK';

/** 计时器色板（v3 规范 §1.3 的 8 色，与 Windows TIMER_PALETTE / Android Contract.TIMER_PALETTE 同序同值） */
export const TIMER_PALETTE: string[] = [
  '#4DC9F0', '#9381FF', '#21E0C4', '#FFB224',
  '#FF6B6B', '#5A9EFF', '#F472B6', '#A3E635'
];
export const DEFAULT_TIMER_COLOR: string = TIMER_PALETTE[0];
/** 标签色板：按名称 charCode 求和取模（三端同算法，见 fixture tag_color 用例） */
export const TAG_PALETTE: string[] = TIMER_PALETTE;

export const TYPE_DATE: string = 'DATE_COUNTDOWN';
export const TYPE_PRECISE: string = 'PRECISE_COUNTDOWN';
export const TYPE_STOPWATCH: string = 'STOPWATCH';
export const TIMER_TYPES: string[] = [TYPE_DATE, TYPE_PRECISE, TYPE_STOPWATCH];

/** 落库只有三种 type；番茄钟是 PRECISE_COUNTDOWN + config.pomodoro，仅 UI 层作为逻辑类型呈现 */
export const LOGICAL_POMODORO: string = 'POMODORO';

export const RUN_IDLE: string = 'idle';
export const RUN_RUNNING: string = 'running';
export const RUN_PAUSED: string = 'paused';

export interface NormalizedPomodoro {
  work_ms: number;
  break_ms: number;
  long_break_ms: number;
  rounds: number;
}

/** 一条记录对三项今日统计的贡献。统计口径只在契约里决定一次，三端求和后按天分组。 */
export interface Contribution {
  focusMs: number;
  rounds: number;
  marks: number;
}

export const EMPTY_CONTRIBUTION: Contribution = { focusMs: 0, rounds: 0, marks: 0 };

function isNum(v: Object | undefined | null): boolean {
  return typeof v === 'number' && Number.isFinite(v as number);
}

/** 未归一的 config 片段：任何一端读到的原始 JSON 都先按这个形状取字段 */
export function numAt(o: Record<string, Object> | null, key: string): number | null {
  if (o === null) {
    return null;
  }
  const v: Object | undefined = o[key];
  return isNum(v) ? (v as number) : null;
}

export function objAt(o: Record<string, Object> | null, key: string): Record<string, Object> | null {
  if (o === null) {
    return null;
  }
  const v: Object | undefined = o[key];
  return v === undefined || v === null ? null : (v as Record<string, Object>);
}

export function strAt(o: Record<string, Object> | null, key: string): string | null {
  if (o === null) {
    return null;
  }
  const v: Object | undefined = o[key];
  return typeof v === 'string' ? (v as string) : null;
}

/** config_json 文本 → 取字段用的形状；空/非法一律按空对象处理（与双端"读不到就用默认"一致） */
export function parseConfig(jsonStr: string | null): Record<string, Object> | null {
  if (jsonStr === null || jsonStr.length === 0) {
    return null;
  }
  try {
    const parsed: Object = JSON.parse(jsonStr);
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    return parsed as Record<string, Object>;
  } catch (e) {
    return null;
  }
}

/** null / 非正数 / 非有限 → 默认值；其余夹进 [lo,hi]（与 TS/Kotlin clamp 同语义） */
export function clamp(v: number | null, lo: number, hi: number, fallback: number): number {
  if (v === null || !Number.isFinite(v) || v <= 0) {
    return fallback;
  }
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/**
 * 读番茄钟配置。兼容三种历史落位：
 *   1) 规范：config.pomodoro.{work_ms,break_ms,long_break_ms,rounds}
 *   2) Android v0.4.7：长休息落在 config.long_break_ms（顶层）
 *   3) Android v0.4.6：config.{focus_ms,short_break_ms,rounds_before_long}
 * 顶层/旧字段仅在 pomodoro 内缺省时兜底，新写入一律走 buildPreciseConfig/buildPomodoroConfig。
 */
export function normalizePomodoro(config: Record<string, Object> | null): NormalizedPomodoro {
  const p: Record<string, Object> | null = objAt(config, 'pomodoro');
  const r: NormalizedPomodoro = {
    work_ms: clamp(numAt(p, 'work_ms') ?? numAt(config, 'focus_ms'), WORK_MIN, WORK_MAX, DEFAULT_WORK_MS),
    break_ms: clamp(numAt(p, 'break_ms') ?? numAt(config, 'short_break_ms'), BREAK_MIN, BREAK_MAX, DEFAULT_BREAK_MS),
    long_break_ms: clamp(numAt(p, 'long_break_ms') ?? numAt(config, 'long_break_ms'), LONG_BREAK_MIN, LONG_BREAK_MAX, DEFAULT_LONG_BREAK_MS),
    rounds: clamp(numAt(p, 'rounds') ?? numAt(config, 'rounds_before_long'), ROUNDS_MIN, ROUNDS_MAX, DEFAULT_ROUNDS)
  };
  return r;
}

/** 是否番茄钟：type=PRECISE_COUNTDOWN 且存在番茄钟配置（含旧格式 focus_ms）。rounds 缺失时补默认 4 而非判否。 */
export function isPomodoroConfig(type: string, config: Record<string, Object> | null): boolean {
  if (type !== TYPE_PRECISE) {
    return false;
  }
  if (objAt(config, 'pomodoro') !== null) {
    return true;
  }
  const focus = numAt(config, 'focus_ms');
  return focus !== null && focus > 0;
}

/** 阶段时长；未知/缺失 phase 一律按 focus 档 */
export function phasePresetMs(p: NormalizedPomodoro, phase: string | null): number {
  if (phase === PHASE_LONG_BREAK) {
    return p.long_break_ms;
  }
  if (phase === PHASE_BREAK) {
    return p.break_ms;
  }
  return p.work_ms;
}

/** 长休息判定：每完成 rounds 轮专注进一次长休息 */
export function isLongBreakDue(p: NormalizedPomodoro, completedFocusAfterThisRound: number): boolean {
  return completedFocusAfterThisRound > 0 && completedFocusAfterThisRound % p.rounds === 0;
}

/** 普通精确倒计时 config */
export function buildPreciseConfig(presetMs: number): Record<string, Object> {
  const cfg: Record<string, Object> = {};
  cfg['schema_version'] = 1 as Object;
  cfg['preset_ms'] = clamp(presetMs, PRESET_MIN_MS, PRESET_MAX_MS, PRESET_MIN_MS) as Object;
  return cfg;
}

/**
 * 番茄钟 config（canonical 落位）：long_break_ms 在 pomodoro 内（Windows/新 Android 读这里），
 * 顶层再镜像一份（v0.4.7 Android 只读顶层）——两处同写让新旧客户端都拿到同一个值。
 */
export function buildPomodoroConfig(pomo: Record<string, Object> | null): Record<string, Object> {
  const wrapped: Record<string, Object> = {};
  const emptyPomo: Record<string, Object> = {};
  wrapped['pomodoro'] = (pomo === null ? emptyPomo : pomo) as Object;
  const n = normalizePomodoro(wrapped);
  const inner: Record<string, Object> = {};
  inner['work_ms'] = n.work_ms as Object;
  inner['break_ms'] = n.break_ms as Object;
  inner['long_break_ms'] = n.long_break_ms as Object;
  inner['rounds'] = n.rounds as Object;
  const cfg: Record<string, Object> = {};
  cfg['schema_version'] = 1 as Object;
  cfg['preset_ms'] = n.work_ms as Object;
  cfg['pomodoro'] = inner as Object;
  cfg['long_break_ms'] = n.long_break_ms as Object;
  return cfg;
}

export function tagColorFor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) {
    sum += name.charCodeAt(i);
  }
  return TAG_PALETTE[sum % TAG_PALETTE.length];
}

/** FNV-1a/32，逐 UTF-16 code unit 折叠（与 Windows/Android 逐位一致） */
function fnv1a32(s: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function hex32(n: number): string {
  const s = (n >>> 0).toString(16);
  return s.length >= 8 ? s : '00000000'.substring(0, 8 - s.length) + s;
}

/**
 * 自动结算记录的去重 id：三端对「同一次阶段完成」必须算出同一个 id，
 * 服务端按 id upsert 后只剩一条，多设备并行结算因此无害。
 * 只取跨设备共享的坐标，刻意不含 version（各端本地计数）与 phase_ends_at（单调守卫会改写）。
 */
export function recordId(timerId: string, sessionId: string | null, phaseKey: string, completedFocus: number): string {
  const key = `${timerId}|${sessionId ?? ''}|${phaseKey}|${completedFocus}`;
  return `rec-${hex32(fnv1a32(key, 2166136261))}${hex32(fnv1a32(key, 2654435761))}`;
}

/** 番茄钟「本阶段结束后进哪个阶段、轮次怎么变」的裁决结果 */
export class NextPhase {
  phase: string = PHASE_FOCUS;
  completedFocus: number = 0;

  constructor(phase: string, completedFocus: number) {
    this.phase = phase;
    this.completedFocus = completedFocus;
  }
}

/**
 * 阶段推进的唯一裁决。三端各写一遍的话长休息节奏迟早漂移（一端每 4 轮一次、另一端每 5 轮），
 * 同步后无法收敛。下一阶段时长由 phasePresetMs(p, np.phase) 求。
 */
export function nextPhaseOf(p: NormalizedPomodoro, phase: string | null, completedFocus: number): NextPhase {
  const isFocus = phase === PHASE_FOCUS;
  const completed = completedFocus + (isFocus ? 1 : 0);
  let next: string = PHASE_FOCUS;
  if (isFocus) next = isLongBreakDue(p, completed) ? PHASE_LONG_BREAK : PHASE_BREAK;
  return new NextPhase(next, completed);
}

/** 一条记录的时刻与时长。ended_at 决定它落在哪个自然日，「计划 vs 检测」之别是跨端统计分歧的头号来源。 */
export class Stamp {
  startedAt: number = 0;
  endedAt: number = 0;
  durationSec: number = 0;

  constructor(startedAt: number, endedAt: number, durationSec: number) {
    this.startedAt = startedAt;
    this.endedAt = endedAt;
    this.durationSec = durationSec;
  }
}

/**
 * 到点自动结算的时刻：一律以「计划截止时刻」为准，不用发现它过期时的墙钟。
 * 否则同一阶段在一直醒着的设备记今天、在睡过夜后补算的设备记昨天，按天分组后永久不一致。
 */
export function autoPhaseStamp(deadlineMs: number, presetMs: number): Stamp {
  return new Stamp(deadlineMs - presetMs, deadlineMs, Math.floor(presetMs / 1000));
}

/** 手动结束 / 跳阶段 / 打点的时刻：以操作时刻为准，段长是「实际操作了多少」 */
export function manualStamp(nowMs: number, elapsedMs: number): Stamp {
  return new Stamp(nowMs - elapsedMs, nowMs, Math.floor(elapsedMs / 1000));
}

/** 不足 1 秒的脏段不写记录（阶段照常推进）——三端同一判据 */
export function isRecordable(s: Stamp): boolean {
  return s.durationSec > 0;
}

export function contribute(
  durationSec: number,
  recordType: string,
  timerIsPomodoro: boolean,
  p: NormalizedPomodoro
): Contribution {
  const ms: number = durationSec * 1000;
  if (ms <= 0) {
    return EMPTY_CONTRIBUTION;
  }
  if (recordType === RECORD_POMODORO_FOCUS) {
    return { focusMs: ms, rounds: 1, marks: 0 };
  }
  if (recordType === RECORD_POMODORO_BREAK) {
    return EMPTY_CONTRIBUTION;
  }
  if (recordType === RECORD_SEGMENT) {
    return { focusMs: 0, rounds: 0, marks: 1 };
  }
  if (recordType === RECORD_PRECISE || recordType === RECORD_STOPWATCH) {
    // 番茄钟的历史 PRECISE：等于休息档则视为休息段
    if (timerIsPomodoro && (ms === p.break_ms || ms === p.long_break_ms)) {
      return EMPTY_CONTRIBUTION;
    }
    return { focusMs: ms, rounds: 1, marks: 0 };
  }
  return EMPTY_CONTRIBUTION;
}

export function sumContribution(acc: Contribution, c: Contribution): Contribution {
  return { focusMs: acc.focusMs + c.focusMs, rounds: acc.rounds + c.rounds, marks: acc.marks + c.marks };
}

/** 同步表白名单（与 backend RowStore.COLUMNS、Windows SYNC_TABLE_COLUMNS、Android 实体逐列一致）。 */
export interface SyncTableColumnsMap {
  timer_item: string[];
  tag: string[];
  timer_tag: string[];
  milestone: string[];
  timer_record: string[];
}

/**
 * 远程行应用与 pending_ops 载荷都从这里取列，避免任何一端私自扩列。
 */
export const SYNC_TABLE_COLUMNS: SyncTableColumnsMap = {
  timer_item: ['id', 'user_id', 'name', 'type', 'color', 'starred', 'pinned', 'remark',
    'config_json', 'run_state', 'session_id', 'run_json', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  tag: ['id', 'user_id', 'name', 'color', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_tag: ['id', 'user_id', 'timer_id', 'tag_id', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  milestone: ['id', 'user_id', 'timer_id', 'note', 'marked_at', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_record: ['id', 'user_id', 'timer_id', 'session_id', 'started_at', 'ended_at',
    'duration_sec', 'record_type', 'version', 'updated_at', 'deleted', 'origin_device_id']
};

/** 按表名取列白名单；未知表返回 null，调用方据此拒绝写入 */
export function columnsOf(table: string): string[] | null {
  if (table === 'timer_item') return SYNC_TABLE_COLUMNS.timer_item;
  if (table === 'tag') return SYNC_TABLE_COLUMNS.tag;
  if (table === 'timer_tag') return SYNC_TABLE_COLUMNS.timer_tag;
  if (table === 'milestone') return SYNC_TABLE_COLUMNS.milestone;
  if (table === 'timer_record') return SYNC_TABLE_COLUMNS.timer_record;
  return null;
}
