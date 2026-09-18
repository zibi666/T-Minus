package com.timemark.app.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.timemark.app.MainActivity
import com.timemark.app.R
import com.timemark.app.core.Contract

/**
 * 到点/阶段切换/D-Day 的高优先级提醒（CHANNEL_ALARM）。
 * 此前该通道只被创建、从未发出通知 —— 倒计时归零后用户得不到任何提示。
 */
object Notifier {

    private var nextId = 2001

    private fun openIntent(context: Context): PendingIntent {
        val i = Intent(context, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun post(context: Context, title: String, body: String, vibrate: Boolean) {
        val b = NotificationCompat.Builder(context, AlarmController.CHANNEL_ALARM)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(openIntent(context))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_ALARM)
        if (vibrate) b.setDefaults(Notification.DEFAULT_VIBRATE)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        try { nm.notify(nextId++, b.build()) } catch (e: Exception) { /* 通知通道被系统关闭等 */ }
    }

    /** 精确倒计时到点 */
    fun timerFinished(context: Context, name: String) =
        post(context, "TimeMark 时光标", "「$name」倒计时已到点", vibrate = true)

    /** 番茄钟阶段推进：进入 focus 表示休息结束 */
    fun pomodoroPhase(context: Context, name: String, nextPhase: String?) {
        val label = when (nextPhase) {
            Contract.PHASE_FOCUS -> "休息结束，开始专注"
            Contract.PHASE_LONG_BREAK -> "专注完成，进入长休息"
            else -> "专注完成，开始休息"
        }
        post(context, "TimeMark 时光标", "「$name」$label", vibrate = true)
    }

    /** 日期倒计时进入目标日 */
    fun dDay(context: Context, name: String) =
        post(context, "TimeMark 时光标", "「$name」就是今天！", vibrate = false)
}
