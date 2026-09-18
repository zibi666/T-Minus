package com.timemark.app.data

import android.os.SystemClock
import com.timemark.app.core.ConfigJson
import com.timemark.app.core.PomodoroConfig
import com.timemark.app.core.Contract
import com.timemark.app.core.Jsons
import com.timemark.app.core.RunJson
import com.timemark.app.core.Types
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import kotlin.math.abs

/** 按本地自然日聚合的专注统计（全部由已同步的 timer_record 现场推导，不再有本机私有账本） */
data class DayStat(val day: String, val focusMs: Long, val rounds: Int, val marks: Int)

/**
 * §3/§4/§6 的本地执行核心：所有业务修改 = 本地事务写入 + pending_ops 同事务入队。
 * 番茄钟判定、默认值与夹紧、统计口径一律走 core/Contract.kt（跨端单一来源）。
 */
class TimerRepository(
    private val db: AppDatabase,
    private val auth: AuthStore
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    fun observeTimers() = db.timerDao().observeLive()
    fun observeRecords() = db.recordDao().observeAll()
    fun observeQueuedCount() = db.pendingOpDao().observeQueuedCount()

    /** 计时记录列表（历史页） */
    fun observeDailyStats(): Flow<List<DayStat>> = combine(
        db.timerDao().observeStatFlags(),
        db.recordDao().observeStatRows()
    ) { timers, rows -> aggregateDaily(timers, rows) }

    /** §3.6 单调时钟守卫：内存基准表（不持久化，进程重启后懒重建，与 Windows segStartMonoNs 一致）。
     *  key = timerId。记录每个 running 计时器进入当前段时的单调/墙钟基准与段起点剩余/累计。 */
    private val monoBaselines = mutableMapOf<String, MonoBaseline>()

    private data class MonoBaseline(
        val monoStart: Long,         // SystemClock.elapsedRealtime() at baseline
        val wallStart: Long,         // System.currentTimeMillis() at baseline
        val remainingAtStart: Long,  // PRECISE/POMODORO：段起点剩余时长
        val elapsedAtStart: Long     // STOPWATCH：段起点已累计（含之前段 + 重启前当前段）
    )

    private suspend fun enqueue(op: PendingOpEntity) {
        if (auth.token() != null) db.pendingOpDao().enqueue(op)
    }

    private suspend fun rowPayload(e: TimerItemEntity, withRun: Boolean) =
        RowCodec.entityRow(e, withRun).toString()

    /** 番茄钟判定：type=PRECISE 且 config 含 pomodoro（与 Windows 同一判定） */
    private fun isPomodoro(t: TimerItemEntity): Boolean =
        Contract.isPomodoro(t.type, Jsons.configJson(t.config_json))

    private fun pomoOf(t: TimerItemEntity): Contract.Pomodoro =
        Contract.normalizePomodoro(Jsons.configJson(t.config_json))

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

    /**
     * 元数据更新。返回 null 表示已保存，非 null 为拒绝原因（与 Windows UpdateResult 对齐，
     * 不再出现「表单保存成功但什么都没变」）。
     */
    suspend fun updateMeta(
        id: String, name: String?, type: String?, color: String?, remark: String?, configJson: String?
    ): String? {
        val old = db.timerDao().byId(id) ?: return "计时不存在"
        val now = System.currentTimeMillis()
        val newType = type ?: old.type
        var newConfig = configJson ?: old.config_json
        val oldIsPomo = old.type == Types.PRECISE && Jsons.configJson(old.config_json).isPomodoro()
        var rejected: String? = null

        if (configJson != null) {
            val cfg = Jsons.configJson(configJson)
            val newIsPomo = newType == Types.PRECISE && cfg.isPomodoro()
            val switchingKind = newIsPomo != oldIsPomo
            // 同一形态下改时长会让已展示的进度悬空；形态切换允许（下面按 typeChanged 清运行态）
            val changesProgress = old.run_state != Types.IDLE && !switchingKind &&
                (cfg.preset_ms ?: 0L) != (Jsons.configJson(old.config_json).preset_ms ?: 0L)
            if (changesProgress) {
                rejected = "运行中不能修改时长，请先结束或重置"
                newConfig = old.config_json
            } else if (newIsPomo) {
                val src = cfg.pomodoro
                newConfig = Contract.pomodoroConfigJson(
                    src?.work_ms, src?.break_ms,
                    // 兼容本端 v0.4.7 只写顶层 long_break_ms 的历史数据
                    src?.long_break_ms ?: cfg.long_break_ms,
                    src?.rounds
                ).toString()
            }
        }

        val newIsPomo = newType == Types.PRECISE && Jsons.configJson(newConfig).isPomodoro()
        val typeChanged = (type != null && type != old.type) || oldIsPomo != newIsPomo
        val e = old.copy(
            name = name ?: old.name,
            type = newType,
            color = color ?: old.color,
            remark = remark ?: old.remark,
            config_json = newConfig,
            run_state = if (typeChanged) Types.IDLE else old.run_state,
            run_json = if (typeChanged) null else old.run_json,
            session_id = if (typeChanged) null else old.session_id,
            version = old.version + 1, updated_at = now
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, typeChanged), old.version, typeChanged, now))
        if (typeChanged) monoBaselines.remove(id)
        return rejected
    }

    suspend fun deleteTimer(id: String) {
        val old = db.timerDao().byId(id) ?: return
        val now = System.currentTimeMillis()
        val e = old.copy(deleted = true, version = old.version + 1, updated_at = now)
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "delete", e.id, rowPayload(e, false), old.version, false, now))
        monoBaselines.remove(id)
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

    /** 同步拉回远程变更后作废本地单调基准：他端可能重置/续接了段，旧基准会把新目标时刻改坏 */
    fun onRemoteApplied(timerId: String) {
        monoBaselines.remove(timerId)
    }

    suspend fun start(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (old.run_state == Types.RUNNING) return // 防御：已在运行不重复 start
        val cfg = Jsons.configJson(old.config_json)
        val now = System.currentTimeMillis()
        val monoNow = SystemClock.elapsedRealtime()
        val session = UUID.randomUUID().toString()
        if (isPomodoro(old)) {
            val workMs = pomoOf(old).workMs
            commitRun(old, RunJson(phase = Contract.PHASE_FOCUS, phase_ends_at = now + workMs, completed_focus = 0), Types.RUNNING, session)
            monoBaselines[id] = MonoBaseline(monoNow, now, workMs, 0)
        } else when (old.type) {
            Types.PRECISE -> {
                val preset = cfg.preset_ms ?: return
                commitRun(old, RunJson(target_at = now + preset, segments_ms = emptyList()), Types.RUNNING, session)
                monoBaselines[id] = MonoBaseline(monoNow, now, preset, 0)
            }
            Types.STOPWATCH -> {
                commitRun(old, RunJson(accumulated_ms = 0, segment_started_at = now, segments_ms = emptyList()), Types.RUNNING, session)
                monoBaselines[id] = MonoBaseline(monoNow, now, 0, 0)
            }
        }
    }

    suspend fun pause(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (old.run_state != Types.RUNNING) return // 防御：非运行态不可暂停
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        if (isPomodoro(old)) {
            commitRun(old, run.copy(remaining_at_pause = maxOf(0, (run.phase_ends_at ?: now) - now)), Types.PAUSED)
        } else when (old.type) {
            Types.PRECISE -> commitRun(old, run.copy(remaining_at_pause = maxOf(0, (run.target_at ?: now) - now)), Types.PAUSED)
            Types.STOPWATCH -> commitRun(
                old, run.copy(
                    accumulated_ms = (run.accumulated_ms ?: 0) + maxOf(0, now - (run.segment_started_at ?: now)),
                    segment_started_at = null
                ), Types.PAUSED
            )
        }
        monoBaselines.remove(id) // 暂停后退出 running 段，清除单调基准（resume 时重建）
    }

    suspend fun resume(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (old.run_state != Types.PAUSED) return // 防御：非暂停态不可继续
        val now = System.currentTimeMillis()
        val monoNow = SystemClock.elapsedRealtime()
        val run = Jsons.runJson(old.run_json)
        if (isPomodoro(old)) {
            val rem = run.remaining_at_pause ?: 0
            commitRun(old, run.copy(phase_ends_at = now + rem, remaining_at_pause = null), Types.RUNNING)
            monoBaselines[id] = MonoBaseline(monoNow, now, rem, 0)
        } else when (old.type) {
            Types.PRECISE -> {
                val rem = run.remaining_at_pause ?: 0
                commitRun(old, run.copy(target_at = now + rem, remaining_at_pause = null), Types.RUNNING)
                monoBaselines[id] = MonoBaseline(monoNow, now, rem, 0)
            }
            Types.STOPWATCH -> {
                val acc = run.accumulated_ms ?: 0
                commitRun(old, run.copy(segment_started_at = now), Types.RUNNING)
                monoBaselines[id] = MonoBaseline(monoNow, now, 0, acc)
            }
        }
    }

    /**
     * 分段（对齐 Windows engine.segment 语义）：
     *  - 精确倒计时 = 打点记 lap，倒计时**不中断**，target_at 保留，session 不变，segments_ms 追加；
     *  - 正计时 = 记一个 lap 继续累计，segments_ms 追加；
     *  - 暂停态同样可结算；番茄钟无手动打点（用 skipPhase 跳阶段）。
     */
    suspend fun segment(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (isPomodoro(old)) return
        if (old.run_state != Types.RUNNING && old.run_state != Types.PAUSED) return
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        val cfg = Jsons.configJson(old.config_json)
        val running = old.run_state == Types.RUNNING
        when (old.type) {
            Types.PRECISE -> {
                val preset = cfg.preset_ms ?: return
                val totalElapsed = if (running) preset - maxOf(0, (run.target_at ?: now) - now)
                else preset - (run.remaining_at_pause ?: 0)
                val segs = (run.segments_ms ?: emptyList()).toMutableList()
                val seg = totalElapsed - segs.sum()
                if (seg <= 0) return // 无新分段（防重复打点）
                segs.add(seg)
                insertRecordRaw(old, now - seg, now, seg / 1000, Types.RECORD_SEGMENT)
                // 倒计时不中断：保留 target_at / remaining_at_pause，仅追加 segments_ms
                commitRun(old, run.copy(segments_ms = segs), old.run_state)
            }
            Types.STOPWATCH -> {
                val total = if (running) (run.accumulated_ms ?: 0) + maxOf(0, now - (run.segment_started_at ?: now))
                else (run.accumulated_ms ?: 0)
                val segs = (run.segments_ms ?: emptyList()).toMutableList()
                val lap = total - segs.sum()
                if (lap <= 0) return
                segs.add(lap)
                insertRecordRaw(old, now - lap, now, lap / 1000, Types.RECORD_SEGMENT)
                // 运行态：重置 segment_started_at 开新 lap；暂停态：仅追加 segments_ms
                val newRun = if (running) run.copy(accumulated_ms = total, segment_started_at = now, segments_ms = segs)
                else run.copy(accumulated_ms = total, segments_ms = segs)
                commitRun(old, newRun, old.run_state)
                // 运行态 lap 重置后更新单调基准（段起点累计 = total）
                if (running) monoBaselines[id] = MonoBaseline(SystemClock.elapsedRealtime(), now, 0, total)
            }
        }
    }

    /**
     * 结束：当前进度如实结算后归零（与 Windows stop 同语义，三类可运行计时统一走这一个入口）。
     * IDLE 态直接返回（防幽灵记录）；不足 Contract.PARTIAL_SETTLE_MIN_MS 视为误触，不记账。
     * 番茄钟按阶段写 POMODORO_FOCUS / POMODORO_BREAK，统计与历史不再靠时长猜阶段。
     */
    suspend fun stop(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (old.run_state == Types.IDLE) return
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        val cfg = Jsons.configJson(old.config_json)
        if (isPomodoro(old)) {
            val p = pomoOf(old)
            val phase = run.phase ?: Contract.PHASE_FOCUS
            val preset = Contract.phasePresetMs(p, phase)
            val remaining = if (old.run_state == Types.PAUSED) maxOf(0, run.remaining_at_pause ?: 0)
            else maxOf(0, (run.phase_ends_at ?: now) - now)
            val elapsed = maxOf(0, preset - remaining)
            if (elapsed >= Contract.PARTIAL_SETTLE_MIN_MS) {
                insertRecordRaw(old, now - elapsed, now, elapsed / 1000,
                    if (phase == Contract.PHASE_FOCUS) Types.RECORD_POMODORO_FOCUS else Types.RECORD_POMODORO_BREAK)
            }
        } else when (old.type) {
            Types.PRECISE -> {
                val preset = cfg.preset_ms ?: return
                val remaining = if (old.run_state == Types.PAUSED) maxOf(0, run.remaining_at_pause ?: 0)
                else maxOf(0, (run.target_at ?: now) - now)
                val elapsed = maxOf(0, preset - remaining)
                if (elapsed >= Contract.PARTIAL_SETTLE_MIN_MS) {
                    insertRecordRaw(old, now - elapsed, now, elapsed / 1000, Types.RECORD_PRECISE)
                }
            }
            Types.STOPWATCH -> {
                val total = if (old.run_state == Types.RUNNING) (run.accumulated_ms ?: 0) + maxOf(0, now - (run.segment_started_at ?: now))
                else (run.accumulated_ms ?: 0)
                if (total >= Contract.PARTIAL_SETTLE_MIN_MS) {
                    insertRecordRaw(old, now - total, now, total / 1000, Types.RECORD_STOPWATCH)
                }
            }
        }
        commitRun(old, RunJson(), Types.IDLE)
        monoBaselines.remove(id)
    }

    /** 归零：不记账（区别于 stop 的「如实结算已进行时长」） */
    suspend fun reset(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (old.type == Types.DATE) return
        if (old.run_state == Types.IDLE && old.run_json == null) return // 防御：已 idle 且无残留不重复 commit
        commitRun(old, RunJson(accumulated_ms = if (old.type == Types.STOPWATCH) 0 else null), Types.IDLE)
        monoBaselines.remove(id)
    }

    // ---- 到点结算：PRECISE 到点 / 番茄钟阶段推进（§3.5，含循环与如实记账 + 长休息）----

    /** 结算结果：供调用方（闹钟/前台循环）发通知，UI 之外不再静默 */
    data class Settled(val timer: TimerItemEntity, val kind: String, val phase: String? = null)

    suspend fun settleDue(now: Long = System.currentTimeMillis()): List<Settled> {
        val settled = mutableListOf<Settled>()
        for (raw in db.timerDao().runningAll()) {
            // §3.6 单调守卫：墙钟跳变 > 阈值时用 elapsedRealtime 修正 run_json，返回修正后实体
            val t = guardMonoClock(raw, now)
            val run = Jsons.runJson(t.run_json)
            if (isPomodoro(t)) {
                val end = run.phase_ends_at ?: continue
                if (end <= now) settled += advancePomodoro(t, end, now)
            } else if (t.type == Types.PRECISE) {
                val target = run.target_at ?: continue
                if (target <= now) settled += finishPrecise(t, target)
            }
        }
        return settled
    }

    /** §3.6 单调时钟守卫：检测墙钟与 elapsedRealtime 偏差，超阈值则修正 run_json 的目标时刻。
     *  防御用户改系统时间 / NTP 校时跳变 / 时区切换导致倒计时突变（与 Windows MONO_GUARD_MS 一致）。
     *  返回修正后的实体（已持久化）或原实体（无显著跳变）。 */
    private suspend fun guardMonoClock(t: TimerItemEntity, now: Long): TimerItemEntity {
        val run = Jsons.runJson(t.run_json)
        // 懒重建基准：进程重启后内存基准丢失，以当前墙钟为准重建（与 Windows load() 一致）
        val baseline = monoBaselines[t.id] ?: rebuildBaseline(t, run, now).also { monoBaselines[t.id] = it }
        val monoNow = SystemClock.elapsedRealtime()
        val monoElapsed = monoNow - baseline.monoStart
        val wallElapsed = now - baseline.wallStart
        if (abs(wallElapsed - monoElapsed) <= Contract.MONO_GUARD_MS) return t // 无显著跳变

        val isPomo = isPomodoro(t)
        val newRun: RunJson
        val newBaseline: MonoBaseline
        if (isPomo || t.type == Types.PRECISE) {
            // 倒计时类：用单调剩余修正目标时刻（target_at / phase_ends_at）
            val correctedRemaining = maxOf(0, baseline.remainingAtStart - monoElapsed)
            newRun = if (isPomo) run.copy(phase_ends_at = now + correctedRemaining)
            else run.copy(target_at = now + correctedRemaining)
            newBaseline = MonoBaseline(monoNow, now, correctedRemaining, 0)
        } else if (t.type == Types.STOPWATCH) {
            // 正计时：用单调累计修正 accumulated_ms，段起点重置为修正时刻
            val correctedElapsed = baseline.elapsedAtStart + monoElapsed
            newRun = run.copy(accumulated_ms = correctedElapsed, segment_started_at = now)
            newBaseline = MonoBaseline(monoNow, now, 0, correctedElapsed)
        } else return t

        // 持久化修正（运行状态更新 is_run=true，随同步收敛到其他设备）
        val e = t.copy(run_json = json.encodeToString(RunJson.serializer(), newRun), version = t.version + 1, updated_at = now)
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), t.version, true, now))
        monoBaselines[t.id] = newBaseline
        return e
    }

    /** 进程重启后懒重建单调基准：以当前墙钟为准（与 Windows TimerEngine.reseatBaseline 一致） */
    private fun rebuildBaseline(t: TimerItemEntity, run: RunJson, now: Long): MonoBaseline {
        val monoNow = SystemClock.elapsedRealtime()
        return if (isPomodoro(t)) {
            MonoBaseline(monoNow, now, maxOf(0, (run.phase_ends_at ?: now) - now), 0)
        } else if (t.type == Types.PRECISE) {
            MonoBaseline(monoNow, now, maxOf(0, (run.target_at ?: now) - now), 0)
        } else { // STOPWATCH：基准累计 = accumulated + 当前段已进行（与 Windows segStartElapsedMs 一致）
            val acc = (run.accumulated_ms ?: 0) + maxOf(0, now - (run.segment_started_at ?: now))
            MonoBaseline(monoNow, now, 0, acc)
        }
    }

    private suspend fun finishPrecise(t: TimerItemEntity, endedAt: Long): Settled {
        val cfg = Jsons.configJson(t.config_json)
        val preset = cfg.preset_ms ?: 0L
        insertRecordRaw(t, endedAt - preset, endedAt, preset / 1000, Types.RECORD_PRECISE)
        val e = commitRunIdle(t)
        monoBaselines.remove(t.id)
        return Settled(e, Types.RECORD_PRECISE)
    }

    /** 番茄钟阶段推进：focus→break/long_break→focus 循环，无限轮。
     *  阶段写进 record_type；下一阶段的 phase_ends_at 从 now 起算（漏掉的时间不补记，与 Windows 一致）。 */
    private suspend fun advancePomodoro(t: TimerItemEntity, phaseEnd: Long, now: Long): Settled {
        val cfg = Jsons.configJson(t.config_json)
        val p = Contract.normalizePomodoro(cfg)
        val run = Jsons.runJson(t.run_json)
        val phase = run.phase ?: Contract.PHASE_FOCUS
        val isFocus = phase == Contract.PHASE_FOCUS
        insertRecordRaw(t, phaseEnd - Contract.phasePresetMs(p, phase), phaseEnd,
            Contract.phasePresetMs(p, phase) / 1000,
            if (isFocus) Types.RECORD_POMODORO_FOCUS else Types.RECORD_POMODORO_BREAK)
        val (nextPhase, nextPreset) = nextPhaseOf(p, phase, run.completed_focus)
        val e = t.copy(
            run_json = json.encodeToString(RunJson.serializer(), RunJson(phase = nextPhase, phase_ends_at = now + nextPreset, completed_focus = nextCompleted(phase, run.completed_focus))),
            run_state = Types.RUNNING, version = t.version + 1, updated_at = now
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), t.version, true, now))
        // 阶段切换：重置单调基准（新阶段起点剩余 = nextPreset）
        monoBaselines[t.id] = MonoBaseline(SystemClock.elapsedRealtime(), now, nextPreset, 0)
        return Settled(e, if (isFocus) Types.RECORD_POMODORO_FOCUS else Types.RECORD_POMODORO_BREAK, nextPhase)
    }

    /** 长休息判定与下一阶段（skipPhase 与 advancePomodoro 共用，两端一致） */
    private fun nextPhaseOf(p: Contract.Pomodoro, phase: String, completedFocus: Int): Pair<String, Long> {
        val isFocus = phase == Contract.PHASE_FOCUS
        val completed = completedFocus + if (isFocus) 1 else 0
        return if (!isFocus) Contract.PHASE_FOCUS to p.workMs
        else {
            val long = Contract.isLongBreakDue(p, completed)
            (if (long) Contract.PHASE_LONG_BREAK else Contract.PHASE_BREAK) to
                (if (long) p.longBreakMs else p.breakMs)
        }
    }

    private fun nextCompleted(phase: String, completedFocus: Int): Int =
        completedFocus + (if (phase == Contract.PHASE_FOCUS) 1 else 0)

    /** 跳过（番茄钟）：不足阈值的误触丢弃记账（与 Windows skipPhase 一致） */
    suspend fun skipPhase(id: String) {
        val old = db.timerDao().byId(id) ?: return
        if (old.run_state != Types.RUNNING) return
        if (!isPomodoro(old)) return // 防御：非番茄钟无阶段可跳
        val now = System.currentTimeMillis()
        val run = Jsons.runJson(old.run_json)
        val p = pomoOf(old)
        val phase = run.phase ?: Contract.PHASE_FOCUS
        val isFocus = phase == Contract.PHASE_FOCUS
        val elapsed = Contract.phasePresetMs(p, phase) - maxOf(0, (run.phase_ends_at ?: now) - now)
        if (elapsed >= Contract.PARTIAL_SETTLE_MIN_MS) {
            insertRecordRaw(old, now - elapsed, now, elapsed / 1000,
                if (isFocus) Types.RECORD_POMODORO_FOCUS else Types.RECORD_POMODORO_BREAK)
        }
        val (nextPhase, nextPreset) = nextPhaseOf(p, phase, run.completed_focus)
        val e = old.copy(
            run_json = json.encodeToString(RunJson.serializer(), RunJson(phase = nextPhase, phase_ends_at = now + nextPreset, completed_focus = nextCompleted(phase, run.completed_focus))),
            run_state = Types.RUNNING, version = old.version + 1, updated_at = now
        )
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), old.version, true, now))
        monoBaselines[id] = MonoBaseline(SystemClock.elapsedRealtime(), now, nextPreset, 0)
    }

    private suspend fun commitRunIdle(t: TimerItemEntity): TimerItemEntity {
        val now = System.currentTimeMillis()
        val e = t.copy(run_state = Types.IDLE, run_json = null, session_id = null, version = t.version + 1, updated_at = now)
        db.timerDao().upsert(e)
        enqueue(PendingOpEntity(UUID.randomUUID().toString(), "timer_item", "update", e.id, rowPayload(e, true), t.version, true, now))
        return e
    }

    // ---- 记录 ----

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
        db.recordDao().ofTimerSince(timerId, since)

    /** 记录 → 按天统计（口径全在 Contract.contribute，本端只负责分组） */
    private fun aggregateDaily(timers: List<TimerStatRow>, rows: List<RecordStatRow>): List<DayStat> {
        val meta = timers.associateBy({ it.id }, {
            val cfg = Jsons.configJson(it.config_json)
            Triple(it.type, Contract.isPomodoro(it.type, cfg), Contract.normalizePomodoro(cfg))
        })
        val fallback = Contract.normalizePomodoro(ConfigJson())
        val byDay = LinkedHashMap<String, Contract.Contribution>()
        for (r in rows) {
            val m = meta[r.timer_id]
            val c = Contract.contribute(
                durationSec = r.duration_sec,
                recordType = r.record_type,
                timerIsPomodoro = m?.second ?: false,
                p = m?.third ?: fallback
            )
            if (c.focusMs == 0L && c.rounds == 0 && c.marks == 0) continue
            val day = com.timemark.app.core.Fmt.dayKey(r.ended_at)
            byDay[day] = (byDay[day] ?: Contract.Contribution.ZERO) + c
        }
        return byDay.map { (day, c) -> DayStat(day, c.focusMs, c.rounds, c.marks) }
    }

    companion object {
        /** 构建 config_json。番茄钟输出 canonical 落位（long_break_ms 在 pomodoro 内 + 顶层镜像），
         *  夹紧与默认值由 Contract 决定，因此旧客户端也读得到同一个长休息值。 */
        fun buildJson(type: String, targetDate: String?, presetMin: Long?, focusMin: Long?, shortMin: Long?, longMin: Long?, rounds: Long?): String {
            if (type == Types.POMODORO) {
                return Contract.pomodoroConfigJson(
                    (focusMin ?: 25L) * 60000, (shortMin ?: 5L) * 60000, (longMin ?: 15L) * 60000, (rounds ?: 4L).toInt()
                ).toString()
            }
            val j = buildJsonObject {
                put("schema_version", 1)
                when (type) {
                    Types.DATE -> { put("target_date", targetDate ?: ""); put("timezone_id", java.time.ZoneId.systemDefault().id); put("include_today", false) }
                    Types.PRECISE -> put("preset_ms", (((presetMin ?: 25L) * 60000).coerceIn(Contract.PRESET_MIN_MS, Contract.PRESET_MAX_MS)))
                    Types.STOPWATCH -> { /* 正计时无配置 */ }
                }
            }
            return j.toString()
        }
    }
}
