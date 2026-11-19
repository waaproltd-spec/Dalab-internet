import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { requirePermission } from "../auth/permissions.js";
import { sendJson } from "../utils/camelCase.js";
import { recordActivity } from "../utils/activityLog.js";
import { validateMobileNumber, companyKeyFromLabel, normalizeMobileDigits } from "../lib/phoneValidation.js";
import { findOrCreateCustomerByPhone } from "../lib/customerPhone.js";
import { sendPushToAgent } from "../services/push.js";

/**
 * Agent Customer Registration.
 *
 * An agent registers a customer with four details -- name, payment sender
 * number, internet receiver number and network (Hormuud, Somnet,
 * Somtel or Amtel). The customer needs no app: this saves the customer's Rukumo
 * setup (the same customers.offline_* setup the Customer App saves), so
 * when that sender pays the company's payment number (on an agent phone),
 * the existing Rukumo pipeline (offlineAutoOrder.ts) verifies the payment
 * -- sender, amount, transaction ID (each used once), payment method/SIM
 * -- and only then creates the order, which is sent to the receiver
 * number on the selected network like every other order. Nothing here
 * creates a payment, a balance or an order by itself.
 *
 * A payment from a registered customer that can't become an order (no
 * service at that amount, two at one price, network offline, ...) is
 * recorded here (agent_registration_payment_issues), pushed to the agent
 * who registered the customer, and written to the Activity Log -- the
 * internet is never sent for it.
 */
export const agentRegistrationsRouter = Router();

/** The networks an agent can register a customer on. */
// Hormuud (EVC Plus), Somnet (Jeeb), Somtel (eDahab), Amtel (Amtel Pay), as companyKeyFromLabel names them.
export const REGISTRATION_NETWORKS = ["evc_plus", "jeeb", "edahab", "amtel_pay"];

const digits = (raw: unknown) => normalizeMobileDigits(String(raw ?? "")).replace(/^0+/, "");

/** Each order's payment (from the payment ledger) and delivery status. */
const ORDER_COLUMNS = `
  o.id, o.customer_id, o.status, o.amount, o.created_at, o.completed_at, o.updated_at,
  o.sender_phone, o.receiver_phone, o.channel, o.company_id, co.name AS company_name,
  COALESCE(o.package_name_snapshot, p.name) AS package_name,
  -- The transaction ID from the payment ledger, else from the payment SMS
  -- that was matched to this order.
  COALESCE(pt.transaction_ref, (SELECT s.transaction_ref FROM sms_logs s
             WHERE s.matched_order_id = o.id AND s.transaction_ref IS NOT NULL LIMIT 1)) AS transaction_ref,
  pt.status AS payment_status, pt.payment_timestamp AS paid_at,
  CASE WHEN pt.id IS NULL AND o.channel <> 'offline_auto' THEN 'awaiting_payment'
       WHEN pt.status = 'failed' THEN 'payment_failed'
       ELSE 'paid' END AS payment_state,
  CASE o.status WHEN 'completed' THEN 'delivered' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled'
                WHEN 'in_progress' THEN 'sending' ELSE 'waiting' END AS delivery_state`;

const ORDER_JOINS = `
  JOIN companies co ON co.id = o.company_id
  LEFT JOIN packages p ON p.id = o.package_id
  LEFT JOIN LATERAL (
    -- The payment itself (it carries the transaction ID), not the
    -- bookkeeping row added when the internet is sent (no transaction ID).
    SELECT id, transaction_ref, status, payment_timestamp FROM payment_transactions
     WHERE order_id = o.id ORDER BY (transaction_ref IS NULL), created_at DESC LIMIT 1
  ) pt ON true`;

/** One registration row: the customer, their setup and order totals. */
const REGISTRATION_SELECT = `
  SELECT c.id, c.name, c.phone, c.status, c.registered_by_agent_id, c.registered_by_agent_at,
         a.name AS agent_name, a.phone AS agent_phone,
         c.offline_sender_number AS sender_number, c.offline_destination_number AS receiver_number,
         c.offline_company_id AS company_id, co.name AS company_name, co.color_hex AS company_color,
         COALESCE(s.orders, 0) AS orders, COALESCE(s.delivered, 0) AS delivered, COALESCE(s.failed, 0) AS failed,
         COALESCE(s.total_paid, 0) AS total_paid, s.last_order_at,
         COALESCE(i.open_issues, 0) AS open_payment_issues
    FROM customers c
    LEFT JOIN agents a ON a.id = c.registered_by_agent_id
    LEFT JOIN companies co ON co.id = c.offline_company_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS orders,
             COUNT(*) FILTER (WHERE status='completed')::int AS delivered,
             COUNT(*) FILTER (WHERE status='failed')::int AS failed,
             COALESCE(SUM(amount) FILTER (WHERE status IN ('completed','in_progress') OR channel='offline_auto'), 0) AS total_paid,
             MAX(created_at) AS last_order_at
        FROM orders WHERE customer_id = c.id
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS open_issues FROM agent_registration_payment_issues
       WHERE customer_id = c.id AND resolved_at IS NULL
    ) i ON true
   WHERE c.registered_by_agent_id IS NOT NULL`;

