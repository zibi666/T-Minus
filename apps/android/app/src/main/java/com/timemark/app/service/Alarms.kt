package com.timemark.app.service

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.timemark.app.core.Jsons
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import kotlinx.coroutines.launch

/** §7：精确闹钟运行时检测 → 授权走 setExactAndAllowWhileIdle；拒绝走 inexact 降级（必做项） */
class AlarmController(private val context: Context, private val container: () -> AppContainer) {

    companion object {
        const val CHANNEL_RUNNING = "timer_running"
        const val CHANNEL_ALARM = "timer_alarm"
        const val REQUEST_CODE = 4001
    }

    fun createChannels() {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL_RUNNING, "运行中计时", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ALARM, "计时到点提醒", NotificationManager.IMPORTANCE_HIGH))
    }

    fun exactAllowed(): Boolean {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return if (Build.VERSION.SDK_INT >= 31) am.canScheduleExactAlarms() else true
    }

    private suspend fun earliestTarget(): Long? {
        var min: Long? = null
        for (t in container().db.timerDao().runningAll()) {
            val run = Jsons.runJson(t.run_json)
            val due = when (t.type) {
                Types.PRECISE -> run.target_at
                Types.POMODORO -> run.phase_ends_at
                else -> null
            }
            if (due != null && due > System.currentTimeMillis()) min = minOf(min ?: Long.MAX_VALUE, due)
        }
        return min
    }

    /** 对最早到点的 running 计时器排一个闹钟（每次重排覆盖前一个） */
    suspend fun scheduleNext() {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val earliest = earliestTarget() ?: return
        if (earliest <= System.currentTimeMillis()) return
        val intent = Intent(context, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_DUE)
        val pi = PendingIntent.getBroadcast(context, REQUEST_CODE, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        if (exactAllowed()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, earliest, pi)
        } else {
            // 降级：非精确；前台服务内的 1s 自检循环兜底
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, earliest, pi)
        }
    }
}

class AlarmReceiver : BroadcastReceiver() {
    companion object { const val ACTION_DUE = "com.timemark.app.ACTION_TIMER_DUE" }

    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val app = context.applicationContext as com.timemark.app.TimeMarkApp
        app.appScope.launch {
            try {
                app.container.repo.settleDue()
                app.afterSettle()
            } finally {
                pending.finish()
            }
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val pending = goAsync()
        val app = context.applicationContext as com.timemark.app.TimeMarkApp
        app.appScope.launch {
            try {
                // PRECISE 的 target_at 为绝对墙钟，重启后自然衔接；仅需恢复前台服务与闹钟
                app.afterSettle()
            } finally {
                pending.finish()
            }
        }
    }
}
