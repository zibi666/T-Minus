# 多端计时软件「TimeMark 时光标」开发计划（v2）

> 暂定名 TimeMark（时光标），可随时更换。定位：个人多设备自用的倒计时/正计时工具，**两端原生移动应用（Android、HarmonyOS）+ Windows 桌面应用（Electron）**（下文统称"三端"）+ 自建后端同步。
>
> **v2 修订说明**：根据评审意见补齐「计时状态与恢复规则」「同步协议细节」「分层冲突策略」「阶段验收条件」四块内容，并修正系统能力断言的出处与验证状态。v1 → v2 变更对照见文末附录 B。

## 1. 已确认的技术决策

| 决策项 | 结论 |
|---|---|
| 鸿蒙端 | ArkTS 原生，HarmonyOS NEXT（API 12+，实况窗计时器字段自 5.0.0(12) 起可用）。实况窗可用，但 **TIMER 场景需在 AGC 申请权益并通过审核**（官方 API 文档明确"使用对应场景需要申请权益"），未过审前以服务卡片 + 通知降级，不阻塞主线 |
| Android 端 | Kotlin + Jetpack Compose + Material 3。到点提醒使用 AlarmManager，**精确闹钟需运行时检测权限，被拒时走降级路径**（见 §7） |
| Windows 端 | Electron + TypeScript + React（桌面应用，非原生） |
| 后端 | Spring Boot 3 + MySQL 8，部署在已有云服务器 |
| 登录 | 账号密码 + JWT（7 天有效，过期凭已存凭据静默重登；refresh token 列入 backlog） |
| 同步 | 离线优先：断网本地照常用，联网增量同步；**冲突按数据类别分层处理**（见 §6），不再笼统"后写优先" |
| 关于灵动岛 | 小米澎湃 OS「超级岛」官方开发指南已于 2025-10 发布（dev.mi.com，pId=2131/2132），但接入需：在架应用 + 开发者认证 + 场景预审/正式方案审核/上线验证；联调需设备白名单（30 天有效、上限 10 台、按 OAID）。**个人自用 APK 走不通的结论维持**，"倒计时上岛"列为将来上架后的可选项 |

## 2. 总体架构

```
┌ 鸿蒙 ArkTS ┐  ┌ Android Compose ┐  ┌ Windows Electron ┐
│ 服务卡片·实况窗│  │ 小组件·前台服务   │  │ 托盘·通知        │
└──────┬─────┘  └───────┬────────┘  └────────┬────────┘
   本地库+同步引擎      本地库+同步引擎       本地库+同步引擎
       └───────────────────┼───────────────────┘
                    REST API（JWT 鉴权）
              Spring Boot 3 · 增量同步服务
                           │
                      MySQL 8（云服务器）
```

三端各自持有本地数据库（RDB / Room / better-sqlite3），本地为唯一可操作数据源；后台只做变更的搬运工。**计时正确性与同步解耦**：同步不可用不影响本地计时。

## 3. 计时状态与恢复规则（核心章节，M0 冻结）

### 3.1 通用原则

1. **状态与展示分离**：持久化的是计时状态（状态机 + 少量基准字段），界面上的"剩余/已用"永远是展示时计算的派生值，绝不用 tick 累加写库。
2. **两类时钟各司其职**：
   - 墙上时钟（UTC epoch ms）：决定"到点与否"、写入截止时间；
   - 单调时钟（进程内单调递增）：用于测量"进行中的间隔"，防御系统时间被修改。
   - 平台映射：Android 用 `elapsedRealtime()`（含深度睡眠，官方推荐用于时间间隔测量）；鸿蒙用系统开机单调时长接口（具体 API 名在 M0 真机验证时确认）；Windows/Electron 用 `process.hrtime.bigint()`。
3. **跨重启边界（如实声明）**：进程重启后单调时钟基准丢失，无法再防御系统时间被改。跨重启恢复一律以**持久化状态字段**为准；启动时比对"上次退出时间"做异常提示，但不强制纠正。日期倒计时因存"日期 + 时区"（§3.2）天然免疫此问题。
4. **session_id 语义**：每次从 idle 进入 running 生成新的 `session_id`（uuid）。暂停/继续沿用当前 session；重置、完成后重新开始、新一轮番茄钟才算新 session。所有运行状态类同步操作必须携带 `session_id`，服务端发现 session 不匹配（新一轮已开始）时直接丢弃过期操作并记冲突日志。

