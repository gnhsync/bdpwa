// Service Worker — Bugs & Drugs PWA
// All app content (HTML pages, data, models) is delivered as data/bundle.tar.gz.
// data/version.json lives outside the bundle for lightweight update checks.

const BASE = new URL(".", self.location).pathname.replace(/\/$/, "");

const CACHE_VERSION = "__CACHE_VERSION__";
const SHELL_CACHE   = `shell-${CACHE_VERSION}`;
const BUNDLE_META   = "bundle-meta"; // tiny cache: stores 'current'/'pending' pointers

const SHELL_ASSETS = [
  BASE + "/",
  BASE + "/index.html",
  BASE + "/manifest.json",
  BASE + "/css/style.css",
  BASE + "/js/app.js",
  BASE + "/js/search.js",
  BASE + "/js/bm25.js",
];

// ── Bundle cache pointer helpers ──────────────────────────────────────────────

async function getPtr(key) {
  const c = await caches.open(BUNDLE_META);
  const r = await c.match(key);
  return r ? r.text() : null;
}

async function setPtr(key, val) {
  const c = await caches.open(BUNDLE_META);
  await c.put(key, new Response(val, { headers: { "Content-Type": "text/plain" } }));
}

async function delPtr(key) {
  const c = await caches.open(BUNDLE_META);
  await c.delete(key);
}

// ── MIME types ────────────────────────────────────────────────────────────────

function mimeFor(path) {
  if (path.endsWith(".html")) return "text/html;charset=utf-8";
  if (path.endsWith(".json")) return "application/json;charset=utf-8";
  if (path.endsWith(".js"))   return "application/javascript";
  if (path.endsWith(".txt"))  return "text/plain;charset=utf-8";
  return "application/octet-stream";
}

// ── Client notifications ──────────────────────────────────────────────────────

async function notify(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage(msg));
}

// ── Bundle download & unpack ──────────────────────────────────────────────────

async function downloadBundle(cacheName, version) {
  const resp = await fetch(BASE + "/data/bundle.tar.gz", { cache: "no-store" });
  if (!resp.ok) throw new Error(`bundle.tar.gz fetch failed: ${resp.status}`);

  const total = parseInt(resp.headers.get("content-length") || "0", 10);
  let received = 0;

  // Track compressed-byte progress while streaming through gzip decompressor
  const progressStream = new TransformStream({
    transform(chunk, controller) {
      received += chunk.length;
      notify({ type: "DOWNLOAD_PROGRESS", received, total });
      controller.enqueue(chunk);
    },
  });

  const decompressed = resp.body
    .pipeThrough(progressStream)
    .pipeThrough(new DecompressionStream("gzip"));

  const tarBuf = await new Response(decompressed).arrayBuffer();
  const tar = new Uint8Array(tarBuf);

  notify({ type: "DOWNLOAD_PROGRESS", received, total, phase: "unpacking" });

  // Parse tar: 512-byte headers, octal size at offset 124
  const dec = new TextDecoder();
  const cache = await caches.open(cacheName);
  const puts = [];
  let i = 0;
  while (i + 512 <= tar.length) {
    const name = dec.decode(tar.subarray(i, i + 100)).replace(/\0.*$/, "").trim();
    if (!name) break;
    const size = parseInt(dec.decode(tar.subarray(i + 124, i + 136)).replace(/\0.*$/, "").trim(), 8);
    i += 512;
    const data = tar.slice(i, i + size);
    i += Math.ceil(size / 512) * 512;
    puts.push(cache.put(
      new Request(BASE + "/" + name),
      new Response(data, { headers: { "Content-Type": mimeFor(name) } }),
    ));
  }
  await Promise.all(puts);

  // Tag the cache with its content version for identification
  await cache.put("_version", new Response(version, { headers: { "Content-Type": "text/plain" } }));
}

// ── Install ───────────────────────────────────────────────────────────────────
// Only cache the app shell. Bundle download happens in activate so
// clients.claim() can be called first and progress messages reach the page.

