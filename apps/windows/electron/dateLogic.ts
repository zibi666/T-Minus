// §3.2 日期倒计时规则：按目标时区自然日计算，不转 UTC 时间戳存储

/** 取某 IANA 时区"今天"的 YYYY-MM-DD（en-CA locale 直接产出 ISO 日期）；时区缺失或非法时退到本机时区 */
export function todayInTz(timezoneId?: string | null, nowMs = Date.now()): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let tz = timezoneId || local;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    tz = local;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(nowMs));
}

/** 两个 YYYY-MM-DD 之间的自然日差（toDate - fromDate）；按 UTC 日期解析，规避夏令时干扰 */
export function diffCalendarDays(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}

/** §3.2 剩余天数：目标日期 − 当前日期（均按目标时区自然日）；includeToday 时 +1 */
export function remainingDays(
  targetDate?: string | null,
  timezoneId?: string | null,
  includeToday = false,
  nowMs = Date.now()
): number {
  if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return 0;
  const today = todayInTz(timezoneId, nowMs);
  const d = diffCalendarDays(today, targetDate);
  return includeToday ? d + 1 : d;
}
