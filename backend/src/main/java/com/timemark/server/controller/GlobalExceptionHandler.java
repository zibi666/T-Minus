package com.timemark.server.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> handleApi(ApiException e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", e.code);
        m.put("message", e.getMessage());
        return ResponseEntity.status(e.status).body(m);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneric(Exception e) {
        log.error("未处理异常", e);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", "internal");
        // 不回显 e.getMessage()：JDBC 报错文本带列名与 SQL 片段，会原样发给任意调用方
        m.put("message", "服务暂时不可用");
        return ResponseEntity.status(500).body(m);
    }
}
