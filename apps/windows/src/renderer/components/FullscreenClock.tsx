import React, { useEffect, useRef, useState } from 'react';
import { TimerDTO } from '../../shared/types';
import { formatHMS, formatElapsed } from '../../shared/format';
import { isPomodoro, getPomodoro, mmss, glowColor, lighten, formatSeconds, PomoPhase } from '../helpers';
import { IconClose, IconPause, IconPlay, IconSegment } from './icons';

const TYPE_LABEL: Record<string, string> = {
  DATE_COUNTDOWN: '日期倒计时',
  PRECISE_COUNTDOWN: '精确倒计时',
  STOPWATCH: '正计时'
};

interface Props {
  timer: TimerDTO;
  pomoPhase: PomoPhase | null;
  onPause: () => void;
  onResume: () => void;
  onStart: () => void;
  onSkip: () => void;
  onSegment: () => void;
  onClose: () => void;
}

export default function FullscreenClock({ timer: t, pomoPhase, onPause, onResume, onStart, onSkip, onSegment, onClose }: Props) {
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
  const phase: PomoPhase = pomoPhase ?? { phase: 'work', round: 1 };

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
    const preset = (t.config as any).preset_ms ?? 0;
    const ms = running || paused ? (t.remainingMs ?? 0) : preset;
    giant = formatHMS(ms);
    if (isPomo && cfg) {
      const isWork = phase.phase === 'work';
      sub = `第 ${phase.round}/${cfg.rounds} ${isWork ? '轮 · 专注中' : '轮 · 休息中'} · ${isWork ? '专注' : '休息'} ${Math.round((isWork ? cfg.work_ms : cfg.break_ms) / 60000)} 分钟`;
    } else {
      sub = running || paused
        ? <>总时长 {formatHMS(preset)} · 剩余 {preset > 0 ? Math.round(((t.remainingMs ?? 0) / preset) * 100) : 0}%</>
        : <>总时长 {formatHMS(preset)} · 待开始</>;
    }
  } else {
    giant = <>{formatSeconds(t.elapsedMs ?? 0, running)}<span className="unit">秒</span></>;
    sub = running ? '计时中' : paused ? '已暂停' : '待开始';
  }

  const dotStyle = { background: t.color } as React.CSSProperties;
  const glowVars = {
    ['--tc' as any]: t.color,
    ['--tc-glow' as any]: glowColor(t.color, 0.14)
  } as React.CSSProperties;

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
              const done = n < phase.round;
              const cur = n === phase.round && (running || paused);
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
