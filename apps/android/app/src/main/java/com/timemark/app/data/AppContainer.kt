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
private val KEY_JOURNAL = stringPreferencesKey("journal_json")

const val SERVER_URL = "http://118.195.133.25:18080/"

class AuthStore(private val ds: DataStore<Preferences>) {
    val loggedIn: Flow<Boolean> = ds.data.map { !it[KEY_TOKEN].isNullOrBlank() }
    val username: Flow<String?> = ds.data.map { it[KEY_USERNAME] }
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

@kotlinx.serialization.Serializable
data class DayStat(val workCount: Int = 0, val workMs: Long = 0, val breakMs: Long = 0)

class JournalStore(private val ds: DataStore<Preferences>) {
    private val json = Json { ignoreUnknownKeys = true }

    fun observe(): Flow<Map<String, DayStat>> = ds.data.map { p ->
        val raw = p[KEY_JOURNAL] ?: return@map emptyMap()
        try { json.decodeFromString<Map<String, DayStat>>(raw) } catch (e: Exception) { emptyMap() }
    }

    suspend fun add(day: String, workCount: Int, workMs: Long, breakMs: Long) {
        ds.edit { p ->
            val cur = p[KEY_JOURNAL]?.let { runCatching { json.decodeFromString<Map<String, DayStat>>(it) }.getOrNull() } ?: emptyMap()
            val old = cur[day] ?: DayStat()
            val next = cur + (day to DayStat(old.workCount + workCount, old.workMs + workMs, old.breakMs + breakMs))
            p[KEY_JOURNAL] = json.encodeToString(next)
        }
    }
}

class AppContainer(context: Context) {
    val appContext = context.applicationContext
    val json = Jsons.json
    val db = AppDatabase.build(appContext)
    val ds = appContext.dataStore
    val auth = AuthStore(ds)
    val journal = JournalStore(ds)

    val api: TimeMarkApi = Retrofit.Builder()
        .baseUrl(SERVER_URL)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()
        .create(TimeMarkApi::class.java)

    suspend fun deviceId(): String = auth.deviceId()
    suspend fun pullCursor(): Long = ds.data.first()[KEY_CURSOR] ?: 0L
    suspend fun setPullCursor(v: Long) { ds.edit { it[KEY_CURSOR] = v } }

    val repo = TimerRepository(db, auth, journal)
    val sync by lazy { SyncManager(this) }
}
