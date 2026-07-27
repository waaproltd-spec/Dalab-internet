package com.dalab.internet

import android.app.Application
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.auth.SessionManager
import com.dalab.internet.sms.SmsListenerState

/**
 * Referenced by AndroidManifest.xml (android:name=".DalabAgentApp") but never
 * actually created in the original delivery — the manifest would have failed
 * at launch with a ClassNotFoundException. Application-scoped singletons are
 * initialized here (both init() calls are idempotent-guarded, so this is safe
 * even though MainActivity.onCreate() also calls them defensively).
 */
class DalabAgentApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)
        DeviceIdentity.init(this)
        SmsListenerState.init(this)
    }
}
