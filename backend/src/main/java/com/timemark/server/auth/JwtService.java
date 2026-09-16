package com.timemark.server.auth;

import jakarta.annotation.PostConstruct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

/** HS256 JWT（与客户端/开发版服务端语义一致，7 天有效） */
@Service
public class JwtService {

    private final JdbcTemplate jdbc;
    private final long ttlSec;
    private String secret;

    public JwtService(JdbcTemplate jdbc,
                      @Value("${app.jwt-ttl-sec:604800}") long ttlSec) {
        this.jdbc = jdbc;
        this.ttlSec = ttlSec;
    }

    @PostConstruct
    public synchronized void init() {
        String env = System.getenv("TIMEMARK_JWT_SECRET");
        if (env != null && !env.isBlank()) {
            this.secret = env;
            return;
        }
        try {
            this.secret = jdbc.queryForObject(
                    "SELECT val FROM meta WHERE meta_key = 'jwt_secret'", String.class);
        } catch (EmptyResultDataAccessException e) {
            this.secret = null;
        }
        if (this.secret == null || this.secret.isBlank()) {
            byte[] rnd = new byte[32];
            new java.security.SecureRandom().nextBytes(rnd);
            this.secret = hex(rnd);
            jdbc.update("INSERT INTO meta (meta_key, val) VALUES ('jwt_secret', ?) " +
                    "ON DUPLICATE KEY UPDATE val = VALUES(val)", this.secret);
        }
    }

    public String sign(String uid, String username) {
        long exp = System.currentTimeMillis() / 1000 + ttlSec;
        String header = b64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String payload = b64("{\"uid\":\"" + esc(uid) + "\",\"username\":\"" + esc(username)
                + "\",\"exp\":" + exp + "}");
        String sig = hmac(header + "." + payload);
        return header + "." + payload + "." + sig;
    }

    /** 校验通过返回 uid，失败返回 null */
    public String verify(String token) {
        String[] full = verifyFull(token);
        return full == null ? null : full[0];
    }

    /** 校验通过返回 {uid, username}，失败返回 null */
    public String[] verifyFull(String token) {
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 3) return null;
            String expect = hmac(parts[0] + "." + parts[1]);
            if (!MessageDigest.isEqual(expect.getBytes(StandardCharsets.UTF_8),
                    parts[2].getBytes(StandardCharsets.UTF_8))) {
                return null;
            }
            String json = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            long exp = Long.parseLong(extract(json, "exp"));
            if (exp < System.currentTimeMillis() / 1000) return null;
            return new String[]{extract(json, "uid"), extract(json, "username")};
        } catch (Exception e) {
            return null;
        }
    }

    private String hmac(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String b64(String s) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    /** 极简 JSON 字段提取：仅用于自产 token（字段顺序固定），非通用解析器 */
    private static String extract(String json, String key) {
        String needle = "\"" + key + "\":";
        int i = json.indexOf(needle);
        if (i < 0) throw new IllegalArgumentException("missing " + key);
        int p = i + needle.length();
        while (p < json.length() && json.charAt(p) == ' ') p++;
        if (p < json.length() && json.charAt(p) == '"') {
            int end = json.indexOf('"', p + 1);
            return json.substring(p + 1, end);
        }
        int end = p;
        while (end < json.length() && "0123456789-".indexOf(json.charAt(end)) >= 0) end++;
        return json.substring(p, end);
    }

    private static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
