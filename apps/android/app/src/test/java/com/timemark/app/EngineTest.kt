package com.timemark.app

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import com.timemark.app.core.Engine
import com.timemark.app.core.Jsons
import com.timemark.app.core.Types

/**
 * 计时引擎纯函数单测（对应 §3 四类型状态推导与 §3.6 时间异常守卫）
 * 运行：gradle :app:testDebugUnitTest
 *
 * 番茄钟 schema 对齐 Windows：type=PRECISE_COUNTDOWN + config.pomodoro 嵌套；
 * 旧格式（type=POMODORO + focus_ms 顶层）仍由 ConfigJson 读取兼容。
 */
class EngineTest {

    private val now = 1789600000000L

    /** Windows 兼容番茄钟配置：work=25min, break=5min, rounds=4, long_break=15min */
    private val pomoCfg = """{"schema_version":1,"preset_ms":1500000,"pomodoro":{"work_ms":1500000,"break_ms":300000,"rounds":4},"long_break_ms":900000}"""

    @Test
    fun precise_running_remaining() {
        val run = """{"target_at":${now + 60000}}"""
        val s = Engine.live("PRECISE_COUNTDOWN", "running", run, """{"schema_version":1,"preset_ms":120000}""", now)
        assertEquals(60000, s.remainingMs)
        assertEquals(60000, s.elapsedMs)
        assertEquals(false, s.due)
    }

    @Test
    fun precise_due_when_past_target() {
        val run = """{"target_at":${now - 1000}}"""
        val s = Engine.live("PRECISE_COUNTDOWN", "running", run, """{"schema_version":1,"preset_ms":60000}""", now)
        assertEquals(0, s.remainingMs)
        assertEquals(true, s.due)
    }

    @Test
    fun precise_paused_uses_snapshot() {
        val run = """{"remaining_at_pause":30000}"""
        val s = Engine.live("PRECISE_COUNTDOWN", "paused", run, """{"schema_version":1,"preset_ms":60000}""", now)
        assertEquals(30000, s.remainingMs)
        assertEquals(30000, s.elapsedMs)
    }

    @Test
    fun precise_idle_shows_preset() {
        val s = Engine.live("PRECISE_COUNTDOWN", "idle", null, """{"schema_version":1,"preset_ms":25000}""", now)
        assertEquals(25000, s.remainingMs)
    }

    @Test
    fun stopwatch_running_accumulates() {
        val run = """{"accumulated_ms":10000,"segment_started_at":${now - 5000}}"""
        val s = Engine.live("STOPWATCH", "running", run, "{}", now)
        assertEquals(15000, s.elapsedMs)
    }

    @Test
    fun stopwatch_wall_clock_jump_guard() {
        // §3.6：系统时间被拨慢（segment_started_at 记录于旧墙钟，拨慢后落在未来）→
        // maxOf(0, now - segment_started_at) 钳为 0，累计不出现负数/异常跳变
        val run = """{"accumulated_ms":10000,"segment_started_at":${now + 99999999}}"""
        val s = Engine.live("STOPWATCH", "running", run, "{}", now)
        assertTrue(s.elapsedMs <= 10000)
    }

    @Test
    fun pomodoro_round_numbering() {
        // 番茄钟 type 统一为 PRECISE_COUNTDOWN，通过 config.pomodoro 判定
        val focus = """{"phase":"focus","phase_ends_at":${now + 1000},"completed_focus":2}"""
        val sFocus = Engine.live("PRECISE_COUNTDOWN", "running", focus, pomoCfg, now)
        assertEquals(3, sFocus.round) // 专注中：第 completed_focus+1 = 3 轮
        val brk = """{"phase":"break","phase_ends_at":${now + 1000},"completed_focus":2}"""
        val sBreak = Engine.live("PRECISE_COUNTDOWN", "running", brk, pomoCfg, now)
        assertEquals(2, sBreak.round) // 休息中：轮次保持 completed_focus = 2
    }

