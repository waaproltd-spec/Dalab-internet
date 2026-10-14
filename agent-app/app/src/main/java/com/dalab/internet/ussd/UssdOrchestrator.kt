package com.dalab.internet.ussd

import android.content.Context
import com.dalab.internet.auth.DeviceIdentity
import com.dalab.internet.data.Order
import com.dalab.internet.data.OrderStatus
import com.dalab.internet.diagnostics.DiagnosticsLog
import com.dalab.internet.network.ApiClient
import com.dalab.internet.network.DialAttemptResultRequest
import com.dalab.internet.network.DialAttemptStartRequest
import com.dalab.internet.network.VerifyPaymentRequest
import com.dalab.internet.queue.PendingActionQueue
import com.dalab.internet.queue.RetryClassifier
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** Gson-serialized payload for a queued dial-attempt audit replay — carries
 * everything needed to redo both the "start" and "result" logging calls
 * together (see [UssdOrchestrator.replayDialAttemptAudit]), since the two are
 * only ever meaningfully retried as a pair: the dial itself already happened
 * by the time either logging call can fail, so there's no separate "pending"
 * state worth persisting — only the already-known final outcome. */
data class DialAttemptAuditAction(
    val orderId: String,
    val simSlot: Int,
    val ussdString: String,
    val attemptNumber: Int,
    val status: String,
    val responseMessage: String?,
    // Whether this is the last attempt this order will get (success, a
    // non-retryable outcome, or the final of maxAttempts retries) — see
    // dialWithRetry. The backend only marks the order 'failed' when this is
    // true, so a first-attempt failure that's about to be retried doesn't
    // show the customer "Failed" moments before a retry might succeed.
    val isFinalAttempt: Boolean = true,
)

/**
 * The end-to-end automatic flow described in the spec:
 *   SMS matched -> verify payment -> pick correct SIM via routing config
 *   -> dial USSD -> wait for response -> mark order Success/Failed
 *   -> retry on failure, never silently drop.
 *
 * Called from SmsReceiver once /agent/sms-logs returns a matchedOrderId —
 * see SmsReceiver.kt's notifyAgent() path, which this replaces/extends with
 * the actual automatic dial rather than only a notification.
 */
/** Whether a dial may be retried automatically: only a CONFIRMED failure
 * (the carrier/OS refused it or replied with a known failure). A timeout or
 * an unrecognised reply may mean the money already went out, so it is never
 * re-dialed automatically. Unit-tested in DialRetryPolicyTest. */
internal fun isAutomaticallyRetryable(result: DialResult): Boolean =
    !result.noRetry && result.outcome == DialOutcome.FAILED

class UssdOrchestrator(context: Context, private val maxAttempts: Int = 3) {
    private val dialer = UssdDialer(context)
    private val packageMenuRunner = PackageInteractiveUssdRunner(context)
    private val appContext: Context = context.applicationContext

    suspend fun processMatchedOrder(orderId: String, smsLogId: String?): DialResult {
        if (!claimOrder(orderId)) {
            DiagnosticsLog.record(
                "duplicate_dial_guard",
                "Order $orderId is already being processed by another in-flight call on this device (e.g. a concurrent self-heal sweep or manual retry) — skipping to prevent a duplicate recharge.",
                isError = false,
            )
            return DialResult(DialOutcome.DUPLICATE_SKIPPED, "Already being processed — skipped to avoid a duplicate recharge.")
        }
        try {
            return processMatchedOrderLocked(orderId, smsLogId)
        } finally {
            releaseOrder(orderId)
        }
    }

