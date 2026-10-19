/* Service worker de MedsAlarm: deja la app disponible sin conexión y
   maneja los botones de la notificación de alarma ("Ya la tomé" / "Aplazar"). */
const VERSION = "medsalarm-v2";
const SHELL = [
  "./", "index.html", "app.css", "app.js", "i18n.js", "pdf.js", "manifest.webmanifest",
  "icons/icon-32.png", "icons/icon-64.png", "icons/icon-192.png", "icons/icon-512.png",
  "icons/maskable-192.png", "icons/maskable-512.png", "icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Primero la red (para recibir actualizaciones), y si no hay conexión, la copia guardada
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined)))
  );
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action || "open";
  const medId = event.notification.data && event.notification.data.medId;
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all.length) {
      const client = all[0];
      client.postMessage({ type: "notif-action", action, medId });
      if ("focus" in client) { try { await client.focus(); } catch (e) {} }
      return;
    }
    const url = new URL(`./?notif=${encodeURIComponent(action)}&med=${encodeURIComponent(medId)}`, self.registration.scope);
    await self.clients.openWindow(url.href);
  })());
});
