package com.timemark.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.timemark.app.core.Types

fun typeLabel(type: String): String = Types.TYPE_LABEL[type] ?: type

fun colorFor(color: String?): Color {
    if (color.isNullOrBlank()) return C.cyan
    return try {
        if (color.startsWith("#")) Color(android.graphics.Color.parseColor(color)) else C.cyan
    } catch (e: Exception) { C.cyan }
}

@Composable
fun ColorDot(color: String?, size: Int = 12) {
    Box(
        Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(colorFor(color))
    )
}

@Composable
fun TypeBadge(type: String) {
    Text(
        typeLabel(type),
        modifier = Modifier
            .clip(RoundedCornerShape(999))
            .background(C.stroke)
            .padding(horizontal = 8.dp, vertical = 2.dp),
        color = C.textLow, fontSize = 10.5.sp
    )
}

@Composable
fun StatBlock(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, color = C.text, fontSize = 17.sp, fontWeight = FontWeight.Bold)
        Text(label, color = C.textLow, fontSize = 11.sp)
    }
}

@Composable
fun Chip(text: String, active: Boolean, onClick: () -> Unit) {
    Text(
        text,
        modifier = Modifier
            .clip(RoundedCornerShape(999))
            .background(if (active) C.cyan.copy(alpha = 0.18f) else C.stroke)
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 6.dp),
        color = if (active) C.cyan else C.textLow,
        fontSize = 12.sp
    )
}

@Composable
fun ActionButton(text: String, tint: Color, onClick: () -> Unit) {
    Text(
        text,
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(tint.copy(alpha = 0.14f))
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 7.dp),
        color = tint, fontSize = 12.5.sp, fontWeight = FontWeight.Medium
    )
}

@Composable
fun ScreenTitle(title: String, subtitle: String? = null) {
    Column {
        Text(title, color = C.text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        if (subtitle != null) Text(subtitle, color = C.textLow, fontSize = 12.sp)
    }
}

@Composable
fun EmptyHint(text: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 40.dp), contentAlignment = Alignment.Center) {
        Text(text, color = C.textLow, fontSize = 13.sp)
    }
}

@Suppress("unused")
@Composable
fun ThemePreview() {
    MaterialTheme { Column { Row { } } }
}
