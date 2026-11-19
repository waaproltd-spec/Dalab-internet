import { Request, Response, NextFunction } from "express";
import { verifyToken } from "./crypto.js";
import { queryOne } from "../db/pool.js";
import { sendJson } from "../utils/camelCase.js";
import type { Permission } from "./permissions.js";

/**
 * Three separate roles:
 *
 *  - OWNER (super_admin): everything. Grants and revokes each Admin's
 *    permissions (admin_users.permissions) and each Agent's services
 *    (agents.services). Only the Owner changes either.
 *  - ADMIN (admin): only the dashboard sections the Owner granted --
 *    reading them as well as changing them (adminPermissionGate below; the
 *    changes are also checked route by route with requirePermission). An
 *    Admin with agents.manage manages agents (name, PIN, suspend, device)
 *    but never an agent's services.
 *  - AGENT (agent): only the services the Owner granted
 *    (agentServiceGate below). The phone's automatic work (SMS upload, USSD
 *    dialing, payment verification, the order queue) is the system's own
 *    machinery, not a service, and is never blocked here -- payments and
 *    deliveries must keep working whatever an agent may use by hand.
 *
 * Both gates read the database on every request, so a permission the Owner
 * switches off is blocked on the very next request -- no waiting for a
 * token to expire or for the person to sign in again.
 */

// ---------------- Agent services ----------------

export const AGENT_SERVICES = [
  { key: "operations", label: "Order operations", description: "Approve / reject payments, cancel, retry, reverse and complete orders" },
  { key: "sales", label: "New sale", description: "Create an order for a walk-in customer" },
  { key: "customers", label: "Customers", description: "View and manage customers, PINs, wallet numbers" },
  { key: "registration", label: "Register customer", description: "Register customers who pay without the app" },
  { key: "schedule", label: "Schedule transaction", description: "Schedule a package to be sent at a set time" },
  { key: "transactions", label: "Transaction history", description: "Order and payment history" },
  { key: "balances", label: "Balances", description: "SIM and wallet balances" },
  { key: "reports", label: "Reports", description: "Sales reports and dashboard" },
  { key: "exchange", label: "Money exchange", description: "Create exchange orders and quotes" },
  { key: "shop", label: "Shop orders", description: "Handle Shop orders" },
  { key: "vip_numbers", label: "VIP numbers", description: "Handle VIP number and VIP package orders" },
  { key: "ciyaaraha", label: "Ciyaaraha", description: "Football contests" },
  { key: "promo_ads", label: "Promo ads", description: "Manage promo ads" },
  { key: "other_agents", label: "Other agents", description: "See which agents are online" },
] as const;

export type AgentService = (typeof AGENT_SERVICES)[number]["key"];
export const AGENT_SERVICE_KEYS: string[] = AGENT_SERVICES.map((s) => s.key);
export const isAgentService = (v: unknown): v is AgentService => typeof v === "string" && AGENT_SERVICE_KEYS.includes(v);

/** Which agent request belongs to which service. Unlisted = always allowed. */
const AGENT_RULES: { methods?: string[]; re: RegExp; service: AgentService }[] = [
  { methods: ["POST"], re: /^\/agent\/orders\/[^/]+\/(approve-payment|reject-payment|cancel|retry|reverse|complete)$/, service: "operations" },
  { methods: ["POST"], re: /^\/agent\/orders$/, service: "sales" },
  { re: /^\/agent\/customers(\/|$)/, service: "customers" },
  { re: /^\/agent\/registered-/, service: "registration" },
  { re: /^\/agent\/scheduled-orders(\/|$)/, service: "schedule" },
  { re: /^\/agent\/(transactions|payment-transactions)(\/|$)/, service: "transactions" },
  { re: /^\/agent\/(balances|wallet-balances|sim-balances)$/, service: "balances" },
  { re: /^\/agent\/reports(\/|$)/, service: "reports" },
  { methods: ["POST"], re: /^\/agent\/exchange\/orders$/, service: "exchange" },
  { re: /^\/agent\/exchange\/quote$/, service: "exchange" },
  { re: /^\/agent\/shop\//, service: "shop" },
  { re: /^\/agent\/vip-numbers\//, service: "vip_numbers" },
  { re: /^\/agent\/football\/(?!me$)/, service: "ciyaaraha" },
  { re: /^\/agent\/promo-ads(\/|$)/, service: "promo_ads" },
  { re: /^\/agent\/agents$/, service: "other_agents" },
];

/** The service an agent request needs, or null when it needs none. */
export function agentServiceFor(method: string, path: string): AgentService | null {
  for (const r of AGENT_RULES) {
    if (r.methods && !r.methods.includes(method)) continue;
    if (r.re.test(path)) return r.service;
  }
  return null;
}

export async function agentServices(agentId: string): Promise<string[]> {
  const row = await queryOne<{ services: string[] | null }>(`SELECT services FROM agents WHERE id=$1`, [agentId]);
  return row?.services ?? [];
}

export async function agentHasService(agentId: string, service: AgentService): Promise<boolean> {
  return (await agentServices(agentId)).includes(service);
}

function bearer(req: Request) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? verifyToken(header.slice(7)) : null;
}

export async function agentServiceGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.path.startsWith("/agent/")) return next();
  const service = agentServiceFor(req.method, req.path);
  if (!service) return next();
  const payload = bearer(req);
  if (!payload || payload.role !== "agent") return next(); // the route's own auth answers
  if (await agentHasService(String(payload.sub), service)) return next();
  const label = AGENT_SERVICES.find((s) => s.key === service)?.label ?? service;
  sendJson(res, 403, { error: `${label} is not allowed for your account. Ask the owner to allow it.`, code: "service_not_allowed", service });
}