### 3.2 日期倒计时（DATE_COUNTDOWN）

纯日期数据，**不允许转换为 UTC 时间戳作为唯一存储**，避免时区/夏令时歧义。

| 规则项 | 定稿规则 |
|---|---|
| 存储 | `target_date`（YYYY-MM-DD 字符串）+ `timezone_id`（IANA 名称，默认设备当前时区）+ `include_today`（布尔，默认 false） |
| 天数计算 | 剩余天数 = 目标日期 − 当前日期（双方均按 `timezone_id` 取自然日）；`include_today=true` 时结果 +1 |
| D-day 当天 | `include_today=false` 且差值为 0 → 显示"就是今天"；过后显示"已过 N 天"（用户可手动归档） |
| 提醒 | 按 `timezone_id` 的自然日边界触发（如目标日前一天 21:00、当天 09:00，具体在 UI 选） |
| 边界说明 | "满 24 小时"式的精确倒计时需求应改用 PRECISE_COUNTDOWN（目标时刻 = 目标日期在该时区的指定时刻） |

### 3.3 精确倒计时（PRECISE_COUNTDOWN）

状态机：`idle → running ⇄ paused → idle(完成/重置)`。

| 事件 | 状态变更规则 |
|---|---|
| 开始 | `run_state=running`，`target_at = now + duration`，生成新 `session_id` |
| 运行中展示 | 剩余 = `target_at − now`（墙上时钟），并用单调时钟校验（§3.6） |
| 暂停 | `remaining_at_pause = target_at − 暂停时刻`（用单调差值计算），`run_state=paused` |
| 继续 | `target_at = 继续时刻 + remaining_at_pause`（重新计算截止时间），沿用当前 `session_id` |
| 完成 | 写入 `timer_record`，`run_state=idle`，清空 `run_json` |
| 进程被杀/重启 | running → 以持久化 `target_at` 为准继续；paused → 以 `remaining_at_pause` 为准，展示暂停值 |

### 3.4 正计时（STOPWATCH）

状态机：`idle → running ⇄ paused → idle(停止)`。

| 事件 | 状态变更规则 |
|---|---|
| 开始 | `accumulated_ms = 0`，`segment_started_at = now`（同时记墙上 + 单调基准），新 `session_id` |
| 运行中展示 | 已用 = `accumulated_ms + (单调now − 单调segment基准)` |
| 暂停 | `accumulated_ms += 本段时长`（单调差值），`segment_started_at` 置空 → **暂停期间不计入** |
| 继续 | `segment_started_at = now`，`accumulated_ms` 不动 |
| 停止 | 写入 `timer_record(duration = 最终累计)`，归零回 idle |
| 重启恢复 | running → 用持久化基准继续累计；paused → 展示 `accumulated_ms` |

### 3.5 番茄钟（POMODORO）

状态机：`idle → focus ⇄ short_break/long_break ⇄ paused_* → idle`。

| 规则项 | 定稿规则 |
|---|---|
| 配置 | `config_json`: focus_ms / short_break_ms / long_break_ms / rounds_before_long（`schema_version` 见 §4.4） |
| 阶段推进 | 运行中阶段自然到点：写 record（focus 完成才记工作时长），自动进入下一阶段；每完成 `rounds_before_long` 个 focus 进入 long_break |
| 计轮 | `completed_focus` 记录本轮周期内已完成的 focus 数，long_break 结束后清零 |
| 暂停/继续 | 同精确倒计时：保存 `remaining_at_pause`，继续时重算 `phase_ends_at` |
| **离线/被杀恢复** | 恢复时若 `phase_ends_at` 已超时：**不自动连跳**。超时 ≤ 5 分钟视为按时完成，正常结算并进入下一阶段；超时 > 5 分钟则停在"阶段已超时"待确认，用户选择"结算并继续"或"放弃本阶段"（record 按实际结算时间补记）。自动连跳列入 backlog 选项 |
| 重置 | 清空阶段与轮次，新 `session_id` |

