// 鸿蒙端引擎行为单测：直接加载 core/{Contract,Engine,Machine}.ets（纯逻辑、不碰 @kit），
// 断言状态迁移序列。场景对齐 Android EngineTest.kt 与 Windows tests/engine.test.cjs。
// 用法：node tools/harmony-engine-test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ETS = path.join(root, 'apps', 'harmony', 'entry', 'src', 'main', 'ets');

const TS_PATHS = [
  'E:/DevEco Studio/tools/hvigor/hvigor/node_modules/typescript',
  'E:/DevEco Studio/tools/hvigor/hvigor-ohos-plugin/node_modules/typescript'
];
let ts = null;
for (const c of TS_PATHS) { try { ts = require(c); break; } catch (e) { /* next */ } }
if (!ts) { try { ts = require('typescript'); } catch (e) { /* next */ } }
if (!ts) { console.error('找不到 TypeScript 编译器'); process.exit(2); }

const MODULES = ['core/Contract', 'core/Engine', 'core/Machine'];
const tmp = mkdtempSync(path.join(tmpdir(), 'tm-engine-'));
let passed = 0;
const failures = [];
try {
  for (const m of MODULES) {
    const src = readFileSync(path.join(ETS, `${m}.ets`), 'utf-8');
    const { outputText, diagnostics } = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
      reportDiagnostics: true, fileName: `${m}.ets`
    });
    if (diagnostics && diagnostics.length) {
      console.error(`${m}.ets 转译失败：`);
      for (const d of diagnostics) console.error(' - ', ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      process.exit(2);
    }
    writeFileSync(path.join(tmp, `${path.basename(m)}.js`), outputText);
  }
  run(require(path.join(tmp, 'Machine.js')), require(path.join(tmp, 'Engine.js')), require(path.join(tmp, 'Contract.js')));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function eq(name, expected, actual) {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : actual;
  const e = typeof expected === 'object' ? JSON.stringify(expected) : expected;
  if (a === e) { passed++; return; }
  failures.push(`${name}\n    期望 ${e}\n    实得 ${a}`);
}
function ok(name, cond) { eq(name, true, !!cond); }

