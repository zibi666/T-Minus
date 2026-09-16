// TimeMark 建库脚本：连接 TDSQL-C，建库 + 执行 schema.sql（全幂等）+ 建索引 + 校验
// 密码通过环境变量 TIMEMARK_DB_PASSWORD 传入，绝不打印
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const HOST = 'sh-cynosdbmysql-grp-2gf1ewak.sql.tencentcdb.com';
const PORT = 28451;
const USER = process.env.TIMEMARK_DB_USER || 'root';
const PASSWORD = process.env.TIMEMARK_DB_PASSWORD;
const DB = 'timemark';

if (!PASSWORD) {
  console.error('FAIL: 缺少 TIMEMARK_DB_PASSWORD');
  process.exit(1);
}

async function main() {
  const conn = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD, connectTimeout: 10000 });
  console.log('OK 已连接 ' + HOST + ':' + PORT + ' (user=' + USER + ')');

  // 1. 建库
  await conn.query('CREATE DATABASE IF NOT EXISTS `' + DB + '` DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci');
  console.log('OK 数据库 ' + DB + ' 就绪');

  // 2. 切库
  await conn.changeUser({ database: DB });

  // 3. 执行 schema.sql（逐条，幂等）
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'backend', 'src', 'main', 'resources', 'schema.sql'), 'utf-8');
  const stmts = ddl.split(';').map((s) => s.trim()).filter(Boolean);
  let n = 0;
  for (const s of stmts) {
    await conn.query(s);
    n++;
  }
  console.log('OK schema.sql 已执行 ' + n + ' 条语句');

  // 4. 索引（已存在则跳过）
  const indexes = [
    'CREATE INDEX idx_timer_user ON timer_item (user_id, deleted)',
    'CREATE INDEX idx_record_timer ON timer_record (timer_id)',
    'CREATE INDEX idx_change_user ON change_log (user_id, change_seq)'
  ];
  for (const ix of indexes) {
    try {
      await conn.query(ix);
      console.log('OK ' + ix.slice(13, 40));
    } catch (e) {
      if (String(e.message).includes('already exists') || e.errno === 1061) {
        console.log('SKIP ' + ix.slice(13, 40) + '（已存在）');
      } else {
        console.log('WARN 索引失败: ' + e.message);
      }
    }
  }

  // 5. 校验：列出所有表
  const [rows] = await conn.query('SHOW TABLES');
  console.log('OK 当前表: ' + rows.map((r) => Object.values(r)[0]).join(', '));

  await conn.end();
  console.log('ALL DONE');
}

main().catch((e) => {
  console.error('FAIL: ' + (e.code ? e.code + ' ' : '') + e.message);
  process.exit(1);
});
