# TimeMark 鸿蒙端（HarmonyOS NEXT）开发计划 M4

> 范围：`apps/harmony`（ArkTS / ArkUI，stage 模型，bundleName `com.timemark.app`，SDK 6.0.2 / API 22）。
> 对齐基线：Windows v0.5.x 与 Android v0.4.7 已收敛的同一套语义；功能面以**两端里较全的那一侧**为准
> （里程碑/标签/导出备份取 Windows，五屏信息结构取 Android）。

## 1. 阶段与状态

| 阶段 | 产出 | 状态 |
|---|---|---|
| H0 | DevEco 工程骨架、hvigor 命令行出包 | 完成 |
| H1 | `core/Contract.ets` 契约镜像 + 共享 fixture runner | 完成，50/50 |
| H2 | `data/{Db,Rows,AuthStore}.ets` RDB 五表 + pending_ops + 迁移 | 完成 |
| H3 | `sync/{Http,SyncManager}.ets` | 完成（编译级，未真机联调） |
| H4 | `data/Repo.ets` 仓储 + `core/Machine.ets` 状态机 + `core/Engine.ets` 读数 | 完成 |
| H5 | `service/{Reminders,Notifier,Ticker}.ets` 到点提醒与前台驱动 | 完成（编译级） |
| H6 | `pages/` 五屏 + `common/` 主题与组件 | 完成 |
| H7 | `tools/version.mjs`、`repo-guard` 接入 | 完成，7/7 |
| H9 | 纯状态机抽离 + `tools/harmony-engine-test.mjs` 行为单测 | 完成，68/68 |
| H10 | 里程碑（详情页标记/列表/删除）+ 标签（表单录入、列表筛选、卡片展示） | 完成（编译级） |
| H11 | 全量导出 / 导入备份 `service/Backup.ets` | 完成（编译级，格式与 Windows 互导） |
| H13 | 桌面服务卡片：`entryformability/EntryFormAbility.ets` + `widget/pages/WidgetCard.ets` + `service/CardUpdater.ets` | 完成（编译级） |
| H14 | 实况窗 `service/LiveView.ets`（权益未过审时静默降级） | 完成（编译级），权益待申请 |
| H12 | 品牌图标替换模板占位 | 见 §6 |
| — | 开机自启 | **不做**：权限不可得，见 §3.2 |

## 2. 与双端的契约对齐点

- **单一语义来源**：`ets/core/Contract.ets` 与 `apps/windows/src/shared/contract.ts`、
  `apps/android/.../core/Contract.kt` 逐字段镜像；三端各自跑同一份
  `shared/contract/fixtures/contract.json`。
- **状态机与持久化分离**：`core/Machine.ets` 只吃「type + config_json + run_json + 墙钟/单调量」，
  吐新状态 + 待写记录；`data/Repo.ets` 只负责落库与 `pending_ops` 入队。
  Machine/Engine/Contract 一律不 import `@kit`，因此能在 node 里被真实断言（H9）。
  时区算法隔离在 `core/Time.ets`（依赖 `@ohos.intl`）。
- **番茄钟不是 type**：落库只有三种 type，番茄钟 = `PRECISE_COUNTDOWN` + `config.pomodoro`。
- **config 落位**：写 canonical（`pomodoro.long_break_ms` + 顶层镜像）；读兼容 v0.4.6/v0.4.7 两种历史落位。
- **run_json 同步**：运行态写 `__run: true` 交服务端做 `version + session_id` 校验；idle→running 才换新 session；
  **只有"到点完成"清空 session_id**，手动结束/归零保留（与双端一致）。
- **统计口径**：今日专注/轮次/打点全部由 `timer_record` 经 `contribute()` 现场聚合，无本机账本。
- **记录时间边界**：番茄钟推进的记录用阶段边界（`phaseEnd`）而不是 `now`，漏掉的时间不补记、不自动连跳多轮。
- **标签规则**：`trim` + 20 字上限 + 去重 + 最多 8 个；标签按名匹配，`timer_tag.id` 是独立 uuid；
  改标签只墓碑连接行，`tag` 行永不删除；删除计时连带墓碑其连接行（与 Windows 一致）。
