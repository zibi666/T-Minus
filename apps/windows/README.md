# TimeMark 时光标 — Windows 桌面端（M1 本地版）

对应《开发计划 v2》§8 的 **M1 阶段**：Electron + TypeScript + React 本地计时应用，离线可用，托盘常驻。

## 运行

```bash
cd apps/windows
npm install     # 已配置 npmmirror 镜像（含 Electron 二进制镜像）
npm run dev     # 构建 + 启动（日常调试）
npm start       # 仅启动（需先 build）
```

> **环境注意**：若启动报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，说明当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`（WorkBuddy 托管 Node 环境默认带此变量），启动前执行 `$env:ELECTRON_RUN_AS_NODE = $null` 即可。虚拟机 / 无 GPU 环境已在 `main.ts` 内置 `--in-process-gpu` 等开关，避免 GPU 进程崩溃循环。

数据存放于 `%APPDATA%/timemark-windows/timemark.db`（SQLite，sql.js 读写）。

## 已实现（对照 M1 验收条件）

| 验收项 | 状态 | 说明 |
|---|---|---|
| 暂停 → 退出 → 重启：不继续计时，剩余/累计与暂停时一致 | ✅ | paused 状态持久化 `remaining_at_pause` / `accumulated_ms`，重启后展示暂停值，不推进 |
| 精确倒计时跨重启恢复正确 | ✅ | running 恢复以持久化 `target_at` 为准（§3.1 已知边界：跨重启无法防御系统时间被改） |
| 正计时暂停期间不计入 | ✅ | 暂停时折算进 `accumulated_ms` 并清空段起点，继续时只开新段 |
| 运行中把系统时间拨 ±1h，读数不跳变 | ✅ | 引擎每 500ms 比对墙上时钟与单调时钟（`hrtime`），偏差 > 2s 以单调差值修正基准（§3.6） |
| 导出文件可再次导入 | ⚠️ 部分 | 导出 JSON 全量快照已实现；导入在 M2 与同步一并做 |
| 绝不用 tick 累加计时 | ✅ | tick 仅用于展示与到点判定，持久化的只有状态机字段 |
| 软删除墓碑 / 通用同步列 / session_id | ✅ | 按 §4.1 建表，M2 接同步无需迁移 |

番茄钟按计划放在 M5；标签/里程碑 UI 在 M2 后补齐（表结构已建好）。

## 架构

```
electron/main.ts        主进程：窗口、托盘、IPC、通知、计时循环（500ms 广播）
electron/timerEngine.ts 计时引擎：状态机 + 单调时钟守卫（§3 全部语义在此）
electron/db.ts          本地库（sql.js）：§4 表结构，持久化防抖 300ms
electron/dateLogic.ts   §3.2 自然日计算（IANA 时区，UTC 日期差规避夏令时）
electron/preload.ts     contextBridge 安全暴露 API
src/renderer/           React UI（卡片列表 / 新建编辑表单）
src/shared/             类型与格式化（主/渲染共用）
```

## 已知边界

- 提醒：精确倒计时到点弹系统通知；日期倒计时 D-day 当天提醒一次。更精细的提醒时点随 M3/M4 平台端实现。
- 跨重启后系统时间被改无法检测（§3.1 声明的边界）；进程存活期间已防御。
- M2 将引入服务端同步（change_seq 游标 + operation_id 幂等 + 分层冲突策略），本地表结构与同步列已就绪。