// ---------------- Agent ----------------

agentRegistrationsRouter.post("/agent/registered-customers", requireAuth("agent"), async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const sender = String(req.body?.senderPhone ?? "").trim();
  const receiver = String(req.body?.receiverPhone ?? "").trim();
  const companyId = String(req.body?.companyId ?? "").trim();
  if (name.length < 2) return sendJson(res, 400, { error: "Enter the customer's full name.", code: "name_required" });

  const company = await queryOne<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM companies WHERE id=$1 AND deleted_at IS NULL`,
    [companyId]
  );
  const networkKey = company ? companyKeyFromLabel(company.name) ?? company.id : null;
  if (!company || !REGISTRATION_NETWORKS.includes(String(networkKey))) {
    return sendJson(res, 400, { error: "Choose Hormuud, Somnet, Somtel or Amtel.", code: "network_not_allowed" });
  }
  if (company.status === "offline") return sendJson(res, 409, { error: `${company.name} is currently offline`, code: "network_offline" });

  // Sender: any wallet number (EVC Plus, Jeeb, eDahab...). Receiver: a
  // number of the selected network, so the internet goes out through it.
  const senderCheck = validateMobileNumber(sender);
  if (!senderCheck.valid) return sendJson(res, 400, { error: senderCheck.error, code: "invalid_sender" });
  const receiverCheck = validateMobileNumber(receiver, String(networkKey));
  if (!receiverCheck.valid) return sendJson(res, 400, { error: receiverCheck.error, code: "invalid_receiver" });

  // The customer is identified by the number they pay from (any spelling of
  // it is the same customer -- lib/customerPhone.ts).
  const { customer, created } = await findOrCreateCustomerByPhone<{ id: string; name: string | null; status: string; registered_by_agent_id: string | null }>(
    sender,
    { name },
    "id, name, status, registered_by_agent_id"
  );
  if (customer.status === "blocked") return sendJson(res, 409, { error: "This customer is blocked.", code: "customer_blocked" });
  await query(
    `UPDATE customers
        SET name = COALESCE(NULLIF(name, ''), $2),
            offline_sender_number = $3, offline_destination_number = $4, offline_company_id = $5,
            offline_package_id = NULL, offline_payment_method_id = NULL, offline_profile_updated_at = now(),
            registered_by_agent_id = $6, registered_by_agent_at = now()
      WHERE id = $1`,
    [customer.id, name, `252${digits(sender)}`, `252${digits(receiver)}`, company.id, req.auth!.sub]
  );
  await recordActivity({
    adminId: undefined,
    action: "agent_registered_customer",
    entityType: "customer",
    entityId: customer.id,
    oldValue: created ? null : { registeredByAgentId: customer.registered_by_agent_id },
    newValue: { agentId: req.auth!.sub, name, senderPhone: sender, receiverPhone: receiver, companyId: company.id },
  });

  const registration = await queryOne(`${REGISTRATION_SELECT} AND c.id = $1`, [customer.id]);
  sendJson(res, created ? 201 : 200, { ...registration, created });
});

/** The networks and the pay-to numbers, for the registration form. */
agentRegistrationsRouter.get("/agent/registered-customers/options", requireAuth("agent"), async (_req, res) => {
  const companies = await query<{ id: string; name: string; status: string; color_hex: string }>(
    `SELECT id, name, status, color_hex FROM companies WHERE deleted_at IS NULL ORDER BY group_number, sort_order, name`
  );
  sendJson(res, 200, {
    networks: companies.filter((c) => REGISTRATION_NETWORKS.includes(String(companyKeyFromLabel(c.name) ?? c.id))),
  });
});

agentRegistrationsRouter.get("/agent/registered-customers", requireAuth("agent"), async (req, res) => {
  const search = String(req.query.search ?? "").trim();
  const args: unknown[] = [req.auth!.sub];
  let sql = `${REGISTRATION_SELECT} AND c.registered_by_agent_id = $1`;
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND (c.name ILIKE $2 OR c.phone ILIKE $2 OR c.offline_sender_number ILIKE $2 OR c.offline_destination_number ILIKE $2)`;
  }
  sendJson(res, 200, await query(`${sql} ORDER BY c.registered_by_agent_at DESC LIMIT 500`, args));
});

