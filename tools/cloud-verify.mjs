// 集成验证：health + 注册 + push + pull 走真实云数据库
// 用法：VERIFY_BASE=http://118.195.133.25:18080 node cloud-verify.mjs（默认本机 18081）
const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:18081';
const uname = 'cloudtest' + Date.now();
async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const out = [];
let r = await req('GET', '/api/v1/health');
out.push((r.status === 200 && r.data.ok) ? 'PASS health' : 'FAIL health ' + JSON.stringify(r.data));
r = await req('POST', '/api/v1/auth/register', { username: uname, password: 'test123456' });
const ok = r.status === 200 && r.data.token;
out.push(ok ? 'PASS register (cloud db)' : 'FAIL register ' + JSON.stringify(r.data));
if (ok) {
  const row = { id: 'cloud-test-1', user_id: null, name: '云库验证', type: 'STOPWATCH', color: '#0090FF', starred: 0, pinned: 0, remark: '集成测试', config_json: '{"schema_version":1}', run_state: 'idle', session_id: null, run_json: null, version: 1, updated_at: Date.now(), deleted: 0, origin_device_id: 'local-test' };
  r = await req('POST', '/api/v1/sync/push', { operations: [{ operation_id: 'cloud-op-1', table_name: 'timer_item', op_type: 'create', row, base_version: 0 }] }, r.data.token);
  const pushOk = r.data?.results?.[0]?.status === 'accepted';
  const opIdOk = r.data?.results?.[0]?.operation_id === 'cloud-op-1';
  out.push(pushOk && opIdOk ? 'PASS push (operation_id 契约 OK)' : 'FAIL push ' + JSON.stringify(r.data));
  r = await req('GET', '/api/v1/sync/pull?cursor=0', null, (await req('POST', '/api/v1/auth/login', { username: uname, password: 'test123456' })).data.token);
  out.push(r.data?.changes?.length === 1 ? 'PASS pull' : 'FAIL pull ' + JSON.stringify(r.data?.changes?.length));
}
console.log(out.join('\n'));
process.exit(out.some((s) => s.startsWith('FAIL')) ? 1 : 0);
