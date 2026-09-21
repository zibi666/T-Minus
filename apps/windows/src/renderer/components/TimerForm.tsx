import React, { useEffect, useRef, useState } from 'react';
import { TimerType, TimerDTO, TimerConfigView } from '../../shared/types';
import {
  CLAMPS, TIMER_PALETTE, DEFAULT_TIMER_COLOR, buildPomodoroConfig, buildPreciseConfig, normalizePomodoro
} from '../../shared/contract';
import { formatRemaining } from '../../shared/format';
import { isPomodoro } from '../helpers';
import { IconCalendar, IconHourglass, IconTimer, IconRepeat, IconClose, IconPlus } from './icons';
import Select from './Select';

export interface EditTarget {
  mode: 'create' | 'edit';
  timer?: TimerDTO;
}

/** v3 计时器色板（规范 §1.3 --tc 8 色，单一来源见 shared/contract） */
const COLORS = TIMER_PALETTE;

/** 毫秒上下界 → 分钟上下界（表单以分钟为输入单位） */
const minOf = ([lo]: readonly [number, number]) => Math.ceil(lo / 60000);
const maxOf = ([, hi]: readonly [number, number]) => Math.floor(hi / 60000);

/** 表单里的番茄钟时长以「分钟」为单位存取，落库前换算 */
interface PomoMin { workMin: number; breakMin: number; longMin: number; rounds: number }

function minutesOfPomodoro(t?: TimerDTO): PomoMin {
  const p = normalizePomodoro(t?.config);
  return {
    workMin: Math.round(p.work_ms / 60000),
    breakMin: Math.round(p.break_ms / 60000),
    longMin: Math.round(p.long_break_ms / 60000),
    rounds: p.rounds
  };
}

/** 预设毫秒 → 天/时/分/秒四段（缺省 25 分） */
function splitPreset(ms?: number) {
  const v = Math.max(0, Math.round(ms ?? 0));
  return {
    days: Math.floor(v / 86400000),
    hours: Math.floor((v % 86400000) / 3600000),
    minutes: v ? Math.floor((v % 3600000) / 60000) : 25,
    seconds: Math.floor((v % 60000) / 1000)
  };
}

/** 数字输入：悬停滚轮直接加减（原生非 passive 监听，阻页滚动），步长 step，范围 [min,max] */
function WheelNumber({ value, min, max, step = 1, onChange }: {
  value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const valRef = useRef(value);
  valRef.current = value;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = (valRef.current || 0) + dir * step;
      const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, Math.round(next)));
      if (clamped !== valRef.current) onChange(clamped);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [min, max, step, onChange]);
  return (
    <input
      ref={ref} type="number" min={min} max={max} value={value}
      onChange={(e) => onChange(+e.target.value)}
      title="滚轮加减数值"
    />
  );
}

/** 表单内部类型：番茄钟承载于 PRECISE_COUNTDOWN + pomodoro 配置 */
type FormType = TimerType | 'POMODORO';

/** 日期选择：三列下拉（年/月/日），联动天数与闰年 */
function useDateParts(initial?: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(initial || '');
  const [y, setY] = useState(m ? m[1] : '');
  const [mo, setMo] = useState(m ? String(Number(m[2])) : '');
  const [d, setD] = useState(m ? String(Number(m[3])) : '');
  const yearNow = new Date().getFullYear();
  // 年份范围与 Android/Harmony 对齐：当前年-10 ~ 当前年+30（旧版本 -20..+40 与两端不一致）
  const years: string[] = [];
  for (let i = yearNow - 10; i <= yearNow + 30; i++) years.push(String(i));
  const daysInMonth = y && mo ? new Date(Number(y), Number(mo), 0).getDate() : 31;
  const dayMax = Math.min(d ? Number(d) : 1, daysInMonth);
  function setMonth(v: string) {
    setMo(v);
    const dim = y ? new Date(Number(y), Number(v), 0).getDate() : 31;
    if (d && Number(d) > dim) setD(String(dim));
  }
  function setYear(v: string) {
    setY(v);
    if (mo) {
      const dim = new Date(Number(v), Number(mo), 0).getDate();
      if (d && Number(d) > dim) setD(String(dim));
    }
  }
  // targetDate 必须与界面显示的日一致（下拉始终显示 dayMax 兜底 1）：
  // 用未提交的原始 d 判空会出现「显示 1 日却报请选择目标日期」的自相矛盾
  const targetDate = y && mo
    ? `${y}-${String(Number(mo)).padStart(2, '0')}-${String(dayMax || 1).padStart(2, '0')}`
    : '';
  return { y, mo, d: dayMax ? String(dayMax) : d, years, daysInMonth, setYear, setMonth, setDay: setD, targetDate };
}

