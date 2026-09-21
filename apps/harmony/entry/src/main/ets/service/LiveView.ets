// 实况窗（Live View）接入：运行中的计时在胶囊/锁屏上持续读秒。
// 前置：liveViewManager 属 @kit.LiveViewKit（HMS），TIMER 场景需在 AGC 申请权益并通过审核；
// 未过审或设备不支持时 startLiveView 会返回非 0 resultCode——这里静默降级为
// 「reminderAgent 到点通知 + 桌面卡片」，不把失败抛成用户可见的错误（见 M4 计划 §3.4）。
import { liveViewManager } from '@kit.LiveViewKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CardSnapshot } from '../common/CardSnapshot';

const TAG = 'TimeMarkLiveView';
const LIVE_VIEW_ID: number = 1001;
const EVENT_START: string = 'start';
const EVENT_UPDATE: string = 'update';
const EVENT_END: string = 'end';

export class LiveViewCtl {
  private shown: boolean = false;
  /** 权益未开通/设备不支持：一次失败后不再反复打扰系统 */
  private unavailable: boolean = false;
  private sequence: number = 0;

  async sync(s: CardSnapshot, remainingMs: number): Promise<void> {
    if (!s.running) {
      if (this.shown) await this.end();
      return;
    }
    if (this.unavailable) return;
    try {
      if (!this.shown) {
        const enabled = await liveViewManager.isLiveViewEnabled();
        if (!enabled) {
          this.unavailable = true;
          return;
        }
      }
      this.sequence++;
      const view = this.build(s, remainingMs, this.shown ? EVENT_UPDATE : EVENT_START);
      const res = await (this.shown ? liveViewManager.updateLiveView(view) : liveViewManager.startLiveView(view));
      if (res.resultCode !== 0) {
        hilog.warn(0x0000, TAG, `实况窗未生效(${res.resultCode})：${res.message}，按降级路径继续`);
        this.unavailable = true;
        this.shown = false;
        return;
      }
      this.shown = true;
    } catch (e) {
      hilog.warn(0x0000, TAG, `实况窗调用失败，降级: ${e}`);
      this.unavailable = true;
      this.shown = false;
    }
  }

  private build(s: CardSnapshot, remainingMs: number, event: string): liveViewManager.LiveView {
    const rich: liveViewManager.RichText[] = [{ text: s.sub }];
    const primary: liveViewManager.PrimaryData = {
      title: s.title,
      content: rich,
      keepTime: 3 * 60 * 1000
    };
    const capsule: liveViewManager.TimerCapsule = {
      type: liveViewManager.CapsuleType.CAPSULE_TYPE_TIMER,
      status: 1,
      content: s.reading,
      time: Math.max(0, Math.round(remainingMs)),
      isCountdown: true,
      isPaused: false
    };
    const data: liveViewManager.LiveViewData = { primary: primary, capsule: capsule };
    const timer: liveViewManager.LiveViewTimer = {
      time: Math.max(0, Math.round(remainingMs)),
      isCountdown: true,
      isPaused: false
    };
    const view: liveViewManager.LiveView = {
      id: LIVE_VIEW_ID,
      event: event,
      sequence: this.sequence,
      timer: timer,
      liveViewData: data
    };
    return view;
  }

  async end(): Promise<void> {
    if (!this.shown) return;
    this.sequence++;
    try {
      const rich: liveViewManager.RichText[] = [{ text: '已结束' }];
      const primary: liveViewManager.PrimaryData = { title: 'TimeMark', content: rich, keepTime: 5000 };
      const view: liveViewManager.LiveView = {
        id: LIVE_VIEW_ID,
        event: EVENT_END,
        sequence: this.sequence,
        liveViewData: { primary: primary }
      };
      await liveViewManager.stopLiveView(view);
    } catch (e) {
      hilog.warn(0x0000, TAG, `结束实况窗失败: ${e}`);
    }
    this.shown = false;
  }
}