    private suspend fun processMatchedOrderLocked(orderId: String, smsLogId: String?): DialResult {
        interruptedDialResult(orderId)?.let { return it }
        // Step 1: verify payment (pending -> in_progress), which also triggers
        // the backend's own USSD string generation (see dalab-backend.zip,
        // routes/orders.js -> generateUssdForOrder).
        val verifyResponse = try {
            RetryClassifier.requireSuccessful(ApiClient.service.verifyPayment(orderId, VerifyPaymentRequest(smsLogId)))
        } catch (e: Exception) {
            // No connectivity right now, or the server responded with a
            // non-2xx status (as opposed to a genuinely rejected request) —
            // the caller (SmsUploadFlow) queues a retry instead of losing
            // this order to a transient network blip or backend hiccup.
            val outcome = if (RetryClassifier.isRetryable(e)) DialOutcome.NETWORK_UNAVAILABLE else DialOutcome.FAILED
            DiagnosticsLog.record("verify_payment", "Could not reach server (order $orderId): ${e.message}")
            return DialResult(outcome, "Could not reach server to verify payment: ${e.message}")
        }
        val order = verifyResponse.body() ?: return DialResult(DialOutcome.FAILED, "Verify-payment returned no order.")
        // verify-payment's CAS is idempotent on status (a second call for an
        // already-completed order is a no-op that just returns current
        // state) — but the returned order still carries its old
        // ussdGenerated string, so without this check the code below would
        // dial AGAIN for an order that already finished. This is the exact
        // mechanism that turned one real payment into 3 real USSD debits.
        if (order.status == OrderStatus.COMPLETED) {
            return DialResult(DialOutcome.SUCCESS, "Order already completed — skipping redundant dial.")
        }
        val ussdString = order.ussdGenerated
            ?: return DialResult(DialOutcome.FAILED, "No USSD template matched this order — check USSD Services in the dashboard.")

        // Step 2: the SIM the Admin assigned to this order (template pin, else
        // this phone's primary SIM Routing). An order assigned to another
        // phone is left for that phone -- its self-heal sweep picks it up --
        // and is never dialed here on this phone's own SIM.
        val configuredSlot: Int = when (val assigned = assignedSimFor(order)) {
            is AssignedSim.ThisPhone -> assigned.slot
            is AssignedSim.OtherPhone -> return assignedElsewhere(order, assigned)
            AssignedSim.NotConfigured -> return DialResult(
                DialOutcome.ASSIGNED_TO_OTHER_SIM,
                "${order.companyName} isn't routed to this phone — the phone assigned in SIM Routing dials it.",
            )
            // A cold-start refresh failure, not a real "not configured" —
            // keep this in NETWORK_UNAVAILABLE so SmsUploadFlow preserves
            // the durable retry-queue entry instead of dropping it terminal.
            AssignedSim.LoadFailed -> return DialResult(DialOutcome.NETWORK_UNAVAILABLE, "Could not load SIM routing (network) — will retry.")
        }
        return deliver(order, configuredSlot, ussdString)
    }

    private suspend fun assignedSimFor(order: Order): AssignedSim {
        val pinned = order.ussdDeviceId != null && order.ussdSimSlot != null
        return resolveAssignedSim(
            order.ussdDeviceId,
            order.ussdSimSlot,
            DeviceIdentity.deviceId(),
            if (pinned) SimSlotResult.NotConfigured else SimRoutingRepository.simSlotFor(order.companyId),
        )
    }

    private fun assignedElsewhere(order: Order, assigned: AssignedSim.OtherPhone): DialResult {
        DiagnosticsLog.record(
            "sim_routing",
            "Order ${order.id} is assigned to ${assigned.deviceId} · SIM ${assigned.slot} — not dialed on this phone.",
            isError = false,
        )
        return DialResult(DialOutcome.ASSIGNED_TO_OTHER_SIM, "Assigned to ${assigned.deviceId} · SIM ${assigned.slot} — that phone dials it.")
    }

    /**
     * Manual, agent-triggered execution from the Orders list — used when an
     * agent wants to force a specific SIM (e.g. the auto-matched SMS path
     * didn't fire, or the recommended slot is temporarily unusable) rather
     * than waiting for SmsReceiver to trigger [processMatchedOrder]. Still
     * goes through verify-payment first so the backend generates the USSD
     * string and the order state transitions the same way either path does;
     * the only difference is the caller supplies `forcedSimSlot` instead of
     * this resolving it from SimRoutingRepository/the template override.
     */
    suspend fun executeManually(
        orderId: String,
        forcedSimSlot: Int,
        // The agent saw an "unknown/outdated SIM balance" warning and chose
        // to dial anyway (never overrides an insufficient balance).
        confirmUnknownBalance: Boolean = false,
        // Started by the agent on the Order screen, which shows the balance
        // warning itself -- no extra system notification needed then.
        fromUi: Boolean = false,
    ): DialResult {
        if (!claimOrder(orderId)) {
            DiagnosticsLog.record(
                "duplicate_dial_guard",
                "Order $orderId is already being processed by another in-flight call on this device (e.g. a concurrent self-heal sweep or the automatic SMS-triggered path) — skipping to prevent a duplicate recharge.",
                isError = false,
            )
            return DialResult(DialOutcome.DUPLICATE_SKIPPED, "Already being processed — skipped to avoid a duplicate recharge.")
        }
        try {
            return executeManuallyLocked(orderId, forcedSimSlot, confirmUnknownBalance, fromUi)
        } finally {
            releaseOrder(orderId)
        }
    }

