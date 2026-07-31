import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus } from "react-native";
import {
  checkSmsPermissions,
  isNativeModuleAvailable,
  openAppSettings,
  requestSmsPermissions,
  subscribeToIncomingSms,
} from "../sms/nativeSmsBridge";
import { parsePaymentSms } from "../sms/smsParsers";
import { smsDedupeKey } from "../sms/smsDedupe";
import { SmsRetryQueue } from "../sms/smsRetryQueue";
import { SmsProcessedStore } from "../sms/smsProcessedStore";
import { ApiRequestError, createSahalDataAgentApiClient } from "../api/sahalDataAgentApi";
import {
  ParsedPaymentSms,
  QueuedSmsLog,
  RawSms,
  SmsListenerOptions,
  SmsListenerState,
} from "../types/sms";

const DEFAULT_MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 2000; // exponential backoff: 2s, 4s, 8s, 16s, 32s
const RECENT_LOGS_CAP = 50;

/**
 * React hook for real-time payment-confirmation SMS detection in the Agent
 * App. Handles the full pipeline described in the requirements:
 *
 *   permission request/check -> native SMS event -> parse & validate
 *   -> de-duplicate -> upload to the existing backend -> auto-verify the
 *   matched order (pending -> in_progress) -> retry with backoff on failure
 *
 * Security posture: every SMS the native side delivers is run through
 * parsePaymentSms() FIRST. Anything that doesn't match a known operator's
 * genuine confirmation format is discarded immediately, in this same
 * synchronous step — it is never logged, stored, or uploaded. Only messages
 * that pass real format validation proceed any further.
 *
 * Usage:
 *   const listener = useSMSListener({
 *     apiBaseUrl: "https://api.sahaldata.so",
 *     getAccessToken: async () => SessionManager.accessToken(), // your existing auth module
 *     onSmsProcessed: (log, matchedOrderId) => { ... },
 *     onError: (err) => { ... },
 *   });
 *
 *   // in a "Start Listening" button:
 *   if (listener.state.permissionStatus !== "granted") {
 *     await listener.requestPermission();
 *   } else {
 *     listener.startListening();
 *   }
 */
