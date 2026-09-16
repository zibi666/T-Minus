package com.timemark.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import com.timemark.app.data.AppContainer
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(c: AppContainer, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val loggedIn by c.auth.loggedIn.collectAsState(initial = false)
    val username by c.auth.username.collectAsState(initial = null)
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(C.bg).padding(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = C.text,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { onBack() }.padding(6.dp))
            Spacer(Modifier.width(8.dp))
            Text("同步账号", color = C.text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(24.dp))

        if (loggedIn) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.Person, null, tint = C.cyan)
                Spacer(Modifier.width(10.dp))
                Text(username ?: "", color = C.text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.height(10.dp))
            Text("已登录 · 数据将自动同步到服务器（每 4 秒节拍）", color = C.textLow, fontSize = 12.sp)
            Spacer(Modifier.height(24.dp))
            Box(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(C.danger.copy(alpha = 0.15f))
                    .clickable { scope.launch { c.sync.logout() } }.padding(vertical = 13.dp),
                contentAlignment = Alignment.Center
            ) { Text("退出登录", color = C.danger, fontWeight = FontWeight.Bold) }
        } else {
            AuthField("用户名", user) { user = it }
            Spacer(Modifier.height(12.dp))
            AuthField("密码", pass, isPassword = true) { pass = it }
            Spacer(Modifier.height(16.dp))
            message?.let { Text(it, color = if (it.startsWith("失败")) C.danger else C.mint, fontSize = 12.sp); Spacer(Modifier.height(10.dp)) }
            Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp)) {
                Box(
                    Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).background(C.cyan)
                        .clickable(enabled = !busy) {
                            busy = true; scope.launch {
                                val ok = c.sync.register(user.trim(), pass)
                                message = if (ok) "注册成功，已登录" else "失败：" + (c.sync.lastError ?: "请检查网络")
                                busy = false
                            }
                        }
                        .padding(vertical = 13.dp),
                    contentAlignment = Alignment.Center
                ) { Text("注册", color = Color(0xFF05060F), fontWeight = FontWeight.Bold) }
                Box(
                    Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).background(C.violet.copy(alpha = 0.9f))
                        .clickable(enabled = !busy) {
                            busy = true; scope.launch {
                                val ok = c.sync.login(user.trim(), pass)
                                message = if (ok) "登录成功，开始同步" else "失败：" + (c.sync.lastError ?: "请检查网络")
                                busy = false
                            }
                        }
                        .padding(vertical = 13.dp),
                    contentAlignment = Alignment.Center
                ) { Text("登录", color = Color(0xFF05060F), fontWeight = FontWeight.Bold) }
            }
            Spacer(Modifier.height(14.dp))
            Text("注册即创建同步账号；两端同账号数据自动互通。", color = C.textLow, fontSize = 11.sp)
        }
    }
}

@Composable
private fun AuthField(label: String, value: String, isPassword: Boolean = false, onChange: (String) -> Unit) {
    Text(label, color = C.textLow, fontSize = 12.sp)
    Spacer(Modifier.height(6.dp))
    OutlinedTextField(
        value = value, onValueChange = onChange,
        modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = C.cyan, unfocusedBorderColor = C.stroke,
            focusedTextColor = C.text, unfocusedTextColor = C.text, cursorColor = C.cyan
        ),
        visualTransformation = if (isPassword) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        singleLine = true
    )
}