self.addEventListener("install", evt => {
  evt.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────

self.addEventListener("activate", evt => {
  evt.waitUntil((async () => {
    // Clean up stale caches; always keep current + pending bundle caches
    const [allKeys, current, pending] = await Promise.all([
      caches.keys(), getPtr("current"), getPtr("pending"),
    ]);
    const keep = new Set([SHELL_CACHE, BUNDLE_META, current, pending].filter(Boolean));
    await Promise.all(allKeys.filter(k => !keep.has(k)).map(k => caches.delete(k)));

    // Take control of all pages immediately so progress messages reach them
    await self.clients.claim();

    // Download the initial bundle if we don't have one yet.
    // waitUntil keeps the SW alive for the duration of the download.
    if (!current) {
      await ensureBundle().catch(err => {
        console.warn("Initial bundle download failed:", err);
        notify({ type: "DOWNLOAD_ERROR", message: err.message });
      });
    }
  })());
});

async function ensureBundle() {
  // Name the cache after the content version so we can detect staleness
  let version = "initial";
  try {
    const r = await fetch(BASE + "/data/version.json", { cache: "no-store" });
    if (r.ok) { const v = await r.json(); version = v.version || version; }
  } catch {}

  const cacheName = `bundle-${version}`;

  // Already populated (e.g. SW re-install after a code-only update)
  const existing = await caches.open(cacheName);
  if ((await existing.keys()).length > 0) {
    await setPtr("current", cacheName);
    notify({ type: "BUNDLE_READY" });
    return;
  }

  await downloadBundle(cacheName, version);
  await setPtr("current", cacheName);
  notify({ type: "BUNDLE_READY" });
}

// ── Messages ──────────────────────────────────────────────────────────────────

self.addEventListener("message", evt => {
  const { type } = evt.data || {};
  if (type === "SKIP_WAITING")  { self.skipWaiting(); return; }
  if (type === "GET_STATUS")    { handleGetStatus(evt); return; }
  if (type === "CHECK_VERSION") { checkForUpdate().catch(console.warn); return; }
  if (type === "APPLY_UPDATE")  { applyUpdate().catch(console.warn); return; }
});

async function handleGetStatus(evt) {
  const [current, pending] = await Promise.all([getPtr("current"), getPtr("pending")]);
  const msg = {
    type: "STATUS",
    status: current ? "ready" : "downloading",
    hasPendingUpdate: !!pending,
  };
  (evt.ports?.[0] ?? evt.source)?.postMessage(msg);
}

async function checkForUpdate() {
  const resp = await fetch(BASE + "/data/version.json", { cache: "no-store" });
  if (!resp.ok) return;
  const { version } = await resp.json();
  if (!version) return;

  const [current, pending] = await Promise.all([getPtr("current"), getPtr("pending")]);
  const newName = `bundle-${version}`;

  if (current === newName || pending === newName) return;

  // Remove any leftover partial download for this version before re-trying
  await caches.delete(newName).catch(() => {});

  try {
    await downloadBundle(newName, version);
    await setPtr("pending", newName);
    notify({ type: "UPDATE_READY", version });
  } catch (err) {
    console.warn("Bundle update download failed:", err);
    await caches.delete(newName).catch(() => {});
  }
}

async function applyUpdate() {
  const pending = await getPtr("pending");
  if (!pending) return;
  const current = await getPtr("current");

  // Swap pointer atomically before deleting old cache
  await setPtr("current", pending);
  await delPtr("pending");
  if (current) await caches.delete(current);

  notify({ type: "RELOAD" });
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", evt => {
  if (evt.request.method !== "GET") return;

  const { pathname } = new URL(evt.request.url);

  // All navigations → shell (routing is handled in-app)
  if (evt.request.mode === "navigate") {
    evt.respondWith(
      caches.match(BASE + "/index.html", { cacheName: SHELL_CACHE })
        .then(r => r || fetch(evt.request))
    );
    return;
  }

  // Shell assets
  if (SHELL_ASSETS.some(a => pathname === a)) {
    evt.respondWith(cacheFirst(evt.request, SHELL_CACHE));
    return;
  }

  // version.json — always network so update checks see the latest value
  if (pathname === BASE + "/data/version.json") {
    evt.respondWith(
      fetch(evt.request, { cache: "no-store" }).catch(() =>
        new Response("{}", { headers: { "Content-Type": "application/json" } })
      )
    );
    return;
  }

  // Everything else (content pages, data files, models) → bundle cache
  evt.respondWith(serveFromBundle(evt.request));
});

async function serveFromBundle(request) {
  const cacheName = await getPtr("current");
  if (!cacheName) return new Response("Bundle not yet downloaded", { status: 503 });
  const cache = await caches.open(cacheName);
  return (await cache.match(request)) ?? new Response("Not found in bundle", { status: 404 });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
