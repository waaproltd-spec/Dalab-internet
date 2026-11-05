// Annual payment notice for Super Admins (Admin Hub). Rendered at the very
// top of the dashboard, before anything else, and impossible to switch off
// from here. Every number (amount, days left, dates, status) comes from the
// hub, which uses server dates; this file only displays them and re-reads
// them regularly. Self-contained styles so it looks the same in every
// system's dashboard and in the hub. Somali by default, English on request.
import React, { useCallback, useEffect, useState } from "react";

const FONT = "'Inter','Segoe UI',system-ui,-apple-system,sans-serif";
const LANG_KEY = "waapro-payment-lang";

const T = {
  so: {
    required: "Lacag-bixin sannadle ah ayaa lagaa rabaa!",
    requiredSub: "Waa inaad bixisaa lacagta adeegga sannadlaha ah si adeeggu u sii shaqeeyo.",
    final1: "DIGNIIN KAMA DAMBAYS AH: maalin keliya ayaa ka hartay!",
    final0: "DIGNIIN KAMA DAMBAYS AH: lacagta waa in maanta la bixiyo!",
    finalSub: "Bixi lacagta sannadlaha ah maanta si adeeggu u sii shaqeeyo.",
    grace: "Waqtigii lacag-bixinta waa dhaafay!",
    graceSub: (d) => `Waxaad ku jirtaa muddada dheeraadka ah. Bixi ugu dambeyn ${d} si aanay rukhsaddaadu u dhicin.`,
    expired: "Rukhsaddaada sannadlaha ah way dhacday!",
    expiredSub: "Lacagta lama helin muddadii dheeraadka ahayd gudaheed. La xiriir Milkiilaha Nidaamka (Platform Owner).",
    paid: "Lacag-bixinta sannadlaha ah waa la xaqiijiyay",
    paidSub: (a, d, n) => `Lacag-bixinta xigta: ${a}, ugu dambeyn ${d} (${n}).`,
    amount: "Lacagta la bixinayo",
    details: "Faahfaahin",
    hide: "Qari",
    timeLeft: "Waqtiga u haray",
    deadline: "Taariikhda dambeysa",
    graceLabel: "Muddada dheeraadka ah",
    graceIfLate: "(Haddii aan la bixin waqtiga)",
    graceLeft: "Muddada dheeraadka ka hartay",
    until: (d) => `(ilaa ${d})`,
    graceOver: "Way dhammaatay",
    days: (n) => (n === 1 ? "1 maalin" : `${n} maalmood`),
    today: "Maanta",
    none: "0 maalmood",
    status: "Xaaladda",
    statusPaid: "La bixiyay (Owner-ku wuu xaqiijiyay)",
    statusPending: "Sugaya lacag-bixin",
    statusGrace: "Sugaya lacag-bixin (muddada dheeraadka)",
    statusExpired: "Wuu dhacay",
    lastPayment: "Lacag-bixintii u dambeysay",
    notPaid: "Weli lama bixin",
    graceEnds: "Muddada dheeraadka waxay dhammaanaysaa",
    howToPay: "Sida loo bixiyo",
    howToPayText: "U bixi lacagta Milkiilaha Nidaamka (Platform Owner). Isaga keliya ayaa xaqiijin kara lacag-bixintaada; markaas ayay xaaladdu noqonaysaa \"La bixiyay\".",
    reminderTitle: "Xusuusin maalinle ah: lacag-bixinta sannadlaha",
    understood: "Waan fahmay",
    lang: "EN",
    payNow: "HADDA BIXI",
    payNowSub: "(Telegram Bot)",
    opening: "Waa la furayaa…",
    pending: (txn) => `Lacag-bixintaada (Transaction ID ${txn}) waxay sugaysaa xaqiijinta Owner-ka.`,
    pendingShort: "Sugaya xaqiijin",
    rejected: (txn) => `Lacag-bixinta Transaction ID ${txn} waa la diiday: lacagtu kuma soo gelin account-ka. Hubi oo mar kale soo gudbi.`,
    extension: (d) => `Waxaa lagu siiyay 2 maalmood oo dheeraad ah: ugu dambeyn ${d}.`,
    whereToPay: "Halka lacagta loo dirayo",
    noInstructions: "Owner-ku weli ma qorin lambarka lacag-bixinta.",
  },
  en: {
    required: "Annual payment required!",
    requiredSub: "You must pay the annual service fee to keep the service running.",
    final1: "FINAL WARNING: only 1 day left!",
    final0: "FINAL WARNING: payment is due today!",
    finalSub: "Pay the annual fee today to keep the service running.",
    grace: "Your payment deadline has passed!",
    graceSub: (d) => `You are in the grace period. Pay by ${d} at the latest or your subscription expires.`,
    expired: "Your annual subscription has EXPIRED!",
    expiredSub: "Payment was not received within the grace period. Contact the Platform Owner.",
    paid: "Annual payment confirmed",
    paidSub: (a, d, n) => `Next payment: ${a}, due by ${d} (${n}).`,
    amount: "Amount to pay",
    details: "Details",
    hide: "Hide",
    timeLeft: "Time left",
    deadline: "Deadline",
    graceLabel: "Grace period",
    graceIfLate: "(if not paid on time)",
    graceLeft: "Grace period left",
    until: (d) => `(until ${d})`,
    graceOver: "Ended",
    days: (n) => (n === 1 ? "1 day" : `${n} days`),
    today: "Today",
    none: "0 days",
    status: "Status",
    statusPaid: "Paid (confirmed by the Owner)",
    statusPending: "Pending payment",
    statusGrace: "Pending payment (grace period)",
    statusExpired: "Expired",
    lastPayment: "Last payment",
    notPaid: "Not paid yet",
    graceEnds: "Grace period ends",
    howToPay: "How to pay",
    howToPayText: "Pay the Platform Owner. Only the Platform Owner can confirm your payment; the status then changes to \"Paid\".",
    reminderTitle: "Daily reminder: annual payment",
    understood: "I understand",
    lang: "SO",
    payNow: "PAY NOW",
    payNowSub: "(Telegram Bot)",
    opening: "Opening…",
    pending: (txn) => `Your payment (transaction ID ${txn}) is awaiting the Owner's verification.`,
    pendingShort: "Awaiting verification",
    rejected: (txn) => `Your payment with transaction ID ${txn} was rejected: it did not arrive in the account. Check and submit again.`,
    extension: (d) => `You were granted 2 extra days: pay by ${d} at the latest.`,
    whereToPay: "Where to pay",
    noInstructions: "The Owner has not set the payment number yet.",
  },
};

