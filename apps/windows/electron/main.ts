// Electron 主进程：窗口 / 托盘 / IPC / 通知 / 计时循环
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, dialog, nativeTheme, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { LocalDB, uuid } from './db';
import { TimerEngine } from './timerEngine';
import { gatherExport } from './exporter';
import { todayInTz } from './dateLogic';
import { CreateTimerInput, UpdateTimerPatch, TickPayload } from '../src/shared/types';
import { SyncClient } from './syncClient';

// ---- 数据目录开关（§8 M2 双实例同步验收）----
// 设置 TIMEMARK_DATA_DIR 后，本实例的数据库 / localStorage / 会话数据全部落在该目录，
// 与默认实例完全隔离；两个实例可同账号同时运行做同步对测。必须在 ready 之前调用 setPath。
const dataDirOverride = process.env.TIMEMARK_DATA_DIR ? path.resolve(process.env.TIMEMARK_DATA_DIR) : '';
if (dataDirOverride) {
  try { fs.mkdirSync(dataDirOverride, { recursive: true }); } catch { /* 已存在 */ }
  app.setPath('userData', dataDirOverride);
  app.setPath('sessionData', path.join(dataDirOverride, 'Session Data'));
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: LocalDB;
let engine: TimerEngine;
let sync: SyncClient;
let deviceId = '';
const ddayNotified = new Set<string>(); // key: `${timerId}:${targetDate}`

// ---- 更新检查（GitHub 仓库 latest.json，多源回退：jsDelivr CDN → 原始仓库 → ghproxy） ----
const REPO = 'zibi666/T-Minus';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const UPDATE_SOURCES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@main/apps/windows/latest.json`,
  `https://raw.githubusercontent.com/${REPO}/main/apps/windows/latest.json`,
  `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/main/apps/windows/latest.json`
];
export interface UpdateInfo { hasUpdate: boolean; latest: string; current: string; url: string; checkedAt: number }
let lastUpdateInfo: UpdateInfo | null = null;

function cmpVer(a: string, b: string): number {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function fetchLatestManifest(): Promise<{ version: string; url?: string } | null> {
  for (const url of UPDATE_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j: any = await res.json();
      if (j && typeof j.version === 'string' && /^\d+\.\d+\.\d+$/.test(j.version)) {
        return { version: j.version, url: typeof j.url === 'string' ? j.url : undefined };
      }
    } catch { /* 换下一个源 */ }
  }
  return null;
}

async function checkUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  const manifest = await fetchLatestManifest();
  const latest = manifest?.version ?? current;
  const url = manifest?.url || RELEASES_URL;
  const info: UpdateInfo = { hasUpdate: cmpVer(latest, current) > 0, latest, current, url, checkedAt: Date.now() };
  lastUpdateInfo = info;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update-status', info);
  if (info.hasUpdate && Notification.isSupported()) {
    new Notification({
      title: 'TimeMark 时光标',
      body: `发现新版本 v${latest}（当前 v${current}），打开侧栏菜单可前往下载`
    }).show();
  }
  return info;
}

// GPU 策略：真机默认启用硬件加速 —— 整窗极光光斑漂移/光晕/SVG 环动画若走 CPU 光栅化
// （软件渲染）会长期占满渲染进程，表现为按钮卡顿、打点反馈延迟数秒；
// 无 GPU 的沙箱/虚拟机环境用 TIMEMARK_SOFTWARE_RENDER=1 强制禁用，避免 GPU 崩溃循环。
if (process.env.TIMEMARK_SOFTWARE_RENDER === '1') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.disableHardwareAcceleration();
}

// 强制深色原生主题：select 弹出列表 / 系统对话框 / confirm 跟随应用深色皮肤，
// 否则亮色系统下原生下拉是白底，与页面浅色文字叠加导致不可读
nativeTheme.themeSource = 'dark';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 980,
    minHeight: 640,
    frame: false, // v3 双栏聚焦形态：标题行内嵌自定义窗控
    backgroundColor: '#05060F',
    title: 'TimeMark 时光标',
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
let trayTipShown = false;
// 关闭到托盘（M1：常驻托盘进程）
win.on('close', (e) => {
  if (!(app as any).isQuiting) {
    e.preventDefault();
    win?.hide();
    if (!trayTipShown && Notification.isSupported()) {
      trayTipShown = true;
      new Notification({ title: 'TimeMark 时光标', body: '已最小化到托盘，点击托盘图标可重新打开' }).show();
    }
  }
});
  win.loadFile(path.join(__dirname, '../../renderer/index.html'));
}

function createTray(): void {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('TimeMark 时光标');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { win?.show(); win?.focus(); } },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        (app as any).isQuiting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { win?.show(); win?.focus(); });
}

