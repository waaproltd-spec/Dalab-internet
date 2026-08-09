package com.dalab.internet.ussd

import android.accessibilityservice.AccessibilityService
import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.diagnostics.DiagnosticsLog

/**
 * Reads Android's native "USSD message" reply dialog via the Accessibility
 * API and can inject text/tap Send into it — the only way to drive a
 * multi-step USSD session (Money Exchange's two-step PIN flow) since
 * TelephonyManager.sendUssdRequest() (used for Internet Store, see
 * UssdDialer.kt) is a single request/response API with no way to continue an
 * already-open session. This service is completely separate from Internet
 * Store's dialing path and never touches it.
 *
 * HONEST LIMITATION: the reply dialog's package name and node structure vary
 * by OEM (stock AOSP is com.android.phone; Samsung/Xiaomi/Huawei/etc ship
 * their own dialer UI). This service does not filter by package — it reads
 * whatever window is foregrounded — but it only ever *acts* (fills text /
 * taps a button) while [ExchangeUssdBridge.armed] is true, i.e. only for the
 * seconds a deliberately started Money Exchange dial attempt is in flight.
 * The heuristics below (longest text node = the dialog message, first
 * editable node = the reply field, a Button whose text contains ok/send/dial
 * = the submit action) are a reasonable default for a stock AlertDialog-style
 * USSD prompt, but MUST be validated against the actual phone models used in
 * the field before this is trusted with real money — see
 * ExchangeAccessibilitySetupScreen for the manual fallback that always stays
 * available regardless of whether this works on a given device.
 */
class ExchangeUssdAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        ExchangeUssdBridge.serviceConnected = true
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!ExchangeUssdBridge.armed) return // never look at/act on dialogs outside a live Money Exchange dial attempt
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) {
            return
        }
        scanAndAct()
    }

    /** Re-reads whatever window is currently foregrounded and either injects
     * a pending PIN into it (if one is armed and this window has an input
     * field) or reports it as a newly-seen dialog. Called both reactively
     * (from onAccessibilityEvent) and proactively (by
     * ExchangeUssdBridge.armPinInjection, in case the target dialog is
     * already on screen and won't fire a fresh event of its own). */
    internal fun scanAndAct() {
        if (!ExchangeUssdBridge.armed) return
        val root = findRelevantRoot() ?: return
        try {
            val messageText = findDialogMessageText(root) ?: return

            val windowPackage = root.packageName?.toString()
            val inputNode = findEditableNode(root)
            // Whether this scan's content looks like a genuine USSD dialog
            // at all -- used only to decide whether it's safe to *establish*
            // the window lock on it (see ExchangeUssdBridge.isWindowAllowed).
            // findPositiveButton(root) here does a second tree walk beyond
            // the one later in this function when a confirm-tap is actually
            // attempted -- an accepted small cost on a small dialog tree,
            // not worth threading a cached node reference through for.
            val looksLikeUssdDialog = inputNode != null || isTransientLoadingDialog(messageText) || findPositiveButton(root) != null
            if (!ExchangeUssdBridge.isWindowAllowed(windowPackage, looksLikeUssdDialog)) {
                // Either the foreground drifted to a different app mid-attempt
                // (e.g. Chrome) after a lock was already established --
                // confirmed live: order DEX624960716 reported SUCCESS off a
                // Chrome tab's text -- or no lock exists yet and this scan's
                // content doesn't look like a dialog at all (confirmed live:
                // order DEX426547905 locked onto an unrelated app's label as
                // if it were the carrier's Step 1 response). Either way,
                // never treat this content as carrier output and never
                // inject the PIN into it. Leave any pending PIN untouched;
                // the next poll retries once the real dialog is in front.
                if (ExchangeUssdBridge.shouldLogWindowMismatch(windowPackage)) {
                    val reason = if (ExchangeUssdBridge.lockedWindowPackageOrNull() == null) {
                        "doesn't look like the carrier dialog yet (no input field, button, or loading text)"
                    } else {
                        "doesn't match the carrier dialog's window for this attempt"
                    }
                    DiagnosticsLog.record(
                        "exchange_window_mismatch",
                        "Ignored foreground window \"$windowPackage\" -- $reason.",
                        isError = false,
                    )
                }
                return
            }

            val pendingPin = ExchangeUssdBridge.consumePendingPinToInject()
            if (pendingPin != null) {
                if (inputNode == null) {
                    // Not the right window yet (or the field hasn't rendered) —
                    // put it back for the next scan instead of dropping it, and
                    // stop here: falling through to the DialogSeen emit below
                    // would land a spurious event on the same conflated channel
                    // ExchangeUssdOrchestrator's step2 awaitNextEvent() is
                    // waiting on for PinSubmitted, making it give up within
                    // seconds instead of waiting for a later scan (once the
                    // field actually renders) to inject for real -- confirmed
                    // live on order DEX176626979: STEP2_FAILED fired 6s after
                    // dialing, well under the 15s timeout, dialog left sitting
                    // untouched on screen with the PIN never actually typed.
                    ExchangeUssdBridge.restorePendingPinToInject(pendingPin)
                    return
                } else {
                    val args = Bundle()
                    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, pendingPin)
                    inputNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                    val submit = findPositiveButton(root) ?: inputNode
                    submit.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    ExchangeUssdBridge.emit(UssdDialogEvent.PinSubmitted)
                    return
                }
            }

            if (isTransientLoadingDialog(messageText)) {
                // Android's own "USSD code running…" placeholder, shown
                // while waiting for the carrier -- not a real response.
                // Emitting this as DialogSeen would make the orchestrator
                // treat it as the final (PIN-less) answer and give up well
                // before its actual timeout -- confirmed live on order
                // DEX801871634 (STEP1_FAILED with response text literally
                // "USSD code running…"). Skip it silently; a later scan
                // (triggered once the real dialog replaces this one) will
                // emit the actual response.
                return
            }

            if (inputNode == null || ExchangeUssdBridge.isEligibleForPostPinConfirmTap()) {
                // No PIN field yet, but this may be a legitimate
                // intermediate step -- some carrier flows show a plain
                // "confirm this transfer?" screen (message + Send/OK, no
                // input) before the PIN prompt, not just an error. Auto-tap
                // it and keep waiting instead of failing the whole attempt,
                // exactly like a human agent manually pressing Send would.
                // A dialog with no recognizable confirm button at all falls
                // through to the ambiguous-failure DialogSeen below
                // unchanged -- never taps something that isn't actually a
                // confirm/dismiss action.
                //
                // The same applies after the PIN has been submitted: the
                // native USSD dialog reuses one template with an EditText
                // for the whole session, so a Step 3 "Send/Cancel" screen
                // confirming the pending transfer still has a (now
                // irrelevant) input field -- inputNode != null doesn't mean
                // "still needs input" once the PIN is already in. Capped to
                // one auto-tap per attempt (isEligibleForPostPinConfirmTap)
                // so the carrier's real final receipt -- which can share the
                // same template -- is never mistaken for another Step 3
                // screen and tapped instead of being accepted as the result.
                val confirmButton = findPositiveButton(root)
                if (confirmButton != null) {
                    if (ExchangeUssdBridge.shouldAutoConfirm(messageText)) {
                        confirmButton.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        ExchangeUssdBridge.emit(UssdDialogEvent.ConfirmationAdvanced(ExchangeUssdBridge.currentConfirmationStage()))
                    }
                    // Else: already tapped this exact dialog on an earlier
                    // scan (a repeat accessibility event can land before the
                    // tap has visually dismissed it) -- do nothing rather
                    // than re-emit this stale screen as a final answer.
                    return
                }
            }

            ExchangeUssdBridge.emit(UssdDialogEvent.DialogSeen(messageText, hasInput = inputNode != null))
        } catch (e: Exception) {
            Log.w(TAG, "scanAndAct failed: ${e.message}")
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
    }

    /** Finds the window this attempt should read from and act on. Before a
     * window is locked in for this attempt (the first time real dialog text
     * is seen -- see ExchangeUssdBridge.isWindowAllowed), uses whatever
     * window is currently active, exactly as before: right after dial()
     * places the call, that's reliably the phone/dialer UI grabbing focus.
     * Once a window is locked, searches *every* currently visible window
     * (not just the active one) for the one belonging to the locked
     * package, so the carrier dialog keeps being read -- and PIN/Send
     * actions keep being dispatched to it -- even after the user navigates
     * to the Home screen or another app. Android can keep a system-style
     * USSD dialog visually on screen without it remaining the "active"
     * window; before this, that meant the automation stalled the moment
     * focus moved away, even with the real dialog still visible (confirmed
     * live: exchange_window_mismatch firing against
     * com.sec.android.app.launcher and com.anthropic.claude while the
     * dialog was still on screen). This never widens *what* the automation
     * is willing to act on -- it's still an exact match against the one
     * package locked in for this attempt, nothing else is ever considered.
     * Returns null once the locked window has genuinely closed. */
    private fun findRelevantRoot(): AccessibilityNodeInfo? {
        val locked = ExchangeUssdBridge.lockedWindowPackageOrNull() ?: return rootInActiveWindow
        var found: AccessibilityNodeInfo? = null
        // Only collected for the miss-diagnostic below -- package+type of
        // every window seen this scan, so a search miss is self-explanatory
        // without needing a live device connection to inspect.
        val seen = mutableListOf<String>()
        for (window in windows) {
            val windowRoot = window.root
            val windowPackage = windowRoot?.packageName?.toString()
            seen.add("${windowPackage ?: "?"}(type=${window.type})")
            if (found == null && windowPackage == locked) {
                found = windowRoot
            } else {
                @Suppress("DEPRECATION")
                windowRoot?.recycle()
            }
            @Suppress("DEPRECATION")
            window.recycle()
        }
        if (found == null && ExchangeUssdBridge.shouldLogWindowSearchMiss()) {
            // Confirmed live (Samsung/One UI): the carrier dialog can stay
            // visually on top of the Home screen after losing focus, yet
            // genuinely not appear in this list at all -- the OS itself
            // excludes it from the interactive window set once backgrounded,
            // not a search-logic gap on our side. Nothing can be tapped or
            // filled without the real window, so the safest response is to
            // tell the user to come back rather than silently keep polling
            // for the rest of this step's existing timeout.
            DiagnosticsLog.record(
                "exchange_window_search_miss",
                "Locked window \"$locked\" not found among ${seen.size} visible window(s): ${seen.joinToString()}",
                isError = false,
            )
            notifyWindowLost()
        }
        return found
    }

    /** Fires at most once per attempt, the moment the locked carrier window
     * can't be found among the currently visible windows -- e.g. the OS
     * stopped exposing it to accessibility services once the user left it
     * for Home or another app (see findRelevantRoot()). Purely
     * informational: tells the user to come back so the in-flight attempt
     * can still complete within its existing timeout. Does not change what
     * the automation waits for, tries, or accepts as a result -- no PIN is
     * entered and no outcome is reported here or anywhere else based on
     * this notification. */
    private fun notifyWindowLost() {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, "payment_channel")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Action needed: return to Money Exchange")
            .setContentText("The USSD screen left the foreground -- return to it now to finish this payout.")
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        NotificationManagerCompat.from(this).notify(WINDOW_LOST_NOTIFICATION_ID, notification)
    }

    private fun isTransientLoadingDialog(text: String): Boolean {
        // Android's built-in USSD "waiting for carrier" placeholder
        // (com.android.phone's ussd_dialog_load string) -- "USSD code
        // running…" on most builds, "Running USSD code…" on some
        // OEM/locale variants. It never carries an input field of its own;
        // the real carrier response replaces it in a later window.
        val normalized = text.trim().lowercase()
        return normalized.contains("ussd code running") || normalized.contains("running ussd code")
    }

    private fun findDialogMessageText(node: AccessibilityNodeInfo): String? {
        // Heuristic: the longest plain text on screen — good enough for a
        // stock AlertDialog message; OEM dialogs may need a per-device tweak.
        var best: String? = null
        fun walk(n: AccessibilityNodeInfo) {
            val text = n.text?.toString()
            if (!text.isNullOrBlank() && (best == null || text.length > best!!.length)) best = text
            for (i in 0 until n.childCount) {
                val child = n.getChild(i) ?: continue
                walk(child)
                @Suppress("DEPRECATION")
                child.recycle()
            }
        }
        walk(node)
        return best
    }

    private fun findEditableNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findEditableNode(child)
            if (found != null) return found
            @Suppress("DEPRECATION")
            child.recycle()
        }
        return null
    }

    private fun findPositiveButton(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        findPositiveButtonByText(node)?.let { return it }

        // No clearly-labelled Send/OK/Dial/Yes button anywhere in this
        // dialog. A textless button can only be safely treated as the
        // confirm/submit action when it's the *only* clickable button
        // present -- with more than one, there's no way to tell it apart
        // from Cancel, and guessing risks tapping the wrong one and
        // cancelling a live-money transfer instead of confirming it.
        val clickableButtons = mutableListOf<AccessibilityNodeInfo>()
        collectClickableButtons(node, clickableButtons)
        if (clickableButtons.size == 1 && clickableButtons[0].text?.toString().isNullOrBlank()) {
            return clickableButtons[0]
        }
        for (button in clickableButtons) {
            @Suppress("DEPRECATION")
            button.recycle()
        }
        return null
    }

    private fun findPositiveButtonByText(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isClickable && node.className?.contains("Button") == true) {
            val text = node.text?.toString()?.lowercase()
            if (text != null && (text.contains("ok") || text.contains("send") || text.contains("dial") || text.contains("yes"))) {
                return node
            }
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findPositiveButtonByText(child)
            if (found != null) return found
            @Suppress("DEPRECATION")
            child.recycle()
        }
        return null
    }

    private fun collectClickableButtons(node: AccessibilityNodeInfo, out: MutableList<AccessibilityNodeInfo>) {
        if (node.isClickable && node.className?.contains("Button") == true) {
            out.add(node)
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collectClickableButtons(child, out)
        }
    }

    override fun onInterrupt() {
        ExchangeUssdBridge.serviceConnected = false
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance === this) instance = null
        ExchangeUssdBridge.serviceConnected = false
    }

    companion object {
        private const val TAG = "ExchangeUssdA11y"

        // Distinct from AgentBackgroundService's NOTIFICATION_ID (1001) and
        // SESSION_EXPIRED_NOTIFICATION_ID (1002) -- notification IDs are
        // shared across the whole app's notifications, not per-class.
        private const val WINDOW_LOST_NOTIFICATION_ID = 2001

        @Volatile
        var instance: ExchangeUssdAccessibilityService? = null
            private set
    }
}
