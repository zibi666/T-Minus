// §5 同步客户端：push pending_ops（operation_id 幂等）→ pull 游标整页推进 → 冲突走 pull 收敛（§6）。
// 与 Android sync/SyncManager.kt 逐条对齐：登录只认领并补交「无主行」、自回声跳过、
// 本地脏行处游标只推进到它之前（连续前缀）、仅终态结果才消费 op、401 即清凭据。
import { getPath, postJson, HttpError } from './Http';
import { Repo } from '../data/Repo';
import { AuthStore } from '../data/AuthStore';
import { LocalDb } from '../data/Db';
import { Milestone, PendingOp, Tag, TimerItem, TimerRecord, TimerTag, boolAt, numOrNullAt, rowPayloadJson, strOrNullAt } from '../data/Rows';
import { Notifier } from '../service/Notifier';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'TimeMarkSync';
const PUSH_BATCH: number = 200;
const PUSH_ROUNDS: number = 50;
const PULL_LIMIT: number = 500;
const PULL_ROUNDS: number = 100;

export class SyncManager {
  private repo: Repo;
  private auth: AuthStore;
  private db: LocalDb;
  private notifier: Notifier | null = null;
  lastError: string | null = null;
  syncing: boolean = false;

  constructor(repo: Repo, auth: AuthStore, db: LocalDb) {
    this.repo = repo;
    this.auth = auth;
    this.db = db;
  }

  bindNotifier(n: Notifier): void {
    this.notifier = n;
  }

  async register(username: string, password: string): Promise<string | null> {
    return this.authFlow('api/v1/auth/register', username, password);
  }

  async login(username: string, password: string): Promise<string | null> {
    return this.authFlow('api/v1/auth/login', username, password);
  }

  /** 返回 null 表示成功，非 null 为可展示的失败原因 */
  private async authFlow(path: string, username: string, password: string): Promise<string | null> {
    if (username.trim().length === 0 || password.length === 0) {
      return '用户名和密码不能为空';
    }
    try {
      const body: Record<string, Object> = {};
      body['username'] = username as Object;
      body['password'] = password as Object;
      const resp = await postJson(path, body, null);
      const token = strOrNullAt(resp, 'token');
      const user = resp['user'];
      if (token === null || user === undefined || user === null) {
        return '服务端未返回令牌';
      }
      const u = user as Record<string, Object>;
      const uid = strOrNullAt(u, 'id') ?? '';
      const uname = strOrNullAt(u, 'username') ?? username;
      // change_seq 全局自增：换账号后旧账号的高水位游标会让新账号的历史永远拉不到，
      // 旧账号残留的待传队列更会把数据推到新账号名下（401 后同号重登不受影响）
      const prevUid = this.auth.syncUid();
      this.auth.save(token, uid, uname);
      if (prevUid === null || prevUid !== uid) {
        this.auth.setPullCursor(0);
        await this.db.clearOps();
      }
      this.auth.setSyncUid(uid);
      await this.adoptAndEnqueue(uid);
      this.lastError = null;
      await this.syncNow();
      return null;
    } catch (e) {
      this.lastError = `${e}`;
      return this.lastError;
    }
  }

  /** 登出连游标与待发队列一起清：change_seq 全局自增，留着高水位会让下一个账号的历史变更永远拉不到 */
  async logout(): Promise<void> {
    this.auth.clear();
    this.auth.clearSyncUid();
    this.auth.setPullCursor(0);
    await this.db.clearOps();
  }

