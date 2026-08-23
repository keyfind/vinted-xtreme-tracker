import { applyListingView, priceBuckets } from "./listing-view.js";

const $ = (selector) => document.querySelector(selector);
const staticMode = document.documentElement.dataset.mode === "static";
const els = {
  profiles: $("#profile-list"), title: $("#page-title"), metrics: $("#metrics"), table: $("#listing-table"), empty: $("#empty-state"),
  count: $("#listing-count"), viewCount: $("#view-count"), search: $("#search"), status: $("#status-filter"), condition: $("#condition-filter"),
  minPrice: $("#min-price"), maxPrice: $("#max-price"), sort: $("#sort-order"), resetFilters: $("#reset-filters"), chart: $("#price-chart"), priceCount: $("#price-count"),
  activity: $("#activity-list"), syncLabel: $("#sync-label"), syncTime: $("#sync-time"), detailSyncTime: $("#detail-sync-time"), sideSync: $("#side-sync"), source: $("#source-badge"),
  profileDialog: $("#profile-dialog"), profileForm: $("#profile-form"), profileTitle: $("#profile-dialog-title"), deleteProfile: $("#delete-profile"),
  importDialog: $("#import-dialog"), importForm: $("#import-form"), drawer: $("#detail-drawer"), drawerContent: $("#drawer-content"), toast: $("#toast"), export: $("#export")
};

let state = null;
let selectedProfileId = localStorage.getItem("selected-profile") || "jbl-xtreme-4";
let adminToken = sessionStorage.getItem("tracker-admin-token") || "";

await refresh();

