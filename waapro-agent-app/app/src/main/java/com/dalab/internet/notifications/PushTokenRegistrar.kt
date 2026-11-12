package com.dalab.internet.notifications

import android.content.Context
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.RegisterDeviceTokenRequest
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await

/**
 * Registers this device's current FCM token against the signed-in agent
 * (POST /agent/notifications/register-device) so a support conversation
 * assigned to them reaches this phone as a real push -- see
 * support.routes.ts's notifyAssignedAgent(). Called from two places, both
 * safe to call repeatedly (the backend's upsert is idempotent):
 *
 *  - AgentApp() once it lands on the Home screen (covers both a fresh login
 *    and a resumed session, since MainActivity skips straight to Home when
 *    already logged in).
 *  - AgentFcmService.onNewToken(), whenever Firebase rotates the token.
 *
 * No-ops entirely (never throws, never crashes the caller) if Firebase
 * hasn't actually initialized -- i.e. google-services.json hasn't been
 * added to this build yet, see app/build.gradle.kts's conditional plugin
 * apply. Once that file is added, this starts working with no other code
 * change needed.
 */
object PushTokenRegistrar {
    suspend fun registerIfNeeded(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) return
        try {
            val token = FirebaseMessaging.getInstance().token.await()
            ApiClient.service.registerAgentDeviceToken(RegisterDeviceTokenRequest(token))
        } catch (e: Exception) {
            DiagnosticsLog.record("push_token_register", "Failed: ${e.message}")
        }
    }
}
