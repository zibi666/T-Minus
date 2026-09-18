package com.timemark.app.ui

import androidx.compose.material3.MaterialTheme
import com.timemark.app.core.Contract
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object C {
    val bg = Color(0xFF05060F)
    val card = Color(0xFF11141F)
    val cardHi = Color(0xFF171C2B)
    val stroke = Color(0xFF232A3C)
    val cyan = Color(0xFF4DC9F0)
    val violet = Color(0xFF9381FF)
    val mint = Color(0xFF21E0C4)
    val amber = Color(0xFFFFB224)
    val coral = Color(0xFFFF6B6B)
    val blue = Color(0xFF5A9EFF)
    val pink = Color(0xFFF472B6)
    val lime = Color(0xFFA3E635)
    val text = Color(0xFFE8EBF4)
    val textLow = Color(0xFF8A90A3)
    val danger = Color(0xFFFF7B72)
}

/** 计时器色板：取值与顺序的唯一来源在 core/Contract.kt（与 Windows 端逐位相同） */
val PALETTE_HEX: List<String> = Contract.TIMER_PALETTE

val PALETTE: List<Color> = PALETTE_HEX.map { Color(android.graphics.Color.parseColor(it)) }

/** 新建计时的默认色（契约同一处定义） */
val DEFAULT_TIMER_COLOR: Color = PALETTE.first()


private val DarkScheme = darkColorScheme(
    primary = C.cyan,
    secondary = C.violet,
    tertiary = C.mint,
    background = C.bg,
    surface = C.card,
    surfaceVariant = C.cardHi,
    onBackground = C.text,
    onSurface = C.text,
    onSurfaceVariant = C.textLow,
    error = C.danger
)

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkScheme, content = content)
}
