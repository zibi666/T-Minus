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

    /** 三端单批都是 200 条，这里留两倍余量：不封顶时一个大请求能长期占满 Hikari（池只有 8）拖死所有人的同步 */
    private static final int MAX_PUSH_OPS = 400;
    private static final int MAX_PULL_LIMIT = 1000;

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
        long from = Math.max(0, cursor);
        int cap = Math.max(1, Math.min(limit, MAX_PULL_LIMIT)); // limit<=0 会让 has_more 恒真或 SQL 直接报错
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT change_seq, table_name, row_id, op_type, payload, origin_device_id " +
                        "FROM change_log WHERE user_id = ? AND change_seq > ? ORDER BY change_seq LIMIT ?",
                userId, from, cap);
        List<Map<String, Object>> changes = new ArrayList<>();
        long next = from;
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
        // 形状不对的 body 走 400 而不是 500：operations 非数组/元素非对象会绕过逐条校验直接炸出 ClassCastException
        Object raw = body.get("operations");
        List<Map<String, Object>> operations = new ArrayList<>();
        if (raw instanceof List<?> list) {
            for (Object o : list) {
                if (!(o instanceof Map)) throw new ApiException(400, "bad_request", "operations 元素必须是对象");
                operations.add(castOp(o));
            }
        } else if (raw != null) {
            throw new ApiException(400, "bad_request", "operations 必须是数组");
        }
        if (operations.size() > MAX_PUSH_OPS) {
            throw new ApiException(400, "too_many_ops", "单次 push 最多 " + MAX_PUSH_OPS + " 条");
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("results", syncService.push(operations, userId));
        return m;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castOp(Object o) {
        return (Map<String, Object>) o;
    }
}
