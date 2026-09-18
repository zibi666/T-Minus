// 预加载：通过 contextBridge 暴露安全的 IPC API。
// 本文件同时是渲染层看到的类型来源（global.d.ts 直接 typeof api），
// 因此每个方法都显式标注返回类型 —— IPC 面不再手写第二遍、也不再是 any。
import { contextBridge, ipcRenderer } from 'electron';
import {
  CreateTimerInput, UpdateTimerPatch, TickPayload, SyncStatusInfo, TimerDTO, TimerMeta, RecordDTO,
  AuthInfo, DayStatDTO, UpdateResultDTO, TagInfo, MilestoneInfo, ExportCounts, UpdateInfo
} from '../src/shared/types';

const api = {
  list: (): Promise<TimerDTO[]> => ipcRenderer.invoke('timers:list'),
  create: (input: CreateTimerInput): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:create', input),
  update: (id: string, patch: UpdateTimerPatch): Promise<UpdateResultDTO> => ipcRenderer.invoke('timers:update', id, patch),
  start: (id: string, payload?: { durationMs?: number }): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:start', id, payload),
  pause: (id: string): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:pause', id),
  resume: (id: string): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:resume', id),
  reset: (id: string): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:reset', id),
  segment: (id: string): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:segment', id),
  /** 结束并如实结算（倒计时 / 番茄钟 / 正计时统一入口） */
  stop: (id: string): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:stop', id),
  skipPhase: (id: string): Promise<TimerDTO | null> => ipcRenderer.invoke('timers:skipPhase', id),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('timers:delete', id),
  listMetas: (): Promise<TimerMeta[]> => ipcRenderer.invoke('timers:metas'),
  listRecords: (limit?: number): Promise<RecordDTO[]> => ipcRenderer.invoke('records:list', limit),
  deleteRecords: (ids: string[]): Promise<number> => ipcRenderer.invoke('records:delete', ids),
  /** 按本地自然日聚合的专注统计（由已同步的 timer_record 推导，跨端一致） */
  dailyStats: (): Promise<DayStatDTO[]> => ipcRenderer.invoke('stats:daily'),
  listTags: (): Promise<TagInfo[]> => ipcRenderer.invoke('tags:list'),
  setTimerTags: (id: string, names: string[]): Promise<TimerDTO | null> =>
    ipcRenderer.invoke('timers:setTags', id, names),
  listMilestones: (timerId: string): Promise<MilestoneInfo[]> => ipcRenderer.invoke('milestones:list', timerId),
  addMilestone: (timerId: string, note: string): Promise<MilestoneInfo | null> =>
    ipcRenderer.invoke('milestones:add', timerId, note),
  removeMilestone: (id: string): Promise<boolean> => ipcRenderer.invoke('milestones:remove', id),
  winControl: (action: 'minimize' | 'maximize' | 'close'): Promise<void> => ipcRenderer.invoke('win:' + action),
  exportData: (): Promise<{ ok: boolean; filePath?: string }> => ipcRenderer.invoke('data:export'),
  importData: (): Promise<{ ok: boolean; counts: ExportCounts; message?: string }> => ipcRenderer.invoke('data:import'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  dataDir: (): Promise<{ dir: string; overridden: boolean }> => ipcRenderer.invoke('app:data-dir'),
  checkUpdate: (): Promise<UpdateInfo> => ipcRenderer.invoke('update:check'),
  openReleasePage: (): Promise<{ ok: boolean; url: string }> => ipcRenderer.invoke('update:open'),

  onUpdateStatus: (cb: (s: UpdateInfo) => void) => subscribe<UpdateInfo>('update-status', cb),
  onTick: (cb: (p: TickPayload) => void) => subscribe<TickPayload>('tick', cb),
  /** 同步拉回远程变更后主进程广播的表名，视图据此重拉缓存的列表 */
  onDataChanged: (cb: (table: string) => void) => subscribe<string>('data-changed', cb),

  // ---- 登录与同步（§5）----
  authState: (): Promise<AuthInfo> => ipcRenderer.invoke('auth:state'),
  login: (serverUrl: string, username: string, password: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('auth:login', serverUrl, username, password),
  register: (serverUrl: string, username: string, password: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('auth:register', serverUrl, username, password),
  logout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('auth:logout'),
  syncNow: (): Promise<void> => ipcRenderer.invoke('sync:now'),
  syncStatus: (): Promise<SyncStatusInfo> => ipcRenderer.invoke('sync:status'),
  onSyncStatus: (cb: (s: SyncStatusInfo) => void) => subscribe<SyncStatusInfo>('sync-status', cb)
};

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

export type TimemarkApi = typeof api;

contextBridge.exposeInMainWorld('timemark', api);