    private suspend fun executeManuallyLocked(orderId: String, forcedSimSlot: Int, confirmUnknownBalance: Boolean, fromUi: Boolean): DialResult {
        interruptedDialResult(orderId)?.let { return it }
        val verifyResponse = try {
            RetryClassifier.requireSuccessful(ApiClient.service.verifyPayment(orderId, VerifyPaymentRequest(null)))
        } catch (e: Exception) {
            val outcome = if (RetryClassifier.isRetryable(e)) DialOutcome.NETWORK_UNAVAILABLE else DialOutcome.FAILED
            DiagnosticsLog.record("manual_execute", "Could not reach server (order $orderId): ${e.message}")
            return DialResult(outcome, "Could not reach server to verify payment: ${e.message}")
        }
        val order = verifyResponse.body() ?: return DialResult(DialOutcome.FAILED, "Verify-payment returned no order.")
        if (order.status == OrderStatus.COMPLETED) {
            return DialResult(DialOutcome.SUCCESS, "Order already completed — skipping redundant dial.")
        }
        val ussdString = order.ussdGenerated
            ?: return DialResult(DialOutcome.FAILED, "No USSD template matched this order — check USSD Services in the dashboard.")
        // Even a manual dial uses only the assigned SIM -- the server
        // refuses any other one too (not_assigned_sim).
        when (val assigned = assignedSimFor(order)) {
            is AssignedSim.ThisPhone -> if (assigned.slot != forcedSimSlot) {
                return DialResult(DialOutcome.ASSIGNED_TO_OTHER_SIM, "This order is assigned to SIM ${assigned.slot} — SIM $forcedSimSlot doesn't dial it.")
            }
            is AssignedSim.OtherPhone -> return assignedElsewhere(order, assigned)
            // This phone's routing cache may simply not have caught up with
            // an Admin change yet (the self-heal sweep passes the server's
            // own assignment): the server decides, and refuses any SIM that
            // isn't the assigned one.
            AssignedSim.NotConfigured, AssignedSim.LoadFailed -> Unit
        }
        return deliver(order, forcedSimSlot, ussdString, confirmUnknownBalance, notifyBalanceBlock = !fromUi)
    }

    /**
     * A normal order (sendCount 1) is dialed exactly as it always was. An
     * Extra Package order (Admin > Add Extra Package) is dialed once per
     * delivery it still owes -- resuming from the server's own count of
     * confirmed deliveries, so a restart never re-sends one already done.
     * Stricter than the single path on purpose: each attempt must be
     * logged, and each success confirmed by the server, before the next
     * delivery is dialed; anything unconfirmed stops the run rather than
     * risk sending more than the Send Count.
     */
    private suspend fun deliver(
        order: Order,
        simSlot: Int,
        ussdString: String,
        confirmUnknownBalance: Boolean = false,
        notifyBalanceBlock: Boolean = true,
    ): DialResult {
        val result = deliverInner(order, simSlot, ussdString, confirmUnknownBalance)
        if (result.outcome == DialOutcome.INSUFFICIENT_SIM_BALANCE || result.outcome == DialOutcome.SIM_BALANCE_UNVERIFIED) {
            if (notifyBalanceBlock) SimBalanceAlerts.notifyBlocked(appContext, order.id, result)
        } else {
            // Got past the balance gate (recharged, or confirmed): a later
            // refusal for this order is a new problem and alerts again.
            SimBalanceAlerts.clear(order.id)
        }
        return result
    }

