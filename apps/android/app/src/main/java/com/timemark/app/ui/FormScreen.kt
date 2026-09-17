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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import com.timemark.app.data.TimerRepository
import kotlinx.coroutines.launch

private val PRESET_MIN = listOf(1L, 5L, 10L, 25L, 45L, 60L, 90L, 120L)

@Composable
fun FormScreen(c: AppContainer, editId: String?, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var type by remember { mutableStateOf(Types.PRECISE) }
    var color by remember { mutableStateOf("#4DC9F0") }
    var remark by remember { mutableStateOf("") }
    var targetDate by remember { mutableStateOf("") }
    var presetMin by remember { mutableStateOf<Long>(25L) }
    var focusMin by remember { mutableStateOf<Long>(25L) }
    var shortMin by remember { mutableStateOf<Long>(5L) }
    var longMin by remember { mutableStateOf<Long>(15L) }
    var rounds by remember { mutableStateOf<Long>(4L) }
    var error by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }

    androidx.compose.runtime.LaunchedEffect(editId) {
        if (editId == null) { loaded = true; return@LaunchedEffect }
        val e = c.repo.byId(editId) ?: run { loaded = true; return@LaunchedEffect }
        val cfg = com.timemark.app.core.Jsons.configJson(e.config_json ?: "{}")
        name = e.name; type = e.type; color = e.color ?: "#4DC9F0"; remark = e.remark ?: ""
        targetDate = cfg.target_date ?: ""
        presetMin = cfg.preset_ms?.let { it / 60000 } ?: 25L
        focusMin = cfg.focus_ms?.let { it / 60000 } ?: 25L
        shortMin = cfg.short_break_ms?.let { it / 60000 } ?: 5L
        longMin = cfg.long_break_ms?.let { it / 60000 } ?: 15L
        rounds = cfg.rounds_before_long?.toLong() ?: 4L
        loaded = true
    }
    if (!loaded) {
        Column(Modifier.fillMaxSize().background(C.bg).padding(18.dp)) {
            Text("加载中…", color = C.textLow)
        }
        return
    }

    Column(Modifier.fillMaxSize().background(C.bg).padding(18.dp).verticalScroll(rememberScrollState())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = C.text,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onBack() }.padding(6.dp))
            Spacer(Modifier.width(8.dp))
            Text(if (editId == null) "新建计时" else "编辑计时", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(18.dp))

        TextField("名称", name) { name = it }
        Spacer(Modifier.height(12.dp))

        Text("类型", color = C.textLow, fontSize = 12.sp)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf(Types.PRECISE, Types.STOPWATCH, Types.POMODORO, Types.DATE).forEach { tp ->
                Chip(typeLabel(tp), type == tp) { type = tp }
            }
        }
        Spacer(Modifier.height(12.dp))

        Text("颜色", color = C.textLow, fontSize = 12.sp)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PALETTE.forEach { cc ->
                val hex = "#%02X%02X%02X".format((cc.red * 255).toInt(), (cc.green * 255).toInt(), (cc.blue * 255).toInt())
                Box(
                    Modifier
                        .size(26.dp)
                        .clip(CircleShape)
                        .background(cc)
                        .clickable { color = hex }
                        .padding(3.dp),
                    contentAlignment = Alignment.Center
                ) {
                    if (color.equals(hex, ignoreCase = true)) {
                        Box(Modifier.size(20.dp).clip(CircleShape).background(C.bg))
                        Box(Modifier.size(12.dp).clip(CircleShape).background(cc))
                    }
                }
            }
        }
        Spacer(Modifier.height(12.dp))

        when (type) {
            Types.PRECISE -> {
                Text("预设时长（分钟）", color = C.textLow, fontSize = 12.sp)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    PRESET_MIN.forEach { m -> Chip("${m}分", presetMin == m) { presetMin = m } }
                }
            }
            Types.POMODORO -> {
                NumField("专注（分钟）", focusMin) { focusMin = it }
                NumField("短休息（分钟）", shortMin) { shortMin = it }
                NumField("长休息（分钟）", longMin) { longMin = it }
                NumField("长休息间隔（轮）", rounds) { rounds = it }
            }
            Types.DATE -> {
                Text("目标日期", color = C.textLow, fontSize = 12.sp)
                Spacer(Modifier.height(6.dp))
                DateRow(targetDate) { targetDate = it }
            }
        }

        if (type != Types.DATE) {
            Spacer(Modifier.height(12.dp))
            TextField("备注", remark) { remark = it }
        }

        Spacer(Modifier.height(20.dp))
        error?.let { Text(it, color = C.danger, fontSize = 12.sp); Spacer(Modifier.height(8.dp)) }
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(C.cyan)
                .clickable {
                    if (name.isBlank()) { error = "名称不能为空"; return@clickable }
                    if (type == Types.DATE && targetDate.isBlank()) { error = "请选择目标日期"; return@clickable }
                    scope.launch {
                        val json = TimerRepository.buildJson(
                            type, targetDate.ifBlank { null }, presetMin, focusMin, shortMin, longMin, rounds
                        )
                        if (editId == null) c.repo.createTimer(name, type, color, json, remark.ifBlank { null })
                        else c.repo.updateMeta(editId, name, color, remark.ifBlank { null }, json)
                        onBack()
                    }
                }
                .padding(vertical = 13.dp),
            contentAlignment = Alignment.Center
        ) { Text("保存", color = Color(0xFF05060F), fontWeight = FontWeight.Bold, fontSize = 14.sp) }
        Spacer(Modifier.height(30.dp))
    }
}

