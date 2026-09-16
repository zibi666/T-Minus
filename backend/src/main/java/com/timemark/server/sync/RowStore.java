package com.timemark.server.sync;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 各同步表列白名单与通用 upsert（与客户端/开发版服务端列定义一致） */
@Service
public class RowStore {

    public static final List<String> SYNC_TABLES =
            List.of("timer_item", "tag", "timer_tag", "milestone", "timer_record");

    private static final Map<String, List<String>> COLUMNS = Map.of(
            "timer_item", List.of("id", "user_id", "name", "type", "color", "starred", "pinned", "remark",
                    "config_json", "run_state", "session_id", "run_json", "version", "updated_at", "deleted",
                    "origin_device_id"),
            "tag", List.of("id", "user_id", "name", "color", "version", "updated_at", "deleted", "origin_device_id"),
            "timer_tag", List.of("id", "user_id", "timer_id", "tag_id", "version", "updated_at", "deleted",
                    "origin_device_id"),
            "milestone", List.of("id", "user_id", "timer_id", "note", "marked_at", "version", "updated_at",
                    "deleted", "origin_device_id"),
            "timer_record", List.of("id", "user_id", "timer_id", "session_id", "started_at", "ended_at",
                    "duration_sec", "record_type", "version", "updated_at", "deleted", "origin_device_id")
    );

    private final JdbcTemplate jdbc;
    private final ObjectMapper om;

    public RowStore(JdbcTemplate jdbc, ObjectMapper om) {
        this.jdbc = jdbc;
        this.om = om;
    }

    public List<String> columns(String table) {
        return COLUMNS.get(table);
    }

    /** 按 id + user_id 取当前行；不存在返回 null */
    public Map<String, Object> getRow(String table, String id, String userId) {
        String cols = String.join(",", COLUMNS.get(table));
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT " + cols + " FROM " + table + " WHERE id = ? AND user_id = ?", id, userId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** 可移植 upsert：先 UPDATE，未命中再 INSERT（调用方负责事务） */
    public void upsert(String table, Map<String, Object> row) {
        List<String> cols = COLUMNS.get(table);
        List<String> nonId = cols.stream().filter(c -> !"id".equals(c)).toList();
        List<Object> updParams = new ArrayList<>();
        for (String c : nonId) updParams.add(norm(row.get(c)));
        updParams.add(row.get("id"));
        int n = jdbc.update("UPDATE " + table + " SET "
                + nonId.stream().map(c -> c + " = ?").reduce((a, b) -> a + ", " + b).orElse("1=1")
                + " WHERE id = ?", updParams.toArray());
        if (n == 0) {
            Object[] vals = cols.stream().map(c -> norm(row.get(c))).toArray();
            jdbc.update("INSERT INTO " + table + " (" + String.join(",", cols) + ") VALUES ("
                    + cols.stream().map(c -> "?").reduce((a, b) -> a + ", " + b).orElse("?") + ")", vals);
        }
    }

    /** 把行数据按列白名单转成 payload（供 change_log 存 JSON） */
    public String toPayload(String table, Map<String, Object> row, String forcedUserId) throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        for (String c : COLUMNS.get(table)) {
            Object v = row.get(c);
            payload.put(c, v instanceof Boolean b ? (b ? 1 : 0) : v);
        }
        payload.put("user_id", forcedUserId);
        return om.writeValueAsString(payload);
    }

    private static Object norm(Object v) {
        if (v instanceof Boolean b) return b ? 1 : 0;
        return v;
    }
}