- **里程碑**：`note` 为用户输入截断 100 字，`marked_at == updated_at`；只对普通倒计时与正计时开放；
  不参与统计（统计仍只看 `timer_record`）。

## 3. 平台能力结论（本轮 SDK 核对，覆盖 `docs/TimeMark-开发计划-v2.md` §7 的三处旧断言）

### 3.1 没有 TIMER 长时任务
`ohos.resourceschedule.backgroundTaskManager.BackgroundMode` 在 API 22 只有
`DATA_TRANSFER / AUDIO_PLAYBACK / AUDIO_RECORDING / LOCATION / BLUETOOTH_INTERACTION /
MULTI_DEVICE_CONNECTION / VOIP / TASK_KEEPING`，**没有 TIMER**；`TASK_KEEPING` 还需系统级 APL。

**采用的方案**：不占长时任务名额。到点交给系统
`reminderAgentManager.publishReminder(REMINDER_TYPE_TIMER, triggerTimeInSeconds)`
（权限 `ohos.permission.PUBLISH_AGENT_REMINDER`，`module.json5` 已声明）；
前台由 `Ticker` 每秒驱动，读数全从持久化字段现算；回前台/冷启动 `Repo.settleDue()` 补算边界。
与既定语义自洽：**超时不自动连跳、错过不补响**。
只排 30 天内到点的前 16 个（reminderAgent 有数量上限）。

### 3.2 开机自启不可得
静态订阅 `usual.event.BOOT_COMPLETED` 需系统级权限，第三方应用申请不到 → **不做开机接收器**；
恢复点在下一次应用启动（`EntryAbility.onCreate → AppHolder.boot → Ticker.start`：补算 + 重排提醒 + 刷卡片/实况窗）。

### 3.3 明文 HTTP
> **2026-09-21 更新**：后端已切 HTTPS，本节结论已过时——对外地址改为 `https://sync.knowhub.chat:18443`
> （Cloudflare DNS → `118.195.133.25`，nginx 18443 + Let's Encrypt 公信证书，见 `deploy/TLS-CUTOVER.md`）。
> Android 侧 `network_security_config.xml` 已改为全局禁止 cleartext。以下为当时的判断过程，留作记录。

后端当时是 `http://118.195.133.25:18080`。鸿蒙网络栈会以 **2300997 Cleartext traffic not permitted** 拦截明文，
而 stage 模型的 `module.json5` **没有** Android `networkSecurityConfig` 那种按地址豁免的开关
（`cleartextTraffic` 只存在于 FA 模型 `config.json` 的 deviceConfig）。
`sync/Http.ets` 已把该错误码翻译成可读提示。**真机若同步失败，先给后端配 HTTPS**（唯一干净解）。

### 3.4 实况窗需要 AGC 权益
`@kit.LiveViewKit` 的 `liveViewManager`（`isLiveViewEnabled/startLiveView/updateLiveView/stopLiveView`）
已接入，TIMER 场景样式（`LiveViewTimer` + `TimerCapsule`）按 API 12+ 字段填写。
但 TIMER 场景需在 AGC 申请权益、且模拟器不渲染，必须真机验证。
`service/LiveView.ets` 的策略是：`resultCode != 0` 或抛错 → 记 `unavailable`，本轮不再重试，
自动回落到「reminderAgent 通知 + 桌面卡片」，对用户无感。**权益申请仍是待办**。

### 3.5 服务卡片
FormKit 走 `extensionAbilities[type=form]` + `resources/base/profile/form_config.json`
（2\*2 与 2\*4，`updateDuration=0` + `scheduledUpdateTime`）。
卡片回调 `onAddForm` 必须**同步**返回，而 RDB 是异步的，所以设计成：
主进程 `CardUpdater` 把最新快照写进偏好 → `EntryFormAbility` 同步读偏好；
卡片号登记在同一份偏好里，主进程按登记逐个 `formProvider.updateForm`。
快照 JSON 未变则跳过推送，避免每秒 IPC 撞系统限频。

