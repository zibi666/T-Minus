// 共用小组件（与 Android ui/Common.kt 同一套：色点/类型徽章/统计块/胶囊/动作按钮/空态）。
import { T, alpha } from './Theme';
import { typeLabel } from './Models';

@Component
export struct ColorDot {
  color: string = '#FFFFFF';
  dotSize: number = 10;

  build() {
    Column()
      .width(this.dotSize)
      .height(this.dotSize)
      .borderRadius(this.dotSize)
      .backgroundColor(this.color)
  }
}

@Component
export struct TypeBadge {
  logical: string = '';

  build() {
    Text(typeLabel(this.logical))
      .fontSize(T.font(11))
      .fontColor(T.TEXT_LOW)
      .padding({ left: 8, right: 8, top: 3, bottom: 3 })
      .borderRadius(T.R_PILL)
      .backgroundColor(alpha(T.CARD_HI, 0.9))
      .border({ width: 1, color: T.STROKE })
  }
}

@Component
export struct StatBlock {
  value: string = '';
  label: string = '';

  build() {
    Column({ space: 2 }) {
      Text(this.value)
        .fontSize(T.font(18))
        .fontWeight(FontWeight.Medium)
        .fontColor(T.TEXT)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(this.label)
        .fontSize(T.font(11))
        .fontColor(T.TEXT_LOW)
    }
    .alignItems(HorizontalAlign.Start)
    .layoutWeight(1)
  }
}

@Component
export struct Chip {
  label: string = '';
  selected: boolean = false;
  /** 可选态：编辑计时器时锁死类型选择，避免误改导致运行态被静默清空。
   *  刻意不叫 enabled：ArkUI 的 CustomComponent 基类已有同名通用属性（方法型），重名会编译报错 */
  selectable: boolean = true;
  onTap: () => void = () => {};

  build() {
    Text(this.label)
      .fontSize(T.font(13))
      .fontColor(this.selected ? T.BG : (this.selectable ? T.TEXT_LOW : alpha(T.TEXT_LOW, 0.4)))
      .fontWeight(this.selected ? FontWeight.Medium : FontWeight.Normal)
      .padding({ left: 14, right: 14, top: 7, bottom: 7 })
      .borderRadius(T.R_PILL)
      .backgroundColor(this.selected ? T.ACCENT : alpha(T.CARD, this.selectable ? 0.85 : 0.4))
      .border({ width: 1, color: this.selected ? T.ACCENT : T.STROKE })
      .opacity(this.selectable ? 1 : 0.6)
      .onClick(() => { if (this.selectable) this.onTap(); })
  }
}

@Component
export struct ActionButton {
  label: string = '';
  kind: string = 'primary';
  busy: boolean = false;
  onTap: () => void = () => {};

  build() {
    Text(this.busy ? '处理中…' : this.label)
      .fontSize(T.font(15))
      .fontWeight(FontWeight.Medium)
      .fontColor(this.kind === 'danger' ? T.DANGER : (this.kind === 'ghost' ? T.TEXT_LOW : T.BG))
      .textAlign(TextAlign.Center)
      .padding({ top: 12, bottom: 12, left: 16, right: 16 })
      .borderRadius(T.R_FIELD)
      .backgroundColor(this.kind === 'danger' ? alpha(T.DANGER, 0.12)
        : (this.kind === 'ghost' ? alpha(T.CARD_HI, 0.7) : T.ACCENT))
      .border({ width: 1, color: this.kind === 'primary' ? T.ACCENT : T.STROKE })
      .opacity(this.busy ? 0.6 : 1)
      .onClick(() => {
        if (!this.busy) this.onTap();
      })
  }
}

@Component
export struct EmptyHint {
  text: string = '还没有计时器';

  build() {
    Column({ space: 6 }) {
      Text(this.text)
        .fontSize(T.font(14))
        .fontColor(T.TEXT_LOW)
    }
    .width('100%')
    .padding({ top: 48, bottom: 48 })
    .justifyContent(FlexAlign.Center)
  }
}