    private suspend fun deliverInner(order: Order, simSlot: Int, ussdString: String, confirmUnknownBalance: Boolean): DialResult {
        // Menu (interactive) package, e.g. Somtel Dhameys Plus -- driven by
        // PackageInteractiveUssdRunner instead of a one-shot dial.
        val plan = if (order.ussdDialMode == "interactive") {
            order.ussdPlan ?: return DialResult(DialOutcome.FAILED, "This menu USSD order has no dial plan — nothing was dialed.")
        } else {
            null
        }
        val sendCount = order.sendCount ?: 1
        // Every order is strict: a dial only starts once the server has
        // logged its attempt (offline -> retried later, never dialed blind),
        // numbered after the order's existing attempts so a later round never
        // reuses an already-resolved attempt row (its result would be lost).
        if (sendCount <= 1) {
            return dialWithRetryRun(
                order.id, simSlot, ussdString, attemptBase = (order.nextAttemptNumber ?: 1) - 1,
                strict = true, confirmUnknownBalance = confirmUnknownBalance, plan = plan,
            ).result
        }

        var done = order.deliveriesDone ?: 0
        var nextAttempt = order.nextAttemptNumber ?: 1
        while (done < sendCount) {
            val run = dialWithRetryRun(order.id, simSlot, ussdString, attemptBase = nextAttempt - 1, strict = true, confirmUnknownBalance = confirmUnknownBalance, plan = plan)
            nextAttempt += run.attemptsUsed
            if (run.result.outcome != DialOutcome.SUCCESS || run.stoppedEarly) return run.result
            if (!run.reportedOnline) {
                DiagnosticsLog.record(
                    "extra_package",
                    "Order ${order.id}: delivery ${done + 1} of $sendCount sent, but the server hasn't confirmed it yet — stopping so nothing is sent twice.",
                    isError = true,
                )
                return DialResult(
                    DialOutcome.FAILED,
                    "Delivery ${done + 1} of $sendCount was sent, but its result couldn't reach the server yet. Stopped so nothing is sent twice — reopen the order to continue once it syncs.",
                )
            }
            done++
            DiagnosticsLog.record("extra_package", "Order ${order.id}: delivery $done of $sendCount sent.", isError = false)
            if (done < sendCount) delay(BETWEEN_DELIVERIES_MS)
        }
        return DialResult(DialOutcome.SUCCESS, "All $sendCount deliveries sent.")
    }


