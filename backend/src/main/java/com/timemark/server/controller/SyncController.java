package com.timemark.server.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.timemark.server.sync.SyncService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import jakarta.servlet.http.HttpServletRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class SyncController {

    private final JdbcTemplate jdbc;
    private final SyncService syncService;
    private final ObjectMapper om;

    public SyncController(JdbcTemplate jdbc, SyncService syncService, ObjectMapper om) {
        this.jdbc = jdbc;
        this.syncService = syncService;
        this.om = om;
    }

    /** §5.3 pull：按 change_seq 升序分页；游标只由客户端成功应用后推进 */
    @GetMapping("/sync/pull")
    public Map<String, Object> pull(HttpServletRequest request,
                                    @RequestParam(defaultValue = "0") long cursor,
                                    @RequestParam(defaultValue = "500") int limit) {
        String userId = (String) request.getAttribute("uid");
        int cap = Math.min(limit, 1000);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT change_seq, table_name, row_id, op_type, payload, origin_device_id " +
                        "FROM change_log WHERE user_id = ? AND change_seq > ? ORDER BY change_seq LIMIT ?",
                userId, cursor, cap);
        List<Map<String, Object>> changes = new ArrayList<>();
        long next = cursor;
        for (Map<String, Object> r : rows) {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("change_seq", ((Number) r.get("change_seq")).longValue());
            c.put("table_name", r.get("table_name"));
            c.put("row_id", r.get("row_id"));
            c.put("op_type", r.get("op_type"));
            try {
                c.put("payload", om.readValue((String) r.get("payload"), Map.class));
            } catch (Exception e) {
                c.put("payload", null);
            }
            c.put("origin_device_id", r.get("origin_device_id"));
            changes.add(c);
            next = Math.max(next, ((Number) r.get("change_seq")).longValue());
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("changes", changes);
        m.put("next_cursor", next);
        m.put("has_more", rows.size() == cap);
        return m;
    }

    /** §5.4 push：幂等 + 冲突校验，逐条返回结果 */
    @PostMapping("/sync/push")
    public Map<String, Object> push(HttpServletRequest request,
                                    @RequestBody Map<String, Object> body) throws Exception {
        String userId = (String) request.getAttribute("uid");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> operations =
                body.get("operations") == null ? List.of() : (List<Map<String, Object>>) body.get("operations");
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("results", syncService.push(operations, userId));
        return m;
    }
}
