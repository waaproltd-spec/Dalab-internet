// Agent Registrations: the customers agents registered (name, payment
// sender number, internet receiver number, network) with their payments and
// orders. Admins see every registration, every payment and delivery, each
// agent's history, and the payments that could not become an order
// (verification failed) to investigate and mark resolved. Self-contained so
// the same file works in every system's dashboard: it only needs that
// dashboard's admin API request function.
import React, { useEffect, useMemo, useState } from "react";
import { UserPlus, RefreshCw, X, CheckCircle2 } from "lucide-react";

export { UserPlus as AgentRegistrationsIcon };

const INK = "var(--c-0b1240, #0B1240)";
const MUTE = "var(--c-6b7390, #6B7390)";
const BORDER = "var(--c-e3e7f2, #E3E7F2)";
const SURFACE = "var(--c-surface, #FFFFFF)";
const NAVY = "#0B2A6B";

const DELIVERY = {
  delivered: { label: "Delivered", bg: "#E6F6EC", fg: "#137A3A" },
  sending: { label: "Sending", bg: "#E3EEFD", fg: "#1450B4" },
  waiting: { label: "Waiting", bg: "#FFF4D6", fg: "#8A6200" },
  failed: { label: "Failed", bg: "#FDE2E2", fg: "#B42318" },
  cancelled: { label: "Cancelled", bg: "#EEF0F5", fg: "#6B7390" },
};
const PAYMENT = {
  paid: { label: "Paid", bg: "#E6F6EC", fg: "#137A3A" },
  awaiting_payment: { label: "Awaiting payment", bg: "#FFF4D6", fg: "#8A6200" },
  payment_failed: { label: "Payment failed", bg: "#FDE2E2", fg: "#B42318" },
};

