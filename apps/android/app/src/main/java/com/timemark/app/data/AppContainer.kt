package com.timemark.app.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.timemark.app.core.Jsons
import com.timemark.app.sync.SyncManager
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import okhttp3.MediaType.Companion.toMediaType
import java.util.UUID

val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "timemark_prefs")

private val KEY_TOKEN = stringPreferencesKey("auth_token")
private val KEY_UID = stringPreferencesKey("auth_uid")
private val KEY_USERNAME = stringPreferencesKey("auth_username")
private val KEY_DEVICE_ID = stringPreferencesKey("device_id")
private val KEY_CURSOR = longPreferencesKey("pull_cursor")
private val KEY_SYNC_UID = stringPreferencesKey("sync_uid")

// 同步服务地址：域名 sync.knowhub.chat → Cloudflare DNS 解析到 118.195.133.25
// nginx 监听 18443/TCP + Let's Encrypt 证书（DNS-01 验证，公信 CA，客户端无需携带任何证书）
// 18443 是非标端口，不受腾讯云未备案域名拦截影响
// 部署/续证步骤见 deploy/TLS-CUTOVER.md
const val SERVER_URL = "https://sync.knowhub.chat:18443/"

class AuthStore(private val ds: DataStore<Preferences>) {
    val loggedIn: Flow<Boolean> = ds.data.map { !it[KEY_TOKEN].isNullOrBlank() }
    val username: Flow<String?> = ds.data.map { it[KEY_USERNAME] }
    val uidFlow: Flow<String?> = ds.data.map { it[KEY_UID] }
    suspend fun token(): String? = ds.data.first()[KEY_TOKEN]
    suspend fun uid(): String? = ds.data.first()[KEY_UID]
    suspend fun deviceId(): String {
        ds.data.first()[KEY_DEVICE_ID]?.let { return it }
        val id = UUID.randomUUID().toString()
        ds.edit { it[KEY_DEVICE_ID] = id }
        return id
    }
    suspend fun save(token: String, uid: String, username: String) {
        ds.edit { it[KEY_TOKEN] = token; it[KEY_UID] = uid; it[KEY_USERNAME] = username }
    }
    suspend fun clear() { ds.edit { it.remove(KEY_TOKEN); it.remove(KEY_UID); it.remove(KEY_USERNAME) } }
}

class AppContainer(context: Context) {
    val appContext = context.applicationContext
    val json = Jsons.json
    val db = AppDatabase.build(appContext)
    val ds = appContext.dataStore
    val auth = AuthStore(ds)

    val api: TimeMarkApi = Retrofit.Builder()
        .baseUrl(SERVER_URL)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(TimeMarkApi::class.java)

    suspend fun deviceId(): String = auth.deviceId()
    suspend fun pullCursor(): Long = ds.data.first()[KEY_CURSOR] ?: 0L
    suspend fun setPullCursor(v: Long) { ds.edit { it[KEY_CURSOR] = v } }
    /** 最近一次登录的账号 id：登录时据此判定「换账号」，决定是否清游标与待传队列 */
    suspend fun syncUid(): String? = ds.data.first()[KEY_SYNC_UID]
    suspend fun setSyncUid(v: String) { ds.edit { it[KEY_SYNC_UID] = v } }
    suspend fun clearSyncUid() { ds.edit { it.remove(KEY_SYNC_UID) } }

    val repo = TimerRepository(db, auth)
    val sync by lazy { SyncManager(this) }
}
