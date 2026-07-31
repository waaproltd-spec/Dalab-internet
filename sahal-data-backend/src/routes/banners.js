import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";

export function registerBannerRoutes(app, db) {
  app.get("/banners", async (ctx) => {
    const rows = db.prepare(
      `SELECT * FROM banners WHERE active = 1
       AND (start_date IS NULL OR start_date <= date('now'))
       AND (end_date IS NULL OR end_date >= date('now'))
       ORDER BY position`
    ).all();
    ctx.json(200, rows);
  });

  app.get("/admin/banners", requireAuth("super_admin"), async (ctx) => {
    ctx.json(200, db.prepare(`SELECT * FROM banners ORDER BY position`).all());
  });

  app.post("/admin/banners", requireAuth("super_admin"), async (ctx) => {
    const { title, subtitle, gradient, targetCompanyId, startDate, endDate } = ctx.body;
    if (!title) return ctx.json(400, { error: "title is required" });
    const id = randomUUID();
    const maxPos = db.prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM banners`).get().m;
    db.prepare(
      `INSERT INTO banners (id, title, subtitle, gradient, target_company_id, position, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, title, subtitle ?? "", gradient ?? "", targetCompanyId ?? null, maxPos + 1, startDate ?? null, endDate ?? null);
    ctx.json(201, db.prepare(`SELECT * FROM banners WHERE id = ?`).get(id));
  });

  app.put("/admin/banners/:id", requireAuth("super_admin"), async (ctx) => {
    const existing = db.prepare(`SELECT * FROM banners WHERE id = ?`).get(ctx.params.id);
    if (!existing) return ctx.json(404, { error: "Banner not found" });
    const merged = { ...existing, ...ctx.body };
    db.prepare(
      `UPDATE banners SET title=?, subtitle=?, gradient=?, active=?, position=?, start_date=?, end_date=? WHERE id=?`
    ).run(merged.title, merged.subtitle, merged.gradient, merged.active ? 1 : 0, merged.position,
          merged.start_date, merged.end_date, ctx.params.id);
    ctx.json(200, db.prepare(`SELECT * FROM banners WHERE id = ?`).get(ctx.params.id));
  });

  app.delete("/admin/banners/:id", requireAuth("super_admin"), async (ctx) => {
    const result = db.prepare(`DELETE FROM banners WHERE id = ?`).run(ctx.params.id);
    if (result.changes === 0) return ctx.json(404, { error: "Banner not found" });
    ctx.json(200, { deleted: true });
  });
}
