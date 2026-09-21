// 仓库不变量守卫：把这次审阅中「容易被改回去」的几类回归钉死在测试里。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'release', 'release3', '.git', 'build', '.gradle', 'target', 'oh_modules', '.hvigor'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|kt|kts|cjs|mjs|java|ets)$/.test(e.name)) out.push(p);
  }
  return out;
}

const sources = [
  ...walk(path.join(ROOT, 'apps/windows/electron')),
  ...walk(path.join(ROOT, 'apps/windows/src')),
  ...walk(path.join(ROOT, 'apps/android/app/src')),
  // 鸿蒙端尚未入库时不参与扫描；提交后自动纳入守卫
  ...(fs.existsSync(path.join(ROOT, 'apps/harmony/entry/src')) ? walk(path.join(ROOT, 'apps/harmony/entry/src')) : []),
  ...walk(path.join(ROOT, 'backend/src'))
];

const read = (p) => fs.readFileSync(p, 'utf-8');

test('番茄钟统计不得回到本机私有账本表', () => {
  for (const f of sources) {
    // 唯一合法的提及是迁移时丢弃这张历史表：DROP 语句本身，以及「表还在不在」的
    // 存在性探测（避免每次启动都空跑一次 DROP 弄脏库文件），两者都要剥掉再匹配
    const body = read(f)
      .replace(/DROP TABLE (IF EXISTS )?\w+/g, '')
      .replace(/sqlite_master[^`;]*?pomo_journal/g, '');
    assert.ok(!/pomo_journal|JournalStore|KEY_JOURNAL/.test(body), `${f} 仍引用本机私有账本（统计应由已同步的 timer_record 派生）`);
  }
});

test('色值只允许出现在契约与 fixture 里', () => {
  const hexes = ['#4DC9F0', '#9381FF', '#21E0C4', '#FFB224', '#FF6B6B', '#5A9EFF', '#F472B6', '#A3E635', '#FF9F43', '#3DDB97', '#E5484D'];
  const allowed = [
    path.join('src', 'shared', 'contract.ts'),
    path.join('core', 'Contract.kt'),
    path.join('core', 'Contract.ets'),
    path.join('ui', 'Theme.kt'), // Compose 主题自身的 UI 色（bg/card/text/stroke），不含计时器色板
    path.join('common', 'Theme.ets') // 同上：ArkUI 主题的 UI 色
  ];
  for (const f of sources) {
    if (allowed.some((a) => f.endsWith(a))) continue;
    const body = read(f);
    const hit = hexes.filter((h) => body.toUpperCase().includes(h));
    assert.strictEqual(hit.length, 0, `${f} 硬编码了色值 ${hit.join(', ')}（应取自契约）`);
  }
});

test('单调守卫阈值不再各处各写一份', () => {
  const hits = sources.filter((f) => /MONO_GUARD_MS\s*[:=]\s*2000|private const val MONO_GUARD_MS/.test(read(f)));
  for (const f of hits) {
    assert.ok(f.endsWith('contract.ts') || f.endsWith('Contract.kt') || f.endsWith('Contract.ets'), `${f} 自定义了守卫阈值，应引用契约`);
  }
});

test('已被 stop 取代的 endPrecise 不残留', () => {
  for (const f of sources) {
    assert.ok(!/endPrecise/.test(read(f)), `${f} 仍引用 endPrecise`);
  }
});

test('构建产物与本机 SDK 不再被 git 跟踪', () => {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return; // 打包源里没有 .git 时跳过
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  const banned = [
    /^apps\/android\/\.gradle\//,
    /^tools\/android\//,
    /^tools\/android-dl\//,
    /^apps\/windows\/dist\//,
    /^apps\/windows\/release/,
    /\.log$/,
    /^\.workbuddy\//
  ];
  const offenders = out.split('\n').filter((f) => banned.some((re) => re.test(f)));
  assert.strictEqual(offenders.length, 0, `仍有 ${offenders.length} 个产物/工具文件被跟踪，例如 ${offenders.slice(0, 3).join(', ')}`);
});

test('四处版本号同源', () => {
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf-8').trim();
  const pkg = JSON.parse(read(path.join(ROOT, 'apps/windows/package.json')));
  const latest = JSON.parse(read(path.join(ROOT, 'apps/windows/latest.json')));
  assert.strictEqual(pkg.version, version, 'apps/windows/package.json 与 VERSION 不一致');
  assert.strictEqual(latest.version, version, 'apps/windows/latest.json 与 VERSION 不一致');
  const gradle = read(path.join(ROOT, 'apps/android/app/build.gradle.kts'));
  assert.ok(/rootProject\.extra\["appVersion"\]/.test(gradle), 'Android 未从 VERSION 读取 versionName');
  const app = read(path.join(ROOT, 'apps/harmony/AppScope/app.json5'));
  assert.ok(new RegExp(`"versionName":\\s*"${version}"`).test(app), 'apps/harmony AppScope/app.json5 的 versionName 与 VERSION 不一致');
  const [ma, mi, pa] = version.split('.').map((n) => parseInt(n, 10));
  assert.ok(new RegExp(`"versionCode":\\s*${ma * 1000000 + mi * 1000 + pa}`).test(app),
    'apps/harmony AppScope/app.json5 的 versionCode 未由 VERSION 导出');
});

test('旧 node 版同步服务端已从仓库移除，Java 后端是唯一实现', () => {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return;
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' });
  // 只看被跟踪的文件：本机残留的旧版临时脚本/本地 db 属于开发者数据，不由测试处置
  const still = out.split('\n').filter((f) => f.startsWith('server/'));
  assert.strictEqual(still.length, 0, `仍有 ${still.length} 个 server/ 文件被跟踪`);
});