@Composable
private fun TextField(label: String, value: String, onChange: (String) -> Unit) {
    Text(label, color = C.textLow, fontSize = 12.sp)
    Spacer(Modifier.height(6.dp))
    OutlinedTextField(
        value = value, onValueChange = onChange,
        modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = C.cyan, unfocusedBorderColor = C.stroke,
            focusedTextColor = C.text, unfocusedTextColor = C.text,
            cursorColor = C.cyan
        ),
        singleLine = true
    )
}

@Composable
private fun NumField(label: String, value: Long, onChange: (Long) -> Unit) {
    var text by remember(value) { mutableStateOf(value.toString()) }
    Text(label, color = C.textLow, fontSize = 12.sp)
    Spacer(Modifier.height(6.dp))
    OutlinedTextField(
        value = text, onValueChange = { s ->
            text = s.filter { it.isDigit() }.take(4)
            text.toLongOrNull()?.let { if (it > 0) onChange(it) }
        },
        modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = C.cyan, unfocusedBorderColor = C.stroke,
            focusedTextColor = C.text, unfocusedTextColor = C.text, cursorColor = C.cyan
        ),
        singleLine = true
    )
    Spacer(Modifier.height(10.dp))
}

@Composable
private fun DateRow(current: String, onChange: (String) -> Unit) {
    val cal = java.util.Calendar.getInstance()
    var y by remember { mutableStateOf(current.takeIf { it.isNotBlank() }?.take(4)?.toIntOrNull() ?: cal.get(java.util.Calendar.YEAR)) }
    var m by remember { mutableStateOf(current.takeIf { it.isNotBlank() }?.let { it.substring(5, 7).toIntOrNull() } ?: (cal.get(java.util.Calendar.MONTH) + 1)) }
    var d by remember { mutableStateOf(current.takeIf { it.isNotBlank() }?.takeLast(2)?.toIntOrNull() ?: cal.get(java.util.Calendar.DAY_OF_MONTH)) }
    val dim = java.time.YearMonth.of(y.coerceIn(1900, 2200), m.coerceIn(1, 12)).lengthOfMonth()

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        DropdownCell("$y 年") { menu ->
            (cal.get(java.util.Calendar.YEAR)..cal.get(java.util.Calendar.YEAR) + 30).forEach { yy ->
                DropdownMenuItem(text = { Text("$yy 年", color = C.text) }, onClick = { y = yy; onChange("%04d-%02d-%02d".format(y, m, d)); menu() })
            }
        }
        DropdownCell("$m 月") { menu ->
            (1..12).forEach { mm -> DropdownMenuItem(text = { Text("$mm 月", color = C.text) }, onClick = { m = mm; onChange("%04d-%02d-%02d".format(y, m, d)); menu() }) }
        }
        DropdownCell("$d 日") { menu ->
            (1..dim).forEach { dd -> DropdownMenuItem(text = { Text("$dd 日", color = C.text) }, onClick = { d = dd; onChange("%04d-%02d-%02d".format(y, m, d)); menu() }) }
        }
    }
}

@Composable
private fun DropdownCell(text: String, content: @Composable (() -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(C.card)
            .clickable { open = true }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text, color = C.text, fontSize = 13.sp)
        Icon(Icons.Filled.ExpandMore, null, tint = C.textLow, modifier = Modifier.size(16.dp))
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            content { open = false }
        }
    }
}
