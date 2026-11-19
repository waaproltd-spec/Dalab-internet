// "Other Agents" in the AGENT APP: lets an admin choose whether agents can
// see each other's work phone numbers (system setting
// agent_directory_show_phone). The server enforces it: when off, numbers
// are never sent to the app. Self-contained so every dashboard can use it.
import React, { useEffect, useState } from "react";
import { Users } from "lucide-react";

const KEY = "agent_directory_show_phone";

export default function AgentDirectorySetting({ request }) {
  const [value, setValue] = useState(null); // null = loading
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    request("/admin/settings")
      .then((s) => setValue(String((s && (s[KEY] ?? s.agentDirectoryShowPhone)) ?? "true") !== "false"))
      .catch(() => setValue(true));
  }, []);

  const toggle = async () => {
    const next = !value;
    setSaving(true);
    setError("");
    try {
      await request(`/admin/settings/${KEY}`, { method: "PUT", body: { value: next ? "true" : "false" } });
      setValue(next);
    } catch (e) {
      setError(e.message || "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "var(--c-surface, #fff)", border: "1px solid var(--c-e3e7f2, #E3E7F2)", borderRadius: 14, padding: "12px 16px", marginBottom: 14 }}>
      <Users size={18} color="#0B2A6B" />
      <div style={{ flex: "1 1 240px" }}>
        <div style={{ fontWeight: 800, fontSize: 13.5, color: "var(--c-0b1240, #0B1240)" }}>Other Agents (Agent App)</div>
        <div style={{ fontSize: 12.5, color: "var(--c-6b7390, #6B7390)" }}>
          Agents see each other's name and ONLINE / OFFLINE status. Choose whether they also see each other's work phone number.
        </div>
        {error && <div style={{ fontSize: 12.5, color: "#B42318", marginTop: 4 }}>{error}</div>}
      </div>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--c-0b1240, #0B1240)", cursor: value === null || saving ? "default" : "pointer" }}>
        <input type="checkbox" checked={!!value} disabled={value === null || saving} onChange={toggle} />
        Show work phone numbers
      </label>
    </div>
  );
}