### 3.6 系统时间异常处理

- 运行中每分钟比对一次：墙上时钟差值与单调时钟差值偏差 > 2 秒 → 判定系统时间被改。精确倒计时/正计时/番茄钟以**单调时钟差值修正内部基准**（重算 target_at / 累计），并记录一次 `clock_adjusted` 事件（仅日志，不入同步流）。
- 日期倒计时不受影响（自然日语义）。
- 跨重启后该防御失效（§3.1 第 3 条），为已知边界，文档与启动提示如实说明。

## 4. 核心数据模型（修订）

### 4.1 通用同步列（所有参与同步的表必备）

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT (uuid) | 主键，**客户端生成**（timer_record 直接以它作跨端幂等去重键） |
| version | INTEGER | 行版本号，客户端每次业务修改 +1；push 时作为 `base_version` 校验依据 |
| updated_at | INTEGER (ms, UTC) | 客户端修改时间，**仅展示与排查用，不参与排序和冲突判定** |
| deleted | INTEGER (0/1) | 软删除墓碑；删除时 version 同样 +1，墓碑保留至服务端策略期后清理 |
| origin_device_id | TEXT | 最近一次修改来源设备（本地首次安装生成的 uuid） |

### 4.2 业务表

| 表 | 字段（通用同步列之外） | 说明 |
|---|---|---|
| user | username, password_hash | 账号密码，BCrypt；仅服务端全量持有，端上缓存当前账号 |
| timer_item | user_id, name, type, color, starred, pinned, remark, config_json, **run_state, session_id, run_json** | 四种类型同 v1；**运行状态字段位置在此明确**：run_state（idle/running/paused/phase*），session_id（§3.1），run_json（§4.3，各类型运行快照） |
| tag | user_id, name, color | 分类标签 |
| timer_tag | user_id, timer_id, tag_id | 计时项-标签关联；**补齐通用同步列，取消标签 = 写墓碑删除，可同步** |
| milestone | user_id, timer_id, note, marked_at | 里程碑；**补齐 version/deleted**，删除走墓碑 |
| timer_record | user_id, timer_id, session_id, started_at, ended_at, duration_sec, record_type | 正计时分段/倒计时完成/番茄钟 focus 完成；**追加型**：只增不改，主键 uuid 即去重依据，服务端 insert-or-ignore；用户删除记录走墓碑 |

### 4.3 run_json 结构（schema_version: 1）

| 类型 | 字段 | 说明 |
|---|---|---|
| DATE_COUNTDOWN | 恒为 null | 无运行状态 |
| PRECISE_COUNTDOWN | `target_at`；paused 时 `remaining_at_pause` | 毫秒 UTC |
| STOPWATCH | `accumulated_ms`；running 时 `segment_started_at`（+ 对应单调基准，仅本地用，不同步） | 暂停后 segment 字段为空 |
| POMODORO | `phase`（focus/short_break/long_break）、`phase_ends_at`；paused 时 `remaining_at_pause`；`completed_focus` | 阶段与轮次随同步走，离线恢复按 §3.5 |

### 4.4 config_json 结构（必须携带 `schema_version`）

| 类型 | 字段（v1 结构） |
|---|---|
| DATE_COUNTDOWN | `{ schema_version: 1, target_date: "YYYY-MM-DD", timezone_id: "Asia/Shanghai", include_today: false }` |
| PRECISE_COUNTDOWN | `{ schema_version: 1, preset_ms }`（新建预设；实际运行截止时间在 run_json） |
| STOPWATCH | `{ schema_version: 1 }`（暂无配置项，预留） |
| POMODORO | `{ schema_version: 1, focus_ms, short_break_ms, long_break_ms, rounds_before_long }` |

结构演进规则：只增不改语义；跨版本读取由各端按 schema_version 降级兼容。

### 4.5 仅本地表（不参与同步）

| 表 | 字段 | 说明 |
|---|---|---|
| pending_ops | operation_id (pk uuid), table_name, op_type, row_payload(json), base_version, created_at, state | **持久化待上传队列**；与业务修改在同一个本地事务内写入，网络恢复后按序上传，确认后清除 |
| sync_cursor | user_id (pk), pull_cursor, updated_at | pull 游标；**只在整页成功应用后才推进**（§5.3） |
| device | device_id, display_name | 本机标识 |

