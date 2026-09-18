// 日期倒计时规则（§3.2）：按目标时区自然日，不受夏令时与本机时区偏移影响
const { test } = require('node:test');
const assert = require('node:assert');
const { remainingDays, todayInTz, diffCalendarDays } = require('../dist/main/electron/dateLogic.js');

test('同日：不含今天为 0，含今天为 1', () => {
  const today = todayInTz('Asia/Shanghai', Date.UTC(2026, 8, 18, 1, 0, 0));
  assert.strictEqual(today, '2026-09-18');
  assert.strictEqual(remainingDays('2026-09-18', 'Asia/Shanghai', false, Date.UTC(2026, 8, 18, 13, 0, 0)), 0);
  assert.strictEqual(remainingDays('2026-09-18', 'Asia/Shanghai', true, Date.UTC(2026, 8, 18, 13, 0, 0)), 1);
});

test('跨 7 天', () => {
  assert.strictEqual(remainingDays('2026-09-25', 'Asia/Shanghai', false, Date.UTC(2026, 8, 18, 13, 0, 0)), 7);
});

test('已过目标日返回负数', () => {
  assert.strictEqual(remainingDays('2026-09-10', 'Asia/Shanghai', false, Date.UTC(2026, 8, 18, 13, 0, 0)), -8);
});

test('目标时区决定「今天」：UTC 午夜在北京已是次日', () => {
  const at = Date.UTC(2026, 8, 18, 16, 30, 0); // 北京 2026-09-19 00:30
  assert.strictEqual(todayInTz('Asia/Shanghai', at), '2026-09-19');
  assert.strictEqual(todayInTz('UTC', at), '2026-09-18');
  assert.strictEqual(remainingDays('2026-09-19', 'Asia/Shanghai', false, at), 0);
  assert.strictEqual(remainingDays('2026-09-19', 'UTC', false, at), 1);
});

test('自然日差不受夏令时影响', () => {
  assert.strictEqual(diffCalendarDays('2026-03-01', '2026-04-01'), 31);
  assert.strictEqual(diffCalendarDays('2026-10-25', '2026-10-26'), 1);
  assert.strictEqual(diffCalendarDays('2028-02-28', '2028-03-01'), 2); // 闰年
});