// ---------------- Admin sections ----------------

/**
 * Dashboard sections and the permission an Admin needs to open them
 * (reading included). Several keys = any one of them. Paths not listed
 * (overview, company/category/package/payment-wallet lists, settings, the
 * admin's own profile) are shared lookups every Admin's pages need.
 */
const ADMIN_RULES: { re: RegExp; any: Permission[] }[] = [
  { re: /^\/admin\/agents(\/|$)/, any: ["agents.manage"] },
  { re: /^\/admin\/agent-notices(\/|$)/, any: ["agents.manage"] },
  { re: /^\/admin\/agent-devices(\/|$)/, any: ["agents.manage", "devices.manage"] },
  { re: /^\/admin\/agent-registrations(\/|$)/, any: ["customers.manage", "orders.manage"] },
  { re: /^\/admin\/customers(\/|$)/, any: ["customers.manage"] },
  { re: /^\/admin\/(orders|offline|payment-transactions)(\/|$)/, any: ["orders.manage"] },
  { re: /^\/admin\/packages\/missing-template$/, any: ["packages.manage"] },
  { re: /^\/admin\/interactive-services(\/|$)/, any: ["packages.manage"] },
  { re: /^\/admin\/companies\/[^/]+\/pin-status$/, any: ["companies.manage"] },
  { re: /^\/admin\/(commissions|commission-rules)(\/|$)/, any: ["commissions.manage"] },
  { re: /^\/admin\/exchange\//, any: ["exchange.manage"] },
  { re: /^\/admin\/feedback(\/|$)/, any: ["feedback.manage"] },
  { re: /^\/admin\/finance\//, any: ["finance.manage"] },
  { re: /^\/admin\/(referrals|referral-rules)(\/|$)/, any: ["referrals.manage"] },
  { re: /^\/admin\/reports(\/|$)/, any: ["reports.export"] },
  { re: /^\/admin\/reseller/, any: ["resellers.manage"] },
  { re: /^\/admin\/notifications(\/|$)/, any: ["settings.manage"] },
  { re: /^\/admin\/banners(\/|$)/, any: ["settings.manage"] },
  { re: /^\/admin\/(sim-balances|sim-routing|sms-formats|sms-logs|sms-sender-ids|ussd-templates|execution-logs)(\/|$)/, any: ["devices.manage"] },
  { re: /^\/admin\/shop\//, any: ["shop.manage"] },
  { re: /^\/admin\/vip-numbers(\/|$)/, any: ["vipNumbers.manage"] },
  { re: /^\/admin\/football\//, any: ["football.manage"] },
  { re: /^\/admin\/support\//, any: ["support.manage"] },
];

export function adminPermissionsFor(path: string): Permission[] | null {
  for (const r of ADMIN_RULES) if (r.re.test(path)) return r.any;
  return null;
}

export async function adminPermissionGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.path.startsWith("/admin/")) return next();
  const needed = adminPermissionsFor(req.path);
  if (!needed) return next();
  const payload = bearer(req);
  if (!payload || payload.role !== "admin") return next(); // Owner passes; other roles hit the route's own auth
  const admin = await queryOne<{ permissions: string[] | null }>(`SELECT permissions FROM admin_users WHERE id=$1`, [payload.sub]);
  if (needed.some((p) => admin?.permissions?.includes(p))) return next();
  sendJson(res, 403, { error: `Missing the '${needed.join("' or '")}' permission. Ask the owner to grant it.`, code: "permission_required" });
}
