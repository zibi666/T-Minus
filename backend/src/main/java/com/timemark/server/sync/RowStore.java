package com.timemark.server.sync;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DuplicateKeyException;
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

    /** id 是否已被其它账号占用（跨租户写入探针） */
    public boolean ownedByOther(String table, String id, String userId) {
        return !jdbc.queryForList(
                "SELECT 1 FROM " + table + " WHERE id = ? AND user_id <> ? LIMIT 1", id, userId).isEmpty();
    }

    private int updateOwned(String table, List<String> nonId, Map<String, Object> row, String userId) {
        List<Object> params = new ArrayList<>();
        for (String c : nonId) params.add(norm(row.get(c)));
        params.add(row.get("id"));
        params.add(userId);
        return jdbc.update("UPDATE " + table + " SET "
                + nonId.stream().map(c -> c + " = ?").reduce((a, b) -> a + ", " + b).orElse("1=1")
                + " WHERE id = ? AND user_id = ?", params.toArray());
    }

    /**
     * 带归属校验的 upsert：调用方须先把 row.user_id 置为 userId，只改写属于本账号的行。
     * 返回 false 表示该 id 被其它账号占用，调用方应拒绝而不是覆盖。
     */
    public boolean upsert(String table, Map<String, Object> row, String userId) {
        List<String> cols = COLUMNS.get(table);
        List<String> nonId = cols.stream().filter(c -> !"id".equals(c)).toList();
        String id = String.valueOf(row.get("id"));
        if (!ownedByOther(table, id, userId)) {
            Object[] vals = cols.stream().map(c -> norm(row.get(c))).toArray();
            try {
                jdbc.update("INSERT INTO " + table + " (" + String.join(",", cols) + ") VALUES ("
                        + cols.stream().map(c -> "?").reduce((a, b) -> a + ", " + b).orElse("?") + ")", vals);
                return true;
            } catch (DuplicateKeyException e) {
                // 并发下本账号刚插过同一行，或刚刚被他人占坑：以带归属的 UPDATE 定胜负
            }
        }
        // MySQL 默认按「实际变更行数」返回，内容未变的重复推送会回 0，故以归属而非行数定性
        updateOwned(table, nonId, row, userId);
        return getRow(table, id, userId) != null;
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
