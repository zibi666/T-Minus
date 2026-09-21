import React from 'react';
// 渲染层 v3 工具：时间格式化 / 分段命名 / 颜色
// 番茄钟判定、默认值与夹紧边界一律走 src/shared/contract.ts，本文件不再持有任何一套规则。
import { TimerDTO } from '../shared/types';
import { isPomodoroConfig, normalizePomodoro, NormalizedPomodoro } from '../shared/contract';

/** 是否番茄钟（精确倒计时 + pomodoro 配置；接受完整 DTO 或元数据） */
export function isPomodoro(t: Pick<TimerDTO, 'type' | 'config'>): boolean {
  return isPomodoroConfig(t.type, t.config);
}

/** 番茄钟配置（已夹紧归一，双端同值） */
export function getPomodoro(t: Pick<TimerDTO, 'type' | 'config'>): NormalizedPomodoro {
  return normalizePomodoro(t.config);
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

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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

/* ---------- CSS 自定义属性 ---------- */

/** React 的 CSSProperties 不含自定义属性；集中一处断言，其余站点保持类型安全 */
export function cssVars(vars: Record<string, string | number>): React.CSSProperties {
  return vars as React.CSSProperties;
}

/* ---------- 颜色 ---------- */

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
