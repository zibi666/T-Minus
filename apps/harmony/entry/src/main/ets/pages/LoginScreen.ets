// 账户页（对齐 Android ui/LoginScreen.kt：注册 / 登录 / 登出 + 同步状态）。
// 注册与登录成功后由 SyncManager 认领无主数据并全量补交，本页只负责反馈结果。
import { common } from '@kit.AbilityKit';
import { AppHolder } from '../AppHolder';
import { T, alpha } from '../common/Theme';
import { ActionButton } from '../common/Widgets';
import { SERVER_BASE } from '../data/AuthStore';

@Component
export struct LoginScreen {
  @Consume('nav') stack: NavPathStack;
  @State username: string = '';
  @State password: string = '';
  @State account: string = '';
  @State loggedIn: boolean = false;
  @State queued: number = 0;
  @State note: string = '';
  @State backupNote: string = '';
  @State busy: boolean = false;

  async aboutToAppear(): Promise<void> {
    const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
    await AppHolder.boot(ctx);
    this.refresh();
  }

  async refresh(): Promise<void> {
    const auth = AppHolder.auth;
    const db = AppHolder.db;
    const sync = AppHolder.sync;
    if (auth === null) return;
    const uname = auth.username();
    this.loggedIn = uname !== null;
    this.account = uname ?? '';
    this.queued = db === null ? 0 : await db.queuedCount();
    this.note = sync === null ? '' : (sync.lastError ?? '');
  }

  private async run(fn: () => Promise<string | null>): Promise<void> {
    this.busy = true;
    try {
      const err = await fn();
      this.note = err ?? '';
      await this.refresh();
      if (err === null) this.stack.pop();
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column({ space: T.SP }) {
      Row() {
        Text('‹')
          .fontSize(T.font(28))
          .fontColor(T.TEXT_LOW)
          .padding({ right: T.SP })
          .onClick(() => this.stack.pop())
        Text('账户')
          .fontSize(T.font(18))
          .fontWeight(FontWeight.Medium)
          .fontColor(T.TEXT)
          .layoutWeight(1)
      }
      .width('100%')
      .padding({ top: T.SP })

      if (this.loggedIn) {
        Column({ space: T.SP_SM }) {
          Row() {
            Text('已登录')
              .fontSize(T.font(13))
              .fontColor(T.TEXT_LOW)
            Blank()
            Text(this.account)
              .fontSize(T.font(15))
              .fontColor(T.TEXT)
          }
          .width('100%')

          Row() {
            Text('待同步')
              .fontSize(T.font(13))
              .fontColor(T.TEXT_LOW)
            Blank()
            Text(`${this.queued} 条`)
              .fontSize(T.font(15))
              .fontColor(this.queued > 0 ? T.ACCENT : T.TEXT)
          }
          .width('100%')
        }
        .width('100%')
        .padding(T.SP)
        .borderRadius(T.R_CARD)
        .backgroundColor(T.CARD)
        .border({ width: 1, color: T.STROKE })

        Row({ space: T.SP_SM }) {
          ActionButton({ label: '立即同步', kind: 'primary', busy: this.busy, onTap: () => {
            const sync = AppHolder.sync;
            if (sync === null) return;
            this.run(async () => {
              await sync.syncNow();
              return sync.lastError;
            });
          } })
          ActionButton({ label: '退出登录', kind: 'danger', busy: this.busy, onTap: () => {
            const auth = AppHolder.auth;
            const sync = AppHolder.sync;
            if (auth === null || sync === null) return;
            this.run(async () => {
              await sync.logout();
              return null;
            });
          } })
        }
        .width('100%')
      } else {
        TextInput({ placeholder: '用户名', text: this.username })
          .fontColor(T.TEXT)
          .placeholderColor(T.TEXT_LOW)
          .backgroundColor(T.CARD)
          .borderRadius(T.R_FIELD)
          .border({ width: 1, color: T.STROKE })
          .height(48)
          .onChange((v: string) => this.username = v)

        TextInput({ placeholder: '密码（至少 6 位）', text: this.password })
          .type(InputType.Password)
          .fontColor(T.TEXT)
          .placeholderColor(T.TEXT_LOW)
          .backgroundColor(T.CARD)
          .borderRadius(T.R_FIELD)
          .border({ width: 1, color: T.STROKE })
          .height(48)
          .onChange((v: string) => this.password = v)

        Row({ space: T.SP_SM }) {
          ActionButton({ label: '注册', kind: 'ghost', busy: this.busy, onTap: () => {
            const sync = AppHolder.sync;
            if (sync === null) return;
            this.run(() => sync.register(this.username, this.password));
          } })
          ActionButton({ label: '登录', kind: 'primary', busy: this.busy, onTap: () => {
            const sync = AppHolder.sync;
            if (sync === null) return;
            this.run(() => sync.login(this.username, this.password));
          } })
        }
        .width('100%')
      }

      if (this.note.length > 0) {
        Text(this.note)
          .fontSize(T.font(12))
          .fontColor(T.DANGER)
          .width('100%')
      }

      Row({ space: T.SP_SM }) {
        ActionButton({ label: '导出备份', kind: 'ghost', busy: this.busy, onTap: () => {
          const b = AppHolder.backup;
          if (b === null) return;
          this.busy = true;
          b.exportToFile().then((res) => {
            this.busy = false;
            this.backupNote = res.message;
            this.refresh();
          }, (e: Error) => {
            this.busy = false;
            this.backupNote = `${e}`;
          });
        } })
        ActionButton({ label: '导入备份', kind: 'ghost', busy: this.busy, onTap: () => {
          const b = AppHolder.backup;
          if (b === null) return;
          this.busy = true;
          b.importFromFile().then((res) => {
            this.busy = false;
            this.backupNote = res.message;
            this.refresh();
          }, (e: Error) => {
            this.busy = false;
            this.backupNote = `${e}`;
          });
        } })
      }
      .width('100%')

      if (this.backupNote.length > 0) {
        Text(this.backupNote)
          .fontSize(T.font(12))
          .fontColor(T.TEXT_LOW)
          .width('100%')
      }

      Text(`同步服务：${SERVER_BASE}`)
        .fontSize(T.font(11))
        .fontColor(alpha(T.TEXT_LOW, 0.7))
        .width('100%')
        .padding({ top: T.SP })
    }
    .width('100%')
    .height('100%')
    .padding({ left: T.SP, right: T.SP, bottom: T.SP_LG })
    .backgroundColor(T.BG)
  }
}
