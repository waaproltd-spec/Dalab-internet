import { query, queryOne } from "../db/pool.js";

/**
 * Deterministic Somali intent-matcher for the in-app "Dalab AI Assistant" --
 * explicitly NOT a generative model (no LLM call, no per-message cost, no
 * hallucination risk). Every answer either comes from a fixed, reviewed
 * Somali string or is built from a real database lookup (the customer's own
 * order/wallet/payment data, or the live catalog/corridor data) -- never
 * invented. If nothing matches with confidence, this returns null and the
 * caller (support.routes.ts) offers Agent/Admin escalation instead of
 * guessing. A matched answer can also set needsEscalation: true when the
 * real data it looked up shows an actual unresolved problem (e.g. a failed
 * payment) -- the customer still gets a real, data-grounded explanation
 * first, and is then offered a human on top of it, rather than being told to
 * "go contact support" with no context.
 *
 * Each intent is a plain keyword list plus a handler -- add more keywords or
 * intents here as real customer questions reveal gaps, no model retraining
 * involved. Order matters: intents are tried top to bottom and the first
 * keyword match wins, so more specific phrasings (e.g. "what is eBadal")
 * are listed before broader ones that share a keyword (e.g. "eBadal" alone,
 * used by the customer's-own-order lookup).
 */

export interface AiAnswer {
  answer: string;
  intent: string;
  needsEscalation: boolean;
}

interface IntentResult {
  text: string;
  needsEscalation?: boolean;
}

