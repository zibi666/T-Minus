import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TimerMeta, RecordDTO } from '../../shared/types';
import { RECORD, TIMER_PALETTE, normalizePomodoro } from '../../shared/contract';
import { formatHMS, formatRemaining, localDateKey } from '../../shared/format';
import { isPomodoro, startOfToday, getSegName, setSegName, cssVars } from '../helpers';
import { IconClose, IconArrowRight, IconTrash } from './icons';
import Select from './Select';

/** 分段占比条用色：契约 8 色轮替，相邻段（含跨循环相邻）均不同色 */
const BAR_COLORS = TIMER_PALETTE;

type RangeKey = 'today' | '7d' | '30d' | 'all';
type KindKey = 'all' | 'pomodoro' | 'precise' | 'stopwatch' | 'date';

function kindOf(t: TimerMeta): KindKey {
  if (isPomodoro(t)) return 'pomodoro';
  if (t.type === 'PRECISE_COUNTDOWN') return 'precise';
  if (t.type === 'STOPWATCH') return 'stopwatch';
  return 'date';
}

/**
 * 番茄钟休息段不入历史卡片：
 * 新记录按 record_type 直接判定；v0.5.x 之前的记录没写阶段，只能退回「时长等于某个休息档」的猜测。
 */
function isPomodoroBreak(rec: RecordDTO, timerIsPomodoro: boolean, config: unknown): boolean {
  if (rec.recordType === RECORD.POMODORO_BREAK) return true;
  if (!timerIsPomodoro || rec.recordType !== RECORD.PRECISE) return false;
  const p = normalizePomodoro(config);
  const ms = rec.durationSec * 1000;
  return ms === p.break_ms || ms === p.long_break_ms;
}

const KIND_LABEL: Record<KindKey, string> = { all: '全部', pomodoro: '番茄钟', precise: '倒计时', stopwatch: '正计时', date: '日期' };
const RANGE_LABEL: Record<RangeKey, string> = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };

interface HistSeg { recId: string; label: string; ms: number; color: string }
interface HistEntry {
  key: string;
  timerId: string;
  name: string;
  color: string;
  kind: KindKey;
  deleted: boolean;
  totalMs: number;
  segs: HistSeg[];
  finalMs: number | null;
  recordIds: string[];
  startAt: number;
  endAt: number;
  marks: number;
}

