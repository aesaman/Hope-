const CACHE = "study-dashboard-v7";
const ASSETS = ["./index.html", "./style.css", "./style.css?v=7", "./app.js", "./app.js?v=7", "./db.js", "./timer.js", "./charts.js", "./share.js", "./shamsi.js", "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    await Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null)));
  }).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).then((res) => {
    if (res && res.ok) caches.open(CACHE).then((cache) => cache.put(event.request, res.clone()));
    return res;
  }).catch(() => caches.match(event.request)));
});
