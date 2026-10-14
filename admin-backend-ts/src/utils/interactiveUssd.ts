/**
 * Interactive (menu-driven) package USSD -- see migration 118.
 *
 * A template with dial_mode='interactive' is a first dial (ussd_code, e.g.
 * "*101#") plus ordered reply steps. Each step says what to reply and what
 * the carrier's screen must show before that reply is sent; the Agent App
 * enforces those checks and stops (paying nothing) on any mismatch, so a
 * reordered or changed Somtel menu can never send the PIN for the wrong
 * package, amount or number.
 */

export interface ReplyStepConfig {
  reply: string;
  expect?: string[];
  checkMenuPrice?: boolean;
  checkAmount?: boolean;
  checkNumber?: boolean;
}

/** One rendered step of an order's plan (orders.ussd_plan.steps). */
export interface PlanStep {
  /** What to type. The PIN step is the literal "{pin}": the PIN is never
   * stored -- the Agent App fetches it only when it reaches this step. */
  reply: string;
  /** Case-insensitive texts that must all be on the screen. */
  expect: string[];
  /** The screen must list "<option>. $<amount>" with exactly this amount. */
  menuOption?: { option: string; amount: string };
  /** The screen must show this dollar amount. */
  amount?: string;
  /** The screen must show this number. */
  number?: string;
  /** This reply is the PIN. */
  secret?: boolean;
}

export interface UssdPlan {
  version: 1;
  initialDial: string;
  steps: PlanStep[];
  successKeywords: string[];
}

const ALLOWED_TOKENS = ["{packageCode}", "{number}", "{pin}"] as const;
const MAX_STEPS = 10;
const MAX_EXPECT_LENGTH = 60;

/** Validates an interactive template before it is saved. Returns an error
 * message, or null when valid. Nothing unsupported is ever accepted and
 * silently treated as valid. */
export function validateInteractiveTemplate(initialDial: unknown, steps: unknown, successKeywords: unknown): string | null {
  if (typeof initialDial !== "string" || !/^\*[0-9*]{1,20}#$/.test(initialDial.trim())) {
    return "The first USSD code must look like *101# (digits and * only, starting with * and ending with #).";
  }
  if (!Array.isArray(steps) || steps.length === 0) return "Add at least one menu step.";
  if (steps.length > MAX_STEPS) return `A menu can have at most ${MAX_STEPS} steps.`;
  let pinIndex = -1;
  let numberIndex = -1;
  let packageCodeIndex = -1;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as ReplyStepConfig;
    const label = `Step ${i + 1}`;
    if (!step || typeof step !== "object") return `${label} is not valid.`;
    const reply = typeof step.reply === "string" ? step.reply.trim() : "";
    if (!reply) return `${label}: enter what to reply.`;
    const isToken = (ALLOWED_TOKENS as readonly string[]).includes(reply);
    if (!isToken && !/^[0-9]{1,3}$/.test(reply)) {
      return `${label}: the reply must be a menu number (like 4) or one of ${ALLOWED_TOKENS.join(", ")}.`;
    }
    if (reply === "{pin}") {
      if (pinIndex !== -1) return "The PIN can only be entered once.";
      pinIndex = i;
    }
    if (reply === "{number}") {
      if (numberIndex !== -1) return "The receiver number can only be entered once.";
      numberIndex = i;
    }
    if (reply === "{packageCode}") {
      if (packageCodeIndex !== -1) return "The package option can only be chosen once.";
      packageCodeIndex = i;
    }
    if (step.expect !== undefined) {
      if (!Array.isArray(step.expect) || step.expect.some((e) => typeof e !== "string" || !e.trim() || e.length > MAX_EXPECT_LENGTH)) {
        return `${label}: expected screen texts must be short, non-empty words (up to ${MAX_EXPECT_LENGTH} characters).`;
      }
    }
    for (const flag of ["checkMenuPrice", "checkAmount", "checkNumber"] as const) {
      if (step[flag] !== undefined && typeof step[flag] !== "boolean") return `${label}: ${flag} must be on or off.`;
    }
    if (step.checkMenuPrice && reply !== "{packageCode}") {
      return `${label}: the price check on a menu only applies to the package option step ({packageCode}).`;
    }
  }
  if (pinIndex === -1) return "The PIN step ({pin}) is required.";
  if (pinIndex !== steps.length - 1) return "The PIN must be the last step, so nothing is entered after paying.";
  if (numberIndex === -1) return "The receiver number step ({number}) is required.";
  if (packageCodeIndex === -1) return "The package option step ({packageCode}) is required, so each package selects its own option.";
  const pinStep = steps[pinIndex] as ReplyStepConfig;
  if (!pinStep.checkAmount || !pinStep.checkNumber) {
    return "The PIN step must check both the amount and the receiver number on the confirmation screen before paying.";
  }
  if ((steps[packageCodeIndex] as ReplyStepConfig).checkMenuPrice !== true) {
    return "The package option step must check the price shown on the menu, so a changed menu can't select the wrong package.";
  }
  if (successKeywords !== undefined) {
    if (!Array.isArray(successKeywords) || successKeywords.some((k) => typeof k !== "string" || k.trim().length < 4 || k.length > MAX_EXPECT_LENGTH)) {
      return "Success words must be at least 4 characters each.";
    }
  }
  return null;
}

/** A package's menu option for a template that selects packages by option. */
export function isValidPackageOption(code: unknown): boolean {
  return typeof code === "string" && /^[0-9]{1,2}$/.test(code.trim());
}

/** Plain dollar amount for screen checks: 0.5 -> "0.50", 15 -> "15.00". */
export function plainAmount(amount: number | string): string {
  return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

/** Renders an order's plan from its template. Never includes the PIN. */
export function renderUssdPlan(
  template: { ussd_code: string; reply_steps: ReplyStepConfig[]; success_keywords?: string[] | null },
  ctx: { number: string; packageCode: string; amount: number | string }
): UssdPlan {
  const amount = plainAmount(ctx.amount);
  const steps: PlanStep[] = template.reply_steps.map((cfg) => {
    const reply = cfg.reply.trim();
    const rendered =
      reply === "{packageCode}" ? ctx.packageCode.trim() : reply === "{number}" ? ctx.number : reply;
    const step: PlanStep = { reply: rendered, expect: (cfg.expect ?? []).map((e) => e.trim()) };
    if (reply === "{pin}") step.secret = true;
    if (cfg.checkMenuPrice && reply === "{packageCode}") step.menuOption = { option: ctx.packageCode.trim(), amount };
    if (cfg.checkAmount) step.amount = amount;
    if (cfg.checkNumber) step.number = ctx.number;
    return step;
  });
  return {
    version: 1,
    initialDial: template.ussd_code.trim(),
    steps,
    successKeywords: (template.success_keywords ?? []).map((k) => k.trim()).filter(Boolean),
  };
}

/** PIN-free one-line summary of a plan, stored as orders.ussd_generated
 * (and shown in logs/dashboards): "*101# > 4 > 3 > 2 > 620346060 > [PIN]".
 * Also the exact string the Agent App reports its dial attempts with. */
export function summarizeUssdPlan(plan: UssdPlan): string {
  return [plan.initialDial, ...plan.steps.map((s) => (s.secret ? "[PIN]" : s.reply))].join(" > ");
}
