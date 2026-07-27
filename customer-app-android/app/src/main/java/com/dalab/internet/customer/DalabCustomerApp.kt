package com.dalab.internet.customer

import android.app.Application
import com.dalab.internet.customer.auth.SessionManager
import com.dalab.internet.customer.prefs.LocalizationManager
import com.dalab.internet.customer.prefs.ThemeManager
import com.dalab.internet.customer.queue.PendingActionQueue

class DalabCustomerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)
        PendingActionQueue.init(this)
        ThemeManager.init(this)
        LocalizationManager.init(this)
    }
}
