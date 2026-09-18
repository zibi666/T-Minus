// §5 同步客户端：登录态 + 持久化 pending_ops 队列 + push/pull 循环 + 冲突丢弃
import { LocalDB, uuid, safeParse, Row } from './db';
import { AuthInfo, SyncStatusInfo } from '../src/shared/types';
import { SYNC_TABLE_COLUMNS } from '../src/shared/contract';

// 生产同步服务地址（内置，不暴露给用户配置）：腾讯云服务器 systemd timemark.service
const DEFAULT_SERVER = 'http://118.195.133.25:18080';

// 与服务端一致的列映射：唯一来源见 src/shared/contract.ts（引擎 importData 共用）
const COLS = SYNC_TABLE_COLUMNS;

export interface QueueOp {
  table: string;
  opType: 'create' | 'update' | 'delete';
  row: Record<string, unknown>;
  baseVersion?: number | null;
  isRun?: boolean;
}

interface AuthResp {
  token?: string;
  user?: { id?: string; username?: string };
  message?: string;
}
interface PushResultItem { operation_id?: string; status?: string }
interface PushResp { results?: PushResultItem[] }
interface PullChange { change_seq: number; table_name: string; origin_device_id?: string; payload?: Row }
interface PullResp { changes?: PullChange[]; has_more?: boolean }
export interface AuthResult { ok: boolean; message?: string }

export class SyncClient {
  private token: string | null = null;
  private userId: string | null = null;
  private username: string | null = null;
  serverUrl = DEFAULT_SERVER;
  private syncing = false;
  /** 远程变更应用到本地后回调（引擎据此刷新运行时基线） */
  onRemoteChange: ((table: string, rowId: string) => void) | null = null;
  onStatus: ((s: SyncStatusInfo) => void) | null = null;
  private lastStatus: SyncStatusInfo = { state: 'idle', lastSyncAt: null, pending: 0, error: null };

  constructor(private db: LocalDB, private deviceId: string) {}

  restore(): AuthInfo {
    this.serverUrl = DEFAULT_SERVER; // 地址内置，忽略历史存储的 server_url meta
    this.token = this.db.getMeta('auth_token');
    this.userId = this.db.getMeta('auth_uid');
    this.username = this.db.getMeta('auth_username');
    return this.authState();
  }

  authState(): AuthInfo {
    return { loggedIn: !!this.token, userId: this.userId, username: this.username, serverUrl: this.serverUrl };
  }

  private emit(state: SyncStatusInfo['state'], error: string | null = null) {
    this.lastStatus = { state, lastSyncAt: this.lastStatus.lastSyncAt, pending: this.pendingCount(), error };
    if (this.onStatus) this.onStatus(this.lastStatus);
  }

  pendingCount(): number {
    const r = this.db.get(`SELECT COUNT(*) AS n FROM pending_ops WHERE state='queued'`);
    return r ? Number(r.n) : 0;
  }

  lastStatusInfo(): SyncStatusInfo {
    return { ...this.lastStatus, pending: this.pendingCount() };
  }

  setServer(_url: string) {
    // 服务地址已内置为生产服务器，忽略外部传入值（接口地址不暴露给用户）
    this.serverUrl = DEFAULT_SERVER;
  }

  register(username: string, password: string): Promise<AuthResult> {
    return this.authFlow('/api/v1/auth/register', username, password);
  }

  login(username: string, password: string): Promise<AuthResult> {
    return this.authFlow('/api/v1/auth/login', username, password);
  }

  private async authFlow(apiPath: string, username: string, password: string): Promise<AuthResult> {
    try {
      const res = await fetch(this.serverUrl + apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = (await res.json()) as AuthResp;
      if (!res.ok || !data.token || !data.user?.id) return { ok: false, message: data.message || '请求失败' };
      this.token = data.token;
      this.userId = data.user.id;
      this.username = data.user.username ?? username;
      this.db.setMeta('auth_token', this.token);
      this.db.setMeta('auth_uid', this.userId);
      this.db.setMeta('auth_username', this.username);
      this.adoptOrphans(this.userId);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: '无法连接服务器：' + (e instanceof Error ? e.message : String(e)) };
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
    const rowId = op.row?.id != null ? String(op.row.id) : null;
    this.db.run(
      `INSERT OR REPLACE INTO pending_ops (operation_id, table_name, op_type, row_id, row_payload, base_version, is_run, created_at, state)
       VALUES (?,?,?,?,?,?,?,?, 'queued')`,
      [uuid(), op.table, op.opType, rowId, JSON.stringify(op.row), op.baseVersion ?? null, op.isRun ? 1 : 0, Date.now()]
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
    } catch (e) {
      this.emit('error', e instanceof Error ? e.message : String(e));
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
          row: { ...safeParse(o.row_payload == null ? null : String(o.row_payload)), __run: !!o.is_run },
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
      const data = (await res.json()) as PushResp;
      let consumed = 0;
      for (const r of data.results || []) {
        // 防御：operation_id 缺失时跳过本地消费（服务端幂等表会在下轮返回 duplicate + operation_id 收敛）
        if (!r || r.operation_id == null) continue;
        // accepted/duplicate 正常消费；conflict/discarded → 丢弃本地操作，随后 pull 拉回服务端现状（§6）
        this.db.run('DELETE FROM pending_ops WHERE operation_id = ?', [r.operation_id]);
        consumed++;
      }
      // 服务端返回空 results（异常/降级）时退出，避免 50 轮重发同一批 ops
      if (consumed === 0) return;
    }
  }

  private async pull() {
    for (let round = 0; round < 100; round++) {
      const cursor = Number(this.db.getMeta('pull_cursor') || 0);
      const res = await fetch(`${this.serverUrl}/api/v1/sync/pull?cursor=${cursor}&limit=500`, { headers: this.headers() });
      if (res.status === 401) throw new Error('登录已过期，请重新登录');
      if (!res.ok) throw new Error('pull 失败：HTTP ' + res.status);
      const data = (await res.json()) as PullResp;
      const changes = data.changes ?? [];
      if (!changes.length) return;
      const touched: Array<[string, string]> = [];
      let appliedMax = cursor;
      this.db.transaction(() => {
        for (const ch of changes) {
          appliedMax = Math.max(appliedMax, ch.change_seq);
          if (ch.origin_device_id === this.deviceId) continue; // 自身提交已在本地
          const appliedId = this.applyChange(ch);
          if (appliedId) touched.push([ch.table_name, appliedId]);
        }
        this.db.setMeta('pull_cursor', String(appliedMax)); // 整页成功应用后才推进（§5.3）
      });
      for (const [t, id] of touched) {
        if (this.onRemoteChange) this.onRemoteChange(t, id);
      }
      if (!data.has_more) return;
    }
  }

  /** 应用远程行；本行存在未上传操作时跳过（dirty 规则），返回被应用的行 id */
  private applyChange(ch: PullChange): string | null {
    const row = ch.payload;
    const table = ch.table_name;
    const cols = COLS[table];
    if (!cols || !row || row.id == null) return null;
    const dirty = this.db.get(
      `SELECT COUNT(*) AS n FROM pending_ops WHERE table_name = ? AND row_id = ? AND state='queued'`,
      [table, String(row.id)]
    );
    if (dirty && Number(dirty.n) > 0) return null;
    const values = cols.map((c) => (row[c] !== undefined ? row[c] : null));
    this.db.run(
      `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      values
    );
    return String(row.id);
  }
}
