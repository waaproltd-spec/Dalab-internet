package com.dalab.internet.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.provider.Telephony
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Native counterpart to src/sms/nativeSmsBridge.ts. There is no cross-platform
 * JS API for reading SMS, so this module does the actual work: registers a
 * BroadcastReceiver for the protected SMS_RECEIVED broadcast and forwards
 * each message to JS as an "onSmsReceived" event.
 *
 * This mirrors the same receiver design already used in the native Kotlin
 * Agent App (dalab-agent-app.zip, sms/SmsReceiver.kt) — same protected-
 * broadcast reasoning applies: a manifest- or context-registered receiver for
 * SMS_RECEIVED_ACTION still fires even on API 26+, where most other implicit
 * broadcasts are background-restricted, because it's a protected system
 * broadcast third-party apps cannot spoof.
 *
 * Registration: add to your MainApplication's list of packages via a
 * ReactPackage (SmsListenerPackage.kt, included alongside this file).
 */
class SmsListenerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SmsListenerModule"

    private var receiver: BroadcastReceiver? = null

    @ReactMethod
    fun startListening() {
        if (receiver != null) return // already listening — avoid double-registration

        receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

                val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
                val sender = messages.firstOrNull()?.originatingAddress ?: return
                val body = messages.joinToString(separator = "") { it.messageBody ?: "" }

                val payload = Arguments.createMap().apply {
                    putString("sender", sender)
                    putString("body", body)
                    putDouble("timestampMs", System.currentTimeMillis().toDouble())
                }

                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("onSmsReceived", payload)
            }
        }

        // Registered at runtime (not just in the manifest) so start/stopListening
        // from JS actually controls whether this module is doing anything —
        // the permission check itself still happens on the JS/PermissionsAndroid
        // side before startListening() is ever called.
        reactContext.registerReceiver(receiver, IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION))
    }

    @ReactMethod
    fun stopListening() {
        receiver?.let {
            reactContext.unregisterReceiver(it)
            receiver = null
        }
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        stopListening()
    }
}