  /** 登录后只认领并入队「无主行」（离线期创建的那些）。
   *  给全部行入队 create 会把本地陈旧副本覆盖到云端较新的行上，且 origin_device_id 被标成本机
   *  → 其它设备 pull 时按「自身提交」跳过，整簇设备一起回退。 */
  private async adoptAndEnqueue(uid: string): Promise<void> {
    if (uid.length === 0) return;
    const items = (await this.db.allTimerRows()).filter((r: TimerItem): boolean => r.user_id === null);
    const recs = (await this.db.allRecords()).filter((r: TimerRecord): boolean => r.user_id === null);
    const tags = (await this.db.allTags()).filter((r: Tag): boolean => r.user_id === null);
    const tts = (await this.db.allTimerTags()).filter((r: TimerTag): boolean => r.user_id === null);
    const ms = (await this.db.allMilestones()).filter((r: Milestone): boolean => r.user_id === null);
    await this.db.adoptOrphans(uid);
    const now = Date.now();
    const push = async (table: string, rowId: string, payload: string): Promise<void> => {
      const o = new PendingOp();
      o.operation_id = `${table}-${rowId}-${now}`;
      o.table_name = table;
      o.op_type = 'create';
      o.row_id = rowId;
      o.row_payload = payload;
      o.base_version = null;
      o.is_run = false;
      o.created_at = now;
      o.state = 'queued';
      await this.db.enqueue(o);
    };
    for (let i = 0; i < items.length; i++) {
      if (await this.db.dirtyCount('timer_item', items[i].id) === 0) {
        await push('timer_item', items[i].id, rowPayloadJson(items[i]));
      }
    }
    for (let i = 0; i < recs.length; i++) {
      if (await this.db.dirtyCount('timer_record', recs[i].id) === 0) {
        await push('timer_record', recs[i].id, rowPayloadJson(recs[i]));
      }
    }
    for (let i = 0; i < tags.length; i++) {
      if (await this.db.dirtyCount('tag', tags[i].id) === 0) {
        await push('tag', tags[i].id, rowPayloadJson(tags[i]));
      }
    }
    for (let i = 0; i < tts.length; i++) {
      if (await this.db.dirtyCount('timer_tag', tts[i].id) === 0) {
        await push('timer_tag', tts[i].id, rowPayloadJson(tts[i]));
      }
    }
    for (let i = 0; i < ms.length; i++) {
      if (await this.db.dirtyCount('milestone', ms[i].id) === 0) {
        await push('milestone', ms[i].id, rowPayloadJson(ms[i]));
      }
    }
  }

  async syncNow(): Promise<void> {
    if (this.syncing) return;
    if (this.auth.token() === null) return;
    this.syncing = true;
    try {
      await this.pushPending();
      await this.pull();
      this.lastError = null;
    } catch (e) {
      // 401：JWT 到期且无刷新接口。不清凭据就会每 30s 撞一次永远失败的请求，界面还显示已登录
      if (e instanceof HttpError && e.status === 401) {
        this.auth.clear();
        this.lastError = '登录已过期，请重新登录';
      } else {
        this.lastError = `${e}`;
      }
      hilog.warn(0x0000, TAG, `同步失败: ${e}`);
    } finally {
      this.syncing = false;
    }
  }

  private async pushPending(): Promise<void> {
    const token = this.auth.token();
    if (token === null) return;
    for (let round = 0; round < PUSH_ROUNDS; round++) {
      const ops = await this.db.queuedOps(PUSH_BATCH);
      if (ops.length === 0) return;
      const operations: Object[] = [];
      for (let i = 0; i < ops.length; i++) {
        const o = ops[i];
        let row: Record<string, Object> = {};
        try {
          row = JSON.parse(o.row_payload) as Record<string, Object>;
        } catch (e) {
          row = {};
        }
        if (o.is_run) {
          row['__run'] = true as Object;
        }
        const op: Record<string, Object> = {};
        op['operation_id'] = o.operation_id as Object;
        op['table_name'] = o.table_name as Object;
        op['op_type'] = o.op_type as Object;
        op['row'] = row as Object;
        if (o.base_version !== null) op['base_version'] = o.base_version as Object;
        operations.push(op as Object);
      }
      const body: Record<string, Object> = {};
      body['operations'] = operations as Object;
      const resp = await postJson('api/v1/sync/push', body, token);
      let consumed = 0;
      const results = resp['results'];
      if (results !== undefined && Array.isArray(results)) {
        const arr = results as Record<string, Object>[];
        for (let i = 0; i < arr.length; i++) {
          const opId = strOrNullAt(arr[i], 'operation_id');
          if (opId === null) continue; // 服务端幂等表下轮返回 duplicate + operation_id 收敛
          // 只有终态才消费本地 op；server_error/未知状态保留重投并停止后续 op 保持队列顺序——
          // 瞬时故障被当终态删掉就是静默丢数据。永久拒绝（rejected：bad_request/foreign_row）
          // 第一轮保留，第二轮幂等表以 duplicate:true 原样返回，靠该标记消费收敛（与 Windows 一致）
          const status = strOrNullAt(arr[i], 'status') ?? '';
          const terminal = boolAt(arr[i], 'duplicate') || status === 'accepted' || status === 'conflict'
            || status === 'discarded' || status === 'bad_request';
          if (!terminal) return;
          await this.db.deleteOp(opId);
          consumed++;
        }
      }
      // 防御：服务端返回空 results（异常/降级）时直接退出，避免 50 轮重发相同 ops 死循环
      if (consumed === 0) return;
    }
  }

