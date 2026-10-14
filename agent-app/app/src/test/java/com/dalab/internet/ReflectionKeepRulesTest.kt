package com.dalab.internet

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The release build is minified (R8). A class Gson creates or reads back by
 * reflection must be kept, or Gson fails at runtime -- the first Dhameys
 * Plus order's verify-payment failed with "Abstract classes can't be
 * instantiated" because UssdPlan wasn't kept. This lists every such class
 * outside the data/network packages (which are kept wholesale) and checks
 * proguard-rules.pro keeps it.
 */
class ReflectionKeepRulesTest {
    private val gsonClassesOutsideKeptPackages = listOf(
        "com.dalab.internet.ussd.UssdPlan",
        "com.dalab.internet.ussd.UssdPlanStep",
        "com.dalab.internet.ussd.UssdMenuOption",
        "com.dalab.internet.ussd.DialJournal\$Entry",
        "com.dalab.internet.ussd.DialAttemptAuditAction",
        "com.dalab.internet.ussd.ExchangeDialStepReportAction",
        "com.dalab.internet.ussd.ResellerWithdrawalDialAttemptAuditAction",
        "com.dalab.internet.sms.SmsUploadAction",
        "com.dalab.internet.sms.VerifyPaymentAction",
        "com.dalab.internet.sms.VoucherConfirmationAction",
        "com.dalab.internet.sms.ExchangePayoutConfirmationAction",
        "com.dalab.internet.sms.VoucherSentEntry",
        "com.dalab.internet.sms.ExchangePayoutConfirmedEntry",
        "com.dalab.internet.sms.SmsSenderIdEntry",
        "com.dalab.internet.sms.SmsIntakeLedger\$Entry",
        "com.dalab.internet.queue.PendingActionQueue\$PendingAction",
        "com.dalab.internet.queue.SaleCreateAction",
        "com.dalab.internet.diagnostics.DiagnosticsLog\$Entry",
    )

    private fun rules(): String {
        val file = listOf(File("proguard-rules.pro"), File("agent-app/app/proguard-rules.pro")).firstOrNull { it.exists() }
            ?: error("proguard-rules.pro not found from ${File(".").absolutePath}")
        return file.readText()
    }

    @Test fun `every Gson class outside data and network is kept in the release build`() {
        val text = rules()
        for (name in gsonClassesOutsideKeptPackages) {
            assertTrue("$name must be kept in proguard-rules.pro (Gson reflection)", text.contains("-keep class $name { *; }"))
        }
    }

    @Test fun `enum names stay stable so saved queue and ledger entries read back after an update`() {
        assertTrue(rules().contains("-keepclassmembers enum com.dalab.internet.** { *; }"))
    }

    @Test fun `every listed class really exists (no stale entries)`() {
        for (name in gsonClassesOutsideKeptPackages) Class.forName(name)
    }
}
