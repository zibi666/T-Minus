// 共享格式化工具

/** 毫秒 → hh:mm:ss（可含百分秒） */
export function formatHMS(ms: number, withCs = false): string {
  const neg = ms < 0;
  const abs = Math.abs(Math.floor(ms));
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const cs = Math.floor((abs % 1000) / 10);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const core = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return (neg ? '-' : '') + (withCs ? `${core}.${pad(cs)}` : core);
}

/** 精确倒计时剩余展示：超过 1 天显示 "N天 hh:mm:ss" */
export function formatRemaining(ms: number): string {
  if (ms >= 86400000 || ms <= -86400000) {
    const sign = ms < 0 ? '-' : '';
    const abs = Math.abs(ms);
    const d = Math.floor(abs / 86400000);
    return `${sign}${d}天 ${formatHMS(abs % 86400000)}`;
  }
  return formatHMS(ms);
}

/** 正计时已用展示：超过 1 天显示 "N天 hh:mm:ss"，否则 hh:mm:ss（含百分秒由调用方决定） */
export function formatElapsed(ms: number, withCs = false): string {
  if (ms >= 86400000) {
    const d = Math.floor(ms / 86400000);
    return `${d}天 ${formatHMS(ms % 86400000, withCs)}`;
  }
  return formatHMS(ms, withCs);
}
