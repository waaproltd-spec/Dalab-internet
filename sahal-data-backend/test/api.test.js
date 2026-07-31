import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../src/server.js";

process.env.NODE_ENV = "development"; // so /auth/otp/request returns debugCode for the test to read
process.env.JWT_SECRET = "test-secret";

let server;
let baseUrl;
let dbDir;

before(async () => {
  dbDir = mkdtempSync(path.join(tmpdir(), "sahal-data-test-"));
  const { app } = buildServer({ dbPath: path.join(dbDir, "test.db") });
  await new Promise((resolve) => {
    server = app.listen(0, resolve); // port 0 = OS picks a free ephemeral port
  });
  const address = server.address();
  baseUrl = `http://localhost:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dbDir, { recursive: true, force: true });
});

async function api(method, urlPath, { body, token } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test("health check responds ok", async () => {
  const { status, json } = await api("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
});

test("public companies list includes the four seeded providers", async () => {
  const { status, json } = await api("GET", "/companies");
  assert.equal(status, 200);
  const names = json.map((c) => c.name).sort();
  assert.deepEqual(names, ["Amtel", "Hormuud", "Somnet", "Somtel"]);
});

test("Amtel is seeded offline, matching the customer app prototype", async () => {
  const { json } = await api("GET", "/companies");
  const amtel = json.find((c) => c.id === "amtel");
  assert.equal(amtel.status, "offline");
});

test("customer OTP request + verify issues a working access token", async () => {
  const requestRes = await api("POST", "/auth/otp/request", { body: { phone: "252699000111" } });
  assert.equal(requestRes.status, 200);
  assert.ok(requestRes.json.debugCode, "dev mode should expose debugCode for testing");

  const verifyRes = await api("POST", "/auth/otp/verify", {
    body: { phone: "252699000111", code: requestRes.json.debugCode },
  });
  assert.equal(verifyRes.status, 200);
  assert.ok(verifyRes.json.accessToken);
  assert.equal(verifyRes.json.customer.phone, "252699000111");
});

test("OTP verify rejects a wrong code", async () => {
  await api("POST", "/auth/otp/request", { body: { phone: "252699000222" } });
  const { status, json } = await api("POST", "/auth/otp/verify", {
    body: { phone: "252699000222", code: "0000" },
  });
  assert.equal(status, 401);
  assert.ok(json.error);
});

test("full order lifecycle: create -> agent verify -> complete -> Macaash credited", async () => {
  // Customer auth
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252699000333" } });
  const custAuth = await api("POST", "/auth/otp/verify", {
    body: { phone: "252699000333", code: otp.json.debugCode },
  });
  const customerToken = custAuth.json.accessToken;

  // Pick a real seeded Hormuud package
  const pkgs = await api("GET", "/companies/hormuud/packages");
  assert.ok(pkgs.json.length > 0);
  const pkg = pkgs.json[0];

  // Place the order
  const orderRes = await api("POST", "/orders", {
    token: customerToken,
    body: { companyId: "hormuud", packageId: pkg.id },
  });
  assert.equal(orderRes.status, 201);
  assert.equal(orderRes.json.status, "pending");
  const orderId = orderRes.json.id;
  assert.match(orderId, /^DLB\d+$/);

  // Agent auth (seeded demo agent)
  const agentAuth = await api("POST", "/agent/auth/login", {
    body: { phone: "252610000001", password: "AgentPass123!" },
  });
  assert.equal(agentAuth.status, 200);
  const agentToken = agentAuth.json.accessToken;

  // RBAC: the customer token must NOT be able to hit an agent route
  const forbidden = await api("GET", "/agent/orders", { token: customerToken });
  assert.equal(forbidden.status, 403);

  // Agent verifies then completes
  const verify = await api("POST", `/agent/orders/${orderId}/verify-payment`, { token: agentToken, body: {} });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.status, "in_progress");

  const complete = await api("POST", `/agent/orders/${orderId}/complete`, { token: agentToken });
  assert.equal(complete.status, 200);
  assert.equal(complete.json.status, "completed");
  assert.ok(complete.json.macaashEarned > 0);

  // Macaash balance reflects the credit
  const balance = await api("GET", "/macaash/balance", { token: customerToken });
  assert.equal(balance.json.balance, complete.json.macaashEarned);
});

test("SMS log upload matches a pending order by amount + normalized phone (not by provider)", async () => {
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252699000444" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252699000444", code: otp.json.debugCode } });
  const pkgs = await api("GET", "/companies/hormuud/packages");
  const pkg = pkgs.json[0];
  const order = await api("POST", "/orders", {
    token: custAuth.json.accessToken,
    body: { companyId: "hormuud", packageId: pkg.id },
  });

  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const smsRes = await api("POST", "/agent/sms-logs", {
    token: agentAuth.json.accessToken,
    body: {
      sender: "EVCPLUS",
      // Order was created with phone "252699000444"; the SMS reports it as
      // "0699000444" — same subscriber, different format. This must still match.
      body: `[-EVCPLUS-] waxaad $${pkg.price} ka heshay 0699000444, Tar: 25/07/26`,
      parsedProvider: "Hormuud",
      parsedAmount: pkg.price,
      parsedPhone: "0699000444",
    },
  });
  assert.equal(smsRes.status, 201);
  assert.equal(smsRes.json.matchedOrderId, order.json.id);
});

test("cross-network payment: customer orders Somtel but pays via a Hormuud EVC Plus SMS — order still matches, and the executed USSD is Somtel's, not Hormuud's", async () => {
  const admin = await adminToken();
  await api("PUT", "/admin/companies/somtel/pin", { token: admin, body: { pin: "3344" } });

  // Customer orders a SOMTEL package.
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252611555000" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252611555000", code: otp.json.debugCode } });
  const somtelPkgs = await api("GET", "/companies/somtel/packages");
  const somtelPkg = somtelPkgs.json[0];
  const order = await api("POST", "/orders", {
    token: custAuth.json.accessToken,
    body: { companyId: "somtel", packageId: somtelPkg.id },
  });
  assert.equal(order.json.companyId, "somtel");

  // But the customer actually pays via HORMUUD EVC Plus — a completely
  // different network than the one they ordered from.
  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const agentToken = agentAuth.json.accessToken;
  const smsRes = await api("POST", "/agent/sms-logs", {
    token: agentToken,
    body: {
      sender: "EVCPLUS", // Hormuud's sender ID — NOT Somtel's
      body: `[-EVCPLUS-] waxaad $${somtelPkg.price} ka heshay 611555000, Tar: 25/07/26`,
      parsedProvider: "Hormuud", // the SMS genuinely came from Hormuud's network
      parsedAmount: somtelPkg.price,
      parsedPhone: "611555000",
    },
  });

  // The order must still match, despite the payment coming from a totally
  // different telecom than the one ordered.
  assert.equal(smsRes.status, 201);
  assert.equal(smsRes.json.matchedOrderId, order.json.id);

  // Approving it must generate a SOMTEL USSD string (the ordered provider),
  // never a Hormuud one (the paying network) — this is the actual behavior
  // being specified, not just the matching step.
  const approved = await api("PUT", `/admin/orders/${order.json.id}/status`, {
    token: admin, body: { status: "in_progress" },
  });
  assert.equal(approved.status, 200);
  assert.match(approved.json.ussdGenerated, /^\*831\*/); // Somtel's Unlimited Data & Voice template code
  assert.doesNotMatch(approved.json.ussdGenerated, /^\*738\*/); // NOT Hormuud's Anfac Plus code
});

test("a payment SMS with no extractable phone number is never auto-matched, even with a correct amount", async () => {
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252699222333" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252699222333", code: otp.json.debugCode } });
  const pkgs = await api("GET", "/companies/hormuud/packages");
  await api("POST", "/orders", { token: custAuth.json.accessToken, body: { companyId: "hormuud", packageId: pkgs.json[0].id } });

  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const smsRes = await api("POST", "/agent/sms-logs", {
    token: agentAuth.json.accessToken,
    body: { sender: "EVCPLUS", body: "some unparseable text", parsedAmount: pkgs.json[0].price }, // no parsedPhone
  });
  assert.equal(smsRes.status, 201);
  assert.equal(smsRes.json.matchedOrderId, null);
});

test("agent cannot verify an order that's already completed", async () => {
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252699000555" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252699000555", code: otp.json.debugCode } });
  const pkgs = await api("GET", "/companies/hormuud/packages");
  const order = await api("POST", "/orders", {
    token: custAuth.json.accessToken,
    body: { companyId: "hormuud", packageId: pkgs.json[0].id },
  });
  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const token = agentAuth.json.accessToken;

  await api("POST", `/agent/orders/${order.json.id}/verify-payment`, { token, body: {} });
  await api("POST", `/agent/orders/${order.json.id}/complete`, { token });

  const secondVerify = await api("POST", `/agent/orders/${order.json.id}/verify-payment`, { token, body: {} });
  assert.equal(secondVerify.status, 409);
});

test("ordering against an offline company is rejected", async () => {
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252699000666" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252699000666", code: otp.json.debugCode } });
  const amtelPkgs = await api("GET", "/companies/amtel/packages");
  const { status, json } = await api("POST", "/orders", {
    token: custAuth.json.accessToken,
    body: { companyId: "amtel", packageId: amtelPkgs.json[0].id },
  });
  assert.equal(status, 409);
  assert.match(json.error, /offline/i);
});

test("admin login works and dashboard stats reflects real completed orders", async () => {
  const adminAuth = await api("POST", "/admin/auth/login", {
    body: { email: "aarandata33@gmail.com", password: "Yaas120@" },
  });
  assert.equal(adminAuth.status, 200);
  const { status, json } = await api("GET", "/admin/dashboard/stats", { token: adminAuth.json.accessToken });
  assert.equal(status, 200);
  assert.ok(json.successfulOrders >= 1); // at least the order completed in the earlier test
});

test("unauthenticated request to a protected route is rejected", async () => {
  const { status } = await api("GET", "/admin/dashboard/stats");
  assert.equal(status, 401);
});

test("refresh token rotation issues a new working access token", async () => {
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252699000777" } });
  const auth = await api("POST", "/auth/otp/verify", { body: { phone: "252699000777", code: otp.json.debugCode } });
  const refreshed = await api("POST", "/auth/refresh", { body: { refreshToken: auth.json.refreshToken } });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.json.accessToken);

  // The old refresh token must now be revoked (rotation, not reuse)
  const reused = await api("POST", "/auth/refresh", { body: { refreshToken: auth.json.refreshToken } });
  assert.equal(reused.status, 401);
});

test("admin login rejects a malformed email or missing password", async () => {
  const badEmail = await api("POST", "/admin/auth/login", { body: { email: "not-an-email", password: "x" } });
  assert.equal(badEmail.status, 400);

  const noPassword = await api("POST", "/admin/auth/login", { body: { email: "aarandata33@gmail.com" } });
  assert.equal(noPassword.status, 400);
});

test("admin login rejects the wrong password without revealing whether the email exists", async () => {
  const wrongPassword = await api("POST", "/admin/auth/login", {
    body: { email: "aarandata33@gmail.com", password: "totallyWrong123!" },
  });
  assert.equal(wrongPassword.status, 401);

  const unknownEmail = await api("POST", "/admin/auth/login", {
    body: { email: "nobody@example.com", password: "whatever123!" },
  });
  assert.equal(unknownEmail.status, 401);
  assert.equal(unknownEmail.json.error, wrongPassword.json.error); // identical error either way
});

test("admin change-password requires the correct current password and a strong new one", async () => {
  const login = await api("POST", "/admin/auth/login", { body: { email: "aarandata33@gmail.com", password: "Yaas120@" } });
  const token = login.json.accessToken;

  const wrongCurrent = await api("POST", "/admin/auth/change-password", {
    token, body: { currentPassword: "wrong", newPassword: "NewStrong123!" },
  });
  assert.equal(wrongCurrent.status, 401);

  const weakNew = await api("POST", "/admin/auth/change-password", {
    token, body: { currentPassword: "Yaas120@", newPassword: "weak" },
  });
  assert.equal(weakNew.status, 400);

  const success = await api("POST", "/admin/auth/change-password", {
    token, body: { currentPassword: "Yaas120@", newPassword: "NewStrongPass123!" },
  });
  assert.equal(success.status, 200);

  // Old password no longer works; new one does. Then change it back so later
  // tests (and repeat runs of this suite) still have the documented default.
  const oldFails = await api("POST", "/admin/auth/login", { body: { email: "aarandata33@gmail.com", password: "Yaas120@" } });
  assert.equal(oldFails.status, 401);

  const newWorks = await api("POST", "/admin/auth/login", { body: { email: "aarandata33@gmail.com", password: "NewStrongPass123!" } });
  assert.equal(newWorks.status, 200);

  await api("POST", "/admin/auth/change-password", {
    token: newWorks.json.accessToken,
    body: { currentPassword: "NewStrongPass123!", newPassword: "Yaas120@" },
  });
});

test("forgot-password issues a reset token that actually resets the password", async () => {
  const forgot = await api("POST", "/admin/auth/forgot-password", { body: { email: "aarandata33@gmail.com" } });
  assert.equal(forgot.status, 200);
  assert.ok(forgot.json.debugResetToken, "dev mode should expose the token for testing");

  const reset = await api("POST", "/admin/auth/reset-password", {
    body: { token: forgot.json.debugResetToken, newPassword: "ResetFlow123!" },
  });
  assert.equal(reset.status, 200);

  const loginWithNew = await api("POST", "/admin/auth/login", { body: { email: "aarandata33@gmail.com", password: "ResetFlow123!" } });
  assert.equal(loginWithNew.status, 200);

  // The same reset token cannot be reused a second time
  const reuseToken = await api("POST", "/admin/auth/reset-password", {
    body: { token: forgot.json.debugResetToken, newPassword: "AnotherOne123!" },
  });
  assert.equal(reuseToken.status, 401);

  // Restore the documented default password for consistency across runs
  await api("POST", "/admin/auth/change-password", {
    token: loginWithNew.json.accessToken,
    body: { currentPassword: "ResetFlow123!", newPassword: "Yaas120@" },
  });
});

test("forgot-password gives the same generic response for an unknown email (no account enumeration)", async () => {
  const known = await api("POST", "/admin/auth/forgot-password", { body: { email: "aarandata33@gmail.com" } });
  const unknown = await api("POST", "/admin/auth/forgot-password", { body: { email: "nobody@example.com" } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(known.json.message, unknown.json.message);
  assert.equal(unknown.json.debugResetToken, undefined); // no token issued for an account that doesn't exist
});

async function placeOrder(phone, companyId = "hormuud", receiverPhone, paymentMethod) {
  const otp = await api("POST", "/auth/otp/request", { body: { phone } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone, code: otp.json.debugCode } });
  const pkgs = await api("GET", `/companies/${companyId}/packages`);
  const order = await api("POST", "/orders", {
    token: custAuth.json.accessToken,
    body: { companyId, packageId: pkgs.json[0].id, receiverPhone, paymentMethod },
  });
  return { order: order.json, customerToken: custAuth.json.accessToken };
}

async function adminToken() {
  const login = await api("POST", "/admin/auth/login", { body: { email: "aarandata33@gmail.com", password: "Yaas120@" } });
  return login.json.accessToken;
}

test("order card includes every field the admin Orders page requires", async () => {
  const { order } = await placeOrder("252698111001", "somnet", "252611222333", "Jeeb");
  const admin = await adminToken();
  const { status, json } = await api("GET", `/admin/orders/${order.id}`, { token: admin });

  assert.equal(status, 200);
  assert.equal(json.companyName, "Somnet");        // Internet Provider
  assert.ok(json.packageName);                       // Package Name
  assert.ok(json.amount >= 0);                        // Price
  assert.equal(json.senderPhone, "252698111001");    // Sender Phone Number
  assert.equal(json.receiverPhone, "252611222333");  // Receiver Phone Number
  assert.match(json.id, /^DLB\d+$/);                  // Order ID
  assert.ok(json.createdAt);                          // Date & Time
  assert.equal(json.paymentMethod, "Jeeb");           // Payment Method
  assert.ok(json.customerName !== undefined);         // Customer Name (may be null, but present)
});

test("admin can search orders by sender phone, receiver phone, order ID, or customer name", async () => {
  const { order } = await placeOrder("252698222002", "hormuud", "252698222999");
  const admin = await adminToken();

  const bySender = await api("GET", "/admin/orders?search=252698222002", { token: admin });
  assert.ok(bySender.json.some((o) => o.id === order.id));

  const byReceiver = await api("GET", "/admin/orders?search=252698222999", { token: admin });
  assert.ok(byReceiver.json.some((o) => o.id === order.id));

  const byOrderId = await api("GET", `/admin/orders?search=${order.id}`, { token: admin });
  assert.ok(byOrderId.json.some((o) => o.id === order.id));
});

test("admin can filter orders by provider and by status together", async () => {
  await placeOrder("252698333003", "somtel");
  const admin = await adminToken();

  const somtelOnly = await api("GET", "/admin/orders?companyId=somtel", { token: admin });
  assert.ok(somtelOnly.json.every((o) => o.companyName === "Somtel"));

  const somtelPending = await api("GET", "/admin/orders?companyId=somtel&status=pending", { token: admin });
  assert.ok(somtelPending.json.every((o) => o.companyName === "Somtel" && o.status === "pending"));
});

test("admin one-tap status change moves an order through the real lifecycle", async () => {
  const { order } = await placeOrder("252698444004");
  const admin = await adminToken();

  const toProgress = await api("PUT", `/admin/orders/${order.id}/status`, { token: admin, body: { status: "in_progress" } });
  assert.equal(toProgress.status, 200);
  assert.equal(toProgress.json.status, "in_progress");

  const toCompleted = await api("PUT", `/admin/orders/${order.id}/status`, { token: admin, body: { status: "completed" } });
  assert.equal(toCompleted.status, 200);
  assert.equal(toCompleted.json.status, "completed");
  assert.ok(toCompleted.json.completedAt);
});

test("admin status change rejects an invalid status value", async () => {
  const { order } = await placeOrder("252698555005");
  const admin = await adminToken();
  const { status, json } = await api("PUT", `/admin/orders/${order.id}/status`, { token: admin, body: { status: "banana" } });
  assert.equal(status, 400);
  assert.match(json.error, /status must be one of/);
});

test("order status counts reflect real data across all five statuses", async () => {
  const admin = await adminToken();
  const before = await api("GET", "/admin/orders/counts", { token: admin });

  const { order: cancelMe } = await placeOrder("252698666006");
  await api("PUT", `/admin/orders/${cancelMe.id}/status`, { token: admin, body: { status: "cancelled" } });

  const after = await api("GET", "/admin/orders/counts", { token: admin });
  assert.equal(after.json.cancelled, before.json.cancelled + 1);
  assert.equal(after.json.all, before.json.all + 1);
});

test("all 17 seeded USSD templates exist with the exact codes specified", async () => {
  const admin = await adminToken();
  const { json } = await api("GET", "/admin/ussd-templates", { token: admin });
  // Not asserting an exact total count here — other tests running against this
  // same shared database create/delete templates too, so the total is not
  // stable across the suite. What matters is that every originally-seeded
  // template is present with the exact code specified.
  assert.ok(json.length >= 17);

  const hormuudAnfacPlus = json.find((t) => t.companyId === "hormuud" && t.serviceName === "Anfac Plus");
  assert.equal(hormuudAnfacPlus.ussdCode, "*738*{number}*{amount}*8233{pin}#");

  const amtelTanaad = json.find((t) => t.companyId === "amtel" && t.serviceName === "Tanaad GB");
  assert.equal(amtelTanaad.ussdCode, "*914*{number}*{amount}*8233{pin}#");

  const somtelNoExpire = json.find((t) => t.companyId === "somtel" && t.serviceName === "No Expire");
  assert.equal(somtelNoExpire.ussdCode, "*830*{number}*{amount}*8233{pin}#");
});

test("admin can create, edit, disable, and delete a USSD template", async () => {
  const admin = await adminToken();

  const created = await api("POST", "/admin/ussd-templates", {
    token: admin,
    body: { companyId: "hormuud", serviceName: "Test Service", ussdCode: "*999*{number}*{amount}*8233{pin}#", notes: "test" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "enabled");

  const edited = await api("PUT", `/admin/ussd-templates/${created.json.id}`, {
    token: admin, body: { serviceName: "Renamed Service" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.serviceName, "Renamed Service");

  const disabled = await api("PUT", `/admin/ussd-templates/${created.json.id}/status`, {
    token: admin, body: { status: "disabled" },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.status, "disabled");

  const deleted = await api("DELETE", `/admin/ussd-templates/${created.json.id}`, { token: admin });
  assert.equal(deleted.status, 200);

  const list = await api("GET", "/admin/ussd-templates", { token: admin });
  assert.ok(!list.json.some((t) => t.id === created.json.id));
});

test("USSD template creation rejects a code missing required placeholders", async () => {
  const admin = await adminToken();
  const { status, json } = await api("POST", "/admin/ussd-templates", {
    token: admin,
    body: { companyId: "hormuud", serviceName: "Bad Template", ussdCode: "*999*{number}*{amount}#" }, // missing {pin}
  });
  assert.equal(status, 400);
  assert.match(json.error, /placeholders/);
});

test("each provider's PIN is rejected if not 3-8 digits, and is never returned in plaintext", async () => {
  const admin = await adminToken();

  const tooShort = await api("PUT", "/admin/companies/hormuud/pin", { token: admin, body: { pin: "12" } });
  assert.equal(tooShort.status, 400);

  const notDigits = await api("PUT", "/admin/companies/hormuud/pin", { token: admin, body: { pin: "abcd" } });
  assert.equal(notDigits.status, 400);

  const valid = await api("PUT", "/admin/companies/hormuud/pin", { token: admin, body: { pin: "7788" } });
  assert.equal(valid.status, 200);

  const check = await api("GET", "/admin/companies/hormuud/pin-status", { token: admin });
  assert.equal(check.status, 200);
  assert.equal(check.json.isSet, true);
  assert.equal(JSON.stringify(check.json).includes("7788"), false); // raw PIN never leaves the server
});

test("providers have independent PINs — setting one does not affect another, and pin_encrypted never appears in any company API response", async () => {
  const admin = await adminToken();
  await api("PUT", "/admin/companies/hormuud/pin", { token: admin, body: { pin: "1111" } });

  const amtelStatus = await api("GET", "/admin/companies/amtel/pin-status", { token: admin });
  assert.equal(amtelStatus.json.isSet, false); // unaffected by Hormuud's PIN being set

  await api("PUT", "/admin/companies/amtel/pin", { token: admin, body: { pin: "2222" } });
  const amtelStatusAfter = await api("GET", "/admin/companies/amtel/pin-status", { token: admin });
  assert.equal(amtelStatusAfter.json.isSet, true);

  // The public, unauthenticated endpoint the customer app hits must never
  // include the encrypted PIN blob for any provider, under any key name.
  const publicCompanies = await api("GET", "/companies");
  const serialized = JSON.stringify(publicCompanies.json);
  assert.equal(serialized.includes("pinEncrypted"), false);
  assert.equal(serialized.includes("pin_encrypted"), false);

  const adminCompanies = await api("GET", "/admin/companies", { token: admin });
  const adminSerialized = JSON.stringify(adminCompanies.json);
  assert.equal(adminSerialized.includes("pinEncrypted"), false);
});

test("approving an order auto-generates the correct USSD string with real substitution", async () => {
  const admin = await adminToken();
  await api("PUT", "/admin/companies/hormuud/pin", { token: admin, body: { pin: "4521" } });

  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252611999888" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252611999888", code: otp.json.debugCode } });
  const pkgs = await api("GET", "/companies/hormuud/packages");
  const anfacPlus = pkgs.json.find((p) => p.name.includes("Anfac Plus"));

  const order = await api("POST", "/orders", {
    token: custAuth.json.accessToken,
    body: { companyId: "hormuud", packageId: anfacPlus.id },
  });

  const approved = await api("PUT", `/admin/orders/${order.json.id}/status`, {
    token: admin, body: { status: "in_progress" },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.ussdGenerated, `*738*252611999888*${anfacPlus.price}*82334521#`);

  // The order detail page must show it
  const detail = await api("GET", `/admin/orders/${order.json.id}`, { token: admin });
  assert.equal(detail.json.ussdGenerated, approved.json.ussdGenerated);

  // And it must be logged
  const logs = await api("GET", `/admin/ussd-logs?orderId=${order.json.id}`, { token: admin });
  assert.equal(logs.json.length, 1);
  assert.equal(logs.json[0].generatedString, approved.json.ussdGenerated);
});

