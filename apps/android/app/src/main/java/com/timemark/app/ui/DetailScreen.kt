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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.timemark.app.core.Engine
import com.timemark.app.core.Fmt
import com.timemark.app.core.Jsons
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import kotlinx.coroutines.launch

@Composable
fun DetailScreen(c: AppContainer, timerId: String, onBack: () -> Unit, onEdit: (String) -> Unit) {
    val timers by c.repo.observeTimers().collectAsState(initial = emptyList())
    val records by c.repo.observeRecords().collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val now = rememberNow()
    val t = timers.firstOrNull { it.id == timerId } ?: run {
        Column(Modifier.fillMaxSize().background(C.bg).padding(18.dp)) {
            Text("记录已删除", color = C.textLow); Spacer(Modifier.height(10.dp))
            Text("返回", color = C.cyan, modifier = Modifier.clickable { onBack() })
        }
        return
    }
    val s = Engine.live(t.type, t.run_state, t.run_json, t.config_json, now)
    val tint = colorFor(t.color)
    val today0 = Fmt.startOfToday()
    val segs = records.filter { it.timer_id == t.id && it.ended_at >= today0 }

    Column(Modifier.fillMaxSize().background(C.bg).padding(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = C.text,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onBack() }.padding(6.dp))
            Spacer(Modifier.width(6.dp))
            ColorDot(t.color, 12); Spacer(Modifier.width(8.dp))
            Text(t.name, color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1)
            TypeBadge(t.type)
            Spacer(Modifier.width(8.dp))
            Icon(Icons.Filled.Edit, "编辑", tint = C.textLow,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onEdit(t.id) }.padding(6.dp))
        }
        Spacer(Modifier.height(24.dp))

        Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) {
            when (t.type) {
                Types.PRECISE, Types.POMODORO -> {
                    val preset = if (t.type == Types.PRECISE) (Jsons.configJson(t.config_json).preset_ms ?: 1)
                    else (if (s.phase == "focus") (Jsons.configJson(t.config_json).focus_ms ?: 1) else (Jsons.configJson(t.config_json).short_break_ms ?: 1))
                    CircularProgressIndicator(
                        progress = { (if (t.run_state == Types.IDLE) 0f else (s.elapsedMs.toFloat() / preset.toFloat())).coerceIn(0f, 1f) },
                        modifier = Modifier.size(230.dp), strokeWidth = 10.dp, color = tint, trackColor = C.stroke
                    )
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(Fmt.hms(s.remainingMs), color = C.text, fontSize = 40.sp, fontWeight = FontWeight.Bold)
                        if (t.type == Types.POMODORO) {
                            Spacer(Modifier.height(4.dp))
                            Text(
                                (if (s.phase == "focus") "专注 · 第 ${s.round} 轮" else "休息") + (if (t.run_state == Types.RUNNING) " · 进行中" else ""),
                                color = C.textLow, fontSize = 12.sp
                            )
                        }
                    }
                }
                Types.STOPWATCH -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(Fmt.hms(s.elapsedMs), color = C.text, fontSize = 44.sp, fontWeight = FontWeight.Bold)
                    Text("正计时" + (if (t.run_state == Types.RUNNING) " · 进行中" else ""), color = C.textLow, fontSize = 12.sp)
                }
                else -> {
                    val cfg = com.timemark.app.core.Jsons.configJson(t.config_json)
                    val left = cfg.target_date?.let { Engine.daysLeft(it, cfg.timezone_id, cfg.include_today, now) }
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (left != null && left >= 0) "$left" else "0", color = tint, fontSize = 56.sp, fontWeight = FontWeight.Bold)
                        Text("天", color = C.textLow, fontSize = 13.sp)
                        if (cfg.target_date != null) Text("目标 · ${cfg.target_date}", color = C.textLow, fontSize = 12.sp)
                    }
                }
            }
        }

        Spacer(Modifier.height(20.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            when (t.type) {
                Types.PRECISE, Types.STOPWATCH, Types.POMODORO -> {
                    when (t.run_state) {
                        Types.RUNNING -> {
                            ActionButton("暂停", C.amber) { scope.launch { c.repo.pause(t.id) } }
                            if (t.type == Types.PRECISE || t.type == Types.STOPWATCH) ActionButton("分段", C.violet) { scope.launch { c.repo.segment(t.id) } }
                            if (t.type == Types.POMODORO) ActionButton("跳过", C.cyan) { scope.launch { c.repo.skipPhase(t.id) } }
                            ActionButton("结束", C.danger) { scope.launch { c.repo.stop(t.id) } }
                        }
                        Types.PAUSED -> {
                            ActionButton("继续", C.mint) { scope.launch { c.repo.resume(t.id) } }
                            ActionButton("结束", C.danger) { scope.launch { c.repo.stop(t.id) } }
                        }
                        else -> {
                            ActionButton("开始", C.mint) { scope.launch { c.repo.start(t.id) } }
                            ActionButton("重置", C.textLow) { scope.launch { c.repo.reset(t.id) } }
                        }
                    }
                }
                else -> ActionButton("重置", C.textLow) { }
            }
        }

        Spacer(Modifier.height(22.dp))
        Text("今日分段 · ${segs.size}", color = C.textLow, fontSize = 12.sp)
        Spacer(Modifier.height(8.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(segs, key = { it.id }) { r ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.card).padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    ColorDot(t.color, 8); Spacer(Modifier.width(8.dp))
                    Text(
                        when (r.record_type) {
                            Types.RECORD_SEGMENT -> "分段"
                            Types.RECORD_PRECISE -> "完成"
                            else -> "计时"
                        }, color = C.text, fontSize = 12.5.sp, modifier = Modifier.weight(1f)
                    )
                    Text(Fmt.hms(r.duration_sec * 1000), color = tint, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.width(10.dp))
                    Text(Fmt.hm(r.started_at) + " ~ " + Fmt.hm(r.ended_at), color = C.textLow, fontSize = 11.sp)
                }
            }
            if (segs.isEmpty()) item { EmptyHint("今天还没有分段") }
        }
    }
}
