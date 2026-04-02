/**
 * app.js — Bugs & Drugs PWA application logic.
 *
 * Handles:
 *  - SearchEngine initialisation & search UX
 *  - Content page loading + link interception
 *  - URL-based routing (/{uuid} deep links)
 *  - Popover tooltip display
 *  - Service worker registration & update notification
 *  - Install prompt (A2HS)
 */

import { SearchEngine, DEFAULT_TOP_K } from "./search.js";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const searchInput   = document.getElementById("search-input");
const searchBtn     = document.getElementById("search-btn");
const statusEl      = document.getElementById("status-text");
const statusBar     = document.getElementById("status-bar");
const resultsPanel  = document.getElementById("results-panel");
const contentPanel  = document.getElementById("content-panel");
const installBtn    = document.getElementById("install-btn");
const updateBanner      = document.getElementById("update-banner");
const updateReloadBtn   = document.getElementById("update-reload");
const contentVersionEl  = document.getElementById("content-version");
const downloadIndicator = document.getElementById("download-indicator");
const popoverEl     = document.getElementById("popover");
const popoverBody   = document.getElementById("popover-body");
const popoverClose  = document.getElementById("popover-close");
const logoLink      = document.getElementById("logo");

// ── Base path (set by GHA for GitHub Pages subpath deployments) ───────────────
const BASE = new URL(".", document.baseURI).pathname.replace(/\/$/, "");

// ── State ─────────────────────────────────────────────────────────────────────
const engine = new SearchEngine(setStatus, BASE);
let installEvent = null;
let searchDebounceTimer = null;
let homeUuid = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

let appInitialized = false;

async function boot() {
  registerServiceWorker(); // sets up SW + message listener

  const [versionData, status] = await Promise.all([
    fetch(`${BASE}/data/version.json`).then(r => r.ok ? r.json() : null).catch(() => null),
    querySWStatus(),
  ]);

  if (versionData?.version) contentVersionEl.textContent = `v${versionData.version}`;
  homeUuid = versionData?.home_uuid ?? null;

  if (status?.status === "ready") {
    await initApp();
    navigator.serviceWorker.controller?.postMessage({ type: "CHECK_VERSION" });
    if (status.hasPendingUpdate) updateBanner.hidden = false;
  } else {
    // Bundle not yet downloaded — show placeholder, wait for BUNDLE_READY message
    showBundlePlaceholder();
  }
}

async function querySWStatus() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(r => setTimeout(r, 5000)),
    ]);
    if (!reg?.active) return null;
    return await new Promise(resolve => {
      const mc = new MessageChannel();
      mc.port1.onmessage = e => resolve(e.data);
      reg.active.postMessage({ type: "GET_STATUS" }, [mc.port2]);
      setTimeout(() => resolve(null), 3000);
    });
  } catch { return null; }
}

async function initApp() {
  if (appInitialized) return;
  appInitialized = true;

  showPanel("content");
  if (homeUuid) loadContent(homeUuid);

  try {
    await engine.init();
    searchInput.disabled = false;
    searchBtn.disabled = false;
    searchInput.placeholder = "Search drugs, organisms, conditions…";
  } catch (e) {
    setStatus("Failed to load: " + e.message, "error");
    console.error(e);
  }
}

function showBundlePlaceholder() {
  showPanel("content");
  contentPanel.innerHTML = `
    <div id="bundle-placeholder">
      <p>Downloading Bugs &amp; Drugs…</p>
      <div id="bundle-progress-wrap"><div id="bundle-progress-bar"></div></div>
      <p id="bundle-progress-text">Connecting…</p>
    </div>
  `;
  setStatus("Downloading…");
}

