package com.dalab.internet.notifications

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Tiny compose-observable flag set the instant a support-request push
 * notification is tapped -- read from two places that can each be the one
 * actually running when the tap happens:
 *
 *  - MainActivity.onCreate(), for a cold start (app wasn't running at all,
 *    the notification tap itself launched it).
 *  - MainActivity.onNewIntent(), for a warm start (app already running,
 *    e.g. the agent was on YouTube/TikTok or had this app backgrounded --
 *    android:launchMode="singleTop" on MainActivity is what routes the tap
 *    back into onNewIntent instead of spawning a second activity instance).
 *
 * AgentApp()'s top-level composable observes [pending] and, once true,
 * navigates straight to Screen.SUPPORT -- which then shows whichever
 * conversation is actually assigned to this agent (there can only ever be
 * one at a time, see support.routes.ts), so no conversationId needs to be
 * threaded through at all.
 */
object SupportDeepLink {
    var pending by mutableStateOf(false)
}
