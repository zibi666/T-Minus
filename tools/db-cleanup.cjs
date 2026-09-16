// 清理集成测试数据
const mysql = require('mysql2/promise');
async function main() {
  const conn = await mysql.createConnection({
    host: 'sh-cynosdbmysql-grp-2gf1ewak.sql.tencentcdb.com', port: 28451,
    user: 'root', password: process.env.TIMEMARK_DB_PASSWORD, database: 'timemark'
  });
  await conn.query("DELETE FROM users WHERE username LIKE 'cloudtest%'");
  await conn.query("DELETE FROM timer_item WHERE id = 'cloud-test-1'");
  await conn.query("DELETE FROM change_log WHERE row_id = 'cloud-test-1'");
  await conn.query("DELETE FROM ops WHERE operation_id = 'cloud-op-1'");
  const [u] = await conn.query('SELECT COUNT(*) AS n FROM users');
  const [t] = await conn.query('SELECT COUNT(*) AS n FROM timer_item');
  console.log('CLEANED users=' + u[0].n + ' timers=' + t[0].n);
  await conn.end();
}
main().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
