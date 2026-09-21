package com.timemark.server.controller;

import com.timemark.server.auth.JwtService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1")
public class AuthController {

    private final JdbcTemplate jdbc;
    private final JwtService jwt;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    /** 账号不存在时也要走一次等价的 BCrypt 计算，否则「不存在的用户名」会明显更快返回，成为撞库探针 */
    private static final String DUMMY_HASH = new BCryptPasswordEncoder().encode(UUID.randomUUID().toString());

    public AuthController(JdbcTemplate jdbc, JwtService jwt) {
        this.jdbc = jdbc;
        this.jwt = jwt;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("app", "TimeMark Sync");
        m.put("time", System.currentTimeMillis());
        return m;
    }

    @PostMapping("/auth/register")
    public Map<String, Object> register(@RequestBody Map<String, Object> body) {
        String username = body.get("username") == null ? "" : String.valueOf(body.get("username")).trim();
        String password = body.get("password") == null ? "" : String.valueOf(body.get("password"));
        // BCryptPasswordEncoder(6.3+) 对超 72 字节的口令直接抛 IllegalArgumentException → 500；
        // username 也须与 users.username VARCHAR(64) 对齐，否则落到数据库报错变 500
        if (username.isEmpty() || password.length() < 6 || username.length() > 64
                || password.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 72) {
            return error(400, "invalid_input", "用户名不能为空且不超过 64 字符，密码至少 6 位、不超过 72 字节");
        }
        List<Map<String, Object>> exist = jdbc.queryForList(
                "SELECT id FROM users WHERE username = ?", username);
        if (!exist.isEmpty()) {
            return error(409, "exists", "用户名已存在");
        }
        String id = UUID.randomUUID().toString();
        try {
            jdbc.update("INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)",
                    id, username, encoder.encode(password), System.currentTimeMillis());
        } catch (DuplicateKeyException e) {
            // 上面的 SELECT 只是快速路径，并发同名注册最终由 username UNIQUE 兜底——不能让它变成 500
            return error(409, "exists", "用户名已存在");
        }
        return ok(id, username);
    }

    @PostMapping("/auth/login")
    public Map<String, Object> login(@RequestBody Map<String, Object> body) {
        String username = body.get("username") == null ? "" : String.valueOf(body.get("username"));
        String password = body.get("password") == null ? "" : String.valueOf(body.get("password"));
        // 超长口令不可能匹配库里任何 BCrypt 哈希（注册时已限 72 字节），先拦住免得 matches 抛异常变 500
        if (password.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 72) {
            return error(401, "bad_credentials", "用户名或密码错误");
        }
        List<Map<String, Object>> users = jdbc.queryForList(
                "SELECT id, username, password_hash FROM users WHERE username = ?", username);
        boolean matched = encoder.matches(password,
                users.isEmpty() ? DUMMY_HASH : (String) users.get(0).get("password_hash"));
        if (!matched || users.isEmpty()) {
            return error(401, "bad_credentials", "用户名或密码错误");
        }
        return ok((String) users.get(0).get("id"), (String) users.get(0).get("username"));
    }

    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest request) {
        Map<String, Object> user = new LinkedHashMap<>();
        user.put("id", request.getAttribute("uid"));
        user.put("username", request.getAttribute("username"));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("user", user);
        return m;
    }

    private Map<String, Object> ok(String id, String username) {
        Map<String, Object> user = new LinkedHashMap<>();
        user.put("id", id);
        user.put("username", username);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("token", jwt.sign(id, username));
        m.put("user", user);
        return m;
    }

    private Map<String, Object> error(int statusCode, String code, String message) {
        // 借助异常 → 全局处理器返回对应状态码
        throw new ApiException(statusCode, code, message);
    }
}
