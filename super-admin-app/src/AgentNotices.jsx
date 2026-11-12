// Maintenance Notices for the AGENT APP: an admin writes an announcement
// (maintenance / info / warning) with an optional scheduled start and end;
// every agent phone shows it at the top of the app (and gets a push when it
// is created). Self-contained so the same file works in every system's
// dashboard: it only needs that dashboard's admin API request function.
import React, { useEffect, useState } from "react";
import { Megaphone, Pencil, Trash2, Plus, X } from "lucide-react";

export { Megaphone as AgentNoticesIcon };

const INK = "var(--c-0b1240, #0B1240)";
const MUTE = "var(--c-6b7390, #6B7390)";
const BORDER = "var(--c-e3e7f2, #E3E7F2)";
const SURFACE = "var(--c-surface, #FFFFFF)";
const NAVY = "#0B2A6B";

const KIND = {
  maintenance: { label: "Maintenance", bg: "#FFF4D6", fg: "#8A6200" },
  warning: { label: "Warning", bg: "#FDE2E2", fg: "#B42318" },
  info: { label: "Info", bg: "#E3EEFD", fg: "#1450B4" },
};
const PHASE = {
  active: { label: "Showing now", bg: "#E6F6EC", fg: "#137A3A" },
  scheduled: { label: "Scheduled", bg: "#E3EEFD", fg: "#1450B4" },
  ended: { label: "Ended", bg: "#EEF0F5", fg: "#6B7390" },
  disabled: { label: "Off", bg: "#EEF0F5", fg: "#6B7390" },
};

const input = {
  width: "100%", padding: "10px 12px", borderRadius: 10, border: `1px solid ${BORDER}`,
  fontSize: 13.5, color: INK, background: SURFACE, outline: "none", boxSizing: "border-box",
};
const pill = (c) => ({ display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: c.bg, color: c.fg });
const btn = (primary) => ({
  display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, padding: "9px 14px", borderRadius: 10,
  cursor: "pointer", border: primary ? "none" : `1px solid ${BORDER}`, background: primary ? NAVY : SURFACE, color: primary ? "#fff" : NAVY,
});

// <input type="datetime-local"> works in the admin's own local time.
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

const EMPTY = { title: "", message: "", kind: "maintenance", startsAt: "", endsAt: "", enabled: true };

