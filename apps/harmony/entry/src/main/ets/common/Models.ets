// UI 侧的只读视图模型：把「一行 timer_item + 当前墙钟」折算成卡片/详情需要的字符串与比例。
// 读数一律现场推导（不缓存进数据库），与 Android core/Core.kt 的 Engine.live 同一职责。
import { TimerItem, TimerRecord } from '../data/Rows';
import {
  LOGICAL_POMODORO, NormalizedPomodoro, PHASE_BREAK, PHASE_LONG_BREAK, RUN_PAUSED, RUN_RUNNING,
  TYPE_DATE, TYPE_PRECISE, TYPE_STOPWATCH, DEFAULT_TIMER_COLOR, isPomodoroConfig, normalizePomodoro,
  numAt, parseConfig, phasePresetMs, strAt
} from '../core/Contract';
import { LiveState, hms, humanMin, liveState, parseRun, phaseLabel } from '../core/Engine';
import { daysLeft } from '../core/Time';

/** 落库 type 只有三种，番茄钟要按 config 还原成 UI 逻辑类型 */
export function logicalOf(t: TimerItem): string {
  const cfg = parseConfig(t.config_json);
  if (t.type === TYPE_PRECISE && isPomodoroConfig(t.type, cfg)) return LOGICAL_POMODORO;
  return t.type;
}

export function typeLabel(logical: string): string {
  if (logical === TYPE_DATE) return '日期倒计时';
  if (logical === TYPE_PRECISE) return '精确倒计时';
  if (logical === TYPE_STOPWATCH) return '正计时';
  return '番茄钟';
}

/** 历史记录类型的中文徽章（历史页用），与 Android Types.RECORD_LABEL 同表 */
export function recordLabel(recordType: string): string {
  if (recordType === 'PRECISE') return '完成';
  if (recordType === 'SEGMENT') return '分段';
  if (recordType === 'STOPWATCH') return '正计时';
  if (recordType === 'POMODORO_FOCUS') return '专注';
  if (recordType === 'POMODORO_BREAK') return '休息';
  return recordType;
}

export function colorOf(t: TimerItem): string {
  return t.color === null || t.color.length === 0 ? DEFAULT_TIMER_COLOR : t.color;
}

export function pomoOf(t: TimerItem): NormalizedPomodoro {
  return normalizePomodoro(parseConfig(t.config_json));
}

/** 日期倒计时的目标日文案 */
export function dateText(t: TimerItem, now: number): string {
  const cfg = parseConfig(t.config_json);
  const target = strAt(cfg, 'target_date') ?? '';
  const tz = strAt(cfg, 'timezone_id');
  const include = cfg !== null && cfg['include_today'] === true;
  const left = daysLeft(target, tz, include, now);
  if (left === null) return target;
  if (left > 0) return `${left}`;
  if (left === 0) return '0';
  return `${-left}`;
}

export class CardModel {
  id: string = '';
  name: string = '';
  logical: string = '';
  color: string = DEFAULT_TIMER_COLOR;
  starred: boolean = false;
  pinned: boolean = false;
  runState: string = 'idle';
  /** 主读数：倒计时 mm:ss / 正计时 mm:ss / D-Day 天数 */
  primary: string = '';
  /** 副行：阶段·轮次 / 预设时长 / 目标日期 */
  secondary: string = '';
  /** 环形进度 0~1；日期倒计时无进度 */
  progress: number = 0;
  /** 剩余毫秒（实况窗读秒用；日期/正计时为 0） */
  remainingMs: number = 0;
  /** 可运行（非日期类）*/
  runnable: boolean = true;
  isPomodoro: boolean = false;
  /** 标签名（已按名字排序） */
  tags: string[] = [];
}

export function cardOf(t: TimerItem, now: number, tagMap: Map<string, string[]> | null): CardModel {
  const m = new CardModel();
  const cfg = parseConfig(t.config_json);
  const logical = logicalOf(t);
  m.id = t.id;
  m.name = t.name.length === 0 ? '未命名' : t.name;
  m.logical = logical;
  m.color = colorOf(t);
  m.starred = t.starred;
  m.pinned = t.pinned;
  m.runState = t.run_state;
  m.isPomodoro = logical === LOGICAL_POMODORO;
  m.runnable = t.type !== TYPE_DATE;
  const had = tagMap === null ? undefined : tagMap.get(t.id);
  m.tags = had === undefined ? [] : had;

  if (t.type === TYPE_DATE) {
    m.primary = `D-${dateText(t, now)}`;
    m.secondary = strAt(cfg, 'target_date') ?? '';
    m.progress = 0;
    return m;
  }

  const live: LiveState = liveState(t.type, t.run_state, t.run_json, t.config_json, now);
  m.remainingMs = live.remainingMs;
  if (t.type === TYPE_STOPWATCH) {
    m.primary = hms(live.elapsedMs);
    m.secondary = t.run_state === RUN_PAUSED ? '已暂停' : (t.run_state === RUN_RUNNING ? '计时中' : '就绪');
    m.progress = 0;
    return m;
  }

  const p = normalizePomodoro(cfg);
  if (m.isPomodoro) {
    const preset = phasePresetMs(p, live.phase);
    m.primary = hms(live.remainingMs);
    m.secondary = t.run_state === 'idle'
      ? `专注 ${Math.round(p.work_ms / 60000)}分 · ${p.rounds}轮后长休息`
      : `${phaseLabel(live.phase)} · 第 ${live.round} 轮`;
    m.progress = preset > 0 ? 1 - live.remainingMs / preset : 0;
    return m;
  }

  const preset = numAt(cfg, 'preset_ms') ?? 0;
  m.primary = hms(live.remainingMs);
  m.secondary = t.run_state === 'idle' ? humanMin(preset) :
    (t.run_state === RUN_PAUSED ? `已暂停 · 预设 ${humanMin(preset)}` : `已用 ${humanMin(live.elapsedMs)}`);
  m.progress = preset > 0 ? 1 - live.remainingMs / preset : 0;
  return m;
}

export function cardsOf(items: TimerItem[], now: number, tagMap: Map<string, string[]> | null): CardModel[] {
  const out: CardModel[] = [];
  for (let i = 0; i < items.length; i++) out.push(cardOf(items[i], now, tagMap));
  return out;
}

/** 今日分段行（详情页） */
export class SegmentRow {
  time: string = '';
  label: string = '';
  duration: string = '';
  id: string = '';

  constructor(id: string, time: string, label: string, duration: string) {
    this.id = id;
    this.time = time;
    this.label = label;
    this.duration = duration;
  }
}

export function segmentRows(recs: TimerRecord[]): SegmentRow[] {
  const out: SegmentRow[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const d = new Date(r.ended_at);
    const hh = d.getHours();
    const mm = d.getMinutes();
    out.push(new SegmentRow(r.id, `${hh < 10 ? `0${hh}` : hh}:${mm < 10 ? `0${mm}` : mm}`,
      recordLabel(r.record_type), hms(r.duration_sec * 1000)));
  }
  return out;
}
