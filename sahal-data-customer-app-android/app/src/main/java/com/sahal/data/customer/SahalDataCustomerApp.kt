package com.sahal.data.customer

import android.app.Application
import com.sahal.data.customer.auth.SessionManager
import com.sahal.data.customer.prefs.LocalizationManager
import com.sahal.data.customer.prefs.ThemeManager
import com.sahal.data.customer.queue.PendingActionQueue

class SahalDataCustomerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)
        PendingActionQueue.init(this)
        ThemeManager.init(this)
        LocalizationManager.init(this)
    }
}
