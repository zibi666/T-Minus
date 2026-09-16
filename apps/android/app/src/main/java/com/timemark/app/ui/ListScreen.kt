package com.timemark.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.timemark.app.core.ConfigJson
import com.timemark.app.core.Engine
import com.timemark.app.core.Fmt
import com.timemark.app.core.Jsons
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import com.timemark.app.data.TimerItemEntity
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun rememberNow(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        while (true) { now = System.currentTimeMillis(); delay(500) }
    }
    return now
}

@Composable
fun ListScreen(c: AppContainer, openDetail: (String) -> Unit, openForm: () -> Unit, openHistory: () -> Unit, openLogin: () -> Unit) {
    val timers by c.repo.observeTimers().collectAsState(initial = emptyList())
    val records by c.repo.observeRecords().collectAsState(initial = emptyList())
    val journal by c.journal.observe().collectAsState(initial = emptyMap())
    val loggedIn by c.auth.loggedIn.collectAsState(initial = false)
    val scope = rememberCoroutineScope()
    val now = rememberNow()

    val today0 = Fmt.startOfToday()
    val day = Fmt.dayKey(now)
    val js = journal[day] ?: com.timemark.app.data.DayStat()
    val pomoIds = timers.filter { it.type == Types.POMODORO }.map { it.id }.toSet()
    var focusMs = js.workMs
    var rounds = js.workCount
    var marks = 0
    for (r in records) {
        if (r.ended_at < today0) continue
        if (r.record_type == Types.RECORD_SEGMENT) { marks++; focusMs += r.duration_sec * 1000 }
        else if (!pomoIds.contains(r.timer_id)) { focusMs += r.duration_sec * 1000; rounds += 1 }
    }

    Scaffold(
        containerColor = C.bg,
        floatingActionButton = {
            FloatingActionButton(onClick = openForm, containerColor = C.cyan, contentColor = Color(0xFF05060F)) {
                Icon(Icons.Filled.Add, contentDescription = "新建")
            }
        }
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(horizontal = 18.dp)) {
            Spacer(Modifier.height(18.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("TimeMark 时光标", color = C.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text("专注每一天", color = C.textLow, fontSize = 11.sp)
                }
                Icon(Icons.Filled.History, "历史", tint = C.textLow,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { openHistory() }.padding(6.dp))
                Icon(Icons.Filled.Person, "账号", tint = if (loggedIn) C.cyan else C.textLow,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { openLogin() }.padding(6.dp))
            }
            Spacer(Modifier.height(14.dp))
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(C.card).padding(vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                StatBlock("今日专注", Fmt.hms(focusMs))
                StatBlock("完成轮次", rounds.toString())
                StatBlock("累计打点", marks.toString())
                StatBlock("连续记录", streakDays(records, journal, now).toString() + " 天")
            }
            Spacer(Modifier.height(12.dp))
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(timers, key = { it.id }) { t -> TimerCard(t, now, c, scope, openDetail) }
                item { Spacer(Modifier.height(80.dp)) }
            }
        }
    }
}

private fun streakDays(
    records: List<com.timemark.app.data.TimerRecordEntity>,
    journal: Map<String, com.timemark.app.data.DayStat>,
    now: Long
): Int {
    val days = HashSet<String>()
    for (r in records) days.add(Fmt.dayKey(r.ended_at))
    for (k in journal.keys) if (journal[k]!!.workCount > 0 || journal[k]!!.workMs > 0) days.add(k)
    var streak = 0
    val cal = java.util.Calendar.getInstance().apply { timeInMillis = now }
    fun key(cal: java.util.Calendar): String = Fmt.dayKey(cal.timeInMillis)
    if (!days.contains(key(cal))) cal.add(java.util.Calendar.DAY_OF_MONTH, -1)
    while (days.contains(key(cal))) { streak++; cal.add(java.util.Calendar.DAY_OF_MONTH, -1) }
    return streak
}

@Composable
fun TimerCard(t: TimerItemEntity, now: Long, c: AppContainer, scope: kotlinx.coroutines.CoroutineScope, openDetail: (String) -> Unit) {
    val s = Engine.live(t.type, t.run_state, t.run_json, t.config_json, now)
    val tint = colorFor(t.color)
    val running = t.run_state == Types.RUNNING

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(C.card)
            .clickable { openDetail(t.id) }
            .padding(16.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ColorDot(t.color, 12)
            Spacer(Modifier.width(8.dp))
            Text(t.name, color = C.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f), maxLines = 1)
            Icon(Icons.Filled.PushPin, "置顶", tint = if (t.pinned) C.amber else C.stroke,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { scope.launch { c.repo.togglePin(t.id) } }.padding(3.dp))
            Icon(Icons.Filled.Star, "收藏", tint = if (t.starred) C.amber else C.stroke,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { scope.launch { c.repo.toggleStar(t.id) } }.padding(3.dp))
            Spacer(Modifier.width(4.dp))
            TypeBadge(t.type)
        }
        Spacer(Modifier.height(10.dp))

        when (t.type) {
            Types.DATE -> {
                val cfg = Jsons.configJson(t.config_json)
                val left = cfg.target_date?.let { Engine.daysLeft(it, cfg.timezone_id, cfg.include_today, now) }
                Text(
                    if (left != null) (if (left >= 0) "$left 天" else "已到期") else "未设置",
                    color = tint, fontSize = 30.sp, fontWeight = FontWeight.Bold
                )
                if (cfg.target_date != null) Text("目标 · ${cfg.target_date}", color = C.textLow, fontSize = 12.sp)
            }
            Types.PRECISE -> {
                Text(Fmt.hms(s.remainingMs), color = if (running) tint else C.text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text(
                    when (t.run_state) {
                        Types.RUNNING -> "倒计时进行中"
                        Types.PAUSED -> "已暂停 · 剩余 " + Fmt.hms(s.remainingMs)
                        else -> "预设 " + Fmt.hms(Jsons.configJson(t.config_json).preset_ms ?: 0)
                    }, color = C.textLow, fontSize = 12.sp
                )
            }
            Types.STOPWATCH -> {
                Text(Fmt.hms(s.elapsedMs), color = if (running) tint else C.text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text(if (running) "正计时进行中" else "正计时", color = C.textLow, fontSize = 12.sp)
            }
            Types.POMODORO -> {
                Text(Fmt.hms(s.remainingMs), color = if (running) tint else C.text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
                Text(
                    (if (s.phase == "focus") "专注 · 第 ${s.round} 轮" else "休息") + (if (running) " · 进行中" else ""),
                    color = C.textLow, fontSize = 12.sp
                )
            }
        }

        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (t.type) {
                Types.PRECISE, Types.STOPWATCH, Types.POMODORO -> {
                    when (t.run_state) {
                        Types.RUNNING -> {
                            ActionButton("暂停", C.amber) { scope.launch { c.repo.pause(t.id) } }
                            if (t.type != Types.STOPWATCH) ActionButton("跳过", C.cyan) { scope.launch { c.repo.skipPhase(t.id); } }
                            if (t.type == Types.PRECISE) ActionButton("分段", C.violet) { scope.launch { c.repo.segment(t.id) } }
                            ActionButton("结束", C.danger) { scope.launch { c.repo.stop(t.id) } }
                        }
                        Types.PAUSED -> {
                            ActionButton("继续", C.mint) { scope.launch { c.repo.resume(t.id) } }
                            ActionButton("结束", C.danger) { scope.launch { c.repo.stop(t.id) } }
                        }
                        else -> ActionButton("开始", C.mint) { scope.launch { c.repo.start(t.id) } }
                    }
                }
            }
        }
    }
}