const input = {
  padding: "9px 12px", borderRadius: 10, border: `1px solid ${BORDER}`, fontSize: 13.5, color: INK,
  background: SURFACE, outline: "none", boxSizing: "border-box",
};
const pill = (c) => ({ display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: c.bg, color: c.fg, whiteSpace: "nowrap" });
const btn = (primary) => ({
  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, padding: "8px 13px", borderRadius: 10,
  cursor: "pointer", border: primary ? "none" : `1px solid ${BORDER}`, background: primary ? NAVY : SURFACE, color: primary ? "#fff" : NAVY,
});
const th = { textAlign: "left", padding: "9px 10px", fontSize: 11.5, fontWeight: 800, color: MUTE, textTransform: "uppercase", letterSpacing: 0.3, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" };
const td = { padding: "10px", fontSize: 13, color: INK, borderBottom: `1px solid ${BORDER}`, verticalAlign: "top" };

const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const local = (p) => String(p || "").replace(/\D/g, "").slice(-9) || "—";

function Stat({ label, value, tone }) {
  return (
    <div style={{ flex: "1 1 130px", border: `1px solid ${BORDER}`, borderRadius: 14, padding: "12px 14px", background: SURFACE }}>
      <div style={{ fontSize: 12, color: MUTE, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: tone || INK, marginTop: 2 }}>{value ?? 0}</div>
    </div>
  );
}

function OrdersTable({ rows, showCustomer, showAgent }) {
  if (!rows.length) return <div style={{ color: MUTE, fontSize: 13, padding: "14px 2px" }}>No orders yet.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
        <thead>
          <tr>
            <th style={th}>Order</th>
            {showCustomer && <th style={th}>Customer</th>}
            {showAgent && <th style={th}>Agent</th>}
            <th style={th}>Service</th>
            <th style={th}>Amount</th>
            <th style={th}>Transaction ID</th>
            <th style={th}>Payment</th>
            <th style={th}>Delivery</th>
            <th style={th}>Receiver</th>
            <th style={th}>Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td style={{ ...td, fontFamily: "monospace" }}>{o.id}</td>
              {showCustomer && <td style={td}>{o.customerName || "—"}</td>}
              {showAgent && <td style={td}>{o.agentName || "—"}</td>}
              <td style={td}>{o.packageName || "—"}<div style={{ color: MUTE, fontSize: 12 }}>{o.companyName}</div></td>
              <td style={td}>{money(o.amount)}</td>
              <td style={{ ...td, fontFamily: "monospace" }}>{o.transactionRef || "—"}</td>
              <td style={td}><span style={pill(PAYMENT[o.paymentState] || PAYMENT.awaiting_payment)}>{(PAYMENT[o.paymentState] || {}).label || o.paymentState}</span></td>
              <td style={td}><span style={pill(DELIVERY[o.deliveryState] || DELIVERY.waiting)}>{(DELIVERY[o.deliveryState] || {}).label || o.deliveryState}</span></td>
              <td style={td}>{local(o.receiverPhone)}</td>
              <td style={td}>{fmt(o.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IssuesTable({ rows, onResolve, showAgent }) {
  if (!rows.length) return <div style={{ color: MUTE, fontSize: 13, padding: "14px 2px" }}>No payment problems.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
        <thead>
          <tr>
            <th style={th}>Customer</th>
            {showAgent && <th style={th}>Agent</th>}
            <th style={th}>Sender</th>
            <th style={th}>Amount</th>
            <th style={th}>Transaction ID</th>
            <th style={th}>Why it was not sent</th>
            <th style={th}>Date</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id}>
              <td style={td}>{i.customerName || "—"}</td>
              {showAgent && <td style={td}>{i.agentName || "—"}</td>}
              <td style={td}>{local(i.senderPhone)}</td>
              <td style={td}>{money(i.amount)}</td>
              <td style={{ ...td, fontFamily: "monospace" }}>{i.transactionRef || "—"}</td>
              <td style={{ ...td, color: "#B42318" }}>{i.reason}</td>
              <td style={td}>{fmt(i.createdAt)}</td>
              <td style={td}>
                {i.resolvedAt ? (
                  <span style={pill({ bg: "#E6F6EC", fg: "#137A3A" })}>Resolved</span>
                ) : onResolve ? (
                  <button style={btn(false)} onClick={() => onResolve(i)}><CheckCircle2 size={14} /> Resolved</button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AgentRegistrations({ request }) {
  const [tab, setTab] = useState("registrations");
  const [agentId, setAgentId] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [data, setData] = useState({ totals: {}, registrations: [] });
  const [agents, setAgents] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [issues, setIssues] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const q = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
    return s ? `?${s}` : "";
  };

  const load = () => {
    setLoading(true);
    setError("");
    Promise.all([
      request(`/admin/agent-registrations${q({ agentId, search: search.trim() })}`),
      request(`/admin/agent-registrations/transactions${q({ agentId, state })}`),
      request(`/admin/agent-registrations/payment-issues${q({ open: showResolved ? "0" : "" })}`),
    ])
      .then(([regs, tx, iss]) => {
        setData(regs || { totals: {}, registrations: [] });
        setTransactions(Array.isArray(tx) ? tx : []);
        setIssues(Array.isArray(iss) ? iss : []);
      })
      .catch((e) => setError(e.message || "Could not load agent registrations."))
      .finally(() => setLoading(false));
  };
  useEffect(load, [agentId, state, showResolved]);
  // The agent list for the filter comes from the unfiltered registrations.
  useEffect(() => {
    request("/admin/agent-registrations")
      .then((r) => {
        const seen = new Map();
        for (const c of r?.registrations || []) if (c.registeredByAgentId && !seen.has(c.registeredByAgentId)) seen.set(c.registeredByAgentId, c.agentName || c.agentPhone);
        setAgents([...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => String(a.name).localeCompare(String(b.name))));
      })
      .catch(() => {});
  }, []);

  const openDetail = (c) => {
    setDetail({ loading: true, name: c.name });
    request(`/admin/agent-registrations/${c.id}`)
      .then((d) => setDetail(d))
      .catch((e) => setDetail({ error: e.message || "Could not load." }));
  };

  const resolve = async (i) => {
    if (!window.confirm(`Mark the ${money(i.amount)} payment from ${local(i.senderPhone)} as resolved? Do this after you have handled it (sent the internet or refunded the customer).`)) return;
    try {
      await request(`/admin/agent-registrations/payment-issues/${i.id}/resolve`, { method: "PUT", body: {} });
      load();
      if (detail?.id) openDetail(detail);
    } catch (e) {
      setError(e.message || "Could not update.");
    }
  };

  const filteredIssues = useMemo(() => (agentId ? issues.filter((i) => i.agentId === agentId) : issues), [issues, agentId]);
  const t = data.totals || {};
  const tabs = [
    { id: "registrations", label: `Registrations (${data.registrations.length})` },
    { id: "transactions", label: `Payments & Orders (${transactions.length})` },
    { id: "issues", label: `Payment Problems (${filteredIssues.filter((i) => !i.resolvedAt).length})` },
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: INK }}>Agent Registrations</div>
        <button style={btn(false)} onClick={load}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div style={{ fontSize: 13, color: MUTE, marginBottom: 14 }}>
        Customers registered by agents (name, payment number, internet number, network). When a customer pays, the payment is verified (sender, amount, transaction ID) and only then is the internet sent. A payment that can't be verified is never sent: it is listed under Payment Problems and the agent is notified.
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Stat label="Registered customers" value={t.registrations} />
        <Stat label="Agents" value={t.agents} />
        <Stat label="Delivered" value={t.delivered} tone="#137A3A" />
        <Stat label="Failed" value={t.failed} tone="#B42318" />
        <Stat label="Open payment problems" value={t.openPaymentIssues} tone={t.openPaymentIssues ? "#B42318" : INK} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <select style={input} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">All agents</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {tab === "registrations" && (
          <form onSubmit={(e) => { e.preventDefault(); load(); }} style={{ display: "flex", gap: 8 }}>
            <input style={{ ...input, minWidth: 220 }} placeholder="Search name or number" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button style={btn(true)} type="submit">Search</button>
          </form>
        )}
        {tab === "transactions" && (
          <select style={input} value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All deliveries</option>
            <option value="delivered">Delivered</option>
            <option value="sending">Sending</option>
            <option value="waiting">Waiting</option>
            <option value="failed">Failed</option>
          </select>
        )}
        {tab === "issues" && (
          <label style={{ fontSize: 13, color: INK, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved too
          </label>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, borderBottom: `1px solid ${BORDER}`, marginBottom: 12, flexWrap: "wrap" }}>
        {tabs.map((x) => (
          <button
            key={x.id}
            onClick={() => setTab(x.id)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: "9px 12px", fontSize: 13.5, fontWeight: 800,
              color: tab === x.id ? NAVY : MUTE, borderBottom: tab === x.id ? `3px solid ${NAVY}` : "3px solid transparent" }}
          >
            {x.label}
          </button>
        ))}
      </div>

      {error && <div style={{ color: "#B42318", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading && <div style={{ color: MUTE, fontSize: 13 }}>Loading…</div>}

      {!loading && tab === "registrations" && (
        data.registrations.length === 0 ? (
          <div style={{ color: MUTE, fontSize: 13, padding: "14px 2px" }}>No customers registered by agents yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
              <thead>
                <tr>
                  <th style={th}>Customer</th>
                  <th style={th}>Payment number</th>
                  <th style={th}>Internet number</th>
                  <th style={th}>Network</th>
                  <th style={th}>Agent</th>
                  <th style={th}>Orders</th>
                  <th style={th}>Paid</th>
                  <th style={th}>Problems</th>
                  <th style={th}>Registered</th>
                </tr>
              </thead>
              <tbody>
                {data.registrations.map((c) => (
                  <tr key={c.id} onClick={() => openDetail(c)} style={{ cursor: "pointer" }}>
                    <td style={{ ...td, fontWeight: 700 }}>{c.name || "—"}</td>
                    <td style={td}>{local(c.senderNumber)}</td>
                    <td style={td}>{local(c.receiverNumber)}</td>
                    <td style={td}>
                      <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 9, background: c.companyColor || MUTE, marginRight: 6 }} />
                      {c.companyName || "—"}
                    </td>
                    <td style={td}>{c.agentName || "—"}<div style={{ color: MUTE, fontSize: 12 }}>{local(c.agentPhone)}</div></td>
                    <td style={td}>{c.orders}<div style={{ color: MUTE, fontSize: 12 }}>{c.delivered} delivered · {c.failed} failed</div></td>
                    <td style={td}>{money(c.totalPaid)}</td>
                    <td style={td}>{c.openPaymentIssues ? <span style={pill(DELIVERY.failed)}>{c.openPaymentIssues} open</span> : "—"}</td>
                    <td style={td}>{fmt(c.registeredByAgentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {!loading && tab === "transactions" && <OrdersTable rows={transactions} showCustomer showAgent />}
      {!loading && tab === "issues" && <IssuesTable rows={filteredIssues} onResolve={resolve} showAgent />}

      {detail && (
        <div onClick={() => setDetail(null)} style={{ position: "fixed", inset: 0, background: "rgba(11,18,64,.45)", zIndex: 1000, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: SURFACE, borderRadius: 18, width: "100%", maxWidth: 1000, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 18, color: INK }}>{detail.name || "Customer"}</div>
              <button style={btn(false)} onClick={() => setDetail(null)}><X size={14} /></button>
            </div>
            {detail.loading && <div style={{ color: MUTE }}>Loading…</div>}
            {detail.error && <div style={{ color: "#B42318" }}>{detail.error}</div>}
            {detail.id && (
              <>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                  <Stat label="Payment number" value={local(detail.senderNumber)} />
                  <Stat label="Internet number" value={local(detail.receiverNumber)} />
                  <Stat label="Network" value={detail.companyName || "—"} />
                  <Stat label="Registered by" value={detail.agentName || "—"} />
                </div>
                <div style={{ fontSize: 12.5, color: MUTE, marginBottom: 12 }}>Registered {fmt(detail.registeredByAgentAt)} · {(detail.orders || []).length} orders · {money(detail.totalPaid)} paid</div>
                <div style={{ fontWeight: 800, color: INK, margin: "6px 0" }}>Orders</div>
                <OrdersTable rows={detail.orders || []} />
                <div style={{ fontWeight: 800, color: INK, margin: "16px 0 6px" }}>Payment problems</div>
                <IssuesTable rows={(detail.paymentIssues || []).map((i) => ({ ...i, customerName: detail.name }))} onResolve={resolve} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
