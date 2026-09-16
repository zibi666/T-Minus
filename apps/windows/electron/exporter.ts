// §8 M1：基础导出备份（JSON 全量快照）
import { LocalDB } from './db';
import { ExportPayload } from '../src/shared/types';

export function gatherExport(db: LocalDB, deviceId: string): ExportPayload {
  return {
    app: 'TimeMark',
    schema_version: 1,
    exported_at: Date.now(),
    device_id: deviceId,
    timer_item: db.all('SELECT * FROM timer_item'),
    tag: db.all('SELECT * FROM tag'),
    timer_tag: db.all('SELECT * FROM timer_tag'),
    milestone: db.all('SELECT * FROM milestone'),
    timer_record: db.all('SELECT * FROM timer_record')
  };
}
