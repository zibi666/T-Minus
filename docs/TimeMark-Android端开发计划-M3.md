# TimeMark Android 端开发计划（M3）

> 对齐《开发计划 v2》§3 计时规则 / §4 数据模型 / §5 同步协议 / §6 冲突策略 / §8 M3 里程碑。
> 服务端已上线：`https://sync.knowhub.chat:18443`（契约：/api/v1/auth/register·login、/api/v1/sync/pull·push）。
> 2026-09-21 起由明文 `http://118.195.133.25:18080` 切为 HTTPS，详见 `deploy/TLS-CUTOVER.md`。
> 参照实现：Windows 端 `apps/windows`（协议先行验证者）。

## 1. 目标与范围

M3 = 「Android 日常可用版」：四种计时类型 + 标签/置顶/收藏 + 历史与分段 + 统计概览 + 前台服务与到点提醒（含精确闹钟降级）+ 小组件 + 与服务端/Windows 同步互通。

**M3 验收（§8，三条硬标准）：**
1. 精确闹钟被拒后降级提醒仍可用；
2. 离线操作入队并在联网后正确上传（operation_id 幂等）；
3. 与 Windows 双端同步一致性抽检通过。

明确不做（留给 M5+）：多语言、平板适配、账号注销、数据迁移工具。

## 2. 技术栈（全部零争议选型）

| 层 | 选型 | 说明 |
|---|---|---|
| 语言/UI | Kotlin 2.x + Jetpack Compose + Material 3 | 与 §1 决策一致 |
| 本地库 | Room 2.7 | 实体对齐 §4，含通用同步列 |
| 序列化 | kotlinx.serialization | `@SerialName` 对齐服务端 snake_case 字段 |
| 网络 | Retrofit + OkHttp | Bearer JWT interceptor；2026-09-21 切 HTTPS 后 `network_security_config.xml` 已改为**全局禁止 cleartext**（Let's Encrypt 公信 CA 走系统信任链，无需 trust-anchors） |
| 凭据存储 | EncryptedSharedPreferences | JWT 与账号缓存 |
| 后台 | Foreground Service + AlarmManager + WorkManager | 见 §5 闹钟策略 |
| 小组件 | Glance (Compose) | M3.5 |
| DI | 手动 AppContainer | 项目规模不需要 Hilt，减少注解处理器链 |

- 包名 `com.timemark.app`，显示名「TimeMark 时光标」；minSdk 26 / targetSdk 35；工程位置 `apps/android`。
- 品牌视觉沿用 v3：深空底 + 青 #4DC9F0 / 紫 #9381FF / 珊瑚 accent，卡片按计时器自身颜色做色晕。

## 3. 分层结构

```
com.timemark.app
├─ core/          单调时钟封装、时间格式化、常量
├─ data/
│  ├─ local/      Room：timer_item / tag / timer_tag / milestone / timer_record
│  │              + pending_ops / sync_cursor / device（仅本地，§4.5）
│  ├─ remote/     Retrofit API + DTO（snake_case 对齐服务端）
│  └─ repo/       TimerRepository / SyncRepository（业务修改 = 本地事务 + pending_ops 同事务写入）
├─ engine/        TimerEngine：§3 状态机（elapsedRealtime 单调基准、跨重启恢复、
│                 暂停/继续/到点结算/提前结束如实记账/分段 lap、番茄钟循环）
├─ sync/          SyncWorker：4s 节拍（登录态）+ 指数退避；push pending_ops（operation_id=uuid）
│                 → 确认后清除；pull 游标整页应用成功后才推进（§5.3）
├─ background/    TimerForegroundService（运行中常驻通知）、ExactAlarmController
│                 （canScheduleExactAlarms 检测 → 授权走 setExactAndAllowWhileIdle，
│                  拒绝走 inexact + WorkManager 兜底 + 服务内自检，§7 降级为必做项）
└─ ui/            清单页 / 计时详情(台钟) / 表单 / 历史 / 统计 / 设置（Compose Navigation 6 屏）
```

## 4. 必须与 Windows 端逐字对齐的 6 条契约

