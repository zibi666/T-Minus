import React, { useState } from 'react';
import { TimerDTO, AuthInfo, SyncStatusInfo } from '../../shared/types';
import { isPomodoro, getPomodoro, mmss } from '../helpers';
import {
  LogoMark, IconSearch, IconArrowRight, IconPlus, IconSync, IconDownload,
  IconLogout, IconUser, IconPin, IconGear
} from './icons';

export type FilterKey = 'all' | 'running' | 'paused';

interface Props {
  timers: TimerDTO[];
  counts: { total: number; running: number; paused: number };
  tags: string[];
  activeTag: string | null;
  onTag: (t: string | null) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenClock: (id: string) => void;
  query: string;
  onQuery: (v: string) => void;
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  historyActive: boolean;
  onToggleHistory: () => void;
  onNew: () => void;
  auth: AuthInfo | null;
  sync: SyncStatusInfo;
  onSyncNow: () => void;
  onExport: () => void;
  onLogout: () => void;
  onLogin: () => void;
  currentVersion: string;
  dataDir: { dir: string; overridden: boolean } | null;
  update: { checking: boolean; info: { hasUpdate: boolean; latest: string } | null };
  onCheckUpdate: () => void;
  onOpenRelease: () => void;
}

/** 行尾数值：日期倒计时→N 天；运行/暂停→剩余或累计；空闲→预设时长 */
function rowValue(t: TimerDTO): string {
  if (t.type === 'DATE_COUNTDOWN') {
    const d = t.daysLeft ?? 0;
    if (d === 0) return '今天';
    return d > 0 ? `${d} 天` : `-${Math.abs(d)} 天`;
  }
  if (t.type === 'PRECISE_COUNTDOWN') {
    if (t.runState === 'running' || t.runState === 'paused') return mmss(t.remainingMs ?? 0);
    return mmss((t.config as any).preset_ms ?? 0);
  }
  return `${Math.floor((t.elapsedMs ?? 0) / 1000)} 秒`; // 正计时只显示秒
}

