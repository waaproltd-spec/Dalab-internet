package com.dalab.internet.network

/**
 * Remembers which optional server features this system doesn't have (it
 * answered 404), so background loops stop asking every minute and filling
 * the diagnostics log. Re-checked after [RECHECK_MS] (an admin may switch a
 * feature on) and forgotten on sign-out / system switch.
 */
object ServerFeatures {
    const val RESELLER_WITHDRAW = "reseller_withdraw"
    internal const val RECHECK_MS = 60 * 60_000L

    private val missingSince = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /** True while [feature] answered 404 less than [RECHECK_MS] ago. */
    fun isSkipped(feature: String, now: Long = System.currentTimeMillis()): Boolean {
        val at = missingSince[feature] ?: return false
        if (now - at >= RECHECK_MS) {
            missingSince.remove(feature)
            return false
        }
        return true
    }

    /** Records a 404; returns true the first time (so the caller logs once). */
    fun markMissing(feature: String, now: Long = System.currentTimeMillis()): Boolean =
        missingSince.put(feature, now) == null

    fun reset() = missingSince.clear()
}