## 5. 同步协议（修订，M0 冻结）

### 5.1 为什么放弃 v1 的 `updated_at > cursor`

| v1 缺口 | v2 对策 |
|---|---|
| 相同 updated_at 的记录遇分页可能漏拉 | 服务端分配**严格单调递增**的 `change_seq`，按 seq 排序分页，seq 唯一且连续可断点 |
| 客户端时钟不一致，"后写"无法判定 | 排序与冲突判定只依赖服务端 seq；客户端 `updated_at` 仅展示 |
| 上传成功但响应丢失，重试重复记账 | 每个 operation 携带唯一 `operation_id`，服务端幂等：已见直接返回 `duplicate`，不重复入变更流 |
| push 返回的游标直接用作 pull 游标，可能跳过其他设备变更 | **pull 游标只通过 pull 成功推进**；push 响应不携带任何用于推进 pull 的游标 |

### 5.2 服务端：变更日志（change_log）

每次 push 接受的变更在一个事务内：更新业务表 + 追加 `change_log(change_seq, user_id, table_name, row_id, op_type, row_version, origin_device_id, committed_at)`。`change_seq` 全局自增（对单用户而言单调）。删除以墓碑行入流。

### 5.3 pull：`GET /api/v1/sync/pull?cursor=<seq>&limit=500`

1. 服务端返回 `change_seq > cursor` 的变更页（按 seq 升序）+ `next_cursor`（本页最大 seq）。
2. 客户端在**一个本地事务**内应用整页：
   - 跳过 `origin_device_id = 本机` 的变更（自身 push 已在本地）；
   - 墓碑 → 删除本地行；普通变更 → upsert；
   - **本地该行存在未上传的 pending_ops（dirty）时跳过应用该行**，以上传后服务端裁决为准；
3. 事务提交成功后，才持久化推进 `pull_cursor`。任何一步失败：不推进、整页重试。

### 5.4 push：`POST /api/v1/sync/push`

请求体：`{ operations: [{ operation_id, table_name, op_type, row, base_version, session_id? }] }`

服务端逐条处理并返回逐条结果：

| 返回 | 条件 |
|---|---|
| `accepted` | 校验通过，写入变更流 |
| `duplicate` | `operation_id` 已存在（幂等重试），返回原结果 |
| `conflict` | 版本校验类数据 `base_version` 过期（§6） |
| `discarded` | 运行状态操作 `session_id` 不匹配当前 session（过期操作） |

客户端收到 `conflict/discarded`：丢弃本地对应 pending op（按 §6 规则处理），等待 pull 拉回服务端现状。

### 5.5 时间语义

- 排序、冲突、游标全部基于服务端 `change_seq`；
- 各端展示"最后修改时间"用本地行 `updated_at`；
- 运行中的计时不同步 tick，只同步 §4.3 状态字段，各端自行推算展示。

## 6. 冲突策略：按数据类别分层（M0 冻结）

> "个人自用冲突率低"不成立为省略理由：手机离线操作、电脑继续修改，就是日常场景。

| 数据类别 | 覆盖范围 | 规则 |
|---|---|---|
| 展示/配置类 | name, color, remark, starred, pinned, config_json, tag 关联 | 简单覆盖：按服务端 change_seq 顺序应用（后写胜出）；`base_version` 过期不阻断，记录日志 |
| **运行状态类** | run_state, session_id, run_json | **必须 base_version 匹配 + session_id 匹配**；不匹配 → `conflict/discarded`，操作整体作废，**绝不允许过期的"继续"复活已被暂停/重置的计时** |
| 追加类 | timer_record, milestone 新增 | append-only；主键 uuid 幂等去重；无覆盖冲突 |
| 删除 | 任意表 deleted=1 | **墓碑胜出**：对已删除行的并发修改一律拒绝（conflict） |

**典型场景走查**（M0 评审逐条过）：电脑已暂停 → 手机离线点"继续" → 数小时后手机联网。手机 op 的 base_version 已过期 → 服务端返回 conflict → 该"继续"作废，计时器保持暂停，两端一致。