## 4. 三端语义待收口项

1. **`PARTIAL_SETTLE_MIN_MS` 没有 fixture 用例**：三端都定义了 5000，
   但 `contract.json` 的 `constants` 里没有它，等于只靠人工对齐。建议加进 `constants`。
2. **`tagColorFor` 对增补平面字符（emoji）双端不一致**：
   Windows 按码点取 `charCodeAt(0)`（只累加高位代理），Android 按 UTF-16 码元逐个累加。
   鸿蒙取 Android 的码元求和（中文/ASCII 三端一致）。建议补一条 emoji fixture 用例把分歧钉死再统一。

## 5. 目录结构

```
apps/harmony/
├─ AppScope/app.json5                 versionName/versionCode 由 VERSION 导出
├─ build-profile.json5                compatible/target = 6.0.2(22)
└─ entry/src/main/
   ├─ module.json5                    INTERNET + PUBLISH_AGENT_REMINDER；form 扩展能力
   ├─ ets/
   │  ├─ AppHolder.ets                依赖装配
   │  ├─ core/{Contract,Machine,Engine,Time}.ets   契约 / 纯状态机 / 读数 / 时区
   │  ├─ data/{Db,Rows,AuthStore,Repo}.ets
   │  ├─ sync/{Http,SyncManager}.ets
   │  ├─ service/{Ticker,Reminders,Notifier,CardUpdater,LiveView,Backup}.ets
   │  ├─ common/{Theme,Widgets,Models,CardSnapshot,Route}.ets
   │  ├─ entryability/EntryAbility.ets
   │  ├─ entryformability/EntryFormAbility.ets
   │  ├─ widget/pages/WidgetCard.ets   服务卡片页
   │  └─ pages/{Index,ListScreen,DetailScreen,FormScreen,HistoryScreen,LoginScreen}.ets
   └─ resources/base/profile/form_config.json
```

## 6. 构建、测试与装机

```bash
# 编译出包（未签名）
cd apps/harmony
DEVECO_SDK_HOME="E:\DevEco Studio\sdk" \
  "E:\DevEco Studio\tools\node\node.exe" "E:\DevEco Studio\tools\hvigor\bin\hvigorw.js" \
  --mode module -p product=default assembleHap --no-daemon
# 产物 entry/build/default/outputs/default/entry-default-unsigned.hap

# 四条验证
node tools/harmony-contract-test.mjs    # 契约 50 例
node tools/harmony-engine-test.mjs      # 状态机 68 例
node tools/version.mjs                  # 四端版本同源
node --test apps/windows/tests/repo-guard.test.cjs
```

**装机前必做**：DevEco `File → Project Structure → Signing-Configs` 自动签名（需华为账号登录；
本机 `~/.ohos/config` 现有证书只覆盖旧包名 PillBox），之后 `hdc install entry-default.hap`。
注意：已部署的模拟器镜像是 5.0.1/5.0.5，装不上锁在 6.0.2(22) 的工程——需真机或另下 6.0 镜像。

## 7. 已验证 / 未验证（如实声明）

| 项 | 状态 |
|---|---|
| ArkTS 编译 + 打包（含 form 扩展与卡片页） | 已验证 BUILD SUCCESSFUL |
| 契约语义与 Windows/Android 同源 | 已验证，共享 fixture 50/50 |
| 状态机行为（迁移、分段、推进、守卫、阈值） | 已验证 68/68，在 node 里跑真实 ArkTS 源码 |
| 仓库不变量（色板/阈值/四端版本同源） | 已验证 repo-guard 7/7 |
| RDB 建表读写、同步往返、导出导入落地 | **未验证**：需签名后真机/模拟器运行 |
| reminderAgent 到点时效、锁屏表现、重启后是否仍触发 | **未验证**：需真机 |
| 服务卡片渲染与 `updateForm` 刷新、实况窗显示 | **未验证**：卡片需真机添加，实况窗还需 AGC 权益 |
| 明文 HTTP 是否被 2300997 拦截 | **未验证**：真机一试便知，见 §3.3 |
