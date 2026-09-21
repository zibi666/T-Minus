// 秒级驱动：前台时自己数秒（读数全部由持久化字段现算，不累加），到点交给 Repo 结算；
// 后台/被杀时靠 Reminders 的 system reminderAgent 发通知。与 Windows 主进程 broadcastTick、
// Android TimerService 的 1s 循环同一职责。
import { Repo, Settled } from '../data/Repo';
import { Reminders } from './Reminders';
import { Notifier } from './Notifier';
import { SyncManager } from '../sync/SyncManager';
import { CardUpdater } from './CardUpdater';
import { parseRun } from '../core/Engine';

/** 每 N 拍做一次同步（30s 一次，避免每条操作都打服务端） */
const SYNC_EVERY_BEATS: number = 30;
/** 每 N 拍刷一次桌面卡片（卡片更新受系统限频，秒推没意义） */
const CARD_EVERY_BEATS: number = 5;

export class Ticker {
  private repo: Repo;
  private reminders: Reminders;
  private sync: SyncManager;
  private notifier: Notifier;
  private cards: CardUpdater | null = null;
  private handle: number = -1;
  private listeners: Array<() => void> = [];
  private busy: boolean = false;
  private beats: number = 0;
  /** 提醒重排节流标记：poke/start 或刚发生结算时才真的 cancelAll+重发，稳态秒拍不重排 */
  private remindersDirty: boolean = false;
  /** UI 用它判断是否需要重取数据；每次写库后自增 */
  generation: number = 0;

  constructor(repo: Repo, reminders: Reminders, sync: SyncManager, notifier: Notifier, cards: CardUpdater | null) {
    this.repo = repo;
    this.reminders = reminders;
    this.sync = sync;
    this.notifier = notifier;
    this.cards = cards;
  }

  async start(): Promise<void> {
    await this.notifier.ensureEnabled();
    this.remindersDirty = true; // 开机补算后必须重排一次，恢复闹钟链（M4 §3.2）
    await this.settleAndAnnounce();
    if (this.handle < 0) {
      this.handle = setInterval(() => {
        this.beat();
      }, 1000);
    }
  }

  stop(): void {
    if (this.handle >= 0) {
      clearInterval(this.handle);
      this.handle = -1;
    }
  }

  subscribe(fn: () => void): void {
    this.listeners.push(fn);
  }

  unsubscribe(fn: () => void): void {
    const out: Array<() => void> = [];
    for (let i = 0; i < this.listeners.length; i++) {
      if (this.listeners[i] !== fn) out.push(this.listeners[i]);
    }
    this.listeners = out;
  }

  private emit(): void {
    this.generation++;
    for (let i = 0; i < this.listeners.length; i++) {
      try {
        this.listeners[i]();
      } catch (e) {
        // 单个页面回调异常不影响其它订阅者
      }
    }
  }

  /** 供页面操作后主动唤醒一次刷新与提醒重排 */
  async poke(): Promise<void> {
    this.remindersDirty = true; // 启动/继续/结束/删除多半没有新结算，但新到点要排上、旧提醒要取消
    await this.settleAndAnnounce();
    if (this.cards !== null) await this.cards.refresh();
    this.emit();
  }

  private async beat(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.settleAndAnnounce();
      this.beats++;
      if (this.beats % SYNC_EVERY_BEATS === 0) {
        this.sync.syncNow();
      }
      if (this.beats % CARD_EVERY_BEATS === 0 && this.cards !== null) {
        this.cards.refresh();
      }
      this.emit();
    } finally {
      this.busy = false;
    }
  }

  /** 补算过期边界 → 发通知 → 重排提醒（幂等，可被任意入口调用） */
  private async settleAndAnnounce(): Promise<void> {
    const settled: Settled[] = await this.repo.settleDue();
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.kind === 'PRECISE') {
        await this.notifier.fired(s.timer.id, s.timer.name);
      } else {
        const run = parseRun(s.timer.run_json);
        const round = s.phase === 'focus' ? run.completed_focus + 1 : run.completed_focus;
        await this.notifier.phaseAdvanced(s.timer.id, s.timer.name, s.phase, round);
      }
    }
    // 重排只在「有结算 / poke / start」时执行（Reminders.reschedule 先 cancelAll 再发布，本身幂等）：
    // reschedule 是 cancelAllReminders + 逐条 publishReminder 的重操作，若每秒稳态拍都跑，
    // 限频窗口内「先清空、发布失败」会让提醒全丢，白耗电。节流后新到点排得上（结算拍必触发）、
    // 已结束计时的旧提醒取消得掉（poke 置 dirty）
    if (settled.length > 0 || this.remindersDirty) {
      this.remindersDirty = false;
      await this.reminders.reschedule();
    }
  }
}
