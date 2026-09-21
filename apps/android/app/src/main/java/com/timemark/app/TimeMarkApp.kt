package com.timemark.app

import android.app.Application
import android.content.Intent
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import com.timemark.app.service.AlarmController
import com.timemark.app.service.TimerService
import com.timemark.app.sync.SyncManager
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class TimeMarkApp : Application() {
    lateinit var container: AppContainer
    lateinit var alarms: AlarmController
    val sync: SyncManager get() = container.sync

    /** 无 handler 时协程内未捕获异常会直接杀进程（例如后台启动前台服务被系统拒绝）。
     *  SupervisorJob 只保证兄弟协程不连带取消，仍然需要这个兜底记录。 */
    private val handler = CoroutineExceptionHandler { _, e ->
        android.util.Log.e("TimeMarkApp", "未捕获异常", e)
    }
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default + handler)

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        alarms = AlarmController(this) { container }
        alarms.createChannels()
        startAppLoop()
    }

    /** 空闲节拍：结算 → 前台服务启停 → 重排闹钟 → 同步。
     *  有计时在跑时，秒级精度由 TimerService 自己的循环负责，这里退回低频省电。 */
    private fun startAppLoop() {
        appScope.launch {
            var sinceSyncMs = 0L
            var failures = 0
            while (isActive) {
                val running = hasRunning()
                try { container.repo.settleDue() } catch (e: Exception) { android.util.Log.w("TimeMarkApp", "settle failed", e) }
                manageService(running)
                try { alarms.scheduleNext() } catch (e: Exception) { android.util.Log.w("TimeMarkApp", "alarm schedule failed", e) }

                val beat = if (running) ACTIVE_BEAT_MS else IDLE_BEAT_MS
                sinceSyncMs += beat

                val loggedIn = runCatching { container.auth.loggedIn.first() }.getOrDefault(false)
                val pending = runCatching { container.db.pendingOpDao().queuedCount() }.getOrDefault(0)
                // 有积压操作时快推（4s）；空闲时退到 20s 拉一次；连续失败再指数退避
                val syncBeat = when {
                    failures > 0 -> minOf(MAX_BACKOFF_MS, SYNC_BEAT_MS shl minOf(failures, 5))
                    pending > 0 -> SYNC_BEAT_MS
                    else -> IDLE_SYNC_BEAT_MS
                }
                if (loggedIn && sinceSyncMs >= syncBeat) {
                    sinceSyncMs = 0
                    sync.syncNow()
                    failures = if (sync.lastError == null) 0 else failures + 1
                }
                delay(beat)
            }
        }
    }

    private suspend fun hasRunning(): Boolean = runCatching {
        container.db.timerDao().runningAll(container.auth.uid()).any { it.type != Types.DATE }
    }.getOrDefault(false)

    /** 前台服务只在「有可运行计时在跑」时存在；启停都必须包异常：
     *  Android 12+ 从后台启动前台服务会抛 ForegroundServiceStartNotAllowedException，
     *  未捕获会直接杀掉进程（本类 appScope 之外的调用点尤其危险）。
     *  启动失败后进入退避期，避免每 2~15s 无意义重试浪费电量（后台时闹钟链仍会正常触发结算）。 */
    private var fgsRetryAfterMs: Long = 0L
    private suspend fun manageService(running: Boolean) {
        val now = System.currentTimeMillis()
        try {
            if (running && !serviceRunning) {
                if (now < fgsRetryAfterMs) return // 处于退避期，本轮不重试
                startForegroundService(Intent(this, TimerService::class.java))
                fgsRetryAfterMs = 0L
            } else if (!running && serviceRunning) {
                stopService(Intent(this, TimerService::class.java))
                fgsRetryAfterMs = 0L
            }
        } catch (e: Exception) {
            android.util.Log.w("TimeMarkApp", "前台服务启停被拒", e)
            // 退避 60s 后再试：避免后台环境下每拍都抛异常刷屏日志与耗电
            fgsRetryAfterMs = now + FGS_RETRY_BACKOFF_MS
        }
    }

    /** 结算后的统一动作：重排闹钟 + 前台服务启停（供闹钟/开机广播调用） */
    fun afterSettle() {
        appScope.launch {
            try { alarms.scheduleNext() } catch (e: Exception) { android.util.Log.w("TimeMarkApp", "alarm schedule failed", e) }
            manageService(hasRunning())
        }
    }

    companion object {
        private const val ACTIVE_BEAT_MS = 2_000L
        private const val IDLE_BEAT_MS = 15_000L
        private const val SYNC_BEAT_MS = 4_000L
        private const val IDLE_SYNC_BEAT_MS = 20_000L
        private const val MAX_BACKOFF_MS = 120_000L
        /** 前台服务启动失败后的退避时长：避免后台受限时每拍都抛异常 */
        private const val FGS_RETRY_BACKOFF_MS = 60_000L

        @Volatile var serviceRunning = false
    }
}
