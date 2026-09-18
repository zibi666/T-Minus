#!/usr/bin/env node
// 版本号同步：仓库根 VERSION 是唯一来源。
//   node tools/version.mjs          检查各处是否一致（CI 用，不一致退出码 1）
//   node tools/version.mjs --write  把 VERSION 写进 package.json / latest.json / harmony app.json5
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf-8').trim();

if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`VERSION 文件格式非法：${VERSION}（需 x.y.z）`);
  process.exit(1);
}

const PKG = path.join(ROOT, 'apps/windows/package.json');
const LATEST = path.join(ROOT, 'apps/windows/latest.json');
const GRADLE = path.join(ROOT, 'apps/android/build.gradle.kts');
const APPJSON = path.join(ROOT, 'apps/harmony/AppScope/app.json5');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

/** 鸿蒙 versionCode：由语义化版本导出，避免手工同步漏掉 */
function harmonyCode(v) {
  const [ma, mi, pa] = v.split('.').map((n) => parseInt(n, 10));
  return ma * 1000000 + mi * 1000 + pa;
}

const pkg = readJson(PKG);
const latest = readJson(LATEST);
// gradle 侧从 VERSION 读取，无需写入；此处只校验读得到同一值
const gradleOk = fs.readFileSync(GRADLE, 'utf-8').includes('extra["appVersion"]');
const appText = fs.existsSync(APPJSON) ? fs.readFileSync(APPJSON, 'utf-8') : '';
const appVersionOk = new RegExp(`"versionName":\\s*"${VERSION}"`).test(appText);
const appCodeOk = new RegExp(`"versionCode":\\s*${harmonyCode(VERSION)}`).test(appText);

const drift = [];
if (pkg.version !== VERSION) drift.push(`apps/windows/package.json: ${pkg.version} → ${VERSION}`);
if (latest.version !== VERSION) drift.push(`apps/windows/latest.json: ${latest.version} → ${VERSION}`);
if (!gradleOk) drift.push('apps/android/build.gradle.kts 未从 VERSION 读取 versionName');
if (!fs.existsSync(APPJSON)) {
  // 鸿蒙端尚未入库：干净克隆里没有这个文件，跳过而不是判失败；入库后自动纳入校验
} else if (!appVersionOk) drift.push(`apps/harmony/AppScope/app.json5: versionName → ${VERSION}`);
else if (!appCodeOk) drift.push(`apps/harmony/AppScope/app.json5: versionCode → ${harmonyCode(VERSION)}`);

if (!process.argv.includes('--write')) {
  if (drift.length) {
    console.error(`VERSION=${VERSION}，以下位置不一致：`);
    for (const d of drift) console.error('  - ' + d);
    console.error('修复：node tools/version.mjs --write');
    process.exit(1);
  }
  console.log(`版本号一致：v${VERSION}`);
  process.exit(0);
}

pkg.version = VERSION;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
const nextLatest = { ...latest, version: VERSION };
fs.writeFileSync(LATEST, JSON.stringify(nextLatest, null, 2) + '\n', 'utf-8');
if (fs.existsSync(APPJSON)) {
  const stamped = appText
    .replace(/"versionName":\s*"[^"]*"/, `"versionName": "${VERSION}"`)
    .replace(/"versionCode":\s*\d+/, `"versionCode": ${harmonyCode(VERSION)}`);
  fs.writeFileSync(APPJSON, stamped, 'utf-8');
}
console.log(`已写入 v${VERSION}：package.json / latest.json / harmony app.json5（Android 侧读 VERSION 文件，无需写入）`);
if (!gradleOk) {
  console.error('注意：apps/android/build.gradle.kts 未接入 VERSION，请手工检查');
  process.exit(1);
}
if (!fs.existsSync(APPJSON)) {
  console.error('注意：apps/harmony/AppScope/app.json5 不存在，未写入鸿蒙端版本号');
  process.exit(1);
}
