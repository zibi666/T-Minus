// §5 同步客户端：登录态 + 持久化 pending_ops 队列 + push/pull 循环 + 冲突丢弃
import { LocalDB, uuid, safeParse } from './db';

// 生产同步服务地址（内置，不暴露给用户配置）：腾讯云服务器 systemd timemark.service
const DEFAULT_SERVER = 'http://118.195.133.25:18080';

// 与服务端一致的列映射（INSERT OR REPLACE 通用应用远程行）
const COLS: Record<string, string[]> = {
  timer_item: ['id', 'user_id', 'name', 'type', 'color', 'starred', 'pinned', 'remark',
    'config_json', 'run_state', 'session_id', 'run_json', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  tag: ['id', 'user_id', 'name', 'color', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_tag: ['id', 'user_id', 'timer_id', 'tag_id', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  milestone: ['id', 'user_id', 'timer_id', 'note', 'marked_at', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_record: ['id', 'user_id', 'timer_id', 'session_id', 'started_at', 'ended_at',
    'duration_sec', 'record_type', 'version', 'updated_at', 'deleted', 'origin_device_id']
};

export interface QueueOp {
  table: string;
  opType: 'create' | 'update' | 'delete';
  row: any;
  baseVersion?: number | null;
  isRun?: boolean;
}

export class SyncClient {
  private token: string | null = null;
  private userId: string | null = null;
  private username: string | null = null;
  serverUrl = DEFAULT_SERVER;
  private syncing = false;
  /** 远程变更应用到本地后回调（引擎据此刷新运行时基线） */
  onRemoteChange: ((table: string, rowId: string) => void) | null = null;
  onStatus: ((s: any) => void) | null = null;
  private lastStatus: any = { state: 'idle', lastSyncAt: null, pending: 0, error: null };

  constructor(private db: LocalDB, private deviceId: string) {}

  restore(): any {
    this.serverUrl = DEFAULT_SERVER; // 地址内置，忽略历史存储的 server_url meta
    this.token = this.db.getMeta('auth_token');
    this.userId = this.db.getMeta('auth_uid');
    this.username = this.db.getMeta('auth_username');
    return this.authState();
  }

  authState() {
    return { loggedIn: !!this.token, userId: this.userId, username: this.username, serverUrl: this.serverUrl };
  }

  private emit(state: string, error: string | null = null) {
    this.lastStatus = { state, lastSyncAt: this.lastStatus.lastSyncAt, pending: this.pendingCount(), error };
    if (this.onStatus) this.onStatus(this.lastStatus);
  }

  pendingCount(): number {
    const r = this.db.get(`SELECT COUNT(*) AS n FROM pending_ops WHERE state='queued'`);
    return r ? Number(r.n) : 0;
  }

  lastStatusInfo() {
    return { ...this.lastStatus, pending: this.pendingCount() };
  }

  setServer(_url: string) {
    // 服务地址已内置为生产服务器，忽略外部传入值（接口地址不暴露给用户）
    this.serverUrl = DEFAULT_SERVER;
  }

  async register(username: string, password: string) {
    return this.authFlow('/api/v1/auth/register', username, password);
  }

  async login(username: string, password: string) {
    return this.authFlow('/api/v1/auth/login', username, password);
  }

  private async authFlow(apiPath: string, username: string, password: string) {
    try {
      const res = await fetch(this.serverUrl + apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data: any = await res.json();
      if (!res.ok) return { ok: false, message: data.message || '请求失败' };
      this.token = data.token;
      this.userId = data.user.id;
      this.username = data.user.username;
      this.db.setMeta('auth_token', this.token!);
      this.db.setMeta('auth_uid', this.userId!);
      this.db.setMeta('auth_username', this.username!);
      this.adoptOrphans(this.userId!);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: '无法连接服务器：' + (e?.message || e) };
    }
  }

  logout() {
    this.token = null;
    this.userId = null;
    this.username = null;
    for (const k of ['auth_token', 'auth_uid', 'auth_username']) {
      this.db.run('DELETE FROM meta WHERE key = ?', [k]);
    }
    this.emit('idle');
  }

  /** 登录后认领离线期产生的无主数据（单账号个人应用语义） */
  private adoptOrphans(uid: string) {
    for (const t of Object.keys(COLS)) {
      this.db.run(`UPDATE ${t} SET user_id = ? WHERE user_id IS NULL`, [uid]);
    }
  }

  private headers() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token };
  }

  /** 引擎每次业务写入后调用；与业务写在同一持久化批次内落盘 */
  enqueue(op: QueueOp) {
    if (!this.token) return; // 离线优先：未登录只记账本地
    this.db.run(
      `INSERT OR REPLACE INTO pending_ops (operation_id, table_name, op_type, row_payload, base_version, is_run, created_at, state)
       VALUES (?,?,?,?,?,?,?,'queued')`,
      [uuid(), op.table, op.opType, JSON.stringify(op.row), op.baseVersion ?? null, op.isRun ? 1 : 0, Date.now()]
    );
  }

  async syncNow(): Promise<void> {
    if (!this.token || this.syncing) {
      if (this.token) this.emit('syncing');
      return;
    }
    this.syncing = true;
    this.emit('syncing');
    try {
      await this.pushPending();
      await this.pull();
      this.lastStatus = { state: 'idle', lastSyncAt: Date.now(), pending: this.pendingCount(), error: null };
      if (this.onStatus) this.onStatus(this.lastStatus);
    } catch (e: any) {
      this.emit('error', String(e?.message || e));
    } finally {
      this.syncing = false;
    }
  }

  private async pushPending() {
    for (let round = 0; round < 50; round++) {
      const ops = this.db.all(`SELECT * FROM pending_ops WHERE state='queued' ORDER BY created_at LIMIT 200`);
      if (!ops.length) return;
      const body = {
        operations: ops.map((o) => ({
          operation_id: o.operation_id,
          table_name: o.table_name,
          op_type: o.op_type,
          row: { ...safeParse(o.row_payload), __run: !!o.is_run },
          base_version: o.base_version
        }))
      };
      const res = await fetch(this.serverUrl + '/api/v1/sync/push', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body)
      });
      if (res.status === 401) throw new Error('登录已过期，请重新登录');
      if (!res.ok) throw new Error('push 失败：HTTP ' + res.status);
      const data: any = await res.json();
      for (const r of data.results || []) {
        // 防御：operation_id 缺失时跳过本地消费（服务端幂等表会在下轮返回 duplicate + operation_id 收敛）
        if (!r || r.operation_id == null) continue;
        // accepted/duplicate 正常消费；conflict/discarded → 丢弃本地操作，随后 pull 拉回服务端现状（§6）
        this.db.run('DELETE FROM pending_ops WHERE operation_id = ?', [r.operation_id]);
      }
    }
  }

  private async pull() {
    for (let round = 0; round < 100; round++) {
      const cursor = Number(this.db.getMeta('pull_cursor') || 0);
      const res = await fetch(`${this.serverUrl}/api/v1/sync/pull?cursor=${cursor}&limit=500`, { headers: this.headers() });
      if (res.status === 401) throw new Error('登录已过期，请重新登录');
      if (!res.ok) throw new Error('pull 失败：HTTP ' + res.status);
      const data: any = await res.json();
      const changes = data.changes || [];
      if (!changes.length) return;
      const touched: Array<[string, string]> = [];
      let appliedMax = cursor;
      this.db.transaction(() => {
        for (const ch of changes) {
          appliedMax = Math.max(appliedMax, ch.change_seq);
          if (ch.origin_device_id === this.deviceId) continue; // 自身提交已在本地
          if (this.applyChange(ch)) touched.push([ch.table_name, ch.payload.id]);
        }
        this.db.setMeta('pull_cursor', String(appliedMax)); // 整页成功应用后才推进（§5.3）
      });
      for (const [t, id] of touched) {
        if (this.onRemoteChange) this.onRemoteChange(t, id);
      }
      if (!data.has_more) return;
    }
  }

  /** 应用远程行；本行存在未上传操作时跳过（dirty 规则），返回是否实际应用 */
  private applyChange(ch: any): boolean {
    const row = ch.payload;
    const table = ch.table_name;
    const cols = COLS[table];
    if (!cols || !row || !row.id) return false;
    const dirty = this.db.get(
      `SELECT COUNT(*) AS n FROM pending_ops WHERE table_name = ? AND state='queued' AND row_payload LIKE ?`,
      [table, `%"id":"${row.id}"%`]
    );
    if (dirty && Number(dirty.n) > 0) return false;
    const values = cols.map((c) => (row[c] !== undefined ? row[c] : null));
    this.db.run(
      `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      values
    );
    return true;
  }
}