    /** One delivery's dial with retries. [attemptBase] offsets the attempt
     * numbers (0 for a normal order, which keeps its 1..maxAttempts). With
     * [strict] (Extra Package deliveries), an attempt is only dialed once
     * the server has logged it -- offline returns NETWORK_UNAVAILABLE so
     * the whole order is retried later from the server's count, and a
     * refusal (e.g. every delivery is already done) returns FAILED --
     * instead of dialing anyway. */
    private suspend fun dialWithRetryRun(
        orderId: String,
        simSlot: Int,
        ussdString: String,
        attemptBase: Int,
        strict: Boolean,
        confirmUnknownBalance: Boolean = false,
        plan: UssdPlan? = null,
    ): DeliveryRun {
        var attemptsUsed = 0
        var reportedOnline = false
        // Retry on transient failure/timeout (not on
        // NO_SIM_CONFIGURED/NO_SIM_PRESENT/PERMISSION_DENIED — those need a
        // human to fix, retrying won't help and would just waste USSD
        // sessions with the carrier).
        var lastResult: DialResult = DialResult(DialOutcome.FAILED, "Not attempted")
        for (attempt in 1..maxAttempts) {
            val attemptNumber = attemptBase + attempt
            val attemptId = if (strict) {
                when (val started = startDialAttemptLogStrict(orderId, simSlot, ussdString, attemptNumber, confirmUnknownBalance)) {
                    is StrictStart.Started -> started.id
                    is StrictStart.BalanceBlocked -> return DeliveryRun(started.result, attemptsUsed, reportedOnline = false, stoppedEarly = true)
                    is StrictStart.Offline -> return DeliveryRun(
                        DialResult(DialOutcome.NETWORK_UNAVAILABLE, "Couldn't reach the server before sending — will retry."),
                        attemptsUsed, reportedOnline = false, stoppedEarly = true,
                    )
                    is StrictStart.Refused -> return DeliveryRun(
                        DialResult(started.outcome, started.message, noRetry = true), attemptsUsed, reportedOnline = false, stoppedEarly = true,
                    )
                }
            } else {
                // A normal order still dials when the start-log merely fails
                // (offline), as before -- but never when the server refused
                // it for SIM balance: that's the backend's enforcement and
                // must not be bypassed by dialing anyway.
                when (val log = startDialAttemptLog(orderId, simSlot, ussdString, attemptNumber, confirmUnknownBalance)) {
                    is StartLog.BalanceBlocked -> return DeliveryRun(log.result, attemptsUsed, reportedOnline = false, stoppedEarly = true)
                    is StartLog.Logged -> log.id
                }
            }
            attemptsUsed = attempt

            // subscriptionId is resolved inside the loop (not before it) so
            // a missing SIM still produces exactly one logged dial-attempt
            // row instead of returning before startDialAttemptLog ever runs
            // — previously this left zero trace anywhere (server or local)
            // that an attempt was even made.
            lastResult = when (val lookup = dialer.subscriptionIdForSlot(simSlot)) {
                // A lost CALL_PHONE/READ_PHONE_STATE permission looks identical
                // to a missing SIM at the API level — reported distinctly here so
                // it's never confused with an actually-empty SIM tray again.
                SubscriptionLookupResult.PermissionMissing -> DialResult(
                    DialOutcome.PERMISSION_DENIED,
                    "Required phone permissions aren't granted on this device — check Settings > Apps > Dalab Agent > Permissions.",
                )
                SubscriptionLookupResult.NotPresent -> DialResult(DialOutcome.NO_SIM_PRESENT, "SIM $simSlot isn't physically inserted on this device.")
                is SubscriptionLookupResult.Found -> {
                    // Internet Store recharge genuinely dials a real USSD
                    // code here (TelephonyManager.sendUssdRequest(), inside
                    // dialer.dial() below) — it must wait its turn for THIS
                    // order's own SIM slot exactly like every other flow
                    // that can dial that same slot (Money Exchange/eBadal,
                    // Reseller Withdraw, a Wallet Name Lookup); see
                    // UssdSimLock's doc comment. Held for exactly the span
                    // of this one dial attempt, not the whole retry loop --
                    // a later attempt (after the backoff delay below)
                    // re-acquires, so a different request queued for this
                    // slot in between isn't blocked behind this order's own
                    // retry backoff.
                    val ticket = UssdSimLock.acquire(simSlot, "internet_store:$orderId:attempt$attemptNumber", System.currentTimeMillis())
                    // On disk before the carrier is contacted: if the app
                    // dies from here on, the next run reports this dial as
                    // outcome-unknown instead of dialing again.
                    DialJournal.begin(appContext, DialJournal.Entry(orderId, attemptId, attemptNumber, simSlot, System.currentTimeMillis()))
                    try {
                        // UssdDialer only catches SecurityException around the telephony
                        // call — other stack exceptions (e.g. IllegalStateException when
                        // the modem/RIL isn't ready) previously escaped uncaught all the
                        // way to QueueDrainer, which then classified them terminal and
                        // dropped a genuinely transient failure forever. Catching here
                        // converts it into a normal FAILED outcome, which this same retry
                        // loop already knows how to handle.
                        try {
                            if (plan != null) {
                                packageMenuRunner.execute(orderId, plan, lookup.subscriptionId) { fetchUssdPin(orderId) }
                            } else {
                                dialer.dial(lookup.subscriptionId, ussdString)
                            }
                        } catch (e: Exception) {
                            DiagnosticsLog.record("ussd_dial", "Dial threw (order $orderId, attempt $attemptNumber): ${e.message}", isError = true)
                            DialResult(DialOutcome.FAILED, "Dial error: ${e.message}")
                        }
                    } finally {
                        UssdSimLock.release(ticket)
                    }
                }
            }
            // Whether THIS attempt is the last one the order will ever get —
            // a non-retryable outcome (anything but FAILED/TIMEOUT/AMBIGUOUS)
            // is final on the spot; a retryable one is only final once
            // maxAttempts is reached. Computed before reporting so the
            // backend never marks the order 'failed' on attempt 1 of 3 while
            // a retry is still about to run — see PUT /agent/dial-attempts.
            // Only a CONFIRMED failure is retried (the carrier/OS refused the
            // request, or replied with a known failure). A timeout or an
            // unrecognised reply may mean the money already went out -- the
            // PIN is inside a one-shot dial string -- so it is reported as
            // outcome-unknown and never re-dialed automatically; the server
            // then refuses further attempts until a person checks it. A real
            // payment was once sent 3 times this way (Amtel, see UssdDialer).
            val retryable = isAutomaticallyRetryable(lastResult)
            val isFinalAttempt = !retryable || attempt == maxAttempts
            reportedOnline = reportDialResult(orderId, simSlot, ussdString, attemptNumber, attemptId, lastResult, isFinalAttempt, strict)
            // The result is now reported online or saved for replay.
            DialJournal.clear(appContext, orderId)

            if (lastResult.outcome == DialOutcome.SUCCESS) return DeliveryRun(lastResult, attemptsUsed, reportedOnline, stoppedEarly = false)
            if (!retryable) {
                // permission/config/no-SIM problems — don't retry blindly
                return DeliveryRun(lastResult, attemptsUsed, reportedOnline, stoppedEarly = false)
            }
            if (attempt < maxAttempts) {
                delay(2000L * attempt) // simple linear backoff between USSD retries
                // A concurrent path (a second SMS match, another device, or the
                // self-heal sweep) may have already completed this order while
                // this attempt was failing/timing out locally — re-check before
                // burning another real USSD session on the carrier. Fails open
                // (keeps retrying) on any network error here, so a flaky status
                // check can never itself cause a genuine payment to go undialed.
                val alreadyCompleted = try {
                    ApiClient.service.getOrder(orderId).body()?.status == OrderStatus.COMPLETED
                } catch (_: Exception) {
                    false
                }
                if (alreadyCompleted) {
                    return DeliveryRun(
                        DialResult(DialOutcome.SUCCESS, "Order already completed — skipping remaining retries."),
                        attemptsUsed, reportedOnline, stoppedEarly = true,
                    )
                }
            }
        }
        return DeliveryRun(lastResult, attemptsUsed, reportedOnline, stoppedEarly = false)
    }

