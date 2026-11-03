import { assignedRouteFor } from "./orderRouting.js";
import { queryOne } from "../db/pool.js";
import { deliveriesDone } from "../services/deliveries.js";

/**
 * Insufficient SIM Balance check: before an Internet order is sent from a
 * company SIM (Hormuud/Somtel/Somnet/Amtel), compare what that send costs
 * against the SIM's last known balance from the SIM Balance System
 * (sim_balances -- kept current by balance SMS, manual edits and each
 * successful dial's own USSD reply, see utils/simBalances.ts).
 *
 * Used in two places:
 *  - GET /agent/orders/:id/sim-balance-check -- the Agent App shows the
 *    warning before the agent taps Dial;
 *  - POST /agent/orders/:id/dial-attempts -- the enforcement point every
 *    dial goes through (manual, SMS-matched auto-dial, self-heal), so no
 *    client can bypass it.
 */

export type SimBalanceStatus = "sufficient" | "insufficient" | "unknown" | "outdated";

export interface SimBalanceCheck {
  status: SimBalanceStatus;
  /** True only for "sufficient": safe to dial without asking. */
  ok: boolean;
  orderId: string;
  customerName: string;
  companyId: string;
  companyName: string;
  /** What this order still needs to send from the SIM. */
  requestedAmount: number;
  /** Last known SIM balance, or null when the system has none. */
  availableBalance: number | null;
  /** requestedAmount - availableBalance when insufficient, else 0 (null when unknown). */
  missingAmount: number | null;
  balanceUpdatedAt: string | null;
  deviceId: string | null;
  simSlot: number | null;
  /** Ready-to-show warning text (null when sufficient). */
  message: string | null;
  /** Which balance on that SIM pays for this order: the company's own
   * send balance (its provider_key, e.g. "somtel") or a mobile-money
   * wallet ("edahab" / "evc_plus") for a template paid with that PIN. */
  balanceSource: string;
  /** Display name of that balance ("Somtel", "eDahab", "EVC Plus"). */
  balanceLabel: string;
}

/** Wallets a template can be paid from (ussd_templates.balance_source). */
export const WALLET_BALANCE_SOURCES: Record<string, string> = { edahab: "eDahab", evc_plus: "EVC Plus" };

/**
 * What happens to a dial when the SIM balance is unknown or outdated:
 *  - "warn" (default): the dial goes ahead. An old or missing reading says
 *    nothing about the SIM now, so the order is attempted and the carrier's
 *    own reply decides: a real insufficient-balance reply is recorded as a
 *    failed attempt with that exact text (USSD Execution History), and the
 *    warning is still shown to the agent and on the dashboard;
 *  - "confirm": refused until the agent has seen the warning and explicitly
 *    confirmed, so automatic dials (SMS-matched / self-heal) wait for the
 *    agent. This blocked paid orders behind a merely outdated reading
 *    (e.g. $24.50 recorded yesterday for a $0.70 send), so it is opt-in.
 * A recent recorded balance that is below the order amount is always
 * refused, whatever this says.
 * Set with SIM_BALANCE_UNVERIFIED_POLICY on the server.
 */
export function unverifiedBalancePolicy(): "confirm" | "warn" {
  return process.env.SIM_BALANCE_UNVERIFIED_POLICY === "confirm" ? "confirm" : "warn";
}

/**
 * True when a carrier's USSD reply says the SIM didn't have enough balance
 * (English, and the Somali "kuguma filna" / "kuma filna" Hormuud uses).
 * Only labels a reply already recorded as a failure; it never decides one.
 */
export function isInsufficientBalanceReply(text: string | null | undefined): boolean {
  if (!text) return false;
  return /insufficient|(not|n.t)( have)? enough (balance|credit|funds|money)|low balance|balance is (too )?low|kuguma filna|kuma filna/i.test(text);
}