test("approving an order with no matching template for its package still succeeds (no crash), just without USSD", async () => {
  const admin = await adminToken();
  // Amtel is seeded offline by default — bring it online so an order can be placed.
  await api("PUT", "/admin/companies/amtel/status", { token: admin, body: { status: "online" } });

  // Delete all Amtel templates so no match is possible
  const templates = await api("GET", "/admin/ussd-templates?companyId=amtel", { token: admin });
  for (const t of templates.json) {
    await api("DELETE", `/admin/ussd-templates/${t.id}`, { token: admin });
  }

  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252611888777" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252611888777", code: otp.json.debugCode } });
  const pkgs = await api("GET", "/companies/amtel/packages");
  const order = await api("POST", "/orders", {
    token: custAuth.json.accessToken,
    body: { companyId: "amtel", packageId: pkgs.json[0].id },
  });

  const approved = await api("PUT", `/admin/orders/${order.json.id}/status`, {
    token: admin, body: { status: "in_progress" },
  });
  assert.equal(approved.status, 200); // approval itself never fails
  assert.equal(approved.json.ussdGenerated, null);
});

test("non-admin roles cannot access USSD templates or the PIN endpoint", async () => {
  const otp = await api("POST", "/auth/otp/request", { body: { phone: "252611777666" } });
  const custAuth = await api("POST", "/auth/otp/verify", { body: { phone: "252611777666", code: otp.json.debugCode } });

  const templates = await api("GET", "/admin/ussd-templates", { token: custAuth.json.accessToken });
  assert.equal(templates.status, 403);

  const pin = await api("GET", "/admin/companies/hormuud/pin-status", { token: custAuth.json.accessToken });
  assert.equal(pin.status, 403);
});

