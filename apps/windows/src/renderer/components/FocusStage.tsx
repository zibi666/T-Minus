import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TimerDTO } from '../../shared/types';
import { formatHMS } from '../../shared/format';
import { isPomodoro, getPomodoro, mmss, lighten, glowColor, formatSeconds, cssVars } from '../helpers';
import { IconPause, IconPlay, IconReset, IconSegment, IconStop, IconArrowRight } from './icons';

export interface StageActions {
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  skip: () => void;      // 番茄钟：跳过当前阶段
  segment: () => void;   // 打点 / lap
  end: () => void;       // 结束并保存
  openClock: () => void;
}

interface Props {
  timer: TimerDTO;
  actions: StageActions;
}

/** 300px 大环（规范 §3：轨道白 7% 粗 10，进度 --tc 渐变圆头，12 点起点） */
function FocusRing({ p, color, dim, paused, center }: {
  p: number; color: string; dim?: boolean; paused?: boolean; center: React.ReactNode;
}) {
  const r = 140;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, p));
  const gid = useRef(`fr-${Math.random().toString(36).slice(2, 9)}`).current;
  return (
    <div className="ring-wrap" style={cssVars({ '--tc-glow': glowColor(color, 0.16) })}>
      <div className={`ring-glow ${dim ? 'ring-dim' : ''}`} />
      <svg
        className={`big-ring ${dim ? 'ring-dim' : ''} ${paused ? 'ring-paused' : ''}`}
        width="300" height="300" viewBox="0 0 300 300"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor={lighten(color)} />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx="150" cy="150" r={r} fill="none" strokeWidth="10" />
        <circle
          className="ring-prog"
          cx="150" cy="150" r={r} fill="none"
          stroke={`url(#${gid})`} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - clamped)}
          transform="rotate(-90 150 150)"
        />
      </svg>
      <div className={`ring-center ${dim ? 'ring-dim' : ''}`}>{center}</div>
    </div>
  );
}

/** 轮次指示点（番茄钟专属，规范 §3） */
function RoundDots({ round, rounds, active }: { round: number; rounds: number; active: boolean }) {
  const items: React.ReactNode[] = [];
  for (let i = 1; i <= rounds; i++) {
    if (i > 1) items.push(<span key={`s${i}`} className="rd-sep" />);
    const done = i < round;
    const cur = i === round && active;
    items.push(
      <span key={`d${i}`} className={`rd-dot ${done ? 'done' : ''} ${cur ? 'cur' : ''}`} />
    );
  }
  return <div className="round-dots">{items}</div>;
}

/** 里程碑面板：计时中标记重要时刻（note + 时刻），参与多端同步；复用 seg-card 样式 */
function MilestonePanel({ timerId, active }: { timerId: string; active: boolean }) {
  const [list, setList] = useState<Array<{ id: string; note: string; markedAt: number }>>([]);
  const reload = useCallback(() => { window.timemark.listMilestones(timerId).then(setList).catch(() => {}); }, [timerId]);
  useEffect(() => { reload(); }, [reload]);
  // 他端改的里程碑也要看得见：只在挂载/本机操作后重拉会等到重启
  useEffect(() => window.timemark.onDataChanged((table) => { if (table === 'milestone') reload(); }), [reload]);
  if (list.length === 0 && !active) return null;
  const hhmm = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const addBtnStyle: React.CSSProperties = { background: 'transparent', border: '1px solid var(--stroke)', color: 'var(--tc)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 12 };
  const delBtnStyle: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--text-low)', cursor: 'pointer', fontSize: 15, lineHeight: 1 };
  function add() {
    const note = window.prompt('里程碑备注（如：完成第一章）', '');
    if (note == null) return;
    window.timemark.addMilestone(timerId, note.trim()).then(reload).catch(() => {});
  }
  return (
    <div className="seg-card">
      <div className="seg-head">
        <span>里程碑 · {list.length}</span>
        {active && <button style={addBtnStyle} onClick={add}>+ 标记此刻</button>}
      </div>
      {list.length === 0 && <div className="seg-row"><span className="seg-name" style={{ opacity: 0.55 }}>计时中点「标记此刻」记录重要节点</span></div>}
      {list.map((m) => (
        <div className="seg-row" key={m.id}>
          <span className="seg-name">{m.note || '（无备注）'}</span>
          <span className="seg-val">{hhmm(m.markedAt)}</span>
          <button style={delBtnStyle} onClick={() => window.timemark.removeMilestone(m.id).then(reload).catch(() => {})} title="删除里程碑">×</button>
        </div>
      ))}
    </div>
  );
}