**提醒语义（v1 明确）**：到点提醒由各设备基于本地已同步状态**各自调度**；默认所有已登录设备都响；离线设备按最后同步状态响，**上线后不补响已过期提醒**（计时仍在进行的除外）；"仅指定设备响"列入 backlog。

## 7. 三端能力矩阵与验证状态

| 能力 | 鸿蒙 ArkTS | Android | Windows | 验证状态 |
|---|---|---|---|---|
| 本地库 | relationalStore | Room | better-sqlite3 | 低风险 |
| 后台计时 | 长时任务（TIMER 类型） | 前台 Service | 常驻托盘进程 | 鸿蒙/Android M0 真机验证 |
| 到点提醒 | reminderAgentManager | AlarmManager + 通知 | 系统 Toast 通知 | 见下方限制说明 |
| 桌面入口 | FormKit 服务卡片 + 实况窗 | Glance 小组件 | 托盘 + 快捷弹窗 | 实况窗需权益申请 |
| UI 框架 | ArkUI 声明式 | Compose + M3 | React + TypeScript | 低风险 |

**Android 精确闹钟（已知官方限制）**：targetSdk 33+ 的应用在 Android 14 上 `SCHEDULE_EXACT_ALARM` 默认不授予（官方变更说明见附录 A）；`USE_EXACT_ALARM` 仅限闹钟/日历核心功能应用。客户端实现必须：`canScheduleExactAlarms()` 检测 → 未授权走降级（inexact alarm + WorkManager 兜底 + 前台服务内倒计时）→ 设置页引导跳转授权。**降级路径为 M3 必做项，不是可选项。**

**鸿蒙实况窗（待验证项）**：官方 API 文档明确各场景"使用对应场景需要申请权益"（TIMER 场景在内）；本地实况窗要求应用前台创建；模拟器不支持实况窗渲染，必须真机调试。M0 动作：AGC 提交 TIMER 场景权益申请 + 真机最小原型（创建/更新/结束 + 读秒）。

## 8. 里程碑计划（v2：M0–M5，每阶段带验收条件）

| 阶段 | 主要产出 | 验收条件 |
|---|---|---|
| **M0 协议定稿与关键能力验证** | §3/§5/§6 冻结；OpenAPI 契约；建表 SQL；并行真机验证：Android 精确闹钟权限/降级 demo、鸿蒙真机安装 + 长时任务后台提醒 demo、实况窗权益申请提交 + 最小原型；验证结果回填 §7 | ① 协议评审通过（§6 四类冲突场景逐条走查）② 两端真机 demo 可运行，或有书面降级方案 ③ OpenAPI 覆盖全部 CRUD + 同步接口 |
| **M1 Windows 本地版** | Electron+React 骨架、本地库、日期/精确/正计时 + 暂停恢复、托盘、提醒、**基础导出备份（JSON，从 M5 提前）** | ① 暂停→退出→重启：不继续计时，剩余/累计与暂停时一致 ② 精确倒计时跨重启恢复正确 ③ 正计时暂停期间不计入 ④ 运行中把系统时间拨 ±1h，计时读数不跳变 ⑤ 导出文件可再次导入 |
| **M2 后端同步闭环** | Spring Boot 骨架、注册/登录、同步服务；Windows 客户端接入；**两个独立客户端实例**对测 | ① 离线修改上线后两端一致 ② 同一 op 重复上传不重复记账（operation_id 幂等）③ 离线设备上线不复活已删除项目（墓碑）④ 过期的运行状态操作被拒绝，计时器不被复活（§6 场景走查）⑤ pull 中途失败不推进游标，重拉无丢失无重复 ⑥ 同步服务宕机时本地功能完全可用 |
| **M3 Android 日常可用版** | Compose UI、Room、前台服务、精确闹钟（含权限检测与降级）、小组件、接入同步 | ① 精确闹钟被拒后降级提醒可用 ② 离线操作入队并在联网后正确上传 ③ 与 Windows 双端同步一致性抽检通过 |
| **M4 鸿蒙日常可用版** | ArkTS UI、RDB、长时任务、服务卡片、实况窗（视 M0 权益结果）、接入同步 | ① 真机锁屏/杀进程场景下后台计时与到点提醒及时 ② 实况窗读秒正确或降级方案生效 ③ 三端同步一致性抽检通过 |
| **M5 番茄钟、里程碑与统计** | 番茄钟全端、里程碑、按标签/类型统计、打磨、完整安装包 | ① 番茄钟跨重启恢复正确（超时不自动连跳，停在边界）② 统计数字与 timer_record 完全一致 ③ 全量导出备份通过 |