const TYPE_LABELS: Record<FormType, string> = {
  DATE_COUNTDOWN: '日期倒计时',
  POMODORO: '番茄钟',
  PRECISE_COUNTDOWN: '精确倒计时',
  STOPWATCH: '正计时'
};

const TYPE_ICONS: Record<FormType, React.ReactNode> = {
  DATE_COUNTDOWN: <IconCalendar size={14} />,
  POMODORO: <IconRepeat size={14} />,
  PRECISE_COUNTDOWN: <IconHourglass size={14} />,
  STOPWATCH: <IconTimer size={14} />
};

export default function TimerForm({ target, onClose }: { target: EditTarget; onClose: () => void }) {
  const t = target.timer;
  const isEdit = target.mode === 'edit';
  const innerType: FormType = t ? (isPomodoro(t) ? 'POMODORO' : t.type) : 'DATE_COUNTDOWN';
  const [name, setName] = useState<string>(t?.name ?? '');
  const [type, setType] = useState<FormType>(innerType);
  const [color, setColor] = useState<string>(t?.color ?? DEFAULT_TIMER_COLOR);
  const [remark, setRemark] = useState<string>(t?.remark ?? '');
  const date = useDateParts(t?.config?.target_date);
  const targetDate = date.targetDate;
  const [includeToday, setIncludeToday] = useState<boolean>(!!t?.config?.include_today);
  const [dParts, setDParts] = useState(() => splitPreset(t?.config?.preset_ms));
  // 番茄钟配置（默认值与夹紧由契约给出；长休息在 Windows 侧同样可编辑）
  const [pomo, setPomo] = useState<PomoMin>(() => minutesOfPomodoro(t));
  // 标签（新建/编辑均可设置；与既有标签联想）
  const [tags, setTags] = useState<string[]>(Array.isArray(t?.tags) ? t.tags : []);
  const [tagInput, setTagInput] = useState('');
  const [allTagNames, setAllTagNames] = useState<string[]>([]);
  useEffect(() => {
    window.timemark.listTags().then((list) => setAllTagNames(list.map((x) => x.name))).catch(() => {});
  }, []);

  function addTag(raw: string) {
    const n = String(raw).trim().slice(0, 20);
    if (!n || tags.includes(n) || tags.length >= 8) return;
    setTags([...tags, n]);
    setTagInput('');
  }

  const presetMs = (dParts.days * 86400000) + (dParts.hours * 3600000) + (dParts.minutes * 60000) + (dParts.seconds * 1000);
  const isPomoType = type === 'POMODORO';
  const wireType: TimerType = isPomoType ? 'PRECISE_COUNTDOWN' : (type as TimerType);

  const PRESETS: Array<[string, number]> = [
    ['10秒', 10 * 1000],
    ['1分钟', 60 * 1000],
    ['5分钟', 5 * 60 * 1000],
    ['25分钟', 25 * 60 * 1000],
    ['1小时', 3600 * 1000],
    ['1天', 86400 * 1000]
  ];

  function applyPreset(ms: number) {
    setDParts(splitPreset(ms));
  }

  function buildConfig(): TimerConfigView {
    if (wireType === 'DATE_COUNTDOWN') {
      return {
        schema_version: 1,
        target_date: targetDate,
        timezone_id: Intl.DateTimeFormat().resolvedOptions().timeZone,
        include_today: includeToday
      };
    }
    if (isPomoType) {
      return buildPomodoroConfig({
        work_ms: Math.round(pomo.workMin) * 60000,
        break_ms: Math.round(pomo.breakMin) * 60000,
        long_break_ms: Math.round(pomo.longMin) * 60000,
        rounds: Math.round(pomo.rounds)
      });
    }
    if (wireType === 'PRECISE_COUNTDOWN') {
      return buildPreciseConfig(presetMs);
    }
    return { schema_version: 1 };
  }

  const [error, setError] = useState('');

  async function submit() {
    if (!name.trim()) {
      setError('请填写名称');
      return;
    }
    if (wireType === 'DATE_COUNTDOWN' && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      setError('请选择目标日期');
      return;
    }
    if (wireType === 'PRECISE_COUNTDOWN' && !isPomoType && presetMs <= 0) {
      setError('时长需大于 0');
      return;
    }
    const config = buildConfig();
    if (isEdit && t) {
      const r = await window.timemark.update(t.id, { name: name.trim(), color, remark, config });
      if (!r.ok) {
        // 引擎拒绝（如运行中改时长）必须回显，否则表单关掉而什么都没变
        setError(r.message || '保存失败');
        return;
      }
      if (tags.length || (t.tags ?? []).length) await window.timemark.setTimerTags(t.id, tags);
    } else {
      const created = await window.timemark.create({
        name: name.trim(),
        type: wireType,
        color,
        remark,
        config
      });
      if (created && tags.length) await window.timemark.setTimerTags(created.id, tags);
    }
    onClose();
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} title="关闭"><IconClose size={15} /></button>
        <h2>{isEdit ? '编辑计时' : '新建计时'}</h2>

        <div className="field">
          <label>名称</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：考研倒计时" maxLength={100} autoFocus />
        </div>

        <div className="field">
          <label>类型{isEdit ? '（创建后不可更改）' : ''}</label>
          <div className="segmented" role="tablist">
            {(Object.keys(TYPE_LABELS) as FormType[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`seg-item ${type === k ? 'active' : ''}`}
                disabled={isEdit}
                onClick={() => setType(k)}
              >
                {TYPE_ICONS[k]} <span>{TYPE_LABELS[k]}</span>
              </button>
            ))}
          </div>
        </div>

        {isPomoType && (
          <>
            <div className="dur-row">
              <div className="field">
                <label>专注（分钟）</label>
                <WheelNumber value={pomo.workMin} min={minOf(CLAMPS.work_ms)} max={maxOf(CLAMPS.work_ms)}
                  onChange={(v) => setPomo({ ...pomo, workMin: v })} />
              </div>
              <div className="field">
                <label>短休息（分钟）</label>
                <WheelNumber value={pomo.breakMin} min={minOf(CLAMPS.break_ms)} max={maxOf(CLAMPS.break_ms)}
                  onChange={(v) => setPomo({ ...pomo, breakMin: v })} />
              </div>
              <div className="field">
                <label>长休息（分钟）</label>
                <WheelNumber value={pomo.longMin} min={minOf(CLAMPS.long_break_ms)} max={maxOf(CLAMPS.long_break_ms)}
                  onChange={(v) => setPomo({ ...pomo, longMin: v })} />
              </div>
              <div className="field">
                <label>轮数</label>
                <WheelNumber value={pomo.rounds} min={CLAMPS.rounds[0]} max={CLAMPS.rounds[1]}
                  onChange={(v) => setPomo({ ...pomo, rounds: v })} />
              </div>
            </div>
            <div className="checkbox" style={{ gap: 0 }}>
              <div className="sub" style={{ fontSize: 12.5, color: 'var(--text-low)' }}>
                运行时自动循环：专注 → 休息，每 {Math.max(1, Math.round(pomo.rounds))} 轮进一次长休息
              </div>
            </div>
          </>
        )}

        {wireType === 'DATE_COUNTDOWN' && (
          <>
            <div className="field">
              <label>目标日期（按本机时区自然日计算）</label>
              <div className="date-row">
                <Select
                  ariaLabel="年"
                  value={date.y}
                  placeholder="年"
                  options={date.years.map((v) => ({ value: v, label: `${v}年` }))}
                  onChange={date.setYear}
                />
                <Select
                  ariaLabel="月"
                  value={date.mo}
                  placeholder="月"
                  options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}月` }))}
                  onChange={date.setMonth}
                />
                <Select
                  ariaLabel="日"
                  value={date.d}
                  placeholder="日"
                  options={Array.from({ length: date.daysInMonth }, (_, i) => ({ value: String(i + 1), label: `${i + 1}日` }))}
                  onChange={date.setDay}
                />
              </div>
            </div>
            <div className="checkbox">
              <input type="checkbox" id="ck-today" checked={includeToday} onChange={(e) => setIncludeToday(e.target.checked)} />
              <label htmlFor="ck-today">包含今天</label>
            </div>
          </>
        )}

        {wireType === 'PRECISE_COUNTDOWN' && !isPomoType && (
          <>
            <div className="field">
              <label>快捷预设</label>
              <div className="presets">
                {PRESETS.map(([label, ms]) => (
                  <button key={label} type="button" className={`preset ${presetMs === ms ? 'active' : ''}`} onClick={() => applyPreset(ms)}>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="dur-row">
              <div className="field">
                <label>天</label>
                <WheelNumber value={dParts.days} min={0} max={999} onChange={(v) => setDParts({ ...dParts, days: v })} />
              </div>
              <div className="field">
                <label>时</label>
                <WheelNumber value={dParts.hours} min={0} max={23} onChange={(v) => setDParts({ ...dParts, hours: v })} />
              </div>
              <div className="field">
                <label>分</label>
                <WheelNumber value={dParts.minutes} min={0} max={59} onChange={(v) => setDParts({ ...dParts, minutes: v })} />
              </div>
              <div className="field">
                <label>秒</label>
                <WheelNumber value={dParts.seconds} min={0} max={59} onChange={(v) => setDParts({ ...dParts, seconds: v })} />
              </div>
            </div>
            <div className="sub" style={{ fontSize: 12.5, color: 'var(--text-low)' }}>
              预设时长：{formatRemaining(presetMs)}（开始后按截止时间精确计时）
            </div>
          </>
        )}

        {wireType === 'STOPWATCH' && (
          <div className="sub" style={{ fontSize: 12.5, color: 'var(--text-low)' }}>
            从 0 开始累计，支持暂停 / 继续，停止后写入历史记录
          </div>
        )}

        <div className="field">
          <label>颜色</label>
          <div className="swatches">
            {COLORS.map((c) => (
              <button key={c} title={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
            <label
              className={`swatch custom ${!COLORS.includes(color) ? 'active' : ''}`}
              title="自定义颜色"
              style={!COLORS.includes(color) ? { background: color } : undefined}
            >
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : COLORS[5]}
                onChange={(e) => setColor(e.target.value)}
              />
              {COLORS.includes(color) && <span className="custom-plus"><IconPlus size={13} /></span>}
            </label>
          </div>
        </div>

        <div className="field">
          <label>标签（可选，最多 8 个，用于筛选）</label>
          <div className="tag-editor">
            {tags.map((tg) => (
              <span className="tag-chip active" key={tg}>
                <span>{tg}</span>
                <button type="button" className="rm" title="移除标签" onClick={() => setTags(tags.filter((x) => x !== tg))}>×</button>
              </span>
            ))}
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); }
              }}
              onBlur={() => { if (tagInput.trim()) addTag(tagInput); }}
              placeholder={tags.length >= 8 ? '已达上限' : (tags.length ? '' : '输入标签后回车，可重复添加')}
              maxLength={20}
              list="tm-tag-suggestions"
              disabled={tags.length >= 8}
            />
            <datalist id="tm-tag-suggestions">
              {allTagNames.filter((n) => !tags.includes(n)).map((n) => <option key={n} value={n} />)}
            </datalist>
          </div>
        </div>

        <div className="field">
          <label>备注（可选）</label>
          <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={200} />
        </div>

        {error && <div className="err-text">{error}</div>}

        <div className="modal-actions">
          <button onClick={onClose}><span>取消</span></button>
          <button className="primary" onClick={submit}><span>{isEdit ? '保存' : '创建'}</span></button>
        </div>
      </div>
    </div>
  );
}
