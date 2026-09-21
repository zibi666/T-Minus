package com.timemark.app.service

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import com.timemark.app.core.Engine
import com.timemark.app.core.Jsons
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import com.timemark.app.data.TimerItemEntity
import kotlinx.coroutines.launch
import java.time.ZoneId

/** §7：精确闹钟运行时检测 → 授权走 setExactAndAllowWhileIdle；拒绝走 inexact 降级（必做项） */
class AlarmController(private val context: Context, private val container: () -> AppContainer) {

    companion object {
        const val CHANNEL_RUNNING = "timer_running"
        const val CHANNEL_ALARM = "timer_alarm"
        const val REQUEST_CODE = 4001
        /** 自续期兜底闹钟：与到点闹钟错开 request code，否则两者会互相覆盖 */
        const val WATCHDOG_REQUEST_CODE = 4002
        const val EXTRA_KIND = "kind"
        const val EXTRA_TIMER_ID = "timer_id"
        const val KIND_SETTLE = "settle"   // 倒计时/番茄钟到点
        const val KIND_DDAY = "dday"       // 日期倒计时进入目标日
        const val KIND_REARM = "rearm"     // 兜底唤醒：只重排提醒链，不对应任何具体计时
        /** 兜底唤醒间隔：进程在「到点」与 afterSettle() 之间被杀、或只有 DATE（无前台服务）时
         *  被杀后不再启动，都会让整条提醒链断掉。15 分钟是「通知不迟到太久」与耗电的折中。 */
        const val WATCHDOG_INTERVAL_MS = 15L * 60L * 1000L
    }

