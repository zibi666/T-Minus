import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconCheck } from './icons';
import { cssVars } from '../helpers';

export interface SelectOption { value: string; label: string }

interface Props {
  value: string;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}

/**
 * 自绘下拉（替代原生 select：原生弹出列表是系统级控件，动画与配色不受页面控制）。
 * 交互：点击/Enter/Space/↑↓ 打开；↑↓/Home/End 移动高亮；Enter 选中；Esc 关闭；
 * type-ahead 快速定位（如年份直接敲 2026）；点击外部或窗口失焦关闭；
 * 底部空间不足时自动向上弹出；打开自动滚动到当前值。
 */
export default function Select({ value, options, placeholder = '请选择', ariaLabel, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [hl, setHl] = useState(0);
  const [dirUp, setDirUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const typeBuf = useRef<{ s: string; t: number }>({ s: '', t: 0 });

  const curIdx = options.findIndex((o) => o.value === value);
  const cur = curIdx >= 0 ? options[curIdx] : undefined;

  function openList() {
    if (disabled || open) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) setDirUp(window.innerHeight - rect.bottom < 260);
    setHl(curIdx >= 0 ? curIdx : 0);
    setOpen(true);
  }

  function requestClose() {
    if (!open || closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 150);
  }

  function commit(idx: number) {
    const o = options[idx];
    if (o) onChange(o.value);
    requestClose();
  }

  // 打开时把当前值滚进视野
  useLayoutEffect(() => {
    if (open && listRef.current) {
      const el = listRef.current.children[hl] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);

  // 高亮移动时保持可见
  useEffect(() => {
    if (open && listRef.current) {
      const el = listRef.current.children[hl] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [hl, open]);

  // 点击外部 / 窗口失焦关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) requestClose();
    };
    const onBlur = () => requestClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, closing]);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(hl); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(options.length - 1, h + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); return; }
    if (e.key === 'Home') { e.preventDefault(); setHl(0); return; }
    if (e.key === 'End') { e.preventDefault(); setHl(options.length - 1); return; }
    if (/^[0-9a-zA-Z]$/.test(e.key)) {
      const now = Date.now();
      const buf = now - typeBuf.current.t < 700 ? typeBuf.current.s + e.key : e.key;
      typeBuf.current = { s: buf, t: now };
      const idx = options.findIndex((o) => o.value.startsWith(buf) || o.label.startsWith(buf));
      if (idx >= 0) setHl(idx);
    }
  }

  return (
    <div className={`select ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="select-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? requestClose() : openList())}
        onKeyDown={onKeyDown}
      >
        <span className={`select-label ${cur ? '' : 'ph'}`}>{cur ? cur.label : placeholder}</span>
        <span className="chev" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className={`select-panel ${closing ? 'closing' : ''} ${dirUp ? 'up' : ''}`} ref={listRef} role="listbox">
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`select-item ${i === hl ? 'hl' : ''} ${o.value === value ? 'cur' : ''}`}
              style={cssVars({ '--i': Math.min(6, Math.abs(i - hl)) })}
              onMouseEnter={() => setHl(i)}
              onClick={() => commit(i)}
            >
              <span className="opt-label">{o.label}</span>
              {o.value === value && <span className="check"><IconCheck size={13} /></span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