function hm(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function dayTag(ts: number): string {
  return localDateKey(ts) === localDateKey(Date.now()) ? '今天' : localDateKey(ts);
}

function buildEntries(records: RecordDTO[], metas: TimerMeta[], since: number, until: number): HistEntry[] {
  const byId = new Map(metas.map((t) => [t.id, t]));
  const groups = new Map<string, RecordDTO[]>();
  for (const r of records) {
    if (r.endedAt < since || r.endedAt > until) continue;
    const t = byId.get(r.timerId);
    if (!t) continue;
    // 番茄钟休息段不入历史卡片（详见 isPomodoroBreak）
    if (isPomodoroBreak(r, isPomodoro(t), t.config)) continue;
    const k = `${r.timerId}:${r.sessionId ?? 'solo-' + r.id}`;
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }

  const entries: HistEntry[] = [];
  for (const [k, rs] of groups) {
    rs.sort((a, b) => a.startedAt - b.startedAt);
    const t = byId.get(rs[0].timerId)!;
    const segRecs = rs.filter((r) => r.recordType === 'SEGMENT');
    const finals = rs.filter((r) => r.recordType !== 'SEGMENT');
    const final = finals.length > 0 ? finals[finals.length - 1] : null;
    const segSum = segRecs.reduce((a, b) => a + b.durationSec, 0) * 1000;
    const totalMs = final ? final.durationSec * 1000 : segSum;

    const segs: HistSeg[] = segRecs.map((r, i) => ({
      recId: r.id,
      label: `第 ${i + 1} 段`,
      ms: r.durationSec * 1000,
      color: BAR_COLORS[i % BAR_COLORS.length]
    }));

    entries.push({
      key: k,
      timerId: t.id,
      name: t.name,
      color: t.color,
      kind: kindOf(t),
      deleted: t.deleted,
      totalMs: Math.max(totalMs, segSum),
      segs,
      finalMs: final ? final.durationSec * 1000 : null,
      recordIds: rs.map((r) => r.id),
      startAt: rs[0].startedAt,
      endAt: rs[rs.length - 1].endedAt,
      marks: segRecs.length
    });
  }
  entries.sort((a, b) => b.endAt - a.endAt);
  return entries;
}

interface Props {
  records: RecordDTO[];
  metas: TimerMeta[];
  onChanged: () => void;
}

export default function HistoryView({ records, metas, onChanged }: Props) {
  const [range, setRange] = useState<RangeKey>('today');
  const [kind, setKind] = useState<KindKey>('all');
  const [color, setColor] = useState<string>('all');
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const openedAtRef = useRef(0); // 弹窗打开时刻：遮罩 300ms 内的点击视为双击误触，不关闭
  const [, bump] = useState(0); // 分段重命名后强制刷新
  // 自定义查看某天（保留快捷范围的同时支持选具体日期）
  const [customOpen, setCustomOpen] = useState(false);
  const now0 = new Date();
  const [cy, setCy] = useState(String(now0.getFullYear()));
  const [cmo, setCmo] = useState(String(now0.getMonth() + 1));
  const [cd, setCd] = useState(String(now0.getDate()));
  const customDays = cy && cmo ? new Date(Number(cy), Number(cmo), 0).getDate() : 31;
  const customDay = Math.min(Number(cd) || 1, customDays);
  const customValid = customOpen && cy && cmo && cd;

  const since = useMemo(() => {
    if (customValid) return new Date(Number(cy), Number(cmo) - 1, customDay, 0, 0, 0, 0).getTime();
    if (range === 'today') return startOfToday();
    if (range === '7d') return startOfToday() - 6 * 86400000;
    if (range === '30d') return startOfToday() - 29 * 86400000;
    return 0;
  }, [customValid, cy, cmo, customDay, range]);
  const until = useMemo(() => (customValid ? since + 86400000 - 1 : Infinity), [customValid, since]);

  const entries = useMemo(() => buildEntries(records, metas, since, until), [records, metas, since, until]);
  const colorOptions = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) {
      if (kind !== 'all' && e.kind !== kind) continue;
      s.add(e.color);
    }
    return [...s];
  }, [entries, kind]);
  const filtered = useMemo(
    () => entries.filter((e) => (kind === 'all' || e.kind === kind) && (color === 'all' || e.color === color)),
    [entries, kind, color]
  );
  const detail = detailKey ? entries.find((e) => e.key === detailKey) ?? null : null;

  function toggleOpen(key: string) {
    setOpenKeys((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  /** 打开详情（记录打开时刻供遮罩误触判断） */
  function openDetail(key: string) {
    openedAtRef.current = Date.now();
    setDetailKey(key);
  }

  function closeDetail() {
    setDetailKey(null);
  }

  // 详情打开时 Esc 直接关弹窗（capture 阶段拦截，避免上层同时把页面切回聚焦）
  useEffect(() => {
    if (!detailKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeDetail();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [detailKey]);

  async function delRecords(ids: string[], msg: string) {
    if (!ids.length || !window.confirm(msg)) return;
    await window.timemark.deleteRecords(ids);
    onChanged();
    setDetailKey(null);
  }

  function saveSegName(recId: string, value: string) {
    setSegName(recId, value);
    bump((v) => v + 1);
  }

  return (
    <div className="history">
      <div className="history-head">
        <div>
          <div className="history-title">
            {customValid ? `${Number(cmo)} 月 ${customDay} 日` : range === 'today' ? '今日记录' : RANGE_LABEL[range]}
          </div>
          <div className="history-sub">结束自动保存 · 点击卡片查看详情，可重命名分段</div>
        </div>
      </div>

      <div className="hist-filters">
        <div className="hist-filter-row">
          {(['today', '7d', '30d', 'all'] as RangeKey[]).map((k) => (
            <button
              key={k}
              className={`filter-chip ${!customOpen && range === k ? 'active' : ''}`}
              onClick={() => { setRange(k); setCustomOpen(false); }}
            >
              <span>{RANGE_LABEL[k]}</span>
            </button>
          ))}
          <button className={`filter-chip ${customOpen ? 'active' : ''}`} onClick={() => setCustomOpen((v) => !v)}>
            <span>某天</span>
          </button>
          <span style={{ flex: 1 }} />
          <button className={`filter-chip ${color === 'all' ? 'active' : ''}`} onClick={() => setColor('all')}><span>全部颜色</span></button>
          {colorOptions.map((c) => (
            <button
              key={c}
              className={`cdot-btn ${color === c ? 'active' : ''}`}
              style={{ background: c }}
              title="按颜色筛选"
              onClick={() => setColor(color === c ? 'all' : c)}
            />
          ))}
        </div>
        {customOpen && (
          <div className="hist-custom-row">
            <Select
              ariaLabel="年"
              value={cy}
              placeholder="年"
              options={Array.from({ length: 12 }, (_, i) => ({ value: String(new Date().getFullYear() - 10 + i), label: `${new Date().getFullYear() - 10 + i}年` }))}
              onChange={setCy}
            />
            <Select
              ariaLabel="月"
              value={cmo}
              placeholder="月"
              options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}月` }))}
              onChange={(v) => { setCmo(v); const dim = new Date(Number(cy), Number(v), 0).getDate(); if (Number(cd) > dim) setCd(String(dim)); }}
            />
            <Select
              ariaLabel="日"
              value={String(customDay)}
              placeholder="日"
              options={Array.from({ length: customDays }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` }))}
              onChange={setCd}
            />
            <span className="hist-custom-tip">查看这一天的记录</span>
          </div>
        )}
        <div className="hist-filter-row">
          {(['all', 'pomodoro', 'precise', 'stopwatch', 'date'] as KindKey[]).map((k) => (
            <button key={k} className={`filter-chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
              <span>{KIND_LABEL[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="history-empty">当前筛选条件下暂无记录 · 任意计时结束后自动保存</div>
      )}

      <div className="history-list">
        {filtered.map((e, i) => {
          const open = openKeys.has(e.key);
          if (e.segs.length === 0) {
            return (
              <div className="rec-card single clickable" key={e.key} style={cssVars({ '--i': i })} onClick={() => openDetail(e.key)} title="点击查看详情">
                <div className="rec-single-main">
                  <div className="rec-single-name">
                    <span className="cdot" style={{ background: e.color }} />
                    {e.name}
                    <span className="kind-badge">{KIND_LABEL[e.kind]}</span>
                    {e.deleted && <span className="kind-badge deleted">计时已删除</span>}
                  </div>
                  <div className="rec-single-sub">{dayTag(e.endAt)} {hm(e.startAt)} · 单次计时</div>
                </div>
                <div className="rec-single-total">{formatHMS(e.totalMs)}</div>
              </div>
            );
          }
          return (
            <div
              className={`rec-card clickable ${open ? 'open' : ''}`}
              key={e.key}
              style={cssVars({ '--i': i })}
              onClick={() => openDetail(e.key)}
              title="点击查看详情"
            >
              <div className="rec-head clickable">
                <span className="rec-name">
                  <span className="cdot" style={{ background: e.color }} />
                  {e.name}
                  <span className="kind-badge">{KIND_LABEL[e.kind]}</span>
                  {e.deleted && <span className="kind-badge deleted">计时已删除</span>}
                </span>
                <span className="rec-date">{dayTag(e.endAt)} {hm(e.startAt)} ~ {hm(e.endAt)}</span>
                <button
                  className={`rec-chevron ${open ? 'open' : ''}`}
                  title={open ? '收起分段' : '展开分段'}
                  onClick={(ev) => { ev.stopPropagation(); toggleOpen(e.key); }}
                >
                  <IconArrowRight size={13} />
                </button>
              </div>
              <div className="rec-total-row">
                <span className="rec-total">{formatHMS(e.totalMs)}</span>
                <span className="rec-total-note">总用时 · 打点 {e.marks} 段</span>
              </div>
              <div className="rec-bar">
                {e.segs.map((s, j) => (
                  <i key={j} style={{ flexGrow: Math.max(1, s.ms), background: s.color }} />
                ))}
              </div>
              <div className="rec-seg-wrap" aria-hidden={!open}>
                <div className="rec-seg-clip">
                  <div className="rec-seg-list">
                    {e.segs.map((s) => (
                      <div className="rec-seg-row" key={s.recId}>
                        <span className="cdot" style={{ background: s.color }} />
                        <span className="seg-name">{getSegName(s.recId) ?? s.label}</span>
                        <span className="seg-val" style={{ color: s.color }}>{formatRemaining(s.ms)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {detail && createPortal(
        <div
          className="modal-mask"
          onClick={() => { if (Date.now() - openedAtRef.current > 300) closeDetail(); }}
        >
          <div className="modal rec-detail" onClick={(ev) => ev.stopPropagation()}>
            <button className="modal-close" onClick={closeDetail} title="关闭"><IconClose size={15} /></button>
            <h2>{detail.name}</h2>
            <div className="rec-detail-sub">
              <span className="kind-badge">{KIND_LABEL[detail.kind]}</span>
              {detail.deleted && <span className="kind-badge deleted">计时已删除</span>}
              <span>{dayTag(detail.endAt)} {hm(detail.startAt)} ~ {hm(detail.endAt)}</span>
            </div>
            <div className="rec-detail-total">
              <span className="rec-total">{formatHMS(detail.totalMs)}</span>
              <span className="rec-total-note">总用时 · 打点 {detail.marks} 段</span>
            </div>

            {detail.segs.length > 0 ? (
              <div className="rec-detail-segs">
                {detail.segs.map((s, i) => (
                  <div className="seg-edit-row" key={s.recId}>
                    <span className="cdot" style={{ background: s.color }} />
                    <span className="idx">{i + 1}.</span>
                    <input
                      className="seg-name-input"
                      defaultValue={getSegName(s.recId) ?? `第 ${i + 1} 段`}
                      maxLength={30}
                      placeholder={`第 ${i + 1} 段`}
                      title="点击重命名分段（回车或失焦保存）"
                      onBlur={(ev) => saveSegName(s.recId, ev.target.value)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }}
                    />
                    <span className="seg-val" style={{ color: s.color }}>{formatRemaining(s.ms)}</span>
                    <button className="del-seg" title="删除此分段" onClick={() => delRecords([s.recId], '确定删除这个分段吗？')}>
                      <IconTrash size={13} />
                    </button>
                  </div>
                ))}
                {detail.finalMs != null && (
                  <div className="seg-edit-row final">
                    <span className="cdot" style={{ background: detail.color }} />
                    <span className="idx">✓</span>
                    <span className="seg-name final-label">最终结算</span>
                    <span className="seg-val">{formatHMS(detail.finalMs)}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="rec-detail-single">单次计时 · {formatHMS(detail.totalMs)}</div>
            )}

            <div className="rec-detail-foot">
              <button
                className="btn-danger-ghost"
                onClick={() => delRecords(detail.recordIds, '删除后不可恢复（多端同步一并删除），确定删除本次记录吗？')}
              >
                <IconTrash size={13} /> <span>删除本次记录</span>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
