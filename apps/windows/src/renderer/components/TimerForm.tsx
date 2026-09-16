import React, { useEffect, useRef, useState } from 'react';
import { TimerType, PomodoroInfo } from '../../shared/types';
import { formatRemaining } from '../../shared/format';
import { IconCalendar, IconHourglass, IconTimer, IconRepeat, IconClose, IconPlus } from './icons';
import Select from './Select';

export interface EditTarget {
  mode: 'create' | 'edit';
  timer?: any;
}

/** v3 计时器色板（规范 §1.3 --tc 8 色） */
const COLORS = ['#FF6B6B', '#FF9F43', '#FFB224', '#3DDB97', '#21E0C4', '#4DC9F0', '#5A9EFF', '#9381FF'];

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
  const years: string[] = [];
  for (let i = yearNow - 20; i <= yearNow + 40; i++) years.push(String(i));
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
  const targetDate = y && mo && d
    ? `${y}-${String(Number(mo)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`
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
  const innerType: FormType = t?.config?.pomodoro ? 'POMODORO' : t?.type ?? 'DATE_COUNTDOWN';
  const [name, setName] = useState<string>(t?.name ?? '');
  const [type, setType] = useState<FormType>(innerType);
  const [color, setColor] = useState<string>(t?.color ?? COLORS[5]);
  const [remark, setRemark] = useState<string>(t?.remark ?? '');
  const date = useDateParts(t?.config?.target_date);
  const targetDate = date.targetDate;
  const [includeToday, setIncludeToday] = useState<boolean>(!!t?.config?.include_today);
  const [dParts, setDParts] = useState({
    days: t?.config?.preset_ms ? Math.floor(t.config.preset_ms / 86400000) : 0,
    hours: t?.config?.preset_ms ? Math.floor((t.config.preset_ms % 86400000) / 3600000) : 0,
    minutes: t?.config?.preset_ms ? Math.floor((t.config.preset_ms % 3600000) / 60000) : 25,
    seconds: t?.config?.preset_ms ? Math.floor((t.config.preset_ms % 60000) / 1000) : 0
  });
  // 番茄钟配置（默认 25/5/4，规范 §2）
  const [pomo, setPomo] = useState<{ workMin: number; breakMin: number; rounds: number }>({
    workMin: t?.config?.pomodoro ? Math.round(t.config.pomodoro.work_ms / 60000) : 25,
    breakMin: t?.config?.pomodoro ? Math.round(t.config.pomodoro.break_ms / 60000) : 5,
    rounds: t?.config?.pomodoro ? t.config.pomodoro.rounds : 4
  });
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
    setDParts({
      days: Math.floor(ms / 86400000),
      hours: Math.floor((ms % 86400000) / 3600000),
      minutes: Math.floor((ms % 3600000) / 60000),
      seconds: Math.floor((ms % 60000) / 1000)
    });
  }

  function buildConfig(): any {
    if (wireType === 'DATE_COUNTDOWN') {
      return {
        schema_version: 1,
        target_date: targetDate,
        timezone_id: Intl.DateTimeFormat().resolvedOptions().timeZone,
        include_today: includeToday
      };
    }
    if (isPomoType) {
      const info: PomodoroInfo = {
        work_ms: Math.max(1, Math.round(pomo.workMin)) * 60000,
        break_ms: Math.max(1, Math.round(pomo.breakMin)) * 60000,
        rounds: Math.max(1, Math.min(12, Math.round(pomo.rounds)))
      };
      return { schema_version: 1, preset_ms: info.work_ms, pomodoro: info };
    }
    if (wireType === 'PRECISE_COUNTDOWN') {
      return { schema_version: 1, preset_ms: presetMs };
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
      await window.timemark.update(t.id, { name: name.trim(), color, remark, config });
      if (tags.length || (t.tags ?? []).length) await window.timemark.setTimerTags(t.id, tags);
    } else {
      const created = await window.timemark.create({
        name: name.trim(),
        type: wireType,
        color,
        remark,
        config
      } as any);
      // 引擎 create 只持久化 preset_ms，pomodoro 扩展字段经 update 落库（idle 状态允许）
      if (created) {
        if (isPomoType) {
          await window.timemark.update(created.id, { config });
        }
        if (tags.length) await window.timemark.setTimerTags(created.id, tags);
      }
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
                <WheelNumber value={pomo.workMin} min={1} max={180} onChange={(v) => setPomo({ ...pomo, workMin: v })} />
              </div>
              <div className="field">
                <label>休息（分钟）</label>
                <WheelNumber value={pomo.breakMin} min={1} max={60} onChange={(v) => setPomo({ ...pomo, breakMin: v })} />
              </div>
              <div className="field">
                <label>轮数</label>
                <WheelNumber value={pomo.rounds} min={1} max={12} onChange={(v) => setPomo({ ...pomo, rounds: v })} />
              </div>
            </div>
            <div className="checkbox" style={{ gap: 0 }}>
              <div className="sub" style={{ fontSize: 12.5, color: 'var(--text-low)' }}>
                运行时自动循环：专注 → 休息 → 下一轮，共 {Math.max(1, Math.round(pomo.rounds))} 轮
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
