import React, { useEffect, useRef, useState } from 'react';
import { TimerDTO } from '../../shared/types';
import { formatHMS, formatElapsed } from '../../shared/format';
import { isPomodoro, getPomodoro, mmss, glowColor, cssVars } from '../helpers';
import { IconClose, IconPause, IconPlay, IconSegment, IconStar, IconPin, IconPencil } from './icons';

const TYPE_LABEL: Record<string, string> = {
  DATE_COUNTDOWN: '日期倒计时',
  PRECISE_COUNTDOWN: '精确倒计时',
  STOPWATCH: '正计时'
};

interface Props {
  timer: TimerDTO;
  onPause: () => void;
  onResume: () => void;
  onStart: () => void;
  onSkip: () => void;
  onSegment: () => void;
  onClose: () => void;
  /** 台钟内快捷操作：不必退出全屏就能改归属/配置 */
  onStar: () => void;
  onPin: () => void;
  onEdit: () => void;
}

export default function FullscreenClock({ timer: t, onPause, onResume, onStart, onSkip, onSegment, onClose, onStar, onPin, onEdit }: Props) {
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  function requestClose() {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 260);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
      if (e.code === 'Space') e.preventDefault(); // 全屏态 Space 交给上层（App 仍监听）
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    };
  }, []);

  const running = t.runState === 'running';
  const paused = t.runState === 'paused';
  const isPomo = isPomodoro(t);
  const cfg = isPomo ? getPomodoro(t) : null;
  const phase = t.pomoPhase ?? 'focus';
  const round = t.pomoRound ?? 1;
  const cyclePos = cfg ? ((round - 1) % cfg.rounds) + 1 : 1;

  let giant: React.ReactNode;
  let sub: React.ReactNode = null;

  if (t.type === 'DATE_COUNTDOWN') {
    const d = t.daysLeft ?? 0;
    giant = d === 0
      ? <span className="dday-text" style={{ fontSize: 96 }}>就是今天</span>
      : <>{Math.abs(d)}<span className="unit">{d > 0 ? '天' : '天已过'}</span></>;
    sub = d === 0
      ? <>目标日 {t.targetDate} 就是今天{t.remark ? ` · ${t.remark}` : ''}</>
      : <>距离 {t.targetDate}{t.remark ? ` · ${t.remark}` : ''} 还有 {Math.abs(d)} 天</>;
  } else if (t.type === 'PRECISE_COUNTDOWN') {
    const preset = t.config.preset_ms ?? 0;
    const ms = running || paused ? (t.remainingMs ?? 0) : preset;
    giant = formatHMS(ms);
    if (isPomo && cfg) {
      const isWork = phase === 'focus';
      const isLong = phase === 'long_break';
      const phaseLabel = isWork ? '专注中' : (isLong ? '长休息中' : '休息中');
      const phaseMin = Math.round((isWork ? cfg.work_ms : (isLong ? (cfg.long_break_ms ?? 15 * 60000) : cfg.break_ms)) / 60000);
      sub = `第 ${round} 轮 · ${phaseLabel} · 本段 ${phaseMin} 分钟 · 每 ${cfg.rounds} 轮长休息`;
    } else {
      sub = running || paused
        ? <>总时长 {formatHMS(preset)} · 剩余 {preset > 0 ? Math.round(((t.remainingMs ?? 0) / preset) * 100) : 0}%</>
        : <>总时长 {formatHMS(preset)} · 待开始</>;
    }
  } else {
    // 正计时与移动端同口径（hh:mm:ss，运行中带百分秒）；不再退回「5400 秒」式裸秒数
    giant = <>{formatElapsed(t.elapsedMs ?? 0, running)}</>;
    sub = running ? '计时中' : paused ? '已暂停' : '待开始';
  }

  const dotStyle = { background: t.color } as React.CSSProperties;
  const glowVars = cssVars({ '--tc': t.color, '--tc-glow': glowColor(t.color, 0.14) });

  return (
    <div className={`clock-mask ${closing ? 'closing' : ''}`} style={glowVars}>
      <button className="clock-close" onClick={requestClose} title="关闭 (Esc)"><IconClose size={16} /></button>

      <div className="clock-stage">
        <div className="clock-name-row">
          <span className="cdot" style={dotStyle} />
          {t.name}
          <span className="type-badge">{isPomo ? '番茄钟' : TYPE_LABEL[t.type] ?? ''}</span>
          {paused && <span className="type-badge" style={{ color: 'var(--warn)', borderColor: 'rgba(255,178,36,.3)', background: 'rgba(255,178,36,.08)' }}>已暂停</span>}
        </div>

        <div className="clock-tools">
          <button
            className={`clock-tool ${t.starred ? 'on-star' : ''}`}
            title={t.starred ? '取消星标' : '星标'}
            onClick={onStar}
          ><IconStar size={15} filled={t.starred} /></button>
          <button
            className={`clock-tool ${t.pinned ? 'on-pin' : ''}`}
            title={t.pinned ? '取消置顶' : '置顶'}
            onClick={onPin}
          ><IconPin size={15} filled={t.pinned} /></button>
          <button className="clock-tool" title="编辑" onClick={onEdit}><IconPencil size={14} /></button>
        </div>

        <div className="clock-giant">{giant}</div>
        {sub && <div className="clock-sub">{sub}</div>}

        {/* 已打点分段（非番茄钟的倒计时/正计时） */}
        {!isPomo && t.type !== 'DATE_COUNTDOWN' && ((t.segmentsMs?.length ?? 0) > 0 || running) && (
          <div className="clock-segs">
            {(t.segmentsMs ?? []).map((ms, i) => (
              <span className="clock-seg-chip" key={i}><b>{i + 1}</b>{mmss(ms)}</span>
            ))}
            {running && <span className="clock-seg-chip live"><b>{(t.segmentsMs?.length ?? 0) + 1}</b>进行中</span>}
          </div>
        )}

        {isPomo && cfg && (
          <div className="round-dots">
            {Array.from({ length: cfg.rounds }, (_, i) => {
              const n = i + 1;
              const done = n < cyclePos;
              const cur = n === cyclePos && (running || paused);
              return (
                <React.Fragment key={n}>
                  {n > 1 && <span className="rd-sep" />}
                  <span className={`rd-dot ${done ? 'done' : ''} ${cur ? 'cur' : ''}`} />
                </React.Fragment>
              );
            })}
          </div>
        )}

        {(t.type !== 'DATE_COUNTDOWN') && (
          <div className="clock-actions">
            {!running && !paused && <button className="btn-accent" onClick={onStart}><IconPlay size={13} /><span>开始</span></button>}
            {running && <button className="btn-accent" onClick={onPause}><IconPause size={13} /><span>暂停</span></button>}
            {paused && <button className="btn-accent" onClick={onResume}><IconPlay size={13} /><span>继续</span></button>}
            {running && !isPomo && <button className="btn-ghost" onClick={onSegment} title="N 键也可打点"><IconSegment size={13} /><span>打点</span></button>}
            {isPomo && running && <button className="btn-ghost" onClick={onSkip}><span>跳过</span></button>}
          </div>
        )}
      </div>

      <div className="clock-hint">双击侧栏行进入台钟 · N 打点 · Esc 返回</div>
    </div>
  );
}
