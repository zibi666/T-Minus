package com.timemark.app.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

// 列名刻意与 §4 服务端一致（snake_case），实体同时作为同步行 DTO（@Serializable）

@Serializable
@Entity(tableName = "timer_item")
data class TimerItemEntity(
    @PrimaryKey val id: String,
    val user_id: String? = null,
    val name: String = "",
    val type: String = "PRECISE_COUNTDOWN",
    val color: String? = null,
    val starred: Boolean = false,
    val pinned: Boolean = false,
    val remark: String? = null,
    val config_json: String? = null,
    val run_state: String = "idle",
    val session_id: String? = null,
    val run_json: String? = null,
    val version: Long = 1,
    val updated_at: Long = 0,
    val deleted: Boolean = false,
    val origin_device_id: String? = null
)

@Serializable
@Entity(tableName = "tag")
data class TagEntity(
    @PrimaryKey val id: String,
    val user_id: String? = null,
    val name: String = "",
    val color: String? = null,
    val version: Long = 1,
    val updated_at: Long = 0,
    val deleted: Boolean = false,
    val origin_device_id: String? = null
)

@Serializable
@Entity(tableName = "timer_tag")
data class TimerTagEntity(
    @PrimaryKey val id: String,
    val user_id: String? = null,
    val timer_id: String = "",
    val tag_id: String = "",
    val version: Long = 1,
    val updated_at: Long = 0,
    val deleted: Boolean = false,
    val origin_device_id: String? = null
)

@Serializable
@Entity(tableName = "milestone")
data class MilestoneEntity(
    @PrimaryKey val id: String,
    val user_id: String? = null,
    val timer_id: String = "",
    val note: String = "",
    val marked_at: Long = 0,
    val version: Long = 1,
    val updated_at: Long = 0,
    val deleted: Boolean = false,
    val origin_device_id: String? = null
)

@Serializable
@Entity(tableName = "timer_record")
data class TimerRecordEntity(
    @PrimaryKey val id: String,
    val user_id: String? = null,
    val timer_id: String = "",
    val session_id: String? = null,
    val started_at: Long = 0,
    val ended_at: Long = 0,
    val duration_sec: Long = 0,
    val record_type: String = "SEGMENT",
    val version: Long = 1,
    val updated_at: Long = 0,
    val deleted: Boolean = false,
    val origin_device_id: String? = null
)

// ---- 仅本地表（§4.5）----

@Serializable
@Entity(tableName = "pending_ops")
data class PendingOpEntity(
    @PrimaryKey val operation_id: String,
    val table_name: String,
    val op_type: String,
    val row_id: String,
    val row_payload: String,
    val base_version: Long? = null,
    val is_run: Boolean = false,
    val created_at: Long = 0,
    val state: String = "queued"
)

@Dao
interface TimerDao {
    @Query("SELECT * FROM timer_item WHERE deleted = 0 ORDER BY pinned DESC, starred DESC, updated_at DESC")
    fun observeLive(): Flow<List<TimerItemEntity>>

    @Query("SELECT * FROM timer_item WHERE id = :id")
    suspend fun byId(id: String): TimerItemEntity?

    @Query("SELECT * FROM timer_item WHERE run_state = 'running'")
    suspend fun runningAll(): List<TimerItemEntity>

    @Query("SELECT * FROM timer_item")
    suspend fun allRaw(): List<TimerItemEntity>

    @Upsert suspend fun upsert(t: TimerItemEntity)

    @Query("UPDATE timer_item SET user_id = :uid WHERE user_id IS NULL")
    suspend fun adoptOrphans(uid: String)
}

@Dao
interface RecordDao {
    @Query("SELECT * FROM timer_record WHERE deleted = 0 ORDER BY ended_at DESC")
    fun observeAll(): Flow<List<TimerRecordEntity>>

    @Query("SELECT * FROM timer_record WHERE id = :id")
    suspend fun byId(id: String): TimerRecordEntity?

    @Query("SELECT * FROM timer_record")
    suspend fun allRaw(): List<TimerRecordEntity>

    @Upsert suspend fun upsert(t: TimerRecordEntity)

    @Query("SELECT * FROM timer_record WHERE timer_id = :timerId AND deleted = 0 AND ended_at >= :since ORDER BY ended_at DESC")
    suspend fun ofTimerSince(timerId: String, since: Long): List<TimerRecordEntity>

    @Query("UPDATE timer_record SET user_id = :uid WHERE user_id IS NULL")
    suspend fun adoptOrphans(uid: String)
}

@Dao
interface MiscDao {
    @Upsert suspend fun upsertTag(t: TagEntity)
    @Upsert suspend fun upsertTimerTag(t: TimerTagEntity)
    @Upsert suspend fun upsertMilestone(t: MilestoneEntity)
    @Query("UPDATE tag SET user_id = :uid WHERE user_id IS NULL") suspend fun adoptTags(uid: String)
    @Query("UPDATE timer_tag SET user_id = :uid WHERE user_id IS NULL") suspend fun adoptTimerTags(uid: String)
    @Query("UPDATE milestone SET user_id = :uid WHERE user_id IS NULL") suspend fun adoptMilestones(uid: String)
}

@Dao
interface PendingOpDao {
    @Upsert suspend fun enqueue(op: PendingOpEntity)

    @Query("SELECT * FROM pending_ops WHERE state = 'queued' ORDER BY created_at LIMIT :limit")
    suspend fun queued(limit: Int): List<PendingOpEntity>

    @Query("DELETE FROM pending_ops WHERE operation_id = :opId")
    suspend fun deleteById(opId: String)

    @Query("SELECT COUNT(*) FROM pending_ops WHERE table_name = :table AND row_id = :rowId AND state = 'queued'")
    suspend fun dirtyCount(table: String, rowId: String): Int

    @Query("SELECT COUNT(*) FROM pending_ops WHERE state = 'queued'")
    fun observeQueuedCount(): Flow<Int>
}