agentRegistrationsRouter.get("/agent/registered-customers/:id", requireAuth("agent"), async (req, res) => {
  const registration = await queryOne(`${REGISTRATION_SELECT} AND c.registered_by_agent_id = $1 AND c.id = $2`, [req.auth!.sub, req.params.id]);
  if (!registration) return sendJson(res, 404, { error: "Not one of your registered customers" });
  const orders = await query(`SELECT ${ORDER_COLUMNS} FROM orders o ${ORDER_JOINS} WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 100`, [req.params.id]);
  const issues = await query(
    `SELECT id, sender_phone, amount, transaction_ref, reason, created_at, resolved_at FROM agent_registration_payment_issues
      WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.params.id]
  );
  sendJson(res, 200, { ...registration, orders, paymentIssues: issues });
});

/** The agent's transaction history: every order of the customers they registered. */
agentRegistrationsRouter.get("/agent/registered-transactions", requireAuth("agent"), async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT ${ORDER_COLUMNS}, c.name AS customer_name FROM orders o ${ORDER_JOINS}
         JOIN customers c ON c.id = o.customer_id
        WHERE c.registered_by_agent_id = $1
        ORDER BY o.created_at DESC LIMIT 300`,
      [req.auth!.sub]
    )
  );
});

agentRegistrationsRouter.get("/agent/registered-payment-issues", requireAuth("agent"), async (req, res) => {
  sendJson(
    res,
    200,
    await query(
      `SELECT i.id, i.customer_id, c.name AS customer_name, i.sender_phone, i.amount, i.transaction_ref, i.reason, i.created_at, i.resolved_at
         FROM agent_registration_payment_issues i JOIN customers c ON c.id = i.customer_id
        WHERE i.agent_id = $1 ORDER BY i.created_at DESC LIMIT 200`,
      [req.auth!.sub]
    )
  );
});

// ---------------- Admin ----------------

agentRegistrationsRouter.get("/admin/agent-registrations", requireStaff(), async (req, res) => {
  const agentId = String(req.query.agentId ?? "").trim();
  const search = String(req.query.search ?? "").trim();
  const args: unknown[] = [];
  let sql = REGISTRATION_SELECT;
  if (agentId) {
    args.push(agentId);
    sql += ` AND c.registered_by_agent_id = $${args.length}`;
  }
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND (c.name ILIKE $${args.length} OR c.phone ILIKE $${args.length} OR c.offline_destination_number ILIKE $${args.length} OR a.name ILIKE $${args.length})`;
  }
  const rows = await query(`${sql} ORDER BY c.registered_by_agent_at DESC LIMIT 1000`, args);
  const totals = await queryOne(
    `SELECT COUNT(*)::int AS registrations,
            COUNT(DISTINCT c.registered_by_agent_id)::int AS agents,
            (SELECT COUNT(*)::int FROM orders o JOIN customers c2 ON c2.id = o.customer_id WHERE c2.registered_by_agent_id IS NOT NULL AND o.status='completed') AS delivered,
            (SELECT COUNT(*)::int FROM orders o JOIN customers c2 ON c2.id = o.customer_id WHERE c2.registered_by_agent_id IS NOT NULL AND o.status='failed') AS failed,
            (SELECT COUNT(*)::int FROM agent_registration_payment_issues WHERE resolved_at IS NULL) AS open_payment_issues
       FROM customers c WHERE c.registered_by_agent_id IS NOT NULL`
  );
  sendJson(res, 200, { totals, registrations: rows });
});

agentRegistrationsRouter.get("/admin/agent-registrations/transactions", requireStaff(), async (req, res) => {
  const agentId = String(req.query.agentId ?? "").trim();
  const state = String(req.query.state ?? "").trim(); // delivered | failed | waiting | sending
  const args: unknown[] = [];
  let sql = `SELECT ${ORDER_COLUMNS}, c.name AS customer_name, a.id AS agent_id, a.name AS agent_name
               FROM orders o ${ORDER_JOINS}
               JOIN customers c ON c.id = o.customer_id
               LEFT JOIN agents a ON a.id = c.registered_by_agent_id
              WHERE c.registered_by_agent_id IS NOT NULL`;
  if (agentId) {
    args.push(agentId);
    sql += ` AND c.registered_by_agent_id = $${args.length}`;
  }
  const statusFor: Record<string, string> = { delivered: "completed", failed: "failed", sending: "in_progress", waiting: "pending" };
  if (statusFor[state]) {
    args.push(statusFor[state]);
    sql += ` AND o.status = $${args.length}`;
  }
  sendJson(res, 200, await query(`${sql} ORDER BY o.created_at DESC LIMIT 500`, args));
});

agentRegistrationsRouter.get("/admin/agent-registrations/payment-issues", requireStaff(), async (req, res) => {
  const open = req.query.open !== "0";
  sendJson(
    res,
    200,
    await query(
      `SELECT i.*, c.name AS customer_name, a.name AS agent_name FROM agent_registration_payment_issues i
         JOIN customers c ON c.id = i.customer_id LEFT JOIN agents a ON a.id = i.agent_id
        ${open ? "WHERE i.resolved_at IS NULL" : ""}
        ORDER BY i.created_at DESC LIMIT 500`
    )
  );
});

agentRegistrationsRouter.put("/admin/agent-registrations/payment-issues/:id/resolve", requirePermission("orders.manage"), async (req, res) => {
  const row = await queryOne(
    `UPDATE agent_registration_payment_issues SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
    [req.params.id, req.auth!.sub]
  );
  if (!row) return sendJson(res, 404, { error: "Issue not found or already resolved" });
  await recordActivity({
    adminId: req.auth!.sub,
    action: "agent_registration_payment_issue_resolved",
    entityType: "customer",
    entityId: String((row as any).customer_id),
    oldValue: null,
    newValue: { issueId: req.params.id },
  });
  sendJson(res, 200, row);
});

