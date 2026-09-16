// 测试到 TDSQL-C 的 TCP 连通性
const net = require('net');
const host = 'sh-cynosdbmysql-grp-2gf1ewak.sql.tencentcdb.com';
const port = 28451;
const start = Date.now();
const socket = net.connect({ host, port, timeout: 6000 });
socket.on('connect', () => {
  const ms = Date.now() - start;
  console.log('REACHABLE ' + host + ':' + port + ' in ' + ms + 'ms');
  socket.end();
  process.exit(0);
});
socket.on('timeout', () => {
  console.log('TIMEOUT - 端口未响应（安全组未放行本机 IP，或公网地址未开启）');
  socket.destroy();
  process.exit(2);
});
socket.on('error', (e) => {
  console.log('ERROR ' + e.message);
  process.exit(1);
});
