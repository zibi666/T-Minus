# TimeMark 时光标 — Windows 桌面端

Electron 37 + React 18 + TypeScript 本地计时应用，离线可用，托盘常驻，支持账号同步。
仓库总览见根目录 [`../../README.md`](../../README.md)。

## 运行

```bash
cd apps/windows
npm install     # 已配置 npmmirror 镜像（含 Electron 二进制镜像）
npm run dev     # 构建 + 启动（日常调试）
npm start       # 仅启动（需先 build）
```

> **环境注意**：若启动报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，说明当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`（WorkBuddy 托管 Node 环境默认带此变量），启动前执行 `$env:ELECTRON_RUN_AS_NODE = $null` 即可。虚拟机 / 无 GPU 环境已在 `main.ts` 内置 `--in-process-gpu` 等开关，避免 GPU 进程崩溃循环。

数据存放于 `%APPDATA%/timemark-windows/timemark.db`（SQLite，sql.js 读写）。

> **数据目录开关**：设置环境变量 `TIMEMARK_DATA_DIR` 可改到别处（M2 双实例对测的前置条件，v0.4.5 起支持）。
> **软/硬件渲染**：真机默认硬件加速；沙箱或无 GPU 环境设 `TIMEMARK_SOFTWARE_RENDER=1` 才禁用 GPU。

## 已实现（对照 M1 验收条件）

| 验收项 | 状态 | 说明 |
|---|---|---|
| 暂停 → 退出 → 重启：不继续计时，剩余/累计与暂停时一致 | ✅ | paused 状态持久化 `remaining_at_pause` / `accumulated_ms`，重启后展示暂停值，不推进 |
| 精确倒计时跨重启恢复正确 | ✅ | running 恢复以持久化 `target_at` 为准（§3.1 已知边界：跨重启无法防御系统时间被改） |
| 正计时暂停期间不计入 | ✅ | 暂停时折算进 `accumulated_ms` 并清空段起点，继续时只开新段 |
| 运行中把系统时间拨 ±1h，读数不跳变 | ✅ | 引擎每 500ms 比对墙上时钟与单调时钟（`hrtime`），偏差 > 2s 以单调差值修正基准（§3.6） |
| 导出文件可再次导入 | ⚠️ 部分 | 导出 JSON 全量快照已实现；导入在 M2 与同步一并做 |
| 绝不用 tick 累加计时 | ✅ | tick 仅用于展示与到点判定，持久化的只有状态机字段 |
| 软删除墓碑 / 通用同步列 / session_id | ✅ | 按 §4.1 建表；session_id 在手动 stop/reset 时**不清空**（与 Android/鸿蒙对齐） |
| 账号同步（M2） | ✅ | pending_ops 持久化队列、push/pull 循环、孤儿数据认领、401 自动失效本地凭据、按账号收口可见域 |
| 番茄钟 | ✅ | 不是独立 type，= `PRECISE_COUNTDOWN` + `config.pomodoro`；阶段推进裁决在契约里 |
| 手动分段 / 台钟视图 | ✅ | `timers:segment` IPC + `components/ClockView.tsx` |
| 标签 / 里程碑 UI | ✅ | 标签按名查重带账号作用域 |

日期倒计时、精确倒计时、正计时、番茄钟四种类型全部落地；番茄钟与分段均已实现，不再是后续里程碑内容。

## 架构

```
electron/main.ts        主进程：窗口、托盘、IPC、通知、计时循环（500ms 广播，tickSignature 签名去重）
electron/timerEngine.ts 计时引擎：状态机 + 单调时钟守卫（§3 全部语义在此）
electron/db.ts          本地库（sql.js）：§4 表结构，持久化防抖 300ms，flush 失败 5s 重试
electron/syncClient.ts 同步客户端：登录/推送/拉取、pending_ops 队列、孤儿认领
                         ★ DEFAULT_SERVER 是客户端地址的单一来源
electron/dateLogic.ts   §3.2 自然日计算（IANA 时区，UTC 日期差规避夏令时）
electron/preload.ts     contextBridge 安全暴露 API（改 IPC 面必须同批改并重建）
src/renderer/           React UI（卡片列表 / 台钟视图 / 新建编辑表单 / 登录弹窗）
src/shared/             类型、格式化与 Contract.ts（逐字段镜像 shared/contract/fixtures/contract.json）
```

## 同步

- 服务器地址由主进程 `electron/syncClient.ts` 的 `DEFAULT_SERVER` 单一决定，当前为 `https://sync.knowhub.chat:18443`；渲染层 `LoginModal.tsx` 的同名常量只是占位，**勿单独改**。
- push 结果仅终态出队（`duplicate` 或 accepted/conflict/discarded/bad_request），`server_error` 等非终态保留整批队列下轮重投。
- pull 遇被挡行 `break` 而非 `continue`：游标只推进到连续已消费前缀，否则该远端变更永不再投递、两端行永久分叉。
- `adoptOrphans` 认领孤儿行时同时 enqueue `create`——只改 `user_id` 的行没有上行通道，未登录离线期的数据会永远躺在本地。

## 已知边界

- 提醒：精确倒计时到点弹系统通知；日期倒计时 D-day 当天提醒一次。更精细的提醒时点由 Android / 鸿蒙端的提醒服务覆盖。
- 跨重启后系统时间被改无法检测（§3.1 声明的边界）；进程存活期间已防御。
- tick 仅用于展示与到点判定，持久化的只有状态机字段（状态与展示分离铁律）。
- exe 未签名（无证书），首次运行可能有 SmartScreen 提示。

## 打包

```bash
npx electron-builder --win    # 走 npmmirror 镜像环境变量
```

产物含 NSIS 安装版与便携版，各约 95MB，含自绘图标（`tools/gen-icon.cjs` → `assets/icon.png`）。

> **铁律：只输出到 `apps/windows/release/`**；运行中则先关再打，**绝不新建 releaseN**。electron-builder 会复用输出目录，若遇 `EBUSY` 用 `--config.directories.output=<新目录>`。
