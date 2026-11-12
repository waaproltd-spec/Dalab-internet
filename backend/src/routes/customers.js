import { requireAuth } from "../auth/middleware.js";

export function registerCustomerRoutes(app, db) {
  app.get("/admin/customers", requireAuth("super_admin"), async (ctx) => {
    const { search } = ctx.query;
    const rows = search
      ? db.prepare(`SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY created_at DESC`)
          .all(`%${search}%`, `%${search}%`)
      : db.prepare(`SELECT * FROM customers ORDER BY created_at DESC`).all();
    ctx.json(200, rows);
  });

  app.put("/admin/customers/:id/block", requireAuth("super_admin"), async (ctx) => {
    const existing = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(ctx.params.id);
    if (!existing) return ctx.json(404, { error: "Customer not found" });
    db.prepare(`UPDATE customers SET status = CASE WHEN status = 'active' THEN 'blocked' ELSE 'active' END WHERE id = ?`).run(ctx.params.id);
    ctx.json(200, db.prepare(`SELECT * FROM customers WHERE id = ?`).get(ctx.params.id));
  });
}
