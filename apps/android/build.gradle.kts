plugins {
    id("com.android.application") version "8.7.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.20" apply false
    id("com.google.devtools.ksp") version "2.0.20-1.0.25" apply false
}

/** 版本号唯一来源：仓库根 VERSION（Android versionName / Windows package.json / latest.json 三处同步）
 *  rootProject 目录是 apps/android，所以要向上两级。缺失即失败，避免打出 0.0.0 的包。 */
val versionFile = rootProject.file("../../VERSION")
if (!versionFile.exists()) {
    throw GradleException("找不到版本文件 ${versionFile.absolutePath}（仓库根 VERSION）")
}
extra["appVersion"] = versionFile.readText().trim()
