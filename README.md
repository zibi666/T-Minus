# TimeMark 时光标

多端计时工具（个人自用）：**Windows / Android / 鸿蒙** 三端 + 自建 Spring Boot 同步后端，离线优先，同一份契约驱动全部计时语义。

当前版本 **v0.6.0**（见根目录 `VERSION`，为全仓库唯一版本来源）。

---

## 一、仓库结构

```
E:/T-Minus
├── VERSION                     # 版本号唯一来源，tools/version.mjs 据此校验三端
├── shared/contract/
│   └── fixtures/contract.json  # ★ 契约单一语义来源（常量/归一化/裁决纯函数 + 用例）
├── apps/
│   ├── windows/                # Electron 37 + React 18 + TS，sql.js 本地库
│   ├── android/                # Kotlin 2.0.20 + Compose + Room 2.6.1 + Retrofit
│   └── harmony/                # ArkTS / ArkUI stage 模型，API 22
├── backend/                    # Spring Boot 3.3.4 + spring-jdbc + BCrypt + 手写 HS256 JWT
├── deploy/                     # HTTPS 一键部署脚本、nginx 配置、TLS 切换指南
├── docs/                       # 开发计划、进度快照、各端计划、UI 令牌
└── tools/                      # 版本校验、契约/引擎测试、图标生成、数据库脚本
```

`server/`（Node + Express 开发版后端）已在 commit `9420e29` 移除出库，弃用；正式后端只有 `backend/`。

各端 `Contract.ts` / `Contract.ets` / `Contract.kt` **逐字段镜像** `shared/contract/fixtures/contract.json`，由测试与 CI 保证一致——契约是所有计时语义的唯一裁决处。

---

## 二、三端与后端

| 端 | 技术栈 | 本地存储 | 关键机制 |
|---|---|---|---|
| Windows | Electron 37 + React 18 + TS | sql.js → `timemark.db` | 托盘常驻、系统通知、electron-builder 打包自动更新 |
| Android | Kotlin 2.0.20 + Jetpack Compose | Room 2.6.1 | 前台服务 + AlarmManager 精确闹钟、BootReceiver 重启恢复 |
| 鸿蒙 | ArkTS / ArkUI（stage 模型） | 关系型数据库 API | 实况窗 / 原子化卡片 / 提醒服务 |
| 后端 | Spring Boot 3.3.4 | MySQL（腾讯云 TDSQL-C，库 `timemark`，9 表） | systemd `timemark.service`，仅听回环由 nginx 反代 |

包名 / bundleName 三端统一为 `com.timemark.app`。

---

## 三、核心业务规则

### 1. 四种计时

| 类型 | 存储要点 |
|---|---|
| 日期倒计时 | `target_date`（YYYY-MM-DD）+ IANA `timezone_id` + `include_today`；**禁止转 UTC 时间戳**，按本地自然日计算 |
| 精确倒计时 | 含手动打点分段（`run_json.segments_ms[]`） |
| 正计时 | lap 分段 |
| 番茄钟 | **不是独立的 type**，= `PRECISE_COUNTDOWN` + `config.pomodoro` |

### 2. 铁律：状态与展示分离

- 界面剩余量**永远是派生值**，任何 tick 都不写库。
- **墙上时钟定到点、单调时钟测间隔**：Android 用 `elapsedRealtime()`，Electron 用 `process.hrtime.bigint()`，防系统时间被拨；偏差 > 2s（`mono_guard_ms`）修正基准。
- 每次 idle→running 换新 `session_id`；手动 stop/reset **不清空** session_id。
- 已知边界：跨进程重启后单调防御失效（§3.1 声明）。

### 3. 结算口径

结算时刻与取整方式已入契约（`settle_stamp` 用例）：到点按**计划截止时刻**记账，`duration_sec` 对非整秒预设**向下取整**（不是四舍五入）。番茄钟阶段推进裁决同样在契约里（`next_phase` / `next_phase_comment`），三端不再各存一份内联副本。

---

## 四、同步协议（离线优先）

- `pending_ops` 持久化队列 + `operation_id` 幂等。
- `change_seq` 游标：**只有整页连续前缀被消费完才推进**；被挡行 `break` 而非 `continue`——否则游标越过该行后，这个远端变更永不再投递、两端行永久分叉。
- 换账号登录：清零 pull 游标 + 清空 pending_ops + 重写 `sync_uid`（`change_seq` 全局自增，旧高水位游标会让新账号历史永远拉不到）。
- 冲突分层：配置 LWW / 运行态 `base_version` + `session_id` / 墓碑胜出。
- push 结果**仅终态出队**（`duplicate` 或 accepted/conflict/discarded/bad_request），`server_error` 等非终态保留整批队列下轮重投——客户端若把带 `operation_id` 的瞬时失败当终态消费掉，就是静默丢数据。
- 非运行类 update 只允许改元数据，运行态三列（`run_state`/`session_id`/`run_json`）一律以服务端现值为准，version 只进不退。
- 账号可见域：读查询带 `(:uid IS NULL OR user_id IS NULL OR user_id = :uid)` 作用域，未登录全放行（本机自持），登录后只认无主行与自己名下的行。