agentRegistrationsRouter.get("/admin/agent-registrations/:customerId", requireStaff(), async (req, res) => {
  const registration = await queryOne(`${REGISTRATION_SELECT} AND c.id = $1`, [req.params.customerId]);
  if (!registration) return sendJson(res, 404, { error: "Registration not found" });
  const orders = await query(`SELECT ${ORDER_COLUMNS} FROM orders o ${ORDER_JOINS} WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 200`, [
    req.params.customerId,
  ]);
  const issues = await query(`SELECT * FROM agent_registration_payment_issues WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`, [
    req.params.customerId,
  ]);
  sendJson(res, 200, { ...registration, orders, paymentIssues: issues });
});

// ---------------- Payment problems ----------------

/**
 * A payment from a sender that belongs to an agent-registered customer
 * could not become an order ([reason], from the Rukumo pipeline): keep it
 * as an open issue (once per transaction ID), tell the agent who registered
 * the customer, and write it to the Activity Log for admins. Never creates
 * or sends anything. Best-effort: never breaks SMS processing.
 */
export async function recordRegistrationPaymentIssue(params: {
  senderPhone: string | undefined;
  amount: number | undefined;
  transactionRef: string | null | undefined;
  reason: string;
}): Promise<void> {
  try {
    const target = digits(params.senderPhone).slice(-9);
    if (target.length !== 9) return;
    const customer = await queryOne<{ id: string; name: string | null; registered_by_agent_id: string }>(
      `SELECT id, name, registered_by_agent_id FROM customers
        WHERE registered_by_agent_id IS NOT NULL AND offline_sender_number IS NOT NULL
          AND RIGHT(regexp_replace(offline_sender_number, '\\D', '', 'g'), 9) = $1
        ORDER BY offline_profile_updated_at DESC NULLS LAST LIMIT 1`,
      [target]
    );
    if (!customer) return;
    const issue = await queryOne<{ id: string }>(
      `INSERT INTO agent_registration_payment_issues (customer_id, agent_id, sender_phone, amount, transaction_ref, reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (customer_id, transaction_ref) WHERE transaction_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [customer.id, customer.registered_by_agent_id, `252${target}`, params.amount ?? null, params.transactionRef || null, params.reason]
    );
    if (!issue) return; // this transaction was already reported
    await recordActivity({
      adminId: undefined,
      action: "agent_registration_payment_failed",
      entityType: "customer",
      entityId: customer.id,
      oldValue: null,
      newValue: { issueId: issue.id, agentId: customer.registered_by_agent_id, amount: params.amount, transactionRef: params.transactionRef, reason: params.reason },
    });
    await sendPushToAgent(customer.registered_by_agent_id, {
      title: "Payment not processed",
      body: `${customer.name || "Customer"} paid $${Number(params.amount ?? 0).toFixed(2)} from ${target}: ${params.reason}. No internet was sent.`,
      data: { type: "agent_registration_payment_issue", customerId: customer.id, issueId: issue.id },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("recordRegistrationPaymentIssue failed (non-fatal):", (err as Error).message);
  }
}
