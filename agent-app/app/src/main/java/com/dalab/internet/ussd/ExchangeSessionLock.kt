package com.dalab.internet.ussd

import kotlinx.coroutines.sync.Mutex

/**
 * Must be held for the entire span from [ExchangeUssdBridge.arm] through
 * [ExchangeUssdBridge.disarm] -- see [ExchangeUssdBridge]'s own doc comment
 * for the live incident this closes (a real Money Exchange payout on one SIM
 * slot and a Wallet Name Lookup on a DIFFERENT slot both arming that single
 * shared bridge at once, each silently resetting the other's in-flight
 * session state). Deliberately a separate lock from [UssdSimLock] (which
 * stays scoped to "one dial per SIM slot"): this one exists purely to
 * protect the bridge's own shared mutable state from two DIFFERENT SIM
 * slots' flows both using it at once, and every caller acquires
 * [UssdSimLock] first, this second -- a consistent global lock order, so the
 * two can never deadlock against each other.
 *
 * Kept as its own file/object with no Android framework imports at all --
 * unlike [ExchangeUssdBridge] itself, which eagerly constructs a real
 * `Handler(Looper.getMainLooper())` as a top-level property and therefore
 * cannot be referenced from a plain JVM unit test (no Robolectric) without
 * throwing during class initialization. This mirrors why [UssdSimLock] is
 * its own standalone object too.
 */
object ExchangeSessionLock {
    private val mutex = Mutex()

    suspend fun acquire() = mutex.lock()

    /** Pairs with [acquire] -- tolerates being called when not held so a
     * caller that failed before ever acquiring can still safely no-op this
     * in a shared cleanup path. */
    fun release() {
        if (mutex.isLocked) mutex.unlock()
    }
}
