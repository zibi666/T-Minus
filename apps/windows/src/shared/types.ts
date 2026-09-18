// TimeMark 共享类型定义（主进程与渲染进程共用）
// 对应《开发计划 v2》§3 计时状态规则 与 §4 数据模型

export type TimerType = 'DATE_COUNTDOWN' | 'PRECISE_COUNTDOWN' | 'STOPWATCH';
export type RunState = 'idle' | 'running' | 'paused';

/** §4.4 config_json 结构（schema_version: 1） */
export interface DateConfig {
  schema_version: 1;
  target_date: string;      // YYYY-MM-DD
  timezone_id: string;      // IANA 时区名
  include_today: boolean;   // 是否包含今天
}
/** 番茄钟配置（引擎驱动的循环状态机，阶段状态存 run_json 参与同步） */
export interface PomodoroInfo {
  work_ms: number;         // 单轮专注时长
  break_ms: number;        // 短休息时长
  long_break_ms?: number;  // 长休息时长（每 rounds 轮触发一次；缺省 15 分钟）
  rounds: number;          // 长休息间隔轮数（每完成 rounds 轮专注进一次长休息，无限循环）
}
export interface PreciseConfig {
  schema_version: 1;
  preset_ms: number;        // 新建预设时长（番茄钟下 = 当前阶段时长，阶段切换时由渲染层更新）
  pomodoro?: PomodoroInfo;  // 存在即视为番茄钟
}
export interface StopwatchConfig {
  schema_version: 1;
}
export type TimerConfig = DateConfig | PreciseConfig | StopwatchConfig;

/** 读模型：库里存的 config_json 是三类字段的合并形状，展示层按字段直接取值 */
export type TimerConfigView = { schema_version?: number } & Partial<DateConfig> & Partial<PreciseConfig> & Partial<StopwatchConfig>;

/** 渲染层展示用 DTO（运行值为派生值，绝不由 tick 累加写入） */
export interface TimerDTO {
  id: string;
  name: string;
  type: TimerType;
  color: string;
  starred: boolean;
  pinned: boolean;
  remark: string;
  config: TimerConfigView;
  runState: RunState;
  // 日期倒计时派生值
  daysLeft?: number;
  targetDate?: string;
  timezoneId?: string;
  includeToday?: boolean;
  // 精确倒计时派生值
  remainingMs?: number;     // running/paused 时的剩余
  // 正计时派生值
  elapsedMs?: number;       // running/paused 时的累计
  // 手动分段：本次运行已完成的分段时长（PRECISE=各轮；STOPWATCH=各 lap）
  segmentsMs?: number[];
  // 番茄钟派生值（阶段状态存 run_json，引擎驱动）
  pomoPhase?: 'focus' | 'break' | 'long_break';
  pomoRound?: number;       // 当前轮次（专注中 = completed_focus+1，休息中 = completed_focus）
  // 标签（tag / timer_tag 表，可作筛选维度）
  tags?: string[];
  updatedAt: number;
  version: number;
}

export interface CreateTimerInput {
  name: string;
  type: TimerType;
  color?: string;
  remark?: string;
  starred?: boolean;
  pinned?: boolean;
  config: TimerConfigView;
}

export interface UpdateTimerPatch {
  name?: string;
  color?: string;
  remark?: string;
  starred?: boolean;
  pinned?: boolean;
  config?: TimerConfigView;
}

/** 按本地自然日聚合的专注统计（由已同步的 timer_record 现场推导，跨端一致） */
export interface DayStatDTO {
  day: string;      // YYYY-MM-DD（本机时区）
  focusMs: number;
  rounds: number;
  marks: number;
}

/** 计时元数据更新结果：配置被拒（如运行中改时长）必须带原因回给表单，不再静默丢弃 */
export interface UpdateResultDTO {
  ok: boolean;
  timer: TimerDTO | null;
  message?: string;
}

export interface TickPayload {
  now: number;
  timers: TimerDTO[];
}

/** 计时记录（timer_record 只读 DTO，供历史回看与今日概览） */
export interface RecordDTO {
  id: string;
  timerId: string;
  sessionId: string | null;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  recordType: string; // PRECISE | SEGMENT | STOPWATCH
}

/** 计时元数据（含已删除，供历史页标注与筛选） */
export interface TimerMeta {
  id: string;
  name: string;
  color: string;
  type: TimerType;
  config: TimerConfigView;
  deleted: boolean;
}

/** 标签（tag 表） */
export interface TagInfo {
  id: string;
  name: string;
  color: string;
}

/** 里程碑（milestone 表，计时中的重要时刻） */
export interface MilestoneInfo {
  id: string;
  note: string;
  markedAt: number;
}

/** 导入备份后各表写入条数 */
export type ExportCounts = Record<string, number>;

/** 更新检查结果（GitHub latest.json） */
export interface UpdateInfo {
  hasUpdate: boolean;
  latest: string;
  current: string;
  url: string;
  checkedAt: number;
}

export interface ExportPayload {
  app: 'TimeMark';
  schema_version: number;
  exported_at: number;
  device_id: string;
  timer_item: unknown[];
  tag: unknown[];
  timer_tag: unknown[];
  milestone: unknown[];
  timer_record: unknown[];
}

/** 登录态（客户端本地视角） */
export interface AuthInfo {
  loggedIn: boolean;
  userId: string | null;
  username: string | null;
  serverUrl: string;
}

/** 同步状态（§5） */
export interface SyncStatusInfo {
  state: 'idle' | 'syncing' | 'error';
  lastSyncAt: number | null;
  pending: number;
  error: string | null;
}
