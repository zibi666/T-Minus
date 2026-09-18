package com.timemark.app.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// 跨端契约单一来源（与 apps/windows/src/shared/contract.ts 逐字段镜像）。
// 默认值、夹紧边界、config_json 字段落位、isPomodoro 判定、色板只在这里定义一次；
// 两端由 shared/contract/fixtures/contract.json 表驱动测试共同校验。

object Contract {
    const val MONO_GUARD_MS = 2000L

    const val DEFAULT_WORK_MS = 25 * 60000L
    const val DEFAULT_BREAK_MS = 5 * 60000L
    const val DEFAULT_LONG_BREAK_MS = 15 * 60000L
    const val DEFAULT_ROUNDS = 4

    /** 夹紧边界：越界一律夹回，双端必须一致 */
    const val WORK_MIN = 60000L
    const val WORK_MAX = 180 * 60000L
    const val BREAK_MIN = 30000L
    const val BREAK_MAX = 60 * 60000L
    const val LONG_BREAK_MIN = 30000L
    const val LONG_BREAK_MAX = 240 * 60000L
    const val ROUNDS_MIN = 1
    const val ROUNDS_MAX = 12

    const val PHASE_FOCUS = "focus"
    const val PHASE_BREAK = "break"
    const val PHASE_LONG_BREAK = "long_break"

    const val PRESET_MIN_MS = 1000L
    const val PRESET_MAX_MS = 365L * 86400000L

    /** 提前结束/跳阶段的最小结算时长：不足则视为误触，不写记录（与 Windows 同一阈值） */
    const val PARTIAL_SETTLE_MIN_MS = 5000L

    /** 计时器色板（v3 规范 §1.3 的 8 色，与 Windows TIMER_PALETTE 同序同值） */
    val TIMER_PALETTE = listOf(
        "#4DC9F0", "#9381FF", "#21E0C4", "#FFB224",
        "#FF6B6B", "#5A9EFF", "#F472B6", "#A3E635"
    )
    val DEFAULT_TIMER_COLOR: String = TIMER_PALETTE[0]
    val TAG_PALETTE: List<String> = TIMER_PALETTE

    const val TYPE_PRECISE = "PRECISE_COUNTDOWN"

    /** null / 非正数 → 默认值；其余夹进 [lo,hi]（与 TS clamp 同语义） */
    private fun clamp(v: Long?, lo: Long, hi: Long, fallback: Long): Long =
        if (v == null || v <= 0L) fallback else v.coerceIn(lo, hi)

    private fun clampInt(v: Int?, lo: Int, hi: Int, fallback: Int): Int =
        if (v == null || v <= 0) fallback else v.coerceIn(lo, hi)

    data class Pomodoro(
        val workMs: Long,
        val breakMs: Long,
        val longBreakMs: Long,
        val rounds: Int
    )

    /**
     * 读番茄钟配置（ConfigJson 已是解析后的视图）。兼容三种历史落位：
     *   1) 规范：pomodoro.{work_ms,break_ms,long_break_ms,rounds}
     *   2) 本端 v0.4.7：长休息落在顶层 long_break_ms
     *   3) 本端 v0.4.6：顶层 focus_ms / short_break_ms / rounds_before_long
     */
    fun normalizePomodoro(cfg: ConfigJson): Pomodoro = Pomodoro(
        workMs = clamp(cfg.pomodoro?.work_ms ?: cfg.focus_ms, WORK_MIN, WORK_MAX, DEFAULT_WORK_MS),
        breakMs = clamp(cfg.pomodoro?.break_ms ?: cfg.short_break_ms, BREAK_MIN, BREAK_MAX, DEFAULT_BREAK_MS),
        longBreakMs = clamp(cfg.pomodoro?.long_break_ms ?: cfg.long_break_ms, LONG_BREAK_MIN, LONG_BREAK_MAX, DEFAULT_LONG_BREAK_MS),
        rounds = clampInt(cfg.pomodoro?.rounds ?: cfg.rounds_before_long, ROUNDS_MIN, ROUNDS_MAX, DEFAULT_ROUNDS)
    )

