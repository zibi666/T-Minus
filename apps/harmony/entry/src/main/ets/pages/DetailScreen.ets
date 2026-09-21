// 详情页（对齐 Android ui/DetailScreen.kt：环形进度 + 大数字读数 + 动作行 + 今日分段）。
import { common } from '@kit.AbilityKit';
import { AppHolder } from '../AppHolder';
import { T, alpha } from '../common/Theme';
import { CardModel, SegmentRow, cardOf, segmentRows } from '../common/Models';
import { Milestone } from '../data/Rows';
import { ActionButton, EmptyHint, TypeBadge } from '../common/Widgets';
import { PAGE_FORM, Route } from '../common/Route';
import { LOGICAL_POMODORO, TYPE_PRECISE, TYPE_STOPWATCH } from '../core/Contract';
import { clockOf, startOfToday } from '../core/Engine';

@Component
export struct DetailScreen {
  @Consume('nav') stack: NavPathStack;
  timerId: string = '';
  @State card: CardModel = new CardModel();
  @State remark: string = '';
  @State segments: SegmentRow[] = [];
  @State milestones: Milestone[] = [];
  @State msNote: string = '';
  @State tags: string[] = [];
  @State busy: string = '';

  private tickCb: () => void = () => {
    this.load();
  };

  async aboutToAppear(): Promise<void> {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
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
    if (repo === null || this.timerId.length === 0) return;
    const item = await repo.timerById(this.timerId);
    if (item === null) {
      this.stack.pop();
      return;
    }
    this.card = cardOf(item, Date.now(), null);
    this.remark = item.remark ?? '';
    this.segments = segmentRows(await repo.recordsOfTimerSince(this.timerId, startOfToday()));
    this.milestones = await repo.milestonesOf(this.timerId);
    this.tags = await repo.tagsOfTimer(this.timerId);
  }

  /** 里程碑只服务于普通倒计时与正计时（与 Windows FocusStage 同口径） */
  showsMilestones(): boolean {
    const l = this.card.logical;
    return l === TYPE_STOPWATCH || (l === TYPE_PRECISE && !this.card.isPomodoro);
  }