const fmtDate = (iso, lang) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const months = lang === "so"
    ? ["Jan", "Feb", "Mar", "Abr", "May", "Jun", "Lul", "Ogo", "Seb", "Okt", "Nof", "Dis"]
    : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1]} ${y}`;
};
const fmtMoney = (amount, currency) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
};

function readLang() {
  try {
    return localStorage.getItem(LANG_KEY) === "en" ? "en" : "so";
  } catch {
    return "so";
  }
}

/** `load` returns the hub's { subscription, reminder }; re-read every 15 minutes and when the page is shown again. */
export function usePaymentStatus(load) {
  const [data, setData] = useState(null);
  const refresh = useCallback(() => {
    load()
      .then((d) => setData(d || null))
      .catch(() => undefined);
  }, [load]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15 * 60 * 1000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  return { data, refresh };
}

const PALETTE = {
  unpaid: { from: "#C2410C", to: "#EA580C" },
  due_soon: { from: "#B91C1C", to: "#DC2626" },
  final: { from: "#991B1B", to: "#DC2626" },
  grace: { from: "#831843", to: "#BE123C" },
  expired: { from: "#111827", to: "#7F1D1D" },
};

function Icon({ kind, size = 28, color = "currentColor" }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (kind === "clock") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
  if (kind === "alert") return <svg {...common}><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17h.01" /></svg>;
  if (kind === "check") return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>;
  return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4M7 14h2M11 14h2M15 14h2M7 17h2M11 17h2" /></svg>;
}

const KEYFRAMES = "@keyframes waaproPayPulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.55)}50%{box-shadow:0 0 0 10px rgba(220,38,38,0)}}";

export default function HubPaymentBanner({ data, onAcknowledge, onPayNow }) {
  const [lang, setLang] = useState(readLang);
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const s = data?.subscription;
  if (!s) return null;
  const t = T[lang];
  const amount = fmtMoney(s.amount, s.currency);
  const switchLang = () => {
    const next = lang === "so" ? "en" : "so";
    setLang(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
  };
  const submission = data.submission;
  const statusText =
    s.phase === "paid" ? t.statusPaid
      : submission?.status === "pending" ? `${t.pendingShort} (${submission.transactionId})`
        : s.phase === "expired" ? t.statusExpired : s.phase === "grace" ? t.statusGrace : t.statusPending;

  // PAY NOW opens the Telegram Payment Bot. The window is opened during the
  // tap itself (phones block windows opened later), then pointed at the bot.
  const payNow = async () => {
    if (!data.payNow || !onPayNow) {
      setOpen(true);
      return;
    }
    const w = window.open("", "_blank");
    setOpening(true);
    try {
      const url = await onPayNow();
      if (url && w) w.location.href = url;
      else if (url) window.location.href = url;
      else {
        if (w) w.close();
        setOpen(true);
      }
    } catch {
      if (w) w.close();
      setOpen(true);
    } finally {
      setOpening(false);
    }
  };

  const langButton = (
    <button onClick={switchLang} style={{ background: "rgba(255,255,255,0.16)", color: "inherit", border: "1px solid rgba(255,255,255,0.35)", borderRadius: 8, padding: "4px 9px", fontSize: 12, fontWeight: 700, cursor: "pointer" }} aria-label="Language">
      {t.lang}
    </button>
  );

  // Owner-confirmed and more than 30 days to go: a clear but compact confirmation.
  if (s.phase === "paid") {
    return (
      <div translate="no" role="status" style={{ fontFamily: FONT, background: "#14532D", color: "#ECFDF5", padding: "8px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Icon kind="check" size={20} color="#4ADE80" />
        <b style={{ fontSize: 13.5 }}>{t.paid}</b>
        <span style={{ fontSize: 13, opacity: 0.9, flex: "1 1 220px" }}>{t.paidSub(amount, fmtDate(s.dueDate, lang), t.days(s.daysLeft))}</span>
        {langButton}
      </div>
    );
  }

  const final = s.phase === "due_soon" && s.finalWarning;
  const key = final ? "final" : s.phase;
  const c = PALETTE[key] || PALETTE.due_soon;
  const title = s.phase === "expired" ? t.expired : s.phase === "grace" ? t.grace : final ? (s.daysLeft === 0 ? t.final0 : t.final1) : t.required;
  const sub = s.phase === "expired" ? t.expiredSub : s.phase === "grace" ? t.graceSub(fmtDate(s.graceEndDate, lang)) : final ? t.finalSub : t.requiredSub;
  const accent = s.phase === "expired" ? "#7F1D1D" : c.to;

  const timeLeftValue = s.phase === "expired" || s.phase === "grace" ? t.none : s.daysLeft === 0 ? t.today : t.days(s.daysLeft);
  const facts = [
    { icon: "calendar", label: t.timeLeft, value: timeLeftValue, strong: true },
    { icon: "calendar", label: t.deadline, value: fmtDate(s.dueDate, lang) },
    s.phase === "grace"
      ? { icon: "clock", label: t.graceLeft, value: t.days(s.graceDaysLeft), note: t.until(fmtDate(s.graceEndDate, lang)), strong: true }
      : s.phase === "expired"
        ? { icon: "clock", label: t.graceLabel, value: t.graceOver, note: t.until(fmtDate(s.graceEndDate, lang)) }
        : { icon: "clock", label: t.graceLabel, value: t.days(15), note: t.graceIfLate },
  ];

  const showReminder = data.reminder && !data.reminder.seen && onAcknowledge;

  return (
    <div translate="no" style={{ fontFamily: FONT, padding: "10px 10px 6px", background: "transparent" }}>
      <style>{KEYFRAMES}</style>
      <div
        role="alert"
        style={{
          background: `linear-gradient(135deg, ${c.from}, ${c.to})`,
          color: "#FFFFFF",
          borderRadius: 16,
          padding: 14,
          border: "2px solid rgba(255,255,255,0.25)",
          animation: final || s.phase === "grace" ? "waaproPayPulse 1.6s ease-in-out infinite" : undefined,
          boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Icon kind={s.phase === "expired" || final ? "alert" : "calendar"} size={32} color="#FFFFFF" />
          </div>
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>{title}</div>
            <div style={{ fontSize: 13.5, marginTop: 4, opacity: 0.95 }}>{sub}</div>
          </div>
          <div style={{ border: "2px solid rgba(255,255,255,0.6)", borderRadius: 12, padding: "6px 16px", textAlign: "center", flex: "0 0 auto" }}>
            <div style={{ fontSize: 12, opacity: 0.9 }}>{t.amount}</div>
            <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.15 }}>{amount}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => setOpen((o) => !o)}
              style={{ background: "#FACC15", color: "#1F2937", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 800, fontSize: 14, cursor: "pointer", minHeight: 44 }}
            >
              {open ? t.hide : t.details}
            </button>
            {langButton}
          </div>
        </div>

        <div style={{ marginTop: 12, background: "#FFF1F2", color: "#111827", borderRadius: 12, display: "flex", flexWrap: "wrap" }}>
          {facts.map((f, i) => (
            <div key={i} style={{ flex: "1 1 180px", display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderLeft: i ? "1px solid #FECDD3" : "none" }}>
              <Icon kind={f.icon} size={30} color={f.icon === "clock" ? "#F97316" : accent} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#374151" }}>{f.label}</div>
                <div style={{ fontSize: f.strong ? 24 : 20, fontWeight: 800, color: f.strong ? accent : "#111827", lineHeight: 1.15 }}>{f.value}</div>
                {f.note && <div style={{ fontSize: 12, color: "#4B5563" }}>{f.note}</div>}
              </div>
            </div>
          ))}
        </div>

        {(submission || s.extension) && (
          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {submission?.status === "pending" && (
              <div style={{ background: "#FEF3C7", color: "#78350F", borderRadius: 10, padding: "8px 12px", fontSize: 13.5, fontWeight: 700 }}>⏳ {t.pending(submission.transactionId)}</div>
            )}
            {submission?.status === "rejected" && (
              <div style={{ background: "#FFFFFF", color: "#991B1B", borderRadius: 10, padding: "8px 12px", fontSize: 13.5, fontWeight: 700 }}>❌ {t.rejected(submission.transactionId)}</div>
            )}
            {s.extension && (
              <div style={{ background: "rgba(255,255,255,0.18)", borderRadius: 10, padding: "8px 12px", fontSize: 13.5, fontWeight: 700 }}>➕ {t.extension(fmtDate(s.extension.newDeadline, lang))}</div>
            )}
          </div>
        )}

        {submission?.status !== "pending" && (
          <button
            onClick={payNow}
            disabled={opening}
            style={{ marginTop: 12, width: "100%", minHeight: 56, borderRadius: 14, border: "3px solid #FACC15", background: "linear-gradient(135deg, #1D4ED8, #2563EB)", color: "#FFFFFF", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontFamily: FONT }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path fill="#FFFFFF" d="M21.9 4.3 18.8 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.5.4-1 .4l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.9 12.9 2.4 11.5c-1-.3-1-1 .2-1.5L20.5 3c.8-.3 1.6.2 1.4 1.3z" /></svg>
            <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, textAlign: "left" }}>
              <span style={{ fontSize: 19, fontWeight: 900, letterSpacing: 0.5 }}>{opening ? t.opening : t.payNow}</span>
              {data.payNow && <span style={{ fontSize: 12.5, opacity: 0.9 }}>{t.payNowSub}</span>}
            </span>
          </button>
        )}

        {open && (
          <div style={{ marginTop: 10, background: "rgba(0,0,0,0.22)", borderRadius: 12, padding: "10px 14px", fontSize: 13.5, display: "grid", gap: 6 }}>
            <div>{t.status}: <b>{statusText}</b></div>
            <div>{t.lastPayment}: <b>{s.lastPaymentDate ? fmtDate(s.lastPaymentDate, lang) : t.notPaid}</b></div>
            <div>{t.graceEnds}: <b>{fmtDate(s.graceEndDate, lang)}</b></div>
            <div>{t.whereToPay}: <b style={{ whiteSpace: "pre-wrap" }}>{data.paymentInstructions || t.noInstructions}</b></div>
            <div>{t.howToPay}: {t.howToPayText}</div>
          </div>
        )}
      </div>

      {showReminder && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(15,23,42,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div role="alertdialog" aria-modal="true" style={{ width: "100%", maxWidth: 420, background: "#FFFFFF", color: "#111827", borderRadius: 18, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ background: `linear-gradient(135deg, ${c.from}, ${c.to})`, color: "#FFFFFF", padding: "18px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.9 }}>{t.reminderTitle}</div>
              <div style={{ fontSize: 54, fontWeight: 900, lineHeight: 1.1, marginTop: 6 }}>
                {s.phase === "grace" ? s.graceDaysLeft : s.daysLeft === 0 ? "!" : s.daysLeft}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{s.phase === "grace" ? t.graceLeft : s.daysLeft === 0 ? t.today : t.timeLeft}</div>
            </div>
            <div style={{ padding: "16px 20px", display: "grid", gap: 8, fontSize: 14 }}>
              <div style={{ fontSize: 17, fontWeight: 800 }}>{title}</div>
              <div>{t.amount}: <b>{amount}</b></div>
              <div>{t.deadline}: <b>{fmtDate(s.dueDate, lang)}</b></div>
              {s.phase === "grace" && <div>{t.graceEnds}: <b>{fmtDate(s.graceEndDate, lang)}</b></div>}
              <div style={{ color: "#4B5563", fontSize: 13 }}>{t.howToPayText}</div>
              <button onClick={onAcknowledge} style={{ marginTop: 6, background: accent, color: "#FFFFFF", border: "none", borderRadius: 12, padding: "12px 16px", fontWeight: 800, fontSize: 15, cursor: "pointer", minHeight: 48 }}>
                {t.understood}
              </button>
              <button onClick={switchLang} style={{ background: "none", border: "none", color: "#4B5563", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}>{lang === "so" ? "English" : "Soomaali"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
