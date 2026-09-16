package com.timemark.app

import android.app.Application
import android.content.Intent
import com.timemark.app.core.Types
import com.timemark.app.data.AppContainer
import com.timemark.app.service.AlarmController
import com.timemark.app.service.TimerService
import com.timemark.app.sync.SyncManager
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
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        alarms = AlarmController(this) { container }
        alarms.createChannels()
        startAppLoop()
    }

    /** 全局 1s 循环：到点结算 → 重排闹钟 → 前台服务启停 → 4s 同步节拍（指数退避） */
    private fun startAppLoop() {
        appScope.launch {
            var syncClock = 0
            var backoff = 4000L
            while (isActive) {
                try { container.repo.settleDue() } catch (e: Exception) { }
                manageService()
                syncClock += 1000
                if (syncClock >= backoff) {
                    syncClock = 0
                    val loggedIn = runCatching { container.auth.loggedIn.first() }.getOrDefault(false)
                    if (loggedIn) {
                        sync.syncNow()
                        backoff = if (sync.lastError == null) 4000L else minOf(60000L, backoff * 2)
                    } else backoff = 4000L
                }
                delay(1000)
            }
        }
    }

    private suspend fun manageService() {
        val anyRunning = runCatching {
            container.db.timerDao().runningAll().any { it.type != Types.DATE }
        }.getOrDefault(false)
        if (anyRunning && !serviceRunning) {
            serviceRunning = true
            startForegroundService(Intent(this, TimerService::class.java))
        } else if (!anyRunning && serviceRunning) {
            serviceRunning = false
            stopService(Intent(this, TimerService::class.java))
        }
    }

    /** 结算后的统一动作：重排闹钟 + 前台服务启停（供闹钟/开机广播调用） */
    fun afterSettle() {
        appScope.launch {
            try { alarms.scheduleNext() } catch (e: Exception) { }
            manageService()
        }
    }

    fun refreshService() { afterSettle() }

    companion object { var serviceRunning = false }
}
