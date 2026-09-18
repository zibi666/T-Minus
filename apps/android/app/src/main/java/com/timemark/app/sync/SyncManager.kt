package com.timemark.app.sync

import com.timemark.app.data.AppContainer
import com.timemark.app.data.AuthReq
import com.timemark.app.data.ChangeEntry
import com.timemark.app.data.PendingOpEntity
import com.timemark.app.data.PushOp
import com.timemark.app.data.PushReq
import com.timemark.app.data.RowCodec
import com.timemark.app.data.TimerItemEntity
import com.timemark.app.data.TimerRecordEntity
import com.timemark.app.data.TagEntity
import com.timemark.app.data.TimerTagEntity
import com.timemark.app.data.MilestoneEntity
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** §5 同步客户端：push pending_ops（operation_id 幂等）→ pull 游标整页推进 → 冲突丢弃走 pull 收敛（§6） */
class SyncManager(private val c: AppContainer) {
    var lastError: String? = null
        private set
    var syncing = false
        private set

    suspend fun register(username: String, password: String): Boolean {
        return authFlow(AuthReq(username, password)) { c.api.register(it) }
    }

    suspend fun login(username: String, password: String): Boolean {
        return authFlow(AuthReq(username, password)) { c.api.login(it) }
    }

    private suspend fun authFlow(
        req: AuthReq,
        call: suspend (AuthReq) -> com.timemark.app.data.AuthResp
    ): Boolean {
        return try {
            val resp = call(req)
            c.auth.save(resp.token, resp.user.id, resp.user.username)
            adoptAndEnqueueOrphans(resp.user.id)
            true
        } catch (e: Exception) {
            lastError = e.message ?: e.toString()
            false
        }
    }

    suspend fun logout() {
        c.auth.clear()
    }

    /** 登录后只认领并入队「无主行」（离线期创建的那些）。
     *  旧实现给当前账号的全部行入队 create：服务端对 create 只挡墓碑，于是本地陈旧副本会覆盖云端较新的行，
     *  且 origin_device_id 被标成本机 → 其它设备 pull 时按「自身提交」跳过，整簇设备一起回退。 */
    private suspend fun adoptAndEnqueueOrphans(uid: String) {
        val timers = c.db.timerDao().orphans()
        val records = c.db.recordDao().orphans()
        val tags = c.db.miscDao().orphanTags()
        val links = c.db.miscDao().orphanTimerTags()
        val milestones = c.db.miscDao().orphanMilestones()
        c.db.timerDao().adoptOrphans(uid)
        c.db.recordDao().adoptOrphans(uid)
        c.db.miscDao().adoptTags(uid)
        c.db.miscDao().adoptTimerTags(uid)
        c.db.miscDao().adoptMilestones(uid)
        val now = System.currentTimeMillis()
        suspend fun op(table: String, rowId: String, payload: String) {
            if (c.db.pendingOpDao().dirtyCount(table, rowId) > 0) return // 创建时已入过队
            c.db.pendingOpDao().enqueue(
                PendingOpEntity(java.util.UUID.randomUUID().toString(), table, "create", rowId, payload, null, false, now)
            )
        }
        for (t in timers) op("timer_item", t.id, RowCodec.entityRow(t).toString())
        for (r in records) op("timer_record", r.id, RowCodec.recordRow(r).toString())
        for (g in tags) op("tag", g.id, RowCodec.tagRow(g).toString())
        for (tt in links) op("timer_tag", tt.id, RowCodec.timerTagRow(tt).toString())
        for (m in milestones) op("milestone", m.id, RowCodec.milestoneRow(m).toString())
    }

    suspend fun syncNow() {
        if (syncing) return
        if (c.auth.token() == null) return
        syncing = true
        try {
            pushPending()
            pull()
            lastError = null
        } catch (e: Exception) {
            lastError = e.message ?: e.toString()
        } finally {
            syncing = false
        }
    }

    private fun authHeader(token: String) = "Bearer $token"

    private suspend fun pushPending() {
        val token = c.auth.token() ?: return
        for (round in 0 until 50) {
            val ops = c.db.pendingOpDao().queued(200)
            if (ops.isEmpty()) return
            val body = PushReq(ops.map { o ->
                val obj = RowCodec.json.parseToJsonElement(o.row_payload) as? kotlinx.serialization.json.JsonObject
                    ?: kotlinx.serialization.json.buildJsonObject { }
                val rowJson = if (o.is_run) kotlinx.serialization.json.buildJsonObject {
                    obj.forEach { (k, v) -> put(k, v) }
                    put("__run", JsonPrimitive(true))
                } else obj
                PushOp(o.operation_id, o.table_name, o.op_type, rowJson, o.base_version)
            })
            val resp = c.api.push(authHeader(token), body)
            var consumed = 0
            for (r in resp.results) {
                val opId = r.operation_id ?: continue // 服务端幂等表下轮返回 duplicate + operation_id 收敛
                c.db.pendingOpDao().deleteById(opId)
                consumed++
            }
            // 防御：服务端返回空 results（异常/降级）时直接退出，避免 50 轮重发相同 ops 死循环
            if (consumed == 0) return
        }
    }

    private suspend fun pull() {
        val token = c.auth.token() ?: return
        val deviceId = c.deviceId()
        for (round in 0 until 100) {
            val cursor = c.pullCursor()
            val resp = c.api.pull(authHeader(token), cursor, 500)
            if (resp.changes.isEmpty()) return
            var appliedMax = cursor
            for (ch in resp.changes) {
                appliedMax = maxOf(appliedMax, ch.change_seq)
                if (ch.origin_device_id == deviceId) continue // 自身提交已在本地
                if (applyChange(ch) && ch.table_name == "timer_item") {
                    val rowId = (ch.payload?.get("id") as? JsonPrimitive)?.contentOrNull
                    if (rowId != null) c.repo.onRemoteApplied(rowId) // 作废本地单调基准，按远端段重落基
                }
            }
            c.setPullCursor(appliedMax) // 整页成功应用后才推进（§5.3）
            if (!resp.has_more) return
        }
    }

    /** dirty 规则：本行存在未上传操作时跳过远程覆盖 */
    private suspend fun applyChange(ch: ChangeEntry): Boolean {
        val row = ch.payload ?: return false
        val rowId = (row["id"] as? JsonPrimitive)?.contentOrNull ?: return false
        if (c.db.pendingOpDao().dirtyCount(ch.table_name, rowId) > 0) return false
        when (ch.table_name) {
            "timer_item" -> c.db.timerDao().upsert(RowCodec.elementToTimerItem(kotlinx.serialization.json.JsonObject(row)))
            "timer_record" -> c.db.recordDao().upsert(RowCodec.elementToRecord(kotlinx.serialization.json.JsonObject(row)))
            "tag" -> c.db.miscDao().upsertTag(RowCodec.elementToTag(kotlinx.serialization.json.JsonObject(row)))
            "timer_tag" -> c.db.miscDao().upsertTimerTag(RowCodec.elementToTimerTag(kotlinx.serialization.json.JsonObject(row)))
            "milestone" -> c.db.miscDao().upsertMilestone(RowCodec.elementToMilestone(kotlinx.serialization.json.JsonObject(row)))
            else -> return false
        }
        return true
    }
}
