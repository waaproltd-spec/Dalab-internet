// Admin Hub (admin.waaproltd.com) hand-off. The hub opens this dashboard as
// https://admin.waaproltd.com/<system>/#hub_sso=<signed, 60-second, single-use token>;
// the token is read once, removed from the address bar at once, and
// exchanged with this system's backend for its normal admin session.
export const HUB_URL = (import.meta.env.VITE_HUB_URL || "").replace(/\/+$/, "");

export function takeHubAssertion() {
  const hash = window.location.hash || "";
  const match = hash.match(/[#&]hub_sso=([^&]+)/);
  if (!match) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function goToHub() {
  if (HUB_URL) window.location.assign(`${HUB_URL}/`);
}
