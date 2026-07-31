// Minimal service worker powering local ("mock") order-status notifications.
// There is no real Web Push backend here (no VAPID keys, no push-subscription
// storage) — this worker never listens for a `push` event. Its only job is
// to let the already-open page call `registration.showNotification(...)`
// (see notifyOrderStatusChange in src/App.jsx), and to focus/open the app
// when a customer taps the resulting notification.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
