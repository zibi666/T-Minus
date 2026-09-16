package com.timemark.server.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> handleApi(ApiException e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", e.code);
        m.put("message", e.getMessage());
        return ResponseEntity.status(e.status).body(m);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleGeneric(Exception e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", "internal");
        m.put("message", String.valueOf(e.getMessage()));
        return ResponseEntity.status(500).body(m);
    }
}
