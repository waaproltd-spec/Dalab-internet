import { queryOne } from "../db/pool.js";

/**
 * Deterministic Somali intent-matcher for the in-app support chat --
 * explicitly NOT a generative model (no LLM call, no per-message cost, no
 * hallucination risk). Every answer either comes from a fixed, reviewed
 * Somali string or is built from a real database lookup (the customer's own
 * order/wallet data) -- never invented. If nothing matches with confidence,
 * this returns null and the caller (support.routes.ts) offers Agent/Admin
 * escalation instead of guessing, exactly matching the product requirement
 * that the AI must never pretend to know something it doesn't.
 *
 * Each intent is a plain keyword list plus a handler -- add more keywords or
 * intents here as real customer questions reveal gaps, no model retraining
 * involved.
 */

export interface AiAnswer {
  answer: string;
  intent: string;
}

interface Intent {
  name: string;
  keywords: string[];
  handle: (customerId: string) => Promise<string>;
}

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "Sugaya lacag-bixin",
  in_progress: "Waa la hawlgelinayaa",
  completed: "Waa la dhammeystiray",
  failed: "Wuu fashilmay",
  cancelled: "Waa la joojiyay",
};

async function handleOrderStatus(customerId: string): Promise<string> {
  const order = await queryOne<{ id: string; status: string; package_name: string; amount: string }>(
    `SELECT o.id, o.status, p.name AS package_name, o.amount
     FROM orders o JOIN packages p ON p.id = o.package_id
     WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 1`,
    [customerId]
  );
  if (!order) return "Wali wax dalab ah ma haysatid. Marka aad dalab sameyso, halkan ayaad ka arki kartaa xaaladdiisa.";
  const statusLabel = ORDER_STATUS_LABELS[order.status] ?? order.status;
  return `Dalabkaagii ugu dambeeyay (${order.package_name}, $${order.amount}) xaaladdiisu waa: ${statusLabel}. Lambarka dalabka: ${order.id}.`;
}

async function handleExchangeStatus(customerId: string): Promise<string> {
  const order = await queryOne<{ id: string; status: string; amount_sent: string; amount_received: string }>(
    `SELECT id, status, amount_sent, amount_received FROM exchange_orders
     WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (!order) return "Wali wax isku-beddel (eBadal) ah ma haysatid.";
  const statusLabel = ORDER_STATUS_LABELS[order.status] ?? order.status;
  return `Isku-beddelkaagii ugu dambeeyay ($${order.amount_sent} -> $${order.amount_received}) xaaladdiisu waa: ${statusLabel}. Lambarka: ${order.id}.`;
}

async function handleWalletNumbers(customerId: string): Promise<string> {
  const customer = await queryOne<{
    evc_plus_name: string | null;
    evc_plus_number: string | null;
    edahab_name: string | null;
    edahab_number: string | null;
  }>(`SELECT evc_plus_name, evc_plus_number, edahab_name, edahab_number FROM customers WHERE id=$1`, [customerId]);
  const parts: string[] = [];
  if (customer?.evc_plus_number) parts.push(`EVC Plus: +${customer.evc_plus_number} (${customer.evc_plus_name})`);
  if (customer?.edahab_number) parts.push(`eDahab: +${customer.edahab_number} (${customer.edahab_name})`);
  if (parts.length === 0) {
    return "Wali lambar EVC Plus ama eDahab kuguma keydin. Waxaad ka keydin kartaa Profile > Wallet Numbers.";
  }
  return `Lambarrada aad keydisay:\n${parts.join("\n")}\nHaddii aad rabto inaad wax ka bedesho, tag Profile > Wallet Numbers.`;
}

async function handlePaymentHelp(): Promise<string> {
  return (
    "Haddii lacagtaadu aysan u muuqan dalabkaaga: 1) Hubi in lambarka aad u dirtay lacagta uu sax yahay, " +
    "2) Hubi qadarka aad dirtay uu la mid yahay qiimaha dalabka, 3) Sug 1-2 daqiiqo, sida caadiga ah waa toos u dhacaa. " +
    "Haddii aysan wali shaqeynin, waxaan kuu geyn karnaa taageero dad ah."
  );
}

async function handleHowToOrder(): Promise<string> {
  return (
    "Si aad dalab u samayso: 1) Doorasho Internet ama eBadal bogga hore, 2) Dooro adeeg-bixiyaha iyo baakidhka aad rabto, " +
    "3) Geli lambarka aad dalabka u samaynayso, 4) Dir lacagta lambarka la muujiyay. Dalabkaagu si toos ah ayuu u bilaabmayaa " +
    "marka lacagta la xaqiijiyo."
  );
}

async function handleGreeting(): Promise<string> {
  return "Salaam! Waxaan kaa caawin karaa dalabyada, lacag-bixinta, iyo lambarrada EVC Plus/eDahab. Su'aashaada ii soo qor.";
}

const INTENTS: Intent[] = [
  {
    name: "greeting",
    keywords: ["salaan", "salam", "asc", "hello", "hi ", "nabad"],
    handle: handleGreeting,
  },
  {
    name: "order_status",
    keywords: ["dalab", "order", "xaalad", "xaggee", "internet-keyga", "baakidh"],
    handle: handleOrderStatus,
  },
  {
    name: "exchange_status",
    keywords: ["ebadal", "isku-beddel", "isku beddel", "exchange"],
    handle: handleExchangeStatus,
  },
  {
    name: "wallet_numbers",
    keywords: ["lambar", "evc plus", "edahab", "wallet", "xisaab"],
    handle: handleWalletNumbers,
  },
  {
    name: "payment_help",
    keywords: ["lacag", "payment", "lama helin", "ma bixin", "ma shaqeynayo", "khalad"],
    handle: handlePaymentHelp,
  },
  {
    name: "how_to_order",
    keywords: ["sidee", "sideed", "how to", "caawimaad", "u sameeyaa"],
    handle: handleHowToOrder,
  },
];

/**
 * Tries every intent in order and returns the first confident match.
 * Deliberately no scoring/ranking beyond "first keyword match wins" --
 * simple and auditable, matching the "never guess" requirement (a partial/
 * fuzzy match would be exactly the kind of guess this must avoid).
 */
export async function answerCustomerQuestion(customerId: string, message: string): Promise<AiAnswer | null> {
  const text = normalize(message);
  if (!text) return null;
  for (const intent of INTENTS) {
    if (matchesKeywords(text, intent.keywords)) {
      return { answer: await intent.handle(customerId), intent: intent.name };
    }
  }
  return null;
}
