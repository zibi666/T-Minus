// 引擎行为测试（真实 sql.js 临时库，跑编译后的 dist/main/electron/timerEngine.js）
// 覆盖这轮改动里最容易回退的语义：canonical 落位、结束/重置分叉、打点不中断、
// 阶段记录类型、按天统计口径、运行中改配置的回显、他端配置切换清运行态。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { LocalDB } = require('../dist/main/electron/db.js');
const { TimerEngine } = require('../dist/main/electron/timerEngine.js');

const POMODORO = { work_ms: 60000, break_ms: 30000, long_break_ms: 120000, rounds: 2 };

let db, engine, ops;

beforeEach(async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')), 't.db');
  db = new LocalDB(file);
  await db.init();
  ops = [];
  engine = new TimerEngine(db, 'dev-test');
  engine.queueOp = (op) => ops.push(op);
  engine.load();
});

const createPomo = (name = '番茄') =>
  engine.create({ name, type: 'PRECISE_COUNTDOWN', config: { schema_version: 1, pomodoro: POMODORO } });
const createPrecise = (presetMs) =>
  engine.create({ name: '倒计时', type: 'PRECISE_COUNTDOWN', config: { schema_version: 1, preset_ms: presetMs } });
const createStopwatch = () => engine.create({ name: '秒表', type: 'STOPWATCH', config: { schema_version: 1 } });

const row = (id) => db.get('SELECT * FROM timer_item WHERE id = ?', [id]);
const records = (id) => db.all('SELECT * FROM timer_record WHERE timer_id = ?', [id]);

test('create 一次性原子落番茄钟配置（canonical：long_break_ms 在 pomodoro 内 + 顶层镜像）', () => {
  const t = createPomo();
  const cfg = JSON.parse(row(t.id).config_json);
  assert.strictEqual(cfg.pomodoro.long_break_ms, 120000, 'Windows 只读 pomodoro 内，缺它长休息会静默变默认值');
  assert.strictEqual(cfg.long_break_ms, 120000, '顶层镜像给只读顶层的旧客户端');
  assert.strictEqual(cfg.preset_ms, 60000);
  assert.strictEqual(JSON.parse(row(t.id).run_json ?? 'null'), null);
  // 单次 create 即完成落库，不再依赖渲染层补一次 update
  assert.strictEqual(ops.filter((o) => o.table === 'timer_item').length, 1);
});

test('番茄钟阶段推进写阶段记录，长休息按 rounds 触发', () => {
  const t = createPomo();
  engine.start(t.id);
  // 手动把当前阶段推到过期：直接改持久化字段后 reloadRow，等价于到点
  const expire = () => {
    const r = row(t.id);
    db.run('UPDATE timer_item SET run_json = ? WHERE id = ?', [
      JSON.stringify({ ...JSON.parse(r.run_json), phase_ends_at: Date.now() - 1000 }), t.id
    ]);
    engine.reloadRow(t.id);
    engine.tick();
  };
  expire(); // focus → break（第 1 轮）
  expire(); // break → focus
  expire(); // focus → long_break（第 2 轮完成，rounds=2）
  const recs = records(t.id).map((r) => r.record_type);
  assert.deepStrictEqual(recs, ['POMODORO_FOCUS', 'POMODORO_BREAK', 'POMODORO_FOCUS'], '阶段必须是事实，不能靠时长猜');
  const phase = JSON.parse(row(t.id).run_json).phase;
  assert.strictEqual(phase, 'long_break');
});

test('结束=如实结算并归零；重置=直接归零不记账', () => {
  const t = createPomo();
  engine.start(t.id);
  const r = row(t.id);
  db.run('UPDATE timer_item SET run_json = ? WHERE id = ?', [
    JSON.stringify({ ...JSON.parse(r.run_json), phase_ends_at: Date.now() + 60000 }), t.id
  ]);
  engine.reloadRow(t.id);
  engine.pause(t.id);
  // 暂停后已进行约 0 秒（<5s）→ 不误记账
  engine.stop(t.id);
  assert.strictEqual(records(t.id).length, 0, '不足 PARTIAL_SETTLE_MIN_MS 的误触不该产生记录');
  assert.strictEqual(row(t.id).run_state, 'idle');

  engine.start(t.id);
  const r2 = row(t.id);
  db.run('UPDATE timer_item SET run_json = ? WHERE id = ?', [
    JSON.stringify({ ...JSON.parse(r2.run_json), phase_ends_at: Date.now() + 1000 }), t.id
  ]);
  engine.reloadRow(t.id);
  engine.pause(t.id);
  engine.stop(t.id);
  assert.strictEqual(records(t.id).length, 1, '超过阈值的进度要结算');
  assert.strictEqual(records(t.id)[0].record_type, 'POMODORO_FOCUS');

  engine.start(t.id);
  engine.reset(t.id);
  assert.strictEqual(records(t.id).length, 1, '重置不记账');
  assert.strictEqual(row(t.id).run_json, null);
});

