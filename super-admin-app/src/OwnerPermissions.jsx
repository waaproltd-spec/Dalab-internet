// Owner only (Roles & Permissions page): which services each AGENT may use,
// and the history of every permission granted or revoked (Admins, from this
// dashboard or the Admin Hub, and Agents). An Admin never sees this page and
// the server refuses these calls to anyone but the Owner.
import React, { useEffect, useMemo, useState } from "react";
import { History, Smartphone, Save } from "lucide-react";

const INK = "var(--c-0b1240, #0B1240)";
const MUTE = "var(--c-6b7390, #6B7390)";
const BORDER = "var(--c-e3e7f2, #E3E7F2)";
const SURFACE = "var(--c-surface, #FFFFFF)";
const NAVY = "#0B2A6B";

const btn = (primary, disabled) => ({
  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700, padding: "7px 12px", borderRadius: 9,
  cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
  border: primary ? "none" : `1px solid ${BORDER}`, background: primary ? NAVY : SURFACE, color: primary ? "#fff" : NAVY,
});
const card = { border: `1px solid ${BORDER}`, borderRadius: 14, background: SURFACE, padding: 16, marginTop: 18 };
const th = { textAlign: "left", padding: "8px 8px", fontSize: 11, fontWeight: 800, color: MUTE, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" };
const td = { padding: "8px", fontSize: 12.5, color: INK, borderBottom: `1px solid ${BORDER}`, verticalAlign: "top" };
const sticky = { position: "sticky", left: 0, background: SURFACE, zIndex: 1 };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const chip = (bg, fg) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg, margin: "1px 3px 1px 0" });

