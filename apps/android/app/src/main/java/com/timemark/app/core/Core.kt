package com.timemark.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

object Types {
    const val DATE = "DATE_COUNTDOWN"
    const val PRECISE = "PRECISE_COUNTDOWN"
    const val STOPWATCH = "STOPWATCH"

    /** 番茄钟不再是独立 type：与 Windows 对齐，存 PRECISE_COUNTDOWN + config.pomodoro 嵌套。
     *  此常量仅用于 UI 逻辑分支标识（isPomodoro 判定后替代 type 比较）。 */
    const val POMODORO = "POMODORO"

    const val IDLE = "idle"
    const val RUNNING = "running"
    const val PAUSED = "paused"

    const val RECORD_PRECISE = "PRECISE"
    const val RECORD_SEGMENT = "SEGMENT"
    const val RECORD_STOPWATCH = "STOPWATCH"
    /** 番茄钟阶段记录：把阶段作为事实写进记录，替代旧版「按时长猜是不是休息」 */
    const val RECORD_POMODORO_FOCUS = "POMODORO_FOCUS"
    const val RECORD_POMODORO_BREAK = "POMODORO_BREAK"

    val TYPE_LABEL = mapOf(
        DATE to "日期倒计时", PRECISE to "精确倒计时",
        STOPWATCH to "正计时", POMODORO to "番茄钟"
    )

    /** 记录类型 → 中文徽章（历史页用） */
    val RECORD_LABEL = mapOf(
        RECORD_PRECISE to "完成", RECORD_SEGMENT to "分段", RECORD_STOPWATCH to "正计时",
        RECORD_POMODORO_FOCUS to "专注", RECORD_POMODORO_BREAK to "休息"
    )

    /** 逻辑类型：番茄钟（PRECISE + pomodoro 配置）返回 POMODORO，否则返回原 type */
    fun logical(type: String, configJson: String?): String {
        val cfg = Jsons.configJson(configJson)
        return if (Contract.isPomodoro(type, cfg)) POMODORO else type
    }
}

@Serializable
data class RunJson(
    val target_at: Long? = null,
    val remaining_at_pause: Long? = null,
    val accumulated_ms: Long? = null,
    val segment_started_at: Long? = null,
    val phase: String? = null,
    val phase_ends_at: Long? = null,
    val completed_focus: Int = 0,
    /** 与 Windows 对齐：已完成分段时长列表（PRECISE=各轮实际用时；STOPWATCH=各 lap 用时） */
    val segments_ms: List<Long>? = null
)

/** Windows 兼容的番茄钟嵌套配置（§4.4）。long_break_ms 与 Windows 同处 pomodoro 内。 */
@Serializable
data class PomodoroConfig(
    val work_ms: Long? = null,
    val break_ms: Long? = null,
    val long_break_ms: Long? = null,
    val rounds: Int? = null
)

@Serializable
data class ConfigJson(
    val schema_version: Int = 1,
    val target_date: String? = null,
    val timezone_id: String? = null,
    val include_today: Boolean = false,
    val preset_ms: Long? = null,
    /** Windows 兼容嵌套：存在即视为番茄钟 */
    val pomodoro: PomodoroConfig? = null,
    /** 兼容落位：v0.4.7 的 Android 把长休息写在顶层；读取兜底，写入时同时镜像 */
    val long_break_ms: Long? = null,
    // ---- 旧格式（v0.4.6 遗留，仅读取兼容，写入不再使用）----
    val focus_ms: Long? = null,
    val short_break_ms: Long? = null,
    val rounds_before_long: Int? = null
) {
    /** 归一化视图：默认值与夹紧边界由 Contract 统一给出 */
    val normalized: Contract.Pomodoro get() = Contract.normalizePomodoro(this)

    /** 配置层面是否为番茄钟（不看 type；type 判定见 Contract.isPomodoro） */
    fun isPomodoro(): Boolean = pomodoro != null || (focus_ms ?: 0L) > 0L

    /** 专注时长 */
    fun workMs(): Long = normalized.workMs

    /** 短休息时长 */
    fun shortBreakMs(): Long = normalized.breakMs

    /** 长休息时长 */
    fun longBreakMs(): Long = normalized.longBreakMs

    /** 长休息间隔轮数 */
    fun roundsBeforeLong(): Int = normalized.rounds
}

object Jsons {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }
    fun runJson(s: String?): RunJson = if (s.isNullOrBlank()) RunJson() else try { json.decodeFromString(s) } catch (e: Exception) { RunJson() }
    fun configJson(s: String?): ConfigJson = if (s.isNullOrBlank()) ConfigJson() else try { json.decodeFromString(s) } catch (e: Exception) { ConfigJson() }
}