test('打点不打断倒计时，且不中断时不重复计入统计', () => {
  const t = createPrecise(600000);
  engine.start(t.id);
  const s = engine.segment(t.id); // 刚起步，不足 1ms → 不记段
  assert.strictEqual(s.segmentsMs, undefined);
  assert.strictEqual(records(t.id).length, 0);
  // 推进到已过 100 秒再打点
  const r = row(t.id);
  db.run('UPDATE timer_item SET run_json = ? WHERE id = ?', [
    JSON.stringify({ ...JSON.parse(r.run_json), target_at: Date.now() + 500000 }), t.id
  ]);
  engine.reloadRow(t.id);
  engine.segment(t.id);
  assert.ok(JSON.parse(row(t.id).run_json).target_at, '打点后 target_at 必须原样保留');
  assert.strictEqual(row(t.id).run_state, 'running', '打点后倒计时必须还在跑');
  assert.strictEqual(records(t.id).length, 1);
  assert.strictEqual(records(t.id)[0].record_type, 'SEGMENT');
});

test('正计时：暂停保留累计、继续只开新段、停止写 STOPWATCH 记录', () => {
  const t = createStopwatch();
  engine.start(t.id);
  engine.pause(t.id);
  const paused = JSON.parse(row(t.id).run_json);
  assert.strictEqual(paused.segment_started_at, undefined, '暂停后不该留着段起点');
  engine.resume(t.id);
  assert.ok(JSON.parse(row(t.id).run_json).segment_started_at, '继续时重新开段，累计值不变');
  assert.strictEqual(JSON.parse(row(t.id).run_json).accumulated_ms, paused.accumulated_ms);
  engine.stop(t.id);
  assert.strictEqual(row(t.id).run_state, 'idle');
  assert.strictEqual(records(t.id).length, 0, '累计不足阈值的误触不该产生记录');
});

test('运行中改时长被拒并回显原因（不再静默保存成功）', () => {
  const t = createPrecise(600000);
  engine.start(t.id);
  const res = engine.update(t.id, { config: { schema_version: 1, preset_ms: 990000 } });
  assert.strictEqual(res.ok, false);
  assert.ok(res.message && res.message.length > 0, '必须带原因，否则用户以为保存成功');
  assert.strictEqual(JSON.parse(row(t.id).config_json).preset_ms, 600000, '被拒时配置不该被写进去');
});

test('番茄钟 ↔ 普通倒计时切换会清掉不兼容的运行态', () => {
  const t = createPomo();
  engine.start(t.id);
  assert.strictEqual(row(t.id).run_state, 'running');
  const res = engine.update(t.id, { config: { schema_version: 1, preset_ms: 120000 } });
  assert.strictEqual(res.ok, true);
  const after = row(t.id);
  assert.strictEqual(after.run_state, 'idle', '旧 run_json 的 phase_ends_at 与新配置不兼容，必须清空');
  assert.strictEqual(after.run_json, null);
});

test('按天统计：专注/轮次/打点不双倍计入，休息段不计专注', () => {
  const t = createPomo();
  engine.start(t.id);
  for (let i = 0; i < 2; i++) {
    const r = row(t.id);
    db.run('UPDATE timer_item SET run_json = ? WHERE id = ?', [
      JSON.stringify({ ...JSON.parse(r.run_json), phase_ends_at: Date.now() - 100 }), t.id
    ]);
    engine.reloadRow(t.id);
    engine.tick();
  }
  const stats = engine.dailyStats();
  const today = stats.find((s) => s.focusMs > 0 || s.rounds > 0 || s.marks > 0);
  assert.ok(today, '应有一天聚合结果');
  assert.strictEqual(today.rounds, 1, '两轮推进里只有 focus 计轮次');
  assert.strictEqual(today.focusMs, 60000, '休息段不计入专注时长');
});

