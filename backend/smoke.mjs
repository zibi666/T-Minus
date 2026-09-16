// TimeMark 后端冒烟测试：走通 §5 契约全链路
// 用法：BASE=http://127.0.0.1:8080 node smoke.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const results = [];

async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

function check(name, cond, extra) {
  results.push(`${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' | ' + extra : ''}`);
}

const uname = 'u' + Date.now();

// 1. health
let r = await req('GET', '/api/v1/health');
check('health', r.status === 200 && r.data.ok === true);

// 2. register
r = await req('POST', '/api/v1/auth/register', { username: uname, password: 'pass123456' });
check('register', r.status === 200 && !!r.data.token && !!r.data.user?.id, JSON.stringify(r.data));
const token = r.data.token;

// 3. duplicate register -> 409
r = await req('POST', '/api/v1/auth/register', { username: uname, password: 'pass123456' });
check('register dup 409', r.status === 409);

// 4. login
r = await req('POST', '/api/v1/auth/login', { username: uname, password: 'pass123456' });
check('login', r.status === 200 && !!r.data.token);

// 5. me
r = await req('GET', '/api/v1/me', null, token);
check('me', r.status === 200 && r.data.user?.username === uname);

// 6. unauthorized pull -> 401
r = await req('GET', '/api/v1/sync/pull?cursor=0');
check('pull unauthorized 401', r.status === 401);

// 7. push create timer_item
const row = {
  id: 't-1', user_id: null, name: '考研倒计时', type: 'DATE_COUNTDOWN', color: '#E5484D',
  starred: 1, pinned: 0, remark: '',
  config_json: JSON.stringify({ schema_version: 1, target_date: '2026-12-19', timezone_id: 'Asia/Shanghai', include_today: false }),
  run_state: 'idle', session_id: null, run_json: null,
  version: 1, updated_at: Date.now(), deleted: 0, origin_device_id: 'dev-A'
};
r = await req('POST', '/api/v1/sync/push',
  { operations: [{ operation_id: 'op-1', table_name: 'timer_item', op_type: 'create', row, base_version: 0 }] }, token);
check('push create accepted', r.data?.results?.[0]?.status === 'accepted', JSON.stringify(r.data?.results?.[0]));

// 8. duplicate push -> duplicate:true
r = await req('POST', '/api/v1/sync/push',
  { operations: [{ operation_id: 'op-1', table_name: 'timer_item', op_type: 'create', row, base_version: 0 }] }, token);
check('push duplicate', r.data?.results?.[0]?.duplicate === true, JSON.stringify(r.data?.results?.[0]));

// 9. pull sees change
r = await req('GET', '/api/v1/sync/pull?cursor=0', null, token);
check('pull has change', r.data?.changes?.length === 1 && r.data.changes[0].payload?.id === 't-1',
  'next=' + r.data?.next_cursor);
const cursor = r.data.next_cursor;

// 10. stale base_version run op -> conflict
const row2 = { ...row, version: 5, run_state: 'running', session_id: 's-2', __run: true };
r = await req('POST', '/api/v1/sync/push',
  { operations: [{ operation_id: 'op-2', table_name: 'timer_item', op_type: 'update', row: row2, base_version: 4 }] }, token);
check('stale run conflict', r.data?.results?.[0]?.status === 'conflict' && r.data.results[0].reason === 'stale_version',
  JSON.stringify(r.data?.results?.[0]));

// 11. correct base_version run op -> accepted
const row3 = { ...row, version: 2, run_state: 'running', session_id: 's-1', __run: true };
r = await req('POST', '/api/v1/sync/push',
  { operations: [{ operation_id: 'op-3', table_name: 'timer_item', op_type: 'update', row: row3, base_version: 1 }] }, token);
check('run update accepted', r.data?.results?.[0]?.status === 'accepted', JSON.stringify(r.data?.results?.[0]));

// 12. delete -> tombstone accepted
r = await req('POST', '/api/v1/sync/push',
  { operations: [{ operation_id: 'op-4', table_name: 'timer_item', op_type: 'delete', row: { ...row, version: 3 }, base_version: 2 }] }, token);
check('delete accepted', r.data?.results?.[0]?.status === 'accepted', JSON.stringify(r.data?.results?.[0]));

// 13. update after tombstone -> tombstone_wins
r = await req('POST', '/api/v1/sync/push',
  { operations: [{ operation_id: 'op-5', table_name: 'timer_item', op_type: 'update', row: { ...row, version: 4, name: 'x' } }] }, token);
check('tombstone wins', r.data?.results?.[0]?.status === 'conflict' && r.data.results[0].reason === 'tombstone_wins',
  JSON.stringify(r.data?.results?.[0]));

// 14. incremental pull from cursor -> run update + delete (2 changes)
r = await req('GET', '/api/v1/sync/pull?cursor=' + cursor, null, token);
check('pull sees run+delete (2)', r.data?.changes?.length === 2, 'got ' + r.data?.changes?.length);

// 15. push timer_record
const rec = {
  id: 'r-1', user_id: null, timer_id: 't-1', session_id: 's-1',
  started_at: 1, ended_at: 2, duration_sec: 60, record_type: 'STOPWATCH',
  version: 1, updated_at: Date.now(), deleted: 0, origin_device_id: 'dev-A'
};
r = await req('POST', '/api/v1/sync/push',
  { operations: [{ operation_id: 'op-6', table_name: 'timer_record', op_type: 'create', row: rec }] }, token);
check('record push accepted', r.data?.results?.[0]?.status === 'accepted', JSON.stringify(r.data?.results?.[0]));

// 16. pull sees run update + delete + record (3 changes)
r = await req('GET', '/api/v1/sync/pull?cursor=' + cursor, null, token);
check('pull sees 3 changes', r.data?.changes?.length === 3, 'got ' + r.data?.changes?.length);

console.log(results.join('\n'));
const fails = results.filter((s) => s.startsWith('FAIL')).length;
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
