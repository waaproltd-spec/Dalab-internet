/**
 * Shared types for the SMS payment-listener feature.
 * Mirrors the real backend contract in dalab-backend.zip (src/routes/*.js)
 * and the order lifecycle already implemented there: pending -> in_progress
 * -> completed (or failed / cancelled).
 */

export type TelecomOperator = "Hormuud" | "Somnet" | "Somtel" | "Amtel";

export type OrderStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/** A raw SMS as delivered by the native Android bridge. */
export interface RawSms {
  sender: string;
  body: string;
  /** Epoch milliseconds, as reported by the device. */
  timestampMs: number;
}

/** The result of successfully parsing a payment confirmation SMS. */
export interface ParsedPaymentSms {
  operator: TelecomOperator;
  /** The customer's phone number, as it appears in the SMS body. */
  customerPhone: string;
  /** Transaction amount, parsed as a number (matches orders.amount server-side). */
  amount: number;
  /** ISO 8601 — parsed from the SMS where possible, device receipt time otherwise. */
  transactionDateTime: string;
  /** Original values, kept for the audit log / troubleshooting. */
  rawSender: string;
  rawBody: string;
}

/** One entry in the hook's internal processing/retry queue. */
export interface QueuedSmsLog extends ParsedPaymentSms {
  /** Deterministic id used for de-duplication — see smsDedupeKey(). */
  id: string;
  attempts: number;
  lastError?: string;
  createdAtMs: number;
}

export interface SmsListenerOptions {
  /** Bearer token for authenticated API calls — supplied by the app's existing auth/session module. */
  getAccessToken: () => Promise<string | null>;
  /** Base URL of the deployed backend, e.g. "https://api.dalabinternet.so". */
  apiBaseUrl: string;
  /** Called for every processed (matched or unmatched) SMS — for UI feed / toast, etc. */
  onSmsProcessed?: (log: QueuedSmsLog, matchedOrderId: string | null) => void;
  /** Called whenever an upload attempt fails, matched or not — for error UI / analytics. */
  onError?: (error: SmsListenerError) => void;
  /** Max retry attempts per queued item before giving up (still logged, never silently dropped). Default 5. */
  maxRetries?: number;
}

export type SmsListenerErrorCode =
  | "PERMISSION_DENIED"
  | "PERMISSION_PERMANENTLY_DENIED"
  | "PARSE_FAILED"
  | "UPLOAD_FAILED"
  | "VERIFY_FAILED"
  | "NATIVE_MODULE_UNAVAILABLE";

export interface SmsListenerError {
  code: SmsListenerErrorCode;
  message: string;
  detail?: unknown;
}

export type PermissionStatus = "granted" | "denied" | "never_ask_again" | "unavailable";

export interface SmsListenerState {
  permissionStatus: PermissionStatus;
  isListening: boolean;
  /** Most recent processed logs, newest first — capped, for a UI feed. */
  recentLogs: QueuedSmsLog[];
  /** Number of items currently queued for retry. */
  pendingRetryCount: number;
}