test('多设备并行结算同一阶段：确定性 id 把重复结算折叠成一条记录', () => {
  const t = createPomo();
  engine.start(t.id);
  const settleWith = (phase, completedFocus) => {
    db.run('UPDATE timer_item SET run_json = ? WHERE id = ?', [
      JSON.stringify({ phase, phase_ends_at: Date.now() - 1000, completed_focus: completedFocus }), t.id
    ]);
    engine.reloadRow(t.id);
    engine.tick();
  };

  settleWith('focus', 0);
  assert.strictEqual(records(t.id).length, 1, '首轮专注记一条');
  // 另一台设备没看到这次推进，拿同一 session 的旧阶段再结算一遍：必须落在同一条上
  settleWith('focus', 0);
  assert.strictEqual(records(t.id).length, 1, '重复结算不得产生第二条记录');

  // 换一个阶段必须是另一条，证明 key 不是过度折叠
  settleWith('break', 1);
  assert.strictEqual(records(t.id).length, 2);
  const today = engine.dailyStats().find((s) => s.rounds > 0 || s.focusMs > 0);
  assert.strictEqual(today.rounds, 1, '重复结算不得多计轮次');
  assert.strictEqual(today.focusMs, 60000, '重复结算不得多计专注时长');
});

// 睡眠语义：进程单调钟（hrtime→QPC）在 S3 期间不走表，醒来后墙钟前跳而单调钟没动。
// 下面两个用例分别钉住「不重排基准会把睡眠误判成改时钟并给计时续命」和「重排后照常补结算」。
test('睡眠跨过整阶段：不重排基准时守卫会吞掉这一轮（回归基线）', () => {
  const t = createPomo();
  engine.start(t.id);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 90000; // 睡了 90s，deadline 已在 30s 前过去
    engine.tick();
    assert.strictEqual(records(t.id).length, 0, '未重排基准时这一轮确实没结算');
    const d = engine.get(t.id);
    assert.ok(d && (d.remainingMs ?? 0) > 55000,
      `未重排时 60s 的专注在 90s 后仍显示剩 ${d?.remainingMs}ms——守卫把它续回了未来`);
  } finally {
    Date.now = realNow;
  }
});

test('睡眠跨过整阶段：唤醒重排基准后补结算，与 Android/鸿蒙 对齐', () => {
  const t = createPomo();
  engine.start(t.id);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 90000;
    engine.resyncAfterSleep(); // 内含一次 tick
  } finally {
    Date.now = realNow;
  }
  const recs = records(t.id);
  assert.strictEqual(recs.length, 1, '睡着期间到点的阶段必须在唤醒时补上');
  assert.strictEqual(recs[0].record_type, 'POMODORO_FOCUS');
  assert.strictEqual(JSON.parse(row(t.id).run_json).phase, 'break');
});

test('补算几小时前到点的倒计时：记录时刻按计划截止，不是发现时刻', () => {
  const t = createPrecise(60000);
  engine.start(t.id);
  const deadline = Date.now() - 2 * 3600 * 1000; // 两小时前就该结束（合上电脑过夜）
  db.run('UPDATE timer_item SET run_json = ? WHERE id = ?', [
    JSON.stringify({ target_at: deadline, segments_ms: [] }), t.id
  ]);
  engine.reloadRow(t.id);
  engine.tick();
  const recs = records(t.id);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].ended_at, deadline, 'ended_at 必须是计划截止，否则与另两端分到不同自然日');
  assert.strictEqual(recs[0].started_at, deadline - 60000);
  assert.strictEqual(recs[0].duration_sec, 60);
});

test('删除计时会给关联标签打墓碑，避免活行永久残留', () => {
  const t = createPrecise(60000);
  engine.setTimerTags(t.id, ['考研', '408']);
  assert.strictEqual(db.all('SELECT * FROM timer_tag WHERE deleted = 0').length, 2);
  engine.remove(t.id);
  assert.strictEqual(db.all('SELECT * FROM timer_tag WHERE deleted = 0').length, 0, '墓碑未清理会让关系表只增不减');
});

test('秒表在缺 preset 的脏配置下不会崩，DATE 无运行态', () => {
  const d = engine.create({ name: '日期', type: 'DATE_COUNTDOWN', config: { schema_version: 1, target_date: '2027-01-01', timezone_id: 'Asia/Shanghai', include_today: false } });
  assert.strictEqual(engine.start(d.id).runState, 'idle');
  assert.strictEqual(typeof engine.get(d.id).daysLeft, 'number');
  const bad = engine.create({ name: '脏', type: 'PRECISE_COUNTDOWN', config: { schema_version: 1 } });
  assert.strictEqual(bad, null, 'preset_ms 缺失应拒绝创建而不是造一个 0 长度计时');
});