export default function AgentNotices({ request }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(null); // null = closed; {id?, ...fields}
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const load = () => {
    setLoading(true);
    setError("");
    request("/admin/agent-notices")
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch((e) => setError(e.message || "Could not load notices."))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const open = (n) => {
    setFormError("");
    setForm(n ? { id: n.id, title: n.title, message: n.message, kind: n.kind, startsAt: toLocalInput(n.startsAt), endsAt: toLocalInput(n.endsAt), enabled: n.enabled } : { ...EMPTY });
  };

  const save = async () => {
    if (!form.title.trim() || !form.message.trim()) return setFormError("Title and message are required.");
    if (form.startsAt && form.endsAt && new Date(form.endsAt) <= new Date(form.startsAt)) return setFormError("The end time must be after the start time.");
    setSaving(true);
    setFormError("");
    const body = { title: form.title.trim(), message: form.message.trim(), kind: form.kind, startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt), enabled: form.enabled };
    try {
      if (form.id) await request(`/admin/agent-notices/${form.id}`, { method: "PUT", body });
      else await request("/admin/agent-notices", { method: "POST", body });
      setForm(null);
      load();
    } catch (e) {
      setFormError(e.message || "Could not save the notice.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (n) => {
    try {
      await request(`/admin/agent-notices/${n.id}`, { method: "PUT", body: { title: n.title, message: n.message, kind: n.kind, startsAt: n.startsAt, endsAt: n.endsAt, enabled: !n.enabled } });
      load();
    } catch (e) {
      setError(e.message || "Could not update the notice.");
    }
  };

  const remove = async (n) => {
    if (!window.confirm(`Delete the notice "${n.title}"? Agents stop seeing it at once.`)) return;
    try {
      await request(`/admin/agent-notices/${n.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(e.message || "Could not delete the notice.");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontWeight: 800, fontSize: 17, color: INK }}>Maintenance Notices</div>
        <button style={btn(true)} onClick={() => open(null)}><Plus size={15} /> New notice</button>
      </div>
      <div style={{ fontSize: 13, color: MUTE, marginBottom: 14 }}>
        Announcements shown at the top of every agent's AGENT APP. Agents see a notice from its start time until its end time; new notices are also sent as a push notification.
      </div>
      {error && <div style={{ color: "#B42318", fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading ? (
        <div style={{ color: MUTE, fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 22, color: MUTE, fontSize: 13.5 }}>No notices yet.</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map((n) => (
            <div key={n.id} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 16, opacity: n.phase === "ended" || n.phase === "disabled" ? 0.7 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={pill(KIND[n.kind] || KIND.info)}>{(KIND[n.kind] || KIND.info).label}</span>
                <span style={pill(PHASE[n.phase] || PHASE.ended)}>{(PHASE[n.phase] || PHASE.ended).label}</span>
                <div style={{ fontWeight: 800, fontSize: 14.5, color: INK, flex: "1 1 180px" }}>{n.title}</div>
                <button style={btn(false)} onClick={() => toggle(n)}>{n.enabled ? "Turn off" : "Turn on"}</button>
                <button style={btn(false)} onClick={() => open(n)} aria-label="Edit"><Pencil size={14} /></button>
                <button style={{ ...btn(false), color: "#B42318" }} onClick={() => remove(n)} aria-label="Delete"><Trash2 size={14} /></button>
              </div>
              <div style={{ fontSize: 13.5, color: INK, marginTop: 8, whiteSpace: "pre-wrap" }}>{n.message}</div>
              <div style={{ fontSize: 12, color: MUTE, marginTop: 6 }}>
                {n.startsAt ? `Starts ${fmt(n.startsAt)}` : "Starts immediately"}
                {" · "}
                {n.endsAt ? `Ends ${fmt(n.endsAt)}` : "No end time"}
              </div>
            </div>
          ))}
        </div>
      )}

      {form && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(11,18,64,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 16 }}>
          <div style={{ background: SURFACE, borderRadius: 18, width: 480, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto", padding: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: INK }}>{form.id ? "Edit notice" : "New notice"}</div>
              <button onClick={() => setForm(null)} style={{ background: "none", border: "none", cursor: "pointer" }} aria-label="Close"><X size={20} color={MUTE} /></button>
            </div>
            {formError && <div style={{ color: "#B42318", fontSize: 13, marginBottom: 10 }}>{formError}</div>}
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: MUTE, marginBottom: 6 }}>Type</label>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              {Object.entries(KIND).map(([k, c]) => (
                <button key={k} onClick={() => setForm({ ...form, kind: k })} style={{ ...pill(c), cursor: "pointer", border: form.kind === k ? `2px solid ${c.fg}` : "2px solid transparent", padding: "6px 12px" }}>{c.label}</button>
              ))}
            </div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: MUTE, marginBottom: 6 }}>Title</label>
            <input style={{ ...input, marginBottom: 12 }} maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. System maintenance tonight" />
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: MUTE, marginBottom: 6 }}>Message</label>
            <textarea style={{ ...input, minHeight: 90, resize: "vertical", marginBottom: 12 }} maxLength={1000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="What agents need to know" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: MUTE, marginBottom: 6 }}>Start (optional)</label>
                <input type="datetime-local" style={input} value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: MUTE, marginBottom: 6 }}>End (optional)</label>
                <input type="datetime-local" style={input} value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, color: INK, marginBottom: 16 }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Show to agents
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={btn(false)} onClick={() => setForm(null)}>Cancel</button>
              <button style={{ ...btn(true), opacity: saving ? 0.6 : 1 }} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