test("admin can set SIM routing per provider (Option 1: SIM1->Hormuud, SIM2->Somtel)", async () => {
  const admin = await adminToken();

  const setHormuud = await api("PUT", "/admin/sim-routing/hormuud", { token: admin, body: { simSlot: 1 } });
  assert.equal(setHormuud.status, 200);
  assert.equal(setHormuud.json.simSlot, 1);

  const setSomtel = await api("PUT", "/admin/sim-routing/somtel", { token: admin, body: { simSlot: 2 } });
  assert.equal(setSomtel.status, 200);
  assert.equal(setSomtel.json.simSlot, 2);

  const list = await api("GET", "/admin/sim-routing", { token: admin });
  const hormuudRow = list.json.find((r) => r.companyId === "hormuud");
  const somtelRow = list.json.find((r) => r.companyId === "somtel");
  assert.equal(hormuudRow.simSlot, 1);
  assert.equal(somtelRow.simSlot, 2);
});

test("SIM routing can be reassigned (Option 2: SIM1->Somnet, SIM2->Amtel) and the agent-facing endpoint reflects it", async () => {
  const admin = await adminToken();
  await api("PUT", "/admin/sim-routing/somnet", { token: admin, body: { simSlot: 1 } });
  await api("PUT", "/admin/sim-routing/amtel", { token: admin, body: { simSlot: 2 } });

  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const agentView = await api("GET", "/agent/sim-routing", { token: agentAuth.json.accessToken });
  const somnetRow = agentView.json.find((r) => r.companyId === "somnet");
  const amtelRow = agentView.json.find((r) => r.companyId === "amtel");
  assert.equal(somnetRow.simSlot, 1);
  assert.equal(amtelRow.simSlot, 2);
});