---

## 五、部署与访问地址

- 域名 **`https://sync.knowhub.chat:18443`**（Cloudflare DNS → `118.195.133.25`，nginx 监听 **18443** 避开腾讯云对未备案域名 80/443 的入向拦截）。
- 证书由 **acme.sh + Cloudflare DNS-01** 签发的 Let's Encrypt 公信证书，安装到 `/etc/nginx/ssl/sync.knowhub.chat/`；三端走系统内置信任链，无需内置 `trust-anchors`，意外降级被系统直接拒绝。
- 后端仅监听 `127.0.0.1:18080`，由 nginx 反代；systemd 单元 `timemark.service`。
- 一键部署 / 迁移 / 回滚：见 [`deploy/TLS-CUTOVER.md`](deploy/TLS-CUTOVER.md) 与 `deploy/setup-https.sh`。

> 客户端地址的单一来源：Windows 在主进程 `electron/syncClient.ts` 的 `DEFAULT_SERVER`；Android 在 `data/AppContainer.kt` 的 `SERVER_URL`。渲染层的同名常量只是占位，勿单独改。

---

## 六、开发命令

```bash
# 版本一致性校验（VERSION vs package.json / latest.json / harmony app.json5）
node tools/version.mjs

# 跨端契约与引擎测试（无依赖 Node 脚本，无 SDK 也能跑）
node tools/harmony-contract-test.mjs    # 契约逐字段一致性
node tools/harmony-engine-test.mjs      # 引擎纯函数行为
node tools/check-sync-columns.mjs       # 后端列白名单 vs 客户端契约

# Windows
cd apps/windows && npm install && npm run dev      # 构建 + 启动
cd apps/windows && npm run lint && npm run typecheck && npm test

# Android
cd apps/android && ./gradlew :app:testDebugUnitTest :app:assembleDebug

# 后端
cd backend && mvn -s .mvn-settings.xml -DskipTests package
```

> **Electron 启动前必须清 `ELECTRON_RUN_AS_NODE=1`**（WorkBuddy 托管 Node 环境默认带此变量），否则报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。

### CI（`.github/workflows/ci.yml`）

`contract`（版本一致 + fixture 合法 JSON）→ `windows`（lint / typecheck / test）→ `android`（单测 + assembleDebug + 产物版本号校验）→ `backend`（列白名单校验 + 编译）。**鸿蒙端暂无 CI job**，其两个测试脚本目前只在本机跑。

---

## 七、文档索引

| 文档 | 内容 |
|---|---|
| [`docs/TimeMark-开发计划-v2.md`](docs/TimeMark-开发计划-v2.md) | M0–M5 主规范：计时状态机、数据模型、同步协议、冲突策略、验收条件 |
| [`docs/TimeMark-进度与待办-2026-09-21.md`](docs/TimeMark-进度与待办-2026-09-21.md) | 最新进度快照与交接事项（**新对话从这份接续**） |
| [`docs/TimeMark-Android端开发计划-M3.md`](docs/TimeMark-Android端开发计划-M3.md) | Android 端 M3.0–M3.6 阶段拆分 |
| [`docs/TimeMark-鸿蒙端开发计划-M4.md`](docs/TimeMark-鸿蒙端开发计划-M4.md) | 鸿蒙端开发计划 |
| [`docs/TimeMark-v3-设计规范-AI可读.md`](docs/TimeMark-v3-设计规范-AI可读.md) | UI 设计令牌 |
| [`backend/README.md`](backend/README.md) | 后端建库、环境变量、构建部署、API 一览 |
| [`apps/windows/README.md`](apps/windows/README.md) | Windows 端运行方式与验收对照 |
| [`deploy/TLS-CUTOVER.md`](deploy/TLS-CUTOVER.md) | HTTPS 部署 / 迁移 / 回滚完整指南 |

---

## 八、长期约束（踩过的坑，改代码前先读）

- **推送**：`git push` 曾触发 SSH 密钥授权被用户拒绝。遵循不重试原则——需要推送时由用户自行 push 或明确授权。
- **Electron IPC**：改 IPC 面必须同批改 `preload.ts` 并重建 `dist`，否则渲染层白屏。
- **沙箱**：`[safe-delete]` 会劫持所有子进程的删除操作；WorkBuddy 宿主对 `.asar` 有独占句柄（重建前先停进程）。
- **打包铁律**：只输出到 `apps/windows/release/`；运行中则先关再打，**绝不新建 releaseN**。
- **systemd 环境变量名**：宿主环境的 `SERVER_PORT` 会污染进程，必须用专属名 `TIMEMARK_SERVER_PORT`。
- **数据库 schema 变更**：`schema.sql` 的内联索引只对首次建表生效，存量库需手动补齐（如 `change_log (user_id, change_seq)`）。
