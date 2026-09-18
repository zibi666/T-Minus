#!/usr/bin/env node
// 同步列白名单一致性：Windows 契约 (src/shared/contract.ts) 与后端 (RowStore.java) 必须逐表逐列同序。
// 两侧各持一份声明是历史现状，本脚本不消除重复，只保证漂移在 CI 里立刻失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const TABLES = ['timer_item', 'tag', 'timer_tag', 'milestone', 'timer_record'];

/** 从 anchor 之后按 { open, close } 提取每个 `table<sep>[cols]` 片段 */
function scan(src, tableRe, open, close, quote) {
  const out = {};
  let m;
  while ((m = tableRe.exec(src))) {
    const start = src.indexOf(open, m.index);
    const end = src.indexOf(close, start);
    if (start < 0 || end < 0) continue;
    const body = src.slice(start, end);
    out[m[1]] = [...body.matchAll(new RegExp(`${quote}(\\w+)${quote}`, 'g'))].map((x) => x[1]);
  }
  return out;
}

const javaSrc = read('backend/src/main/java/com/timemark/server/sync/RowStore.java');
const tsSrc = read('apps/windows/src/shared/contract.ts');

const java = scan(javaSrc, /"(\w+)",\s*List\.of\(/g, '(', ')', '"');
const ts = scan(tsSrc, /^\s{2}(\w+):\s*\[/gm, '[', ']', "'");

const problems = [];
for (const t of TABLES) {
  const a = java[t];
  const b = ts[t];
  if (!a) problems.push(`RowStore.java 未解析出表 ${t}`);
  if (!b) problems.push(`contract.ts 未解析出表 ${t}`);
  if (a && b && a.join(',') !== b.join(',')) {
    problems.push(`${t} 列不一致\n  java: ${a.join(', ')}\n  ts  : ${b.join(', ')}`);
  }
}

if (problems.length) {
  console.error('同步列白名单漂移：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
const total = TABLES.reduce((n, t) => n + ts[t].length, 0);
console.log(`同步列白名单一致：${TABLES.length} 张表，共 ${total} 列`);
