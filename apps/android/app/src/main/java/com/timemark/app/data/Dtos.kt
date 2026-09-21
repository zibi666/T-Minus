package com.timemark.app.data

import kotlinx.serialization.Serializable

// 服务端契约（§5）：字段名与 /api/v1 返回/接收完全一致

@Serializable
data class AuthReq(val username: String, val password: String)

@Serializable
data class AuthUser(val id: String, val username: String)

@Serializable
data class AuthResp(val token: String, val user: AuthUser)

@Serializable
data class PushOp(
    val operation_id: String,
    val table_name: String,
    val op_type: String,
    val row: kotlinx.serialization.json.JsonObject,
    val base_version: Long? = null
)

@Serializable
data class PushReq(val operations: List<PushOp>)

@Serializable
data class PushResult(val operation_id: String? = null, val status: String? = null, val duplicate: Boolean = false)

@Serializable
data class PushResp(val results: List<PushResult> = emptyList())

@Serializable
data class ChangeEntry(
    val change_seq: Long = 0,
    val table_name: String = "",
    val origin_device_id: String? = null,
    val payload: Map<String, kotlinx.serialization.json.JsonElement>? = null
)

@Serializable
data class PullResp(val changes: List<ChangeEntry> = emptyList(), val has_more: Boolean = false)
