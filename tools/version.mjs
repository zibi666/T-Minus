#!/usr/bin/env node
// 版本号同步：仓库根 VERSION 是唯一来源。
//   node tools/version.mjs          检查三处是否一致（CI 用，不一致退出码 1）
//   node tools/version.mjs --write  把 VERSION 写进 package.json 与 latest.json
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

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

const pkg = readJson(PKG);
const latest = readJson(LATEST);
// gradle 侧从 VERSION 读取，无需写入；此处只校验读得到同一值
const gradleOk = fs.readFileSync(GRADLE, 'utf-8').includes('extra["appVersion"]');

const drift = [];
if (pkg.version !== VERSION) drift.push(`apps/windows/package.json: ${pkg.version} → ${VERSION}`);
if (latest.version !== VERSION) drift.push(`apps/windows/latest.json: ${latest.version} → ${VERSION}`);
if (!gradleOk) drift.push('apps/android/build.gradle.kts 未从 VERSION 读取 versionName');

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
console.log(`已写入 v${VERSION}：package.json / latest.json（Android 侧读 VERSION 文件，无需写入）`);
if (!gradleOk) {
  console.error('注意：apps/android/build.gradle.kts 未接入 VERSION，请手工检查');
  process.exit(1);
}
