// Annual payment banner for Super Admins (Admin Hub). Shown at the very top
// of the dashboard; the hub computes every number from server dates, this
// only displays them and re-reads them regularly. Self-contained colours so
// it renders the same in every system's dashboard and in the hub.
import React, { useEffect, useState } from "react";

const FONT = "'Inter','Segoe UI',system-ui,-apple-system,sans-serif";
const fmtDate = (iso) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const fmtMoney = (amount, currency) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const THEMES = {
  paid: { bg: "#ECFDF3", border: "#16A34A", fg: "#14532D", accent: "#16A34A" },
  due_soon: { bg: "#FFF7E6", border: "#F59E0B", fg: "#78350F", accent: "#D97706" },
  final: { bg: "#FEF2F2", border: "#DC2626", fg: "#7F1D1D", accent: "#DC2626" },
  grace: { bg: "#FFF1F2", border: "#E11D48", fg: "#881337", accent: "#E11D48" },
  expired: { bg: "#3F0A0A", border: "#B91C1C", fg: "#FEE2E2", accent: "#F87171" },
};

/** `load` returns the subscription (or null) from the hub. */
export function usePaymentStatus(load) {
  const [sub, setSub] = useState(null);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      load()
        .then((s) => alive && setSub(s || null))
        .catch(() => undefined);
    refresh();
    // The day count comes from the server; re-read it every 30 minutes and
    // whenever the page comes back into view (so it changes at midnight).
    const timer = setInterval(refresh, 30 * 60 * 1000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);
  return sub;
}

export default function HubPaymentBanner({ subscription: s }) {
  if (!s) return null;
  const key = s.phase === "due_soon" && s.finalWarning ? "final" : s.phase;
  const t = THEMES[key] || THEMES.paid;
  const amount = fmtMoney(s.amount, s.currency);

  let big = null;
  let title;
  let text;
  if (s.phase === "paid") {
    title = "Annual payment: Paid";
    text = `Next payment of ${amount} is due on ${fmtDate(s.dueDate)} (${plural(s.daysLeft, "day")} left).`;
  } else if (s.phase === "due_soon") {
    big = s.daysLeft === 0 ? "TODAY" : String(s.daysLeft);
    title = s.daysLeft === 0 ? "FINAL WARNING: your annual payment is due today" : s.daysLeft === 1 ? "FINAL WARNING: 1 day left to pay" : `${plural(s.daysLeft, "day")} left to pay your annual subscription`;
    text = `Pay ${amount} to the Platform Owner by ${fmtDate(s.dueDate)}. After that a ${15}-day grace period starts.`;
  } else if (s.phase === "grace") {
    big = String(s.graceDaysLeft);
    title = `Payment overdue: grace period, ${plural(s.graceDaysLeft, "day")} left`;
    text = `Your annual payment of ${amount} was due on ${fmtDate(s.dueDate)}. Pay the Platform Owner by ${fmtDate(s.graceEndDate)} (last grace day) or your subscription expires.`;
  } else {
    title = "Annual subscription EXPIRED";
    text = `The payment of ${amount} due on ${fmtDate(s.dueDate)} was not received within the grace period (ended ${fmtDate(s.graceEndDate)}). Contact the Platform Owner.`;
  }

  const facts = [
    ["Amount", amount],
    ["Due date", fmtDate(s.dueDate)],
    s.phase === "grace" ? ["Grace days left", String(s.graceDaysLeft)] : ["Days left", s.phase === "expired" ? "0" : String(s.daysLeft)],
    ["Last payment", fmtDate(s.lastPaymentDate)],
    ["Status", s.phase === "grace" ? "Pending (grace period)" : s.status],
  ];

  if (s.phase === "paid") {
    // Quiet line while more than 30 days remain.
    return (
      <div role="status" style={{ background: t.bg, borderBottom: `2px solid ${t.border}`, color: t.fg, fontFamily: FONT, fontSize: 12.5, padding: "6px 14px", display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "center" }}>
        <b>{title}</b>
        {facts.map(([k, v]) => (
          <span key={k}>{k}: <b>{v}</b></span>
        ))}
      </div>
    );
  }
  return (
    <div role="alert" style={{ background: t.bg, borderBottom: `3px solid ${t.border}`, color: t.fg, fontFamily: FONT, padding: "12px 14px" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        {big && (
          <div style={{ minWidth: 64, height: 64, padding: "0 8px", borderRadius: 14, background: t.accent, color: "#FFFFFF", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
            <span style={{ fontSize: big.length > 3 ? 18 : 30, fontWeight: 800 }}>{big}</span>
            {big !== "TODAY" && <span style={{ fontSize: 10, fontWeight: 700, marginTop: 3 }}>{s.phase === "grace" ? "GRACE DAYS" : big === "1" ? "DAY" : "DAYS"}</span>}
          </div>
        )}
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
          <div style={{ fontSize: 13, marginTop: 2 }}>{text}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginTop: 10, fontSize: 12.5 }}>
        {facts.map(([k, v]) => (
          <span key={k}>{k}: <b>{v}</b></span>
        ))}
      </div>
    </div>
  );
}
