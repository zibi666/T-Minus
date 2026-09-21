// 设备/账号偏好（与 Android AuthStore + DataStore 同键位）。
// token/uid/username/device_id/pull_cursor 五项是同步协议的输入；reminder_ids 是鸿蒙端特有：
// reminderAgent 的提醒号需要跨进程取消，落在本地偏好里而不是数据库（不上同步）。
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

/** 与 Android AppContainer.SERVER_URL / Windows syncClient 同一后端
 *  域名 sync.knowhub.chat → Cloudflare DNS 解析到 118.195.133.25
 *  nginx 监听 18443/TCP + Let's Encrypt 证书（DNS-01 验证，公信 CA）
 *  鸿蒙系统已内置 Let's Encrypt 信任链，无需携带任何证书或修改 module.json5。
 *  18443 是非标端口，不受腾讯云未备案域名拦截影响。
 *  部署/续证步骤见 deploy/TLS-CUTOVER.md。 */
export const SERVER_BASE = 'https://sync.knowhub.chat:18443';

const KEY_TOKEN = 'auth_token';
const KEY_UID = 'auth_uid';
const KEY_USERNAME = 'auth_username';
const KEY_DEVICE_ID = 'device_id';
const KEY_CURSOR = 'pull_cursor';
const KEY_SYNC_UID = 'sync_uid';
const KEY_REMINDERS = 'reminder_ids';
const KEY_SNAPSHOT = 'card_snapshot';

export class AuthStore {
  private p: preferences.Preferences;

  constructor(p: preferences.Preferences) {
    this.p = p;
  }

  static async open(ctx: common.Context): Promise<AuthStore> {
    const p = await preferences.getPreferences(ctx, 'timemark_prefs');
    return new AuthStore(p);
  }

  private readStr(key: string): string | null {
    const v = this.p.getSync(key, '');
    const s = typeof v === 'string' ? v : `${v}`;
    return s.length === 0 ? null : s;
  }

  token(): string | null { return this.readStr(KEY_TOKEN); }
  uid(): string | null { return this.readStr(KEY_UID); }
  username(): string | null { return this.readStr(KEY_USERNAME); }
  loggedIn(): boolean { return this.token() !== null; }

  deviceId(): string {
    const had = this.readStr(KEY_DEVICE_ID);
    if (had !== null) return had;
    const id = util.generateRandomUUID(true);
    this.p.putSync(KEY_DEVICE_ID, id);
    this.p.flush();
    return id;
  }

  save(token: string, uid: string, username: string): void {
    this.p.putSync(KEY_TOKEN, token);
    this.p.putSync(KEY_UID, uid);
    this.p.putSync(KEY_USERNAME, username);
    this.p.flush();
  }

  clear(): void {
    this.p.deleteSync(KEY_TOKEN);
    this.p.deleteSync(KEY_UID);
    this.p.deleteSync(KEY_USERNAME);
    this.p.flush();
  }

  pullCursor(): number {
    const v = this.p.getSync(KEY_CURSOR, 0);
    return typeof v === 'number' ? v : 0;
  }

  setPullCursor(v: number): void {
    this.p.putSync(KEY_CURSOR, v);
    this.p.flush();
  }

  /** 最近一次登录的账号 id：登录时据此判定「换账号」，决定是否清游标与待传队列 */
  syncUid(): string | null { return this.readStr(KEY_SYNC_UID); }

  setSyncUid(uid: string): void {
    this.p.putSync(KEY_SYNC_UID, uid);
    this.p.flush();
  }

  clearSyncUid(): void {
    this.p.deleteSync(KEY_SYNC_UID);
    this.p.flush();
  }

  /** timerId → reminderAgent 提醒号；重启后据此取消过期提醒 */
  reminderIds(): Record<string, Object> {
    const raw = this.readStr(KEY_REMINDERS);
    if (raw === null) return {};
    try {
      const o: Object = JSON.parse(raw);
      return typeof o === 'object' && o !== null ? (o as Record<string, Object>) : {};
    } catch (e) {
      return {};
    }
  }

  setReminderId(timerId: string, reminderId: number): void {
    const m = this.reminderIds();
    m[timerId] = reminderId as Object;
    this.p.putSync(KEY_REMINDERS, JSON.stringify(m));
    this.p.flush();
  }

  /** 卡片快照：主进程写入，FormExtensionAbility 同步读取 */
  setCardSnapshot(json: string): void {
    this.p.putSync(KEY_SNAPSHOT, json);
    this.p.flush();
  }

  prefs(): preferences.Preferences {
    return this.p;
  }

  clearReminderId(timerId: string): void {
    const m = this.reminderIds();
    if (m[timerId] === undefined) return;
    const next: Record<string, Object> = {};
    const keys = Object.keys(m);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] !== timerId) next[keys[i]] = m[keys[i]];
    }
    this.p.putSync(KEY_REMINDERS, JSON.stringify(next));
    this.p.flush();
  }
}