顺序说明：M0 协议与验证先行——同步协议和计时状态规则决定三端能否稳定协作，比先堆页面和 CRUD 更关键；Windows 先行是因为桌面端调试效率最高，能最快验证协议；鸿蒙放 M4 是工具链最重，但**实况窗权益申请必须在 M0 就提交**（审核约数个工作日，避免 M4 被卡）。若更想先做鸿蒙，可对调 M3/M4，权益申请仍留在 M0。

## 9. 风险与对策（更新）

| 风险 | 对策 |
|---|---|
| 系统时间被用户修改 | 运行中用单调时钟校验修正（§3.6）；跨重启以持久化状态为准，属已知边界并如实提示 |
| 同步冲突 | 分层策略（§6）：配置类 LWW、运行状态版本校验 + session_id、追加类幂等去重、删除墓碑胜出 |
| 鸿蒙实况窗权益未过审 | M0 即提交申请；未过审则服务卡片 + 通知降级，不阻塞 M4 主线 |
| Android 14+ 精确闹钟默认不授予 | 运行时检测 + 降级提醒路径 + 引导授权（§7），列入 M3 验收 |
| 小米 HyperOS 激进杀后台 | 前台服务 + 通知栏常驻 + 引导电池优化白名单（维持 v1） |
| 三端代码量大 | API 契约先行（OpenAPI），UI 只保证信息结构一致、不追求像素级统一（维持 v1） |
| 鸿蒙 NEXT API 迭代快 | 锁定 API 12+ 文档版本开发，封装平台差异层（维持 v1） |

## 10. 下一步

1. 评审确认本 v2 的三处默认决策：日期倒计时"不含今天"、番茄钟离线"不自动连跳"、提醒"所有设备都响且不补响"；
2. 依据 §4/§5 产出 OpenAPI 契约 + 建表 SQL（M0 主线）；
3. 并行提交鸿蒙实况窗 TIMER 权益申请，完成 Android 精确闹钟真机验证（M0 并行）。

## 附录 A：官方参考与出处

| 主题 | 出处 |
|---|---|
| Android 单调时钟（elapsedRealtime 含深度睡眠） | https://developer.android.com/reference/android/os/SystemClock |
| Android 14 精确闹钟默认授权变更 | https://developer.android.com/about/versions/14/changes/schedule-exact-alarms |
| 鸿蒙实况窗 liveViewManager API（场景需申请权益；计时器字段 5.0.0(12) 起） | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/liveview-liveviewmanager |
| 小米超级岛开发指南 / 接入流程（2025-10 发布） | https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2131 ・ https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2132 |
| 小米焦点通知 Q&A（权限邮件申请、白名单联调） | https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2146 |

## 附录 B：v1 → v2 变更对照

| 评审意见 | 落点 |
|---|---|
| 1. "只存时间戳"过于绝对，缺暂停/继续/日期/时区规则 | 新增 §3 全章；§4.3/§4.4 定义状态与配置结构 |
| 2. 同步协议缺口（漏拉、时钟、重试重复、游标跳变） | §5 重写：change_seq、operation_id 幂等、pull 游标推进规则、持久化队列 |
| 3. 不宜统一"后写优先" | §6 分层冲突策略 + 场景走查 + 提醒语义 |
| 4. 数据模型未支撑同步（timer_tag/milestone/timer_record、运行字段位置） | §4 全章修订：通用同步列、run_json/config_json 结构、仅本地表 |
| 5. 手机端高风险能力提前验证 | §7 验证状态列 + M0 真机验证项；§1/§9 补出处与降级方案 |
| 6. 第一阶段偏大、验收偏少；"三端原生"表述 | §8 改为 M0–M5 含验收条件；导出提前到 M1；定位改为"两端原生移动应用 + Windows 桌面应用" |