function updateDownloadProgress({ received, total, phase }) {
  const bar = document.getElementById("bundle-progress-bar");
  if (bar) {
    // Initial download: update inline placeholder
    if (phase === "unpacking") {
      bar.style.width = "100%";
      document.getElementById("bundle-progress-text").textContent = "Unpacking…";
    } else {
      if (total > 0) bar.style.width = `${Math.round(received / total * 100)}%`;
      document.getElementById("bundle-progress-text").textContent = total > 0
        ? `${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`
        : `${(received / 1e6).toFixed(0)} MB`;
    }
    return;
  }
  // Background update download: unobtrusive footer indicator
  if (!downloadIndicator) return;
  downloadIndicator.hidden = false;
  downloadIndicator.textContent = phase === "unpacking" ? "↓ Unpacking…"
    : total > 0 ? `↓ ${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB`
    : `↓ ${(received / 1e6).toFixed(0)} MB`;
}

function handleSWMessage({ type, ...data }) {
  if (type === "DOWNLOAD_PROGRESS") { updateDownloadProgress(data); return; }
  if (type === "BUNDLE_READY")      { initApp(); return; }
  if (type === "UPDATE_READY")      {
    if (downloadIndicator) downloadIndicator.hidden = true;
    updateBanner.hidden = false;
    return;
  }
  if (type === "DOWNLOAD_ERROR") {
    setStatus("Download failed — check connection", "error");
    const text = document.getElementById("bundle-progress-text");
    if (text) text.textContent = "Download failed. Reload to retry.";
    return;
  }
  if (type === "RELOAD") { location.href = BASE + "/"; return; }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(uuid) {
  showPanel("content");
  loadContent(uuid);
}

logoLink?.addEventListener("click", (e) => {
  e.preventDefault();
  searchInput.value = "";
  clearResults();
  if (homeUuid) navigate(homeUuid);
});

// ── Service Worker ────────────────────────────────────────────────────────────
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(`${BASE}/sw.js`).then((reg) => {
    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          updateBanner.hidden = false;
        }
      });
    });
  }).catch(console.warn);

  navigator.serviceWorker.addEventListener("message", e => handleSWMessage(e.data));

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!refreshing) { refreshing = true; location.reload(); }
  });
}

updateReloadBtn?.addEventListener("click", () => {
  navigator.serviceWorker.getRegistration().then(reg => {
    if (reg?.waiting) {
      // SW code update waiting to activate
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      // Bundle update ready to apply
      navigator.serviceWorker.controller?.postMessage({ type: "APPLY_UPDATE" });
    }
  });
});

// ── A2HS install prompt ───────────────────────────────────────────────────────
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  installBtn.hidden = false;
});
installBtn?.addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  if (outcome === "accepted") installBtn.hidden = true;
  installEvent = null;
});

// ── Status bar ────────────────────────────────────────────────────────────────
function setStatus(msg, level = "info") {
  statusEl.textContent = msg;
  statusBar.dataset.level = level;
}

// ── Search ────────────────────────────────────────────────────────────────────
searchInput?.addEventListener("focus", () => {
  const q = searchInput.value.trim();
  if (q && resultsPanel.innerHTML) showPanel("results");
});

searchInput?.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  const q = searchInput.value.trim();
  if (!q) { clearResults(); return; }
  searchDebounceTimer = setTimeout(() => runSearch(q), 350);
});

searchBtn?.addEventListener("click", () => {
  const q = searchInput.value.trim();
  if (q) runSearch(q);
});

searchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchDebounceTimer);
    const q = searchInput.value.trim();
    if (q) runSearch(q);
  } else if (e.key === "Escape") {
    clearResults();
    searchInput.value = "";
  }
});

