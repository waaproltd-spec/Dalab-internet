import { Router } from "express";
import { randomUUID } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireStaff } from "../auth/middleware.js";
import { sendJson } from "../utils/camelCase.js";

export const customersRouter = Router();

customersRouter.get("/admin/customers", requireStaff(), async (req, res) => {
  const { search } = req.query;
  const rows = search
    ? await query(`SELECT * FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY created_at DESC`, [`%${search}%`])
    : await query(`SELECT * FROM customers ORDER BY created_at DESC`);
  sendJson(res, 200, rows);
});

customersRouter.put("/admin/customers/:id/block", requireStaff(), async (req, res) => {
  const customer = await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.params.id]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  const nextStatus = customer.status === "active" ? "blocked" : "active";
  await query(`UPDATE customers SET status=$1 WHERE id=$2`, [nextStatus, req.params.id]);
  sendJson(res, 200, await queryOne(`SELECT * FROM customers WHERE id=$1`, [req.params.id]));
});

// ---------------- Agent: customer lookup (for walk-in sales) ----------------
// pin_encrypted/password fields don't exist on customers, but explicit
// column list still keeps this in sync with what the Agent App actually needs.
const AGENT_CUSTOMER_COLUMNS = "id, phone, name, status, macaash_points, created_at";

customersRouter.get("/agent/customers", requireAuth("agent"), async (req, res) => {
  const { search } = req.query;
  const rows = search
    ? await query(
        `SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE name ILIKE $1 OR phone ILIKE $1 ORDER BY created_at DESC`,
        [`%${search}%`]
      )
    : await query(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers ORDER BY created_at DESC`);
  sendJson(res, 200, rows);
});

customersRouter.post("/agent/customers", requireAuth("agent"), async (req, res) => {
  const phone = String(req.body.phone ?? "").trim();
  if (!/^\+?\d{6,15}$/.test(phone)) return sendJson(res, 400, { error: "Provide a valid phone number" });
  const name = req.body.name ? String(req.body.name).trim() : null;

  const existing = await queryOne(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE phone=$1`, [phone]);
  if (existing) return sendJson(res, 409, { error: "A customer with this phone already exists", customer: existing });

  const id = randomUUID();
  await query(`INSERT INTO customers (id, phone, name) VALUES ($1,$2,$3)`, [id, phone, name]);
  sendJson(res, 201, await queryOne(`SELECT ${AGENT_CUSTOMER_COLUMNS} FROM customers WHERE id=$1`, [id]));
});

// ---------------- Customer: own profile ----------------
const CUSTOMER_PROFILE_COLUMNS = "id, phone, name, macaash_points, created_at";

customersRouter.get("/customer/profile", requireAuth("customer"), async (req, res) => {
  const customer = await queryOne(`SELECT ${CUSTOMER_PROFILE_COLUMNS} FROM customers WHERE id=$1`, [req.auth!.sub]);
  if (!customer) return sendJson(res, 404, { error: "Customer not found" });
  sendJson(res, 200, customer);
});

customersRouter.put("/customer/profile", requireAuth("customer"), async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return sendJson(res, 400, { error: "name is required" });
  await query(`UPDATE customers SET name=$1 WHERE id=$2`, [name, req.auth!.sub]);
  sendJson(res, 200, await queryOne(`SELECT ${CUSTOMER_PROFILE_COLUMNS} FROM customers WHERE id=$1`, [req.auth!.sub]));
});