function run(Machine, Engine, C) {
  const NOW = 1789600000000;
  const runStr = (r) => Engine.runToJsonString(r);

  // ---------- A. 读数（Engine.liveState，对齐 Android EngineTest 前半） ----------
  const preciseCfg = JSON.stringify(C.buildPreciseConfig(60000));
  let live = Engine.liveState(C.TYPE_PRECISE, 'running', runStr({ target_at: NOW + 60000 }), preciseCfg, NOW);
  eq('precise/running 剩余=60000 已用=0', [60000, 0, false], [live.remainingMs, live.elapsedMs, live.due]);

  live = Engine.liveState(C.TYPE_PRECISE, 'running', runStr({ target_at: NOW - 1000 }), preciseCfg, NOW);
  eq('precise/到点后 剩余=0 且 due', [0, true], [live.remainingMs, live.due]);

  live = Engine.liveState(C.TYPE_PRECISE, 'paused', runStr({ remaining_at_pause: 30000 }), preciseCfg, NOW);
  eq('precise/paused 用快照剩余', [30000, 30000], [live.remainingMs, live.elapsedMs]);

  live = Engine.liveState(C.TYPE_PRECISE, 'idle', null, preciseCfg, NOW);
  eq('precise/idle 显示预设', 60000, live.remainingMs);

  live = Engine.liveState(C.TYPE_STOPWATCH, 'running',
    runStr({ accumulated_ms: 10000, segment_started_at: NOW - 5000 }), '{"schema_version":1}', NOW);
  eq('stopwatch/running 累计含当前段', 15000, live.elapsedMs);

  const pomoCfg = JSON.stringify(C.buildPomodoroConfig({ work_ms: 1500000, break_ms: 300000, long_break_ms: 900000, rounds: 4 }));
  live = Engine.liveState(C.TYPE_PRECISE, 'running', runStr({ phase: 'focus', phase_ends_at: NOW + 1500000, completed_focus: 2 }), pomoCfg, NOW);
  eq('番茄钟/专注中轮次=completed+1', 3, live.round);
  live = Engine.liveState(C.TYPE_PRECISE, 'running', runStr({ phase: 'break', phase_ends_at: NOW + 300000, completed_focus: 2 }), pomoCfg, NOW);
  eq('番茄钟/休息中轮次=completed', 2, live.round);
  live = Engine.liveState(C.TYPE_PRECISE, 'running', runStr({ phase: 'long_break', phase_ends_at: NOW + 60000, completed_focus: 4 }), pomoCfg, NOW);
  eq('番茄钟/长休息用长休息档', [900000 - 60000, 4], [live.elapsedMs, live.round]);
  live = Engine.liveState(C.TYPE_PRECISE, 'idle', runStr({ phase: 'long_break', completed_focus: 4 }), pomoCfg, NOW);
  eq('番茄钟/idle 保留阶段与轮次', ['long_break', 900000, 4], [live.phase, live.remainingMs, live.round]);

  const legacy = JSON.stringify({ schema_version: 1, focus_ms: 1800000, short_break_ms: 360000, rounds_before_long: 3 });
  ok('旧格式仍判为番茄钟', C.isPomodoroConfig(C.TYPE_PRECISE, JSON.parse(legacy)));
  live = Engine.liveState(C.TYPE_PRECISE, 'running', runStr({ phase: 'focus', phase_ends_at: NOW + 1800000 }), legacy, NOW);
  eq('旧格式读数用旧档位', 1800000, live.remainingMs);

  live = Engine.liveState(C.TYPE_PRECISE, 'running', '{坏数据', '也不是json', NOW);
  eq('坏数据退化为 idle 读数', 0, live.remainingMs);

  // ---------- B. 三段式生命周期（start→pause→resume→stop） ----------
  let t = Machine.start(C.TYPE_PRECISE, preciseCfg, NOW);
  eq('start 进 running 并要新 session', [true, 'running'], [t.newSession, t.runState]);
  eq('start 目标时刻 = now + preset', NOW + 60000, t.run.target_at);
  const started = t.run;

  t = Machine.pause(C.TYPE_PRECISE, preciseCfg, runStr(started), NOW + 20000);
  eq('pause 存快照剩余', 40000, t.run.remaining_at_pause);
  eq('pause 作废单调基准', true, t.dropBaseline);
  const paused = t.run;

  t = Machine.resume(C.TYPE_PRECISE, preciseCfg, runStr(paused), NOW + 30000);
  eq('resume 以快照重排目标', NOW + 30000 + 40000, t.run.target_at);
  eq('resume 清快照剩余', null, t.run.remaining_at_pause ?? null);
  const resumed = t.run;

  t = Machine.stop(C.TYPE_PRECISE, preciseCfg, runStr(resumed), 'running', NOW + 40000);
  eq('stop 按已进行时长记一条 PRECISE', 1, t.records.length);
  eq('stop 计入 20s+10s，暂停的 10s 不计', 30, t.records[0].durationSec);
  eq('stop 记录类型', 'PRECISE', t.records[0].recordType);
  eq('stop 归 idle 且保留 session', ['idle', false], [t.runState, t.clearSession]);

  t = Machine.stop(C.TYPE_PRECISE, preciseCfg, runStr({ target_at: NOW + 60000 }), 'running', NOW + 1000);
  eq('不足 5s 的误触结束不记账', 0, t.records.length);

  t = Machine.reset(C.TYPE_PRECISE, runStr(resumed));
  eq('reset 归 idle 不记账', [0, 'idle'], [t.records.length, t.runState]);

  t = Machine.finishPrecise(C.TYPE_PRECISE, preciseCfg, NOW + 60000);
  eq('到点记整段预设', 60, t.records[0].durationSec);
  eq('到点清空 session', true, t.clearSession);
  eq('到点结束时间用 target 而非 now', NOW + 60000, t.records[0].endedAt);

  // ---------- C. 分段（不中断、不双倍计入） ----------
  t = Machine.segment(C.TYPE_PRECISE, preciseCfg, runStr({ target_at: NOW + 60000, segments_ms: [] }), 'running', NOW + 10000);
  eq('分段记一条 SEGMENT', ['SEGMENT', 10], [t.records[0].recordType, t.records[0].durationSec]);
  eq('分段后倒计时不中断', NOW + 60000, t.run.target_at);
  eq('分段后 session 不变', false, t.newSession);
  const seg1 = t.run;
  t = Machine.segment(C.TYPE_PRECISE, preciseCfg, runStr(seg1), 'running', NOW + 30000);
  eq('第二段只记增量', 20, t.records[0].durationSec);
  eq('segments_ms 累积两段', [10000, 20000], t.run.segments_ms);
  t = Machine.segment(C.TYPE_PRECISE, preciseCfg, runStr(t.run), 'running', NOW + 30000);
  eq('无新增时长时不再打点', true, t.noop);

  const swCfg = '{"schema_version":1}';
  t = Machine.segment(C.TYPE_STOPWATCH, swCfg,
    runStr({ accumulated_ms: 0, segment_started_at: NOW - 25000, segments_ms: [] }), 'running', NOW);
  eq('正计时分段记 lap', 25, t.records[0].durationSec);
  eq('正计时分段后累计落袋', 25000, t.run.accumulated_ms);
  ok('正计时分段后重开新 lap', t.run.segment_started_at === NOW);

  // ---------- D. 番茄钟推进 / 长休息 / 不自动连跳 ----------
  t = Machine.start(C.TYPE_PRECISE, pomoCfg, NOW);
  eq('番茄钟 start 从 focus 起', ['focus', 0], [t.run.phase, t.run.completed_focus]);
  eq('番茄钟 start 阶段终点', NOW + 1500000, t.run.phase_ends_at);
  let r = t.run;

  t = Machine.advancePomodoro(C.TYPE_PRECISE, pomoCfg, runStr(r), NOW + 1500000, NOW + 1500000);
  eq('专注结束记 POMODORO_FOCUS', ['POMODORO_FOCUS', 1500], [t.records[0].recordType, t.records[0].durationSec]);
  eq('进入短休息', 'break', t.run.phase);
  eq('完成轮次 +1', 1, t.run.completed_focus);
  r = t.run;

  t = Machine.advancePomodoro(C.TYPE_PRECISE, pomoCfg, runStr(r), NOW + 1800000, NOW + 1800000);
  eq('休息结束记 POMODORO_BREAK', 'POMODORO_BREAK', t.records[0].recordType);
  eq('休息结束回 focus', 'focus', t.run.phase);
  eq('休息不计轮次', 1, t.run.completed_focus);
  r = t.run;

  // 连推到第 4 轮 → 长休息
  let cur = runStr({ phase: 'focus', phase_ends_at: NOW + 1500000, completed_focus: 3 });
  t = Machine.advancePomodoro(C.TYPE_PRECISE, pomoCfg, cur, NOW + 1500000, NOW + 1500000);
  eq('第 4 轮专注后进长休息', 'long_break', t.run.phase);
  eq('长休息时长写入阶段终点', NOW + 1500000 + 900000, t.run.phase_ends_at);
  eq('长休息前轮次已计到 4', 4, t.run.completed_focus);

  // 超时不自动连跳：一次 settle 只推进一个阶段，漏掉的时间不补记
  const overdue = runStr({ phase: 'focus', phase_ends_at: NOW, completed_focus: 0 });
  t = Machine.advancePomodoro(C.TYPE_PRECISE, pomoCfg, overdue, NOW, NOW + 7200000);
  eq('拖延 2 小时仍只推进一个阶段', 'break', t.run.phase);
  eq('下一阶段从 now 起算（不补跑）', NOW + 7200000 + 300000, t.run.phase_ends_at);
  eq('漏掉的时间不记进专注', 1500, t.records[0].durationSec);

  t = Machine.skipPhase(C.TYPE_PRECISE, pomoCfg, runStr({ phase: 'focus', phase_ends_at: NOW + 1500000, completed_focus: 0 }), NOW + 10000);
  eq('跳阶段：已过 10s 达阈值 → 记账', 'POMODORO_FOCUS', t.records[0].recordType);
  eq('跳阶段后进休息', 'break', t.run.phase);
  t = Machine.skipPhase(C.TYPE_PRECISE, pomoCfg, runStr({ phase: 'focus', phase_ends_at: NOW + 1500000, completed_focus: 0 }), NOW + 1000);
  eq('跳阶段：1s 误触不记账', 0, t.records.length);
  t = Machine.skipPhase(C.TYPE_PRECISE, preciseCfg, runStr({ target_at: NOW + 60000 }), NOW);
  eq('非番茄钟无阶段可跳', true, t.noop);
  t = Machine.segment(C.TYPE_PRECISE, pomoCfg, runStr({ phase: 'focus', phase_ends_at: NOW + 1500000 }), 'running', NOW);
  eq('番茄钟无手动打点', true, t.noop);

  // ---------- E. §3.6 单调时钟守卫 ----------
  const target = runStr({ target_at: NOW + 60000 });
  eq('跳变在阈值内不修正', null, Machine.guardMono(C.TYPE_PRECISE, preciseCfg, target, NOW + 1000, 1000, 1000, 60000, 0));
  const g = Machine.guardMono(C.TYPE_PRECISE, preciseCfg, target, NOW + 3600000, 0, 3600000, 60000, 0);
  ok('墙钟被拨快 1 小时后触发修正', g !== null);
  eq('按单调钟把目标时刻改回 now+60000', NOW + 3600000 + 60000, g.run.target_at);
  eq('修正后重建基准剩余', 60000, g.baselineRemaining);
  const gs = Machine.guardMono(C.TYPE_STOPWATCH, swCfg,
    runStr({ accumulated_ms: 10000, segment_started_at: NOW - 5000 }), NOW + 7200000, 0, 7200000, 0, 15000);
  eq('正计时以单调累计为准', 15000, gs.run.accumulated_ms);
  eq('守卫不改变 running 语义', 'running', gs.runState);

  const b = Machine.baselineFor(C.TYPE_PRECISE, preciseCfg, runStr({ target_at: NOW + 45000 }), NOW);
  eq('重启后按持久化字段重建剩余', 45000, b[0]);
  const bs = Machine.baselineFor(C.TYPE_STOPWATCH, swCfg,
    runStr({ accumulated_ms: 10000, segment_started_at: NOW - 5000 }), NOW);
  eq('重启后正计时基准=累计+当前段', 15000, bs[1]);

  // ---------- F. 阶段计划与阈值口径 ----------
  const p = C.normalizePomodoro(JSON.parse(pomoCfg));
  eq('4 轮档第 4 轮触发长休息', true, C.isLongBreakDue(p, 4));
  eq('第 5 轮不触发', false, C.isLongBreakDue(p, 5));
  const npBreak = C.nextPhaseOf(p, 'break', 1);
  eq('nextPhaseOf 休息后回 focus', 'focus', npBreak.phase);
  eq('休息后轮次不加', 1, npBreak.completedFocus);
  eq('回 focus 的段时长', 1500000, C.phasePresetMs(p, npBreak.phase));
  const npLong = C.nextPhaseOf(p, 'focus', 3);
  eq('nextPhaseOf 第 4 轮后长休息', 'long_break', npLong.phase);
  eq('长休息段时长', 900000, C.phasePresetMs(p, npLong.phase));
  eq('阈值取自契约', 5000, C.PARTIAL_SETTLE_MIN_MS);

  // ---------- G. session_id 生命周期（只有自然到点才清，手动 stop/reset 保留） ----------
  const runningPomo = JSON.stringify({ phase: 'focus', phase_ends_at: NOW + 60000, completed_focus: 0 });
  eq('stop 不清 session', false, Machine.stop(C.TYPE_PRECISE, pomoCfg, runningPomo, C.RUN_RUNNING, NOW).clearSession);
  eq('reset 不清 session', false, Machine.reset(C.TYPE_PRECISE, runningPomo).clearSession);
  eq('精确倒计时自然到点清 session', true, Machine.finishPrecise(C.TYPE_PRECISE, preciseCfg, NOW).clearSession);

  console.log(`harmony 引擎：${passed} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
}
