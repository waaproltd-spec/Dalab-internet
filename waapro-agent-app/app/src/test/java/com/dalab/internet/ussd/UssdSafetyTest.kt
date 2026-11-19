package com.dalab.internet.ussd

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * Slow and unstable networks during automated USSD (UssdSafety.kt): late
 * and partially drawn menus, wrong windows (keyboard, the Register
 * Customer form, chat heads), timeouts, unclear results after the PIN,
 * competing requests, and dropped connections around a payout's start.
 * A virtual clock makes "the carrier answers 40 seconds later" instant.
 */
class UssdSafetyTest {

    // ---------------- A scripted carrier on a virtual clock ----------------

    private class Clock { var now = 0L }

    /**
     * After the dial (reply #0) and after each reply, the carrier shows the
     * screens listed for that point, each [Pair.first] ms later.
     */
    private class FakeCarrier(
        private val clock: Clock,
        private val screensAfter: Map<Int, List<Pair<Long, CarrierScreen>>>,
        private val receiptAfterLast: Pair<Long, String>?,
        private val replyConfirmed: (Int) -> Boolean = { true },
    ) : CarrierScreenPort {
        val replies = mutableListOf<String>()
        var cancelled = false
        private val pending = ArrayDeque<Pair<Long, CarrierScreen>>()
        private var receipt: Pair<Long, String>? = null
        var totalSteps = 0

        init { schedule(0) }

        private fun schedule(point: Int) {
            screensAfter[point].orEmpty().forEach { (delay, screen) -> pending.addLast(clock.now + delay to screen) }
            if (point == totalSteps && totalSteps > 0) receiptAfterLast?.let { receipt = clock.now + it.first to it.second }
        }

        override suspend fun nextScreen(timeoutMs: Long, drain: Boolean): CarrierScreen? {
            if (drain) while (pending.isNotEmpty() && pending.first().first < clock.now) pending.removeFirst()
            val next = pending.firstOrNull()
            return if (next != null && next.first <= clock.now + timeoutMs) {
                pending.removeFirst()
                clock.now = maxOf(clock.now, next.first)
                next.second
            } else {
                clock.now += timeoutMs
                null
            }
        }

        override suspend fun reply(text: String, timeoutMs: Long): Boolean {
            replies += text
            clock.now += 200
            if (!replyConfirmed(replies.size - 1)) { clock.now += timeoutMs; return false }
            pending.clear()
            schedule(replies.size)
            return true
        }

        override suspend fun cancel() { cancelled = true }

        override suspend fun finalText(timeoutMs: Long): String? {
            val r = receipt
            return if (r != null && r.first <= clock.now + timeoutMs) { clock.now = maxOf(clock.now, r.first); r.second } else { clock.now += timeoutMs; null }
        }
    }

    // Somtel Dhameys Plus, as on the phone: *101# -> 4 -> 3 ($0.5) -> PIN.
    private val plan = UssdPlan(
        initialDial = "*101#",
        steps = listOf(
            UssdPlanStep(reply = "4", expect = listOf("Dhameys")),
            UssdPlanStep(reply = "3", menuOption = UssdMenuOption("3", "0.5")),
            UssdPlanStep(reply = "{pin}", amount = "0.5", number = "620346060", secret = true),
        ),
    )
    private val menuHeaderOnly = CarrierScreen("<-Somtel Services- >", hasInput = true)
    private val mainMenu = CarrierScreen(
        "<-Somtel Services- >\n1. Ku Hadal\n2. Kaafiye Plus\n3. Jumca & Abaal\n4. Dhameys Plus\n5. Muraadso\n6. Xulmo-Social Bundle\n7. Broadband & DID",
        hasInput = true,
    )
    private val packageMenu = CarrierScreen("Dhameys Plus\n1. \$0.25 = 1 Hr\n3. \$0.5 = Daily 24 Hrs", hasInput = true)
    private val confirm = CarrierScreen("Ku shub Daily 24 Hrs \$0.5 lambarka 620346060. Geli PIN", hasInput = true)
    private val receipt = "Macmiil, waxaad ku guuleysatay inaad = Daily 24 Hrs ugu shubto 620346060."

    private fun run(carrier: FakeCarrier, clock: Clock): DialResult {
        carrier.totalSteps = plan.steps.size
        return runBlocking { InteractiveMenuDriver.run(plan, "1234", carrier, now = { clock.now }) }
    }

    // ---------------- Slow internet / delayed menus ----------------

