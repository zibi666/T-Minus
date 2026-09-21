// 到点通知（与 Android service/Notifier.kt 同一套文案）。
// 两类槽位：运行中常驻用低打扰、到点/阶段推进用高打扰（会响铃振动）。
import { notificationManager } from '@kit.NotificationKit';
import notification from '@ohos.notification';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { phaseLabel } from '../core/Engine';

const TAG = 'TimeMarkNotifier';
/** 到点/阶段推进通知号的高位区起点：running 常驻用低位区（1001），Reminders 的系统提醒号在 2000 段，
 *  哈希区整体避开这两段 */
const ALARM_ID_BASE: number = 100000;
/** 高位区跨度：timerId 哈希对它取模，几十个计时同刻到点撞号的概率可忽略 */
const ALARM_ID_SPAN: number = 90000;

export class Notifier {
  private ctx: common.UIAbilityContext | null = null;
  private enabled: boolean = false;
  /** 通知号段：running 用低位区，到点提醒按 timerId 哈希到高位区 */
  static readonly RUNNING_ID: number = 1001;

  /** 到点/阶段推进通知号：timerId 的 FNV-1a 稳定哈希映射到高位区——
   *  两个计时同刻到点各用各的号，不再互相覆盖；发布与取消路径必须都经本函数取号才能对上 */
  static alarmId(timerId: string): number {
    let h: number = 0x811c9dc5;
    for (let i = 0; i < timerId.length; i++) {
      h = h ^ (timerId.charCodeAt(i) & 0xff);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ALARM_ID_BASE + (h % ALARM_ID_SPAN);
  }

  init(ctx: common.UIAbilityContext): void {
    this.ctx = ctx;
  }

  async ensureEnabled(): Promise<boolean> {
    try {
      this.enabled = await notificationManager.isNotificationEnabled();
      if (!this.enabled && this.ctx !== null) {
        try {
          await notificationManager.requestEnableNotification(this.ctx);
        } catch (e) {
          // 用户拒绝或已开启：以下一次查询结果为准
          hilog.info(0x0000, TAG, `通知授权请求未通过: ${e}`);
        }
        this.enabled = await notificationManager.isNotificationEnabled();
      }
    } catch (e) {
      hilog.warn(0x0000, TAG, `通知授权检查失败: ${e}`);
      this.enabled = false;
    }
    return this.enabled;
  }

  private async post(id: number, title: string, text: string, high: boolean): Promise<void> {
    if (!this.enabled) return;
    try {
      const req: notificationManager.NotificationRequest = {
        id: id,
        content: {
          normal: { title: title, text: text, additionalText: '' },
          contentType: notification.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT
        },
        notificationSlotType: high ? notificationManager.SlotType.SOCIAL_COMMUNICATION
          : notificationManager.SlotType.CONTENT_INFORMATION
      };
      await notificationManager.publish(req);
    } catch (e) {
      hilog.warn(0x0000, TAG, `通知发布失败: ${e}`);
    }
  }

  /** 到点：精确倒计时结束 */
  async fired(timerId: string, timerName: string): Promise<void> {
    await this.post(Notifier.alarmId(timerId), '时间到', `${timerName} 已到点`, true);
  }

  /** 番茄钟阶段推进：专注↔休息 */
  async phaseAdvanced(timerId: string, timerName: string, nextPhase: string | null, round: number): Promise<void> {
    const label = phaseLabel(nextPhase);
    await this.post(Notifier.alarmId(timerId), `${timerName} · 第 ${round} 轮`,
      nextPhase === 'focus' ? '休息结束，开始下一轮专注' : `专注完成，进入${label}`, true);
  }

  /** 日期倒计时 D-Day（目标日 00:00 提醒） */
  async dateMarked(timerId: string, timerName: string, daysLeft: number): Promise<void> {
    const text = daysLeft === 0 ? `就是今天：${timerName}` : `距 ${timerName} 还有 ${daysLeft} 天`;
    await this.post(Notifier.alarmId(timerId), '日期倒计时', text, true);
  }

  async cancelRunning(): Promise<void> {
    try {
      await notificationManager.cancel(Notifier.RUNNING_ID);
    } catch (e) {
      hilog.warn(0x0000, TAG, `取消常驻通知失败: ${e}`);
    }
  }
}
