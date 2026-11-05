// Admin Hub (admin.waaproltd.com) hand-off. The hub opens this dashboard as
// https://admin.waaproltd.com/<system>/#hub_sso=<signed, 60-second, single-use token>[&hub_nav=switch|hub];
// the token is read once, removed from the address bar at once, and
// exchanged with this system's backend for its normal admin session.
export const HUB_URL = (import.meta.env.VITE_HUB_URL || "").replace(/\/+$/, "");
const NAV_KEY = "waapro_hub_nav";
const PAY_KEY = "waapro_hub_pay";

export function takeHubAssertion() {
  const hash = window.location.hash || "";
  if (!/[#&]hub_sso=/.test(hash)) return null;
  const params = new URLSearchParams(hash.slice(1));
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  // Which way back to the hub to offer (only a link: the hub decides what each person sees).
  try {
    const nav = params.get("hub_nav");
    if (nav === "switch" || nav === "hub") sessionStorage.setItem(NAV_KEY, nav);
    else sessionStorage.removeItem(NAV_KEY);
    // Super Admins: read-only token for their own annual payment status.
    const pay = params.get("hub_pay");
    if (pay) sessionStorage.setItem(PAY_KEY, pay);
    else sessionStorage.removeItem(PAY_KEY);
  } catch {
    /* storage unavailable: no link back */
  }
  return params.get("hub_sso") || null;
}

/** "switch" (other systems), "hub" (admin management only) or null. */
export function hubNav() {
  try {
    return sessionStorage.getItem(NAV_KEY);
  } catch {
    return null;
  }
}

/** The hub's front door: signed-in admins are taken straight to their system. */
export function goToHub() {
  if (HUB_URL) window.location.assign(`${HUB_URL}/`);
}

/** Back to the hub on purpose (switch system / manage admins): it stays open. */
export function openHub() {
  if (HUB_URL) window.location.assign(`${HUB_URL}/?hub=1`);
}

/** Signing out of a dashboard opened from the hub signs out of the hub too (Platform Owners return to it). */
export function signOutToHub() {
  try {
    sessionStorage.removeItem(NAV_KEY);
    sessionStorage.removeItem(PAY_KEY);
  } catch {
    /* ignore */
  }
  if (HUB_URL) window.location.assign(`${HUB_URL}/?from=system`);
}

/**
 * System Control: when this system's API answers "suspended" (the Platform
 * Owner disabled the system in the Admin Hub), tell the dashboard so it
 * shows the suspension notice instead of a half-working page.
 */
let watching = false;
const suspendedListeners = new Set();
export function watchSystemSuspension(onSuspended) {
  suspendedListeners.add(onSuspended);
  if (!watching && typeof window !== "undefined" && window.fetch) {
    watching = true;
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await original(...args);
      if (res.status === 503) {
        res
          .clone()
          .json()
          .then((body) => {
            if (body && body.code === "SYSTEM_SUSPENDED") suspendedListeners.forEach((fn) => fn(body.error));
          })
          .catch(() => undefined);
      }
      return res;
    };
  }
  return () => suspendedListeners.delete(onSuspended);
}

/** The signed-in Super Admin's annual payment status from the hub (null: none to show). */
export async function loadHubPayment() {
  let token = null;
  try {
    token = sessionStorage.getItem(PAY_KEY);
  } catch {
    return null;
  }
  if (!token || !HUB_URL) return null;
  const res = await fetch(`${HUB_URL}/api/billing/view`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return (await res.json()).subscription || null;
}
