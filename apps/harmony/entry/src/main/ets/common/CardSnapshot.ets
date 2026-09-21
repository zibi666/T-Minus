// 卡片快照：由应用主进程写入偏好，FormExtensionAbility 同步读取。
// 之所以不走数据库：卡片新增回调必须同步返回，而 RDB 是异步的——
// 把"最近一次已知状态"缓存在偏好里，既能让刚添加的卡片立刻有内容，也不引入第二份状态来源。
import { preferences } from '@kit.ArkData';
import { DEFAULT_TIMER_COLOR } from '../core/Contract';

export const PREFS_NAME = 'timemark_prefs';
export const KEY_SNAPSHOT = 'card_snapshot';
export const KEY_FORM_IDS = 'form_ids';

export class CardSnapshot {
  title: string = 'TimeMark';
  reading: string = '--:--';
  sub: string = '还没有运行中的计时';
  color: string = DEFAULT_TIMER_COLOR;
  running: boolean = false;
}

/** 已添加的卡片登记（卡片号 + 规格），扩展能力与应用侧共用同一份 */
export class FormReg {
  id: string = '';
  dimension: string = '2*2';

  constructor(id: string, dimension: string) {
    this.id = id;
    this.dimension = dimension;
  }
}

export function readFormIds(p: preferences.Preferences): FormReg[] {
  try {
    const had = p.getSync(KEY_FORM_IDS, '[]');
    if (typeof had !== 'string') return [];
    const list = JSON.parse(had) as Object[];
    const out: FormReg[] = [];
    for (let i = 0; i < list.length; i++) {
      const o = list[i] as Record<string, Object>;
      const id = o['id'];
      const dim = o['dimension'];
      if (typeof id === 'string' && id.length > 0) {
        out.push(new FormReg(id, typeof dim === 'string' ? dim : '2*2'));
      }
    }
    return out;
  } catch (e) {
    return [];
  }
}

export function writeFormIds(p: preferences.Preferences, list: FormReg[]): void {
  p.putSync(KEY_FORM_IDS, JSON.stringify(list));
  p.flush();
}

export function upsertFormId(p: preferences.Preferences, formId: string, dimension: string): void {
  if (formId.length === 0) return;
  const list = readFormIds(p);
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === formId) {
      list[i].dimension = dimension;
      writeFormIds(p, list);
      return;
    }
  }
  list.push(new FormReg(formId, dimension));
  writeFormIds(p, list);
}

export function dropFormId(p: preferences.Preferences, formId: string): void {
  const list = readFormIds(p);
  const next: FormReg[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].id !== formId) next.push(list[i]);
  }
  writeFormIds(p, next);
}

export function snapshotJson(s: CardSnapshot): string {
  const o: Record<string, Object> = {};
  o['title'] = s.title as Object;
  o['reading'] = s.reading as Object;
  o['sub'] = s.sub as Object;
  o['color'] = s.color as Object;
  o['running'] = s.running as Object;
  return JSON.stringify(o);
}

/** 同步读：拿不到（首次/损坏）时回落到占位快照 */
export function readSnapshot(p: preferences.Preferences): CardSnapshot {
  const s = new CardSnapshot();
  try {
    const raw = p.getSync(KEY_SNAPSHOT, '');
    if (typeof raw !== 'string' || raw.length === 0) return s;
    const o = JSON.parse(raw) as Record<string, Object>;
    const t = o['title'];
    const r = o['reading'];
    const sub = o['sub'];
    const c = o['color'];
    const run = o['running'];
    if (typeof t === 'string') s.title = t;
    if (typeof r === 'string') s.reading = r;
    if (typeof sub === 'string') s.sub = sub;
    if (typeof c === 'string' && c.length > 0) s.color = c;
    s.running = typeof run === 'boolean' ? (run as boolean) : false;
  } catch (e) {
    // 回落占位
  }
  return s;
}
