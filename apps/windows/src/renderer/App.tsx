import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TimerDTO, TimerMeta, AuthInfo, SyncStatusInfo, RecordDTO, RunState, DayStatDTO } from '../shared/types';
import { formatRemaining, localDateKey } from '../shared/format';
import Sidebar, { FilterKey } from './components/Sidebar';
import FocusStage, { StageActions } from './components/FocusStage';
import HistoryView from './components/HistoryView';
import FullscreenClock from './components/FullscreenClock';
import TimerForm, { EditTarget } from './components/TimerForm';
import LoginModal from './components/LoginModal';
import { EmptyArt, IconStar, IconPin, IconPencil, IconTrash, IconMinus, IconSquare, IconClose } from './components/icons';
import { isPomodoro, getPomodoro, formatFocus } from './helpers';

/** 按天索引的专注统计 */
type StatMap = Record<string, DayStatDTO>;

export default function App() {
  const [timers, setTimers] = useState<TimerDTO[]>([]);
  const [records, setRecords] = useState<RecordDTO[]>([]);
  const [metas, setMetas] = useState<TimerMeta[]>([]);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [sync, setSync] = useState<SyncStatusInfo>({ state: 'idle', lastSyncAt: null, pending: 0, error: null, needsRelogin: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [view, setView] = useState<'focus' | 'history'>('focus');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  /** 轻量提示：导入/退出登录这类「静默改变了数据」的动作必须给出结果反馈 */
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  // ---- 更新检查 ----
  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean; latest: string; current: string } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [appVer, setAppVer] = useState('');
  const [dataDir, setDataDir] = useState<{ dir: string; overridden: boolean } | null>(null);
  useEffect(() => {
    window.timemark.onUpdateStatus(setUpdateInfo);
    window.timemark.appVersion().then(setAppVer).catch(() => {});
    window.timemark.dataDir().then(setDataDir).catch(() => {});
  }, []);
  const doCheckUpdate = useCallback(async () => {
    setUpdateChecking(true);
    try { setUpdateInfo(await window.timemark.checkUpdate()); } catch { /* 网络失败静默 */ } finally { setUpdateChecking(false); }
  }, []);
  const doOpenRelease = useCallback(() => { void window.timemark.openReleasePage(); }, []);

  // ---- 专注统计（主进程按天聚合已同步的 timer_record；渲染层只读展示） ----
  const [dayStats, setDayStats] = useState<StatMap>({});
  const prevRun = useRef<Map<string, RunState>>(new Map());
  const prevPhase = useRef<Map<string, string>>(new Map());
  const refreshStats = useCallback(() => {
    window.timemark.dailyStats().then((rows) => {
      const m: StatMap = {};
      for (const r of rows) m[r.day] = r;
      setDayStats(m);
    }).catch(() => {});
  }, []);

  const refreshMetas = useCallback(() => {
    window.timemark.listMetas().then(setMetas).catch(() => {});
  }, []);

  const refreshRecords = useCallback(() => {
    window.timemark.listRecords(400).then(setRecords).catch(() => { /* 本地无记录可忽略 */ });
    refreshMetas(); // 含已删除计时，历史页据此保留记录
  }, [refreshMetas]);

  /** 历史与概览同源（timer_record），必须成对刷新，否则两侧口径会短暂不一致 */
  const refreshLedger = useCallback(() => {
    refreshRecords();
    refreshStats();
  }, [refreshRecords, refreshStats]);

  // ---- 即时反馈与渲染减负 ----
  const lastSyncRef = useRef<SyncStatusInfo | null>(null);

  /** 同步状态浅比较：内容未变不触发 re-render（syncing 每 4s 重复 emit、对象身份每次都变） */
  function applySync(s: SyncStatusInfo) {
    const p = lastSyncRef.current;
    if (p && p.state === s.state && p.pending === s.pending && p.error === s.error
      && p.lastSyncAt === s.lastSyncAt && p.needsRelogin === s.needsRelogin) return;
    lastSyncRef.current = s;
    setSync(s);
  }

  /** 用动作返回的最新 DTO 立即合并进列表（不等下一个 500ms tick，消除打点/暂停/继续的反馈延迟） */
  function mergeDto(dto: TimerDTO | null | undefined) {
    if (!dto || !dto.id) return;
    setTimers((list) => {
      const idx = list.findIndex((x) => x.id === dto.id);
      if (idx < 0) return [...list, dto];
      const next = list.slice();
      next[idx] = { ...next[idx], ...dto };
      return next;
    });
    prevRun.current.set(dto.id, dto.runState); // 同步镜像，防 applyTick 到点误判
  }

  useEffect(() => {
    window.timemark.list().then(setTimers);
    window.timemark.authState().then(setAuth);
    window.timemark.syncStatus().then(applySync);
    refreshLedger();
    const offTick = window.timemark.onTick(applyTick);
    const offSync = window.timemark.onSyncStatus(applySync);
    // 同步拉回的远程变更（里程碑/记录/标签）本地没有内存运行时，需主动重拉
    const offData = window.timemark.onDataChanged((table) => {
      if (table === 'timer_record' || table === 'timer_item') refreshLedger();
    });
    return () => {
      offTick?.();
      offSync?.();
      offData?.();
    };
  }, [refreshLedger]);

  // 凭据过期时直接把登录框推到眼前：否则侧栏会一直挂着「已登录」，而同步其实每 4s 撞一次 401
  useEffect(() => {
    if (sync.needsRelogin) setLoginOpen(true);
  }, [sync.needsRelogin]);

  /** 500ms tick：更新列表。番茄钟阶段推进已由主进程引擎自动完成（后台/托盘也走），
   *  渲染层仅检测 running→idle（普通倒计时到点）或番茄钟阶段切换 → 刷新记录与今日统计 */
  function applyTick(p: { now: number; timers: TimerDTO[] }) {
    setTimers(p.timers);
    let changed = false;
    for (const t of p.timers) {
      const prev = prevRun.current.get(t.id);
      prevRun.current.set(t.id, t.runState);
      if (prev === 'running' && t.runState === 'idle') changed = true; // 普通倒计时/正计时到点
      const pp = prevPhase.current.get(t.id);
      const cp = t.pomoPhase ?? '';
      prevPhase.current.set(t.id, cp);
      if (pp !== undefined && pp !== cp && cp !== '') changed = true; // 番茄钟阶段推进
    }
    if (changed) refreshLedger();
  }

  const sorted = useMemo(() => {
    return [...timers].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [timers]);

  // 选中项兜底：无选中或已删除 → 选第一个
  useEffect(() => {
    if (!selectedId || !timers.some((t) => t.id === selectedId)) {
      setSelectedId(sorted[0]?.id ?? null);
    }
  }, [timers, sorted, selectedId]);

  // 全部标签（去重排序，供侧栏筛选）
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const t of timers) for (const g of t.tags ?? []) s.add(g);
    return [...s].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [timers]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((t) => {
      if (q && !t.name.toLowerCase().includes(q)) return false;
      if (filter === 'running' && t.runState !== 'running') return false;
      if (filter === 'paused' && t.runState !== 'paused') return false;
      if (activeTag && !(t.tags ?? []).includes(activeTag)) return false;
      return true;
    });
  }, [sorted, query, filter, activeTag]);

  const counts = useMemo(() => ({
    total: timers.length,
    running: timers.filter((t) => t.runState === 'running').length,
    paused: timers.filter((t) => t.runState === 'paused').length
  }), [timers]);

  const selected = useMemo(
    () => (selectedId ? timers.find((t) => t.id === selectedId) ?? null : null),
    [timers, selectedId]
  );
  const fullscreenTimer = useMemo(
    () => (fullscreenId ? timers.find((t) => t.id === fullscreenId) ?? null : null),
    [timers, fullscreenId]
  );

  // ---- 今日概览统计（口径由主进程按已同步记录聚合，双端一致） ----
  const EMPTY_STAT: DayStatDTO = { day: '', focusMs: 0, rounds: 0, marks: 0 };
  const stats = useMemo(() => {
    const today = dayStats[localDateKey(Date.now())] ?? EMPTY_STAT;
    const daySet = new Set<string>();
    for (const [day, s] of Object.entries(dayStats)) {
      if (s.focusMs > 0 || s.rounds > 0 || s.marks > 0) daySet.add(day);
    }
    let streak = 0;
    const cursor = new Date();
    if (!daySet.has(localDateKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
    while (daySet.has(localDateKey(cursor.getTime()))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { focusMs: today.focusMs, rounds: today.rounds, marks: today.marks, streak };
  }, [dayStats]);

  // ---- 用户动作（番茄钟阶段推进已由引擎接管，渲染层直接调 IPC） ----
  function buildActions(t: TimerDTO): StageActions {
    return {
      start: () => window.timemark.start(t.id).then((d) => { mergeDto(d); refreshLedger(); }),
      pause: () => window.timemark.pause(t.id).then(mergeDto),
      resume: () => window.timemark.resume(t.id).then(mergeDto),
      reset: () => window.timemark.reset(t.id).then((d) => { mergeDto(d); refreshLedger(); }),
      skip: () => { if (isPomodoro(t)) window.timemark.skipPhase(t.id).then((d) => { mergeDto(d); refreshLedger(); }); },
      segment: async () => {
        mergeDto(await window.timemark.segment(t.id));
        refreshLedger();
      },
      /** 结束 = 如实结算已进行时长并归零（引擎内按类型分派），与重置（直接归零不记账）区分 */
      end: async () => {
        mergeDto(await window.timemark.stop(t.id));
        refreshLedger();
      },
      openClock: () => setFullscreenId(t.id)
    };
  }

  function toggleRun(t: TimerDTO | null) {
    if (!t || t.type === 'DATE_COUNTDOWN') return;
    const a = buildActions(t);
    if (t.runState === 'running') a.pause();
    else if (t.runState === 'paused') a.resume();
    else a.start();
  }

  function secondaryAction(t: TimerDTO | null) {
    if (!t || t.runState !== 'running') return;
    if (isPomodoro(t)) window.timemark.skipPhase(t.id).then((d) => { mergeDto(d); refreshLedger(); });
    else if (t.type === 'PRECISE_COUNTDOWN' || t.type === 'STOPWATCH') {
      window.timemark.segment(t.id).then((d) => { mergeDto(d); refreshLedger(); });
    }
  }

  // ---- 快捷键：Space 暂停/继续 · N 跳过/打点 · Esc 返回 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || el?.isContentEditable) return;
      if (editing || loginOpen) return;
      // 台钟打开时快捷键作用于台钟计时器，而非侧栏选中项
      const target = fullscreenTimer ?? selected;
      if (e.code === 'Space') {
        e.preventDefault();
        toggleRun(target);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        secondaryAction(target);
      } else if (e.key === 'Escape') {
        if (!fullscreenId && view === 'history') setView('focus');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, fullscreenTimer, editing, loginOpen, fullscreenId, view]);

  async function handleLogout() {
    const r = await window.timemark.logout();
    if (r.discarded > 0) {
      showToast(`已退出登录，丢弃 ${r.discarded} 条上一个账号未上传的本地修改`);
    }
    setAuth(await window.timemark.authState());
  }

  const typeDesc = (t: TimerDTO): string => {
    if (isPomodoro(t)) {
      const c = getPomodoro(t);
      return `番茄钟 · 专注 ${Math.round(c.work_ms / 60000)} 分钟 · 每 ${c.rounds} 轮长休息`;
    }
    if (t.type === 'PRECISE_COUNTDOWN') return `精确倒计时 · 总时长 ${formatRemaining(t.config.preset_ms ?? 0)}`;
    if (t.type === 'STOPWATCH') return '正计时 · 累计计时 · 支持分段';
    return `日期倒计时 · 目标 ${t.targetDate ?? ''}`;
  };

  return (
    <div className="app">
      <Sidebar
        timers={visible}
        counts={counts}
        tags={allTags}
        activeTag={activeTag}
        onTag={setActiveTag}
        selectedId={selectedId}
        onSelect={(id) => { setSelectedId(id); setView('focus'); }}
        onOpenClock={(id) => setFullscreenId(id)}
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        historyActive={view === 'history'}
        onToggleHistory={() => setView((v) => (v === 'history' ? 'focus' : 'history'))}
        onNew={() => setEditing({ mode: 'create' })}
        auth={auth}
        sync={sync}
        onSyncNow={() => window.timemark.syncNow()}
        onExport={() => window.timemark.exportData()}
        onImport={() => window.timemark.importData().then((r) => { if (r.ok) { refreshLedger(); showToast(`已导入 ${r.counts.timer_item ?? 0} 个计时项`); } else if (r.message) showToast(r.message); })}
        onLogout={handleLogout}
        onLogin={() => setLoginOpen(true)}
        currentVersion={appVer}
        dataDir={dataDir}
        update={{ checking: updateChecking, info: updateInfo }}
        onCheckUpdate={doCheckUpdate}
        onOpenRelease={doOpenRelease}
      />

      <main className="main">
        {timers.length === 0 ? (
          <div className="empty">
            <div className="art"><EmptyArt /></div>
            <div className="tip">
              还没有计时项<br />
              <b>日期倒计时</b>、<b>番茄钟</b>、<b>精确倒计时</b>、<b>正计时</b> —— 从新建开始
            </div>
            <button className="btn-accent" onClick={() => setEditing({ mode: 'create' })}><span>+ 新建第一个计时</span></button>
          </div>
        ) : view === 'history' ? (
          <HistoryView records={records} metas={metas} onChanged={refreshRecords} />
        ) : selected ? (
          <>
            <div className="title-row">
              <div className="title-group">
                <div className="title-name">
                  {selected.name}
                  {(selected.tags ?? []).map((tg) => <span key={tg} className="tag-chip mini"><span>{tg}</span></span>)}
                </div>
                <div className="title-desc">{typeDesc(selected)}</div>
              </div>
              <div className="title-actions">
                <button
                  className={`t-icon-btn ${selected.starred ? 'on-star' : ''}`}
                  title={selected.starred ? '取消星标' : '星标'}
                  onClick={() => window.timemark.update(selected.id, { starred: !selected.starred }).then((r) => mergeDto(r.timer))}
                >
                  <IconStar size={17} filled={selected.starred} />
                </button>
                <button
                  className={`t-icon-btn ${selected.pinned ? 'on-pin' : ''}`}
                  title={selected.pinned ? '取消置顶' : '置顶'}
                  onClick={() => window.timemark.update(selected.id, { pinned: !selected.pinned }).then((r) => mergeDto(r.timer))}
                >
                  <IconPin size={17} filled={selected.pinned} />
                </button>
                <button className="t-icon-btn" title="编辑" onClick={() => setEditing({ mode: 'edit', timer: selected })}>
                  <IconPencil size={16} />
                </button>
                <button
                  className="t-icon-btn danger"
                  title="删除"
                  onClick={async () => {
                    if (window.confirm(`确定删除「${selected.name}」吗？`)) {
                      await window.timemark.remove(selected.id);
                      setFullscreenId((f) => (f === selected.id ? null : f));
                      refreshRecords(); // 同步刷新历史记录来源与已删除计时元数据
                    }
                  }}
                >
                  <IconTrash size={16} />
                </button>
              </div>
              <WinControls />
            </div>

            <FocusStage key={selected.id} timer={selected} actions={buildActions(selected)} />

            <div className="overview">
              <div className="ov-item"><span className="ov-val">{formatFocus(stats.focusMs)}</span><span className="ov-label">今日专注</span></div>
              <div className="ov-item"><span className="ov-val">{stats.rounds}</span><span className="ov-label">完成轮次</span></div>
              <div className="ov-item"><span className="ov-val">{stats.marks}</span><span className="ov-label">累计打点</span></div>
              <div className="ov-item"><span className="ov-val">{stats.streak} 天</span><span className="ov-label">连续记录</span></div>
            </div>
          </>
        ) : (
          <div className="empty"><div className="tip">选择左侧任意计时开始聚焦</div></div>
        )}
      </main>

      {editing && <TimerForm target={editing} onClose={() => setEditing(null)} />}
      {fullscreenTimer && (
        <FullscreenClock
          timer={fullscreenTimer}
          onStart={() => buildActions(fullscreenTimer).start()}
          onPause={() => buildActions(fullscreenTimer).pause()}
          onResume={() => buildActions(fullscreenTimer).resume()}
          onSkip={() => buildActions(fullscreenTimer).skip()}
          onSegment={() => buildActions(fullscreenTimer).segment()}
          onStar={() => window.timemark.update(fullscreenTimer.id, { starred: !fullscreenTimer.starred }).then((r) => mergeDto(r.timer))}
          onPin={() => window.timemark.update(fullscreenTimer.id, { pinned: !fullscreenTimer.pinned }).then((r) => mergeDto(r.timer))}
          onEdit={() => setEditing({ mode: 'edit', timer: fullscreenTimer })}
          onClose={() => setFullscreenId(null)}
        />
      )}
      {loginOpen && (
        <LoginModal
          onClose={() => setLoginOpen(false)}
          onDone={async () => {
            setLoginOpen(false);
            setAuth(await window.timemark.authState());
            window.timemark.syncNow();
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

/** 自定义窗控（无边框窗口）：— □ ×，走 IPC；× 走既有 close 钩子 → 隐藏到托盘 */
function WinControls() {
  return (
    <div className="win-controls">
      <button className="win-btn" title="最小化" onClick={() => window.timemark.winControl('minimize')}><IconMinus size={15} /></button>
      <button className="win-btn" title="最大化 / 还原" onClick={() => window.timemark.winControl('maximize')}><IconSquare size={12} /></button>
      <button className="win-btn close" title="关闭到托盘" onClick={() => window.timemark.winControl('close')}><IconClose size={15} /></button>
    </div>
  );
}
