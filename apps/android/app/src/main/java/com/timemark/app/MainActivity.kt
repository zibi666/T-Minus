package com.timemark.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import com.timemark.app.ui.AppNav
import com.timemark.app.ui.AppTheme

class MainActivity : ComponentActivity() {
    /** 权限注册器提为属性：必须在 Activity 初始化时无条件注册（STARTED 前），
     *  避免每次 onCreate 重建 launcher + 配置变更后重复弹窗。 */
    private val notifPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requestNotificationPermission()
        setContent { AppTheme { AppNav((application as TimeMarkApp).container) } }
    }

    private fun requestNotificationPermission() {
        // 仅 Android 13+ 需要运行时申请；已授权则不弹（checkSelfPermission 防御重复弹窗）
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            val granted = checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
            if (!granted) notifPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}