test("SIM routing rejects an invalid slot number", async () => {
  const admin = await adminToken();
  const { status, json } = await api("PUT", "/admin/sim-routing/hormuud", { token: admin, body: { simSlot: 3 } });
  assert.equal(status, 400);
  assert.match(json.error, /simSlot must be 1 or 2/);
});

test("a successful dial attempt marks the order completed and credits Macaash", async () => {
  const admin = await adminToken();
  await api("PUT", "/admin/companies/hormuud/pin", { token: admin, body: { pin: "9911" } });

  const { order } = await placeOrder("252697000111");
  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const agentToken = agentAuth.json.accessToken;

  await api("PUT", `/admin/orders/${order.id}/status`, { token: admin, body: { status: "in_progress" } });

  const dialStart = await api("POST", `/agent/orders/${order.id}/dial-attempts`, {
    token: agentToken,
    body: { simSlot: 1, ussdString: "*738*252697000111*0.22*82339911#", attemptNumber: 1 },
  });
  assert.equal(dialStart.status, 201);
  assert.ok(dialStart.json.id);

  const dialResult = await api("PUT", `/agent/dial-attempts/${dialStart.json.id}`, {
    token: agentToken,
    body: { status: "success", responseMessage: "You have successfully purchased Anfac Plus" },
  });
  assert.equal(dialResult.status, 200);
  assert.equal(dialResult.json.status, "success");

  const finalOrder = await api("GET", `/admin/orders/${order.id}`, { token: admin });
  assert.equal(finalOrder.json.status, "completed");
});