    /** 是否番茄钟：type=PRECISE_COUNTDOWN 且存在番茄钟配置（含旧格式 focus_ms>0） */
    fun isPomodoro(type: String, cfg: ConfigJson): Boolean =
        type == TYPE_PRECISE && (cfg.pomodoro != null || (cfg.focus_ms ?: 0L) > 0L)

    fun phasePresetMs(p: Pomodoro, phase: String?): Long = when (phase) {
        PHASE_LONG_BREAK -> p.longBreakMs
        PHASE_BREAK -> p.breakMs
        else -> p.workMs
    }

    /** 长休息判定：每完成 rounds 轮专注进一次长休息 */
    fun isLongBreakDue(p: Pomodoro, completedFocusAfterThisRound: Int): Boolean =
        completedFocusAfterThisRound > 0 && completedFocusAfterThisRound % p.rounds == 0

    fun tagColorFor(name: String): String {
        val sum = name.sumOf { it.code }
        return TAG_PALETTE[sum % TAG_PALETTE.size]
    }

    /** 普通精确倒计时 config（与 Windows buildPreciseConfig 同形） */
    fun preciseConfigJson(presetMs: Long): JsonObject = buildJsonObject {
        put("schema_version", 1)
        put("preset_ms", clamp(presetMs, PRESET_MIN_MS, PRESET_MAX_MS, PRESET_MIN_MS))
    }

    /**
     * 番茄钟 config（canonical 落位，与 Windows buildPomodoroConfig 同形）：
     * long_break_ms 在 pomodoro 内（Windows/新本端读这里），顶层再镜像一份（v0.4.7 只读顶层）——
     * 两处同写让新旧客户端都拿到同一个值。
     */
    fun pomodoroConfigJson(workMs: Long?, breakMs: Long?, longBreakMs: Long?, rounds: Int?): JsonObject {
        val p = normalizePomodoro(
            ConfigJson(pomodoro = PomodoroConfig(work_ms = workMs, break_ms = breakMs, long_break_ms = longBreakMs, rounds = rounds))
        )
        return buildJsonObject {
            put("schema_version", 1)
            put("preset_ms", p.workMs)
            put("pomodoro", buildJsonObject {
                put("work_ms", p.workMs)
                put("break_ms", p.breakMs)
                put("long_break_ms", p.longBreakMs)
                put("rounds", p.rounds)
            })
            put("long_break_ms", p.longBreakMs)
        }
    }

    /** 一条记录对三项今日统计的贡献。统计口径只在 Contract 一处决定，双端求和后按天分组。 */
    data class Contribution(val focusMs: Long, val rounds: Int, val marks: Int) {
        operator fun plus(o: Contribution) = Contribution(focusMs + o.focusMs, rounds + o.rounds, marks + o.marks)

        companion object {
            val ZERO = Contribution(0L, 0, 0)
        }
    }

    /**
     * 单条记录的统计贡献。
     * 新数据按 record_type 直接判定；历史的番茄钟 PRECISE 记录无法区分阶段，
     * 只能按时长猜测（等于任一休息档则不计入专注），与旧版行为一致。
     */
    fun contribute(
        durationSec: Long,
        recordType: String,
        timerIsPomodoro: Boolean,
        p: Pomodoro
    ): Contribution {
        val ms = durationSec * 1000L
        if (ms <= 0L) return Contribution.ZERO
        return when (recordType) {
            Types.RECORD_POMODORO_FOCUS -> Contribution(ms, 1, 0)
            Types.RECORD_POMODORO_BREAK -> Contribution.ZERO
            Types.RECORD_SEGMENT -> Contribution(0L, 0, 1)
            Types.RECORD_PRECISE, Types.RECORD_STOPWATCH -> {
                // 番茄钟的历史 PRECISE：等于休息档则视为休息段
                if (timerIsPomodoro && (ms == p.breakMs || ms == p.longBreakMs)) Contribution.ZERO
                else Contribution(ms, 1, 0)
            }
            else -> Contribution.ZERO
        }
    }
}