export default function FocusStage({ timer: t, actions }: Props) {
  const running = t.runState === 'running';
  const paused = t.runState === 'paused';
  const segs = t.segmentsMs ?? [];
  const tcStyle = cssVars({ '--tc': t.color, '--tc-light': lighten(t.color) });

  /* ---------- 番茄钟（阶段状态来自 DTO pomoPhase/pomoRound，引擎驱动） ---------- */
  if (isPomodoro(t)) {
    const cfg = getPomodoro(t);
    const phase = t.pomoPhase ?? 'focus';
    const round = t.pomoRound ?? 1;
    const isWork = phase === 'focus';
    const isLong = phase === 'long_break';
    const phaseMs = isWork ? cfg.work_ms : (isLong ? cfg.long_break_ms : cfg.break_ms);
    const rem = t.remainingMs ?? phaseMs;
    const p = running || paused ? (phaseMs > 0 ? rem / phaseMs : 0) : 1;
    const active = running || paused;
    const workMin = Math.round(cfg.work_ms / 60000);
    const phaseLabel = isWork ? '专注中' : (isLong ? '长休息中' : '休息中');
    // 长休息周期内的轮次位置（rounds = 长休息间隔，无限循环）
    const cyclePos = ((round - 1) % cfg.rounds) + 1;

    const status = !active
      ? `第 ${round} 轮 · 待开始 · 专注 ${workMin} 分钟`
      : `第 ${round} 轮 · ${phaseLabel} · 每 ${cfg.rounds} 轮一次长休息`;

    return (
      <div className="stage" style={tcStyle}>
        <FocusRing
          p={p} color={t.color} paused={paused}
          center={
            <>
              <div className="ring-num">{mmss(active || t.runState === 'idle' ? rem : phaseMs)}</div>
              <div className="ring-sub">{isWork ? '剩余' : '休息剩余'} {Math.round(p * 100)}%</div>
            </>
          }
        />
        <RoundDots round={cyclePos} rounds={cfg.rounds} active={active} />
        <div className="stage-status">{status}</div>
        <div className="stage-actions">
          {!active && <button className="btn-accent" onClick={actions.start}><IconPlay size={13} /><span>开始专注</span></button>}
          {running && <button className="btn-accent" onClick={actions.pause}><IconPause size={13} /><span>暂停</span></button>}
          {running && <button className="btn-ghost" onClick={actions.skip}><span>跳过</span></button>}
          {paused && <button className="btn-accent" onClick={actions.resume}><IconPlay size={13} /><span>继续</span></button>}
          {/* 结束 = 当前阶段已进行时长如实记账；重置 = 直接归零不记账（与 Android 同语义） */}
          {active && <button className="btn-ghost danger" onClick={actions.end}><IconStop size={12} /><span>结束</span></button>}
          {active && <button className="btn-ghost" onClick={actions.reset}><IconReset size={13} /><span>重置</span></button>}
        </div>
        <div className="stage-hints">Space 开始/暂停 · N 跳过 · 双击侧栏行进入台钟</div>
      </div>
    );
  }

  /* ---------- 精确倒计时（打点会话，规范 §4.2） ---------- */
  if (t.type === 'PRECISE_COUNTDOWN') {
    const preset = t.config.preset_ms ?? 0;
    const rem = t.remainingMs ?? preset;
    const p = running || paused ? (preset > 0 ? rem / preset : 0) : 1;
    const active = running || paused;

    return (
      <div className="stage" style={tcStyle}>
        <div className="stage-num-block">
          <div className="stage-num">{rem <= 0 ? <span className="dday-text">已完成</span> : formatHMS(rem)}</div>
          <div className="stage-desc">
            {active
              ? <>总时长 {formatHMS(preset)} · 剩余 {Math.round(p * 100)}% · 打点不打断倒计时</>
              : <>总时长 {formatHMS(preset)} · {preset > 0 ? '待开始' : '未设置时长'}</>}
          </div>
        </div>
        <div className="total-bar"><i style={{ transform: `scaleX(${p})` }} /></div>

        {(active || segs.length > 0) && (
          <div className="seg-card">
            <div className="seg-head">
              <span>已打点 {segs.length} 段 · 第 {segs.length + 1} 段{active ? '进行中' : ''}</span>
              <span className="note">段时长 = 相邻打点之差</span>
            </div>
            {segs.map((ms, i) => (
              <div className="seg-row" key={i} style={cssVars({ '--i': i })}>
                <span className="idx">{i + 1}.</span>
                <span className="seg-name">第 {i + 1} 段</span>
                <span className="seg-val">{formatHMS(ms)}</span>
              </div>
            ))}
            {active && (
              <div className="seg-row" style={cssVars({ '--i': segs.length })}>
                <span className="idx">{segs.length + 1}.</span>
                <span className="seg-name">第 {segs.length + 1} 段</span>
                <span className="seg-val live">进行中</span>
              </div>
            )}
          </div>
        )}

        <MilestonePanel timerId={t.id} active={running || paused} />
        <div className="stage-actions">
          {!active && <button className="btn-accent" onClick={actions.start}><IconPlay size={13} /><span>开始</span></button>}
          {(running || paused) && <button className="btn-accent" onClick={actions.segment}><IconSegment size={13} /><span>打点</span></button>}
          {running && <button className="btn-ghost" onClick={actions.pause}><IconPause size={13} /><span>暂停</span></button>}
          {paused && <button className="btn-accent" onClick={actions.resume}><IconPlay size={13} /><span>继续</span></button>}
          {(running || paused) && <button className="btn-ghost danger" onClick={actions.end}><IconStop size={12} /><span>结束</span></button>}
        </div>
        <div className="stage-hints">Space 暂停/继续 · N 打点 · 双击侧栏行进入台钟</div>
      </div>
    );
  }

  /* ---------- 正计时（秒表，保留 lap；只显示秒） ---------- */
  if (t.type === 'STOPWATCH') {
    const elapsed = t.elapsedMs ?? 0;
    const segSum = segs.reduce((a, b) => a + b, 0);
    const curLap = Math.max(0, elapsed - segSum);
    const active = running || paused;

    return (
      <div className="stage" style={tcStyle}>
        <div className="stage-num-block">
          <div className="stage-num">
            {formatSeconds(elapsed, running)}<span className="unit">秒</span>
          </div>
          <div className="stage-desc">
            {active
              ? <>本段 {formatSeconds(curLap)} 秒 · N 键记录一段（lap）</>
              : t.runState === 'idle'
                ? <>从 0 开始累计 · 支持分段与暂停</>
                : null}
          </div>
        </div>

        {segs.length > 0 && (
          <div className="seg-card">
            <div className="seg-head">
              <span>已计 {segs.length} 段 · 当前第 {segs.length + 1} 段</span>
              <span className="note">lap = 上段时长</span>
            </div>
            {segs.map((ms, i) => (
              <div className="seg-row" key={i} style={cssVars({ '--i': i })}>
                <span className="idx">{i + 1}.</span>
                <span className="seg-name">第 {i + 1} 段</span>
                <span className="seg-val">{formatSeconds(ms, true)} 秒</span>
              </div>
            ))}
          </div>
        )}

        <MilestonePanel timerId={t.id} active={running || paused} />
        <div className="stage-actions">
          {!active && <button className="btn-accent" onClick={actions.start}><IconPlay size={13} /><span>开始</span></button>}
          {(running || paused) && <button className="btn-accent" onClick={actions.segment}><IconSegment size={13} /><span>打点</span></button>}
          {running && <button className="btn-ghost" onClick={actions.pause}><IconPause size={13} /><span>暂停</span></button>}
          {paused && <button className="btn-accent" onClick={actions.resume}><IconPlay size={13} /><span>继续</span></button>}
          {(running || paused) && <button className="btn-ghost danger" onClick={actions.end}><IconStop size={12} /><span>停止并记录</span></button>}
        </div>
        <div className="stage-hints">Space 暂停/继续 · N 打点 · 双击侧栏行进入台钟</div>
      </div>
    );
  }

  /* ---------- 日期倒计时（D-Day） ---------- */
  const d = t.daysLeft ?? 0;
  return (
    <div className="stage" style={tcStyle}>
      <div className="stage-num-block">
        <div className="stage-num">
          {d === 0
            ? <span className="dday-text">就是今天</span>
            : <>{Math.abs(d)}<span className="unit">{d > 0 ? '天' : '天已过'}</span></>}
        </div>
        <div className="stage-desc">
          {d === 0
            ? <>目标日 {t.targetDate} 就是今天{t.remark ? ` · ${t.remark}` : ''}</>
            : <>距离 {t.targetDate}{t.remark ? ` · ${t.remark}` : ''} 还有 {Math.abs(d)} 天</>}
        </div>
      </div>
      <div className="stage-actions">
        <button className="btn-ghost" onClick={actions.openClock}><span>进入台钟</span> <IconArrowRight size={13} /></button>
      </div>
      <div className="stage-hints">双击侧栏行进入台钟 · Esc 返回</div>
    </div>
  );
}