1. **时间语义**：全部 UTC 毫秒；今日统计按本地时区；`elapsedRealtime()` 只做本地基准，不同步。
2. **run_json / config_json**：结构按 §4.3/§4.4，`schema_version: 1` 必带；STOPWATCH 的单调基准仅本地、不入 run_json。
3. **通用同步列**：id(uuid 客户端生成)/version(+1)/updated_at/deleted 墓碑/origin_device_id——每张同步表都齐。
4. **pending_ops**：业务修改与队列入队同一本地事务；push 后端必须回 `operation_id`（Windows 端已修过此 bug，Android 直接带空值防御）。
5. **pull 游标**：整页应用成功后才推进 `sync_cursor`；应用时按 §6 处理冲突（配置 LWW / 运行状态 base_version+session_id 校验 / 墓碑胜出 / 记录 insert-or-ignore）。
6. **计时结算**：到点写 PRECISE/STOPWATCH 记录；提前结束如实记账；打点 = SEGMENT（旧 session）+ 立即开启下一轮（新 session_id）。

## 5. 里程碑拆分（M3.0 → M3.6）

| 阶段 | 内容 | 产出 | 验收 | 预估 |
|---|---|---|---|---|
| M3.0 脚手架 | 工程创建、Gradle 版本目录、主题（v3 色板）、导航骨架、AppContainer | 可运行空壳 | 编译安装通过 | 0.5 天 |
| M3.1 数据+引擎 | Room 全表 + DAO、TimerEngine（§3 全类型）、清单页卡片 CRUD、计时详情页（大环+控制） | 本地可用版 | 全类型计时/暂停/恢复/到点结算正确，杀进程后恢复 | 2–3 天 |
| M3.2 记录+统计 | 历史页（范围筛选/颜色筛选/自定义某天）、分段重命名、今日概览统计 | 与 Windows 历史页对齐 | 数据与 Windows 端同源一致 | 1–2 天 |
| M3.3 后台+提醒 | 前台服务（运行中常驻通知）、精确闹钟 + 降级路径、POST_NOTIFICATIONS 权限流 | 后台计时可用 | **闹钟被拒后提醒仍可用**（验收①）；杀后台后到点仍结算 | 1–2 天 |
| M3.4 同步 | 注册/登录、push/pull、pending_ops、游标、三类冲突、退避 | 同账号双端互通 | **离线入队联网上传正确**（验收②） | 1–2 天 |
| M3.5 小组件 | Glance 桌面小组件（D-day / 运行中计时） | 桌面组件 | 添加/刷新正常 | 1 天 |
| M3.6 双端验收 | 对照 §8 M3 三条 + 与 Windows 抽检一致性 | 验收记录回填 §7/进度文档 | **双端一致性抽检通过**（验收③） | 0.5 天 |

## 6. 环境与分工

| 事项 | 谁做 | 说明 |
|---|---|---|
| 工程代码 / 引擎 / 同步 | 我（Agent） | 先行编写，git 管理；不依赖 SDK 也能推进到 M3.2 |
| Android Studio + SDK 35 | 你安装 | 我无法保证本机直出 APK；有 IDE 后打开 `apps/android` 即可跑 |
| 真机（Android 14+ 优先） | 你提供 | 精确闹钟权限/降级必须真机验证 |
| HTTP 明文豁免 | 我在代码内 | networkSecurityConfig 仅放行服务器 IP |
| （并行）鸿蒙 AGC 权益 | 你提交 | 与本计划无阻塞，但审核周期长，尽早交 |

**构建路线**：默认你用 Android Studio 跑；若想让我在本机直出 APK，需要装 Android SDK 命令行工具（约 1–2GB 下载），可作为 M3.1 时的并行事项。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Android 14+ 精确闹钟默认不授予 | 运行时检测 + 降级路径（inexact + WorkManager 兜底 + 服务内自检）+ 设置页引导授权；**M3 必做项** |
| 国产 ROM 杀后台（华为/小米） | 前台服务 + 引导用户加自启/电池白名单（设置页提示页）；到点结算不依赖进程存活（记录由 AlarmManager 唤醒补写） |
| 服务器为 HTTP 明文 | networkSecurityConfig 仅对该 IP 放行 cleartext；后续服务器上 TLS（Caddy 反代）后移除豁免 |
| JWT 泄露 | EncryptedSharedPreferences；401 统一登出重新登录 |
| 双端字段漂移 | DTO 以服务端为唯一事实源；Windows 端 syncClient.ts 作为参照实现，改动需同步评审 |

## 8. 执行顺序（本周建议）

1. M3.0 脚手架（我，立即开始——不依赖 SDK）；
2. 你并行装 Android Studio + 真机准备；
3. M3.1 → M3.2 顺序推进（每阶段结束给你可安装的 APK/工程快照）；
4. M3.3 闹钟降级（真机验证点，需要你在场）；
5. M3.4 同步 → M3.6 双端抽检（配合 0.4.5 的 TIMEMARK_DATA_DIR 双实例法在 Windows 侧对照）。
