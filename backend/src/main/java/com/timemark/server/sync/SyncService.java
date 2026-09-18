package com.timemark.server.sync;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** §5.4 push 语义：operation_id 幂等、运行状态 base_version/session 校验、墓碑胜出 */
@Service
public class SyncService {

    private final JdbcTemplate jdbc;
    private final RowStore rowStore;
    private final ObjectMapper om;

    public SyncService(JdbcTemplate jdbc, RowStore rowStore, ObjectMapper om) {
        this.jdbc = jdbc;
        this.rowStore = rowStore;
        this.om = om;
    }

    @Transactional
    public List<Map<String, Object>> push(List<Map<String, Object>> operations, String userId) throws Exception {
        List<Map<String, Object>> results = new ArrayList<>();
        if (operations == null) operations = List.of();
        for (Map<String, Object> op : operations) {
            results.add(processOne(op, userId));
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

        // 幂等：已见过的 operation_id 直接返回原结果
        List<Map<String, Object>> seen = jdbc.queryForList(
                "SELECT response FROM ops WHERE operation_id = ?", operationId == null ? "" : operationId);
        if (!seen.isEmpty()) {
            Map<String, Object> r = om.readValue((String) seen.get(0).get("response"), Map.class);
            r.put("operation_id", operationId);
            r.put("duplicate", true);
            return r;
        }

        String status = "accepted";
        String reason = null;
        if (operationId == null || operationId.isBlank()
                || !RowStore.SYNC_TABLES.contains(table)
                || row == null || row.get("id") == null
                || !List.of("create", "update", "delete").contains(opType)) {
            status = "rejected";
            reason = "bad_request";
        } else if (!"create".equals(opType)) {
            Map<String, Object> cur = rowStore.getRow(table, (String) row.get("id"), userId);
            if ("update".equals(opType)) {
                if (cur != null && num(cur.get("deleted")) == 1) {
                    status = "conflict";              // §6 删除墓碑胜出
                    reason = "tombstone_wins";
                } else if ("timer_item".equals(table) && Boolean.TRUE.equals(row.get("__run"))) {
                    // §6 运行状态类：base_version 必须匹配；session 过期直接丢弃
                    if (cur == null) {
                        status = "conflict";
                        reason = "missing_row";
                    } else if (baseVersion != null && num(cur.get("version")) != num(baseVersion)) {
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
        if ("accepted".equals(status) && "create".equals(opType)) {
            Map<String, Object> cur = rowStore.getRow(table, (String) row.get("id"), userId);
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
                        userId, table, row.get("id"), opType, payload,
                        str(row.get("origin_device_id")), System.currentTimeMillis());
            } else {
                status = "rejected";
                reason = "foreign_row";
            }
        }

        String responseJson = om.writeValueAsString(Map.of("status", status, "reason", reason == null ? "" : reason));
        jdbc.update("INSERT INTO ops (operation_id, user_id, response, created_at) VALUES (?,?,?,?)",
                operationId, userId, responseJson, System.currentTimeMillis());
        Map<String, Object> result = new java.util.LinkedHashMap<>();
        result.put("operation_id", operationId);   // 契约字段：客户端凭此消费 pending_ops（缺失会导致本地绑定 undefined 报错）
        result.put("status", status);
        result.put("reason", reason == null ? "" : reason);
        return result;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static long num(Object o) {
        if (o instanceof Number n) return n.longValue();
        try {
            return Long.parseLong(String.valueOf(o));
        } catch (Exception e) {
            return Long.MIN_VALUE;
        }
    }
}
