// 行模型与列映射（与 Android Entities.kt / Windows db.ts 逐列一致）。
// 列顺序只从 Contract.SYNC_TABLE_COLUMNS 取——任何一端私自扩列都会在同步时暴露。
import { relationalStore } from '@kit.ArkData';
import { columnsOf } from '../core/Contract';

/** 服务端 payload 把布尔存成 0/1（RowStore.toPayload），已知布尔列读回时归一成 true/false */
export const BOOL_COLS: string[] = ['starred', 'pinned', 'deleted'];

export type ValueType = relationalStore.ValueType;

export function boolAt(src: Record<string, Object>, key: string): boolean {
  const v: Object | undefined = src[key];
  if (typeof v === 'boolean') return v as boolean;
  if (typeof v === 'number') return (v as number) !== 0;
  if (typeof v === 'string') return v === '1' || v === 'true';
  return false;
}

export function strOrNullAt(src: Record<string, Object>, key: string): string | null {
  const v: Object | undefined = src[key];
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? (v as string) : `${v}`;
}

export function numOrNullAt(src: Record<string, Object>, key: string): number | null {
  const v: Object | undefined = src[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v as number;
  const n = Number.parseInt(`${v}`, 10);
  return Number.isNaN(n) ? null : n;
}

export interface SyncRow {
  table(): string;
  rowId(): string;
  fields(): Map<string, ValueType>;
}

/** 列白名单缺失即视为编程错误：宁可写空也不猜列序 */
function colsOf(row: SyncRow): string[] {
  const c = columnsOf(row.table());
  return c === null ? [] : c;
}

/** 列白名单 + 顺序 → 可直接用于 INSERT 的取值数组 */
export function orderedValues(row: SyncRow): ValueType[] {
  const cols = colsOf(row);
  const f = row.fields();
  const out: ValueType[] = [];
  for (let i = 0; i < cols.length; i++) {
    const v = f.get(cols[i]);
    out.push(v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  return out;
}

/** 同步载荷：布尔按 Android 侧 kotlinx 的写法保留 true/false，null 字段不写出 */
export function rowPayloadJson(row: SyncRow): string {
  const cols = colsOf(row);
  const f = row.fields();
  const o: Record<string, Object> = {};
  for (let i = 0; i < cols.length; i++) {
    const v = f.get(cols[i]);
    if (v === undefined || v === null) continue;
    o[cols[i]] = v as Object;
  }
  return JSON.stringify(o);
}

/**
 * 备份导出用：全列都写出（含 null），布尔归 0/1——
 * 与 Windows electron/exporter.ts 的 SELECT * 结果同形，两端的备份文件可互导。
 */
export function rawRowObject(row: SyncRow): Record<string, Object | null> {
  const cols = colsOf(row);
  const f = row.fields();
  const o: Record<string, Object | null> = {};
  for (let i = 0; i < cols.length; i++) {
    const v = f.get(cols[i]);
    if (v === undefined || v === null) {
      o[cols[i]] = null;
    } else if (typeof v === 'boolean') {
      o[cols[i]] = ((v as boolean) ? 1 : 0) as Object;
    } else {
      o[cols[i]] = v as Object;
    }
  }
  return o;
}

export class TimerItem implements SyncRow {
  id: string = '';
  user_id: string | null = null;
  name: string = '';
  type: string = 'PRECISE_COUNTDOWN';
  color: string | null = null;
  starred: boolean = false;
  pinned: boolean = false;
  remark: string | null = null;
  config_json: string | null = null;
  run_state: string = 'idle';
  session_id: string | null = null;
  run_json: string | null = null;
  version: number = 1;
  updated_at: number = 0;
  deleted: boolean = false;
  origin_device_id: string | null = null;

  table(): string { return 'timer_item'; }
  rowId(): string { return this.id; }

  fields(): Map<string, ValueType> {
    const m = new Map<string, ValueType>();
    m.set('id', this.id);
    m.set('user_id', this.user_id);
    m.set('name', this.name);
    m.set('type', this.type);
    m.set('color', this.color);
    m.set('starred', this.starred);
    m.set('pinned', this.pinned);
    m.set('remark', this.remark);
    m.set('config_json', this.config_json);
    m.set('run_state', this.run_state);
    m.set('session_id', this.session_id);
    m.set('run_json', this.run_json);
    m.set('version', this.version);
    m.set('updated_at', this.updated_at);
    m.set('deleted', this.deleted);
    m.set('origin_device_id', this.origin_device_id);
    return m;
  }

  cloneFrom(o: TimerItem): TimerItem {
    const c = new TimerItem();
    c.id = o.id; c.user_id = o.user_id; c.name = o.name; c.type = o.type; c.color = o.color;
    c.starred = o.starred; c.pinned = o.pinned; c.remark = o.remark; c.config_json = o.config_json;
    c.run_state = o.run_state; c.session_id = o.session_id; c.run_json = o.run_json;
    c.version = o.version; c.updated_at = o.updated_at; c.deleted = o.deleted;
    c.origin_device_id = o.origin_device_id;
    return c;
  }

  /** 远程 payload → 行（服务端布尔为 0/1，列白名单外的键一律忽略） */
  static fromPayload(src: Record<string, Object>): TimerItem {
    const e = new TimerItem();
    e.id = strOrNullAt(src, 'id') ?? '';
    e.user_id = strOrNullAt(src, 'user_id');
    e.name = strOrNullAt(src, 'name') ?? '';
    e.type = strOrNullAt(src, 'type') ?? 'PRECISE_COUNTDOWN';
    e.color = strOrNullAt(src, 'color');
    e.starred = boolAt(src, 'starred');
    e.pinned = boolAt(src, 'pinned');
    e.remark = strOrNullAt(src, 'remark');
    e.config_json = strOrNullAt(src, 'config_json');
    e.run_state = strOrNullAt(src, 'run_state') ?? 'idle';
    e.session_id = strOrNullAt(src, 'session_id');
    e.run_json = strOrNullAt(src, 'run_json');
    e.version = numOrNullAt(src, 'version') ?? 1;
    e.updated_at = numOrNullAt(src, 'updated_at') ?? 0;
    e.deleted = boolAt(src, 'deleted');
    e.origin_device_id = strOrNullAt(src, 'origin_device_id');
    return e;
  }
}

export class TimerRecord implements SyncRow {
  id: string = '';
  user_id: string | null = null;
  timer_id: string = '';
  session_id: string | null = null;
  started_at: number = 0;
  ended_at: number = 0;
  duration_sec: number = 0;
  record_type: string = 'SEGMENT';
  version: number = 1;
  updated_at: number = 0;
  deleted: boolean = false;
  origin_device_id: string | null = null;

  table(): string { return 'timer_record'; }
  rowId(): string { return this.id; }

  fields(): Map<string, ValueType> {
    const m = new Map<string, ValueType>();
    m.set('id', this.id);
    m.set('user_id', this.user_id);
    m.set('timer_id', this.timer_id);
    m.set('session_id', this.session_id);
    m.set('started_at', this.started_at);
    m.set('ended_at', this.ended_at);
    m.set('duration_sec', this.duration_sec);
    m.set('record_type', this.record_type);
    m.set('version', this.version);
    m.set('updated_at', this.updated_at);
    m.set('deleted', this.deleted);
    m.set('origin_device_id', this.origin_device_id);
    return m;
  }

  static fromPayload(src: Record<string, Object>): TimerRecord {
    const e = new TimerRecord();
    e.id = strOrNullAt(src, 'id') ?? '';
    e.user_id = strOrNullAt(src, 'user_id');
    e.timer_id = strOrNullAt(src, 'timer_id') ?? '';
    e.session_id = strOrNullAt(src, 'session_id');
    e.started_at = numOrNullAt(src, 'started_at') ?? 0;
    e.ended_at = numOrNullAt(src, 'ended_at') ?? 0;
    e.duration_sec = numOrNullAt(src, 'duration_sec') ?? 0;
    e.record_type = strOrNullAt(src, 'record_type') ?? 'SEGMENT';
    e.version = numOrNullAt(src, 'version') ?? 1;
    e.updated_at = numOrNullAt(src, 'updated_at') ?? 0;
    e.deleted = boolAt(src, 'deleted');
    e.origin_device_id = strOrNullAt(src, 'origin_device_id');
    return e;
  }
}

/** tag / timer_tag / milestone：本轮 UI 不落地，但同步与统计口径要求列齐备 */
export class Tag implements SyncRow {
  id: string = '';
  user_id: string | null = null;
  name: string = '';
  color: string | null = null;
  version: number = 1;
  updated_at: number = 0;
  deleted: boolean = false;
  origin_device_id: string | null = null;

  table(): string { return 'tag'; }
  rowId(): string { return this.id; }
  fields(): Map<string, ValueType> {
    const m = new Map<string, ValueType>();
    m.set('id', this.id); m.set('user_id', this.user_id); m.set('name', this.name); m.set('color', this.color);
    m.set('version', this.version); m.set('updated_at', this.updated_at);
    m.set('deleted', this.deleted); m.set('origin_device_id', this.origin_device_id);
    return m;
  }

  static fromPayload(src: Record<string, Object>): Tag {
    const e = new Tag();
    e.id = strOrNullAt(src, 'id') ?? '';
    e.user_id = strOrNullAt(src, 'user_id');
    e.name = strOrNullAt(src, 'name') ?? '';
    e.color = strOrNullAt(src, 'color');
    e.version = numOrNullAt(src, 'version') ?? 1;
    e.updated_at = numOrNullAt(src, 'updated_at') ?? 0;
    e.deleted = boolAt(src, 'deleted');
    e.origin_device_id = strOrNullAt(src, 'origin_device_id');
    return e;
  }
}

export class TimerTag implements SyncRow {
  id: string = '';
  user_id: string | null = null;
  timer_id: string = '';
  tag_id: string = '';
  version: number = 1;
  updated_at: number = 0;
  deleted: boolean = false;
  origin_device_id: string | null = null;

  table(): string { return 'timer_tag'; }
  rowId(): string { return this.id; }
  fields(): Map<string, ValueType> {
    const m = new Map<string, ValueType>();
    m.set('id', this.id); m.set('user_id', this.user_id); m.set('timer_id', this.timer_id);
    m.set('tag_id', this.tag_id); m.set('version', this.version); m.set('updated_at', this.updated_at);
    m.set('deleted', this.deleted); m.set('origin_device_id', this.origin_device_id);
    return m;
  }

  static fromPayload(src: Record<string, Object>): TimerTag {
    const e = new TimerTag();
    e.id = strOrNullAt(src, 'id') ?? '';
    e.user_id = strOrNullAt(src, 'user_id');
    e.timer_id = strOrNullAt(src, 'timer_id') ?? '';
    e.tag_id = strOrNullAt(src, 'tag_id') ?? '';
    e.version = numOrNullAt(src, 'version') ?? 1;
    e.updated_at = numOrNullAt(src, 'updated_at') ?? 0;
    e.deleted = boolAt(src, 'deleted');
    e.origin_device_id = strOrNullAt(src, 'origin_device_id');
    return e;
  }
}

export class Milestone implements SyncRow {
  id: string = '';
  user_id: string | null = null;
  timer_id: string = '';
  note: string = '';
  marked_at: number = 0;
  version: number = 1;
  updated_at: number = 0;
  deleted: boolean = false;
  origin_device_id: string | null = null;

  table(): string { return 'milestone'; }
  rowId(): string { return this.id; }
  fields(): Map<string, ValueType> {
    const m = new Map<string, ValueType>();
    m.set('id', this.id); m.set('user_id', this.user_id); m.set('timer_id', this.timer_id);
    m.set('note', this.note); m.set('marked_at', this.marked_at); m.set('version', this.version);
    m.set('updated_at', this.updated_at); m.set('deleted', this.deleted);
    m.set('origin_device_id', this.origin_device_id);
    return m;
  }

  static fromPayload(src: Record<string, Object>): Milestone {
    const e = new Milestone();
    e.id = strOrNullAt(src, 'id') ?? '';
    e.user_id = strOrNullAt(src, 'user_id');
    e.timer_id = strOrNullAt(src, 'timer_id') ?? '';
    e.note = strOrNullAt(src, 'note') ?? '';
    e.marked_at = numOrNullAt(src, 'marked_at') ?? 0;
    e.version = numOrNullAt(src, 'version') ?? 1;
    e.updated_at = numOrNullAt(src, 'updated_at') ?? 0;
    e.deleted = boolAt(src, 'deleted');
    e.origin_device_id = strOrNullAt(src, 'origin_device_id');
    return e;
  }
}

/** pending_ops 只落本地，不进同步白名单 */
export class PendingOp {
  operation_id: string = '';
  table_name: string = '';
  op_type: string = '';
  row_id: string = '';
  row_payload: string = '{}';
  base_version: number | null = null;
  is_run: boolean = false;
  created_at: number = 0;
  state: string = 'queued';
}
