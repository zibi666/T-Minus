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
/** 番茄钟配置（渲染层驱动的循环状态机；引擎侧每阶段仍是一次精确倒计时） */
export interface PomodoroInfo {
  work_ms: number;   // 单轮专注时长
  break_ms: number;  // 轮间休息时长
  rounds: number;    // 重复轮数
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

/** 渲染层展示用 DTO（运行值为派生值，绝不由 tick 累加写入） */
export interface TimerDTO {
  id: string;
  name: string;
  type: TimerType;
  color: string;
  starred: boolean;
  pinned: boolean;
  remark: string;
  config: TimerConfig;
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
  config: Partial<TimerConfig> & { schema_version?: number };
}

export interface UpdateTimerPatch {
  name?: string;
  color?: string;
  remark?: string;
  starred?: boolean;
  pinned?: boolean;
  config?: TimerConfig;
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
  config: TimerConfig;
  deleted: boolean;
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
