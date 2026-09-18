package com.timemark.app

import com.timemark.app.core.ConfigJson
import com.timemark.app.core.Contract
import com.timemark.app.core.Jsons
import com.timemark.app.core.Types
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 跨端契约一致性测试（表驱动，与 Windows apps/windows/tests/contract.test.cjs 读同一份 fixture）。
 * 任一端语义漂移（默认值、夹紧、字段落位、统计口径、色板）都会在这里失败。
 * fixture 目录由 build.gradle.kts 的 test resources srcDir 指向仓库根 shared/contract/fixtures。
 */
class ContractFixtureTest {

    private val root: JsonObject = Json.parseToJsonElement(
        javaClass.classLoader.getResourceAsStream("contract.json")!!.bufferedReader().use { it.readText() }
    ).jsonObject

    private fun arr(key: String): List<JsonObject> = (root[key]!!.jsonArray).map { it.jsonObject }

    private fun JsonObject.str(k: String): String = this[k]!!.jsonPrimitive.content
    private fun JsonObject.longv(k: String): Long = this[k]!!.jsonPrimitive.long
    private fun JsonObject.intv(k: String): Int = this[k]!!.jsonPrimitive.int
    private fun JsonObject.bool(k: String): Boolean = this[k]!!.jsonPrimitive.boolean
    private fun JsonObject.obj(k: String): JsonObject = this[k]!!.jsonObject
    private fun JsonElement.asConfig(): ConfigJson = Jsons.json.decodeFromJsonElement(ConfigJson.serializer(), this)

    @Test
    fun `常量与契约一致`() {
        val c = root["constants"]!!.jsonObject
        assertEquals(c["mono_guard_ms"]!!.jsonPrimitive.long, Contract.MONO_GUARD_MS)
        val palette = c["palette"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(palette, Contract.TIMER_PALETTE)
        assertEquals(c["default_color"]!!.jsonPrimitive.content, Contract.DEFAULT_TIMER_COLOR)
    }

    @Test
    fun `番茄钟默认值与夹紧边界`() {
        for (t in arr("normalize")) {
            val got = Contract.normalizePomodoro(t["config"]!!.asConfig())
            val e = t.obj("expect")
            assertEquals(t.str("name"), e.longv("work_ms"), got.workMs)
            assertEquals(t.str("name"), e.longv("break_ms"), got.breakMs)
            assertEquals(t.str("name"), e.longv("long_break_ms"), got.longBreakMs)
            assertEquals(t.str("name"), e.intv("rounds"), got.rounds)
        }
    }

    @Test
    fun `番茄钟统一判定`() {
        for (t in arr("is_pomodoro")) {
            assertEquals(
                t.str("name"),
                t.bool("expect"),
                Contract.isPomodoro(t.str("type"), t["config"]!!.asConfig())
            )
        }
    }

    @Test
    fun `阶段时长与长休息触发`() {
        for (t in arr("phase_preset")) {
            val phase = t["phase"]?.jsonPrimitive?.contentOrNull
            assertEquals(
                t.str("name"),
                t.longv("expect_ms"),
                Contract.phasePresetMs(Contract.normalizePomodoro(t["config"]!!.asConfig()), phase)
            )
        }
        for (t in arr("long_break_due")) {
            assertEquals(
                t.str("name"),
                t.bool("expect"),
                Contract.isLongBreakDue(Contract.normalizePomodoro(t["config"]!!.asConfig()), t.intv("completed"))
            )
        }
    }

    @Test
    fun `写入落位与夹紧后可被对端原样读出`() {
        for (t in arr("build_pomodoro_config")) {
            val input = t.obj("input")
            val got = Contract.pomodoroConfigJson(
                input["work_ms"]?.jsonPrimitive?.long,
                input["break_ms"]?.jsonPrimitive?.long,
                input["long_break_ms"]?.jsonPrimitive?.long,
                input["rounds"]?.jsonPrimitive?.int
            )
            assertEquals(t.str("name"), t.obj("expect"), got)
            // 写出去的 canonical 形态必须被同一套归一化读回同样的长休息
            val back = Contract.normalizePomodoro(got.asConfig())
            assertEquals(t.str("name"), t.obj("expect").obj("pomodoro").longv("long_break_ms"), back.longBreakMs)
        }
        for (t in arr("build_precise_config")) {
            assertEquals(t.str("name"), t.obj("expect"), Contract.preciseConfigJson(t.longv("input_ms")))
        }
    }

    @Test
    fun `统计口径双端一致`() {
        for (t in arr("contribute")) {
            val got = Contract.contribute(
                durationSec = t.longv("duration_sec"),
                recordType = t.str("record_type"),
                timerIsPomodoro = t.bool("timer_is_pomodoro"),
                p = Contract.normalizePomodoro(t["config"]!!.asConfig())
            )
            val e = t.obj("expect")
            assertEquals(t.str("name"), e.longv("focus_ms"), got.focusMs)
            assertEquals(t.str("name"), e.intv("rounds"), got.rounds)
            assertEquals(t.str("name"), e.intv("marks"), got.marks)
        }
    }

    @Test
    fun `标签哈希取色一致`() {
        for (t in arr("tag_color")) {
            assertEquals(t.str("name"), t.str("expect"), Contract.tagColorFor(t.str("tag")))
        }
    }

    @Test
    fun `自动结算记录的跨端去重 id`() {
        for (t in arr("record_id")) {
            assertEquals(
                t.str("name"),
                t.str("expect"),
                Contract.recordId(
                    t.str("timer_id"),
                    t["session_id"]?.jsonPrimitive?.contentOrNull,
                    t.str("phase_key"),
                    t.intv("completed_focus")
                )
            )
        }
    }

    @Test
    fun `记录类型常量与 fixture 用值一致`() {
        // fixture 直接写字符串，本端常量必须逐字对应，否则统计与历史判定会静默失效
        assertTrue(arr("contribute").isNotEmpty())
        assertEquals("POMODORO_FOCUS", Types.RECORD_POMODORO_FOCUS)
        assertEquals("POMODORO_BREAK", Types.RECORD_POMODORO_BREAK)
        assertEquals("SEGMENT", Types.RECORD_SEGMENT)
        assertEquals("PRECISE", Types.RECORD_PRECISE)
        assertEquals("STOPWATCH", Types.RECORD_STOPWATCH)
    }
}
