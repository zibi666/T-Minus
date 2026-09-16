# TimeMark v3 设计规范（AI 可读版）

> **本文档用途**：供任何 AI（Cursor / Copilot / 新会话）精确还原 TimeMark Windows 客户端 v3 视觉改版。
> **使用方法**：先通读 §1 令牌与 §2 功能模型，再对照同目录 4 张 PNG 截图实现。截图是唯一视觉事实，本文档是唯一数值事实，两者冲突时以本文档为准。
> **生成时间**：2026-09-16 · 对应设计稿：ardot 文件 726391670145395

**配套截图（同目录）**：

| 文件 | 内容 |
|---|---|
| `v3-方向二-双栏聚焦.png` | **主形态**：侧栏清单 + 右侧聚焦台（番茄钟运行态） |
| `v3-台钟全屏.png` | 全屏沉浸模式（日期倒计时巨型数字 + 里程碑时间轴） |
| `v3-打点与回看.png` | 倒计时打点会话（左）+ 历史记录回看（右） |
| `v3-设计规范板.png` | 全部令牌的视觉总览 |

---

## 0. 技术栈与硬约束

- Electron 37 + React 18 + TypeScript；样式为单文件 `src/renderer/styles.css` 设计令牌体系（CSS 变量）。
- **应用禁用 GPU（软件渲染）**：背景光斑必须用大半径 `radial-gradient` 预模糊实现，**禁止 `filter: blur()`**；动画只允许 `transform` / `opacity`；需支持 `prefers-reduced-motion` 降级。
- 图标：项目已有自绘 lucide 风格线性 SVG 图标集 `src/renderer/components/icons.tsx`（19 个），继续复用，不引入图标库。
- 中文界面；中文用 Noto Sans SC，数字等宽显示。

## 1. 设计令牌（直接映射为 CSS 变量）

### 1.1 表面（三层递进）

```css
--bg: #05060F;               /* 深空画布，全局背景 */
--sidebar-bg: #0A0D17;       /* 侧栏 */
--card-grad-a: #171C2B;      /* 卡片渐变顶（135deg） */
--card-grad-b: #0F131E;      /* 卡片渐变底 */
--glass: rgba(255,255,255,0.028);   /* 玻璃内卡/底栏 */
--glass-strong: rgba(255,255,255,0.045); /* 幽灵按钮/搜索框 */
--stroke-faint: rgba(255,255,255,0.05);
--stroke-soft: rgba(255,255,255,0.08);
--stroke-hover: rgba(255,255,255,0.12);
--inner-highlight: inset 0 1px 0 rgba(255,255,255,0.09); /* 顶部 1px 内高光，所有卡片必有 */
```

### 1.2 极光氛围（冷色）与品牌动作色（暖）

```css
--aurora-cyan: #4DC9F0;   /* 青环境光 rgba(77,201,240,0.16) 大 radial + 预模糊 */
--aurora-violet: #9381FF; /* 紫 rgba(147,129,255,0.16) */
--aurora-mint: #21E0C4;   /* 薄荷（少量） */
--accent-grad: linear-gradient(135deg, #FF5D5D, #FFB224); /* 品牌珊瑚橙：仅用于
   「新建计时」CTA、运行中的主动作按钮（暂停/开始）、打点主按钮、D-Day 徽章与文字。
   规则：暖色出现 = 可点或重要；环境/装饰一律冷色。 */
--accent-glow: rgba(255,93,93,0.28); /* 主按钮投影色 */
```

### 1.3 语义色与计时器色板

```css
--text-hi: #F2F5FB;   /* 主文字 */
--text-mid: #99A2B8;  /* 次文字 */
--text-low: #6B7386;  /* 弱文字/占位 */
--ok: #3DDB97; --warn: #FFB224; --danger: #FF7B72;
/* 计时器自身颜色 --tc（用户可选 8 色），卡片色点/环形进度/色晕用 */
--tc-red:#FF6B6B; --tc-orange:#FF9F43; --tc-amber:#FFB224; --tc-green:#3DDB97;
--tc-mint:#21E0C4; --tc-cyan:#4DC9F0; --tc-blue:#5A9EFF; --tc-violet:#9381FF;
```

### 1.4 字体

