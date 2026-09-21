// 桌面服务卡片页面（FormKit）。数据由 EntryFormAbility 注入、主进程 CardUpdater 刷新；
// 卡片只展示与唤起，不做任何计时计算，也不写库。
import { DEFAULT_TIMER_COLOR } from '../../core/Contract';
import { T } from '../../common/Theme';

const storage: LocalStorage = new LocalStorage();

@Entry(storage)
@Component
struct WidgetCard {
  @LocalStorageProp('title') title: string = 'TimeMark';
  @LocalStorageProp('reading') reading: string = '--:--';
  @LocalStorageProp('sub') sub: string = '点按打开 TimeMark';
  @LocalStorageProp('color') color: string = DEFAULT_TIMER_COLOR;
  @LocalStorageProp('running') running: boolean = false;

  private openApp(): void {
    const params: Record<string, Object> = {};
    params['targetPage'] = 'list' as Object;
    const action: Record<string, Object> = {};
    action['action'] = 'router' as Object;
    action['abilityName'] = 'EntryAbility' as Object;
    action['params'] = params as Object;
    postCardAction(this, action as Object);
  }

  build() {
    Column({ space: 6 }) {
      Row({ space: 6 }) {
        Circle()
          .width(8)
          .height(8)
          .fill(this.color)
        Text(this.title)
          .fontSize(13)
          .fontColor(T.TEXT)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .layoutWeight(1)
        if (this.running) {
          Text('进行中')
            .fontSize(10)
            .fontColor(this.color)
        }
      }
      .width('100%')

      Text(this.reading)
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor(T.TEXT)
        .width('100%')

      Text(this.sub)
        .fontSize(11)
        .fontColor(T.TEXT_LOW)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .backgroundColor(T.CARD_HI)
    .onClick(() => this.openApp())
  }
}