export default function Sidebar(p: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const syncCls = p.sync.state === 'syncing' ? 'busy' : p.sync.state === 'error' ? 'err' : p.auth?.loggedIn ? 'ok' : '';
  const syncText = !p.auth?.loggedIn
    ? '未登录 · 仅本地使用'
    : p.sync.state === 'syncing'
      ? `同步中${p.sync.pending ? ` · 待传 ${p.sync.pending}` : ''}…`
      : p.sync.state === 'error'
        ? `同步失败 · 点击重试`
        : `已同步 · ${p.auth.username ?? ''}${p.sync.lastSyncAt ? ' · ' + new Date(p.sync.lastSyncAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''}`;

  const filters: Array<[FilterKey, string, number]> = [
    ['all', '全部', p.counts.total],
    ['running', '进行中', p.counts.running],
    ['paused', '已暂停', p.counts.paused]
  ];

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo"><LogoMark size={19} /></div>
        <div className="brand-name">TimeMark 时光标</div>
      </div>

      <div className="search-box">
        <IconSearch size={14} />
        <input
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
          placeholder="搜索计时…"
          maxLength={50}
        />
      </div>

      <div className="filter-row">
        {filters.map(([k, label, n]) => (
          <button
            key={k}
            className={`filter-chip ${p.filter === k ? 'active' : ''}`}
            onClick={() => p.onFilter(k)}
          >
            <span>{label}</span> <span className="n">{n}</span>
          </button>
        ))}
      </div>

      {p.tags.length > 0 && (
        <div className="tag-row">
          {p.tags.map((tg) => (
            <button
              key={tg}
              className={`tag-chip ${p.activeTag === tg ? 'active' : ''}`}
              title={p.activeTag === tg ? '取消标签筛选' : `筛选「${tg}」`}
              onClick={() => p.onTag(p.activeTag === tg ? null : tg)}
            >
              <span>{tg}</span>
            </button>
          ))}
        </div>
      )}

      <div className="list-head">
        <span>清单 · {p.counts.total}</span>
        <button
          className={`to-history ${p.historyActive ? 'active' : ''}`}
          onClick={p.onToggleHistory}
          title="查看今日计时记录"
        >
          {p.historyActive ? '返回聚焦' : '历史记录'} <IconArrowRight size={11} />
        </button>
      </div>

      <div className="timer-list">
        {p.timers.length === 0 && <div className="list-empty">没有匹配的计时项</div>}
        {p.timers.map((t, i) => (
          <button
            key={t.id}
            className={`t-row ${t.id === p.selectedId ? 'selected' : ''} ${t.runState === 'running' ? 'running' : ''}`}
            style={{ ['--tc' as any]: t.color, ['--i' as any]: i }}
            onClick={() => p.onSelect(t.id)}
            onDoubleClick={() => p.onOpenClock(t.id)}
            title={isPomodoro(t) ? `番茄钟 · 专注 ${Math.round(getPomodoro(t).work_ms / 60000)} 分钟 × ${getPomodoro(t).rounds} 轮（双击进入台钟）` : '单击聚焦 · 双击进入台钟'}
          >
            <span className="dot" />
            <span className="t-name">
              {t.name}
              {t.pinned && <span className="pin-mark" title="已置顶"><IconPin size={11} filled /></span>}
            </span>
            <span className="t-val">{rowValue(t)}</span>
          </button>
        ))}
      </div>

      <button className="new-btn" onClick={p.onNew}>
        <IconPlus size={14} /> 新建计时
      </button>

      <div
        className={`sync-line ${syncCls}`}
        role="button"
        tabIndex={0}
        onClick={() => setMenuOpen((v) => !v)}
        title="设置与更新：立即同步 / 导出备份 / 检查更新 / 退出登录"
      >
        <span className="sdot" />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{syncText}</span>
        <button
          className={`gear-btn ${p.update.info?.hasUpdate ? 'has-update' : ''}`}
          title="设置与更新"
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        >
          <IconGear size={13} />
        </button>
        {menuOpen && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }} />
            <div className="sync-menu" onClick={(e) => e.stopPropagation()}>
              {!p.auth?.loggedIn && (
                <button onClick={() => { setMenuOpen(false); p.onLogin(); }}>
                  <IconUser size={12} /> <span>登录 / 注册</span>
                </button>
              )}
              {p.auth?.loggedIn && (
                <button onClick={() => { setMenuOpen(false); p.onSyncNow(); }}>
                  <IconSync size={12} /> <span>立即同步</span>
                </button>
              )}
              <button onClick={() => { setMenuOpen(false); p.onExport(); }}>
                <IconDownload size={12} /> <span>导出备份</span>
              </button>
              <button onClick={() => p.onCheckUpdate()}>
                <IconSync size={12} /> <span>
                  {p.update.checking
                    ? '检查更新中…'
                    : p.update.info?.hasUpdate
                      ? `发现新版本 v${p.update.info.latest}`
                      : p.update.info
                        ? '当前已是最新'
                        : `检查更新${p.currentVersion ? ` · v${p.currentVersion}` : ''}`}
                </span>
              </button>
              {p.update.info?.hasUpdate && (
                <button onClick={() => { p.onOpenRelease(); }}>
                  <IconDownload size={12} /> <span>前往下载新版本</span>
                </button>
              )}
              {p.auth?.loggedIn && (
                <button className="danger" onClick={() => { setMenuOpen(false); p.onLogout(); }}>
                  <IconLogout size={12} /> <span>退出登录</span>
                </button>
              )}
              {p.dataDir && (
                <div className="menu-info" title={p.dataDir.dir}>
                  数据目录 · {p.dataDir.dir.split(/[\\/]/).filter(Boolean).pop()}
                  {p.dataDir.overridden ? '（TIMEMARK_DATA_DIR）' : '（默认）'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
