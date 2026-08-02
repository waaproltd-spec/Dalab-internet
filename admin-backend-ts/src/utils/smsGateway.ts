// Real SMS delivery for OTP codes, via Hormuud's SMS Business API
// (https://smsapi.hormuud.com — see api/sms/Send, HTTP Basic auth). Optional:
// with no HORMUUD_SMS_USERNAME/PASSWORD configured this is a no-op, so local/
// dev/test environments keep working exactly as before (auth.routes.ts falls
// back to its existing test-mode "return the code in the response" behavior).
const HORMUUD_SMS_URL = "https://smsapi.hormuud.com/api/sms/Send";

export type SendOtpSmsResult = "sent" | "not_configured" | "failed";

export async function sendOtpSms(phone: string, code: string): Promise<SendOtpSmsResult> {
  const username = process.env.HORMUUD_SMS_USERNAME;
  const password = process.env.HORMUUD_SMS_PASSWORD;
  if (!username || !password) return "not_configured";

  // Hormuud's own example payloads use local digits without the country
  // code (e.g. "61xxxxxxx") — strip the "252" prefix this codebase's phone
  // numbers are otherwise stored/passed around with (see toE164 on the
  // Customer App side).
  const mobile = phone.replace(/^\+?252/, "");
  const senderId = process.env.HORMUUD_SMS_SENDER_ID || "DALAB";

  try {
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    const res = await fetch(HORMUUD_SMS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        mobile,
        message: `Your DALAB INTERNET verification code is ${code}`,
        senderid: senderId,
        validity: 0,
      }),
    });
    const json: any = await res.json().catch(() => null);
    if (json?.ResponseCode === "200") return "sent";
    // eslint-disable-next-line no-console
    console.error(`Hormuud SMS send failed for ${mobile}:`, json ?? `HTTP ${res.status}`);
    return "failed";
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Hormuud SMS send threw for ${mobile}:`, err);
    return "failed";
  }
}
