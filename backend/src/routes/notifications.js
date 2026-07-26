import { randomUUID } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";

export function registerNotificationRoutes(app, db) {
  app.post("/admin/notifications/send", requireAuth("super_admin"), async (ctx) => {
    const { type, title, body } = ctx.body;
    if (!["push", "promotion", "maintenance"].includes(type) || !title) {
      return ctx.json(400, { error: "type (push|promotion|maintenance) and title are required" });
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO notifications (id, type, title, body) VALUES (?, ?, ?, ?)`).run(id, type, title, body ?? "");
    // A real deployment fans this out via FCM/APNs here; this sandbox only
    // persists the record so both apps' "Notifications" screens have
    // something real to read.
    ctx.json(201, db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id));
  });

  app.get("/agent/notifications", requireAuth("agent"), async (ctx) => {
    ctx.json(200, db.prepare(`SELECT * FROM notifications ORDER BY sent_at DESC LIMIT 50`).all());
  });

  app.get("/notifications", requireAuth("customer"), async (ctx) => {
    ctx.json(200, db.prepare(`SELECT * FROM notifications WHERE type != 'maintenance' ORDER BY sent_at DESC LIMIT 50`).all());
  });
}
