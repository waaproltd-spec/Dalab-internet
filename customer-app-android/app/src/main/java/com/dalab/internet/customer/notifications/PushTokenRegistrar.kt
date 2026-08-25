package com.dalab.internet.customer.notifications

import android.content.Context
import android.util.Log
import com.dalab.internet.customer.network.ApiClient
import com.dalab.internet.customer.network.RegisterDeviceTokenRequest
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await

/**
 * Registers this device's current FCM token against the signed-in customer
 * (POST /notifications/register-device) so an order/exchange status update
 * reaches this phone as a real push -- see customerNotify.ts/push.ts. Called
 * from two places, both safe to call repeatedly (the backend's upsert is
 * idempotent):
 *
 *  - CustomerHome's LaunchedEffect(Unit), once the customer reaches Home
 *    (covers both a fresh login and a resumed session).
 *  - CustomerFcmService.onNewToken(), whenever Firebase rotates the token.
 *
 * No-ops entirely (never throws, never crashes the caller) if Firebase
 * hasn't actually initialized -- i.e. google-services.json hasn't been
 * added to this build yet, see app/build.gradle.kts's conditional plugin
 * apply. Once that file is added, this starts working with no other code
 * change needed.
 */
object PushTokenRegistrar {
    private const val TAG = "PushTokenRegistrar"

    suspend fun registerIfNeeded(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) return
        try {
            val token = FirebaseMessaging.getInstance().token.await()
            ApiClient.service.registerDeviceToken(RegisterDeviceTokenRequest(token))
        } catch (e: Exception) {
            Log.w(TAG, "Failed to register device token: ${e.message}")
        }
    }

    /** Best-effort on logout -- a stale token just gets pruned server-side
     * the next time a send to it fails, so a failure here is never fatal. */
    suspend fun unregister(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) return
        try {
            val token = FirebaseMessaging.getInstance().token.await()
            ApiClient.service.unregisterDeviceToken(RegisterDeviceTokenRequest(token))
        } catch (e: Exception) {
            Log.w(TAG, "Failed to unregister device token: ${e.message}")
        }
    }
}