    @Test
    fun pomodoro_long_break_phase() {
        // 长休息阶段：phase="long_break" → preset 取 long_break_ms（15min）
        val run = """{"phase":"long_break","phase_ends_at":${now + 60000},"completed_focus":4}"""
        val s = Engine.live("PRECISE_COUNTDOWN", "running", run, pomoCfg, now)
        assertEquals(60000, s.remainingMs)
        // elapsed = longBreakMs - remaining = 900000 - 60000 = 840000
        assertEquals(840000, s.elapsedMs)
        assertEquals(4, s.round) // 长休息中轮次保持 completed_focus
    }

    @Test
    fun pomodoro_short_break_uses_break_ms() {
        // 短休息阶段：phase="break" → preset 取 pomodoro.break_ms（5min）
        val run = """{"phase":"break","phase_ends_at":${now + 100000},"completed_focus":1}"""
        val s = Engine.live("PRECISE_COUNTDOWN", "running", run, pomoCfg, now)
        assertEquals(100000, s.remainingMs)
        // elapsed = break_ms - remaining = 300000 - 100000 = 200000
        assertEquals(200000, s.elapsedMs)
    }

    @Test
    fun pomodoro_legacy_config_fallback() {
        // 旧格式兼容：type=POMODORO + focus_ms 顶层字段（v0.4.6 遗留数据）
        // 迁移后 type 已转为 PRECISE_COUNTDOWN，但 config_json 仍是旧格式 → ConfigJson.isPomodoro() 经 focus_ms 判定为真
        val legacyCfg = """{"schema_version":1,"focus_ms":1500000,"short_break_ms":300000}"""
        val run = """{"phase":"focus","phase_ends_at":${now + 60000},"completed_focus":0}"""
        val s = Engine.live("PRECISE_COUNTDOWN", "running", run, legacyCfg, now)
        assertEquals(60000, s.remainingMs)
        assertEquals(1, s.round)
    }

    @Test
    fun date_days_left() {
        // 目标日必须从被测的那个固定时刻推出来：用真实 now() 会让这个用例只在特定日期通过
        val base = java.time.Instant.ofEpochMilli(now).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
        val d = Engine.daysLeft(base.plusDays(7).toString(), null, false, now)
        assertEquals(7L, d)
        assertEquals(0L, Engine.daysLeft(base.toString(), null, false, now))
        assertEquals(1L, Engine.daysLeft(base.toString(), null, true, now))
        assertEquals(-3L, Engine.daysLeft(base.minusDays(3).toString(), null, false, now))
        assertEquals(null, Engine.daysLeft("not-a-date", null, false, now))
    }

    @Test
    fun pomodoro_idle_shows_phase_from_run_json() {
        // 空闲态也按 run_json 留存阶段展示（与 Windows dto() 一致），他端重置后本端不会假装回到第 1 轮专注
        val run = """{"phase":"long_break","phase_ends_at":${now + 1000},"completed_focus":4}"""
        val s = Engine.live("PRECISE_COUNTDOWN", "idle", run, pomoCfg, now)
        assertEquals(900000, s.remainingMs) // 长休息档 15 分钟
        assertEquals("long_break", s.phase)
        assertEquals(4, s.round)
    }

    @Test
    fun malformed_json_falls_back() {
        val s = Engine.live("PRECISE_COUNTDOWN", "idle", "{broken", """{"schema_version":1,"preset_ms":1000}""", now)
        assertEquals(1000, s.remainingMs)
    }

    @Test
    fun logical_type_pomodoro_detection() {
        // Types.logical：PRECISE + pomodoro 配置 → POMODORO；PRECISE 无 pomodoro → PRECISE
        assertEquals(Types.POMODORO, Types.logical("PRECISE_COUNTDOWN", pomoCfg))
        assertEquals(Types.PRECISE, Types.logical("PRECISE_COUNTDOWN", """{"schema_version":1,"preset_ms":60000}"""))
        assertEquals(Types.STOPWATCH, Types.logical("STOPWATCH", "{}"))
        assertEquals(Types.DATE, Types.logical("DATE_COUNTDOWN", """{"schema_version":1,"target_date":"2027-01-01"}"""))
    }
}
