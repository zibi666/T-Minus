// 历史页（对齐 Android ui/HistoryScreen.kt：区间切换 + 色点筛选 + 按日分组 + 点击删除记录）。
// 每日合计与统计口径共用 Contract.contribute，本端不做第二套判断。
import { common } from '@kit.AbilityKit';
import { AppHolder } from '../AppHolder';
import { T, alpha } from '../common/Theme';
import { Chip, ColorDot, EmptyHint } from '../common/Widgets';
import { recordLabel } from '../common/Models';
import { TimerItem, TimerRecord } from '../data/Rows';
import { Contribution, NormalizedPomodoro, contribute, isPomodoroConfig, normalizePomodoro, parseConfig, sumContribution } from '../core/Contract';
import { dayKey, dayTitle, hms } from '../core/Engine';

const RANGES: string[] = ['今天', '近7天', '近30天', '全部'];

class HistRow {
  id: string = '';
  time: string = '';
  name: string = '';
  badge: string = '';
  duration: string = '';
  color: string = '';
  secs: number = 0;
}

class HistDay {
  day: string = '';
  title: string = '';
  focus: string = '';
  rounds: string = '';
  marks: string = '';
  rows: HistRow[] = [];
}

@Component
export struct HistoryScreen {
  @Consume('nav') stack: NavPathStack;
  @State range: number = 1;
  @State colorFilter: string = '';
  @State days: HistDay[] = [];
  @State palette: string[] = [];
  @State note: string = '';

  async aboutToAppear(): Promise<void> {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    await AppHolder.boot(ctx);
    this.load();
  }

  private cutoff(): number {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
    if (this.range === 0) return start;
    if (this.range === 1) return start - 6 * 86400000;
    if (this.range === 2) return start - 29 * 86400000;
    return 0;
  }

