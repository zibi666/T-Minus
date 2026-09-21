// 时区相关的日期算法（依赖 @ohos.intl，因此与纯逻辑的 Engine.ets 分开：
// Engine/Contract/Machine 必须能在 node 里直接加载跑单测，不能碰 @kit）。
import intl from '@ohos.intl';

/** 'YYYY-MM-DD' → 该日在指定时区的自然日序号（天为单位的 epoch） */
export function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** 把日期串里能取到的前三个数字段解析成 [年, 月, 日] */
function parseDateText(text: string): number[] | null {
  const segs = text.split(/[^0-9]+/).filter((s: string) => s.length > 0);
  if (segs.length < 3) return null;
  const y = parseInt(segs[0], 10);
  const m = parseInt(segs[1], 10);
  const d = parseInt(segs[2], 10);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
  return [y, m, d];
}

/** 墙钟毫秒在指定时区的 [年, 月, 日]；时区名不可用时退回本机自然日 */
export function partsInTz(ms: number, tz: string): number[] {
  const d = new Date(ms);
  const local = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  if (tz.length === 0) return local;
  try {
    const opts: intl.DateTimeOptions = { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' };
    // en-CA 的日期格式即 ISO 顺序（YYYY-MM-DD）；本 SDK 的 intl 只提供 format，不提供 formatToParts
    const text = new intl.DateTimeFormat('en-CA', opts).format(d);
    const got = parseDateText(text);
    return got === null ? local : got;
  } catch (e) {
    return local;
  }
}

/** 墙钟毫秒在指定时区的 [时, 分, 秒]（24 小时制） */
function timePartsInTz(ms: number, tz: string): number[] {
  const opts: intl.DateTimeOptions = {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  };
  const text = new intl.DateTimeFormat('en-GB', opts).format(new Date(ms));
  const segs = text.split(/[^0-9]+/).filter((s: string) => s.length > 0);
  if (segs.length < 3) return [0, 0, 0];
  return [parseInt(segs[0], 10) % 24, parseInt(segs[1], 10), parseInt(segs[2], 10)];
}

/**
 * 目标时区相对 UTC 的偏移（ms），用一次已知时刻的格式化结果反推，不依赖第三方时区库。
 * 拿不到时按 0 处理（此时日期倒计时退化为 UTC 零点，误差在一个自然日内）。
 */
export function tzOffsetOf(tz: string): number {
  if (tz.length === 0) return new Date().getTimezoneOffset() * -60000;
  try {
    const probe = Date.UTC(2000, 0, 1, 12, 0, 0);
    const dp = partsInTz(probe, tz);
    const tp = timePartsInTz(probe, tz);
    return Date.UTC(dp[0], dp[1] - 1, dp[2], tp[0], tp[1], tp[2]) - probe;
  } catch (e) {
    return 0;
  }
}

/**
 * §3.2 剩余天数：目标日期 − 当前日期（按目标时区自然日）；includeToday 时 +1。
 * 与 Android Engine.daysLeft / Windows dateLogic 一致。
 */
export function daysLeft(targetDate: string, timezoneId: string | null, includeToday: boolean,
  now: number): number | null {
  const parts = targetDate.split('-');
  if (parts.length !== 3) return null;
  const ty = parseInt(parts[0], 10);
  const tm = parseInt(parts[1], 10);
  const td = parseInt(parts[2], 10);
  if (Number.isNaN(ty) || Number.isNaN(tm) || Number.isNaN(td)) return null;
  const cur = partsInTz(now, timezoneId ?? '');
  const d = dayNumber(ty, tm, td) - dayNumber(cur[0], cur[1], cur[2]);
  return includeToday ? d + 1 : d;
}
