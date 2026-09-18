package com.timemark.app.service

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.timemark.app.R
import com.timemark.app.core.Contract
import com.timemark.app.core.Engine
import com.timemark.app.core.Fmt
import com.timemark.app.core.Jsons
import com.timemark.app.core.Types
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** 运行中计时的常驻通知（低优先级通道）+ 秒级到点结算。
 *  服务存活期间是「有计时在跑」的唯一时段，因此这里是精度最高的节拍；
 *  Application 侧的空闲循环节流到秒级以上，省电。 */
class TimerService : Service() {
    private val handler = CoroutineExceptionHandler { _, e ->
        android.util.Log.e("TimerService", "未捕获异常", e)
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + handler)
    private var loopJob: Job? = null

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        com.timemark.app.TimeMarkApp.serviceRunning = true // 生命周期同步：服务真实启动
        try {
            startAsForeground()
        } catch (e: Exception) {
            // 通知被系统/用户禁用等：停掉自己，避免卡在非前台状态被系统强杀
            android.util.Log.w("TimerService", "startForeground 失败，停止服务", e)
            stopSelf()
            return START_NOT_STICKY
        }
        // 防多协程泄漏：取消上一个循环再启新循环（START_STICKY 重启 / 重复 startForegroundService 场景）
        loopJob?.cancel()
        loopJob = scope.launch {
            var sinceAlarm = 0L
            while (isActive) {
                settleAndNotify()
                updateText()
                delay(1000)
                sinceAlarm += 1000
                if (sinceAlarm >= 5000) {
                    sinceAlarm = 0
                    val app = application as com.timemark.app.TimeMarkApp
                    try { app.alarms.scheduleNext() } catch (e: Exception) { android.util.Log.w("TimerService", "闹钟重排失败", e) }
                }
            }
        }
        return START_STICKY
    }

    /** 到点结算 + 提醒（多计时同时到点逐条提醒），与 Application 循环共用同一套幂等结算 */
    private suspend fun settleAndNotify() {
        val app = application as com.timemark.app.TimeMarkApp
        val settled = try {
            app.container.repo.settleDue()
        } catch (e: Exception) {
            android.util.Log.w("TimerService", "settle failed", e); return
        }
        for (s in settled) {
            if (s.kind == Types.RECORD_POMODORO_FOCUS || s.kind == Types.RECORD_POMODORO_BREAK) {
                Notifier.pomodoroPhase(this, s.timer.name, s.phase)
            } else if (s.timer.type != Types.STOPWATCH) {
                Notifier.timerFinished(this, s.timer.name)
            }
        }
    }

    override fun onDestroy() {
        com.timemark.app.TimeMarkApp.serviceRunning = false // 生命周期同步：服务真实销毁
        loopJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun startAsForeground() {
        val n = NotificationCompat.Builder(this, AlarmController.CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_notification)
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
        val now = System.currentTimeMillis()
        val running = app.container.db.timerDao().runningAll().filter { it.type != Types.DATE }
        if (running.isEmpty()) return
        // 多计时器：首条做标题，其余汇总到内容行（最多展示 3 条避免通知过长）
        val lines = mutableListOf<String>()
        for (t in running.take(3)) {
            val s = Engine.live(t.type, t.run_state, t.run_json, t.config_json, now)
            val isPomo = Contract.isPomodoro(t.type, Jsons.configJson(t.config_json))
            val text = when {
                isPomo -> {
                    val phaseLabel = when (s.phase) {
                        Contract.PHASE_FOCUS -> "专注"
                        Contract.PHASE_LONG_BREAK -> "长休息"
                        else -> "休息"
                    }
                    "$phaseLabel " + Fmt.hms(s.remainingMs)
                }
                t.type == Types.PRECISE -> "剩余 " + Fmt.hms(s.remainingMs)
                t.type == Types.STOPWATCH -> "已进行 " + Fmt.hms(s.elapsedMs)
                else -> continue
            }
            lines.add("${t.name} · $text")
        }
        if (lines.isEmpty()) return
        val title = if (running.size == 1) running[0].name else "TimeMark · ${running.size} 个计时中"
        val content = lines.joinToString("\n")
        val builder = NotificationCompat.Builder(this, AlarmController.CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setOngoing(true)
        if (running.size == 1) {
            builder.setContentText(content)
        } else {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(content))
        }
        try { nm.notify(1001, builder.build()) } catch (e: Exception) { /* 通道被关闭 */ }
    }
}
