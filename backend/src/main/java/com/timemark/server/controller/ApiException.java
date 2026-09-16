package com.timemark.server.controller;

/** 业务异常：携带 HTTP 状态码与错误码 */
public class ApiException extends RuntimeException {
    public final int status;
    public final String code;

    public ApiException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
