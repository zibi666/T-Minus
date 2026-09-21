// 表单页（对齐 Android ui/FormScreen.kt：名称 / 四类型 / 8 色板 / 预设档 / 番茄钟分钟档 / 日期下拉）。
// 落库只有三种 type——番茄钟存 PRECISE_COUNTDOWN + config.pomodoro，与双端一致。
import { common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { AppHolder } from '../AppHolder';
import { Repo } from '../data/Repo';
import { T, alpha } from '../common/Theme';
import { Chip } from '../common/Widgets';
import { logicalOf } from '../common/Models';
import {
  DEFAULT_TIMER_COLOR, LOGICAL_POMODORO, TIMER_PALETTE, TYPE_DATE, TYPE_PRECISE, TYPE_STOPWATCH,
  normalizePomodoro, numAt, parseConfig, strAt
} from '../core/Contract';
import { hms } from '../core/Engine';
import { daysLeft } from '../core/Time';

const PRESET_MIN: number[] = [1, 5, 10, 25, 45, 60, 90, 120];
const TYPE_OPTIONS: string[] = [TYPE_DATE, TYPE_PRECISE, TYPE_STOPWATCH, LOGICAL_POMODORO];

function typeChipName(logical: string): string {
  if (logical === TYPE_DATE) return '日期';
  if (logical === TYPE_PRECISE) return '倒计时';
  if (logical === TYPE_STOPWATCH) return '正计时';
  return '番茄钟';
}

@Component
export struct FormScreen {
  @Consume('nav') stack: NavPathStack;
  timerId: string = '';
  @State editing: boolean = false;
  @State name: string = '';
  @State remark: string = '';
  @State logical: string = TYPE_PRECISE;
  @State color: string = DEFAULT_TIMER_COLOR;
  @State presetText: string = '25';
  @State focusText: string = '25';
  @State shortText: string = '5';
  @State longText: string = '15';
  @State roundsText: string = '4';
  @State year: number = new Date().getFullYear();
  @State month: number = new Date().getMonth() + 1;
  @State day: number = new Date().getDate();
  @State note: string = '';
  @State busy: boolean = false;
  @State tags: string[] = [];
  @State tagInput: string = '';
  @State tagSuggest: string[] = [];
  @State yearOpts: SelectOption[] = [];
  @State monthOpts: SelectOption[] = [];
  @State dayOpts: SelectOption[] = [];

  async aboutToAppear(): Promise<void> {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    await AppHolder.boot(ctx);
    // 年份范围与 Android/Windows 对齐：当前年-10 ~ 当前年+30（旧版本只能选 base-5..base+10，不能设“20 年后的退休倒计时”）
    const ys: SelectOption[] = [];
    const base = new Date().getFullYear();
    for (let y = base - 10; y <= base + 30; y++) {
      ys.push({ value: `${y}` });
    }
    this.yearOpts = ys;
    const ms: SelectOption[] = [];
    for (let m = 1; m <= 12; m++) {
      ms.push({ value: `${m}月` });
    }
    this.monthOpts = ms;
    this.dayOpts = this.buildDayOpts(this.year, this.month);
    this.load();
  }

  /** 按当前年月实际天数生成日期选项，防止用户选到 2/31 这类不存在的日期（Date.UTC 会溢出到下个月） */
  private buildDayOpts(y: number, m: number): SelectOption[] {
    const dim = daysInMonth(y, m);
    const ds: SelectOption[] = [];
    for (let d = 1; d <= dim; d++) {
      ds.push({ value: `${d}日` });
    }
    return ds;
  }

  /** 年或月变化后重建日选项并钳制已选日：避免留下“2/31”这类新上下文里不存在的日期 */
  private onYearMonthChanged(): void {
    this.dayOpts = this.buildDayOpts(this.year, this.month);
    const dim = daysInMonth(this.year, this.month);
    if (this.day > dim) this.day = dim;
  }

  async load(): Promise<void> {
    const repo = AppHolder.repo;
    if (repo === null) return;
    this.tagSuggest = await repo.tagNames();
    if (this.timerId.length === 0) {
      this.editing = false;
      return;
    }
    const item = await repo.timerById(this.timerId);
    if (item === null) return;
    this.editing = true;
    this.tags = await repo.tagsOfTimer(this.timerId);
    this.name = item.name;
    this.remark = item.remark ?? '';
    this.color = item.color ?? DEFAULT_TIMER_COLOR;
    this.logical = logicalOf(item);
    const cfg = parseConfig(item.config_json);
    const p = normalizePomodoro(cfg);
    this.presetText = `${Math.round((numAt(cfg, 'preset_ms') ?? 1500000) / 60000)}`;
    this.focusText = `${Math.round(p.work_ms / 60000)}`;
    this.shortText = `${Math.round(p.break_ms / 60000)}`;
    this.longText = `${Math.round(p.long_break_ms / 60000)}`;
    this.roundsText = `${p.rounds}`;
    const target = strAt(cfg, 'target_date') ?? '';
    const parts = target.split('-');
    if (parts.length === 3) {
      this.year = parseInt(parts[0], 10);
      this.month = parseInt(parts[1], 10);
      this.day = parseInt(parts[2], 10);
      // 读入旧日期后重建日选项并钳制，避免历史上已写入的“2/31”在 UI 上遇到只到 28 日的选项时 indexOf 失败
      this.onYearMonthChanged();
    }
  }

  /** 添标签：清洗规则走 Repo，避免表单里再写一份上限 */
  addTag(name: string = ''): void {
    const raw = name.length > 0 ? name : this.tagInput;
    this.tags = Repo.cleanTagNames(this.tags.concat([raw]));
    if (name.length === 0) this.tagInput = '';
  }

  private digits(s: string, fallback: number): number {
    const n = parseInt(s, 10);
    return Number.isNaN(n) || n <= 0 ? fallback : n;
  }

  private targetDate(): string {
    const m = this.month < 10 ? `0${this.month}` : `${this.month}`;
    const d = this.day < 10 ? `0${this.day}` : `${this.day}`;
    return `${this.year}-${m}-${d}`;
  }

  private async save(): Promise<void> {
    const repo = AppHolder.repo;
    if (repo === null) return;
    this.busy = true;
    try {
      const storedType = this.logical === LOGICAL_POMODORO ? TYPE_PRECISE : this.logical;
      const tz = localTz();
      const configJson = repo.buildConfigJson(this.logical, this.targetDate(),
        this.digits(this.presetText, 25), this.digits(this.focusText, 25), this.digits(this.shortText, 5),
        this.digits(this.longText, 15), this.digits(this.roundsText, 4), tz);
      if (this.editing) {
        const rejected = await repo.updateMeta(this.timerId, this.name.length === 0 ? '未命名' : this.name,
          storedType, this.color, this.remark, configJson);
        this.note = rejected === null ? '' : rejected;
        if (rejected === null) await repo.setTimerTags(this.timerId, this.tags);
      } else {
        const created = await repo.createTimer(this.name.length === 0 ? '未命名' : this.name, storedType,
          this.color, configJson, this.remark.length === 0 ? null : this.remark);
        await repo.setTimerTags(created, this.tags);
      }
      const t = AppHolder.ticker;
      if (t !== null) await t.poke();
      if (this.note.length === 0) this.stack.pop();
    } finally {
      this.busy = false;
    }
  }

  build() {
    Scroll() {
      Column({ space: T.SP }) {
        Row() {
          Text('‹')
            .fontSize(T.font(28))
            .fontColor(T.TEXT_LOW)
            .padding({ right: T.SP })
            .onClick(() => this.stack.pop())
          Text(this.editing ? '编辑计时' : '新建计时')
            .fontSize(T.font(18))
            .fontWeight(FontWeight.Medium)
            .fontColor(T.TEXT)
            .layoutWeight(1)
        }
        .width('100%')
        .padding({ top: T.SP })

        TextInput({ placeholder: '名称', text: this.name })
          .placeholderColor(T.TEXT_LOW)
          .fontColor(T.TEXT)
          .backgroundColor(T.CARD)
          .borderRadius(T.R_FIELD)
          .border({ width: 1, color: T.STROKE })
          .height(48)
          .onChange((v: string) => this.name = v)

        Row({ space: T.SP_SM }) {
          ForEach(TYPE_OPTIONS, (op: string) => {
            // 编辑时禁改类型：与 Windows TimerForm 一致（Repo.updateMeta 遇 typeChanged 会清 run_state/run_json/session_id，
            // 运行中误改会静默丢失当前进度）
            Chip({
              label: typeChipName(op),
              selected: this.logical === op,
              selectable: !this.editing,
              onTap: () => this.logical = op
            })
          }, (op: string) => op)
        }
        .width('100%')

        Row({ space: T.SP_SM }) {
          ForEach(TIMER_PALETTE, (c: string) => {
            Column()
              .width(28)
              .height(28)
              .borderRadius(28)
              .backgroundColor(c)
              .border({ width: this.color === c ? 3 : 0, color: T.TEXT })
              .onClick(() => this.color = c)
          }, (c: string) => c)
        }
        .width('100%')

        if (this.logical === TYPE_PRECISE) {
          Column({ space: T.SP_SM }) {
            Text('预设时长（分钟）')
              .fontSize(T.font(12))
              .fontColor(T.TEXT_LOW)
              .width('100%')
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(PRESET_MIN, (p: number) => {
                Row() {
                  Chip({ label: `${p}分`, selected: this.presetText === `${p}`, onTap: () => this.presetText = `${p}` })
                }
                .margin({ right: 8, bottom: 8 })
              }, (p: number) => `${p}`)
            }
            TextInput({ placeholder: '自定义分钟', text: this.presetText })
              .type(InputType.Number)
              .fontColor(T.TEXT)
              .placeholderColor(T.TEXT_LOW)
              .backgroundColor(T.CARD)
              .borderRadius(T.R_FIELD)
              .border({ width: 1, color: T.STROKE })
              .height(44)
              .onChange((v: string) => this.presetText = v)
            Text(`即 ${hms(this.digits(this.presetText, 25) * 60000)}`)
              .fontSize(T.font(11))
              .fontColor(T.TEXT_LOW)
          }
          .width('100%')
        }

        if (this.logical === LOGICAL_POMODORO) {
          Column({ space: T.SP_SM }) {
            Text('番茄钟档位（分钟）')
              .fontSize(T.font(12))
              .fontColor(T.TEXT_LOW)
              .width('100%')
            Row({ space: T.SP_SM }) {
              NumField({ label: '专注', text: $focusText })
              NumField({ label: '短休息', text: $shortText })
            }
            .width('100%')
            Row({ space: T.SP_SM }) {
              NumField({ label: '长休息', text: $longText })
              NumField({ label: '轮数', text: $roundsText })
            }
            .width('100%')
          }
          .width('100%')
        }

        if (this.logical === TYPE_DATE) {
          Column({ space: T.SP_SM }) {
            Text('目标日期')
              .fontSize(T.font(12))
              .fontColor(T.TEXT_LOW)
              .width('100%')
            Row({ space: T.SP_SM }) {
              Select(this.yearOpts)
                .selected(indexOf(this.yearOpts, `${this.year}`))
                .value(`${this.year}`)
                .font({ size: T.font(14) })
                .fontColor(T.TEXT)
                .backgroundColor(alpha(T.CARD, 0.9))
                .borderRadius(T.R_SMALL)
                .layoutWeight(1)
                .onSelect((idx: number) => {
                  this.year = this.yearOpts[idx].value === undefined ? this.year
                    : parseInt(`${this.yearOpts[idx].value}`, 10);
                  this.onYearMonthChanged();
                })
              Select(this.monthOpts)
                .selected(indexOf(this.monthOpts, `${this.month}月`))
                .value(`${this.month}月`)
                .font({ size: T.font(14) })
                .fontColor(T.TEXT)
                .backgroundColor(alpha(T.CARD, 0.9))
                .borderRadius(T.R_SMALL)
                .layoutWeight(1)
                .onSelect((idx: number) => {
                  this.month = idx + 1;
                  this.onYearMonthChanged();
                })
              Select(this.dayOpts)
                .selected(indexOf(this.dayOpts, `${this.day}日`))
                .value(`${this.day}日`)
                .font({ size: T.font(14) })
                .fontColor(T.TEXT)
                .backgroundColor(alpha(T.CARD, 0.9))
                .borderRadius(T.R_SMALL)
                .layoutWeight(1)
                .onSelect((idx: number) => {
                  this.day = idx + 1;
                })
            }
            .width('100%')
            Text(`目标日 ${this.targetDate()} · 剩 ${daysTo(this.year, this.month, this.day)} 天`)
              .fontSize(T.font(11))
              .fontColor(T.TEXT_LOW)
          }
          .width('100%')
        }

        TextArea({ placeholder: '备注（可选）', text: this.remark })
          .placeholderColor(T.TEXT_LOW)
          .fontColor(T.TEXT)
          .backgroundColor(T.CARD)
          .borderRadius(T.R_FIELD)
          .border({ width: 1, color: T.STROKE })
          .height(72)
          .onChange((v: string) => this.remark = v)

        Column({ space: T.SP_SM }) {
          Text('标签（可选，最多 8 个，用于筛选）')
            .fontSize(T.font(12))
            .fontColor(T.TEXT_LOW)
            .width('100%')
          if (this.tags.length > 0) {
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.tags, (g: string) => {
                Row({ space: 4 }) {
                  Text(g).fontSize(T.font(12)).fontColor(T.BG)
                  Text('×').fontSize(T.font(13)).fontColor(T.BG)
                }
                .padding({ left: 10, right: 8, top: 5, bottom: 5 })
                .borderRadius(T.R_PILL)
                .backgroundColor(T.ACCENT)
                .margin({ right: 6, bottom: 6 })
                .onClick(() => {
                  const next: string[] = [];
                  for (let i = 0; i < this.tags.length; i++) {
                    if (this.tags[i] !== g) next.push(this.tags[i]);
                  }
                  this.tags = next;
                })
              }, (g: string) => g)
            }
            .width('100%')
          }
          Row({ space: T.SP_SM }) {
            TextInput({ placeholder: '输入标签后回车', text: this.tagInput })
              .fontSize(T.font(13))
              .fontColor(T.TEXT)
              .placeholderColor(T.TEXT_LOW)
              .backgroundColor(T.CARD)
              .borderRadius(T.R_FIELD)
              .border({ width: 1, color: T.STROKE })
              .height(44)
              .layoutWeight(1)
              .onChange((v: string) => this.tagInput = v)
              .onSubmit(() => this.addTag())
            Button('添加')
              .height(44)
              .fontSize(T.font(13))
              .fontColor(T.BG)
              .backgroundColor(T.CARD_HI)
              .borderRadius(T.R_FIELD)
              .onClick(() => this.addTag())
          }
          .width('100%')

          if (this.tagSuggest.length > 0) {
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.tagSuggest, (g: string) => {
                Row() {
                  Chip({ label: g, selected: false, onTap: () => this.addTag(g) })
                }
                .margin({ right: 8, bottom: 6 })
              }, (g: string) => `sug-${g}`)
            }
            .width('100%')
          }
        }
        .width('100%')

        if (this.note.length > 0) {
          Text(this.note)
            .fontSize(T.font(12))
            .fontColor(T.DANGER)
            .width('100%')
        }

        Button(this.busy ? '保存中…' : '保存')
          .width('100%')
          .height(48)
          .borderRadius(T.R_FIELD)
          .backgroundColor(T.ACCENT)
          .fontColor(T.BG)
          .fontSize(T.font(16))
          .enabled(!this.busy)
          .onClick(() => this.save())
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

