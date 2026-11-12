package com.dalab.internet.ussd

import kotlinx.coroutines.sync.Mutex

/**
 * Must be held for the entire span any interactive (AccessibilityService-
 * driven, on-screen-dialog) USSD flow is active on this device -- currently
 * [ExchangeUssdOrchestrator] (real Money Exchange payouts),
 * [WalletLookupUssdOrchestrator] (read-only $1 wallet name lookups, which
 * shares [ExchangeUssdBridge] with the payout flow), and
 * [ResellerWithdrawalInteractiveUssdOrchestrator] (Reseller Withdraw's own
 * multi-step eDahab flow, which drives a SEPARATE bridge/accessibility
 * service -- [ResellerWithdrawalInteractiveUssdBridge]/
 * [ResellerWithdrawalInteractiveUssdAccessibilityService]).
 *
 * [UssdSimLock] alone is not enough to keep these apart: it only serializes
 * the actual DIAL per SIM slot, so it happily lets two of these flows run on
 * DIFFERENT SIM slots "concurrently" -- confirmed live: a wallet lookup on
 * one slot reported a real, concurrently-running Money Exchange payout's own
 * dialed number as its "raw response", because both flows share
 * [ExchangeUssdBridge]'s single set of mutable state (lockedPackageName, the
 * event channel, etc.) and each call to `arm()` unconditionally resets it.
 * Extending the reasoning further: even where two flows DON'T share a bridge
 * object (Exchange/Wallet Lookup vs. Reseller Withdraw), Android delivers
 * every accessibility event to EVERY enabled AccessibilityService
 * regardless of which flow's dial produced it, and neither
 * [ExchangeUssdAccessibilityService] nor
 * [ResellerWithdrawalInteractiveUssdAccessibilityService] has any way to
 * tell "this on-screen dialog belongs to MY flow's own dial, not a
 * different flow's" -- there is only ever one physical screen, and no
 * dial-attempt correlation id travels with it. Left unfixed, this could let
 * one flow's accessibility service tap Cancel on (or, far worse, inject and
 * submit a queued PIN into) a dialog that actually belongs to a completely
 * different, concurrently-running flow's real transaction. This lock closes
 * that gap by making all three flows mutually exclusive device-wide,
 * regardless of SIM slot -- every caller acquires [UssdSimLock] first, this
 * second, a consistent global lock order so the two can never deadlock
 * against each other.
 *
 * Kept as its own file/object with no Android framework imports at all --
 * unlike [ExchangeUssdBridge], which eagerly constructs a real
 * `Handler(Looper.getMainLooper())` as a top-level property and therefore
 * cannot be referenced from a plain JVM unit test (no Robolectric) without
 * throwing during class initialization. This mirrors why [UssdSimLock] is
 * its own standalone object too.
 */
object InteractiveUssdScreenLock {
    private val mutex = Mutex()

    suspend fun acquire() = mutex.lock()

    /** Pairs with [acquire] -- tolerates being called when not held so a
     * caller that failed before ever acquiring can still safely no-op this
     * in a shared cleanup path. */
    fun release() {
        if (mutex.isLocked) mutex.unlock()
    }
}