function registerIpc(): void {
  ipcMain.handle('timers:list', () => engine.list());
  ipcMain.handle('timers:create', (_e, input: CreateTimerInput) => engine.create(input));
  ipcMain.handle('timers:update', (_e, id: string, patch: UpdateTimerPatch) => engine.update(id, patch));
  ipcMain.handle('timers:start', (_e, id: string, payload?: { durationMs?: number }) => engine.start(id, payload));
  ipcMain.handle('timers:pause', (_e, id: string) => engine.pause(id));
  ipcMain.handle('timers:resume', (_e, id: string) => engine.resume(id));
  ipcMain.handle('timers:reset', (_e, id: string) => engine.reset(id));
  ipcMain.handle('timers:segment', (_e, id: string) => engine.segment(id));
  ipcMain.handle('timers:stop', (_e, id: string) => engine.stop(id));
  ipcMain.handle('timers:delete', (_e, id: string) => engine.remove(id));
  ipcMain.handle('timers:metas', () => engine.listMetas());
  ipcMain.handle('records:list', (_e, limit?: number) => engine.listRecentRecords(limit ?? 300));
  ipcMain.handle('records:delete', (_e, ids: string[]) => engine.deleteRecords(Array.isArray(ids) ? ids.map(String) : []));
  ipcMain.handle('tags:list', () => engine.listTags());
  ipcMain.handle('timers:setTags', (_e, id: string, names: string[]) =>
    engine.setTimerTags(String(id), Array.isArray(names) ? names.map(String) : []));
  // v3 无边框窗口控制
  ipcMain.handle('win:minimize', () => { win?.minimize(); });
  ipcMain.handle('win:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.handle('win:close', () => { win?.close(); }); // 走既有 close 钩子 → 隐藏到托盘
  ipcMain.handle('auth:state', () => sync.authState());
  ipcMain.handle('auth:login', async (_e, serverUrl: string, username: string, password: string) => {
    sync.setServer(serverUrl);
    const r = await sync.login(String(username || '').trim(), password);
    if (r.ok) engine.currentUserId = sync.authState().userId;
    return r;
  });
  ipcMain.handle('auth:register', async (_e, serverUrl: string, username: string, password: string) => {
    sync.setServer(serverUrl);
    const r = await sync.register(String(username || '').trim(), password);
    if (r.ok) engine.currentUserId = sync.authState().userId;
    return r;
  });
  ipcMain.handle('auth:logout', () => {
    sync.logout();
    engine.currentUserId = null;
    return { ok: true };
  });
  ipcMain.handle('sync:now', () => sync.syncNow());
  ipcMain.handle('sync:status', () => sync.lastStatusInfo());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:data-dir', () => ({ dir: app.getPath('userData'), overridden: !!dataDirOverride }));
  ipcMain.handle('update:check', () => checkUpdate());
  ipcMain.handle('update:open', async () => {
    const url = lastUpdateInfo?.url || RELEASES_URL;
    await shell.openExternal(url);
    return { ok: true, url };
  });
  ipcMain.handle('data:export', async () => {
    if (!win) return { ok: false };
    const payload = gatherExport(db, deviceId);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出备份',
      defaultPath: `timemark-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false };
    require('fs').writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return { ok: true, filePath };
  });
}

let lastTickSig = ''; // tick 变更检测：空闲（无任何计时值变化）时不向渲染层广播，避免无效全树 re-render
function broadcastTick(): void {
  engine.tick();
  const timers = engine.list();
  const sig = JSON.stringify(timers);
  if (sig === lastTickSig) return;
  lastTickSig = sig;
  const payload: TickPayload = { now: Date.now(), timers };
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('tick', payload);
  }
  checkDday(payload);
}

/** 日期倒计时 D-day 提醒：每个目标日只提醒一次（更细的时点提醒在 M3/M4 平台端处理） */
function checkDday(payload: TickPayload): void {
  if (!Notification.isSupported()) return;
  for (const t of payload.timers) {
    if (t.type !== 'DATE_COUNTDOWN' || t.daysLeft !== 0 || !t.targetDate) continue;
    const key = `${t.id}:${t.targetDate}`;
    if (ddayNotified.has(key)) continue;
    ddayNotified.add(key);
    new Notification({ title: 'TimeMark 时光标', body: `「${t.name}」就是今天！` }).show();
  }
}

app.whenReady().then(async () => {
  db = new LocalDB(path.join(app.getPath('userData'), 'timemark.db'));
  await db.init();
  deviceId = db.getMeta('device_id') || uuid();
  db.setMeta('device_id', deviceId);

  engine = new TimerEngine(db, deviceId);
  engine.onFinish = (row) => {
    if (Notification.isSupported()) {
      new Notification({ title: 'TimeMark 时光标', body: `「${row.name}」倒计时已到点` }).show();
    }
  };
  engine.load();

  sync = new SyncClient(db, deviceId);
  sync.onStatus = (s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync-status', s);
  };
  sync.onRemoteChange = (table, rowId) => {
    if (table === 'timer_item') engine.reloadRow(rowId);
    else if (table === 'tag' || table === 'timer_tag') engine.refreshTags();
  };
  engine.queueOp = (op) => sync.enqueue(op);
  const auth = sync.restore();
  engine.currentUserId = auth.userId;

  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  createTray();
  setInterval(broadcastTick, 500);
  // 同步循环：登录状态下每 4s push/pull 一轮；syncNow 内部有并发保护
  setInterval(() => {
    if (sync.authState().loggedIn) sync.syncNow();
  }, 4000);
  if (auth.loggedIn) sync.syncNow();
  // 更新检查：启动 8s 后一次，之后每 6h 静默检查；发现新版发系统通知
  setTimeout(() => { void checkUpdate().catch(() => {}); }, 8000);
  setInterval(() => { void checkUpdate().catch(() => {}); }, 6 * 60 * 60 * 1000);
});

app.on('before-quit', () => {
  if (db) db.flush();
});

app.on('window-all-closed', () => {
  // 托盘常驻：不随窗口关闭退出（Windows）
});
