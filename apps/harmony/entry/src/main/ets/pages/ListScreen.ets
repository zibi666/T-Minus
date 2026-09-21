// 列表页（对齐 Android ui/ListScreen.kt 的信息结构：标题行 + 四统计 + 钟卡片列表 + 新建 FAB）。
import { common } from '@kit.AbilityKit';
import { AppHolder } from '../AppHolder';
import { T, alpha } from '../common/Theme';
import { CardModel, cardsOf } from '../common/Models';
import { ActionButton, Chip, ColorDot, EmptyHint, TypeBadge } from '../common/Widgets';
import { PAGE_DETAIL, PAGE_FORM, PAGE_HISTORY, PAGE_LOGIN, Route } from '../common/Route';
import { DayStat } from '../data/Repo';
import { humanMin } from '../core/Engine';
import { LOGICAL_POMODORO } from '../core/Contract';

@Component
export struct ListScreen {
  @Consume('nav') stack: NavPathStack;
  @State cards: CardModel[] = [];
  @State tagNames: string[] = [];
  @State tagFilter: string = '';
  @State todayFocus: string = '0分';
  @State todayRounds: string = '0';
  @State todayMarks: string = '0';
  @State streak: string = '0';
  @State userLabel: string = '登录';
  @State queued: number = 0;
  @State syncNote: string = '';
  @State busy: string = '';
  @State bootError: string = '';

  private tickCb: () => void = () => {
    this.load();
  };

  async aboutToAppear(): Promise<void> {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    // 必须等装配完成再订阅：boot() 未完成时 ticker 仍是 null，订阅会静默失败导致列表不再走时
    await AppHolder.boot(ctx);
    const t = AppHolder.ticker;
    if (t !== null) t.subscribe(this.tickCb);
    this.load();
  }

  aboutToDisappear(): void {
    const t = AppHolder.ticker;
    if (t !== null) t.unsubscribe(this.tickCb);
  }

  async load(): Promise<void> {
    const repo = AppHolder.repo;
    const auth = AppHolder.auth;
    const db = AppHolder.db;
    if (repo === null || auth === null) {
      this.bootError = AppHolder.bootError ?? '';
      return;
    }
    const tagMap = await repo.tagsByTimer();
    this.tagNames = await repo.tagNames();
    const all = cardsOf(await repo.timers(), Date.now(), tagMap);
    if (this.tagFilter.length === 0) {
      this.cards = all;
    } else {
      const filtered: CardModel[] = [];
      for (let i = 0; i < all.length; i++) {
        if (all[i].tags.indexOf(this.tagFilter) >= 0) filtered.push(all[i]);
      }
      this.cards = filtered;
    }
    const stats: DayStat[] = await repo.dailyStats();
    const todayKey = keyOf(Date.now());
    let focus = 0;
    let rounds = 0;
    let marks = 0;
    const days = new Map<string, DayStat>();
    for (let i = 0; i < stats.length; i++) {
      days.set(stats[i].day, stats[i]);
      if (stats[i].day === todayKey) {
        focus = stats[i].focusMs;
        rounds = stats[i].rounds;
        marks = stats[i].marks;
      }
    }
    this.todayFocus = humanMin(focus);
    this.todayRounds = `${rounds}`;
    this.todayMarks = `${marks}`;
    this.streak = `${streakOf(days, new Date())}`;
    const uname = auth.username();
    this.userLabel = uname === null ? '登录' : uname;
    this.queued = db === null ? 0 : await db.queuedCount();
    const sync = AppHolder.sync;
    this.syncNote = sync === null ? '' : (sync.lastError ?? '');
    this.bootError = '';
  }

  private async act(id: string, what: string, fn: () => Promise<void>): Promise<void> {
    this.busy = `${what}:${id}`;
    try {
      await fn();
    } finally {
      this.busy = '';
      const t = AppHolder.ticker;
      if (t !== null) await t.poke();
      await this.load();
    }
  }

