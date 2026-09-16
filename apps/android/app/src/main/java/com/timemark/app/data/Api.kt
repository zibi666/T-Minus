package com.timemark.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Query

interface TimeMarkApi {
    @POST("api/v1/auth/register")
    suspend fun register(@Body body: AuthReq): AuthResp

    @POST("api/v1/auth/login")
    suspend fun login(@Body body: AuthReq): AuthResp

    @GET("api/v1/sync/pull")
    suspend fun pull(
        @Header("Authorization") auth: String,
        @Query("cursor") cursor: Long,
        @Query("limit") limit: Int
    ): PullResp

    @POST("api/v1/sync/push")
    suspend fun push(@Header("Authorization") auth: String, @Body body: PushReq): PushResp
}

object RowCodec {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

    // 服务端 SQLite 布尔可能是 0/1：已知布尔列统一归一成 true/false
    private val BOOL_COLS = setOf("starred", "pinned", "deleted")

    private fun normalize(obj: Map<String, JsonElement>): Map<String, JsonElement> =
        obj.mapValues { (k, v) ->
            if (k in BOOL_COLS && v is JsonPrimitive && !v.isString && v.longOrNull != null) JsonPrimitive(v.long == 1L) else v
        }

    fun elementToTimerItem(el: JsonElement): TimerItemEntity =
        json.decodeFromJsonElement(TimerItemEntity.serializer(), JsonObject(normalize(el.jsonObject)))

    fun elementToRecord(el: JsonElement): TimerRecordEntity =
        json.decodeFromJsonElement(TimerRecordEntity.serializer(), JsonObject(normalize(el.jsonObject)))

    fun elementToTag(el: JsonElement): TagEntity =
        json.decodeFromJsonElement(TagEntity.serializer(), JsonObject(normalize(el.jsonObject)))

    fun elementToTimerTag(el: JsonElement): TimerTagEntity =
        json.decodeFromJsonElement(TimerTagEntity.serializer(), JsonObject(normalize(el.jsonObject)))

    fun elementToMilestone(el: JsonElement): MilestoneEntity =
        json.decodeFromJsonElement(MilestoneEntity.serializer(), JsonObject(normalize(el.jsonObject)))

    fun entityRow(e: TimerItemEntity, withRunFlag: Boolean = false): JsonObject {
        val base = json.encodeToJsonElement(TimerItemEntity.serializer(), e).jsonObject
        return if (withRunFlag) buildJsonObject { base.forEach { (k, v) -> put(k, v) }; put("__run", JsonPrimitive(true)) } else base
    }

    fun recordRow(e: TimerRecordEntity): JsonObject = json.encodeToJsonElement(TimerRecordEntity.serializer(), e).jsonObject
    fun tagRow(e: TagEntity): JsonObject = json.encodeToJsonElement(TagEntity.serializer(), e).jsonObject
    fun timerTagRow(e: TimerTagEntity): JsonObject = json.encodeToJsonElement(TimerTagEntity.serializer(), e).jsonObject
    fun milestoneRow(e: MilestoneEntity): JsonObject = json.encodeToJsonElement(MilestoneEntity.serializer(), e).jsonObject
}
