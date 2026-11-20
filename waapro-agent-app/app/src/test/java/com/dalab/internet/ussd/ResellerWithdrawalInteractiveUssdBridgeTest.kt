package com.dalab.internet.ussd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression coverage for the real production bug this pins down: a screen
 * must never be blind-tapped as a "confirm" target while any reply still
 * remains to be typed — only once every reply (including the PIN) has
 * already been submitted, for the true final receipt screen. Confirmed
 * live against real eDahab withdrawals (2026-08-19, WDR267393976/
 * WDR894433377, replySteps=["3","{number}","{amount}"] + the PIN, so 4
 * replies total): a window locked onto com.android.phone (the real *300#
 * menu appeared), a confirmation_advanced event fired with no reply ever
 * armed, the on-device toast read "Input required. Try again." (the
 * carrier's response to a blank USSD reply), and both attempts then timed
 * out waiting for a DialogSeen event that never came — the real menu
 * screen had already been consumed as a confirm-tap target instead.
 *
 * An earlier fix attempt used `stage > 0` (eligible as soon as ANY reply
 * had been submitted) — that would have fixed stage 0 but reintroduced the
 * identical bug at every later intermediate stage (1, 2, 3), since this
 * flow has multiple replies in a row, unlike Money Exchange's single PIN.
 * The real fix compares against the total reply count instead.
 */
class ResellerWithdrawalInteractiveUssdBridgeTest {

    // The real eDahab sequence: "3" (stage 0->1), {number} (1->2), {amount}
    // (2->3), then the PIN (3->4) — 4 replies total, so only stage 4 (every
    // reply already submitted) is ever eligible for a blind confirm-tap.
    private val edahabTotalReplies = 4

    @Test
    fun `stage 0 (before any reply submitted) is never eligible — the exact bug case`() {
        assertFalse(isConfirmTapEligible(stage = 0, totalReplies = edahabTotalReplies, alreadyTappedThisStage = false))
    }

    @Test
    fun `every intermediate stage is still ineligible — the bug would recur here with a stage-greater-than-zero fix`() {
        assertFalse(isConfirmTapEligible(stage = 1, totalReplies = edahabTotalReplies, alreadyTappedThisStage = false))
        assertFalse(isConfirmTapEligible(stage = 2, totalReplies = edahabTotalReplies, alreadyTappedThisStage = false))
        assertFalse(isConfirmTapEligible(stage = 3, totalReplies = edahabTotalReplies, alreadyTappedThisStage = false))
    }

    @Test
    fun `only the stage after every reply (including the PIN) is submitted is eligible`() {
        assertTrue(isConfirmTapEligible(stage = 4, totalReplies = edahabTotalReplies, alreadyTappedThisStage = false))
    }

    @Test
    fun `the final stage is not eligible again once already tapped, capping the auto-tap to once`() {
        assertFalse(isConfirmTapEligible(stage = 4, totalReplies = edahabTotalReplies, alreadyTappedThisStage = true))
    }

    @Test
    fun `a single-reply flow (like Exchange's own PIN-only case) is eligible right after that one reply`() {
        assertFalse(isConfirmTapEligible(stage = 0, totalReplies = 1, alreadyTappedThisStage = false))
        assertTrue(isConfirmTapEligible(stage = 1, totalReplies = 1, alreadyTappedThisStage = false))
    }
}