export default function OwnerPermissions({ request }) {
  const [catalog, setCatalog] = useState({ agentServices: [] });
  const [agents, setAgents] = useState([]);
  const [drafts, setDrafts] = useState({}); // agentId -> services[]
  const [savingId, setSavingId] = useState(null);
  const [auditRows, setAuditRows] = useState([]);
  const [auditFilter, setAuditFilter] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = () => {
    setError("");
    Promise.all([request("/admin/permission-catalog"), request("/admin/agent-services"), request("/admin/permission-audit")])
      .then(([c, a, h]) => {
        setCatalog(c || { agentServices: [] });
        setAgents(Array.isArray(a) ? a : []);
        setAuditRows(Array.isArray(h) ? h : []);
        setDrafts({});
      })
      .catch((e) => setError(e.message || "Could not load permissions."));
  };
  useEffect(load, []);

  const services = catalog.agentServices || [];
  const label = useMemo(() => Object.fromEntries(services.map((s) => [s.key, s.label])), [services]);
  const current = (a) => drafts[a.id] ?? a.services ?? [];
  const toggle = (a, key) => {
    const s = current(a);
    setDrafts((d) => ({ ...d, [a.id]: s.includes(key) ? s.filter((k) => k !== key) : [...s, key] }));
  };
  const setAll = (a, on) => setDrafts((d) => ({ ...d, [a.id]: on ? services.map((s) => s.key) : [] }));
  const changed = (a) => drafts[a.id] && JSON.stringify([...drafts[a.id]].sort()) !== JSON.stringify([...(a.services || [])].sort());

  const save = async (a) => {
    setSavingId(a.id);
    setError("");
    setSaved("");
    try {
      await request(`/admin/agents/${a.id}/services`, { method: "PUT", body: { services: current(a) } });
      setSaved(`${a.name}: saved. The agent's phone follows it on its next request.`);
      load();
    } catch (e) {
      setError(e.message || "Could not save.");
    } finally {
      setSavingId(null);
    }
  };

  const shownAudit = auditFilter ? auditRows.filter((r) => r.targetType === auditFilter) : auditRows;

  return (
    <>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 16, color: INK }}>
          <Smartphone size={18} /> Agent services
        </div>
        <div style={{ fontSize: 12.5, color: MUTE, margin: "4px 0 12px" }}>
          Only you (the Owner) choose what each agent may use in the Agent App. Admins can't change this, even with Manage agents.
          A service you switch off is blocked at once. The phone's automatic work (payment SMS, USSD sending) always keeps running.
        </div>
        {error && <div style={{ color: "#B42318", fontSize: 13, marginBottom: 8 }}>{error}</div>}
        {saved && <div style={{ color: "#137A3A", fontSize: 13, marginBottom: 8, fontWeight: 700 }}>{saved}</div>}
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ ...th, ...sticky }}>Agent</th>
                {services.map((s) => (
                  <th key={s.key} style={{ ...th, textAlign: "center" }} title={s.description}>{s.label}</th>
                ))}
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const s = current(a);
                return (
                  <tr key={a.id}>
                    <td style={{ ...td, ...sticky, whiteSpace: "nowrap" }}>
                      <div style={{ fontWeight: 700 }}>{a.name}</div>
                      <div style={{ color: MUTE, fontSize: 11.5 }}>{a.phone}{a.status !== "active" ? " · suspended" : ""}</div>
                      <div style={{ marginTop: 4, display: "flex", gap: 6 }}>
                        <button style={{ ...btn(false), padding: "2px 7px", fontSize: 11 }} onClick={() => setAll(a, true)}>All</button>
                        <button style={{ ...btn(false), padding: "2px 7px", fontSize: 11 }} onClick={() => setAll(a, false)}>None</button>
                      </div>
                    </td>
                    {services.map((x) => (
                      <td key={x.key} style={{ ...td, textAlign: "center" }}>
                        <input type="checkbox" aria-label={`${a.name}: ${x.label}`} checked={s.includes(x.key)} onChange={() => toggle(a, x.key)} />
                      </td>
                    ))}
                    <td style={td}>
                      <button style={btn(true, !changed(a) || savingId === a.id)} disabled={!changed(a) || savingId === a.id} onClick={() => save(a)}>
                        <Save size={13} /> {savingId === a.id ? "Saving…" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {agents.length === 0 && (
                <tr><td style={td} colSpan={services.length + 2}>No agents.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 16, color: INK }}>
            <History size={18} /> Permission history
          </div>
          <select value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)} style={{ padding: "7px 10px", borderRadius: 9, border: `1px solid ${BORDER}`, fontSize: 12.5 }}>
            <option value="">Admins and agents</option>
            <option value="admin">Admins</option>
            <option value="agent">Agents</option>
          </select>
        </div>
        <div style={{ fontSize: 12.5, color: MUTE, margin: "4px 0 12px" }}>Who granted or revoked what, for whom, and when (last 500).</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Changed by</th>
                <th style={th}>For</th>
                <th style={th}>Granted</th>
                <th style={th}>Revoked</th>
                <th style={th}>Role</th>
              </tr>
            </thead>
            <tbody>
              {shownAudit.map((r) => (
                <tr key={r.id}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fmt(r.createdAt)}</td>
                  <td style={td}>{r.actorLabel}{r.source === "admin_hub" ? <div style={{ color: MUTE, fontSize: 11 }}>via Admin Hub</div> : null}</td>
                  <td style={td}>{r.targetLabel}<div style={{ color: MUTE, fontSize: 11 }}>{r.targetType === "agent" ? "Agent" : "Admin"}</div></td>
                  <td style={td}>{(r.granted || []).map((k) => <span key={k} style={chip("#E6F6EC", "#137A3A")}>{label[k] || k}</span>)}</td>
                  <td style={td}>{(r.revoked || []).map((k) => <span key={k} style={chip("#FDE2E2", "#B42318")}>{label[k] || k}</span>)}</td>
                  <td style={td}>{r.roleAfter ? `${r.roleBefore || "—"} → ${r.roleAfter}` : ""}</td>
                </tr>
              ))}
              {shownAudit.length === 0 && (
                <tr><td style={td} colSpan={6}>No changes yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