    fun createChannels() {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL_RUNNING, "运行中计时", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALARM, "计时到点提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                enableVibration(true)
            }
        )
    }

    fun exactAllowed(): Boolean {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return if (Build.VERSION.SDK_INT >= 31) am.canScheduleExactAlarms() else true
    }

    /** 单个计时的下一次到点时刻（绝对墙钟）；无则 null。
     *  番茄钟（PRECISE + pomodoro 配置）用 phase_ends_at，普通 PRECISE 用 target_at，
     *  DATE 用「daysLeft 归零那天」的 00:00（按目标时区）—— 三类都要提醒，此前 DATE 被漏掉。 */
    private fun dueAt(t: TimerItemEntity, now: Long): Long? {
        val run = Jsons.runJson(t.run_json)
        val cfg = Jsons.configJson(t.config_json)
        return when {
            t.type == Types.PRECISE && cfg.isPomodoro() -> run.phase_ends_at
            t.type == Types.PRECISE -> run.target_at
            t.type == Types.DATE -> {
                val date = cfg.target_date ?: return null
                val zone = try { ZoneId.of(cfg.timezone_id ?: ZoneId.systemDefault().id) } catch (e: Exception) { ZoneId.systemDefault() }
                // 不能直接排目标日 00:00：include_today=true 时那天 daysLeft 仍是 1，Receiver 的
                // left<=0 判会静默跳过；此后 nextDue() 又因 due<=now 永远不再选它，D-Day 提醒就没了
                try { Engine.dDayFireDate(date, cfg.include_today)?.atStartOfDay(zone)?.toInstant()?.toEpochMilli() } catch (e: Exception) { null }
            }
            else -> null // 正计时由用户主动结束，无需闹钟
        }
    }

    /** 未来最早的一次到点：到点即提醒，过点不补（由 settle 兜底推进） */
    private suspend fun nextDue(): Pair<TimerItemEntity, Long>? {
        var best: Pair<TimerItemEntity, Long>? = null
        val now = System.currentTimeMillis()
        for (t in container().db.timerDao().allForAlarm(container().auth.uid())) {
            if (t.run_state != Types.RUNNING && t.type != Types.DATE) continue
            val due = dueAt(t, now) ?: continue
            if (due <= now) continue
            if (best == null || due < best!!.second) best = t to due
        }
        return best
    }

    /** 对最早到点的计时排一个闹钟（每次重排覆盖前一个）。
     *  同时维护兜底唤醒：只要还有未来的到点，就有一个周期性闹钟在维护这条链。 */
    suspend fun scheduleNext() {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val next = nextDue()
        if (next == null) {
            am.cancel(pendingIntent())
            cancelWatchdog() // 没有待提醒的到点了，别再周期性唤醒
            return
        }
        val (timer, due) = next
        val intent = Intent(context, AlarmReceiver::class.java)
            .setAction(AlarmReceiver.ACTION_DUE)
            .putExtra(EXTRA_KIND, if (timer.type == Types.DATE) KIND_DDAY else KIND_SETTLE)
            .putExtra(EXTRA_TIMER_ID, timer.id)
        val pi = pendingIntent(intent)
        if (exactAllowed()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, pi)
        } else {
            // 降级：非精确；前台服务内的自检循环兜底
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, due, pi)
        }
        // 到点闹钟只覆盖「未来最早一次」，它触发后要靠 afterSettle() 重排。进程若在这之间被杀
        // （或只有 DATE 时根本没有前台服务在跑进程），链就断了且不会再自愈 —— 用兜底闹钟补这个洞
        scheduleWatchdog()
    }

    /** 兜底唤醒：固定 request code + FLAG_UPDATE_CURRENT，重复排只是覆盖，不会堆积旧 PendingIntent。
     *  走 setAndAllowWhileIdle 而非 setExact：Doze 下系统本来就会把精确闹钟限制到约每 9 分钟一次，
     *  这里不需要精确权限，也不需要额外申请。 */
    fun scheduleWatchdog(intervalMs: Long = WATCHDOG_INTERVAL_MS) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val i = Intent(context, AlarmReceiver::class.java)
            .setAction(AlarmReceiver.ACTION_DUE)
            .putExtra(EXTRA_KIND, KIND_REARM)
        val pi = PendingIntent.getBroadcast(
            context, WATCHDOG_REQUEST_CODE, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + intervalMs, pi)
    }

    fun cancelWatchdog() {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val i = Intent(context, AlarmReceiver::class.java)
            .setAction(AlarmReceiver.ACTION_DUE)
            .putExtra(EXTRA_KIND, KIND_REARM)
        am.cancel(
            PendingIntent.getBroadcast(
                context, WATCHDOG_REQUEST_CODE, i,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        )
    }

    private fun pendingIntent(intent: Intent? = null): PendingIntent {
        val i = intent ?: Intent(context, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_DUE)
        return PendingIntent.getBroadcast(
            context, REQUEST_CODE, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}

class AlarmReceiver : BroadcastReceiver() {
    companion object { const val ACTION_DUE = "com.timemark.app.ACTION_TIMER_DUE" }

    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val app = context.applicationContext as com.timemark.app.TimeMarkApp
        val kind = intent.getStringExtra(AlarmController.EXTRA_KIND)
        val timerId = intent.getStringExtra(AlarmController.EXTRA_TIMER_ID)
        app.appScope.launch {
            try {
                // KIND_REARM（兜底唤醒）没有具体计时，不走 D-Day 分支，但仍要结算 + 重排：
                // 进程刚被唤醒时可能已有计时在无人值守期间到点，settleDue 幂等，不会重复提醒
                if (kind == AlarmController.KIND_DDAY && timerId != null) {
                    app.container.db.timerDao().byId(timerId)?.let {
                        val cfg = Jsons.configJson(it.config_json)
                        val left = Engine.daysLeft(cfg.target_date ?: "", cfg.timezone_id, cfg.include_today, System.currentTimeMillis())
                        if (left != null && left <= 0L) Notifier.dDay(context, it.name)
                    }
                }
                // 到点结算（含多计时同时到点），逐条提醒 —— 通知不能静默吞掉
                for (s in app.container.repo.settleDue()) {
                    if (s.timer.type == Types.STOPWATCH) continue
                    if (s.kind == Types.RECORD_POMODORO_FOCUS || s.kind == Types.RECORD_POMODORO_BREAK) {
                        Notifier.pomodoroPhase(context, s.timer.name, s.phase)
                    } else {
                        Notifier.timerFinished(context, s.timer.name)
                    }
                }
                app.afterSettle()
            } catch (e: Exception) {
                android.util.Log.w("AlarmReceiver", "settle failed", e)
            } finally {
                pending.finish()
            }
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // 开机与覆盖安装（MY_PACKAGE_REPLACED）都会打断闹钟链，两种广播同待遇：补结算 + 恢复提醒
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val pending = goAsync()
        val app = context.applicationContext as com.timemark.app.TimeMarkApp
        app.appScope.launch {
            try {
                // PRECISE 的 target_at 为绝对墙钟，重启后自然衔接；先补结算再恢复提醒链
                for (s in app.container.repo.settleDue()) {
                    if (s.kind == Types.RECORD_POMODORO_FOCUS || s.kind == Types.RECORD_POMODORO_BREAK) {
                        Notifier.pomodoroPhase(context, s.timer.name, s.phase)
                    } else if (s.timer.type != Types.STOPWATCH) {
                        Notifier.timerFinished(context, s.timer.name)
                    }
                }
                app.afterSettle()
            } catch (e: Exception) {
                android.util.Log.w("BootReceiver", "boot settle failed", e)
            } finally {
                pending.finish()
            }
        }
    }
}
