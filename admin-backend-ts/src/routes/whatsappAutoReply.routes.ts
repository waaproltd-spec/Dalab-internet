import express, { Router, Request, Response } from "express";
import { query, queryOne } from "../db/pool.js";
import { normalizeMobileDigits } from "../lib/phoneValidation.js";

export const whatsappAutoReplyRouter = Router();

const AUTO_REPLY_API_KEY = process.env.WHATSAPP_AUTO_REPLY_API_KEY || "";

const MAIN_MENU = `🚀 DALAB APP

Ku soo dhowow DALAB APP 👋

Fadlan dooro adeegga aad rabto:

1️⃣ Internet 🌐
2️⃣ eBadal 💱
3️⃣ Reseller 👤
4️⃣ Shop 🛍️
5️⃣ VIP Number 📱
6️⃣ Xaaladda Dalabka 📦

📞 WhatsApp: 0620338686
📲 Telegram: @Dalabapp33`;

const ORDER_STATUS_PROMPT = `📦 XAALADDA DALABKA

Fadlan soo dir Order ID-ga dalabka aad DALAB APP ku samaysay.`;

function isAuthorized(req: Request): boolean {
  if (!AUTO_REPLY_API_KEY) return false;
  const authorization = String(req.headers.authorization || "").trim();
  if (!authorization.startsWith("Bearer ")) return false;
  return authorization.slice("Bearer ".length).trim() === AUTO_REPLY_API_KEY;
}

function cleanOrderId(value: unknown): string {
  return String(value ?? "").trim().replace(/^#/, "").trim();
}

function looksLikeOrderStatusRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === "6" || normalized.includes("xaalad") || normalized === "status";
}

function orderStatusToSomali(status: string): string {
  switch (status) {
    case "pending":
      return "⏳ Weli waa socdaa";
    case "in_progress":
      return "🔄 Waa la fulinayaa";
    case "completed":
      return "✅ Waa la dhammeeyay";
    case "failed":
      return "❌ Wuu fashilmay";
    case "cancelled":
      return "🚫 Waa la joojiyay";
    default:
      return "⏳ Xaaladda dalabka wali waa la hubinayaa";
  }
}

function vipStatusToSomali(status: string): string {
  switch (status) {
    case "pending":
      return "⏳ Weli waa socdaa";
    case "processing":
      return "🔄 Waa la fulinayaa";
    case "completed":
      return "✅ Waa la dhammeeyay";
    case "failed":
      return "❌ Wuu fashilmay";
    case "cancelled":
      return "🚫 Waa la joojiyay";
    case "expired":
      return "⌛ Wakhtigii wuu dhacay";
    default:
      return "⏳ Xaaladda dalabka wali waa la hubinayaa";
  }
}

function formatMoney(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `$${n.toFixed(2)}`;
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-GB");
}

async function getConversationState(phoneKey: string): Promise<string> {
  const row = await queryOne<{ state: string }>(
    `SELECT state FROM whatsapp_conversation_state WHERE phone=$1`,
    [phoneKey]
  );
  return row?.state ?? "main";
}

async function setConversationState(
  phoneKey: string,
  state: "main" | "awaiting_order_id"
): Promise<void> {
  await query(
    `INSERT INTO whatsapp_conversation_state (phone, state, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (phone) DO UPDATE SET state=$2, updated_at=now()`,
    [phoneKey, state]
  );
}

/**
 * customers.phone is matched both as the local 9-digit form and the
 * 252-prefixed form, since we could not confirm from schema alone
 * which form is stored for every row.
 */
async function findCustomerByWhatsAppPhone(rawPhone: string) {
  const normalized = normalizeMobileDigits(rawPhone);
  if (!normalized || normalized.length !== 9) return null;
  return queryOne<{ id: string; name: string | null; phone: string }>(
    `SELECT id, name, phone FROM customers WHERE phone=$1 OR phone=$2 LIMIT 1`,
    [normalized, `252${normalized}`]
  );
}

function buildUnknownCustomerReply(): string {
  return `❌ Lambarka WhatsApp-kan kuma xirna akoon DALAB.

Fadlan isticmaal lambarka aad DALAB APP ku diiwaangashan tahay.

📞 WhatsApp: 0620338686
📲 Telegram: @Dalabapp33`;
}

function buildNotFoundReply(): string {
  return `❌ Dalabka lama helin.

Fadlan hubi Order ID-ga aad dirtay, ama hubi in dalabkaasi ku jiro lambarkan aad WhatsApp ka isticmaalayso.

📞 WhatsApp: 0620338686
📲 Telegram: @Dalabapp33`;
}

// ---- Internet order (orders) ----
async function findInternetOrder(orderId: string, customerId: string) {
  return queryOne<{
    id: string;
    status: string;
    amount: string | number;
    created_at: string | Date;
    company_name: string | null;
    package_name: string | null;
  }>(
    `SELECT o.id, o.status, o.amount, o.created_at,
            co.name AS company_name, p.name AS package_name
     FROM orders o
     JOIN companies co ON co.id = o.company_id
     JOIN packages p ON p.id = o.package_id
     WHERE o.id = $1 AND o.customer_id = $2
     LIMIT 1`,
    [orderId, customerId]
  );
}