    @Test fun `slow carrier - every screen arrives 30 seconds late and the order still completes`() {
        val clock = Clock()
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(30_000L to mainMenu), 1 to listOf(30_000L to packageMenu), 2 to listOf(30_000L to confirm)), 30_000L to receipt)
        val r = run(carrier, clock)
        assertEquals(DialOutcome.SUCCESS, r.outcome)
        assertEquals(listOf("4", "3", "1234"), carrier.replies)
    }

    @Test fun `a menu drawn in parts is read only once complete - the Dhameys incident`() {
        val clock = Clock()
        // First the header alone, the full menu 1.5 s later.
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(2_000L to menuHeaderOnly, 3_500L to mainMenu), 1 to listOf(500L to packageMenu), 2 to listOf(500L to confirm)), 1_000L to receipt)
        val r = run(carrier, clock)
        assertEquals(DialOutcome.SUCCESS, r.outcome)
        assertEquals("4", carrier.replies.first())
    }

    @Test fun `a partial screen that becomes complete within the grace time is accepted`() {
        val clock = Clock()
        // The header settles (nothing new for a second), then the full menu comes 2 s later.
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(1_000L to menuHeaderOnly, 4_000L to mainMenu), 1 to listOf(500L to packageMenu), 2 to listOf(500L to confirm)), 1_000L to receipt)
        assertEquals(DialOutcome.SUCCESS, run(carrier, clock).outcome)
    }

    @Test fun `no menu within the wait - timeout, nothing typed, nothing paid`() {
        val clock = Clock()
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(50_000L to mainMenu)), null)
        val r = run(carrier, clock)
        assertEquals(DialOutcome.TIMEOUT, r.outcome)
        assertTrue(r.moneyNotSent)
        assertTrue(carrier.replies.isEmpty())
    }

    @Test fun `the connection drops mid-menu - timeout before the PIN, the PIN is never sent`() {
        val clock = Clock()
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(1_000L to mainMenu)), null) // nothing after "4"
        val r = run(carrier, clock)
        assertEquals(DialOutcome.TIMEOUT, r.outcome)
        assertTrue(r.moneyNotSent)
        assertEquals(listOf("4"), carrier.replies)
    }

    // ---------------- Wrong windows / unexpected screens ----------------

    @Test fun `the Register Customer form or any other screen is never answered - stop before the PIN`() {
        val clock = Clock()
        val form = CarrierScreen("Register customer\nCustomer name\nPayment sender number", hasInput = true)
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(1_000L to form)), receipt = null)
        val r = run(carrier, clock)
        assertEquals(DialOutcome.FAILED, r.outcome)
        assertTrue(r.noRetry)
        assertTrue(carrier.cancelled)
        assertTrue("nothing typed", carrier.replies.isEmpty())
        assertTrue(r.responseMessage!!.contains("nothing was paid"))
    }

    @Test fun `a carrier error instead of the menu stops before anything is typed`() {
        val clock = Clock()
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(1_000L to CarrierScreen("Service not available. Try again later.", hasInput = false))), null)
        val r = run(carrier, clock)
        assertEquals(DialOutcome.FAILED, r.outcome)
        assertTrue(carrier.replies.isEmpty())
        assertTrue(carrier.cancelled)
    }

    @Test fun `a confirmation for the wrong amount or number stops BEFORE the PIN`() {
        val clock = Clock()
        val wrong = CarrierScreen("Ku shub Daily 24 Hrs \$0.75 lambarka 620346060. Geli PIN", hasInput = true)
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(500L to mainMenu), 1 to listOf(500L to packageMenu), 2 to listOf(500L to wrong)), null)
        val r = run(carrier, clock)
        assertEquals(DialOutcome.FAILED, r.outcome)
        assertFalse("the PIN is never typed", carrier.replies.contains("1234"))
        assertTrue(carrier.cancelled)
    }

    // ---------------- After the PIN: never twice ----------------

    @Test fun `the PIN went out but its submission was not confirmed - unclear, never retried`() {
        val clock = Clock()
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(500L to mainMenu), 1 to listOf(500L to packageMenu), 2 to listOf(500L to confirm)), null, replyConfirmed = { it != 2 })
        val r = run(carrier, clock)
        assertEquals(DialOutcome.AMBIGUOUS, r.outcome)
        assertTrue(r.noRetry)
    }

    @Test fun `no receipt after the PIN - a late reply - is unclear and never retried`() {
        val clock = Clock()
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(500L to mainMenu), 1 to listOf(500L to packageMenu), 2 to listOf(500L to confirm)), 60_000L to receipt)
        val r = run(carrier, clock)
        assertEquals(DialOutcome.AMBIGUOUS, r.outcome)
        assertTrue(r.noRetry)
    }

    @Test fun `a failure receipt after the PIN is final, never retried`() {
        val clock = Clock()
        val carrier = FakeCarrier(clock, mapOf(0 to listOf(500L to mainMenu), 1 to listOf(500L to packageMenu), 2 to listOf(500L to confirm)), 1_000L to "Haraagaagu kuguma filna. Insufficient balance.")
        val r = run(carrier, clock)
        assertEquals(DialOutcome.FAILED, r.outcome)
        assertTrue(r.noRetry)
    }

    // ---------------- Settling ----------------

    @Test fun `a screen read twice the same is settled at once`() = runBlocking {
        val clock = Clock()
        val seq = ArrayDeque(listOf(mainMenu, mainMenu))
        val s = awaitSettledScreen(10_000L, 900L, { clock.now }) { _, _ -> seq.removeFirstOrNull() }
        assertEquals(mainMenu, s)
    }

    @Test fun `no screen at all is null`() = runBlocking {
        assertNull(awaitSettledScreen(10_000L, 900L, { 0L }) { _, _ -> null })
    }

    // ---------------- Which window is the carrier's ----------------

    @Test fun `only the carrier dialog is taken - never the keyboard, an overlay, this app, a launcher or a chat app`() {
        val own = "com.dalab.internet"
        val f = CarrierWindowFilter
        assertTrue(f.accept("com.android.phone", f.TYPE_SYSTEM, own, looksLikeDialog = true))
        assertTrue("other phone makers' dialog apps", f.accept("com.transsion.phone", f.TYPE_APPLICATION, own, looksLikeDialog = true))
        assertFalse("the Register Customer form has input fields but is this app", f.accept(own, f.TYPE_APPLICATION, own, looksLikeDialog = true))
        assertFalse("keyboard window", f.accept("com.samsung.android.honeyboard", f.TYPE_INPUT_METHOD, own, looksLikeDialog = true))
        assertFalse("keyboard app even if the type is unknown", f.accept("com.google.android.inputmethod.latin", null, own, looksLikeDialog = true))
        assertFalse("overlay", f.accept("com.some.recorder", f.TYPE_ACCESSIBILITY_OVERLAY, own, looksLikeDialog = true))
        assertFalse("chat heads", f.accept("com.facebook.orca", f.TYPE_APPLICATION, own, looksLikeDialog = true))
        assertFalse("launcher", f.accept("com.sec.android.app.launcher", f.TYPE_APPLICATION, own, looksLikeDialog = true))
        assertFalse("status bar / notification shade", f.accept("com.android.systemui", f.TYPE_SYSTEM, own, looksLikeDialog = true))
        assertFalse("an unknown window that doesn't look like a dialog", f.accept("com.android.phone", f.TYPE_SYSTEM, own, looksLikeDialog = false))
        assertFalse("no package", f.accept(null, f.TYPE_SYSTEM, own, looksLikeDialog = true))
    }

    // ---------------- Reseller Withdraw ----------------

    @Test fun `Reseller Withdraw never replies into an error screen`() {
        assertTrue(resellerScreenProblem("Invalid number. Try again") != null)
        assertTrue(resellerScreenProblem("Haraaga xisaabtaadu kuguma filna, haraagaagu waa: 5.367") != null)
        assertNull(resellerScreenProblem("Geli lambarka aad u dirayso"))
        assertNull(resellerScreenProblem("Fadlan geli PIN-kaaga"))
    }

    @Test fun `the PIN position follows each company - first for Somnet, last for eDahab`() {
        assertEquals(0, resellerPinIndex(listOf("{pin}", "2", "{number}", "{number}", "{amount}", "1"), 6))
        assertEquals(3, resellerPinIndex(listOf("1", "{number}", "{amount}"), 4))
    }

    // ---------------- Dropped connections around a payout ----------------

    @Test fun `a payout is dialed only on a dial record the server created just now`() {
        assertTrue("201: new record", payoutStartAllowsDial(201))
        assertFalse("200: already dialed before (maybe while offline) - never again", payoutStartAllowsDial(200))
        assertFalse("no answer: the server doesn't know - nothing dialed", payoutStartAllowsDial(null))
        assertFalse(payoutStartAllowsDial(403))
        assertFalse(payoutStartAllowsDial(500))
    }

    // ---------------- One session at a time ----------------

    @Before fun resetQueue() = runBlocking {
        UssdSimLock.debounceMs = 20L
        UssdSimLock.resetForTest()
    }

    @Test fun `a Package Order and a Reseller Withdraw arriving together never share the screen, and the app knows a session is active`() = runBlocking {
        val onScreen = AtomicInteger(0)
        val maxOnScreen = AtomicInteger(0)
        val sawActive = AtomicInteger(0)
        suspend fun flow(sim: Int, id: String, at: Long) {
            val ticket = UssdSimLock.acquire(sim, id, at)
            InteractiveUssdScreenLock.acquire()
            try {
                if (InteractiveUssdScreenLock.active.value) sawActive.incrementAndGet()
                maxOnScreen.updateAndGet { maxOf(it, onScreen.incrementAndGet()) }
                delay(40)
            } finally {
                onScreen.decrementAndGet()
                InteractiveUssdScreenLock.release()
                UssdSimLock.release(ticket)
            }
        }
        val pkg = async { flow(1, "internet_store:DLB1:attempt1", 1_000L) }
        val reseller = async { flow(2, "reseller:W1", 1_001L) }
        val pkg2 = async { flow(1, "internet_store:DLB2:attempt1", 1_002L) }
        pkg.await(); reseller.await(); pkg2.await()
        assertEquals("never two on the screen at once", 1, maxOnScreen.get())
        assertEquals("every session is shown as active", 3, sawActive.get())
        assertFalse("the cover lifts when the last one ends", InteractiveUssdScreenLock.active.value)
    }
}