interface Intent {
  name: string;
  keywords: string[];
  handle: (customerId: string) => Promise<IntentResult>;
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

interface LatestActivity {
  type: "internet" | "exchange";
  id: string;
  status: string;
  amount: string;
  label: string;
}

// Backs every "my latest order / how much did I pay / did you receive my
// money" question -- looks at BOTH Internet orders and eBadal exchanges and
// returns whichever is actually more recent, since the customer rarely
// specifies which service they mean.
async function loadLatestActivity(customerId: string): Promise<LatestActivity | null> {
  const [order, exchange] = await Promise.all([
    queryOne<{ id: string; status: string; amount: string; package_name: string; created_at: string }>(
      `SELECT o.id, o.status, o.amount, p.name AS package_name, o.created_at
       FROM orders o JOIN packages p ON p.id = o.package_id
       WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 1`,
      [customerId]
    ),
    queryOne<{ id: string; status: string; amount_sent: string; receiver_phone: string; created_at: string }>(
      `SELECT id, status, amount_sent, receiver_phone, created_at FROM exchange_orders
       WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    ),
  ]);
  if (!order && !exchange) return null;
  if (order && (!exchange || new Date(order.created_at) >= new Date(exchange.created_at))) {
    return { type: "internet", id: order.id, status: order.status, amount: order.amount, label: order.package_name };
  }
  return {
    type: "exchange",
    id: exchange!.id,
    status: exchange!.status,
    amount: exchange!.amount_sent,
    label: `eBadal -> ${exchange!.receiver_phone}`,
  };
}

/**
 * A one-line, real-data snapshot of the customer's most recent order/
 * exchange -- attached to a support ticket the moment it's created (see
 * support.routes.ts) so whichever Agent/Admin accepts it can see real
 * context immediately instead of asking the customer to repeat what they
 * already told the AI. Returns null when the customer has no order/exchange
 * history at all, rather than a placeholder line.
 */
export async function loadLatestActivitySummary(customerId: string): Promise<string | null> {
  const latest = await loadLatestActivity(customerId);
  if (!latest) return null;
  const statusLabel = ORDER_STATUS_LABELS[latest.status] ?? latest.status;
  return `Macluumaad toos ah: ${latest.label}, $${latest.amount}, xaalad: ${statusLabel}, lambar: ${latest.id}.`;
}

async function handleOrderStatus(customerId: string): Promise<IntentResult> {
  const order = await queryOne<{ id: string; status: string; package_name: string; amount: string }>(
    `SELECT o.id, o.status, p.name AS package_name, o.amount
     FROM orders o JOIN packages p ON p.id = o.package_id
     WHERE o.customer_id=$1 ORDER BY o.created_at DESC LIMIT 1`,
    [customerId]
  );
  if (!order) return { text: "Wali wax dalab ah ma haysatid. Marka aad dalab sameyso, halkan ayaad ka arki kartaa xaaladdiisa." };
  const statusLabel = ORDER_STATUS_LABELS[order.status] ?? order.status;
  return { text: `Dalabkaagii ugu dambeeyay (${order.package_name}, $${order.amount}) xaaladdiisu waa: ${statusLabel}. Lambarka dalabka: ${order.id}.` };
}

async function handleExchangeStatus(customerId: string): Promise<IntentResult> {
  const order = await queryOne<{ id: string; status: string; amount_sent: string; amount_received: string }>(
    `SELECT id, status, amount_sent, amount_received FROM exchange_orders
     WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (!order) return { text: "Wali wax isku-beddel (eBadal) ah ma haysatid." };
  const statusLabel = ORDER_STATUS_LABELS[order.status] ?? order.status;
  return { text: `Isku-beddelkaagii ugu dambeeyay ($${order.amount_sent} -> $${order.amount_received}) xaaladdiisu waa: ${statusLabel}. Lambarka: ${order.id}.` };
}

// "Tell me my latest order" / "how much did I pay" / "did you receive my
// money" -- all three are really the same underlying question (what's the
// state of my most recent activity), so one real-data lookup answers all of
// them rather than risking three slightly-inconsistent code paths.
async function handlePaymentStatus(customerId: string): Promise<IntentResult> {
  const latest = await loadLatestActivity(customerId);
  if (!latest) return { text: "Wali wax dalab ah ama eBadal ah kuguma jiro xisaabtaada." };
  const statusLabel = ORDER_STATUS_LABELS[latest.status] ?? latest.status;
  if (latest.status === "pending") {
    return {
      text: `Dalabkaagii ugu dambeeyay (${latest.label}, $${latest.amount}) weli lama xaqiijin lacagta. Sida caadiga ah waa in ay qaadato 1-2 daqiiqo. Lambarka: ${latest.id}.`,
    };
  }
  if (latest.status === "cancelled") {
    return { text: `Dalabkaagii ugu dambeeyay (${latest.label}, $${latest.amount}) waa la joojiyay (cancelled). Lambarka: ${latest.id}.` };
  }
  return {
    text: `Haa, waan helnay lacagtaada $${latest.amount} ee ${latest.label}. Xaaladdeeda hadda waa: ${statusLabel}. Lambarka: ${latest.id}.`,
  };
}

// A customer reporting a payment/order PROBLEM -- checks real status first
// and explains what's actually happening, rather than generic canned text.
// Escalates automatically (needsEscalation: true) whenever the real data
// shows something genuinely unresolved (nothing found despite a claimed
// payment, still pending, or failed), instead of just saying "contact
// support" with no context.
async function handlePaymentHelp(customerId: string): Promise<IntentResult> {
  const latest = await loadLatestActivity(customerId);
  if (!latest) {
    return {
      text: "Wali wax dalab ah kuguma jiro xisaabtaada, sidaas darteed lacag lagama helin. Haddii aad hubtid inaad lacag dirtay, waxaan kuu xiriirin karnaa Agent si loo hubiyo.",
      needsEscalation: true,
    };
  }
  const statusLabel = ORDER_STATUS_LABELS[latest.status] ?? latest.status;
  if (latest.status === "pending") {
    return {
      text: `Dalabkaagii ugu dambeeyay (${latest.label}, $${latest.amount}) weli wuxuu sugayaa xaqiijinta lacagta. Sida caadiga ah waa 1-2 daqiiqo. Haddii aad horay u dirtay oo aysan wali xaqiijin, waxaan kuu xiriirin karnaa Agent si loo hubiyo.`,
      needsEscalation: true,
    };
  }
  if (latest.status === "failed") {
    return {
      text: `Waan xaqiijinay in lacagtaada $${latest.amount} la helay, laakiin dalabkaagii (${latest.label}) si toos ah uma dhammaan — wuu fashilmay ka dib markii lacagta la xaqiijiyay. Tani ma aha khalad lacageed, waa dhibaato ku timid marka la fulinayay adeegga. Waxaan kuu xiriirinayaa Agent si loo xalliyo.`,
      needsEscalation: true,
    };
  }
  return {
    text: `Dalabkaagii ugu dambeeyay (${latest.label}, $${latest.amount}) xaaladdiisu waa: ${statusLabel}. Haddii aad wali dhib qabto, waxaan kuu xiriirin karnaa Agent.`,
    needsEscalation: false,
  };
}

async function handleWalletNumbers(customerId: string): Promise<IntentResult> {
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
    return { text: "Wali lambar EVC Plus ama eDahab kuguma keydin. Waxaad ka keydin kartaa Profile > Wallet Numbers." };
  }
  return { text: `Lambarrada aad keydisay:\n${parts.join("\n")}\nHaddii aad rabto inaad wax ka bedesho, tag Profile > Wallet Numbers.` };
}

async function handleMyBalance(customerId: string): Promise<IntentResult> {
  const customer = await queryOne<{ macaash_points: number | null }>(`SELECT macaash_points FROM customers WHERE id=$1`, [customerId]);
  const points = customer?.macaash_points ?? 0;
  return { text: `Xisaabtaada Macaash waxay hadda tahay ${points} dhibcood. Waxaad ku dari kartaa gundhig marka aad dalabyo sameyso.` };
}

async function handleMinimumAmount(): Promise<IntentResult> {
  const corridors = await query<{ from_wallet_name: string; to_wallet_name: string; min_amount: string | null }>(
    `SELECT fw.name AS from_wallet_name, tw.name AS to_wallet_name, ec.min_amount
     FROM exchange_corridors ec
     LEFT JOIN payment_wallets fw ON fw.id = ec.from_wallet_id
     LEFT JOIN payment_wallets tw ON tw.id = ec.to_wallet_id
     WHERE ec.enabled=true AND ec.min_amount IS NOT NULL
     ORDER BY ec.min_amount ASC`
  );
  if (corridors.length === 0) {
    return {
      text: "Xadka ugu yar ee eBadal hadda lama heli karo. Waxaan kuu xiriirin karnaa Agent si aad u hesho macluumaad sax ah.",
      needsEscalation: true,
    };
  }
  const lines = corridors.map((c) => `${c.from_wallet_name} → ${c.to_wallet_name}: ugu yaraan $${c.min_amount}`);
  return { text: `Xadka ugu yar ee aad eBadal ku samayn karto:\n${lines.join("\n")}` };
}

async function handleProviders(): Promise<IntentResult> {
  const companies = await query<{ name: string }>(
    `SELECT name FROM companies WHERE deleted_at IS NULL AND status='online' AND visible_customer_app=true ORDER BY group_number, sort_order, name`
  );
  if (companies.length === 0) {
    return { text: "Hadda adeeg-bixiyayaal lama heli karo, fadlan mar dambe soo eeg." };
  }
  return { text: `Adeeg-bixiyayaasha aan haysano waa: ${companies.map((c) => c.name).join(", ")}.` };
}

async function handleAboutDalab(): Promise<IntentResult> {
  return {
    text:
      "Dalab Internet waa app aad kaga iibsan karto internet iyo baakidhyada xogta (data) shirkado kala duwan, " +
      "sidoo kalena waxaad ku samayn kartaa eBadal (isku-beddelka lacagta). Waxaad dooran kartaa adeeg-bixiye iyo baakidh, " +
      "kadibna lacagta ku bixi lambar la muujiyay — dalabkaagu si toos ah ayuu u shaqeeyaa marka lacagta la xaqiijiyo.",
  };
}

async function handleAboutEbadal(): Promise<IntentResult> {
  return {
    text:
      "eBadal waa adeegga isku-beddelka lacagta ee Dalab Internet. Waxaad geli kartaa qadarka aad rabto, dooran xisaabta aad ka dirayso " +
      "iyo tan aad u dirayso (tusaale EVC Plus una eDahab), kadibna lacagta ku dir lambarka la muujiyay. Marka la xaqiijiyo, " +
      "lacagta si toos ah ayaa loogu diraa xisaabkaaga kale.",
  };
}

async function handleHowPaymentsWork(): Promise<IntentResult> {
  return {
    text:
      "Lacag-bixintu waxay u shaqeysaa sidan: marka aad dalabka sameyso, waxaa lagu siin doonaa lambar (EVC Plus ama eDahab). " +
      "Ku dir qadarka saxda ah lambarkaas. Marka lacagta la xaqiijiyo si toos ah, dalabkaagu wuu bilaabmaa — uma baahnid inaad qof la hadasho.",
  };
}

async function handleHowToOrder(): Promise<IntentResult> {
  return {
    text:
      "Si aad dalab u samayso: 1) Doorasho Internet ama eBadal bogga hore, 2) Dooro adeeg-bixiyaha iyo baakidhka aad rabto, " +
      "3) Geli lambarka aad dalabka u samaynayso, 4) Dir lacagta lambarka la muujiyay. Dalabkaagu si toos ah ayuu u bilaabmayaa " +
      "marka lacagta la xaqiijiyo.",
  };
}

async function handleGreeting(): Promise<IntentResult> {
  return {
    text: "Salaam! Waxaan ahay Dalab AI Assistant. Waxaan kaa caawin karaa dalabyada, eBadal, lacag-bixinta, iyo lambarrada EVC Plus/eDahab. Su'aashaada ii soo qor.",
  };
}

const INTENTS: Intent[] = [
  {
    name: "greeting",
    keywords: ["salaan", "salam", "asc", "hello", "hi ", "nabad"],
    handle: handleGreeting,
  },
  {
    name: "about_dalab",
    keywords: ["dalab internet waa", "maxay tahay dalab", "waa maxay dalab", "what is dalab", "sidee dalab internet u shaqeeya", "waa maxay app-kan"],
    handle: handleAboutDalab,
  },
  {
    name: "about_ebadal",
    keywords: ["ebadal waa maxay", "maxay tahay ebadal", "waa maxay ebadal", "what is ebadal", "sidee ebadal u shaqeeya", "ebadal sidee u shaqeeya"],
    handle: handleAboutEbadal,
  },
  {
    name: "providers",
    keywords: ["shirkado", "shirkadaha", "adeeg-bixiyayaal", "adeeg bixiyeyaal", "providers", "companies"],
    handle: handleProviders,
  },
  {
    name: "minimum_amount",
    keywords: ["ugu yar", "xadka ugu yar", "minimum", "qadarka ugu yar"],
    handle: handleMinimumAmount,
  },
  {
    name: "my_balance",
    keywords: ["macaash", "dhibcood", "my balance", "balance", "xisaabta gundhig"],
    handle: handleMyBalance,
  },
  {
    name: "payment_status",
    keywords: [
      "ugu dambeeyay",
      "immisa ayaan bixiyay",
      "intee ayaan bixiyay",
      "waxa aan bixiyay",
      "ma heshay lacagta",
      "ma la helay lacagta",
      "did you receive",
      "how much did i pay",
      "dalabkayga ugu dambeeyay",
    ],
    handle: handlePaymentStatus,
  },
  {
    name: "how_payments_work",
    keywords: ["sidee lacagta loo bixiyaa", "sidee ayaan u bixiyaa", "how does payment work", "sidee loo bixiyaa lacagta", "sidee baan u bixinayaa"],
    handle: handleHowPaymentsWork,
  },
  {
    name: "payment_help",
    keywords: ["lacag", "payment", "lama helin", "ma bixin", "ma shaqeynayo", "khalad"],
    handle: handlePaymentHelp,
  },
  {
    name: "order_status",
    keywords: ["dalabkayga", "dalabka", "order", "xaalad", "xaggee", "internet-keyga", "baakidh"],
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
      const result = await intent.handle(customerId);
      return { answer: result.text, intent: intent.name, needsEscalation: result.needsEscalation ?? false };
    }
  }
  return null;
}