data class LiveState(
    val runState: String,
    val remainingMs: Long,
    val elapsedMs: Long,
    val phase: String? = null,
    val round: Int = 0,
    val daysLeft: Long? = null,
    val targetAt: Long? = null,
    val due: Boolean = false
)

object Engine {
    /** §3 通用状态计算：given row 的 JSON 快照 + 当前墙钟，推导 UI 所需的全部派生量。
     *  番茄钟通过 config.isPomodoro() 判定（type 统一为 PRECISE_COUNTDOWN，与 Windows 对齐）。 */
    fun live(type: String, runState: String, runJson: String?, configJson: String?, now: Long): LiveState {
        val run = Jsons.runJson(runJson)
        val cfg = Jsons.configJson(configJson)
        // 番茄钟：PRECISE_COUNTDOWN + pomodoro 配置（与 Windows isPomodoro 一致）
        if (Contract.isPomodoro(type, cfg)) return pomodoroLive(runState, run, cfg, now)
        return when (type) {
            Types.PRECISE -> {
                val preset = cfg.preset_ms ?: 0L
                when (runState) {
                    Types.RUNNING -> {
                        val rem = (run.target_at ?: now) - now
                        LiveState(runState, maxOf(0, rem), preset - maxOf(0, rem), targetAt = run.target_at, due = rem <= 0)
                    }
                    Types.PAUSED -> {
                        val rem = run.remaining_at_pause ?: 0
                        LiveState(runState, rem, preset - rem)
                    }
                    else -> LiveState(runState, preset, 0)
                }
            }
            Types.STOPWATCH -> {
                val acc = run.accumulated_ms ?: 0
                when (runState) {
                    Types.RUNNING -> LiveState(runState, 0, acc + maxOf(0, now - (run.segment_started_at ?: now)))
                    else -> LiveState(runState, 0, acc)
                }
            }
            // DATE 无运行态，剩余天数由 Engine.daysLeft 按目标时区自然日算。
            // 缺这个分支时 else 会落到 LiveState(runState, 0, 0)，daysLeft 恒为 null；
            // 调用方若直接读 s.daysLeft 就会显示「未设置」（三个既有调用点各自另算 daysLeft 才没爆）。
            Types.DATE -> {
                val left = cfg.target_date?.let { daysLeft(it, cfg.timezone_id, cfg.include_today, now) }
                LiveState(runState, 0, 0, daysLeft = left, due = left != null && left <= 0)
            }
            else -> LiveState(runState, 0, 0)
        }
    }

    private fun pomodoroLive(runState: String, run: RunJson, cfg: ConfigJson, now: Long): LiveState {
        val p = cfg.normalized
        val phase = run.phase ?: Contract.PHASE_FOCUS
        val isFocus = phase == Contract.PHASE_FOCUS
        val phasePreset = Contract.phasePresetMs(p, phase)
        // 轮次：专注中显示正在进行的第 completed+1 轮，休息中显示刚完成的第 completed 轮
        val round = if (isFocus) run.completed_focus + 1 else run.completed_focus
        return when (runState) {
            Types.RUNNING -> {
                val rem = (run.phase_ends_at ?: now) - now
                LiveState(runState, maxOf(0, rem), phasePreset - maxOf(0, rem), phase, round, due = rem <= 0)
            }
            Types.PAUSED -> {
                val rem = run.remaining_at_pause ?: 0
                LiveState(runState, rem, phasePreset - rem, phase, round)
            }
            else -> LiveState(runState, phasePreset, 0, phase, round)
        }
    }

    /** §3.2 剩余天数：目标日期 − 当前日期（按目标时区自然日）；includeToday 时 +1 —— 与 Windows dateLogic.ts 一致 */
    fun daysLeft(targetDate: String, timezoneId: String?, includeToday: Boolean, now: Long): Long? {
        return try {
            val tz = java.time.ZoneId.of(timezoneId ?: java.time.ZoneId.systemDefault().id)
            val target = java.time.LocalDate.parse(targetDate)
            val today = java.time.Instant.ofEpochMilli(now).atZone(tz).toLocalDate()
            val d = java.time.temporal.ChronoUnit.DAYS.between(today, target)
            if (includeToday) d + 1 else d
        } catch (e: Exception) { null }
    }
}

object Fmt {
    fun hms(ms: Long): String {
        val total = maxOf(0, ms) / 1000
        val h = total / 3600; val m = (total % 3600) / 60; val s = total % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
    }
    fun hm(ms: Long): String {
        val t = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault())
        return "%02d:%02d".format(t.hour, t.minute)
    }
    fun dayKey(ms: Long): String {
        val d = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
        return d.toString()
    }
    fun dayTitle(ms: Long): String {
        val d = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault())
        return "${d.monthValue}月${d.dayOfMonth}日"
    }
    fun startOfToday(): Long {
        val d = java.time.LocalDate.now()
        return d.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
    }
}