```css
--font-num: "Segoe UI Variable Display", "Mona Sans", sans-serif; /* 大数字，weight 600 */
--font-cn: "Noto Sans SC", "Microsoft YaHei", sans-serif;
--font-mono: "JetBrains Mono", Consolas, monospace;
/* 大数字必须加 font-variant-numeric: tabular-nums; 防跳动 */
```

字号阶梯：巨型数字 150px（台钟）/ 76px（会话页）/ 48–56px（卡片）/ 44px（迷你环旁）/ 16–13px 正文 / 12–10.5px 辅助。

### 1.5 形状 / 阴影 / 动效

```css
--r-card: 22px; --r-inner: 16px; --r-chip: 999px; --r-row: 12px;
--shadow-card: 0 1px 2px rgba(0,0,0,.3), 0 8px 20px -8px rgba(0,0,0,.25),
               0 24px 48px -12px rgba(0,0,0,.35);
--shadow-accent-btn: 0 4px 14px rgba(255,93,93,.28);
--dur-flip: .35s cubic-bezier(.4,0,.2,1);      /* 网格重排 FLIP */
--dur-ring: .5s linear;                          /* 环 dashoffset 匀速，与 500ms tick 对齐 */
--dur-pop: .26s cubic-bezier(.34,1.56,.64,1);   /* 弹簧弹出 */
```

## 2. 功能模型（业务逻辑，实现必须遵守）

| 类型 | 行为 | 打点/分段 |
|---|---|---|
| 番茄钟 | 配置：工作时长、休息时长、重复轮数（默认 25/5/4）。运行时自动循环：专注→铃响自动进休息→休息完自动下一轮（设置可改手动确认）。界面显示「第 N/M 轮 · 专注中/休息中」 | ❌ 无手动分段 |
| 精确倒计时 | 总时长固定单次运行（如试卷 3 小时）。中途「打点」：**不打断、不重置倒计时**，仅记录时刻；段时长 = 相邻打点之差 | ✅ 打点，运行中实时显示分段列表 |
| 正计时（秒表） | 累计计时 | ✅ 保留 lap（上段时长） |
| 记录回看 | 任意计时结束（自然到点或手动结束）自动保存完整记录：起止时间、总用时、打点明细；历史页可回看每条的分段统计 | — |

环形进度数学：`C = 2πr`；`stroke-dasharray: C`；`stroke-dashoffset = C × (1 - progress)`；起点 12 点方向（`transform: rotate(-90deg)`），`stroke-linecap: round`。

## 3. 主形态布局（v3-方向二-双栏聚焦.png）

窗口 1280×832 基准，水平双栏：

```
├─ 侧栏 264px（--sidebar-bg，右侧 1px --stroke-faint 分隔，padding 18，垂直 flex gap 16）
│   ├─ 品牌行：Logo 28px + "TimeMark 时光标" 14px SemiBold
│   ├─ 搜索框：--glass-strong 底 --stroke-soft 描边 r12，高 32，放大镜 14px + "搜索计时…" 12.5px
│   ├─ 过滤胶囊行 gap 8：「全部 6」激活态(#2A3145 实底) /「进行中 2」「已暂停 1」幽灵态；r999 padding 11/5 字 12.5
│   ├─ 清单头：「清单 · 6」11.5px 弱色 + 右侧「历史记录 →」11.5px 青（记录页入口）
│   ├─ 计时清单（垂直 gap 4，行 r12 padding 12/10 gap 10）：
│   │   行 = 8px 色点(--tc,运行态带 0 0 8px 同色光晕) + 名称 13px SemiBold(flex:1) + 数值 11.5px mono
│   │   激活行：青色 9% 底 + 25% 青描边 + 数值青色；其余透明 hover 出 --glass
│   ├─ 弹性占位（flex:1）
│   ├─ 「+ 新建计时」：--accent-grad 实底 r13 高 40，白字 13px SemiBold，投影 --accent-glow
│   └─ 同步状态：6px 绿点(光晕) + "已同步 · 李宓 · 14:32" 11px 弱色
└─ 主区（flex:1，padding 30 36，垂直 flex gap 14，背景含 1-2 处极光 radial）
    ├─ 标题行：标题组(名称 22px Bold + 类型说明 12.5px 弱色) | 右侧 4 个 17px 线性图标
    │   （星标/置顶/编辑/删除，--text-mid，hover 提亮）| 窗控 65×16（— □ ×，键距 16px，最右）
    ├─ 聚焦舞台（垂直 flex 居中 gap 12，flex:1）：
    │   ├─ 大环 300px：SVG 圆环，轨道 rgba(255,255,255,.07) 粗 10，进度 --tc 渐变粗 10 圆头；
    │   │   环心：剩余时间 56px mono tabular + "剩余 68%" 12.5px 弱色
    │   ├─ 轮次指示（番茄钟专属）：8px 点=已完成(--ok)、10px 青发光点=进行中、白12%点=未到；
    │   │   点间 14×2px 白10% 短横线 = 休息间隔
    │   ├─ 状态说明 12.5px 弱色："第 2/4 轮 · 专注中 · 之后休息 5 分钟"
    │   ├─ 动作区 gap 10：暂停(--accent-grad r999 padding 24/12 白 13.5 SemiBold + 投影)
    │   │   + 跳过/重置(幽灵: --glass-strong 底 --stroke-hover 描边 r999 padding 20/12 字 13 --text-hi 80%)
    │   └─ 快捷键提示 11px mono 弱色："Space 暂停/继续 · N 跳过 · Esc 返回"
    ├─ 弹性占位（flex:1）
    └─ 今日概览条：--glass 底 --stroke-faint 描边 r14 padding 16/14；四组统计
        SPACE_BETWEEN（数值 16px mono SemiBold --text-hi + 标签 10.5px 弱色）：
        今日专注 1:47 | 完成轮次 3 | 累计打点 5 | 连续记录 12 天
```

