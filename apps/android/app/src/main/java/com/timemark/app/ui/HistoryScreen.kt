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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.timemark.app.core.Fmt
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import com.timemark.app.data.TimerRecordEntity
import kotlinx.coroutines.launch

private val RANGES = listOf("今天", "近7天", "近30天", "全部")

@Composable
fun HistoryScreen(c: AppContainer, onBack: () -> Unit) {
    val records by c.repo.observeRecords().collectAsState(initial = emptyList())
    val timers by c.repo.observeTimers().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val now = rememberNow()
    var range by remember { mutableIntStateOf(0) }
    var colorFilter by remember { mutableStateOf<String?>("all") }
    val nameById = remember(timers) { timers.associate { it.id to it.name } }
    val colorById = remember(timers) { timers.associate { it.id to it.color } }

    val since = when (range) {
        0 -> Fmt.startOfToday()
        1 -> Fmt.startOfToday() - 6 * 86400000L
        2 -> Fmt.startOfToday() - 29 * 86400000L
        else -> 0L
    }
    val filtered = records.filter {
        it.ended_at >= since && (colorFilter == "all" || colorFilter == null || colorById[it.timer_id] == colorFilter)
    }.sortedByDescending { it.ended_at }
    val grouped = filtered.groupBy { Fmt.dayKey(it.ended_at) }.toSortedMap(compareByDescending { it })

    Column(Modifier.fillMaxSize().background(C.bg).padding(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = C.text,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onBack() }.padding(6.dp))
            Spacer(Modifier.width(8.dp))
            Column {
                Text("历史记录", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text("到点自动保存 · 点击条目可删除", color = C.textLow, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            RANGES.forEachIndexed { i, label -> Chip(label, range == i) { range = i } }
            Spacer(Modifier.width(4.dp))
            ColorDot("all", 14); Spacer(Modifier.width(2.dp))
            Box(Modifier.clip(RoundedCornerShape(6.dp)).clickable { colorFilter = "all" }.padding(2.dp)) {
                Text("全部", color = if (colorFilter == "all") C.cyan else C.textLow, fontSize = 11.sp)
            }
            Spacer(Modifier.width(4.dp))
            val seen = LinkedHashMap<String, Boolean>()
            filtered.forEach { seen[colorById[it.timer_id] ?: ""] = true }
            PALETTE.filter { cc -> seen.any { s -> s.key.equals("#%02X%02X%02X".format(cc.red.toInt().times(255), cc.green.toInt().times(255), cc.blue.toInt().times(255)), ignoreCase = true) } }
                .forEach { cc ->
                    val hex = "#%02X%02X%02X".format(cc.red.toInt().times(255), cc.green.toInt().times(255), cc.blue.toInt().times(255))
                    Box(Modifier.padding(2.dp).clip(RoundedCornerShape(6.dp)).clickable { colorFilter = hex }) { ColorDot(hex, 16) }
                }
        }
        Spacer(Modifier.height(12.dp))

        LazyColumn {
            grouped.forEach { (day, list) ->
                item(key = "h_$day") {
                    Text(Fmt.dayTitle(list.first().ended_at) + " · ${list.size} 条", color = C.textLow, fontSize = 11.5.sp,
                        modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
                }
                items(list, key = { it.id }) { r -> RecordRow(r, nameById[r.timer_id] ?: "已删除计时", colorById[r.timer_id], tintOf(colorById[r.timer_id])) { scope.launch { c.repo.deleteRecord(r.id) } } }
            }
            if (filtered.isEmpty()) item { EmptyHint("这一段时间还没有记录") }
        }
    }
}

private fun tintOf(color: String?): androidx.compose.ui.graphics.Color = colorFor(color)

@Composable
private fun RecordRow(r: TimerRecordEntity, name: String, color: String?, tint: androidx.compose.ui.graphics.Color, onDelete: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.card).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        ColorDot(color, 10); Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, color = C.text, fontSize = 13.5.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                Spacer(Modifier.width(6.dp))
                TypeBadge(r.record_type)
            }
            Text(Fmt.hm(r.started_at) + " ~ " + Fmt.hm(r.ended_at), color = C.textLow, fontSize = 11.sp)
        }
        Text(Fmt.hms(r.duration_sec * 1000), color = tint, fontSize = 13.5.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(10.dp))
        Icon(Icons.Filled.Delete, "删除", tint = C.stroke,
            modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { onDelete() }.padding(4.dp))
    }
}
