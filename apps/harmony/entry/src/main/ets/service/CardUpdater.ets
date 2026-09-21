// 外部表面同步（桌面服务卡片 + 实况窗）：把"最该被看见的那个计时"缓存进偏好并推给卡片与实况窗。
// 由 Ticker 在每次结算/用户操作后调用，卡片与实况窗读数因此与应用内同源（同一套 Engine 计算）。
import { formBindingData, formProvider } from '@kit.FormKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Repo } from '../data/Repo';
import { AuthStore } from '../data/AuthStore';
import { TimerItem } from '../data/Rows';
import { RUN_PAUSED, RUN_RUNNING } from '../core/Contract';
import { CardSnapshot, readFormIds, snapshotJson } from '../common/CardSnapshot';
import { cardOf } from '../common/Models';
import { LiveViewCtl } from './LiveView';

const TAG = 'TimeMarkCard';

export class CardUpdater {
  private repo: Repo;
  private auth: AuthStore;
  private live: LiveViewCtl | null;
  private lastJson: string = '';

  constructor(repo: Repo, auth: AuthStore, live: LiveViewCtl | null) {
    this.repo = repo;
    this.auth = auth;
    this.live = live;
  }

  async refresh(): Promise<void> {
    const items: TimerItem[] = await this.repo.timers();
    const now = Date.now();
    let chosen: TimerItem | null = null;
    let runningCount = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.run_state === RUN_RUNNING) {
        runningCount++;
        if (chosen === null) chosen = it;
      }
    }
    if (chosen === null) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].run_state === RUN_PAUSED) { chosen = items[i]; break; }
      }
    }
    if (chosen === null) chosen = items.length > 0 ? items[0] : null;

    const s = new CardSnapshot();
    let remaining = 0;
    if (chosen === null) {
      s.sub = '还没有计时器';
    } else {
      const m = cardOf(chosen, now, null);
      s.title = m.name;
      s.reading = m.primary;
      s.sub = runningCount > 1 ? `${m.secondary} · 另有 ${runningCount - 1} 个在跑` : m.secondary;
      s.color = m.color;
      s.running = chosen.run_state === RUN_RUNNING;
      remaining = m.remainingMs;
    }
    const json = snapshotJson(s);
    // 读数没变就不推卡片，省掉每秒一次的 IPC
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.auth.setCardSnapshot(json);
      const forms = readFormIds(this.auth.prefs());
      if (forms.length > 0) {
        const binding = formBindingData.createFormBindingData(this.toRecord(s));
        for (let i = 0; i < forms.length; i++) {
          try {
            await formProvider.updateForm(forms[i].id, binding);
          } catch (e) {
            hilog.warn(0x0000, TAG, `卡片刷新失败(${forms[i].id}): ${e}`);
          }
        }
      }
    }
    if (this.live !== null) await this.live.sync(s, remaining);
  }

  private toRecord(s: CardSnapshot): Record<string, Object> {
    const o: Record<string, Object> = {};
    o['title'] = s.title as Object;
    o['reading'] = s.reading as Object;
    o['sub'] = s.sub as Object;
    o['color'] = s.color as Object;
    o['running'] = s.running as Object;
    return o;
  }
}
