// 依赖装配（与 Android data/AppContainer.kt 同位）：进程内单例，Ability 启动时初始化。
import { common } from '@kit.AbilityKit';
import { LocalDb } from './data/Db';
import { AuthStore } from './data/AuthStore';
import { Repo } from './data/Repo';
import { SyncManager } from './sync/SyncManager';
import { Reminders } from './service/Reminders';
import { Notifier } from './service/Notifier';
import { Ticker } from './service/Ticker';
import { Backup } from './service/Backup';
import { CardUpdater } from './service/CardUpdater';
import { LiveViewCtl } from './service/LiveView';

export class AppHolder {
  static ctx: common.UIAbilityContext | null = null;
  static db: LocalDb | null = null;
  static auth: AuthStore | null = null;
  static repo: Repo | null = null;
  static sync: SyncManager | null = null;
  static reminders: Reminders | null = null;
  static notifier: Notifier | null = null;
  static ticker: Ticker | null = null;
  static backup: Backup | null = null;
  static live: LiveViewCtl | null = null;
  static ready: boolean = false;
  static bootError: string | null = null;
  private static booting: Promise<void> | null = null;

  /**
   * 幂等装配：Ability 与每个页面都可能调用，且 doBoot 内部有 await，
   * 只看 ready 会让第二次调用重复组装（两个 Ticker / 两个 setInterval，且 onDestroy 只停得掉最后一个）。
   * 因此缓存进行中的 Promise，让后来者等同一次装配。
   */
  static boot(ctx: common.UIAbilityContext): Promise<void> {
    if (AppHolder.ready) return Promise.resolve();
    if (AppHolder.booting === null) AppHolder.booting = AppHolder.doBoot(ctx);
    return AppHolder.booting;
  }

  private static async doBoot(ctx: common.UIAbilityContext): Promise<void> {
    AppHolder.ctx = ctx;
    try {
      const db = await LocalDb.open(ctx);
      const auth = await AuthStore.open(ctx);
      const repo = new Repo(db, auth);
      const notifier = new Notifier();
      notifier.init(ctx);
      const reminders = new Reminders(db, auth);
      const sync = new SyncManager(repo, auth, db);
      sync.bindNotifier(notifier);
      const live = new LiveViewCtl();
      const ticker = new Ticker(repo, reminders, sync, notifier, new CardUpdater(repo, auth, live));
      AppHolder.live = live;
      const backup = new Backup(repo);
      backup.bind(ctx);
      AppHolder.backup = backup;
      AppHolder.db = db;
      AppHolder.auth = auth;
      AppHolder.repo = repo;
      AppHolder.notifier = notifier;
      AppHolder.reminders = reminders;
      AppHolder.sync = sync;
      AppHolder.ticker = ticker;
      // 启动即补算：杀进程/改系统时间后按持久化字段回到正确边界（§3.4）
      await ticker.start();
      AppHolder.ready = true;
      AppHolder.bootError = null;
    } catch (e) {
      AppHolder.bootError = `${e}`;
    }
  }
}
