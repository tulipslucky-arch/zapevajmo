/* Zapevajmo service worker â€” keĹˇ za offline, ali kod uvijek svjeĹľ */
const CACHE = "zapevajmo-v2";
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.js", "./acr.js", "./config.js",
  "./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  /* ACRCloud i LRCLIB â€” uvijek mreĹľa */
  if (url.origin !== self.location.origin) return;

  /* HTML/CSS/JS â€” PRVO MREĹ˝A (da update-ovi odmah dolaze do telefona), keĹˇ kao rezerva */
  const isCode = e.request.mode === "navigate" ||
                 /\.(js|css|html)$/i.test(url.pathname);
  if (isCode) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then(h => h || caches.match("./index.html")))
    );
    return;
  }

  /* ostalo (slike itd.) â€” keĹˇ prvi */
  e.respondWith(
    caches.match(e.request).then(hit => hit ||
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
    )
  );
});