  async load(): Promise<void> {
    const repo = AppHolder.repo;
    const db = AppHolder.db;
    if (repo === null || db === null) return;
    const items: TimerItem[] = await db.allTimerRows();
    const meta = new Map<string, TimerItem>();
    const pomoFlags = new Map<string, boolean>();
    const pomoNorms = new Map<string, NormalizedPomodoro>();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      meta.set(it.id, it);
      const cfg = parseConfig(it.config_json);
      pomoFlags.set(it.id, isPomodoroConfig(it.type, cfg));
      pomoNorms.set(it.id, normalizePomodoro(cfg));
    }
    const recs: TimerRecord[] = await db.liveRecords();
    const cut = this.cutoff();
    const colors = new Set<string>();
    const order: string[] = [];
    const buckets = new Map<string, HistDay>();
    const totals = new Map<string, Contribution>();
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (cut > 0 && r.ended_at < cut) continue;
      const owner = meta.get(r.timer_id);
      const color = owner === undefined || owner.color === null ? T.ACCENT : owner.color;
      if (this.colorFilter.length > 0 && color !== this.colorFilter) continue;
      colors.add(color);
      const c: Contribution = contribute(r.duration_sec, r.record_type,
        pomoFlags.get(r.timer_id) ?? false, pomoNorms.get(r.timer_id) ?? normalizePomodoro(null));
      const key = dayKey(r.ended_at);
      if (!buckets.has(key)) {
        const hd = new HistDay();
        hd.day = key;
        hd.title = dayTitle(r.ended_at);
        buckets.set(key, hd);
        totals.set(key, { focusMs: 0, rounds: 0, marks: 0 });
        order.push(key);
      }
      totals.set(key, sumContribution(totals.get(key) as Contribution, c));
      const row = new HistRow();
      const d = new Date(r.ended_at);
      const hh = d.getHours();
      const mm = d.getMinutes();
      row.id = r.id;
      row.time = `${hh < 10 ? `0${hh}` : hh}:${mm < 10 ? `0${mm}` : mm}`;
      row.name = owner === undefined ? '已删除的计时' : owner.name;
      row.badge = recordLabel(r.record_type);
      row.duration = hms(r.duration_sec * 1000);
      row.color = color;
      row.secs = r.duration_sec;
      (buckets.get(key) as HistDay).rows.push(row);
    }
    const out: HistDay[] = [];
    for (let i = 0; i < order.length; i++) {
      const hd = buckets.get(order[i]) as HistDay;
      const c = totals.get(order[i]) as Contribution;
      hd.focus = hms(c.focusMs);
      hd.rounds = `${c.rounds}`;
      hd.marks = `${c.marks}`;
      out.push(hd);
    }
    this.days = out;
    this.palette = Array.from(colors);
  }

  build() {
    Column({ space: T.SP }) {
      Row() {
        Text('‹')
          .fontSize(T.font(28))
          .fontColor(T.TEXT_LOW)
          .padding({ right: T.SP })
          .onClick(() => this.stack.pop())
        Text('历史')
          .fontSize(T.font(18))
          .fontWeight(FontWeight.Medium)
          .fontColor(T.TEXT)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ top: T.SP })

      Row({ space: T.SP_SM }) {
        ForEach(RANGES, (label: string, idx: number) => {
          Chip({ label: label, selected: this.range === idx, onTap: () => {
            this.range = idx;
            this.load();
          } })
        }, (label: string) => label)
      }
      .width('100%')

      if (this.palette.length > 1) {
        Row({ space: T.SP_SM }) {
          ForEach(this.palette, (c: string) => {
            Column({ space: 2 }) {
              ColorDot({ color: c, dotSize: this.colorFilter === c ? 18 : 12 })
            }
            .padding(4)
            .borderRadius(T.R_PILL)
            .border({ width: this.colorFilter === c ? 1 : 0, color: c })
            .onClick(() => {
              this.colorFilter = this.colorFilter === c ? '' : c;
              this.load();
            })
          }, (c: string) => c)
        }
        .width('100%')
      }

      if (this.days.length === 0) {
        EmptyHint({ text: '这个区间还没有记录' })
      } else {
        List({ space: T.SP }) {
          ForEach(this.days, (d: HistDay) => {
            ListItem() {
              Column({ space: T.SP_SM }) {
                Row() {
                  Text(d.title)
                    .fontSize(T.font(14))
                    .fontColor(T.TEXT)
                  Blank()
                  Text(`专注 ${d.focus} · ${d.rounds} 轮 · 打点 ${d.marks}`)
                    .fontSize(T.font(11))
                    .fontColor(T.TEXT_LOW)
                }
                .width('100%')

                ForEach(d.rows, (r: HistRow) => {
                  Row({ space: T.SP_SM }) {
                    ColorDot({ color: r.color, dotSize: 8 })
                    Text(r.time)
                      .fontSize(T.font(12))
                      .fontColor(T.TEXT_LOW)
                      .width(48)
                    Text(r.name)
                      .fontSize(T.font(13))
                      .fontColor(T.TEXT)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .layoutWeight(1)
                    Text(r.badge)
                      .fontSize(T.font(11))
                      .fontColor(T.TEXT_LOW)
                      .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                      .borderRadius(T.R_PILL)
                      .backgroundColor(alpha(T.CARD_HI, 0.9))
                    Text(r.duration)
                      .fontSize(T.font(13))
                      .fontColor(T.TEXT)
                  }
                  .width('100%')
                  .padding({ top: 6, bottom: 6 })
                  .onClick(() => {
                    const repo = AppHolder.repo;
                    if (repo === null) return;
                    repo.deleteRecord(r.id).then(() => this.load());
                  })
                }, (r: HistRow) => `${r.id}:${r.secs}`)
              }
              .width('100%')
              .padding(T.SP)
              .borderRadius(T.R_CARD)
              .backgroundColor(T.CARD)
              .border({ width: 1, color: T.STROKE })
            }
          }, (d: HistDay) => `${d.day}:${d.rows.length}:${d.focus}`)
        }
        .layoutWeight(1)
        .scrollBar(BarState.Auto)
      }

      if (this.note.length > 0) {
        Text(this.note).fontSize(T.font(12)).fontColor(T.TEXT_LOW)
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: T.SP, right: T.SP, bottom: T.SP })
    .backgroundColor(T.BG)
  }
}