    /** The provider PIN for a menu order's PIN step -- only while that
     * order is being dialed (the server checks). Null on any failure, in
     * which case the runner cancels before paying. Never logged. */
    private suspend fun fetchUssdPin(orderId: String): String? = try {
        val response = ApiClient.service.getUssdPin(orderId)
        if (response.isSuccessful) response.body()?.pin?.takeIf { it.isNotBlank() } else null
    } catch (_: Exception) {
        null
    }

    private data class DeliveryRun(
        val result: DialResult,
        val attemptsUsed: Int,
        // Whether the last attempt's result was confirmed by the server
        // (not just queued for a later replay).
        val reportedOnline: Boolean,
        // Stopped before finishing this delivery's own retries for a reason
        // other than its outcome (order completed elsewhere, offline, refused).
        val stoppedEarly: Boolean,
    )

    private sealed class StrictStart {
        data class Started(val id: String) : StrictStart()
        data class BalanceBlocked(val result: DialResult) : StrictStart()
        object Offline : StrictStart()
        data class Refused(val message: String, val outcome: DialOutcome = DialOutcome.FAILED) : StrictStart()
    }

    private sealed class StartLog {
        data class Logged(val id: String?) : StartLog()
        data class BalanceBlocked(val result: DialResult) : StartLog()
    }

    private fun startRequest(simSlot: Int, ussdString: String, attemptNumber: Int, confirmUnknownBalance: Boolean) =
        DialAttemptStartRequest(simSlot, ussdString, attemptNumber, confirmUnknownBalance.takeIf { it })

