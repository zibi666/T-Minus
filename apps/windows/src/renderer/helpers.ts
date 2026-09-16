// 渲染层 v3 工具：番茄钟判定 / 时间格式 / 今日日志统计
import { TimerDTO, PomodoroInfo } from '../shared/types';

/** 是否番茄钟（精确倒计时 + pomodoro 配置；接受完整 DTO 或元数据） */
export function isPomodoro(t: Pick<TimerDTO, 'type' | 'config'>): boolean {
  const cfg = (t.config as any)?.pomodoro;
  return t.type === 'PRECISE_COUNTDOWN' && !!cfg && Number(cfg.rounds) > 0;
}

/** 读取番茄钟配置（缺省 25/5/4，规范 §2；接受完整 DTO 或元数据） */
export function getPomodoro(t: Pick<TimerDTO, 'type' | 'config'>): PomodoroInfo {
  const cfg = (t.config as any)?.pomodoro ?? {};
  return {
    work_ms: Math.max(60000, Number(cfg.work_ms) || 25 * 60000),
    break_ms: Math.max(30000, Number(cfg.break_ms) || 5 * 60000),
    rounds: Math.max(1, Math.min(12, Number(cfg.rounds) || 4))
  };
}

/** m:ss（分钟不封顶，如 88:12）；≥1h 显示 h:mm:ss */
export function mmss(ms: number): string {
  const abs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** 今日专注展示：h:mm（小时不封顶） */
export function formatFocus(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** 本地日期键 YYYY-MM-DD */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 正计时秒级展示：纯秒数（可含百分秒），如 72.45 */
export function formatSeconds(ms: number, withCs = false): string {
  const total = Math.max(0, Math.floor(ms));
  const s = Math.floor(total / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return withCs ? `${s}.${String(cs).padStart(2, '0')}` : String(s);
}

/* ---------- 分段自定义命名（localStorage，键为 timer_record.id） ---------- */

const SEG_NAMES_KEY = 'tm-seg-names';

function loadSegNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEG_NAMES_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function getSegName(recordId: string): string | null {
  const v = loadSegNames()[recordId];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 命名为空串时清除该条命名 */
export function setSegName(recordId: string, name: string): void {
  const map = loadSegNames();
  const v = String(name).trim().slice(0, 30);
  if (v) map[recordId] = v;
  else delete map[recordId];
  try { localStorage.setItem(SEG_NAMES_KEY, JSON.stringify(map)); } catch { /* 忽略配额错误 */ }
}

/** 颜色提亮（用于环形渐变第二色 / 进度条） */
export function lighten(hex: string, amt = 0.38): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v: number) => Math.round(v + (255 - v) * amt);
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

/** --tc 色的预模糊光晕色（radial 用，替代 blur 滤镜） */
export function glowColor(hex: string, alpha = 0.16): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(77, 201, 240, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* ---------- 番茄钟今日日志（localStorage；番茄钟统计不走 timer_record，避免休息段混入专注统计） ---------- */

export interface PomoJournalDay { workCount: number; workMs: number; breakMs: number }
export type PomoJournal = Record<string, PomoJournalDay>;

const JKEY = 'tm-pomo-journal';

export function loadJournal(): PomoJournal {
  try {
    const raw = localStorage.getItem(JKEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function saveJournal(j: PomoJournal): void {
  try { localStorage.setItem(JKEY, JSON.stringify(j)); } catch { /* 忽略配额错误 */ }
}

export function journalAdd(j: PomoJournal, patch: Partial<PomoJournalDay>): PomoJournal {
  const k = localDateKey(Date.now());
  const day = j[k] ?? { workCount: 0, workMs: 0, breakMs: 0 };
  const next: PomoJournal = {
    ...j,
    [k]: {
      workCount: day.workCount + (patch.workCount ?? 0),
      workMs: day.workMs + (patch.workMs ?? 0),
      breakMs: day.breakMs + (patch.breakMs ?? 0)
    }
  };
  saveJournal(next);
  return next;
}

/* ---------- 番茄钟循环状态（渲染层驱动；每阶段 = 引擎一次 deadline 精确倒计时） ---------- */

export interface PomoPhase { phase: 'work' | 'break'; round: number }
const PKEY = 'tm-pomo-state';

export function loadPomoState(): Record<string, PomoPhase> {
  try {
    const raw = localStorage.getItem(PKEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

export function savePomoState(s: Record<string, PomoPhase>): void {
  try { localStorage.setItem(PKEY, JSON.stringify(s)); } catch { /* 忽略 */ }
}
