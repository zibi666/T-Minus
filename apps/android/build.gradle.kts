plugins {
    id("com.android.application") version "8.7.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.20" apply false
    id("com.google.devtools.ksp") version "2.0.20-1.0.25" apply false
}

/** 版本号唯一来源：仓库根 VERSION（Android versionName / Windows package.json / latest.json 三处同步） */
val versionFile = rootProject.file("../VERSION")
extra["appVersion"] = if (versionFile.exists()) versionFile.readText().trim() else "0.0.0"