@Component
struct NumField {
  label: string = '';
  @Link text: string;

  build() {
    Column({ space: 4 }) {
      Text(this.label)
        .fontSize(T.font(11))
        .fontColor(T.TEXT_LOW)
      TextInput({ placeholder: this.label, text: this.text })
        .type(InputType.Number)
        .fontColor(T.TEXT)
        .placeholderColor(T.TEXT_LOW)
        .backgroundColor(T.CARD)
        .borderRadius(T.R_FIELD)
        .border({ width: 1, color: T.STROKE })
        .height(44)
        .layoutWeight(1)
        .onChange((v: string) => this.text = v)
    }
    .alignItems(HorizontalAlign.Start)
    .layoutWeight(1)
  }
}

function indexOf(opts: SelectOption[], want: string): number {
  for (let i = 0; i < opts.length; i++) {
    if (`${opts[i].value}` === want) return i;
  }
  return 0;
}

function daysTo(y: number, m: number, d: number): number {
  // 与列表/详情页同源：走 Time.ets 的 daysLeft，使用写入 config.timezone_id 的目标时区计算。
  // 旧实现直接 new Date() 取本机时间，跨时区时表单预览与实际倒计时会不一致。
  const target = `${y}-${m < 10 ? `0${m}` : m}-${d < 10 ? `0${d}` : d}`;
  const tz = localTz();
  const left = daysLeft(target, tz, false, Date.now());
  return left === null ? 0 : left;
}

/** 当前年月的实际天数（闰年 2 月自动 29）：日期下拉选项与钳制已选日共用 */
function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** 本机 IANA 时区名（写入 config.timezone_id，与 Android/Windows 同字段） */
function localTz(): string {
  try {
    return i18n.getTimeZone().getID();
  } catch (e) {
    return 'Asia/Shanghai';
  }
}
