// 预加载：通过 contextBridge 暴露安全的 IPC API
import { contextBridge, ipcRenderer } from 'electron';
import { CreateTimerInput, UpdateTimerPatch, TickPayload, SyncStatusInfo } from '../src/shared/types';

const api = {
  list: () => ipcRenderer.invoke('timers:list'),
  create: (input: CreateTimerInput) => ipcRenderer.invoke('timers:create', input),
  update: (id: string, patch: UpdateTimerPatch) => ipcRenderer.invoke('timers:update', id, patch),
  start: (id: string, payload?: { durationMs?: number }) => ipcRenderer.invoke('timers:start', id, payload),
  pause: (id: string) => ipcRenderer.invoke('timers:pause', id),
  resume: (id: string) => ipcRenderer.invoke('timers:resume', id),
  reset: (id: string) => ipcRenderer.invoke('timers:reset', id),
  segment: (id: string) => ipcRenderer.invoke('timers:segment', id),
  stop: (id: string) => ipcRenderer.invoke('timers:stop', id),
  remove: (id: string) => ipcRenderer.invoke('timers:delete', id),
  listMetas: () => ipcRenderer.invoke('timers:metas'),
  listRecords: (limit?: number) => ipcRenderer.invoke('records:list', limit),
  deleteRecords: (ids: string[]) => ipcRenderer.invoke('records:delete', ids),
  listTags: () => ipcRenderer.invoke('tags:list'),
  setTimerTags: (id: string, names: string[]) => ipcRenderer.invoke('timers:setTags', id, names),
  winControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('win:' + action),
  exportData: () => ipcRenderer.invoke('data:export'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  dataDir: () => ipcRenderer.invoke('app:data-dir'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openReleasePage: () => ipcRenderer.invoke('update:open'),
  onUpdateStatus: (cb: (s: unknown) => void) => {
    const handler = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('update-status', handler);
    return () => { ipcRenderer.removeListener('update-status', handler); };
  },
  onTick: (cb: (p: TickPayload) => void) => {
    const handler = (_e: unknown, p: TickPayload) => cb(p);
    ipcRenderer.on('tick', handler);
    return () => {
      ipcRenderer.removeListener('tick', handler);
    };
  },
  // ---- 登录与同步（§5）----
  authState: () => ipcRenderer.invoke('auth:state'),
  login: (serverUrl: string, username: string, password: string) =>
    ipcRenderer.invoke('auth:login', serverUrl, username, password),
  register: (serverUrl: string, username: string, password: string) =>
    ipcRenderer.invoke('auth:register', serverUrl, username, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  onSyncStatus: (cb: (s: SyncStatusInfo) => void) => {
    const handler = (_e: unknown, s: SyncStatusInfo) => cb(s);
    ipcRenderer.on('sync-status', handler);
    return () => {
      ipcRenderer.removeListener('sync-status', handler);
    };
  }
};

contextBridge.exposeInMainWorld('timemark', api);