## 4. 次级界面

### 4.1 台钟全屏（v3-台钟全屏.png）

- 全屏遮罩 `rgba(5,6,15,.97)`，中央垂直居中列：计时名 15px + 类型徽章 → 巨型数字 **150px**（`--font-num` 600 tabular，纯数字+小单位"天"，品牌渐变文字仅限 D-Day 类型）→ 说明行 → 里程碑时间轴（日期倒计时专属：640px 轨道 2px 白 8%，已走过段 `--tc` 渐变 4px，里程碑 6px 节点，今日标记点）→ 底部提示 "双击任意卡片进入台钟 · Esc 返回"。
- 右上角关闭按钮。背景中央 `--tc` 大 radial 色晕（预模糊）。

### 4.2 倒计时打点会话（v3-打点与回看.png 左半）

- 名称行（色点+名+「精确倒计时」青徽章）→ 大数字 76px（如 02:06:23）→ 说明行 → 总进度条（6px，--tc 渐变）→ 分段列表卡（r16 玻璃卡：表头「已打点 N 段 · 第 N+1 段进行中」+ 右注「段时长 = 相邻打点之差」；行 = ①②③ 名称 13px + 右侧 mono 时长青色；进行段右侧琥珀「进行中」）→ 动作区：打点(--accent-grad 主按钮) / 暂停 / 结束(幽灵，字 --danger)。

### 4.3 历史记录回看（v3-打点与回看.png 右半）

- 「今日记录」标题 + 说明「结束自动保存 · 可回看」→ 记录卡（r16 玻璃卡 padding 20 gap 14）：
  头行（名称 14 SemiBold + 日期 mono 11 弱色）→ 总用时 30px mono + 「总用时 · 打点 3 段」→
  **分段占比条**（高 10px，按各段时长占比分色块：--tc-cyan/--tc-violet/--tc-mint，gap 2 圆角 2）→
  明细行（6px 色点 + 段名 12.5 + 右 mono 时长同色）→ 第二条记录（单行卡：名称+副行+右 mono 总时长）→ 「查看全部记录 →」青链。

## 5. 实现优先级与验收

1. 令牌先行：§1 全部写入 `styles.css` `:root`，删除旧 v2 值。
2. 布局重构：App 改双栏（§3），台钟改全屏模式（§4.1）。
3. 功能：番茄钟循环状态机（自动切换）、倒计时打点（lap，不换 session）、历史记录页（§2）。
4. 动效约束：§1.5 时长曲线；禁 blur 滤镜；`prefers-reduced-motion` 降级。
5. 验收：对照 4 张 PNG 逐区块比对；大数字 tabular 不跳动；暖色只出现在动作/D-Day。
