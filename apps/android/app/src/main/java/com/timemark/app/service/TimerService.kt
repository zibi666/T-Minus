package com.timemark.app.service

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.timemark.app.R
import com.timemark.app.core.Engine
import com.timemark.app.core.Fmt
import com.timemark.app.core.Types
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** 运行中计时的常驻通知（低优先级通道）；存在运行中计时器时由 App 循环拉起 */
class TimerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        scope.launch {
            while (isActive) {
                updateText()
                delay(1000)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun startAsForeground() {
        val n = NotificationCompat.Builder(this, AlarmController.CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("TimeMark")
            .setContentText("计时进行中")
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
        startForeground(1001, n)
    }

    private suspend fun updateText() {
        val app = application as com.timemark.app.TimeMarkApp
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        var best: Pair<String, String>? = null
        val now = System.currentTimeMillis()
        for (t in app.container.db.timerDao().runningAll()) {
            val s = Engine.live(t.type, t.run_state, t.run_json, t.config_json, now)
            val text = when (t.type) {
                Types.PRECISE -> "剩余 " + Fmt.hms(s.remainingMs)
                Types.STOPWATCH -> "已进行 " + Fmt.hms(s.elapsedMs)
                Types.POMODORO -> (if (s.phase == "focus") "专注" else "休息") + " " + Fmt.hms(s.remainingMs)
                else -> ""
            }
            if (text.isNotEmpty()) { best = t.name to text; break }
        }
        val pair = best ?: return
        val (name, text) = pair
        val n = NotificationCompat.Builder(this, AlarmController.CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(name)
            .setContentText(text)
            .setOngoing(true)
            .build()
        try { nm.notify(1001, n) } catch (e: Exception) { }
    }
}