export function useSMSListener(options: SmsListenerOptions) {
  const { apiBaseUrl, getAccessToken, onSmsProcessed, onError, maxRetries = DEFAULT_MAX_RETRIES } = options;

  const [state, setState] = useState<SmsListenerState>({
    permissionStatus: "denied",
    isListening: false,
    recentLogs: [],
    pendingRetryCount: 0,
  });

  const apiClientRef = useRef(createSahalDataAgentApiClient(apiBaseUrl));
  const retryQueueRef = useRef(new SmsRetryQueue());
  const processedStoreRef = useRef(new SmsProcessedStore());
  const inMemorySeenRef = useRef<Set<string>>(new Set()); // fast path, avoids an AsyncStorage read per SMS
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const emitError = useCallback(
    (code: SmsListenerErrorCodeLocal, message: string, detail?: unknown) => {
      onError?.({ code, message, detail });
    },
    [onError]
  );

  const pushRecentLog = useCallback((log: QueuedSmsLog) => {
    setState((prev) => ({
      ...prev,
      recentLogs: [log, ...prev.recentLogs].slice(0, RECENT_LOGS_CAP),
    }));
  }, []);

  /** Attempts to upload + verify one queued item. Returns true on success. */
  const attemptUpload = useCallback(
    async (item: QueuedSmsLog): Promise<boolean> => {
      const token = await getAccessToken();
      if (!token) {
        emitError("UPLOAD_FAILED", "No access token available — is the agent logged in?");
        return false;
      }

      try {
        const uploadResult = await apiClientRef.current.uploadSmsLog(item, token);

        if (uploadResult.matchedOrderId) {
          try {
            await apiClientRef.current.verifyPayment(uploadResult.matchedOrderId, uploadResult.id, token);
          } catch (verifyErr) {
            // The SMS log itself was uploaded successfully — that's the
            // important audit record. A failure to auto-verify shouldn't be
            // treated as an upload failure (no retry-from-scratch); surface
            // it distinctly so the agent can verify that order manually.
            emitError(
              "VERIFY_FAILED",
              `SMS logged, but auto-verifying order ${uploadResult.matchedOrderId} failed.`,
              verifyErr
            );
          }
        }

        await processedStoreRef.current.markProcessed(item.id);
        inMemorySeenRef.current.add(item.id);
        onSmsProcessed?.(item, uploadResult.matchedOrderId);
        pushRecentLog(item);
        return true;
      } catch (err) {
        const message = err instanceof ApiRequestError ? err.message : "Network error while uploading SMS log.";
        emitError("UPLOAD_FAILED", message, err);
        return false;
      }
    },
    [getAccessToken, emitError, onSmsProcessed, pushRecentLog]
  );

  /** Drains the retry queue with exponential backoff, one item at a time. */
  const drainRetryQueue = useCallback(async () => {
    const queued = await retryQueueRef.current.all();
    setState((prev) => ({ ...prev, pendingRetryCount: queued.length }));
    if (queued.length === 0) return;

    for (const item of queued) {
      if (item.attempts >= maxRetries) {
        // Never silently dropped — stays logged in the queue and visible via
        // pendingRetryCount / a dedicated "failed uploads" screen the app can
        // build against retryQueueRef; we simply stop auto-retrying it.
        continue;
      }
      const success = await attemptUpload(item);
      if (success) {
        await retryQueueRef.current.remove(item.id);
      } else {
        await retryQueueRef.current.recordFailure(item.id, "retry attempt failed");
      }
    }

    const remaining = await retryQueueRef.current.all();
    setState((prev) => ({ ...prev, pendingRetryCount: remaining.length }));
  }, [attemptUpload, maxRetries]);

  const scheduleRetry = useCallback(
    (attemptNumber: number) => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, Math.min(attemptNumber, 4));
      retryTimerRef.current = setTimeout(() => {
        drainRetryQueue();
      }, delay);
    },
    [drainRetryQueue]
  );

  /** The core pipeline: one raw SMS in, at most one upload attempt out. */
  const handleRawSms = useCallback(
    async (raw: RawSms) => {
      const parsed: ParsedPaymentSms | null = parsePaymentSms(raw);
      // Anything that isn't a recognized, validated payment confirmation is
      // discarded right here — never logged, stored, or uploaded.
      if (!parsed) return;

      const id = smsDedupeKey(raw);

      if (inMemorySeenRef.current.has(id) || (await processedStoreRef.current.has(id))) {
        return; // already processed — prevents duplicate processing of the same SMS
      }
      if (await retryQueueRef.current.has(id)) {
        return; // already queued from a previous delivery of the same broadcast
      }

      const item: QueuedSmsLog = { ...parsed, id, attempts: 0, createdAtMs: Date.now() };

      const success = await attemptUpload(item);
      if (!success) {
        await retryQueueRef.current.enqueue(item);
        setState((prev) => ({ ...prev, pendingRetryCount: prev.pendingRetryCount + 1 }));
        scheduleRetry(0);
      }
    },
    [attemptUpload, scheduleRetry]
  );

  const refreshPermissionStatus = useCallback(async () => {
    const status = await checkSmsPermissions();
    setState((prev) => ({ ...prev, permissionStatus: status }));
    return status;
  }, []);

  const requestPermission = useCallback(async () => {
    const status = await requestSmsPermissions();
    setState((prev) => ({ ...prev, permissionStatus: status }));
    if (status === "never_ask_again") {
      emitError("PERMISSION_PERMANENTLY_DENIED", "SMS permission was permanently denied.");
    } else if (status === "denied") {
      emitError("PERMISSION_DENIED", "SMS permission was denied.");
    }
    return status;
  }, [emitError]);

  const guideToSettings = useCallback(() => openAppSettings(), []);

  const startListening = useCallback(() => {
    if (state.isListening) return;
    if (!isNativeModuleAvailable()) {
      emitError("NATIVE_MODULE_UNAVAILABLE", "SmsListenerModule isn't linked — see android/SmsListenerModule.");
      return;
    }
    if (state.permissionStatus !== "granted") {
      emitError("PERMISSION_DENIED", "Cannot start listening without SMS permission.");
      return;
    }
    unsubscribeRef.current = subscribeToIncomingSms(handleRawSms);
    setState((prev) => ({ ...prev, isListening: true }));
  }, [state.isListening, state.permissionStatus, handleRawSms, emitError]);

  const stopListening = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    setState((prev) => ({ ...prev, isListening: false }));
  }, []);

  // Re-check permission whenever the app returns to the foreground — covers
  // the case where the user granted it from Settings while the app was
  // backgrounded (the "guide to App Settings" flow).
  useEffect(() => {
    refreshPermissionStatus();
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (next === "active") refreshPermissionStatus();
    });
    return () => sub.remove();
  }, [refreshPermissionStatus]);

  // Attempt to drain any queued retries once on mount (e.g. items left over
  // from a previous app session that never succeeded).
  useEffect(() => {
    drainRetryQueue();
  }, [drainRetryQueue]);

  // Always clean up the native subscription and any pending timer on unmount.
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  return {
    state,
    requestPermission,
    refreshPermissionStatus,
    guideToSettings,
    startListening,
    stopListening,
    /** Manually trigger a retry-queue drain (e.g. a pull-to-refresh on a "failed uploads" screen). */
    retryNow: drainRetryQueue,
  };
}

// Re-exported locally only to keep the emitError callback's type signature
// readable above without an extra import line at the top of the file.
type SmsListenerErrorCodeLocal = import("../types/sms").SmsListenerErrorCode;
