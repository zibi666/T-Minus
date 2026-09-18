// 跨端契约一致性测试（表驱动，与 Android ContractFixtureTest 读同一份 fixture）。
// 前置：npm run build:main（本文件跑编译后的 dist/main/src/shared/contract.js）
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const C = require('../dist/main/src/shared/contract.js');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'shared', 'contract', 'fixtures', 'contract.json'), 'utf-8')
);

test('constants 与契约一致', () => {
  assert.strictEqual(C.MONO_GUARD_MS, FIXTURE.constants.mono_guard_ms);
  assert.deepStrictEqual(C.TIMER_PALETTE, FIXTURE.constants.palette);
  assert.strictEqual(C.DEFAULT_TIMER_COLOR, FIXTURE.constants.default_color);
});

test('normalizePomodoro：默认值与夹紧边界', () => {
  for (const c of FIXTURE.normalize) {
    assert.deepStrictEqual(C.normalizePomodoro(c.config), c.expect, `用例：${c.name}`);
  }
});

test('isPomodoroConfig：统一判定（含脏数据与旧格式）', () => {
  for (const c of FIXTURE.is_pomodoro) {
    assert.strictEqual(C.isPomodoroConfig(c.type, c.config), c.expect, `用例：${c.name}`);
  }
});

test('phasePresetMs：阶段时长', () => {
  for (const c of FIXTURE.phase_preset) {
    assert.strictEqual(C.phasePresetMs(C.normalizePomodoro(c.config), c.phase), c.expect_ms, `用例：${c.name}`);
  }
});

test('isLongBreakDue：长休息触发轮次', () => {
  for (const c of FIXTURE.long_break_due) {
    assert.strictEqual(C.isLongBreakDue(C.normalizePomodoro(c.config), c.completed), c.expect, `用例：${c.name}`);
  }
});

test('buildPomodoroConfig：long_break_ms 规范落位 + 顶层镜像', () => {
  for (const c of FIXTURE.build_pomodoro_config) {
    assert.deepStrictEqual(C.buildPomodoroConfig(c.input), c.expect, `用例：${c.name}`);
  }
});

test('buildPreciseConfig：普通倒计时配置', () => {
  for (const c of FIXTURE.build_precise_config) {
    assert.deepStrictEqual(C.buildPreciseConfig(c.input_ms), c.expect, `用例：${c.name}`);
  }
});

test('contribute：统计口径（跨端不双倍计入）', () => {
  for (const c of FIXTURE.contribute) {
    const got = C.contribute(
      { durationSec: c.duration_sec, recordType: c.record_type },
      c.timer_is_pomodoro,
      C.normalizePomodoro(c.config)
    );
    assert.deepStrictEqual(got, { focusMs: c.expect.focus_ms, rounds: c.expect.rounds, marks: c.expect.marks }, `用例：${c.name}`);
  }
});

test('tagColorFor：标签哈希取色', () => {
  for (const c of FIXTURE.tag_color) {
    assert.strictEqual(C.tagColorFor(c.tag), c.expect, `用例：${c.name}`);
  }
});

test('recordId：自动结算记录的跨端去重 id', () => {
  for (const c of FIXTURE.record_id) {
    assert.strictEqual(
      C.recordId(c.timer_id, c.session_id, c.phase_key, c.completed_focus),
      c.expect,
      `用例：${c.name}`
    );
  }
});

test('settle_stamp：结算时刻与取整口径（跨端统计落在同一天）', () => {
  for (const c of FIXTURE.settle_stamp) {
    const s = c.kind === 'auto'
      ? C.autoPhaseStamp(c.deadline_ms, c.preset_ms)
      : C.manualStamp(c.now_ms, c.elapsed_ms);
    assert.deepStrictEqual(
      { started_at: s.startedAt, ended_at: s.endedAt, duration_sec: s.durationSec, recordable: C.isRecordable(s) },
      c.expect,
      `用例：${c.name}`
    );
  }
});