    private suspend fun startDialAttemptLogStrict(orderId: String, simSlot: Int, ussdString: String, attemptNumber: Int, confirmUnknownBalance: Boolean): StrictStart {
        val response = try {
            ApiClient.service.startDialAttempt(orderId, startRequest(simSlot, ussdString, attemptNumber, confirmUnknownBalance))
        } catch (e: Exception) {
            DiagnosticsLog.record("dial_attempt_log", "Start-log failed (order $orderId, attempt $attemptNumber): ${e.message} — not dialing.", isError = false)
            return StrictStart.Offline
        }
        val id = response.body()?.id
        if (response.isSuccessful && id != null) return StrictStart.Started(id)
        if (response.code() >= 500) return StrictStart.Offline
        // The error body can be read only once: parse it here for both the
        // SIM-balance refusal and the other refusal codes.
        val (code, serverMessage) = errorCodeAndMessage(response)
        if (response.code() == 409) SimBalanceAlerts.refusalFromJson(code, serverMessage)?.let { return StrictStart.BalanceBlocked(it) }
        val message = "Server refused this dial (HTTP ${response.code()}${code?.let { ", $it" } ?: ""}) — nothing was sent." +
            (serverMessage?.let { " $it" } ?: "")
        DiagnosticsLog.record("dial_attempt_log", "Order $orderId, attempt $attemptNumber: $message", isError = true)
        // An earlier dial's result is unknown or another phone is dialing it:
        // not a failure of this order, just "already being handled".
        val outcome = when {
            code == "not_assigned_sim" -> DialOutcome.ASSIGNED_TO_OTHER_SIM
            code != null && code in REFUSAL_ALREADY_HANDLED -> DialOutcome.DUPLICATE_SKIPPED
            else -> DialOutcome.FAILED
        }
        return StrictStart.Refused(message, outcome)
    }

    private fun errorCodeAndMessage(response: retrofit2.Response<*>): Pair<String?, String?> = try {
        val json = response.errorBody()?.string()?.let { org.json.JSONObject(it) }
        Pair(json?.optString("code")?.takeIf { it.isNotBlank() }, json?.optString("error")?.takeIf { it.isNotBlank() })
    } catch (_: Exception) {
        Pair(null, null)
    }

    /**
     * A dial for [orderId] started on this phone and its result was never
     * recorded (the app died mid-dial). Reports it as outcome-unknown and
     * returns a result that stops this run -- nothing is dialed again until
     * a person checks whether the money went out. Null when there's nothing
     * interrupted.
     */
    private suspend fun interruptedDialResult(orderId: String): DialResult? {
        val entry = DialJournal.get(appContext, orderId) ?: return null
        val message = "The app stopped while dial attempt #${entry.attemptNumber} (SIM ${entry.simSlot}) was running, so the carrier's result is unknown. " +
            "Check whether the customer received it before sending again."
        DiagnosticsLog.record("dial_interrupted", "Order $orderId: $message", isError = true)
        if (entry.attemptId != null) {
            val reported = try {
                ApiClient.service.reportDialResult(entry.attemptId, DialAttemptResultRequest("ambiguous", message, true)).isSuccessful
            } catch (_: Exception) {
                false
            }
            // Not reported yet: keep the journal entry and retry later (the
            // caller keeps its queued retry on NETWORK_UNAVAILABLE). Still no dial.
            if (!reported) return DialResult(DialOutcome.NETWORK_UNAVAILABLE, "$message Will report this once the server is reachable.", noRetry = true)
        }
        DialJournal.clear(appContext, orderId)
        return DialResult(DialOutcome.AMBIGUOUS, message, noRetry = true)
    }

    private suspend fun startDialAttemptLog(orderId: String, simSlot: Int, ussdString: String, attemptNumber: Int, confirmUnknownBalance: Boolean): StartLog {
        return try {
            val response = ApiClient.service.startDialAttempt(orderId, startRequest(simSlot, ussdString, attemptNumber, confirmUnknownBalance))
            SimBalanceAlerts.refusalFrom(response)?.let {
                DiagnosticsLog.record("sim_balance", "Order $orderId: ${it.responseMessage}", isError = true)
                return StartLog.BalanceBlocked(it)
            }
            StartLog.Logged(response.body()?.id)
        } catch (e: Exception) {
            // Dial isn't blocked; reportDialResult below queues a full replay
            // covering both steps once the (already-known) outcome is in.
            DiagnosticsLog.record("dial_attempt_log", "Start-log failed (order $orderId, attempt $attemptNumber): ${e.message}", isError = false)
            StartLog.Logged(null)
        }
    }