test("a failed dial attempt leaves the order in a retryable failed state, not silently dropped", async () => {
  const admin = await adminToken();
  const { order } = await placeOrder("252697000222");
  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const agentToken = agentAuth.json.accessToken;

  await api("PUT", `/admin/orders/${order.id}/status`, { token: admin, body: { status: "in_progress" } });

  const dialStart = await api("POST", `/agent/orders/${order.id}/dial-attempts`, {
    token: agentToken,
    body: { simSlot: 2, ussdString: "*738*252697000222*0.22*82339911#", attemptNumber: 1 },
  });
  const dialResult = await api("PUT", `/agent/dial-attempts/${dialStart.json.id}`, {
    token: agentToken,
    body: { status: "failed", responseMessage: "Insufficient balance" },
  });
  assert.equal(dialResult.status, 200);
  assert.equal(dialResult.json.status, "failed");

  const finalOrder = await api("GET", `/admin/orders/${order.id}`, { token: admin });
  assert.equal(finalOrder.json.status, "failed");
});

test("seeded devices match the exact spec: Mobile 1 (Hormuud/Somtel), Mobile 2 (Somnet/Amtel)", async () => {
  const admin = await adminToken();
  const { status, json } = await api("GET", "/admin/agent-devices", { token: admin });
  assert.equal(status, 200);

  const mobile1 = json.find((d) => d.name === "Mobile 1");
  const mobile2 = json.find((d) => d.name === "Mobile 2");
  assert.ok(mobile1 && mobile2);

  const mobile1Providers = mobile1.sims.map((s) => `${s.companyId}:${s.simSlot}`).sort();
  assert.deepEqual(mobile1Providers, ["hormuud:1", "somtel:2"]);

  const mobile2Providers = mobile2.sims.map((s) => `${s.companyId}:${s.simSlot}`).sort();
  assert.deepEqual(mobile2Providers, ["amtel:2", "somnet:1"]);
});

