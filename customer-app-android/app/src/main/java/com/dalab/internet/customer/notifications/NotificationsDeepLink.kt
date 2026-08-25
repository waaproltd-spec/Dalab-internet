package com.dalab.internet.customer.notifications

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Tiny compose-observable flag set the instant an order/exchange status push
 * notification is tapped -- read from two places that can each be the one
 * actually running when the tap happens:
 *
 *  - MainActivity.onCreate(), for a cold start (app wasn't running at all,
 *    the notification tap itself launched it).
 *  - MainActivity.onNewIntent(), for a warm start (app already running --
 *    android:launchMode="singleTop" on MainActivity is what routes the tap
 *    back into onNewIntent instead of spawning a second activity instance).
 *
 * CustomerApp()'s top-level composable observes [pending] and navigates to
 * Screen.HOME if needed; CustomerHome() then observes it too and opens the
 * Notifications screen -- same two-step pattern as agent-app's
 * SupportDeepLink, adapted for this app's nested (bottom-nav + overlay)
 * screen structure.
 */
object NotificationsDeepLink {
    var pending by mutableStateOf(false)
}