/** A balance older than this is "outdated": it may no longer be true. */
export function simBalanceMaxAgeMs(): number {
  const hours = Number(process.env.SIM_BALANCE_MAX_AGE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Round to cents so 0.1 + 0.2 style float noise never decides a check. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The pure decision -- no database. Exported for unit tests.
 * - no balance on record -> "unknown"
 * - balance older than maxAgeMs -> "outdated" (never assumed to be enough)
 * - balance < requested -> "insufficient", with the exact missing amount
 * - otherwise -> "sufficient"
 */
export function evaluateSimBalance(input: {
  requestedAmount: number;
  availableBalance: number | null | undefined;
  balanceUpdatedAt: Date | string | null | undefined;
  companyName: string;
  /** Set when the order is paid from a wallet on the SIM ("eDahab"):
   * the warnings then name that wallet, not the company's SIM balance. */
  walletLabel?: string | null;
  now?: Date;
  maxAgeMs?: number;
}): Pick<SimBalanceCheck, "status" | "ok" | "requestedAmount" | "availableBalance" | "missingAmount" | "message"> {
  const requested = cents(Math.max(0, Number(input.requestedAmount) || 0));
  const company = input.companyName || "company";
  const wallet = input.walletLabel?.trim() || null;
  const balance = input.availableBalance == null || !Number.isFinite(Number(input.availableBalance)) ? null : cents(Number(input.availableBalance));

  if (balance == null) {
    return {
      status: "unknown",
      ok: false,
      requestedAmount: requested,
      availableBalance: null,
      missingAmount: null,
      message: wallet
        ? `${wallet} Balance Unknown — ${company}. This order is paid from the ${company} SIM's ${wallet} balance, which has not been recorded yet, so it can't be confirmed that it covers the customer's ${money(requested)}. Check the ${wallet} balance on this SIM before processing this order.`
        : `SIM Balance Unknown — ${company}. The ${company} SIM balance has not been recorded yet, so it can't be confirmed that it covers the customer's ${money(requested)}. Check the ${company} SIM balance before processing this order.`,
    };
  }

  const now = input.now ?? new Date();
  const updatedAt = input.balanceUpdatedAt ? new Date(input.balanceUpdatedAt) : null;
  const maxAge = input.maxAgeMs ?? simBalanceMaxAgeMs();
  if (!updatedAt || Number.isNaN(updatedAt.getTime()) || now.getTime() - updatedAt.getTime() > maxAge) {
    return {
      status: "outdated",
      ok: false,
      requestedAmount: requested,
      availableBalance: balance,
      missingAmount: balance < requested ? cents(requested - balance) : 0,
      message: wallet
        ? `${wallet} Balance Outdated — ${company}. The ${company} SIM's ${wallet} balance showed ${money(balance)} at its last update, which may no longer be correct. Check the ${wallet} balance on this SIM before processing this ${money(requested)} order.`
        : `SIM Balance Outdated — ${company}. The ${company} SIM showed ${money(balance)} at its last update, which may no longer be correct. Check the ${company} SIM balance before processing this ${money(requested)} order.`,
    };
  }

  if (balance < requested) {
    const missing = cents(requested - balance);
    return {
      status: "insufficient",
      ok: false,
      requestedAmount: requested,
      availableBalance: balance,
      missingAmount: missing,
      message: wallet
        ? `Insufficient ${wallet} Balance — ${company}. The customer requested ${money(requested)}, but the ${wallet} balance on the ${company} SIM is only ${money(balance)}. The remaining amount needed is ${money(missing)}. Please top up ${wallet} on this SIM and try again.`
        : `Insufficient SIM Balance — ${company}. The customer requested ${money(requested)}, but the available SIM balance is only ${money(balance)}. The remaining amount needed is ${money(missing)}. Please recharge the ${company} SIM and try again.`,
    };
  }

  return { status: "sufficient", ok: true, requestedAmount: requested, availableBalance: balance, missingAmount: 0, message: null };
}

/**
 * Runs the check for one order against the SIM that will send it:
 * the explicit device/slot when given (a dial attempt), else the order's
 * template-assigned SIM, else the company's primary sim_routing SIM.
 * Returns null if the order doesn't exist.
 */
export async function checkSimBalanceForOrder(
  orderId: string,
  sim: { deviceId?: string | null; simSlot?: number | null } = {}
): Promise<SimBalanceCheck | null> {
  const order = await queryOne<{
    id: string;
    company_id: string;
    company_name: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    amount: string;
    provider_amount: string | null;
    send_count: number | null;
    ussd_device_id: string | null;
    ussd_sim_slot: number | null;
    ussd_balance_source: string | null;
  }>(
    `SELECT o.id, o.company_id, c.name AS company_name, cu.name AS customer_name, cu.phone AS customer_phone,
            o.amount, o.provider_amount, o.send_count, o.ussd_device_id, o.ussd_sim_slot, o.ussd_balance_source
     FROM orders o
     LEFT JOIN companies c ON c.id = o.company_id
     LEFT JOIN customers cu ON cu.id = o.customer_id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!order) return null;

  // What the SIM still has to send: the provider amount the USSD dials
  // (COALESCE(provider_amount, amount), same as generateUssdForOrder), times
  // the deliveries left on an Extra Package (send_count > 1).
  const perSend = Number(order.provider_amount ?? order.amount) || 0;
  const sendCount = Number(order.send_count ?? 1);
  const remainingSends = sendCount > 1 ? Math.max(1, sendCount - (await deliveriesDone(order.id))) : 1;
  const requestedAmount = perSend * remainingSends;

  let deviceId = sim.deviceId ?? null;
  let simSlot = sim.simSlot ?? null;
  if (!deviceId || !simSlot) {
    // The order's assigned SIM (utils/orderRouting.ts) -- never another
    // device's slot mixed with this one, never a backup route.
    const route = await assignedRouteFor(order);
    if (route && (!deviceId || deviceId === route.deviceId)) {
      deviceId = route.deviceId;
      simSlot = simSlot ?? route.simSlot;
    }
  }

  const companyName = order.company_name?.trim() || order.company_id;
  // A template paid from a wallet on the dialing SIM (Dhameys Plus: the
  // eDahab PIN) is checked against THAT wallet's balance on the same SIM,
  // and only that one: the company's Send Data balance doesn't pay for it,
  // and neither does the same wallet on another SIM. No row is "unknown",
  // never zero and never borrowed from another balance.
  const walletLabel = order.ussd_balance_source ? WALLET_BALANCE_SOURCES[order.ussd_balance_source] ?? order.ussd_balance_source : null;
  const balanceRow = !(deviceId && simSlot)
    ? null
    : walletLabel
      ? await queryOne<{ balance: string | null; updated_at: string | null }>(
          `SELECT balance, updated_at FROM sim_balances
           WHERE device_id=$1 AND sim_slot=$2 AND provider_key = $3
           ORDER BY updated_at DESC LIMIT 1`,
          [deviceId, simSlot, order.ussd_balance_source]
        )
      : // The company's own data-sending balance on that SIM: provider_key
        // is the company name lowercased (applyBalanceUpdate); a row never
        // touched by the provider gate falls back to its company_id. Other
        // balances that can live on the same SIM (evc_plus, edahab,
        // hormuud_evoucher, ...) are excluded.
        await queryOne<{ balance: string | null; updated_at: string | null }>(
          `SELECT balance, updated_at FROM sim_balances
           WHERE device_id=$1 AND sim_slot=$2
             AND (provider_key = LOWER(TRIM($3)) OR (provider_key IS NULL AND company_id = $4))
           ORDER BY updated_at DESC LIMIT 1`,
          [deviceId, simSlot, companyName, order.company_id]
        );

  const verdict = evaluateSimBalance({
    requestedAmount,
    availableBalance: balanceRow?.balance == null ? null : Number(balanceRow.balance),
    balanceUpdatedAt: balanceRow?.updated_at ?? null,
    companyName,
    walletLabel,
  });

  return {
    ...verdict,
    orderId: order.id,
    customerName: order.customer_name?.trim() || (order.customer_phone ? `+${order.customer_phone}` : "Customer"),
    companyId: order.company_id,
    companyName,
    balanceUpdatedAt: balanceRow?.updated_at ? new Date(balanceRow.updated_at).toISOString() : null,
    deviceId,
    simSlot,
    balanceSource: walletLabel ? order.ussd_balance_source! : companyName.toLowerCase(),
    balanceLabel: walletLabel ?? companyName,
  };
}