// ---- eBadal order (exchange_orders) ----
async function findExchangeOrder(orderId: string, customerId: string) {
  return queryOne<{
    id: string;
    status: string;
    amount_sent: string | number;
    amount_received: string | number;
    created_at: string | Date;
    from_wallet_name: string | null;
    to_wallet_name: string | null;
  }>(
    `SELECT eo.id, eo.status, eo.amount_sent, eo.amount_received, eo.created_at,
            fw.name AS from_wallet_name, tw.name AS to_wallet_name
     FROM exchange_orders eo
     LEFT JOIN payment_wallets fw ON fw.id = eo.from_wallet_id
     LEFT JOIN payment_wallets tw ON tw.id = eo.to_wallet_id
     WHERE eo.id = $1 AND eo.customer_id = $2
     LIMIT 1`,
    [orderId, customerId]
  );
}

// ---- VIP number order (vip_number_orders) ----
async function findVipNumberOrder(orderId: string, customerId: string) {
  return queryOne<{
    id: string;
    status: string;
    payment_status: string;
    phone_number: string;
    category: string;
    price: string | number;
    created_at: string | Date;
  }>(
    `SELECT id, status, payment_status, phone_number, category, price, created_at
     FROM vip_number_orders
     WHERE id = $1 AND customer_id = $2
     LIMIT 1`,
    [orderId, customerId]
  );
}

async function buildOrderStatusReply(orderId: string, customerId: string): Promise<string> {
  const internetOrder = await findInternetOrder(orderId, customerId);
  if (internetOrder) {
    return `📦 DALABKA INTERNET-KA

🆔 Order ID: ${internetOrder.id}
🏢 Shirkad: ${internetOrder.company_name ?? "-"}
📶 Package: ${internetOrder.package_name ?? "-"}
💵 Qiimaha: ${formatMoney(internetOrder.amount)}
📅 Taariikhda: ${formatDate(internetOrder.created_at)}
📊 Xaalada: ${orderStatusToSomali(internetOrder.status)}

📞 WhatsApp: 0620338686
📲 Telegram: @Dalabapp33`;
  }

  const exchangeOrder = await findExchangeOrder(orderId, customerId);
  if (exchangeOrder) {
    return `📦 DALABKA EBADAL

🆔 Order ID: ${exchangeOrder.id}
💱 Laga diray: ${exchangeOrder.from_wallet_name ?? "-"}
💱 Loo diray: ${exchangeOrder.to_wallet_name ?? "-"}
💵 La diray: ${formatMoney(exchangeOrder.amount_sent)}
💵 La helay: ${formatMoney(exchangeOrder.amount_received)}
📅 Taariikhda: ${formatDate(exchangeOrder.created_at)}
📊 Xaalada: ${orderStatusToSomali(exchangeOrder.status)}

📞 WhatsApp: 0620338686
📲 Telegram: @Dalabapp33`;
  }

  const vipOrder = await findVipNumberOrder(orderId, customerId);
  if (vipOrder) {
    const categoryLabel = vipOrder.category === "gold" ? "Gold" : "Silver";
    return `📦 DALABKA VIP NUMBER

🆔 Order ID: ${vipOrder.id}
📱 Lambarka: ${vipOrder.phone_number}
🏷️ Nooca: ${categoryLabel}
💵 Qiimaha: ${formatMoney(vipOrder.price)}
📅 Taariikhda: ${formatDate(vipOrder.created_at)}
📊 Xaalada: ${vipStatusToSomali(vipOrder.status)}

📞 WhatsApp: 0620338686
📲 Telegram: @Dalabapp33`;
  }

  return buildNotFoundReply();
}

/**
 * READ-ONLY WhatsApp auto-reply webhook.
 * Only ever runs SELECT queries plus state-tracking upserts against
 * whatsapp_conversation_state. Never creates, updates, cancels an
 * order, or touches payment/USSD/customer data.
 */
whatsappAutoReplyRouter.use(express.json({ type: () => true, limit: "8mb" }));
whatsappAutoReplyRouter.use(express.json({ type: () => true, limit: "8mb" }));
whatsappAutoReplyRouter.post("/whatsapp/auto-reply", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rawPhone = String(
    req.body?.phone ??
    req.body?.sender_phone ??
    req.body?.from ??
    req.body?.from_number ??
    req.body?.phone_number ??
    req.body?.number ??
    req.body?.sender ??
    ""
  ).trim();

  const message = String(
    req.body?.message ??
    req.body?.text ??
    req.body?.body ??
    ""
  ).trim();

  if (!rawPhone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  const normalizedPhone = normalizeMobileDigits(rawPhone);
  const phoneKey = normalizedPhone || rawPhone;

  const state = await getConversationState(phoneKey);

  if (state === "awaiting_order_id") {
    const orderId = cleanOrderId(message);
    await setConversationState(phoneKey, "main");

    if (!orderId) {
      res.json({ reply: buildNotFoundReply() });
    return;
    }

    const customer = await findCustomerByWhatsAppPhone(rawPhone);
    if (!customer) {
      res.json({ reply: buildUnknownCustomerReply() });
    return;
    }

    const reply = await buildOrderStatusReply(orderId, customer.id);
    res.json({ reply });
    return;
  }

  if (looksLikeOrderStatusRequest(message)) {
    const customer = await findCustomerByWhatsAppPhone(rawPhone);
    if (!customer) {
      res.json({ reply: buildUnknownCustomerReply() });
    return;
    }
    await setConversationState(phoneKey, "awaiting_order_id");
    res.json({ reply: ORDER_STATUS_PROMPT });
    return;
  }

  res.json({ reply: MAIN_MENU });
    return;
});