async function refresh() {
  try {
    const response = await fetch(staticMode ? "./data/state.json" : "/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`Daten konnten nicht geladen werden (HTTP ${response.status})`);
    state = await response.json();
    if (!state.profiles.some((p) => p.id === selectedProfileId)) selectedProfileId = state.profiles[0]?.id;
    render();
  } catch (error) { toast(error.message, true); }
}

function render() {
  const profile = selectedProfile();
  if (!profile) return renderNoProfiles();
  localStorage.setItem("selected-profile", profile.id);
  els.title.textContent = profile.name;
  els.syncLabel.textContent = profile.lastSyncStatus || "Noch nicht synchronisiert";
  els.syncTime.textContent = profile.lastSyncAt ? `Letzter Abgleich ${relative(profile.lastSyncAt)}` : "";
  els.detailSyncTime.textContent = profile.lastDetailSyncAt ? `Details ${relative(profile.lastDetailSyncAt)}` : "Details: noch nicht gelaufen";
  els.sideSync.textContent = profile.active ? (staticMode ? "Suche stündlich · Details täglich" : `alle ${minutes(profile.refreshMinutes)}`) : "pausiert";
  const job = state.collectorJobs?.[profile.id];
  els.source.textContent = profile.collectorEnabled ? (staticMode ? "STÜNDLICHE SUCHE · TÄGLICHE DETAILS" : "VINTED BROWSER-COLLECTOR") : profile.feedUrl ? "AUTOMATISCHER FEED" : "IMPORT / BEISPIELDATEN";
  if (job?.status === "running") {
    els.syncLabel.textContent = job.message;
    els.syncTime.textContent = job.total ? `${job.current} / ${job.total}` : "läuft…";
  }
  els.export.href = staticMode ? "./data/listings.csv" : `/api/export.csv?profileId=${encodeURIComponent(profile.id)}`;
  renderProfiles(); renderMetrics(); renderChart(); renderActivity(); renderTable();
}

function renderProfiles() {
  els.profiles.innerHTML = state.profiles.map((profile) => {
    const metric = state.metrics[profile.id] || {};
    const source = profile.collectorEnabled ? "Browser" : profile.feedUrl ? "Feed" : "Import";
    return `<button class="profile-item ${profile.id === selectedProfileId ? "active" : ""}" data-profile="${esc(profile.id)}"><span class="profile-icon">${initials(profile.name)}</span><span><strong>${esc(profile.name)}</strong><small>${metric.active || 0} online · ${source}</small></span><i aria-hidden="true">›</i></button>`;
  }).join("");
}

function renderMetrics() {
  const metric = state.metrics[selectedProfileId] || {};
  const cards = [
    ["Online", metric.active ?? 0, "Aktuell sichtbar", "signal"],
    ["Medianpreis", metric.medianPrice == null ? "–" : money(metric.medianPrice), "Aktive Angebote", "price"],
    ["Ø Online-Dauer", metric.avgOnlineDays == null ? "–" : `${metric.avgOnlineDays.toFixed(1)} T.`, "Bis Verkauf / Wegfall", "time"],
    ["Verkauft bestätigt", metric.sold ?? 0, `${metric.missing || 0} nicht mehr online`, "sold"]
  ];
  els.metrics.innerHTML = cards.map(([label, value, sub, icon]) => `<article class="metric-card"><div class="metric-icon ${icon}">${metricIcon(icon)}</div><div><span>${label}</span><strong>${value}</strong><small>${sub}</small></div></article>`).join("");
}

function renderChart() {
  const rows = listings().filter((row) => row.status === "active");
  els.priceCount.textContent = `${rows.length} aktive Angebote`;
  if (!rows.length) { els.chart.innerHTML = `<div class="chart-empty">Noch keine aktiven Preisdaten</div>`; return; }
  const buckets = priceBuckets(rows);
  const highest = Math.max(...buckets.map((b) => b.count), 1);
  els.chart.innerHTML = `<div class="bars">${buckets.map((bucket) => {
    const range = `${number(bucket.from)}–${bucket.inclusiveEnd ? "" : "<"}${number(bucket.to)} €`;
    const exact = bucket.prices.length ? bucket.prices.map((price) => money(price)).join(", ") : "Keine Angebote";
    const tooltip = `${range}: ${bucket.count} ${bucket.count === 1 ? "Angebot" : "Angebote"}${bucket.count ? ` (${exact})` : ""}`;
    return `<div class="bar-col" tabindex="0" title="${esc(tooltip)}" aria-label="${esc(tooltip)}"><span>${bucket.count || ""}</span><div class="bar" style="height:${Math.max(8, bucket.count / highest * 100)}%"></div><small>${range}</small></div>`;
  }).join("")}</div><div class="chart-summary"><span>Spanne <strong>${money(Math.min(...rows.map((r) => r.price)))}–${money(Math.max(...rows.map((r) => r.price)))}</strong></span><span>Ø <strong>${money(rows.reduce((sum, row) => sum + row.price, 0) / rows.length)}</strong></span></div>`;
}

function renderActivity() {
  const events = state.events.filter((event) => event.profileId === selectedProfileId && event.type !== "new").slice(0, 6);
  const icons = { price: "€", condition: "◇", description: "≡", status: "↔", missing: "×" };
  els.activity.innerHTML = events.length ? events.map((event) => `<button class="activity-item" type="button" ${event.listingExternalId ? `data-activity-listing="${esc(event.listingExternalId)}"` : ""}><span class="event-icon ${esc(event.type)}">${icons[event.type] || "·"}</span><span><strong>${esc(event.text)}</strong><small>${relative(event.at)} · ${date(event.at, true)}</small></span><i aria-hidden="true">›</i></button>`).join("") : `<div class="activity-empty"><strong>Noch keine Änderungen</strong><span>Der erste Abruf legt nur den Ausgangsstand an.</span></div>`;
}

function renderTable() {
  const all = listings();
  const rows = applyListingView(all, {
    query: els.search.value,
    status: els.status.value,
    condition: els.condition.value,
    minPrice: els.minPrice.value,
    maxPrice: els.maxPrice.value,
    sort: els.sort.value
  });
  els.count.textContent = `${all.length}`;
  els.viewCount.textContent = `${rows.length} von ${all.length} Angeboten`;
  els.table.innerHTML = rows.map((row) => {
    const lastPriceChange = row.priceHistory?.at(-1);
    const delta = lastPriceChange?.from != null ? `<small class="price-delta">vorher ${money(lastPriceChange.from)}</small>` : "";
    return `<tr data-listing="${esc(row.id)}"><td data-label="Angebot"><div class="listing-cell">${listingThumb(row)}<div><strong>${esc(row.title)}</strong><small>${esc(row.seller)}</small></div></div></td><td data-label="Preis"><strong class="price">${money(row.price)}</strong>${delta}</td><td data-label="Zustand"><span class="condition">${esc(row.condition)}</span></td><td data-label="Status"><span class="status ${row.status}"><i></i>${statusLabel(row.status)}</span></td><td data-label="Online seit">${date(row.firstSeenAt)}</td><td data-label="Dauer"><strong>${duration(row)}</strong><small class="duration-sub">${row.status === "active" ? "laufend" : row.status === "checking" ? "Prüfung läuft" : row.status === "sold" ? "bis Verkauf" : "bis Wegfall"}</small></td><td><button class="row-action" aria-label="Details öffnen">›</button></td></tr>`;
  }).join("");
  els.empty.hidden = rows.length > 0;
  els.resetFilters.disabled = !hasActiveFilters();
}

function renderNoProfiles() {
  els.title.textContent = "Noch kein Tracker"; els.profiles.innerHTML = ""; els.metrics.innerHTML = ""; els.chart.innerHTML = ""; els.activity.innerHTML = ""; els.table.innerHTML = ""; els.empty.hidden = false;
}

function openProfile(profile = null) {
  if (staticMode) return openRepositoryFile("config/profiles.json");
  els.profileForm.reset();
  els.profileTitle.textContent = profile ? "Produkt anpassen" : "Neuen Tracker anlegen";
  els.deleteProfile.hidden = !profile;
  const values = profile || { conditions: ["Neu, mit Etikett", "Neu", "Sehr gut", "Gut", "Zufriedenstellend"], refreshMinutes: 60, checkingThreshold: 3, missingThreshold: 2, collectorEnabled: true, scrapeDetails: true, maxResults: 300, detailDelayMs: 3000 };
  for (const [key, value] of Object.entries(values)) {
    const field = els.profileForm.elements[key];
    if (!field) continue;
    if (key === "conditions") [...els.profileForm.querySelectorAll('[name="conditions"]')].forEach((box) => box.checked = value.includes(box.value));
    else if (["collectorEnabled", "scrapeDetails"].includes(key)) field.checked = Boolean(value);
    else if (key === "includeTerms" || key === "excludeTerms") field.value = value.join(", ");
    else field.value = value ?? "";
  }
  els.profileDialog.showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  if (staticMode) return openRepositoryFile("config/profiles.json");
  const data = Object.fromEntries(new FormData(els.profileForm));
  data.conditions = [...els.profileForm.querySelectorAll('[name="conditions"]:checked')].map((el) => el.value);
  data.collectorEnabled = els.profileForm.elements.collectorEnabled.checked;
  data.scrapeDetails = els.profileForm.elements.scrapeDetails.checked;
  data.includeTerms = data.includeTerms.split(",").map((v) => v.trim()).filter(Boolean);
  data.excludeTerms = data.excludeTerms.split(",").map((v) => v.trim()).filter(Boolean);
  const id = data.id; delete data.id;
  const response = await apiFetch(id ? `/api/profiles/${id}` : "/api/profiles", { method: id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const payload = await response.json(); if (!response.ok) return toast(payload.error, true);
  selectedProfileId = payload.id; els.profileDialog.close(); await refresh(); toast("Tracker gespeichert");
}

async function importSnapshot(event) {
  event.preventDefault();
  if (staticMode) return openRepositoryFile("config/profiles.json");
  try {
    const items = JSON.parse(new FormData(els.importForm).get("snapshot"));
    const response = await apiFetch(`/api/profiles/${selectedProfileId}/snapshot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error);
    els.importDialog.close(); els.importForm.reset(); await refresh(); toast(`${payload.matched} Angebote abgeglichen · ${payload.added} neu`);
  } catch (error) { toast(error.message || "JSON konnte nicht importiert werden", true); }
}

async function syncNow() {
  if (staticMode) return openRepositoryActions();
  const button = $("#sync-now"); button.disabled = true; button.classList.add("loading");
  try {
    const profile = selectedProfile();
    if (profile.collectorEnabled) {
      const response = await apiFetch(`/api/profiles/${selectedProfileId}/collect`, { method: "POST" }); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      await pollCollector();
    } else {
      const response = await apiFetch(`/api/profiles/${selectedProfileId}/sync`, { method: "POST" }); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error); await refresh(); toast(`${payload.matched} Angebote abgeglichen`);
    }
  } catch (error) { toast(error.message, true); if (!selectedProfile().feedUrl && !selectedProfile().collectorEnabled) els.importDialog.showModal(); }
  finally { button.disabled = false; button.classList.remove("loading"); }
}

async function pollCollector() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await refresh();
    const job = state.collectorJobs?.[selectedProfileId];
    if (!job) { toast("Collector beendet"); return; }
    if (job.status === "failed") throw new Error(job.error || "Collector fehlgeschlagen");
    if (job.status === "complete") { toast(`${job.result?.matched || 0} Angebote aktualisiert`); return; }
  }
}

function openDetails(id) {
  const row = state.listings.find((item) => item.id === id); if (!row) return;
  const changes = [
    ...(row.priceHistory || []).map((point) => ({ at: point.at, type: "Preis", value: `${money(point.from)} → ${money(point.to ?? point.price)}` })),
    ...(row.conditionHistory || []).map((point) => ({ at: point.at, type: "Zustand", value: `${point.from || "–"} → ${point.to ?? point.condition}` })),
    ...(row.descriptionHistory || []).map((point) => ({ at: point.at, type: "Beschreibung", value: "Vorher/Nachher anzeigen", before: point.from || "", after: point.to ?? point.description ?? "" })),
    ...(row.statusHistory || []).map((point) => ({ at: point.at, type: "Status", value: `${statusLabel(point.from)} → ${statusLabel(point.to ?? point.status)}` }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30);
  const descriptions = uniqueDescriptions(row.descriptionVersions || []).reverse();
  els.drawerContent.innerHTML = `<div class="drawer-head"><span>ANGEBOTSDETAILS</span><button class="icon-button" id="close-drawer" aria-label="Details schließen">×</button></div><div class="drawer-product">${listingThumb(row, true)}<div><span class="status ${row.status}"><i></i>${statusLabel(row.status)}</span><h2>${esc(row.title)}</h2><p>${esc(row.seller)}</p></div></div><div class="drawer-price"><span>Aktueller Preis</span><strong>${money(row.price)}</strong></div><div class="description-card"><span>AKTUELLE BESCHREIBUNG</span><p>${esc(row.description || "Keine Beschreibung erfasst.")}</p></div><dl><div><dt>Zustand</dt><dd>${esc(row.condition)}</dd></div><div><dt>Erstmals gesehen</dt><dd>${date(row.firstSeenAt, true)}</dd></div><div><dt>Zuletzt gesehen</dt><dd>${date(row.lastSeenAt, true)}</dd></div><div><dt>Online-Dauer</dt><dd>${duration(row)}</dd></div><div><dt>Gespeicherte Zustände</dt><dd>${row.snapshots?.length || 1}</dd></div></dl><div class="history"><span>ÄNDERUNGSVERLAUF</span>${changes.map(historyEntry).join("") || "<p class=archive-empty>Noch keine Änderungen seit der ersten Erfassung.</p>"}</div><div class="description-archive"><span>EINMALIG GESPEICHERTE BESCHREIBUNGEN</span>${descriptions.map((point) => `<details><summary><span>${date(point.at, true)}</span><strong>Version ansehen</strong></summary><p>${esc(point.description)}</p></details>`).join("") || "<p class=archive-empty>Noch keine Beschreibung erfasst.</p>"}</div>${row.url ? `<a class="button primary full" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">Auf Vinted öffnen ↗</a>` : `<button class="button secondary full" disabled>Demo ohne Listing-Link</button>`}`;
  els.drawer.setAttribute("aria-hidden", "false");
}

function toast(message, error = false) { els.toast.textContent = message; els.toast.className = `toast show ${error ? "error" : ""}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => els.toast.classList.remove("show"), 3600); }
async function apiFetch(input, options = {}) {
  const execute = () => {
    const headers = new Headers(options.headers || {});
    if (adminToken) headers.set("authorization", `Bearer ${adminToken}`);
    return fetch(input, { ...options, headers });
  };
  let response = await execute();
  if (response.status === 401 && !staticMode) {
    const entered = window.prompt("Admin-Token für diese Sitzung eingeben:", "")?.trim();
    if (!entered) return response;
    adminToken = entered;
    sessionStorage.setItem("tracker-admin-token", adminToken);
    response = await execute();
  }
  return response;
}
function repositoryUrl() { return state?.deployment?.repositoryUrl || ""; }
function openRepositoryActions() {
  const url = repositoryUrl();
  if (!url) return toast("Repository-Link fehlt", true);
  window.open(`${url}/actions/workflows/daily-track.yml`, "_blank", "noopener,noreferrer");
}
function openRepositoryFile(path) {
  const url = repositoryUrl();
  if (!url) return toast("Repository-Link fehlt", true);
  window.open(`${url}/edit/main/${path}`, "_blank", "noopener,noreferrer");
}
function selectedProfile() { return state?.profiles.find((p) => p.id === selectedProfileId); }
function listings() { return (state?.listings || []).filter((row) => row.profileId === selectedProfileId); }
function listingThumb(row, large = false) { const className = large ? "listing-image large" : "listing-image"; return row.imageUrl ? `<span class="${className}"><img src="${esc(row.imageUrl)}" alt="" loading="lazy" /></span>` : `<span class="${className} fallback" aria-hidden="true"><i></i></span>`; }
function uniqueDescriptions(points) { const seen = new Set(); return points.filter((point) => { const value = String(point.description || "").replace(/\s+/g, " ").trim(); if (seen.has(value)) return false; seen.add(value); return true; }); }
function hasActiveFilters() { return Boolean(els.search.value || els.status.value !== "all" || els.condition.value !== "all" || els.minPrice.value || els.maxPrice.value || els.sort.value !== "newest"); }
function resetFilters() { els.search.value = ""; els.status.value = "all"; els.condition.value = "all"; els.minPrice.value = ""; els.maxPrice.value = ""; els.sort.value = "newest"; renderTable(); }
function historyEntry(point) {
  if (point.type === "Beschreibung") return `<details class="history-description"><summary><i class="history-dot"></i><span>${date(point.at, true)}</span><strong>Beschreibung</strong><small>${esc(point.value)}</small></summary><div class="description-diff"><section><span>VORHER</span><p>${esc(point.before || "Keine Beschreibung")}</p></section><section><span>NACHHER</span><p>${esc(point.after || "Keine Beschreibung")}</p></section></div></details>`;
  return `<div><i class="history-dot"></i><span>${date(point.at, true)}</span><strong>${esc(point.type)}</strong><small>${esc(point.value)}</small></div>`;
}
function money(value, digits = 2) { return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); }
function number(value) { return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value); }
function date(value, withTime = false) { if (!value) return "–"; return new Intl.DateTimeFormat("de-DE", withTime ? { dateStyle: "medium", timeStyle: "short" } : { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)); }
function relative(value) { if (!value) return ""; const minutes = Math.max(0, Math.round((Date.now() - new Date(value)) / 60000)); if (minutes < 1) return "gerade eben"; if (minutes < 60) return `vor ${minutes} Min.`; const hours = Math.round(minutes / 60); if (hours < 24) return `vor ${hours} Std.`; return `vor ${Math.round(hours / 24)} T.`; }
function duration(row) { const end = row.soldAt || row.disappearedAt || new Date(); const days = Math.max(0, (new Date(end) - new Date(row.firstSeenAt)) / 86400000); return days < 1 ? `${Math.max(1, Math.round(days * 24))} Std.` : `${days.toFixed(days < 10 ? 1 : 0)} T.`; }
function statusLabel(status) { return ({ active: "Online", checking: "Wird geprüft", sold: "Verkauft", missing: "Nicht mehr online", removed: "Entfernt" })[status] || status; }
function initials(name) { return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(); }
function minutes(value) { return value >= 1440 ? "Tag" : value >= 60 ? `${value / 60} Std.` : `${value} Min.`; }
function esc(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function metricIcon(type) { return ({ signal: "◉", price: "€", time: "◷", sold: "✓" })[type]; }

els.profiles.addEventListener("click", (event) => { const button = event.target.closest("[data-profile]"); if (!button) return; selectedProfileId = button.dataset.profile; render(); });
els.profiles.addEventListener("dblclick", (event) => { const button = event.target.closest("[data-profile]"); if (button) openProfile(state.profiles.find((p) => p.id === button.dataset.profile)); });
$("#add-profile").addEventListener("click", () => openProfile());
els.title.addEventListener("click", () => openProfile(selectedProfile()));
$("#import-snapshot").addEventListener("click", () => staticMode ? openRepositoryFile("config/profiles.json") : els.importDialog.showModal());
$("#sync-now").addEventListener("click", syncNow);
[els.search, els.minPrice, els.maxPrice].forEach((input) => input.addEventListener("input", renderTable));
[els.status, els.condition, els.sort].forEach((select) => select.addEventListener("change", renderTable));
els.resetFilters.addEventListener("click", resetFilters);
els.profileForm.addEventListener("submit", saveProfile); els.importForm.addEventListener("submit", importSnapshot);
els.deleteProfile.addEventListener("click", async () => { const id = els.profileForm.elements.id.value; if (!id || !confirm("Tracker inklusive Verlauf wirklich löschen?")) return; await apiFetch(`/api/profiles/${id}`, { method: "DELETE" }); els.profileDialog.close(); await refresh(); });
els.table.addEventListener("click", (event) => { const row = event.target.closest("[data-listing]"); if (row) openDetails(row.dataset.listing); });
els.activity.addEventListener("click", (event) => { const item = event.target.closest("[data-activity-listing]"); if (!item) return; const row = state.listings.find((listing) => listing.externalId === item.dataset.activityListing && listing.profileId === selectedProfileId); if (row) openDetails(row.id); });
els.drawer.addEventListener("click", (event) => { if (event.target.closest("#close-drawer")) els.drawer.setAttribute("aria-hidden", "true"); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") els.drawer.setAttribute("aria-hidden", "true"); });

if (staticMode) {
  $("#sync-now").innerHTML = '<span aria-hidden="true">▶</span> Lauf starten';
  $("#import-snapshot").innerHTML = '<span aria-hidden="true">⚙</span> Konfiguration';
  $("#add-profile").title = "Konfiguration auf GitHub bearbeiten";
  document.querySelector(".sidebar-footer").textContent = "GitHub Pages · stündlich aktualisiert";
}
