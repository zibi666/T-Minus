package com.timemark.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.timemark.app.data.AppContainer

@Composable
fun AppNav(c: AppContainer) {
    val nav = rememberNavController()
    val back by nav.currentBackStackEntryAsState()

    NavHost(navController = nav, startDestination = "list") {
        composable("list") {
            ListScreen(
                c,
                openDetail = { nav.navigate("detail/$it") },
                openForm = { nav.navigate("form") },
                openHistory = { nav.navigate("history") },
                openLogin = { nav.navigate("login") }
            )
        }
        composable("detail/{id}") { entry ->
            val id = entry.arguments?.getString("id") ?: ""
            DetailScreen(c, id, onBack = { nav.popBackStack() }, onEdit = { nav.navigate("form/$id") })
        }
        composable("form") { FormScreen(c, null, onBack = { nav.popBackStack() }) }
        composable("form/{id}") { entry ->
            FormScreen(c, entry.arguments?.getString("id"), onBack = { nav.popBackStack() })
        }
        composable("history") { HistoryScreen(c, onBack = { nav.popBackStack() }) }
        composable("login") { LoginScreen(c, onBack = { nav.popBackStack() }) }
    }
}
