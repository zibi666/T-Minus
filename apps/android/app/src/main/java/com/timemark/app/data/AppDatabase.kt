package com.timemark.app.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        TimerItemEntity::class, TagEntity::class, TimerTagEntity::class,
        MilestoneEntity::class, TimerRecordEntity::class, PendingOpEntity::class
    ],
    version = 2,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun timerDao(): TimerDao
    abstract fun recordDao(): RecordDao
    abstract fun miscDao(): MiscDao
    abstract fun pendingOpDao(): PendingOpDao

    companion object {
        /** v1→v2：番茄钟 type 由独立 "POMODORO" 统一为 "PRECISE_COUNTDOWN"（与 Windows 对齐，
         *  通过 config_json 内 pomodoro 嵌套对象判定番茄钟）。旧 config_json 的 focus_ms 等字段
         *  仍能被 ConfigJson 读取兼容，无需重写 JSON。 */
        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("UPDATE timer_item SET type = 'PRECISE_COUNTDOWN' WHERE type = 'POMODORO'")
            }
        }

        fun build(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "timemark.db")
                .addMigrations(MIGRATION_1_2)
                .build()
    }
}