  build() {
    Stack({ alignContent: Alignment.BottomEnd }) {
      Column({ space: T.SP }) {
        Row() {
          Text('TimeMark')
            .fontSize(T.font(22))
            .fontWeight(FontWeight.Bold)
            .fontColor(T.TEXT)
          Blank()
          Chip({ label: '历史', onTap: () => {
            this.stack.pushPath(new NavPathInfo(PAGE_HISTORY, undefined));
          } })
          Blank().width(T.SP_SM)
          Chip({ label: this.userLabel, onTap: () => {
            this.stack.pushPath(new NavPathInfo(PAGE_LOGIN, undefined));
          } })
        }
        .width('100%')

        Row() {
          StatCell({ value: this.todayFocus, label: '今日专注' })
          StatCell({ value: this.todayRounds, label: '完成轮次' })
          StatCell({ value: this.todayMarks, label: '累计打点' })
          StatCell({ value: this.streak, label: '连续记录' })
        }
        .width('100%')

        if (this.tagNames.length > 0) {
          Scroll() {
            Row({ space: T.SP_SM }) {
              ForEach(this.tagNames, (g: string) => {
                Chip({ label: this.tagFilter === g ? `取消「${g}」` : `筛选「${g}」`, selected: this.tagFilter === g,
                  onTap: () => {
                    this.tagFilter = this.tagFilter === g ? '' : g;
                    this.load();
                  } })
              }, (g: string) => g)
            }
          }
          .scrollable(ScrollDirection.Horizontal)
          .scrollBar(BarState.Off)
          .width('100%')
        }

        if (this.bootError.length > 0) {
          Text(`初始化失败：${this.bootError}`)
            .fontSize(T.font(13))
            .fontColor(T.DANGER)
            .width('100%')
        }
        if (this.syncNote.length > 0) {
          Text(`同步异常：${this.syncNote}`)
            .fontSize(T.font(12))
            .fontColor(T.TEXT_LOW)
            .width('100%')
        }

        if (this.cards.length === 0) {
          Column() {
            EmptyHint({ text: '还没有计时器，点右下角加一个' })
          }
          .layoutWeight(1)
        } else {
          List({ space: T.SP_SM }) {
            ForEach(this.cards, (c: CardModel) => {
              ListItem() {
                this.card(c)
              }
            }, (c: CardModel) => `${c.id}:${c.runState}:${c.primary}:${c.progress.toFixed(1)}`)
          }
          .scrollBar(BarState.Auto)
          .edgeEffect(EdgeEffect.Spring)
          .layoutWeight(1)
        }

        Row({ space: T.SP_SM }) {
          Text(this.queued > 0 ? `${this.queued} 条待同步` : '本地已同步')
            .fontSize(T.font(11))
            .fontColor(T.TEXT_LOW)
          Blank()
        }
        .width('100%')
        .padding({ bottom: T.SP_SM })
      }
      .width('100%')
      .height('100%')
      .padding({ left: T.SP, right: T.SP, top: T.SP_LG, bottom: T.SP_LG })

      Button('+', { type: ButtonType.Circle })
        .width(56)
        .height(56)
        .fontSize(28)
        .fontColor(T.BG)
        .backgroundColor(T.ACCENT)
        .margin(T.SP_LG)
        .onClick(() => {
          Route.argId = '';
          this.stack.pushPath(new NavPathInfo(PAGE_FORM, undefined));
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(T.BG)
  }

  @Builder
  card(c: CardModel) {
    Column({ space: T.SP_SM }) {
      Row({ space: T.SP_SM }) {
        ColorDot({ color: c.color, dotSize: 10 })
        Text(c.name)
          .fontSize(T.font(16))
          .fontWeight(FontWeight.Medium)
          .fontColor(T.TEXT)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        Text(c.pinned ? '⊙' : '○')
          .fontSize(T.font(16))
          .fontColor(c.pinned ? T.ACCENT : T.TEXT_LOW)
          .margin({ right: T.SP_SM })
          .onClick(() => {
            const repo = AppHolder.repo;
            if (repo !== null) this.act(c.id, 'pin', () => repo.togglePin(c.id));
          })
        Text(c.starred ? '★' : '☆')
          .fontSize(T.font(16))
          .fontColor(c.starred ? T.ACCENT : T.TEXT_LOW)
          .onClick(() => {
            const repo = AppHolder.repo;
            if (repo !== null) this.act(c.id, 'star', () => repo.toggleStar(c.id));
          })
      }
      .width('100%')

      Row({ space: T.SP_SM }) {
        Text(c.primary)
          .fontSize(T.font(26))
          .fontWeight(FontWeight.Bold)
          .fontColor(c.runState === 'running' ? c.color : T.TEXT)
          .fontFamily('HarmonyOS Sans')
        Column({ space: 2 }) {
          TypeBadge({ logical: c.logical })
          Text(c.secondary)
            .fontSize(T.font(11))
            .fontColor(T.TEXT_LOW)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Text('›')
          .fontSize(T.font(20))
          .fontColor(T.TEXT_LOW)
      }
      .width('100%')
      .onClick(() => {
        Route.argId = c.id;
        this.stack.pushPath(new NavPathInfo(PAGE_DETAIL, undefined));
      })

      if (c.tags.length > 0) {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(c.tags, (g: string) => {
            Text(g)
              .fontSize(T.font(10))
              .fontColor(T.TEXT_LOW)
              .padding({ left: 7, right: 7, top: 2, bottom: 2 })
              .borderRadius(T.R_PILL)
              .backgroundColor(alpha(T.CARD_HI, 0.8))
              .border({ width: 1, color: T.STROKE })
              .margin({ right: 6, bottom: 4 })
          }, (g: string) => g)
        }
        .width('100%')
      }

      if (c.runnable && c.progress > 0) {
        Progress({ value: Math.min(100, c.progress * 100), total: 100 })
          .color(c.color)
          .backgroundColor(alpha(T.STROKE, 0.6))
          .height(4)
          .width('100%')
      }

      if (c.runnable) {
        Row({ space: T.SP_SM }) {
          if (c.runState === 'running') {
            ActionButton({
              label: '暂停', kind: 'ghost', busy: this.busy === `pause:${c.id}`,
              onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act(c.id, 'pause', () => repo.pause(c.id));
              }
            })
            ActionButton({
              label: c.logical === LOGICAL_POMODORO ? '跳过' : '分段', kind: 'ghost',
              busy: this.busy === `seg:${c.id}`,
              onTap: () => {
                const repo = AppHolder.repo;
                if (repo === null) return;
                this.act(c.id, 'seg', () => c.logical === LOGICAL_POMODORO ? repo.skipPhase(c.id) : repo.segment(c.id));
              }
            })
            ActionButton({
              label: '结束', kind: 'danger', busy: this.busy === `stop:${c.id}`,
              onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act(c.id, 'stop', () => repo.stop(c.id));
              }
            })
          } else if (c.runState === 'paused') {
            ActionButton({
              label: '继续', kind: 'primary', busy: this.busy === `resume:${c.id}`,
              onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act(c.id, 'resume', () => repo.resume(c.id));
              }
            })
            ActionButton({
              label: '结束', kind: 'danger', busy: this.busy === `stop:${c.id}`,
              onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act(c.id, 'stop', () => repo.stop(c.id));
              }
            })
          } else {
            ActionButton({
              label: '开始', kind: 'primary', busy: this.busy === `start:${c.id}`,
              onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act(c.id, 'start', () => repo.start(c.id));
              }
            })
            ActionButton({
              label: '编辑', kind: 'ghost', busy: false,
              onTap: () => {
                Route.argId = c.id;
                this.stack.pushPath(new NavPathInfo(PAGE_FORM, undefined));
              }
            })
          }
        }
        .width('100%')
      }
    }
    .width('100%')
    .padding(T.SP)
    .borderRadius(T.R_CARD)
    .backgroundColor(c.runState === 'running' ? T.CARD_HI : T.CARD)
    .border({ width: 1, color: c.runState === 'running' ? alpha(c.color, 0.5) : T.STROKE })
  }
}

@Component
struct StatCell {
  @Prop value: string;
  @Prop label: string;

  build() {
    Column({ space: 2 }) {
      Text(this.value)
        .fontSize(T.font(17))
        .fontWeight(FontWeight.Medium)
        .fontColor(T.TEXT)
        .maxLines(1)
      Text(this.label)
        .fontSize(T.font(11))
        .fontColor(T.TEXT_LOW)
    }
    .alignItems(HorizontalAlign.Start)
    .layoutWeight(1)
  }
}

function keyOf(ms: number): string {
  const d = new Date(ms);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? `0${m}` : m}-${day < 10 ? `0${day}` : day}`;
}

/** 连续记录天数：从今天往回数，缺失即断 */
function streakOf(days: Map<string, DayStat>, from: Date): number {
  let n = 0;
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12, 0, 0, 0);
  // 今天还没记录时不打断连续性：从昨天起算
  if (!days.has(keyOf(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(keyOf(cursor.getTime()))) {
    const s = days.get(keyOf(cursor.getTime()));
    if (s === undefined || (s.focusMs === 0 && s.rounds === 0 && s.marks === 0)) break;
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}