  private async pull(): Promise<void> {
    const token = this.auth.token();
    if (token === null) return;
    const deviceId = this.auth.deviceId();
    for (let round = 0; round < PULL_ROUNDS; round++) {
      const cursor = this.auth.pullCursor();
      const resp = await getPath(`api/v1/sync/pull?cursor=${cursor}&limit=${PULL_LIMIT}`, token);
      const changes = resp['changes'];
      if (changes === undefined || !Array.isArray(changes) || (changes as Object[]).length === 0) return;
      const arr = changes as Record<string, Object>[];
      let appliedMax = cursor;
      for (let i = 0; i < arr.length; i++) {
        const ch = arr[i];
        const seq = numOrNullAt(ch, 'change_seq') ?? 0;
        const origin = strOrNullAt(ch, 'origin_device_id');
        if (origin === deviceId) {
          appliedMax = Math.max(appliedMax, seq); // 自身提交已在本地
          continue;
        }
        const table = strOrNullAt(ch, 'table_name') ?? '';
        const payloadRaw = ch['payload'];
        if (payloadRaw === undefined || payloadRaw === null) {
          appliedMax = Math.max(appliedMax, seq); // 空载荷属垃圾行，消费掉别卡住游标
          continue;
        }
        const payload = payloadRaw as Record<string, Object>;
        const rowId = strOrNullAt(payload, 'id');
        // 本行还有未上传操作：游标只能停在它之前（连续前缀，§5.3）。
        // 同页后面更高级 seq 的行本轮一并放弃——继续消费会让 appliedMax 越过被挡行，
        // 这条远端变更从此永不再投递，该行将本地/服务端永久分叉
        if (rowId !== null && await this.db.dirtyCount(table, rowId) > 0) break;
        appliedMax = Math.max(appliedMax, seq);
        const applied = await this.applyChange(table, payload);
        if (applied && table === 'timer_item' && rowId !== null) {
          this.repo.onRemoteApplied(rowId); // 作废本地单调基准，按远端段重落基
        }
      }
      this.auth.setPullCursor(appliedMax); // 只推进到「连续已消费」前缀（§5.3）
      if (appliedMax === cursor) return;   // 整页都被挡住：等下一次 sync，不空转重取同一页
      const more = resp['has_more'];
      if (typeof more !== 'boolean' || !more) return;
    }
  }

  /**
   * 应用远程行（调用方已确认本行没有未上传操作）。
   * 与业务写入同锁（Repo.withWriteLock）：远端行若落在 settleDue/用户操作的「读旧行 → 改 → 写」
   * 中间，会被陈旧快照覆盖或反过来覆盖它；同一把锁也保证本行落库不会卷进进行中的事务
   * （全库事务都在该锁内开启，回滚不会连带远端行而游标已推进）。
   * 不可重入：锁内只做裸 upsertRow，不得再调 settleDue 类持锁方法。
   */
  private async applyChange(table: string, payload: Record<string, Object>): Promise<boolean> {
    return this.repo.withWriteLock<boolean>(async (): Promise<boolean> => {
      const rowId = strOrNullAt(payload, 'id');
      if (rowId === null) return false;
      if (table === 'timer_item') {
        await this.db.upsertRow(TimerItem.fromPayload(payload));
      } else if (table === 'timer_record') {
        await this.db.upsertRow(TimerRecord.fromPayload(payload));
      } else if (table === 'tag') {
        await this.db.upsertRow(Tag.fromPayload(payload));
      } else if (table === 'timer_tag') {
        await this.db.upsertRow(TimerTag.fromPayload(payload));
      } else if (table === 'milestone') {
        await this.db.upsertRow(Milestone.fromPayload(payload));
      } else {
        return false;
      }
      return true;
    });
  }
}
