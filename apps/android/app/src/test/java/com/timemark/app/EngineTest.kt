package com.timemark.app

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import com.timemark.app.core.Engine
import com.timemark.app.core.Jsons

/**
 * 计时引擎纯函数单测（对应 §3 四类型状态推导与 §3.6 时间异常守卫）
 * 运行：gradle :app:testDebugUnitTest
 */
class EngineTest {

    private val now = 1789600000000L

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
        // §3.6：墙钟被拨快 → 单调守卫不累加负数/异常跳变（segment_started_at 在未来时按 0 计）
        val run = """{"accumulated_ms":10000,"segment_started_at":${now + 99999999}}"""
        val s = Engine.live("STOPWATCH", "running", run, "{}", now)
        assertTrue(s.elapsedMs <= 10000)
    }

    @Test
    fun pomodoro_round_numbering() {
        val focus = """{"phase":"focus","phase_ends_at":${now + 1000},"completed_focus":2}"""
        val sFocus = Engine.live("POMODORO", "running", focus, """{"schema_version":1,"focus_ms":1500000}""", now)
        assertEquals(3, sFocus.round)
        val brk = """{"phase":"break","phase_ends_at":${now + 1000},"completed_focus":2}"""
        val sBreak = Engine.live("POMODORO", "running", brk, """{"schema_version":1,"focus_ms":1500000}""", now)
        assertEquals(2, sBreak.round)
    }

    @Test
    fun date_days_left() {
        val today = java.time.LocalDate.now().plusDays(7).toString()
        val d = Engine.daysLeft(today, null, false, now)
        assertEquals(7L, d)
    }

    @Test
    fun malformed_json_falls_back() {
        val s = Engine.live("PRECISE_COUNTDOWN", "idle", "{broken", """{"schema_version":1,"preset_ms":1000}""", now)
        assertEquals(1000, s.remainingMs)
    }
}
