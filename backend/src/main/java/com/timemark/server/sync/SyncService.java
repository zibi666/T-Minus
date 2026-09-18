package com.timemark.server.sync;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** §5.4 push 语义：operation_id 幂等、运行状态 base_version/session 校验、墓碑胜出 */
@Service
public class SyncService {

    private static final Logger log = LoggerFactory.getLogger(SyncService.class);
    private static final int MAX_OPERATION_ID_LEN = 64;

    private final JdbcTemplate jdbc;
    private final RowStore rowStore;
    private final ObjectMapper om;
    private final TransactionTemplate tx;

    public SyncService(JdbcTemplate jdbc, RowStore rowStore, ObjectMapper om,
                       PlatformTransactionManager txManager) {
        this.jdbc = jdbc;
        this.rowStore = rowStore;
        this.om = om;
        this.tx = new TransactionTemplate(txManager);
    }

    /**
     * 逐条独立事务：一条脏数据不再连带回滚整批已接受的写入，也不会把 §5.4 承诺的逐条结果变成一个 500。
     * 每笔事务先锁用户行，使 change_seq 的分配顺序等于提交顺序 ——
     * 否则 A 取到 101 却晚提交、B 取到 102 先提交，游标推过 102 之后 101 永久不可见。
     */
    public List<Map<String, Object>> push(List<Map<String, Object>> operations, String userId) {
        List<Map<String, Object>> results = new ArrayList<>();
        if (operations == null) operations = List.of();
        for (Map<String, Object> op : operations) {
            Map<String, Object> r;
            try {
                r = tx.execute(status -> {
                    try {
                        return processOne(op, userId);
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                });
            } catch (Exception e) {
                log.error("push 单条失败 table={} row_id={}", op.get("table_name"), rowIdOf(op), e);
                r = new LinkedHashMap<>();
                r.put("operation_id", str(op.get("operation_id")));
                r.put("status", "rejected");
                r.put("reason", "server_error");
            }
            results.add(r);
        }
        return results;
    }

    private Map<String, Object> processOne(Map<String, Object> op, String userId) throws Exception {
        String operationId = str(op.get("operation_id"));
        String table = str(op.get("table_name"));
        String opType = str(op.get("op_type"));
        @SuppressWarnings("unchecked")
        Map<String, Object> row = (Map<String, Object>) op.get("row");
        Object baseVersion = op.get("base_version");

        // 同用户串行化：change_seq 与提交顺序一致的前提，也让并发写同一行时版本校验不交错
        jdbc.queryForList("SELECT id FROM users WHERE id = ? FOR UPDATE", userId);

        // 幂等：只认本账号见过的 operation_id。按全局键读会让别人撞号时把本次写入静默丢掉
        List<Map<String, Object>> seen = jdbc.queryForList(
                "SELECT response FROM ops WHERE operation_id = ? AND user_id = ?",
                operationId == null ? "" : operationId, userId);
        if (!seen.isEmpty()) {
            Map<String, Object> cached = om.readValue((String) seen.get(0).get("response"), Map.class);
            cached.put("operation_id", operationId);
            cached.put("duplicate", true);
            return cached;
        }

        String status = "accepted";
        String reason = null;
        boolean opIdUsable = operationId != null && !operationId.isBlank() && operationId.length() <= MAX_OPERATION_ID_LEN;
        if (!opIdUsable
                || !RowStore.SYNC_TABLES.contains(table)
                || row == null || row.get("id") == null
                || !List.of("create", "update", "delete").contains(opType)) {
            status = "rejected";
            reason = "bad_request";
        } else if (!"create".equals(opType)) {
            String rowId = String.valueOf(row.get("id")); // 数字 id 直接强转 String 会抛 ClassCastException
            Map<String, Object> cur = rowStore.getRow(table, rowId, userId);
            if ("update".equals(opType)) {
                if (cur != null && num(cur.get("deleted")) == 1) {
                    status = "conflict";              // §6 删除墓碑胜出
                    reason = "tombstone_wins";
                } else if ("timer_item".equals(table) && Boolean.TRUE.equals(row.get("__run"))) {
                    // §6 运行状态类：base_version 必须匹配；缺基线不得绕过校验；session 过期直接丢弃
                    if (cur == null) {
                        status = "conflict";
                        reason = "missing_row";
                    } else {
                        Long curVersion = numOrNull(cur.get("version"));
                        Long baseVersionNum = numOrNull(baseVersion);
                        if (curVersion == null || baseVersionNum == null || !curVersion.equals(baseVersionNum)) {
                            status = "conflict";
                            reason = "stale_version";
                        } else {
                            String curSession = (String) cur.get("session_id");
                            String rowSession = (String) row.get("session_id");
                            if (rowSession != null && curSession != null && !curSession.equals(rowSession)) {
                                status = "discarded";
                                reason = "stale_session";
                            }
                        }
                    }
                }
            }
        }
        if ("accepted".equals(status) && "create".equals(opType)) {
            Map<String, Object> cur = rowStore.getRow(table, String.valueOf(row.get("id")), userId);
            if (cur != null && num(cur.get("deleted")) == 1) {
                status = "conflict";
                reason = "tombstone_wins";
            }
        }

        if ("accepted".equals(status)) {
            row.put("user_id", userId);
            if ("delete".equals(opType)) {
                row.put("deleted", 1);
                // 墓碑落地即归零运行态：否则客户端按 run_state 扫描的结算循环会永久推进已删除的计时器
                if ("timer_item".equals(table)) row.put("run_state", "idle");
            }
            if (rowStore.upsert(table, row, userId)) {
                String payload = rowStore.toPayload(table, row, userId);
                jdbc.update("INSERT INTO change_log (user_id, table_name, row_id, op_type, payload, origin_device_id, committed_at) VALUES (?,?,?,?,?,?,?)",
                        userId, table, String.valueOf(row.get("id")), opType, payload,
                        str(row.get("origin_device_id")), System.currentTimeMillis());
            } else {
                status = "rejected";
                reason = "foreign_row";
            }
        }

        String responseJson = om.writeValueAsString(Map.of("status", status, "reason", reason == null ? "" : reason));
        // op id 本身不可用时不写幂等表：那行键存不进 ops.operation_id，硬写会让这条"拒绝"反过来把整条事务回滚成 500
        if (opIdUsable) {
            // 与别人撞号时保持对方记录不动：宁可本端少一次幂等缓存，也不覆盖他人的结果
            jdbc.update("INSERT INTO ops (operation_id, user_id, response, created_at) VALUES (?,?,?,?) "
                            + "ON DUPLICATE KEY UPDATE operation_id = operation_id",
                    operationId, userId, responseJson, System.currentTimeMillis());
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("operation_id", operationId);   // 契约字段：客户端凭此消费 pending_ops（缺失会导致本地绑定 undefined 报错）
        result.put("status", status);
        result.put("reason", reason == null ? "" : reason);
        return result;
    }

    @SuppressWarnings("unchecked")
    private static String rowIdOf(Map<String, Object> op) {
        Object row = op.get("row");
        return row instanceof Map ? String.valueOf(((Map<String, Object>) row).get("id")) : null;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static long num(Object o) {
        Long v = numOrNull(o);
        return v == null ? Long.MIN_VALUE : v;
    }

    /** 解析不出数字时返回 null，让调用方能区分「0」和「不是个数」——两者都当成同一个值会让坏基线互相判等 */
    private static Long numOrNull(Object o) {
        if (o instanceof Number n) return n.longValue();
        try {
            return Long.parseLong(String.valueOf(o));
        } catch (Exception e) {
            return null;
        }
    }
}