  private async act(what: string, fn: () => Promise<void>): Promise<void> {
    this.busy = what;
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
    Scroll() {
      Column({ space: T.SP_LG }) {
        Row() {
          Text('‹')
            .fontSize(T.font(28))
            .fontColor(T.TEXT_LOW)
            .padding({ left: 0, right: T.SP })
            .onClick(() => this.stack.pop())
          Text(this.card.name)
            .fontSize(T.font(18))
            .fontWeight(FontWeight.Medium)
            .fontColor(T.TEXT)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          Text('编辑')
            .fontSize(T.font(14))
            .fontColor(T.ACCENT)
            .onClick(() => {
              Route.argId = this.timerId;
              this.stack.pushPath(new NavPathInfo(PAGE_FORM, undefined));
            })
        }
        .width('100%')
        .padding({ top: T.SP })

        Column({ space: T.SP }) {
          Stack({ alignContent: Alignment.Center }) {
            Progress({ value: Math.min(100, this.card.progress * 100), total: 100, type: ProgressType.Ring })
              .color(this.card.color)
              .backgroundColor(alpha(T.STROKE, 0.7))
              .width(230)
              .height(230)
              .style({ strokeWidth: 14 })
            Column({ space: 4 }) {
              Text(this.card.primary)
                .fontSize(T.font(40))
                .fontWeight(FontWeight.Bold)
                .fontColor(T.TEXT)
              Row({ space: T.SP_SM }) {
                TypeBadge({ logical: this.card.logical })
              }
              Text(this.card.secondary)
                .fontSize(T.font(12))
                .fontColor(T.TEXT_LOW)
            }
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Center)
        .padding({ top: T.SP_LG, bottom: T.SP_LG })

        if (this.card.runnable) {
          Row({ space: T.SP_SM }) {
            if (this.card.runState === 'running') {
              ActionButton({ label: '暂停', kind: 'ghost', busy: this.busy === 'pause', onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act('pause', () => repo.pause(this.timerId));
              } })
              ActionButton({ label: this.card.logical === LOGICAL_POMODORO ? '跳过' : '分段', kind: 'ghost',
                busy: this.busy === 'seg', onTap: () => {
                  const repo = AppHolder.repo;
                  if (repo === null) return;
                  this.act('seg', () => this.card.logical === LOGICAL_POMODORO
                    ? repo.skipPhase(this.timerId) : repo.segment(this.timerId));
                } })
              ActionButton({ label: '结束', kind: 'danger', busy: this.busy === 'stop', onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act('stop', () => repo.stop(this.timerId));
              } })
            } else if (this.card.runState === 'paused') {
              ActionButton({ label: '继续', kind: 'primary', busy: this.busy === 'resume', onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act('resume', () => repo.resume(this.timerId));
              } })
              // 引擎 segment() 放行 paused：暂停后仍可给已进行的时段打点
              if (this.card.logical !== LOGICAL_POMODORO) {
                ActionButton({ label: '分段', kind: 'ghost', busy: this.busy === 'seg', onTap: () => {
                  const repo = AppHolder.repo;
                  if (repo === null) return;
                  this.act('seg', () => repo.segment(this.timerId));
                } })
              }
              ActionButton({ label: '归零', kind: 'ghost', busy: this.busy === 'reset', onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act('reset', () => repo.reset(this.timerId));
              } })
            } else {
              ActionButton({ label: '开始', kind: 'primary', busy: this.busy === 'start', onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act('start', () => repo.start(this.timerId));
              } })
              ActionButton({ label: '归零', kind: 'ghost', busy: this.busy === 'reset', onTap: () => {
                const repo = AppHolder.repo;
                if (repo !== null) this.act('reset', () => repo.reset(this.timerId));
              } })
            }
          }
          .width('100%')
        }

        if (this.remark.length > 0) {
          Text(this.remark)
            .fontSize(T.font(13))
            .fontColor(T.TEXT_LOW)
            .width('100%')
            .padding(T.SP)
            .borderRadius(T.R_SMALL)
            .backgroundColor(alpha(T.CARD, 0.7))
        }

        if (this.tags.length > 0) {
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.tags, (g: string) => {
              Text(g)
                .fontSize(T.font(11))
                .fontColor(T.TEXT_LOW)
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .borderRadius(T.R_PILL)
                .backgroundColor(alpha(T.CARD_HI, 0.85))
                .border({ width: 1, color: T.STROKE })
                .margin({ right: 6, bottom: 4 })
            }, (g: string) => g)
          }
          .width('100%')
        }

        if (this.showsMilestones()) {
          Column({ space: T.SP_SM }) {
            Row() {
              Text(`里程碑 · ${this.milestones.length}`)
                .fontSize(T.font(14))
                .fontColor(T.TEXT)
              Blank()
            }
            .width('100%')

            if (this.card.runState === 'running' || this.card.runState === 'paused') {
              Row({ space: T.SP_SM }) {
                TextInput({ placeholder: '备注（如：完成第一章）', text: this.msNote })
                  .fontSize(T.font(13))
                  .fontColor(T.TEXT)
                  .placeholderColor(T.TEXT_LOW)
                  .backgroundColor(T.CARD)
                  .borderRadius(T.R_SMALL)
                  .border({ width: 1, color: T.STROKE })
                  .height(40)
                  .layoutWeight(1)
                  .onChange((v: string) => this.msNote = v)
                ActionButton({ label: '标记此刻', kind: 'primary', busy: this.busy === 'ms', onTap: () => {
                  const repo = AppHolder.repo;
                  if (repo === null) return;
                  const note = this.msNote;
                  this.msNote = '';
                  this.act('ms', async () => {
                    await repo.addMilestone(this.timerId, note);
                  });
                } })
              }
              .width('100%')
            }

            if (this.milestones.length === 0) {
              Text('计时中点「标记此刻」记录重要节点')
                .fontSize(T.font(12))
                .fontColor(T.TEXT_LOW)
                .width('100%')
            } else {
              ForEach(this.milestones, (m: Milestone) => {
                Row({ space: T.SP_SM }) {
                  Text(m.note.length === 0 ? '（无备注）' : m.note)
                    .fontSize(T.font(13))
                    .fontColor(m.note.length === 0 ? T.TEXT_LOW : T.TEXT)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .layoutWeight(1)
                  Text(clockOf(m.marked_at))
                    .fontSize(T.font(12))
                    .fontColor(T.TEXT_LOW)
                  Text('×')
                    .fontSize(T.font(16))
                    .fontColor(T.DANGER)
                    .padding({ left: 6, right: 2 })
                    .onClick(() => {
                      const repo = AppHolder.repo;
                      if (repo === null) return;
                      this.act('msdel', async () => {
                        await repo.deleteMilestone(m.id);
                      });
                    })
                }
                .width('100%')
                .padding({ top: 5, bottom: 5 })
              }, (m: Milestone) => `${m.id}:${m.marked_at}`)
            }
          }
          .width('100%')
        }

        Column({ space: T.SP_SM }) {
          Text('今日分段')
            .fontSize(T.font(14))
            .fontColor(T.TEXT)
            .width('100%')
          if (this.segments.length === 0) {
            EmptyHint({ text: '今天还没有记录' })
          } else {
            ForEach(this.segments, (s: SegmentRow) => {
              Row({ space: T.SP_SM }) {
                Text(s.time)
                  .fontSize(T.font(12))
                  .fontColor(T.TEXT_LOW)
                  .width(52)
                Text(s.label)
                  .fontSize(T.font(12))
                  .fontColor(this.card.color)
                  .layoutWeight(1)
                Text(s.duration)
                  .fontSize(T.font(13))
                  .fontColor(T.TEXT)
              }
              .width('100%')
              .padding({ top: 6, bottom: 6 })
            }, (s: SegmentRow) => s.id)
          }
        }
        .width('100%')

        Row() {
          Blank()
          Text('删除此计时')
            .fontSize(T.font(14))
            .fontColor(T.DANGER)
            .padding(T.SP_SM)
            .onClick(() => {
              const repo = AppHolder.repo;
              if (repo === null) return;
              this.act('delete', async () => {
                await repo.deleteTimer(this.timerId);
              });
              this.stack.pop();
            })
        }
        .width('100%')
      }
      .width('100%')
      .padding({ left: T.SP, right: T.SP, bottom: T.SP_LG })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(T.BG)
    .scrollBar(BarState.Auto)
  }
}
