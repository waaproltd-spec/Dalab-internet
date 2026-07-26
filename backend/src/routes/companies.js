import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";

// Every company SELECT that can reach a client (including the public,
// unauthenticated /companies endpoint the customer app hits) must exclude
// pin_encrypted. It's AES-GCM ciphertext, not plaintext, but there is no
// reason it should ever leave the server — `SELECT *` here would have
// shipped it to every customer app request. Use this column list, not
// `SELECT *`, anywhere a company row is returned in an API response.
const COMPANY_COLUMNS = `id, name, group_number, color_hex, logo_url, status, gateway, payment_number, payment_ussd_template, ussd_code, created_at, updated_at`;

export function registerCompanyRoutes(app, db) {
  // ---------------- Public / customer-facing ----------------
  app.get("/companies", async (ctx) => {
    const rows = db.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY group_number, name`).all();
    ctx.json(200, rows);
  });

  app.get("/companies/:id/packages", async (ctx) => {
    const rows = db.prepare(
      `SELECT * FROM packages WHERE company_id = ? AND active = 1 ORDER BY category_id, price`
    ).all(ctx.params.id);
    ctx.json(200, rows);
  });

  // ---------------- Admin CRUD ----------------
  app.get("/admin/companies", requireAuth("super_admin"), async (ctx) => {
    ctx.json(200, db.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY group_number, name`).all());
  });

  app.post("/admin/companies", requireAuth("super_admin"), async (ctx) => {
    const { id, name, groupNumber, colorHex, gateway } = ctx.body;
    if (!id || !name || !groupNumber || !colorHex) {
      return ctx.json(400, { error: "id, name, groupNumber, colorHex are required" });
    }
    db.prepare(
      `INSERT INTO companies (id, name, group_number, color_hex, gateway, status)
       VALUES (?, ?, ?, ?, ?, 'online')`
    ).run(id, name, groupNumber, colorHex, gateway ?? "Manual");
    ctx.json(201, db.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ?`).get(id));
  });

  app.put("/admin/companies/:id", requireAuth("super_admin"), async (ctx) => {
    const existing = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(ctx.params.id);
    if (!existing) return ctx.json(404, { error: "Company not found" });
    const merged = { ...existing, ...ctx.body };
    db.prepare(
      `UPDATE companies SET name=?, group_number=?, color_hex=?, gateway=?, updated_at=datetime('now') WHERE id=?`
    ).run(merged.name, merged.group_number, merged.color_hex, merged.gateway, ctx.params.id);
    ctx.json(200, db.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ?`).get(ctx.params.id));
  });

  // Now also accepts paymentUssdTemplate — the literal string the CUSTOMER
  // dials to send payment (e.g. "*712*610338686*{amount}#"), distinct from
  // the ussd_templates table (which is what the AGENT dials to deliver the
  // package after payment is confirmed).
  app.put("/admin/companies/:id/payment-number", requireAuth("super_admin"), async (ctx) => {
    const existing = db.prepare(`SELECT payment_number, payment_ussd_template FROM companies WHERE id = ?`).get(ctx.params.id);
    if (!existing) return ctx.json(404, { error: "Company not found" });
    const paymentNumber = ctx.body.paymentNumber ?? existing.payment_number ?? "";
    const paymentUssdTemplate = ctx.body.paymentUssdTemplate ?? existing.payment_ussd_template ?? "";
    db.prepare(
      `UPDATE companies SET payment_number = ?, payment_ussd_template = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(paymentNumber, paymentUssdTemplate, ctx.params.id);
    ctx.json(200, db.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ?`).get(ctx.params.id));
  });

  app.put("/admin/companies/:id/status", requireAuth("super_admin"), async (ctx) => {
    const { status } = ctx.body;
    if (!["online", "offline"].includes(status)) return ctx.json(400, { error: "status must be online|offline" });
    const result = db.prepare(
      `UPDATE companies SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, ctx.params.id);
    if (result.changes === 0) return ctx.json(404, { error: "Company not found" });
    ctx.json(200, db.prepare(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = ?`).get(ctx.params.id));
  });
}

export function registerPackageRoutes(app, db) {
  app.get("/admin/packages", requireAuth("super_admin"), async (ctx) => {
    const { companyId } = ctx.query;
    const rows = companyId
      ? db.prepare(`SELECT * FROM packages WHERE company_id = ? ORDER BY category_id, price`).all(companyId)
      : db.prepare(`SELECT * FROM packages ORDER BY company_id, category_id, price`).all();
    ctx.json(200, rows);
  });

  app.post("/admin/packages", requireAuth("super_admin"), async (ctx) => {
    const { companyId, categoryId, name, oldPrice, price, mb, minutes, sms, validity } = ctx.body;
    if (!companyId || !categoryId || !name || price == null) {
      return ctx.json(400, { error: "companyId, categoryId, name, price are required" });
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO packages (id, company_id, category_id, name, old_price, price, mb, minutes, sms, validity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, companyId, categoryId, name, oldPrice ?? price, price, mb ?? 0, minutes ?? 0, sms ?? 0, validity ?? "");
    ctx.json(201, db.prepare(`SELECT * FROM packages WHERE id = ?`).get(id));
  });

  app.put("/admin/packages/:id", requireAuth("super_admin"), async (ctx) => {
    const existing = db.prepare(`SELECT * FROM packages WHERE id = ?`).get(ctx.params.id);
    if (!existing) return ctx.json(404, { error: "Package not found" });
    const merged = { ...existing, ...ctx.body };
    db.prepare(
      `UPDATE packages SET name=?, old_price=?, price=?, mb=?, minutes=?, sms=?, validity=?, active=? WHERE id=?`
    ).run(merged.name, merged.old_price, merged.price, merged.mb, merged.minutes, merged.sms, merged.validity,
          merged.active ? 1 : 0, ctx.params.id);
    ctx.json(200, db.prepare(`SELECT * FROM packages WHERE id = ?`).get(ctx.params.id));
  });

  // Soft delete only — a package that's already been ordered must stay in
  // history for receipts/reports, so this deactivates rather than removing
  // the row (same reasoning as the architecture doc's "no ON DELETE CASCADE"
  // guidance for companies/customers).
  app.delete("/admin/packages/:id", requireAuth("super_admin"), async (ctx) => {
    const result = db.prepare(`UPDATE packages SET active = 0 WHERE id = ?`).run(ctx.params.id);
    if (result.changes === 0) return ctx.json(404, { error: "Package not found" });
    ctx.json(200, { deactivated: true });
  });
}
