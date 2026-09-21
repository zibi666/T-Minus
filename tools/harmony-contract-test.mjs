// 跨端契约一致性测试（表驱动，与 Windows apps/windows/tests/contract.test.cjs、
// Android ContractFixtureTest 读同一份 shared/contract/fixtures/contract.json）。
// 鸿蒙端跑不了 JUnit 也没有 npm test，这里用 DevEco 自带的 TypeScript 把 Contract.ets
// 转译成 CommonJS 后在 node 里断言——跑的就是设备上那份源码，不复制逻辑。
// 用法：node tools/harmony-contract-test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONTRACT_ETS = path.join(root, 'apps', 'harmony', 'entry', 'src', 'main', 'ets', 'core', 'Contract.ets');
const FIXTURE = path.join(root, 'shared', 'contract', 'fixtures', 'contract.json');

// DevEco 自带的 tsc（无网络依赖）；若装了独立 typescript 也可用。
const TS_CANDIDATES = [
  'E:/DevEco Studio/tools/hvigor/hvigor/node_modules/typescript',
  'E:/DevEco Studio/tools/hvigor/hvigor-ohos-plugin/node_modules/typescript'
];
let ts = null;
for (const c of TS_CANDIDATES) {
  try { ts = require(c); break; } catch (e) { /* try next */ }
}
if (!ts) {
  try { ts = require('typescript'); } catch (e) { /* fall through */ }
}
if (!ts) {
  console.error('找不到 TypeScript 编译器：需要 DevEco Studio 或本地 typescript。');
  process.exit(2);
}

const src = readFileSync(CONTRACT_ETS, 'utf-8');
const { outputText, diagnostics } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  reportDiagnostics: true,
  fileName: 'Contract.ets'
});
if (diagnostics && diagnostics.length) {
  console.error('Contract.ets 转译失败：');
  for (const d of diagnostics) console.error(' - ', ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  process.exit(2);
}

const tmp = mkdtempSync(path.join(tmpdir(), 'tm-contract-'));
const outfile = path.join(tmp, 'Contract.cjs');
try {
  writeFileSync(outfile, outputText);
  run(require(outfile));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function run(C) {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
  let passed = 0;
  const failures = [];

  const check = (group, name, expected, actual) => {
    const a = norm(actual), e = norm(expected);
    if (a === e) { passed++; return; }
    failures.push(`[${group}] ${name}\n    期望 ${e}\n    实得 ${a}`);
  };
  const norm = (v) => JSON.stringify(sortDeep(v));
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
      return o;
    }
    return v;
  };

  // 1) 常量
  check('constants', 'mono_guard_ms', fx.constants.mono_guard_ms, C.MONO_GUARD_MS);
  check('constants', 'palette', fx.constants.palette, C.TIMER_PALETTE);
  check('constants', 'default_color', fx.constants.default_color, C.DEFAULT_TIMER_COLOR);

  // 2) normalizePomodoro：默认值与夹紧边界
  for (const c of fx.normalize) {
    const got = C.normalizePomodoro(c.config);
    check('normalize', c.name, c.expect, {
      work_ms: got.work_ms, break_ms: got.break_ms, long_break_ms: got.long_break_ms, rounds: got.rounds
    });
  }

  // 3) isPomodoroConfig：统一判定（含脏数据与旧格式）
  for (const c of fx.is_pomodoro) {
    check('is_pomodoro', c.name, c.expect, C.isPomodoroConfig(c.type, c.config));
  }

  // 4) phasePresetMs：阶段时长
  for (const c of fx.phase_preset) {
    check('phase_preset', c.name, c.expect_ms, C.phasePresetMs(C.normalizePomodoro(c.config), c.phase));
  }

  // 5) isLongBreakDue：长休息触发轮次
  for (const c of fx.long_break_due) {
    check('long_break_due', c.name, c.expect, C.isLongBreakDue(C.normalizePomodoro(c.config), c.completed));
  }

  // 6) buildPomodoroConfig：long_break_ms 规范落位 + 顶层镜像，且写出的形态必须能被同一套归一化读回
  for (const c of fx.build_pomodoro_config) {
    const got = C.buildPomodoroConfig(c.input);
    check('build_pomodoro_config', c.name, c.expect, got);
    check('build_pomodoro_config', `${c.name}（读回）`,
      c.expect.pomodoro.long_break_ms, C.normalizePomodoro(got).long_break_ms);
  }

  // 7) buildPreciseConfig：普通倒计时配置
  for (const c of fx.build_precise_config) {
    check('build_precise_config', c.name, c.expect, C.buildPreciseConfig(c.input_ms));
  }

  // 8) contribute：统计口径（跨端不双倍计入）
  for (const c of fx.contribute) {
    const got = C.contribute(c.duration_sec, c.record_type, c.timer_is_pomodoro, C.normalizePomodoro(c.config));
    check('contribute', c.name, c.expect, { focus_ms: got.focusMs, rounds: got.rounds, marks: got.marks });
  }

  // 9) tagColorFor：标签哈希取色
  for (const c of fx.tag_color) {
    check('tag_color', c.name, c.expect, C.tagColorFor(c.tag));
  }

  // 10) 记录类型常量必须与 fixture 用值逐字对应，否则统计与历史判定会静默失效
  check('record_type', 'POMODORO_FOCUS', 'POMODORO_FOCUS', C.RECORD_POMODORO_FOCUS);
  check('record_type', 'POMODORO_BREAK', 'POMODORO_BREAK', C.RECORD_POMODORO_BREAK);
  check('record_type', 'SEGMENT', 'SEGMENT', C.RECORD_SEGMENT);
  check('record_type', 'PRECISE', 'PRECISE', C.RECORD_PRECISE);
  check('record_type', 'STOPWATCH', 'STOPWATCH', C.RECORD_STOPWATCH);

  // 11) 落库类型只有三种（番茄钟是 PRECISE_COUNTDOWN + config.pomodoro）
  check('types', 'TIMER_TYPES', ['DATE_COUNTDOWN', 'PRECISE_COUNTDOWN', 'STOPWATCH'], C.TIMER_TYPES);

  // 12) recordId：自动结算记录的跨端去重 id（三端必须逐位一致，否则多设备并行结算会各写一条）
  for (const c of fx.record_id) {
    check('record_id', c.name, c.expect, C.recordId(c.timer_id, c.session_id, c.phase_key, c.completed_focus));
  }

  // 13) settle_stamp：结算时刻与取整口径（ended_at 用计划截止、秒数向下取整、脏段不记账）
  for (const c of fx.settle_stamp) {
    const s = c.kind === 'auto' ? C.autoPhaseStamp(c.deadline_ms, c.preset_ms) : C.manualStamp(c.now_ms, c.elapsed_ms);
    check('settle_stamp', c.name, c.expect,
      { started_at: s.startedAt, ended_at: s.endedAt, duration_sec: s.durationSec, recordable: C.isRecordable(s) });
  }

  // 14) next_phase：番茄钟阶段推进裁决（长休息节奏必须三端同一套）
  for (const c of fx.next_phase) {
    const p = C.normalizePomodoro({ pomodoro: { work_ms: 1500000, break_ms: 300000, long_break_ms: 900000, rounds: c.rounds } });
    const n = C.nextPhaseOf(p, c.phase, c.completed_focus);
    check('next_phase', `rounds=${c.rounds} ${c.phase}/${c.completed_focus}`,
      { phase: c.expect.phase, completed_focus: c.expect.completed_focus },
      { phase: n.phase, completed_focus: n.completedFocus });
  }

  console.log(`harmony 契约：${passed} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
}
