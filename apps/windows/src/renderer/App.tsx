import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TimerDTO, TimerMeta, AuthInfo, SyncStatusInfo, RecordDTO, RunState, PomodoroInfo } from '../shared/types';
import { formatRemaining } from '../shared/format';
import Sidebar, { FilterKey } from './components/Sidebar';
import FocusStage, { StageActions } from './components/FocusStage';
import HistoryView from './components/HistoryView';
import FullscreenClock from './components/FullscreenClock';
import TimerForm, { EditTarget } from './components/TimerForm';
import LoginModal from './components/LoginModal';
import { EmptyArt, IconStar, IconPin, IconPencil, IconTrash, IconMinus, IconSquare, IconClose } from './components/icons';
import {
  isPomodoro, getPomodoro, formatFocus, startOfToday, localDateKey,
  journalAdd, PomoJournal, loadJournal, PomoPhase, loadPomoState, savePomoState
} from './helpers';

// 同步服务地址已内置（与主进程 syncClient 一致），不向用户暴露配置项
const SYNC_SERVER = 'http://118.195.133.25:18080';

export default function App() {
  const [timers, setTimers] = useState<TimerDTO[]>([]);
  const [records, setRecords] = useState<RecordDTO[]>([]);
  const [metas, setMetas] = useState<TimerMeta[]>([]);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [sync, setSync] = useState<SyncStatusInfo>({ state: 'idle', lastSyncAt: null, pending: 0, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [view, setView] = useState<'focus' | 'history'>('focus');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

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

  // ---- 番茄钟循环状态（渲染层驱动；每阶段 = 引擎一次 deadline 精确倒计时，绝不 tick 累加） ----
  const [pomoState, setPomoState] = useState<Record<string, PomoPhase>>(loadPomoState);
  const pomoStateRef = useRef(pomoState);
  const [journal, setJournal] = useState<PomoJournal>(loadJournal);
  const prevRun = useRef<Map<string, RunState>>(new Map());
  const transitioning = useRef<Set<string>>(new Set()); // 阶段切换中：抑制到点误判
  const manual = useRef<Set<string>>(new Set());         // 用户主动重置/跳过：抑制自动推进

  function setPomo(next: Record<string, PomoPhase>) {
    pomoStateRef.current = next;
    setPomoState(next);
    savePomoState(next);
  }

  const refreshMetas = useCallback(() => {
    window.timemark.listMetas().then(setMetas).catch(() => {});
  }, []);

  const refreshRecords = useCallback(() => {
    window.timemark.listRecords(400).then(setRecords).catch(() => { /* 本地无记录可忽略 */ });
    refreshMetas(); // 含已删除计时，历史页据此保留记录
  }, [refreshMetas]);

  // ---- 即时反馈与渲染减负 ----
  const lastSyncRef = useRef<SyncStatusInfo | null>(null);

  /** 同步状态浅比较：内容未变不触发 re-render（syncing 每 4s 重复 emit、对象身份每次都变） */
  function applySync(s: SyncStatusInfo) {
    const p = lastSyncRef.current;
    if (p && p.state === s.state && p.pending === s.pending && p.error === s.error && p.lastSyncAt === s.lastSyncAt) return;
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
    refreshRecords();
    const offTick = window.timemark.onTick(applyTick);
    const offSync = window.timemark.onSyncStatus(applySync);
    return () => {
      offTick && offTick();
      offSync && offSync();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRecords]);

  /** 500ms tick：更新列表 + 监测 running→idle（自然到点）驱动番茄钟循环 */
  function applyTick(p: { now: number; timers: TimerDTO[] }) {
    setTimers(p.timers);
    const finished: TimerDTO[] = [];
    for (const t of p.timers) {
      const prev = prevRun.current.get(t.id);
      prevRun.current.set(t.id, t.runState);
      if (prev === 'running' && t.runState === 'idle') finished.push(t);
    }
    if (finished.length === 0) return;
    refreshRecords(); // 自然到点会写入记录 → 刷新今日统计
    for (const t of finished) {
      if (isPomodoro(t) && !transitioning.current.has(t.id) && !manual.current.has(t.id)) {
        void advanceAfterPhase(t.id);
      }
    }
  }

  /** 番茄钟阶段自然到点：专注→休息/完轮；休息→下一轮专注 */
  async function advanceAfterPhase(id: string) {
    const t = timersRef.current.find((x) => x.id === id);
    if (!t) return;
    const cfg = getPomodoro(t);
    const cur = pomoStateRef.current[id] ?? { phase: 'work' as const, round: 1 };
    if (cur.phase === 'work') {
      setJournal((j) => journalAdd(j, { workCount: 1, workMs: cfg.work_ms }));
      if (cur.round < cfg.rounds) {
        await startPhase(id, cfg, 'break', cur.round);
      } else {
        const next = { ...pomoStateRef.current };
        delete next[id];
        setPomo(next); // 整轮循环完成
      }
    } else {
      setJournal((j) => journalAdd(j, { breakMs: cfg.break_ms }));
      await startPhase(id, cfg, 'work', cur.round + 1);
    }
  }

  /** 开启某阶段：先把 preset_ms 更新为阶段时长（引擎到点记录才准确），再按 durationMs 启动 */
  async function startPhase(id: string, cfg: PomodoroInfo, phase: 'work' | 'break', round: number) {
    transitioning.current.add(id);
    try {
      setPomo({ ...pomoStateRef.current, [id]: { phase, round } });
      const ms = phase === 'work' ? cfg.work_ms : cfg.break_ms;
      await window.timemark.update(id, { config: { schema_version: 1, preset_ms: ms, pomodoro: cfg } });
      mergeDto(await window.timemark.start(id, { durationMs: ms }));
    } finally {
      transitioning.current.delete(id);
    }
  }

  // 定时器镜像（异步回调里读最新列表）
  const timersRef = useRef<TimerDTO[]>([]);
  useEffect(() => { timersRef.current = timers; }, [timers]);

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

  // ---- 今日概览统计 ----
  const stats = useMemo(() => {
    const todayKey = localDateKey(Date.now());
    const j = journal[todayKey] ?? { workCount: 0, workMs: 0, breakMs: 0 };
    const pomoIds = new Set(timers.filter(isPomodoro).map((t) => t.id));
    const since = startOfToday();
    let focusMs = j.workMs;
    let marks = 0;
    let extraRounds = 0; // 非番茄钟的完整计时次数（倒计时到点 / 正计时结算）
    const daySet = new Set<string>();
    for (const r of records) {
      daySet.add(localDateKey(r.endedAt));
      if (r.endedAt < since) continue;
      if (r.recordType === 'SEGMENT') {
        marks++;
        focusMs += r.durationSec * 1000;
      } else if (!pomoIds.has(r.timerId)) {
        focusMs += r.durationSec * 1000; // 番茄钟专注走 journal，避免休息段混入
        extraRounds += 1; // 完整跑完一次也计一轮专注
      }
    }
    for (const k of Object.keys(journal)) {
      if (journal[k].workCount > 0 || journal[k].workMs > 0) daySet.add(k);
    }
    let streak = 0;
    const cursor = new Date();
    if (!daySet.has(localDateKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
    while (daySet.has(localDateKey(cursor.getTime()))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { focusMs, rounds: j.workCount + extraRounds, marks, streak };
  }, [records, timers, journal]);

  // ---- 用户动作 ----
  async function pomoStart(t: TimerDTO) {
    const cfg = getPomodoro(t);
    const cur = pomoStateRef.current[t.id];
    if (!cur) await startPhase(t.id, cfg, 'work', 1);
    else await startPhase(t.id, cfg, cur.phase, cur.round);
  }

  async function pomoSkip(t: TimerDTO) {
    const cfg = getPomodoro(t);
    const cur = pomoStateRef.current[t.id] ?? { phase: 'work' as const, round: 1 };
    manual.current.add(t.id);
    try {
      mergeDto(await window.timemark.reset(t.id));
      // 跳过也如实计账：专注段计入专注时长与完成轮次，休息段计入休息时长（>5s 才计，防误触）
      if (t.runState === 'running' || t.runState === 'paused') {
        const phaseMs = cur.phase === 'work' ? cfg.work_ms : cfg.break_ms;
        const elapsed = Math.max(0, Math.min(phaseMs, phaseMs - (t.remainingMs ?? phaseMs)));
        if (elapsed > 5000) {
          if (cur.phase === 'work') setJournal((j) => journalAdd(j, { workCount: 1, workMs: elapsed }));
          else setJournal((j) => journalAdd(j, { breakMs: elapsed }));
        }
      }
      const next = { ...pomoStateRef.current };
      const finishCycle = cur.phase === 'work' ? cur.round >= cfg.rounds : cur.round >= cfg.rounds;
      if (finishCycle) {
        delete next[t.id];
        setPomo(next);
      } else if (cur.phase === 'work') {
        await startPhase(t.id, cfg, 'break', cur.round);
      } else {
        await startPhase(t.id, cfg, 'work', cur.round + 1);
      }
    } finally {
      manual.current.delete(t.id);
    }
  }

  async function pomoReset(t: TimerDTO) {
    manual.current.add(t.id);
    try {
      mergeDto(await window.timemark.reset(t.id));
      const next = { ...pomoStateRef.current };
      delete next[t.id];
      setPomo(next);
    } finally {
      manual.current.delete(t.id);
    }
  }

  function buildActions(t: TimerDTO): StageActions {
    return {
      start: () => (isPomodoro(t) ? pomoStart(t) : window.timemark.start(t.id).then(mergeDto)),
      pause: () => window.timemark.pause(t.id).then(mergeDto),
      resume: () => window.timemark.resume(t.id).then(mergeDto),
      reset: () => (isPomodoro(t) ? pomoReset(t) : window.timemark.reset(t.id).then(mergeDto)),
      skip: () => { if (isPomodoro(t)) void pomoSkip(t); },
      segment: async () => {
        mergeDto(await window.timemark.segment(t.id));
        refreshRecords();
      },
      end: async () => {
        if (t.type === 'STOPWATCH') {
          mergeDto(await window.timemark.stop(t.id));
        } else if (t.runState === 'running' || t.runState === 'paused') {
          // 提前结束（运行/暂停均可）：把已进行时长如实打点保存，再复位，不丢数据
          mergeDto(await window.timemark.segment(t.id));
          mergeDto(await window.timemark.reset(t.id));
        } else {
          mergeDto(await window.timemark.reset(t.id));
        }
        refreshRecords();
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
    if (isPomodoro(t)) void pomoSkip(t);
    else if (t.type === 'PRECISE_COUNTDOWN' || t.type === 'STOPWATCH') {
      window.timemark.segment(t.id).then(() => refreshRecords());
    }
  }

  // ---- 快捷键：Space 暂停/继续 · N 跳过/打点 · Esc 返回 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, fullscreenTimer, editing, loginOpen, fullscreenId, view]);

  async function handleLogout() {
    await window.timemark.logout();
    setAuth(await window.timemark.authState());
  }

  const typeDesc = (t: TimerDTO): string => {
    if (isPomodoro(t)) {
      const c = getPomodoro(t);
      return `番茄钟 · 专注 ${Math.round(c.work_ms / 60000)} 分钟 × ${c.rounds} 轮`;
    }
    if (t.type === 'PRECISE_COUNTDOWN') return `精确倒计时 · 总时长 ${formatRemaining((t.config as any).preset_ms ?? 0)}`;
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
                  onClick={() => window.timemark.update(selected.id, { starred: !selected.starred }).then(mergeDto)}
                >
                  <IconStar size={17} filled={selected.starred} />
                </button>
                <button
                  className={`t-icon-btn ${selected.pinned ? 'on-pin' : ''}`}
                  title={selected.pinned ? '取消置顶' : '置顶'}
                  onClick={() => window.timemark.update(selected.id, { pinned: !selected.pinned })}
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

            <FocusStage key={selected.id} timer={selected} pomoPhase={pomoState[selected.id] ?? null} actions={buildActions(selected)} />

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
          pomoPhase={pomoState[fullscreenTimer.id] ?? null}
          onStart={() => (isPomodoro(fullscreenTimer) ? pomoStart(fullscreenTimer) : window.timemark.start(fullscreenTimer.id).then(mergeDto))}
          onPause={() => window.timemark.pause(fullscreenTimer.id).then(mergeDto)}
          onResume={() => window.timemark.resume(fullscreenTimer.id).then(mergeDto)}
          onSkip={() => { if (isPomodoro(fullscreenTimer)) void pomoSkip(fullscreenTimer); }}
          onSegment={() => buildActions(fullscreenTimer).segment()}
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
