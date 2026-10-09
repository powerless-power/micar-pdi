const PREFIX = `car-inspection-static-${encodeURIComponent(new URL(self.registration.scope).pathname)}-`;
const CACHE = `${PREFIX}v11`;
const localAssets = [
  "./",
  "./index.html",
  "./data/common.js",
  "./data/models/n70.js",
  "./data/models/n90.js",
  "./data/models/su7.js",
  "./data/models/yu7.js",
  "./data/catalog.js",
  "./app.js",
  "./manifest.webmanifest",
  "./public/icons/icon-192.png",
  "./public/icons/icon-512.png",
  "./public/icons/maskable-512.png",
  "./public/icons/apple-touch-icon.png",
  "./public/fonts/NotoSansCJKsc-Regular.otf",
];
const libraries = [
  "https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js",
  "https://cdn.jsdelivr.net/npm/pdfmake@0.2.23/build/pdfmake.min.js",
];
const allowed = new Set([
  ...localAssets.map((path) => new URL(path, self.registration.scope).href),
  ...libraries,
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(localAssets);
      for (const url of libraries) {
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) throw new Error("Offline dependency unavailable");
        await cache.put(url, response);
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== CACHE)
          await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (
    request.mode === "navigate" &&
    request.url.startsWith(self.registration.scope)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match("./index.html")) || fetch(request);
      })(),
    );
  } else if (allowed.has(request.url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(request)) || fetch(request);
      })(),
    );
  }
});
