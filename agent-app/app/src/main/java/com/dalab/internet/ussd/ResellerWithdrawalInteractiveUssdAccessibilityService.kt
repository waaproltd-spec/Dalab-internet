package com.dalab.internet.ussd

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.dalab.internet.MainActivity
import com.dalab.internet.R
import com.dalab.internet.diagnostics.DiagnosticsLog

/**
 * Reads and drives the native USSD reply dialog for Reseller Withdraw's
 * interactive (eDahab-style multi-step) payout flow — the exact same
 * dialog-detection/window-lock/recovery approach
 * [ExchangeUssdAccessibilityService] already runs in production for Money
 * Exchange, copied here rather than shared so this new, less-proven eDahab
 * flow can never affect Money Exchange's own working automation. The only
 * real difference from Exchange's version: it consumes an arbitrary ordered
 * sequence of replies from [ResellerWithdrawalInteractiveUssdBridge]
 * (armReplyInjection, called once per step by
 * [ResellerWithdrawalInteractiveUssdOrchestrator]) instead of a single fixed
 * PIN slot.
 *
 * HONEST LIMITATION — same as Exchange's own: the reply dialog's package
 * name and node structure vary by OEM, and the heuristics below (longest
 * text node = the dialog message, first editable node = the reply field, a
 * Button whose text contains ok/send/dial/yes = the submit action) MUST be
 * validated against real target devices before this is trusted with real
 * money — see the Reseller Withdrawal payout setup screen for the manual
 * fallback that stays available regardless of whether this works on a given
 * device.
 */
class ResellerWithdrawalInteractiveUssdAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        ResellerWithdrawalInteractiveUssdBridge.serviceConnected = true
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (!ResellerWithdrawalInteractiveUssdBridge.armed) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) {
            return
        }
        scanAndAct()
    }

    internal fun scanAndAct() {
        val bridge = ResellerWithdrawalInteractiveUssdBridge
        if (!bridge.armed) return
        val root = findRelevantRoot() ?: return
        try {
            val messageText = findDialogMessageText(root) ?: return

            val windowPackage = root.packageName?.toString()
            val windowInfo = root.window
            val windowId = windowInfo?.id
            @Suppress("DEPRECATION")
            windowInfo?.recycle()
            val inputNode = findEditableNode(root)
            val looksLikeUssdDialog = inputNode != null || isTransientLoadingDialog(messageText) || findPositiveButton(root) != null
            if (!bridge.isWindowAllowed(windowPackage, windowId, looksLikeUssdDialog)) {
                if (bridge.shouldLogWindowMismatch(windowPackage)) {
                    val reason = if (bridge.lockedWindowPackageOrNull() == null) {
                        "doesn't look like the carrier dialog yet (no input field, button, or loading text)"
                    } else {
                        "doesn't match the carrier dialog's window for this attempt"
                    }
                    DiagnosticsLog.record(
                        "reseller_withdrawal_interactive_window_mismatch",
                        "Ignored foreground window \"$windowPackage\" -- $reason.",
                        isError = false,
                    )
                }
                return
            }

            val pendingReply = bridge.consumePendingReplyToInject()
            if (pendingReply != null) {
                if (inputNode == null) {
                    if (bridge.shouldLogPinFieldMiss()) {
                        DiagnosticsLog.record(
                            "reseller_withdrawal_interactive_field_miss",
                            "Locked window \"$windowPackage\" has no editable field yet -- reply not injected on this poll. Dialog text: \"$messageText\".",
                            isError = false,
                        )
                    }
                    bridge.restorePendingReplyToInject(pendingReply)
                    return
                } else {
                    val args = Bundle()
                    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, pendingReply)
                    inputNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                    val submit = findPositiveButton(root) ?: inputNode
                    submit.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    bridge.emit(UssdDialogEvent.PinSubmitted)
                    return
                }
            }

            if (isTransientLoadingDialog(messageText)) {
                return
            }

            if (inputNode == null || bridge.isEligibleForConfirmTapAtCurrentStage()) {
                val confirmButton = findPositiveButton(root)
                if (confirmButton != null) {
                    if (bridge.shouldAutoConfirm(messageText)) {
                        confirmButton.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                        bridge.emit(UssdDialogEvent.ConfirmationAdvanced(ConfirmationStage.PRE_PIN))
                    }
                    return
                }
            }

            bridge.emit(UssdDialogEvent.DialogSeen(messageText, hasInput = inputNode != null))
        } catch (e: Exception) {
            Log.w(TAG, "scanAndAct failed: ${e.message}")
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
    }

    private fun findRelevantRoot(): AccessibilityNodeInfo? {
        val bridge = ResellerWithdrawalInteractiveUssdBridge
        val locked = bridge.lockedWindowPackageOrNull() ?: return rootInActiveWindow
        val lockedId = bridge.lockedWindowIdOrNull()
        var found: AccessibilityNodeInfo? = null
        val seen = mutableListOf<String>()
        for (window in windows) {
            val windowRoot = window.root
            val windowPackage = windowRoot?.packageName?.toString()
            seen.add("${windowPackage ?: "?"}(type=${window.type}, id=${window.id})")
            val matchesById = lockedId != null && window.id == lockedId
            if (found == null && (windowPackage == locked || matchesById)) {
                found = windowRoot
            } else {
                @Suppress("DEPRECATION")
                windowRoot?.recycle()
            }
            @Suppress("DEPRECATION")
            window.recycle()
        }
        if (found == null) {
            if (bridge.shouldLogWindowSearchMiss()) {
                DiagnosticsLog.record(
                    "reseller_withdrawal_interactive_window_search_miss",
                    "Locked window \"$locked\" not found among ${seen.size} visible window(s): ${seen.joinToString()}." +
                        screenStateDiagnostics(),
                    isError = false,
                )
                notifyWindowLost()
            }
            if (bridge.shouldAttemptWindowRecovery()) {
                attemptForegroundRecovery()
            }
        }
        return found
    }

    private fun attemptForegroundRecovery() {
        val bridge = ResellerWithdrawalInteractiveUssdBridge
        DiagnosticsLog.record("reseller_withdrawal_interactive_window_recovery_attempt", "Recovery triggered after window-search-miss.", isError = false)
        try {
            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            }
            startActivity(intent)
        } catch (e: Exception) {
            DiagnosticsLog.record(
                "reseller_withdrawal_interactive_window_recovery_attempt",
                "Recovery failed -- could not bring MainActivity to the foreground: ${e.message}",
                isError = false,
            )
            bridge.recoveryAttemptFinished()
            return
        }
        Handler(Looper.getMainLooper()).postDelayed({
            if (!bridge.armed) {
                bridge.recoveryAttemptFinished()
                return@postDelayed
            }
            val recoveredRoot = findRelevantRoot()
            if (recoveredRoot != null) {
                @Suppress("DEPRECATION")
                recoveredRoot.recycle()
            }
            bridge.recoveryAttemptFinished()
            scanAndAct()
        }, 500L)
    }

    private fun screenStateDiagnostics(): String {
        val screenInteractive = getSystemService(PowerManager::class.java)?.isInteractive
        val keyguardLocked = getSystemService(KeyguardManager::class.java)?.isKeyguardLocked
        val wakeLockHeld = ResellerWithdrawalInteractiveUssdBridge.activeWakeLock?.isHeld
        return " screenInteractive=$screenInteractive keyguardLocked=$keyguardLocked wakeLockHeld=$wakeLockHeld"
    }

    private fun notifyWindowLost() {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, "payment_channel")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Action needed: return to Reseller Withdraw")
            .setContentText("The USSD screen left the foreground -- return to it now to finish this payout.")
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        NotificationManagerCompat.from(this).notify(WINDOW_LOST_NOTIFICATION_ID, notification)
    }

    private fun isTransientLoadingDialog(text: String): Boolean {
        val normalized = text.trim().lowercase()
        return normalized.contains("ussd code running") || normalized.contains("running ussd code")
    }

    private fun findDialogMessageText(node: AccessibilityNodeInfo): String? {
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
        ResellerWithdrawalInteractiveUssdBridge.serviceConnected = false
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance === this) instance = null
        ResellerWithdrawalInteractiveUssdBridge.serviceConnected = false
    }

    companion object {
        private const val TAG = "RsWdInteractiveA11y"
        private const val WINDOW_LOST_NOTIFICATION_ID = 2002

        @Volatile
        var instance: ResellerWithdrawalInteractiveUssdAccessibilityService? = null
            private set
    }
}
