package com.dalab.internet.ussd

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

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
        val root = rootInActiveWindow ?: return
        try {
            val messageText = findDialogMessageText(root) ?: return
            val inputNode = findEditableNode(root)

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

            ExchangeUssdBridge.emit(UssdDialogEvent.DialogSeen(messageText, hasInput = inputNode != null))
        } catch (e: Exception) {
            Log.w(TAG, "scanAndAct failed: ${e.message}")
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
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
        if (node.isClickable && node.className?.contains("Button") == true) {
            val text = node.text?.toString()?.lowercase()
            if (text == null || text.contains("ok") || text.contains("send") || text.contains("dial") || text.contains("yes")) {
                return node
            }
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val found = findPositiveButton(child)
            if (found != null) return found
            @Suppress("DEPRECATION")
            child.recycle()
        }
        return null
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

        @Volatile
        var instance: ExchangeUssdAccessibilityService? = null
            private set
    }
}
