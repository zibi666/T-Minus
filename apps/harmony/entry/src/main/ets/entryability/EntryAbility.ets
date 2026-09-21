import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppHolder } from '../AppHolder';

const TAG = 'TimeMarkAbility';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 装配失败不阻塞窗口创建：页面会显示 bootError，避免白屏无从排查
    AppHolder.boot(this.context);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, TAG, `页面加载失败: ${err.code}`);
        return;
      }
      hilog.info(0x0000, TAG, '页面已加载');
    });
  }

  onForeground(): void {
    // 回到前台：补算过期边界 + 立刻同步一次（多端收敛）
    const t = AppHolder.ticker;
    if (t !== null) {
      t.poke();
    }
    const s = AppHolder.sync;
    if (s !== null) {
      s.syncNow();
    }
  }

  onBackground(): void {
    // 数秒交给系统提醒：进程被回收也不影响下一次到点通知
    const r = AppHolder.reminders;
    if (r !== null) {
      r.reschedule();
    }
  }

  onDestroy(): void {
    const t = AppHolder.ticker;
    if (t !== null) {
      t.stop();
    }
  }
}
