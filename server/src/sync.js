// §5.3 pull / §5.4 push —— 服务端同步协议核心
const { SYNC_TABLES } = require('./db');

const COLUMNS = {
  timer_item: ['id', 'user_id', 'name', 'type', 'color', 'starred', 'pinned', 'remark',
    'config_json', 'run_state', 'session_id', 'run_json', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  tag: ['id', 'user_id', 'name', 'color', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_tag: ['id', 'user_id', 'timer_id', 'tag_id', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  milestone: ['id', 'user_id', 'timer_id', 'note', 'marked_at', 'version', 'updated_at', 'deleted', 'origin_device_id'],
  timer_record: ['id', 'user_id', 'timer_id', 'session_id', 'started_at', 'ended_at',
    'duration_sec', 'record_type', 'version', 'updated_at', 'deleted', 'origin_device_id']
};

function upsertRow(db, table, row) {
  const cols = COLUMNS[table];
  const values = cols.map((c) => (row[c] !== undefined ? row[c] : null));
  db.run(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, values);
}

function registerSyncRoutes(app, db, authMiddleware) {
  // §5.3 pull：按 change_seq 升序分页；游标只由客户端成功应用后推进
  app.get('/api/v1/sync/pull', authMiddleware, (req, res) => {
    const cursor = Number(req.query.cursor || 0);
    const limit = Math.min(Number(req.query.limit || 500), 1000);
    const changes = db.all(
      `SELECT change_seq, table_name, row_id, op_type, payload, origin_device_id
       FROM change_log WHERE user_id = ? AND change_seq > ? ORDER BY change_seq LIMIT ?`,
      [req.auth.userId, cursor, limit]
    );
    const nextCursor = changes.length ? changes[changes.length - 1].change_seq : cursor;
    res.json({
      changes: changes.map((c) => ({ ...c, payload: JSON.parse(c.payload) })),
      next_cursor: nextCursor,
      has_more: changes.length === limit
    });
  });

  // §5.4 push：operation_id 幂等；运行状态 base_version/session 校验；墓碑胜出
  app.post('/api/v1/sync/push', authMiddleware, (req, res) => {
    const list = Array.isArray(req.body && req.body.operations) ? req.body.operations.slice(0, 1000) : [];
    const results = [];
    db.transaction(() => {
      for (const op of list) {
        const { operation_id, table_name, op_type, row, base_version } = op || {};
        const seen = db.get('SELECT response FROM ops WHERE operation_id = ?', [String(operation_id || '')]);
        if (seen) {
          results.push({ operation_id, ...JSON.parse(seen.response), duplicate: true });
          continue;
        }
        let status = 'accepted';
        let reason = null;
        if (!operation_id || !SYNC_TABLES.includes(table_name) || !row || !row.id ||
            !['create', 'update', 'delete'].includes(op_type)) {
          status = 'rejected';
          reason = 'bad_request';
        } else if (op_type !== 'create') {
          const cur = db.get(`SELECT * FROM ${table_name} WHERE id = ? AND user_id = ?`, [row.id, req.auth.userId]);
          if (op_type === 'update') {
            if (cur && Number(cur.deleted) === 1) {
              status = 'conflict';
              reason = 'tombstone_wins'; // §6 删除墓碑胜出
            } else if (table_name === 'timer_item' && row.__run) {
              // §6 运行状态类：base_version 必须匹配，session 过期直接丢弃
              if (!cur) {
                status = 'conflict';
                reason = 'missing_row';
              } else if (base_version != null && Number(cur.version) !== Number(base_version)) {
                status = 'conflict';
                reason = 'stale_version';
              } else if (row.session_id && cur.session_id && cur.session_id !== row.session_id) {
                status = 'discarded';
                reason = 'stale_session';
              }
            }
          }
        }
        if (status === 'accepted' && op_type === 'create') {
          const cur = db.get(`SELECT deleted FROM ${table_name} WHERE id = ? AND user_id = ?`, [row.id, req.auth.userId]);
          if (cur && Number(cur.deleted) === 1) {
            status = 'conflict';
            reason = 'tombstone_wins';
          }
        }
        if (status === 'accepted') {
          const payload = { ...row, user_id: req.auth.userId };
          delete payload.__run;
          if (op_type === 'delete') payload.deleted = 1;
          upsertRow(db, table_name, payload);
          db.run(
            `INSERT INTO change_log (user_id, table_name, row_id, op_type, payload, origin_device_id, committed_at)
             VALUES (?,?,?,?,?,?,?)`,
            [req.auth.userId, table_name, row.id, op_type, JSON.stringify(payload), row.origin_device_id || null, Date.now()]
          );
        }
        const response = { status, reason };
        db.run('INSERT INTO ops (operation_id, user_id, response, created_at) VALUES (?,?,?,?)',
          [String(operation_id), req.auth.userId, JSON.stringify(response), Date.now()]);
        results.push({ operation_id, ...response });
      }
    });
    res.json({ results });
  });
}

module.exports = { registerSyncRoutes };