    /** Returns true when the result was reported online (false: queued
     * for a later replay). With [strict], a non-2xx reply counts as not
     * reported. */
    private suspend fun reportDialResult(
        orderId: String, simSlot: Int, ussdString: String, attemptNumber: Int,
        attemptId: String?, result: DialResult, isFinalAttempt: Boolean, strict: Boolean = false,
    ): Boolean {
        // "ambiguous" is reported as its own status, distinct from both
        // "success" and "failed" — the backend only ever completes an order
        // on "success" (see ussd.routes.ts), so a response that merely LOOKS
        // like a response (as opposed to a genuine carrier confirmation)
        // can never silently complete an order, while still being clearly
        // recorded (with its raw text) instead of collapsed into "failed".
        // A plain timeout is "result unknown", never "failed": the money may
        // have gone out with only the reply lost (Amtel DLB780359065).
        val status = reportedDialStatus(result)
        if (attemptId != null) {
            try {
                val response = ApiClient.service.reportDialResult(
                    attemptId,
                    DialAttemptResultRequest(status, result.responseMessage, isFinalAttempt),
                )
                if (!strict || response.isSuccessful) {
                    return true // both logging calls succeeded online — nothing to queue
                }
            } catch (_: Exception) {
                // fall through — queue a full start+report replay below
            }
        }
        // Either the start call failed (attemptId null) or the result report
        // did — queue a full replay of both. Safe to redo "start" even if it
        // actually succeeded the first time: the backend's unique index on
        // (order_id, attempt_number) makes it an idempotent upsert.
        DiagnosticsLog.record("dial_attempt_log", "Queued full replay (order $orderId, attempt $attemptNumber)", isError = false)
        PendingActionQueue.enqueue(
            id = UUID.randomUUID().toString(),
            type = PendingActionQueue.Type.DIAL_ATTEMPT_AUDIT,
            payload = DialAttemptAuditAction(orderId, simSlot, ussdString, attemptNumber, status, result.responseMessage, isFinalAttempt),
        )
        return false
    }

    companion object {
        // A short pause between an Extra Package's deliveries, so the
        // carrier finishes one USSD session before the next starts.
        private const val BETWEEN_DELIVERIES_MS = 3000L

        // Server refusal codes (POST /agent/orders/:id/dial-attempts) that
        // mean "this order is already being handled", not a failure.
        private val REFUSAL_ALREADY_HANDLED = setOf("previous_attempt_unresolved", "attempt_in_progress_elsewhere", "attempt_already_resolved", "order_not_dialable")

        // Process-wide (not per-instance): OrderDetailScreen, OrdersListScreen,
        // SmsUploadFlow, and SelfHealSweeper each construct their own
        // UssdOrchestrator instance, so an instance-level lock would do
        // nothing to stop two of them racing on the SAME orderId at the same
        // time -- confirmed root cause of a real incident where one payment
        // produced two real USSD dials/deductions (the direct SMS-triggered
        // path and a concurrent self-heal sweep both passed the existing
        // already-COMPLETED check, since neither dial had finished yet, and
        // both proceeded to physically dial). This is the single choke point
        // both processMatchedOrder and executeManually now go through.
        private val inFlightMutex = Mutex()
        private val inFlightOrderIds = mutableSetOf<String>()

        private suspend fun claimOrder(orderId: String): Boolean = inFlightMutex.withLock {
            if (orderId in inFlightOrderIds) false else { inFlightOrderIds.add(orderId); true }
        }

        private suspend fun releaseOrder(orderId: String) {
            inFlightMutex.withLock { inFlightOrderIds.remove(orderId) }
        }

        /** Replays a queued [DialAttemptAuditAction] — called by QueueDrainer.
         * Lets any exception propagate so the caller can classify it via
         * RetryClassifier (retryable -> keep queued, terminal -> drop). */
        suspend fun replayDialAttemptAudit(action: DialAttemptAuditAction) {
            val startResponse = RetryClassifier.requireSuccessful(
                ApiClient.service.startDialAttempt(
                    action.orderId,
                    DialAttemptStartRequest(action.simSlot, action.ussdString, action.attemptNumber),
                )
            )
            val attemptId = startResponse.body()?.id ?: error("startDialAttempt returned no id")
            RetryClassifier.requireSuccessful(
                ApiClient.service.reportDialResult(
                    attemptId,
                    DialAttemptResultRequest(action.status, action.responseMessage, action.isFinalAttempt),
                )
            )
        }
    }
}
