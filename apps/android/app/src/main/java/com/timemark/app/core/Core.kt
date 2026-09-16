package com.timemark.app.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

object Types {
    const val DATE = "DATE_COUNTDOWN"
    const val PRECISE = "PRECISE_COUNTDOWN"
    const val STOPWATCH = "STOPWATCH"
    const val POMODORO = "POMODORO"

    const val IDLE = "idle"
    const val RUNNING = "running"
    const val PAUSED = "paused"

    const val RECORD_PRECISE = "PRECISE"
    const val RECORD_SEGMENT = "SEGMENT"
    const val RECORD_STOPWATCH = "STOPWATCH"

    val TYPE_LABEL = mapOf(
        DATE to "日期倒计时", PRECISE to "精确倒计时",
        STOPWATCH to "正计时", POMODORO to "番茄钟"
    )
}

@Serializable
data class RunJson(
    val target_at: Long? = null,
    val remaining_at_pause: Long? = null,
    val accumulated_ms: Long? = null,
    val segment_started_at: Long? = null,
    val phase: String? = null,
    val phase_ends_at: Long? = null,
    val completed_focus: Int = 0
)

@Serializable
data class ConfigJson(
    val schema_version: Int = 1,
    val target_date: String? = null,
    val timezone_id: String? = null,
    val include_today: Boolean = false,
    val preset_ms: Long? = null,
    val focus_ms: Long? = null,
    val short_break_ms: Long? = null,
    val long_break_ms: Long? = null,
    val rounds_before_long: Int? = null
)

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
    /** §3 通用状态计算：given row 的 JSON 快照 + 当前墙钟，推导 UI 所需的全部派生量 */
    fun live(type: String, runState: String, runJson: String?, configJson: String?, now: Long): LiveState {
        val run = Jsons.runJson(runJson)
        val cfg = Jsons.configJson(configJson)
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
            Types.POMODORO -> {
                val focus = cfg.focus_ms ?: 25 * 60000
                val phase = run.phase ?: "focus"
                val phasePreset = if (phase == "focus") focus else (cfg.short_break_ms ?: 5 * 60000)
                when (runState) {
                    Types.RUNNING -> {
                        val rem = (run.phase_ends_at ?: now) - now
                        val round = if (phase == "focus") run.completed_focus + 1 else run.completed_focus
                        LiveState(runState, maxOf(0, rem), phasePreset - maxOf(0, rem), phase, round, due = rem <= 0)
                    }
                    Types.PAUSED -> {
                        val rem = run.remaining_at_pause ?: 0
                        val round = if (phase == "focus") run.completed_focus + 1 else run.completed_focus
                        LiveState(runState, rem, phasePreset - rem, phase, round)
                    }
                    else -> LiveState(runState, focus, 0, "focus", 1)
                }
            }
            else -> LiveState(runState, 0, 0)
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
