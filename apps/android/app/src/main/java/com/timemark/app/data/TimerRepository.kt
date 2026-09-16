package com.timemark.app.data

import com.timemark.app.core.ConfigJson
import com.timemark.app.core.Fmt
import com.timemark.app.core.Jsons
import com.timemark.app.core.RunJson
import com.timemark.app.core.Types
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

/** §3/§4/§6 的本地执行核心：所有业务修改 = 本地事务写入 + pending_ops 同事务入队 */
class TimerRepository(
    private val db: AppDatabase,
    private val auth: AuthStore,
    private val journal: JournalStore
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    fun observeTimers() = db.timerDao().observeLive()
    fun observeRecords() = db.recordDao().observeAll()
    fun observeQueuedCount() = db.pendingOpDao().observeQueuedCount()

    private suspend fun enqueue(op: PendingOpEntity) {
        if (auth.token() != null) db.pendingOpDao().enqueue(op)
    }

    private suspend fun rowPayload(e: TimerItemEntity, withRun: Boolean) =
        RowCodec.entityRow(e, withRun).toString()

    // ---- 元数据 CRUD ----

    suspend fun createTimer(name: String, type: String, color: String?, configJson: String?, remark: String?): String {
        val now = System.currentTimeMillis()
        val e = TimerItemEntity(
            id = UUID.randomUUID().toString(), user_id = auth.uid(),
            name = name, type = type, color = color, config_json = configJson, remark = remark,
            version = 1, updated_at = now, origin_device_id = auth.deviceId()
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "create", e.id, RowCodec.entityRow(e).toString(), null, false, now))
        return e.id
    }

    suspend fun updateMeta(id: String, name: String?, color: String?, remark: String?, configJson: String?) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val e = old.copy(
            name = name ?: old.name, color = color ?: old.color, remark = remark ?: old.remark,
            config_json = configJson ?: old.config_json, version = old.version + 1, updated_at = now
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, false), old.version, false, now))
    }

    suspend fun deleteTimer(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val e = old.copy(deleted = true, version = old.version + 1, updated_at = now)
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "delete", e.id, rowPayload(e, false), old.version, false, now))
    }

    suspend fun togglePin(id: String) = toggleFlag(id) { it.copy(pinned = !it.pinned) }
    suspend fun toggleStar(id: String) = toggleFlag(id) { it.copy(starred = !it.starred) }

    private suspend fun toggleFlag(id: String, mutate: (TimerItemEntity) -> TimerItemEntity) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val e = mutate(old).copy(version = old.version + 1, updated_at = now)
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, false), old.version, false, now))
    }

    // ---- 运行状态操作（§3）----

    private suspend fun commitRun(old: TimerItemEntity, run: RunJson, runState: String, newSession: String? = null) {
        val now = System.currentTimeMillis()
        val e = old.copy(
            run_json = json.encodeToString(RunJson.serializer(), run),
            run_state = runState,
            session_id = newSession ?: old.session_id,
            version = old.version + 1, updated_at = now
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), old.version, true, now))
    }

    suspend fun start(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val cfg = Jsons.configJson(old.config_json)
        val now = System.currentTimeMillis()
        val session = UUID.randomUUID().toString()
        when (old.type) {
            Types.PRECISE -> commitRun(old, RunJson(target_at = now + (cfg.preset_ms ?: 60000)), Types.RUNNING, session)
            Types.STOPWATCH -> commitRun(old, RunJson(accumulated_ms = 0, segment_started_at = now), Types.RUNNING, session)
            Types.POMODORO -> commitRun(
                old,
                RunJson(phase = "focus", phase_ends_at = now + (cfg.focus_ms ?: 25 * 60000), completed_focus = 0),
                Types.RUNNING, session
            )
        }
    }

    suspend fun pause(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        when (old.type) {
            Types.PRECISE -> commitRun(old, run.copy(remaining_at_pause = maxOf(0, (run.target_at ?: now) - now)), Types.PAUSED)
            Types.STOPWATCH -> commitRun(
                old, run.copy(
                    accumulated_ms = (run.accumulated_ms ?: 0) + maxOf(0, now - (run.segment_started_at ?: now)),
                    segment_started_at = null
                ), Types.PAUSED
            )
            Types.POMODORO -> commitRun(old, run.copy(remaining_at_pause = maxOf(0, (run.phase_ends_at ?: now) - now)), Types.PAUSED)
        }
    }

    suspend fun resume(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        when (old.type) {
            Types.PRECISE -> commitRun(old, run.copy(target_at = now + (run.remaining_at_pause ?: 0)), Types.RUNNING)
            Types.STOPWATCH -> commitRun(old, run.copy(segment_started_at = now), Types.RUNNING)
            Types.POMODORO -> commitRun(old, run.copy(phase_ends_at = now + (run.remaining_at_pause ?: 0)), Types.RUNNING)
        }
    }

    /** 分段（精确倒计时 = 打点并立即开启下一轮；正计时 = 记 lap 继续）——与 Windows engine.segment 一致 */
    suspend fun segment(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        val cfg = Jsons.configJson(old.config_json)
        when (old.type) {
            Types.PRECISE -> {
                val preset = cfg.preset_ms ?: 60000
                val elapsed = preset - maxOf(0, (run.target_at ?: now) - now)
                insertRecord(old, now - elapsed, now, elapsed / 1000, Types.RECORD_SEGMENT, newSession = false)
                commitRun(old, RunJson(target_at = now + preset), Types.RUNNING, UUID.randomUUID().toString())
            }
            Types.STOPWATCH -> {
                val lap = maxOf(0, now - (run.segment_started_at ?: now))
                insertRecord(old, now - lap, now, lap / 1000, Types.RECORD_SEGMENT, newSession = false)
                commitRun(old, run.copy(segment_started_at = now), Types.RUNNING)
            }
        }
    }

    /** 结束：提前结束如实记账（SEGMENT），正计时写总账（STOPWATCH） */
    suspend fun stop(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        val cfg = Jsons.configJson(old.config_json)
        when (old.type) {
            Types.PRECISE -> {
                val preset = cfg.preset_ms ?: 60000
                val elapsed = if (old.run_state == Types.PAUSED) preset - (run.remaining_at_pause ?: 0)
                else preset - maxOf(0, (run.target_at ?: now) - now)
                if (elapsed > 0) insertRecord(old, now - elapsed, now, elapsed / 1000, Types.RECORD_SEGMENT, newSession = false)
                commitRun(old, RunJson(), Types.IDLE)
            }
            Types.STOPWATCH -> {
                val total = if (old.run_state == Types.RUNNING) (run.accumulated_ms ?: 0) + maxOf(0, now - (run.segment_started_at ?: now))
                else (run.accumulated_ms ?: 0)
                if (total > 0) insertRecord(old, now - total, now, total / 1000, Types.RECORD_STOPWATCH, newSession = false)
                commitRun(old, RunJson(accumulated_ms = 0), Types.IDLE)
            }
            Types.POMODORO -> {
                val elapsed = if (old.run_state == Types.PAUSED) run.remaining_at_pause?.let { phasePresetOf(cfg, run) - it } ?: 0
                else maxOf(0, phasePresetOf(cfg, run) - maxOf(0, (run.phase_ends_at ?: now) - now))
                if (run.phase == "focus" && elapsed > 5000) journal.add(Fmt.dayKey(now), 0, elapsed, 0)
                if (elapsed > 0) insertRecord(old, now - elapsed, now, elapsed / 1000, Types.RECORD_SEGMENT, newSession = false)
                commitRun(old, RunJson(), Types.IDLE)
            }
        }
    }

    suspend fun reset(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (old.type == Types.DATE) return
        commitRun(old, RunJson(accumulated_ms = if (old.type == Types.STOPWATCH) 0 else null), Types.IDLE)
    }

    private fun phasePresetOf(cfg: ConfigJson, run: RunJson): Long {
        val focus = cfg.focus_ms ?: 25 * 60000
        return if (run.phase == "focus") focus else (cfg.short_break_ms ?: 5 * 60000)
    }

    // ---- 到点结算：PRECISE 到点 / 番茄钟阶段推进（§3.5，含循环与如实记账）----

    suspend fun settleDue(now: Long = System.currentTimeMillis()): Int {
        var settled = 0
        for (t in db.timerDao().runningAll()) {
            val run = Jsons.runJson(t.run_json)
            when (t.type) {
                Types.PRECISE -> {
                    val target = run.target_at ?: continue
                    if (target <= now) { finishPrecise(t, target); settled++ }
                }
                Types.POMODORO -> {
                    val end = run.phase_ends_at ?: continue
                    if (end <= now) { advancePomodoro(t, end, now); settled++ }
                }
            }
        }
        return settled
    }

    private suspend fun finishPrecise(t: TimerItemEntity, endedAt: Long) {
        val cfg = Jsons.configJson(t.config_json)
        val preset = cfg.preset_ms ?: 60000
        insertRecordRaw(t, endedAt - preset, endedAt, preset / 1000, Types.RECORD_PRECISE)
        val e = t.copy(run_state = Types.IDLE, run_json = null, version = t.version + 1, updated_at = System.currentTimeMillis())
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), t.version, true, System.currentTimeMillis()))
    }

    private suspend fun advancePomodoro(t: TimerItemEntity, phaseEnd: Long, now: Long) {
        val cfg = Jsons.configJson(t.config_json)
        val run = Jsons.runJson(t.run_json)
        val focus = cfg.focus_ms ?: 25 * 60000
        val breakMs = cfg.short_break_ms ?: 5 * 60000
        val isFocus = run.phase == "focus"
        val phasePreset = if (isFocus) focus else breakMs
        insertRecordRaw(t, phaseEnd - phasePreset, phaseEnd, phasePreset / 1000, Types.RECORD_PRECISE)
        val completed = run.completed_focus + if (isFocus) 1 else 0
        if (isFocus) journal.add(Fmt.dayKey(now), 1, focus, 0) else journal.add(Fmt.dayKey(now), 0, 0, breakMs)
        val nextPhase = if (isFocus) "break" else "focus"
        val nextPreset = if (isFocus) breakMs else focus
        val e = t.copy(
            run_json = json.encodeToString(RunJson.serializer(), RunJson(phase = nextPhase, phase_ends_at = now + nextPreset, completed_focus = completed)),
            run_state = Types.RUNNING, version = t.version + 1, updated_at = System.currentTimeMillis()
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), t.version, true, System.currentTimeMillis()))
    }

    /** 跳过（番茄钟）：与 Windows 一致，专注期跳过也如实计入（>5s） */
    suspend fun skipPhase(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        val cfg = Jsons.configJson(old.config_json)
        if (old.run_state != Types.RUNNING) return
        val focus = cfg.focus_ms ?: 25 * 60000
        val breakMs = cfg.short_break_ms ?: 5 * 60000
        val isFocus = run.phase == "focus"
        val phasePreset = if (isFocus) focus else breakMs
        val elapsed = phasePreset - maxOf(0, (run.phase_ends_at ?: now) - now)
        if (isFocus && elapsed > 5000) journal.add(Fmt.dayKey(now), 1, elapsed, 0)
        if (elapsed > 0) insertRecord(old, now - elapsed, now, elapsed / 1000, Types.RECORD_PRECISE, newSession = false)
        val completed = run.completed_focus + if (isFocus) 1 else 0
        if (isFocus) journal.add(Fmt.dayKey(now), 0, 0, breakMs) // 跳过专注 = 直接进入休息
        val nextPhase = if (isFocus) "break" else "focus"
        val nextPreset = if (isFocus) breakMs else focus
        val e = old.copy(
            run_json = json.encodeToString(RunJson.serializer(), RunJson(phase = nextPhase, phase_ends_at = now + nextPreset, completed_focus = completed)),
            run_state = Types.RUNNING, version = old.version + 1, updated_at = now
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), old.version, true, now))
    }

    // ---- 记录 ----

    private suspend fun insertRecord(t: TimerItemEntity, startedAt: Long, endedAt: Long, durationSec: Long, type: String, newSession: Boolean) {
        insertRecordRaw(t, startedAt, endedAt, durationSec, type)
        if (newSession) {
            // 开启下一轮：新 session（旧 session 的分段归属不变）
        }
    }

    private suspend fun insertRecordRaw(t: TimerItemEntity, startedAt: Long, endedAt: Long, durationSec: Long, type: String) {
        val r = TimerRecordEntity(
            id = UUID.randomUUID().toString(), user_id = auth.uid(), timer_id = t.id,
            session_id = t.session_id, started_at = startedAt, ended_at = endedAt,
            duration_sec = durationSec, record_type = type, origin_device_id = auth.deviceId()
        )
        db.recordDao().upsert(r)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_record", "create", r.id, RowCodec.recordRow(r).toString(), null, false, System.currentTimeMillis()))
    }

    suspend fun deleteRecord(id: String) {
        val old = db.recordDao().byId(id) ?: return
        val e = old.copy(deleted = true, version = old.version + 1)
        db.recordDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_record", "delete", e.id, RowCodec.recordRow(e).toString(), old.version, false, System.currentTimeMillis()))
    }

    suspend fun byId(id: String): TimerItemEntity? = db.timerDao().byId(id)

    suspend fun segmentsOfToday(timerId: String, since: Long): List<TimerRecordEntity> =
        db.recordDao().ofTimerSince(timerId, since).filter { it.record_type == Types.RECORD_SEGMENT }

    companion object {
        fun buildJson(type: String, targetDate: String?, presetMin: Long?, focusMin: Long?, shortMin: Long?, longMin: Long?, rounds: Long?): String {
            val j = buildJsonObject {
                put("schema_version", 1)
                when (type) {
                    Types.DATE -> { put("target_date", targetDate ?: ""); put("timezone_id", java.time.ZoneId.systemDefault().id); put("include_today", false) }
                    Types.PRECISE -> put("preset_ms", (presetMin ?: 25L) * 60000)
                    Types.POMODORO -> {
                        put("focus_ms", (focusMin ?: 25L) * 60000)
                        put("short_break_ms", (shortMin ?: 5L) * 60000)
                        put("long_break_ms", (longMin ?: 15L) * 60000)
                        put("rounds_before_long", (rounds ?: 4L).toInt())
                    }
                }
            }
            return j.toString()
        }
    }
}
