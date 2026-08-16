// SOMLINK Data Service API client — the only file in this codebase that
// ever sees the SOMLINK wallet password or its JWT token. Both stay here:
// the token is cached in-memory only (never persisted, never returned from
// any route), and the password is read from the environment, never from a
// request body or a database row.
//
// Talks to https://api.data.somlink.net (SOMLINK_BASE_URL): POST
// /auth/data_v3_login to obtain a token, then POST /data/send_data to
// purchase a bundle. Both are real-money operations against a live wallet —
// callers (see ../routes/somlink.routes.ts) are responsible for the
// idempotency guarantee that a given DALAB order is never sent here twice;
// this module only wraps the two documented HTTP calls and classifies
// their outcome, it holds no order-level state itself.

const REQUEST_TIMEOUT_MS = 20_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new SomlinkConfigError(`${name} is not set`);
  return value;
}

function somlinkBaseUrl(): string {
  return (process.env.SOMLINK_BASE_URL || "https://api.data.somlink.net").replace(/\/+$/, "");
}

export class SomlinkConfigError extends Error {}
// A structured error response from SOMLINK itself (auth failure, invalid
// bundle, insufficient balance, invalid phone, ...) — code/message are
// whatever SOMLINK returned, passed through unchanged rather than
// re-interpreted, since the documented set of error codes isn't exhaustive.
export class SomlinkApiError extends Error {
  constructor(public code: number | undefined, public somlinkMessage: string | undefined) {
    super(`SOMLINK error ${code ?? "?"}: ${somlinkMessage ?? "unknown"}`);
  }
}
// Network failure, timeout, or a response that couldn't be parsed as the
// documented shape at all — genuinely unknown whether SOMLINK processed
// the request. Callers must treat this differently from SomlinkApiError:
// an ApiError is a confirmed "no", this is "we don't know".
export class SomlinkAmbiguousError extends Error {}

interface SomlinkLoginResponse {
  status?: boolean | string;
  token?: string;
  create_date?: string;
}

interface SomlinkSendDataResponse {
  code: number;
  message: string;
  paid_amount?: number;
  data_phone?: string;
  balance?: number;
}

let cachedToken: string | null = null;

function maskPhone(phone: string): string {
  const digits = String(phone ?? "");
  if (digits.length <= 5) return "***";
  return `${digits.slice(0, 5)}${"*".repeat(Math.max(0, digits.length - 8))}${digits.slice(-3)}`;
}

async function fetchJson(path: string, body: unknown): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(`${somlinkBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    // Network error, DNS failure, or the AbortSignal timeout firing —
    // SOMLINK's side of what happened is unknown.
    throw new SomlinkAmbiguousError(`SOMLINK request to ${path} failed: ${err?.message ?? err}`);
  }
  let json: any;
  try {
    json = await res.json();
  } catch (err: any) {
    throw new SomlinkAmbiguousError(`SOMLINK returned a non-JSON response from ${path} (HTTP ${res.status})`);
  }
  return { status: res.status, json };
}

async function login(): Promise<string> {
  const phone = requiredEnv("SOMLINK_PHONE");
  const password = requiredEnv("SOMLINK_PASSWORD");
  const { status, json } = await fetchJson("/auth/data_v3_login", { phone, password });
  const parsed = json as SomlinkLoginResponse;
  if (status < 200 || status >= 300 || !parsed?.token) {
    throw new SomlinkApiError(status, typeof json?.message === "string" ? json.message : "login_failed");
  }
  cachedToken = parsed.token;
  return cachedToken;
}

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  return login();
}

/** True for the shape of response SOMLINK sends back for an invalid/expired
 * token — used to trigger exactly one re-login + retry, never an unbounded
 * retry loop. */
function looksLikeInvalidToken(status: number, json: any): boolean {
  if (status === 401 || status === 403) return true;
  const message = String(json?.message ?? "").toUpperCase();
  return message.includes("TOKEN") || message.includes("UNAUTHORIZED") || message.includes("AUTH");
}

export interface SomlinkSendDataParams {
  dataPhone: string;
  walletPhone: string;
  amount: number;
  bundleId: number;
}

export interface SomlinkSendDataResult {
  code: number;
  message: string;
  paidAmount: number | null;
  dataPhone: string | null;
  balance: number | null;
}

/** Purchases one bundle via POST /data/send_data. Logs in first if there is
 * no cached token yet; on a response that looks like an invalid/expired
 * token, re-authenticates exactly once and retries the same request once —
 * never more than that, so a genuinely broken account can't spin into an
 * unbounded loop of real-money attempts. Throws SomlinkApiError for any
 * other structured non-success response, or SomlinkAmbiguousError if the
 * outcome could not be determined (network error, timeout, bad response
 * body) — callers must not treat SomlinkAmbiguousError as a failure to
 * safely retry; see deliverViaSomlink in ../routes/somlink.routes.ts.
 */
export async function somlinkSendData(params: SomlinkSendDataParams): Promise<SomlinkSendDataResult> {
  const attempt = async (token: string) => {
    const { status, json } = await fetchJson("/data/send_data", {
      token,
      data_phone: params.dataPhone,
      wallet_phone: params.walletPhone,
      amount: params.amount,
      bundle_id: params.bundleId,
    });
    return { status, json: json as SomlinkSendDataResponse };
  };

  let token = await getToken();
  let { status, json } = await attempt(token);

  if (looksLikeInvalidToken(status, json)) {
    cachedToken = null;
    token = await login();
    ({ status, json } = await attempt(token));
  }

  if (typeof json?.code !== "number") {
    throw new SomlinkAmbiguousError(`SOMLINK /data/send_data returned an unrecognized response shape (HTTP ${status})`);
  }
  if (json.code !== 200 || json.message !== "DATA_PAID_SUCCESSFULLY") {
    throw new SomlinkApiError(json.code, json.message);
  }
  return {
    code: json.code,
    message: json.message,
    paidAmount: typeof json.paid_amount === "number" ? json.paid_amount : null,
    dataPhone: json.data_phone ?? null,
    balance: typeof json.balance === "number" ? json.balance : null,
  };
}

/** Log line format shared by every SOMLINK call site — never includes the
 * password or the full token; the customer phone is masked. */
export function logSomlink(entry: {
  orderId: string;
  bundleId: number;
  amount: number;
  dataPhone: string;
  status: "success" | "failed" | "ambiguous";
  responseCode?: number;
  responseMessage?: string;
  durationMs: number;
  error?: string;
}): void {
  console.log(
    `[somlink] order=${entry.orderId} provider=SOMLINK bundle=${entry.bundleId} amount=${entry.amount} ` +
      `phone=${maskPhone(entry.dataPhone)} status=${entry.status} code=${entry.responseCode ?? "-"} ` +
      `message=${entry.responseMessage ?? entry.error ?? "-"} durationMs=${entry.durationMs}`
  );
}

// Test-only hook — lets tests force a specific cached token (or clear it)
// without reaching into module-private state any other way.
export function __setCachedTokenForTests(token: string | null): void {
  cachedToken = token;
}