async function runSearch(query) {
  setStatus("Searching…");
  showPanel("results");
  resultsPanel.innerHTML = '<div class="searching-indicator">Searching…</div>';

  try {
    const results = await engine.search(query, DEFAULT_TOP_K);
    renderResults(results, query);
    setStatus(`${results.length} result${results.length !== 1 ? "s" : ""}`);
  } catch (e) {
    setStatus("Search error: " + e.message, "error");
    resultsPanel.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

function renderResults(results, query) {
  if (!results.length) {
    resultsPanel.innerHTML = '<div class="no-results">No results found.</div>';
    return;
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  resultsPanel.innerHTML = results.map((r, i) => `
    <article class="result-card" data-uuid="${r.uuid}" tabindex="0" role="button"
             aria-label="Open ${esc(r.title)}">
      <p class="result-breadcrumb">${highlight(esc(r.breadcrumb), terms)}</p>
      <h3 class="result-title">${highlight(esc(r.title), terms)}</h3>
      <p class="result-snippet">${highlight(esc(r.snippet), terms)}</p>
    </article>
  `).join("");

  resultsPanel.querySelectorAll(".result-card").forEach((card) => {
    card.addEventListener("click", () => navigate(card.dataset.uuid));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") navigate(card.dataset.uuid);
    });
  });
}

function highlight(text, terms) {
  if (!terms.length) return text;
  const pattern = new RegExp(`(${terms.map(escapeRe).join("|")})`, "gi");
  return text.replace(pattern, "<mark>$1</mark>");
}

function esc(str) {
  return (str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clearResults() {
  resultsPanel.innerHTML = "";
  showPanel("content");
}

// ── Content loading ───────────────────────────────────────────────────────────
function parseHTML(html) {
  return new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstElementChild;
}

async function loadContent(uuid) {
  uuid = uuid.toLowerCase();
  contentPanel.innerHTML = '<div class="content-loading">Loading…</div>';

  try {
    const r = await fetch(`${BASE}/content/${uuid}.html`);
    if (!r.ok) throw new Error(`Page not found (${r.status})`);
    const html = await r.text();
    renderContent(html);
  } catch (e) {
    contentPanel.innerHTML = `<div class="error-msg">Failed to load page: ${e.message}</div>`;
  }
}

function renderContent(html) {
  const root = parseHTML(html);

  // Intercept all links — UUID hrefs become SPA navigations,
  // .aa/.popover-link become popovers, #anchors stay as-is.
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const raw  = href.replace(/^\//, "").replace(/\.html$/, "");

    // Popover links
    if (a.classList.contains("aa") || a.dataset.popover) {
      a.setAttribute("href", "#");
      a.classList.add("popover-trigger");
      const uuid = raw.toLowerCase();
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await showPopover(uuid, a);
      });
      return;
    }

    // UUID navigation links (nav, internal-link, breadcrumb, etc.)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      const uuid = raw.toLowerCase();
      a.setAttribute("href", "#");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(uuid);
      });
      return;
    }

    // Jump links (#anchor) and external links — leave as-is
  });

  contentPanel.innerHTML = "";
  contentPanel.appendChild(root);
  contentPanel.scrollTop = 0;
}

// ── Popover tooltip ───────────────────────────────────────────────────────────
async function showPopover(uuid, anchor) {
  popoverBody.innerHTML = '<span class="popover-loading">Loading…</span>';
  positionPopover(anchor);
  popoverEl.hidden = false;

  try {
    const r = await fetch(`${BASE}/content/${uuid}.html`);
    if (!r.ok) throw new Error("Not found");
    const html = await r.text();
    const root = parseHTML(html);
    root.querySelector(".page_breadcrumb")?.remove();
    popoverBody.innerHTML = root.innerHTML;
  } catch (e) {
    popoverBody.textContent = "Could not load content.";
  }
}

function positionPopover(anchor) {
  const rect = anchor.getBoundingClientRect();
  const viewW = window.innerWidth;

  popoverEl.style.top   = "";
  popoverEl.style.left  = "";
  popoverEl.style.right = "";
  popoverEl.style.bottom = "";

  const top  = rect.bottom + 6;
  const left = Math.min(rect.left, viewW - 320 - 12);
  popoverEl.style.top  = `${Math.max(8, top)}px`;
  popoverEl.style.left = `${Math.max(8, left)}px`;
}

popoverClose?.addEventListener("click", () => { popoverEl.hidden = true; });
document.addEventListener("click", (e) => {
  if (!popoverEl.hidden && !popoverEl.contains(e.target) &&
      !e.target.classList.contains("popover-trigger")) {
    popoverEl.hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") popoverEl.hidden = true;
});

// ── Panel switching ───────────────────────────────────────────────────────────
function showPanel(which) {
  resultsPanel.hidden = which !== "results";
  contentPanel.hidden = which !== "content";
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot();
