import { randomUUID } from "node:crypto";

export function seedCatalog(db) {
  const companies = [
    { id: "hormuud", name: "Hormuud", group_number: 1, color_hex: "#16A34A", gateway: "EVC Plus", ussd_code: "*770#", payment_number: "610338686", payment_ussd_template: "*712*610338686*{amount}#" },
    { id: "somnet", name: "Somnet", group_number: 1, color_hex: "#1D4ED8", gateway: "JEEB", ussd_code: "*828#", payment_number: "685115555", payment_ussd_template: "*812*685115555*{amount}#" },
    { id: "somtel", name: "Somtel", group_number: 2, color_hex: "#F2C200", gateway: "eDahab", ussd_code: "*883#", payment_number: "620338686", payment_ussd_template: "*110*620338686*{amount}#" },
    { id: "amtel", name: "Amtel", group_number: 2, color_hex: "#C81E2C", gateway: "Manual", ussd_code: "*505#", payment_number: null, payment_ussd_template: null },
  ];

  for (const c of companies) {
    if (db.prepare(`SELECT id FROM companies WHERE id = ?`).get(c.id)) continue;
    db.prepare(
      `INSERT INTO companies (id, name, group_number, color_hex, gateway, ussd_code, payment_number, payment_ussd_template, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'online')`
    ).run(c.id, c.name, c.group_number, c.color_hex, c.gateway, c.ussd_code, c.payment_number, c.payment_ussd_template);
  }
  // Amtel starts offline, matching the customer app prototype's default state.
  db.prepare(`UPDATE companies SET status = 'offline' WHERE id = 'amtel'`).run();

  const packages = [
    // Hormuud — Anfac (real pricing confirmed against the reference screenshots)
    { company: "hormuud", category: "anfac", name: "Anfac Kuhadal", old: 0.10, price: 0.09, minutes: 8, validity: "30 maalin" },
    { company: "hormuud", category: "anfac", name: "Anfac Kuhadal", old: 0.50, price: 0.45, minutes: 40, validity: "30 maalin" },
    { company: "hormuud", category: "anfac", name: "Anfac Kuhadal", old: 1.00, price: 0.88, minutes: 80, validity: "30 maalin" },
    // Hormuud — Anfac Plus
    { company: "hormuud", category: "anfac-plus", name: "Anfac Plus", old: 0.25, price: 0.22, mb: 400, minutes: 10, validity: "1 day" },
    { company: "hormuud", category: "anfac-plus", name: "Anfac Plus", old: 0.50, price: 0.45, mb: 850, minutes: 30, validity: "10 days" },
    { company: "hormuud", category: "anfac-plus", name: "Anfac Plus", old: 1.00, price: 0.89, mb: 2048, minutes: 80, sms: 50, validity: "2 weeks" },
    { company: "hormuud", category: "anfac-plus", name: "Anfac Plus", old: 2.00, price: 1.78, mb: 5120, minutes: 160, sms: 100, validity: "1 month" },
    // Somnet — Qanciye Plus
    { company: "somnet", category: "qanciye-plus", name: "Qanciye Plus 170MB", old: 0.10, price: 0.09, mb: 170, minutes: 5, validity: "no expire" },
    { company: "somnet", category: "qanciye-plus", name: "Qanciye Plus 425MB", old: 0.25, price: 0.23, mb: 425, minutes: 11, sms: 10, validity: "no expire" },
    { company: "somnet", category: "qanciye-plus", name: "Qanciye Plus 1.2GB", old: 0.50, price: 0.45, mb: 1229, minutes: 35, sms: 25, validity: "no expire" },
    { company: "somnet", category: "qanciye-plus", name: "Qanciye Plus 2.5GB", old: 1.00, price: 0.89, mb: 2560, validity: "no expire" },
    // Somtel — Unlimited Data & Voice
    { company: "somtel", category: "unlimited-data-voice", name: "Unlimited Data & Voice", old: 0.20, price: 0.18, validity: "6 saac" },
    { company: "somtel", category: "unlimited-data-voice", name: "Unlimited Data & Voice", old: 0.35, price: 0.31, validity: "12 saac" },
    { company: "somtel", category: "unlimited-data-voice", name: "Unlimited Data & Voice", old: 0.50, price: 0.45, validity: "24 saac" },
    // Amtel — Unlimited Data & Voice
    { company: "amtel", category: "unlimited-data-voice", name: "Unlimited Data & Voice", old: 0.25, price: 0.23, validity: "10 saac" },
    { company: "amtel", category: "unlimited-data-voice", name: "Unlimited Data & Voice", old: 0.50, price: 0.45, validity: "36 saac" },
    { company: "amtel", category: "unlimited-data-voice", name: "Unlimited Data & Voice", old: 1.00, price: 0.88, validity: "3 maalin" },
  ];

  const existingCount = db.prepare(`SELECT COUNT(*) AS n FROM packages`).get().n;
  if (existingCount === 0) {
    const insert = db.prepare(
      `INSERT INTO packages (id, company_id, category_id, name, old_price, price, mb, minutes, sms, validity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of packages) {
      insert.run(randomUUID(), p.company, p.category, p.name, p.old, p.price, p.mb ?? 0, p.minutes ?? 0, p.sms ?? 0, p.validity);
    }
  }

  if (!db.prepare(`SELECT id FROM banners LIMIT 1`).get()) {
    db.prepare(
      `INSERT INTO banners (id, title, subtitle, gradient, position, active) VALUES (?, ?, ?, ?, 1, 1)`
    ).run(randomUUID(), "Weekend Data Bonus", "Get 20% extra MB on Anfac Plus, Fri–Sun", "linear-gradient(135deg,#1D2E8C,#2A3FC0)");
  }
}

export function seedUssdTemplates(db) {
  const templates = [
    // AMTEL
    { company: "amtel", name: "Tanaad GB", code: "*914*{number}*{amount}*8233{pin}#" },
    { company: "amtel", name: "Bulaal Unlimited Data", code: "*918*{number}*{amount}*8233{pin}#" },
    // SOMNET
    { company: "somnet", name: "Kaafi Unlimited Data & Voice", code: "*834*{number}*{amount}*8233{pin}#" },
    { company: "somnet", name: "Kaafi Voice", code: "*829*{number}*{amount}*8233{pin}#" },
    { company: "somnet", name: "Qanciye Plus", code: "*830*{number}*{amount}*8233{pin}#" },
    { company: "somnet", name: "Unlimited Data & Voice", code: "*834*{number}*{amount}*8233{pin}#" },
    { company: "somnet", name: "5G", code: "*827*{number}*{amount}*8233{pin}#" },
    // HORMUUD
    { company: "hormuud", name: "Anfac", code: "*737*{number}*{amount}*8233{pin}#" },
    { company: "hormuud", name: "Anfac Plus", code: "*738*{number}*{amount}*8233{pin}#" },
    { company: "hormuud", name: "Unlimited Data & Voice", code: "*729*{number}*{amount}*8233{pin}#" },
    { company: "hormuud", name: "Unlimited Calls", code: "*741*{number}*{amount}*8233{pin}#" },
    { company: "hormuud", name: "5G Plus", code: "*727*{number}*{amount}*8233{pin}#" },
    { company: "hormuud", name: "ADSL Plus", code: "*729*{number}*{amount}*8233{pin}#" },
    { company: "hormuud", name: "Kaar Kuhadal", code: "*727*{number}*{amount}*8233{pin}#" },
    // SOMTEL
    { company: "somtel", name: "Unlimited Data & Voice", code: "*831*{number}*{amount}*8233{pin}#" },
    { company: "somtel", name: "No Expire", code: "*830*{number}*{amount}*8233{pin}#" },
    { company: "somtel", name: "Unlimited Calls", code: "*834*{number}*{amount}*8233{pin}#" },
    { company: "somtel", name: "Voice", code: "*832*{number}*{amount}*8233{pin}#" },
  ];

  const existing = db.prepare(`SELECT COUNT(*) AS n FROM ussd_templates`).get().n;
  if (existing > 0) return; // idempotent — only seed once

  const insert = db.prepare(
    `INSERT INTO ussd_templates (id, company_id, service_name, ussd_code, status) VALUES (?, ?, ?, ?, 'enabled')`
  );
  for (const t of templates) {
    insert.run(randomUUID(), t.company, t.name, t.code);
  }
}

export function seedAgentDevices(db) {
  const devices = [
    { id: "mobile-1", name: "Mobile 1", description: "SIM 1: Hormuud (+252610338686) — SIM 2: Somtel (+252620338686)" },
    { id: "mobile-2", name: "Mobile 2", description: "SIM 1: Somnet (+252685115555) — SIM 2: Amtel" },
  ];
  for (const d of devices) {
    if (db.prepare(`SELECT id FROM agent_devices WHERE id = ?`).get(d.id)) continue;
    db.prepare(`INSERT INTO agent_devices (id, name, description) VALUES (?, ?, ?)`).run(d.id, d.name, d.description);
  }

  // Mobile 1: SIM1->Hormuud, SIM2->Somtel · Mobile 2: SIM1->Somnet, SIM2->Amtel
  const routing = [
    { company: "hormuud", device: "mobile-1", slot: 1 },
    { company: "somtel", device: "mobile-1", slot: 2 },
    { company: "somnet", device: "mobile-2", slot: 1 },
    { company: "amtel", device: "mobile-2", slot: 2 },
  ];
  for (const r of routing) {
    if (db.prepare(`SELECT company_id FROM sim_routing WHERE company_id = ?`).get(r.company)) continue;
    db.prepare(`INSERT INTO sim_routing (company_id, device_id, sim_slot) VALUES (?, ?, ?)`).run(r.company, r.device, r.slot);
  }
}