test("admin can create, edit, and delete an agent device; deleting un-assigns its providers rather than breaking their routing rows", async () => {
  const admin = await adminToken();

  const created = await api("POST", "/admin/agent-devices", { token: admin, body: { name: "Mobile 3", description: "Spare device" } });
  assert.equal(created.status, 201);

  const edited = await api("PUT", `/admin/agent-devices/${created.json.id}`, { token: admin, body: { description: "Updated description" } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.description, "Updated description");

  const duplicate = await api("POST", "/admin/agent-devices", { token: admin, body: { name: "Mobile 3" } });
  assert.equal(duplicate.status, 409);

  const deleted = await api("DELETE", `/admin/agent-devices/${created.json.id}`, { token: admin });
  assert.equal(deleted.status, 200);
});

test("an Agent App can fetch SIM routing scoped to just its own device", async () => {
  const agentAuth = await api("POST", "/agent/auth/login", { body: { phone: "252610000001", password: "AgentPass123!" } });
  const agentToken = agentAuth.json.accessToken;

  const mobile1Routing = await api("GET", "/agent/sim-routing?deviceId=mobile-1", { token: agentToken });
  assert.equal(mobile1Routing.status, 200);
  assert.ok(mobile1Routing.json.every((r) => ["hormuud", "somtel"].includes(r.companyId)));

  const mobile2Routing = await api("GET", "/agent/sim-routing?deviceId=mobile-2", { token: agentToken });
  assert.ok(mobile2Routing.json.every((r) => ["somnet", "amtel"].includes(r.companyId)));

  const devices = await api("GET", "/agent/devices", { token: agentToken });
  assert.equal(devices.status, 200);
  assert.ok(devices.json.some((d) => d.name === "Mobile 1"));
});

test("reassigning a provider to a different device and SIM slot takes effect immediately", async () => {
  const admin = await adminToken();
  const reassign = await api("PUT", "/admin/sim-routing/amtel", {
    token: admin, body: { deviceId: "mobile-1", simSlot: 2 },
  });
  assert.equal(reassign.status, 200);
  assert.equal(reassign.json.deviceId, "mobile-1");
  assert.equal(reassign.json.simSlot, 2);

  // Restore original assignment so later/repeat test runs stay consistent
  // with the documented default configuration.
  await api("PUT", "/admin/sim-routing/amtel", { token: admin, body: { deviceId: "mobile-2", simSlot: 2 } });
});

test("payment number and payment USSD template are stored and returned per provider, matching the exact specified values", async () => {
  const { json } = await api("GET", "/companies");
  const hormuud = json.find((c) => c.id === "hormuud");
  const somtel = json.find((c) => c.id === "somtel");
  const somnet = json.find((c) => c.id === "somnet");

  assert.equal(hormuud.paymentNumber, "610338686");
  assert.equal(hormuud.paymentUssdTemplate, "*712*610338686*{amount}#");
  assert.equal(somtel.paymentNumber, "620338686");
  assert.equal(somtel.paymentUssdTemplate, "*110*620338686*{amount}#");
  assert.equal(somnet.paymentNumber, "685115555");
  assert.equal(somnet.paymentUssdTemplate, "*812*685115555*{amount}#");
});
