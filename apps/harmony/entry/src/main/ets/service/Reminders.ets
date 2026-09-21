// 到点提醒（替代 Android 的 AlarmManager）。
// 鸿蒙长时任务没有 TIMER 模式（BackgroundMode 只有数据传输/音视频/位置/蓝牙/多设备/VOIP/任务保持），
// 因此后台到点不能靠"应用活着自己数秒"：改用系统 reminderAgent 定时提醒——由系统代发通知，
// 应用被杀也生效；应用回到前台时由 Repo.settleDue 按持久化字段补算边界（不自动连跳，§3.5）。
import { reminderAgentManager } from '@kit.BackgroundTasksKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import notification from '@ohos.notification';
import { TYPE_DATE, TYPE_PRECISE, isPomodoroConfig, numAt, parseConfig, strAt } from '../core/Contract';
import { parseRun } from '../core/Engine';
import { daysLeft, dDayFireMs } from '../core/Time';
import { LocalDb } from '../data/Db';
import { AuthStore } from '../data/AuthStore';
import { TimerItem } from '../data/Rows';

const TAG = 'TimeMarkReminders';
/** reminderAgent 单应用提醒数量有上限，且超远期的定时没有意义：只排 30 天内到点的 */
const MAX_REMINDERS: number = 16;
const MAX_HORIZON_SEC: number = 30 * 86400;

export class Reminders {
  private db: LocalDb;
  private auth: AuthStore;

  constructor(db: LocalDb, auth: AuthStore) {
    this.db = db;
    this.auth = auth;
  }

  /** 该计时下一次到点的墙钟时刻；正计时无到点 */
  async dueAt(t: TimerItem, now: number): Promise<number | null> {
    const cfg = parseConfig(t.config_json);
    if (t.type === TYPE_DATE) {
      const targetDate = strAt(cfg, 'target_date') ?? '';
      const tz = strAt(cfg, 'timezone_id') ?? '';
      const include = cfg !== null && cfg['include_today'] === true;
      // daysLeft 归零那天 00:00（按目标时区）——与 Android Alarms.dueAt 同口径。
      // 不能直接排目标日：include_today=true（可由 Android/Windows 同步过来）时那天还剩 1 天，
      // 通知会早发一天且内容写「还剩 1 天」，之后 reschedule 又因 sec<=0 不再排它
      return dDayFireMs(targetDate, tz, include);
    }
    if (t.run_state !== 'running') return null;
    const run = parseRun(t.run_json);
    if (isPomodoroConfig(t.type, cfg)) return run.phase_ends_at;
    if (t.type === TYPE_PRECISE) return run.target_at;
    return null;
  }

  /** 重排全部提醒：先清空再按最早到点排（幂等，每次结算/回前台后调用） */
  async reschedule(): Promise<void> {
    try {
      await reminderAgentManager.cancelAllReminders();
    } catch (e) {
      hilog.warn(0x0000, TAG, `清空旧提醒失败: ${e}`);
    }
    const now = Date.now();
    const items = await this.db.timers();
    const due: TimerItem[] = [];
    const times: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const at = await this.dueAt(items[i], now);
      if (at === null) continue;
      const sec = Math.floor((at - now) / 1000);
      if (sec <= 0 || sec > MAX_HORIZON_SEC) continue;
      let pos = times.length;
      for (let j = 0; j < times.length; j++) {
        if (at < times[j]) {
          pos = j;
          break;
        }
      }
      times.splice(pos, 0, at);
      due.splice(pos, 0, items[i]);
    }
    const keep = Math.min(due.length, MAX_REMINDERS);
    /** 本次实际发布成功的计时器 id：未发布（超出 MAX_REMINDERS 或 publishReminder 报错）的旧 reminderId 需从本地映射里清掉，
     *  否则会指向已被 cancelAllReminders 作废的提醒号，重启后无法取消（旧实现只按 due 列表保留，超出限额的 id 会永久残留在映射里） */
    const published: string[] = [];
    for (let i = 0; i < keep; i++) {
      const t = due[i];
      const at = times[i];
      const sec = Math.floor((at - now) / 1000);
      const req: reminderAgentManager.ReminderRequestTimer = {
        reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_TIMER,
        triggerTimeInSeconds: sec,
        title: t.name.length > 0 ? t.name : '计时结束',
        content: await this.bodyOf(t, now),
        slotType: notification.SlotType.SOCIAL_COMMUNICATION,
        ringDuration: 5,
        notificationId: 2000 + i,
        expiredContent: t.type === TYPE_DATE ? `${t.name} 已到目标日` : `${t.name} 已到点`
      };
      try {
        const id = await reminderAgentManager.publishReminder(req);
        this.auth.setReminderId(t.id, id);
        published.push(t.id);
      } catch (e) {
        hilog.warn(0x0000, TAG, `发布提醒失败(${t.name}): ${e}`);
      }
    }
    // 未发布的计时器（已结束/已超范围/超出限额/发布失败）清掉登记，避免残留无效提醒号
    const saved = this.auth.reminderIds();
    const keys = Object.keys(saved);
    for (let i = 0; i < keys.length; i++) {
      let kept = false;
      for (let j = 0; j < published.length; j++) {
        if (published[j] === keys[i]) { kept = true; break; }
      }
      if (!kept) this.auth.clearReminderId(keys[i]);
    }
  }

  private async bodyOf(t: TimerItem, now: number): Promise<string> {
    const cfg = parseConfig(t.config_json);
    if (t.type === TYPE_DATE) {
      const tz = strAt(cfg, 'timezone_id');
      // 用写入的 include_today，不能硬编码 false：否则提醒文案与列表页 dateText() 对不上
      const include = cfg !== null && cfg['include_today'] === true;
      const left = daysLeft(strAt(cfg, 'target_date') ?? '', tz, include, now);
      return left === null ? t.name : `${t.name} 还剩 ${left} 天`;
    }
    if (isPomodoroConfig(t.type, cfg)) {
      const run = parseRun(t.run_json);
      const upcoming = run.phase === 'break' || run.phase === 'long_break' ? '专注' : '休息';
      return `${t.name} 阶段到点，准备进入${upcoming}`;
    }
    return `${t.name} 时间到`;
  }
}

