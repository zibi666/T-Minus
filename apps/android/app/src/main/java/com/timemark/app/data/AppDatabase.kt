package com.timemark.app.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        TimerItemEntity::class, TagEntity::class, TimerTagEntity::class,
        MilestoneEntity::class, TimerRecordEntity::class, PendingOpEntity::class
    ],
    version = 1,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun timerDao(): TimerDao
    abstract fun recordDao(): RecordDao
    abstract fun miscDao(): MiscDao
    abstract fun pendingOpDao(): PendingOpDao

    companion object {
        fun build(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "timemark.db").build()
    }
}
