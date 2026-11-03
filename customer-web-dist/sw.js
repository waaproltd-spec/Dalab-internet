// DALAB Customer Web App — offline cache for the app's own files.
//
// What it keeps: this site's static files (index.html, main.dart.js,
// flutter*.js, canvaskit/, assets/, icons/, manifest.json) and Google font
// files Flutter downloads for text. Nothing else.
//
// What it never touches: the DALAB API (a different address, so requests
// to it pass straight through), any non-GET request, anything sent with an
// Authorization header, and anything that isn't a plain 200 response. So
// no login token, password, PIN, order, payment or wallet data is ever
// stored here. Orders and payments always need a live connection.
//
// Strategy: network first, cache only as the fallback when offline, so an
// online customer always gets the newest version of the app and its files
// stay consistent with each other.

const CACHE = "dalab-static-v1";
const FONT_HOSTS = ["fonts.gstatic.com"];
const CORE = ["./", "index.html", "manifest.json", "flutter.js", "flutter_bootstrap.js", "main.dart.js", "icons/Icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheable(request) {
  if (request.method !== "GET") return false;
  if (request.headers.has("authorization")) return false;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    // Only files under this app's own scope.
    return url.href.startsWith(self.registration.scope);
  }
  return url.protocol === "https:" && FONT_HOSTS.includes(url.hostname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!cacheable(request)) return; // API calls and everything else: browser default, never cached

  const isFont = new URL(request.url).origin !== self.location.origin;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isFont) {
      // Font files never change at a given URL.
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    try {
      const response = await fetch(request);
      if (response.ok && (response.type === "basic" || response.type === "cors")) {
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
      if (hit) return hit;
      if (request.mode === "navigate") {
        const shell = await cache.match("index.html");
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
