package com.dalab.internet.customer

import android.app.Application
import com.dalab.internet.customer.auth.SessionManager

class DalabCustomerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SessionManager.init(this)
    }
}
