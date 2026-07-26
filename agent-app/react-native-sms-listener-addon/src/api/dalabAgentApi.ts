import { ParsedPaymentSms } from "../types/sms";

/**
 * Matches dalab-backend.zip's src/routes/smsLogs.js and src/routes/orders.js
 * exactly — same paths, same body shapes, verified against that server's own
 * test suite. This is the "existing Backend API" the hook is required to use;
 * nothing here is invented, it's a TypeScript mirror of routes that already
 * exist and are tested.
 */

export interface SmsLogUploadResponse {
  id: string;
  matchedOrderId: string | null;
}

export interface OrderResponse {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  [key: string]: unknown;
}

export class ApiRequestError extends Error {
  constructor(message: string, public status: number, public body?: unknown) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface DalabAgentApiClient {
  uploadSmsLog(parsed: ParsedPaymentSms, accessToken: string): Promise<SmsLogUploadResponse>;
  verifyPayment(orderId: string, smsLogId: string, accessToken: string): Promise<OrderResponse>;
}

export function createDalabAgentApiClient(apiBaseUrl: string): DalabAgentApiClient {
  const base = apiBaseUrl.replace(/\/$/, "");

  async function request<T>(path: string, accessToken: string, body: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiRequestError(
        (json && typeof json === "object" && "error" in json ? String((json as any).error) : `Request failed (${res.status})`),
        res.status,
        json
      );
    }
    return json as T;
  }

  return {
    // POST /agent/sms-logs — server-side matches by company + amount against
    // pending orders (see dalab-backend.zip src/routes/smsLogs.js), returns
    // matchedOrderId or null. This is the real matching logic; the hook does
    // not attempt its own matching.
    uploadSmsLog(parsed, accessToken) {
      return request<SmsLogUploadResponse>("/agent/sms-logs", accessToken, {
        sender: parsed.rawSender,
        body: parsed.rawBody,
        parsedProvider: parsed.operator,
        parsedAmount: parsed.amount,
        parsedPhone: parsed.customerPhone,
        receivedAt: parsed.transactionDateTime,
      });
    },

    // POST /agent/orders/:id/verify-payment — moves pending -> in_progress.
    // Deliberately does NOT also call /complete: payment confirmation proves
    // the customer paid, not that the package was actually delivered, so
    // completion stays a separate, deliberate step (matches the backend's
    // existing order lifecycle and the native Agent App's same design).
    verifyPayment(orderId, smsLogId, accessToken) {
      return request<OrderResponse>(`/agent/orders/${orderId}/verify-payment`, accessToken, { smsLogId });
    },
  };
}
