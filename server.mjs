import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { blankStore, makeProfile, metrics, reconcileSnapshot, updateProfile } from "./src/tracker.mjs";
import { assertSecureBind, isAuthorizedMutation, requireAllowedFeedUrl } from "./src/security.mjs";
import { collectVinted } from "./src/vinted-browser.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(root, "public");
const dataFile = process.env.TRACKER_DATA_FILE || join(root, "data", "store.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const adminToken = String(process.env.TRACKER_ADMIN_TOKEN || "").trim();
assertSecureBind(host, adminToken);
let store = await loadStore();
const collectorJobs = new Map();

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await api(request, response, url);
    return await staticFile(response, url.pathname);
  } catch (error) {
    json(response, 500, { error: error.message || "Interner Fehler" });
  }
});

server.listen(port, host, () => console.log(`Xtreme Tracker läuft auf http://${host}:${port}`));

setInterval(async () => {
  for (const profile of store.profiles.filter((entry) => entry.active && (entry.feedUrl || (entry.collectorEnabled && process.env.ENABLE_SCHEDULED_SCRAPING === "true")))) {
    const due = !profile.lastSyncAt || Date.now() - new Date(profile.lastSyncAt).getTime() >= profile.refreshMinutes * 60000;
    if (due && !collectorJobs.has(profile.id)) {
      if (profile.collectorEnabled && process.env.ENABLE_SCHEDULED_SCRAPING === "true") startCollector(profile);
      else await syncProfile(profile).catch((error) => { profile.lastSyncStatus = `Fehler: ${error.message}`; });
    }
  }
}, 60000).unref();

async function api(request, response, url) {
  if (request.method !== "GET" && !isAuthorizedMutation(request, adminToken)) {
    response.setHeader("www-authenticate", 'Bearer realm="Xtreme Tracker"');
    return json(response, 401, { error: "Admin-Token fehlt oder ist ungültig." });
  }
  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(response, 200, { ...store, metrics: Object.fromEntries(store.profiles.map((profile) => [profile.id, metrics(store, profile.id)])), collectorJobs: Object.fromEntries(collectorJobs), serverTime: new Date().toISOString() });
  }
  if (request.method === "GET" && url.pathname === "/api/export.csv") return csvExport(response, url.searchParams.get("profileId"));
  if (request.method === "POST" && url.pathname === "/api/profiles") {
    const profile = makeProfile(await body(request));
    store.profiles.push(profile); await saveStore();
    return json(response, 201, profile);
  }
  const profileMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch && request.method === "PATCH") {
    const index = store.profiles.findIndex((entry) => entry.id === profileMatch[1]);
    if (index < 0) return json(response, 404, { error: "Tracker nicht gefunden" });
    store.profiles[index] = updateProfile(store.profiles[index], await body(request)); await saveStore();
    return json(response, 200, store.profiles[index]);
  }
  if (profileMatch && request.method === "DELETE") {
    store.profiles = store.profiles.filter((entry) => entry.id !== profileMatch[1]);
    store.listings = store.listings.filter((entry) => entry.profileId !== profileMatch[1]);
    store.events = store.events.filter((entry) => entry.profileId !== profileMatch[1]);
    await saveStore(); return json(response, 200, { ok: true });
  }
  const snapshotMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/snapshot$/);
  if (snapshotMatch && request.method === "POST") {
    const payload = await body(request);
    const result = reconcileSnapshot(store, snapshotMatch[1], Array.isArray(payload) ? payload : payload.items);
    await saveStore(); return json(response, 200, result);
  }
  const syncMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/sync$/);
  if (syncMatch && request.method === "POST") {
    const profile = store.profiles.find((entry) => entry.id === syncMatch[1]);
    if (!profile) return json(response, 404, { error: "Tracker nicht gefunden" });
    if (!profile.feedUrl) return json(response, 400, { error: "Noch keine autorisierte Feed-URL hinterlegt. Nutze den Snapshot-Import oder ergänze sie in den Einstellungen." });
    return json(response, 200, await syncProfile(profile));
  }
  const collectMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)\/collect$/);
  if (collectMatch && request.method === "POST") {
    const profile = store.profiles.find((entry) => entry.id === collectMatch[1]);
    if (!profile) return json(response, 404, { error: "Tracker nicht gefunden" });
    if (!profile.collectorEnabled) return json(response, 400, { error: "Aktiviere zuerst den Browser-Collector in den Tracker-Einstellungen." });
    if (collectorJobs.has(profile.id)) return json(response, 202, collectorJobs.get(profile.id));
    const job = startCollector(profile);
    return json(response, 202, job);
  }
  return json(response, 404, { error: "Nicht gefunden" });
}

function startCollector(profile) {
  const job = { profileId: profile.id, status: "running", phase: "starting", message: "Collector startet", current: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  collectorJobs.set(profile.id, job);
  collectVinted(profile, (progress) => Object.assign(job, progress), store.listings.filter((listing) => listing.profileId === profile.id))
    .then(async ({ items, advertisedTotal, visitedDetails }) => {
      const summary = reconcileSnapshot(store, profile.id, items);
      profile.lastSyncStatus = `${summary.matched} von ${advertisedTotal || summary.received} Treffern erfasst`;
      job.status = "complete"; job.phase = "complete"; job.finishedAt = new Date().toISOString();
      job.result = { ...summary, advertisedTotal, visitedDetails };
      await saveStore();
    })
    .catch(async (error) => {
      job.status = "failed"; job.phase = "failed"; job.error = error.message; job.message = error.message; job.finishedAt = new Date().toISOString();
      profile.lastSyncStatus = `Collector-Fehler: ${error.message}`;
      await saveStore().catch(() => {});
    })
    .finally(() => setTimeout(() => collectorJobs.delete(profile.id), 15 * 60 * 1000).unref());
  return job;
}

async function syncProfile(profile) {
  const feedUrl = requireAllowedFeedUrl(
    profile.feedUrl.replaceAll("{query}", encodeURIComponent(profile.query)),
    process.env.TRACKER_FEED_ALLOWLIST
  );
  const headers = { Accept: "application/json", "User-Agent": "XtremeTracker/1.0" };
  if (process.env.TRACKER_FEED_TOKEN) headers.Authorization = `Bearer ${process.env.TRACKER_FEED_TOKEN}`;
  const result = await fetch(feedUrl, { headers, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!result.ok) throw new Error(`Feed antwortet mit HTTP ${result.status}`);
  const payload = await result.json();
  const items = Array.isArray(payload) ? payload : payload.items || payload.results || payload.data?.items;
  const summary = reconcileSnapshot(store, profile.id, items);
  await saveStore();
  return summary;
}

async function staticFile(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const file = join(publicRoot, safe);
  if (!file.startsWith(publicRoot)) return text(response, 403, "Nicht erlaubt");
  try { const bytes = await readFile(file); response.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-cache" }); response.end(bytes); }
  catch { const html = await readFile(join(publicRoot, "index.html")); response.writeHead(200, { "content-type": mime[".html"] }); response.end(html); }
}

async function body(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 2_000_000) throw new Error("Anfrage ist zu groß."); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new Error("Ungültiges JSON."); }
}

async function loadStore() {
  try { return JSON.parse(await readFile(dataFile, "utf8")); }
  catch { const initial = blankStore(); initial.profiles.push(makeProfile({ id: "jbl-xtreme-4", name: "JBL Xtreme 4", query: "JBL Xtreme 4", excludeTerms: ["Hülle", "Case", "Ersatzteil"], minPrice: 40, maxPrice: 350, missingThreshold: 3, refreshMinutes: 1440, collectorEnabled: true, scrapeDetails: true, maxResults: 300, detailDelayMs: 3000 })); return initial; }
}
async function saveStore() { store.updatedAt = new Date().toISOString(); await mkdir(new URL("./data/", import.meta.url), { recursive: true }); await writeFile(dataFile, JSON.stringify(store, null, 2)); }

function json(response, status, payload) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(payload)); }
function text(response, status, payload) { response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); response.end(payload); }
function csvExport(response, profileId) {
  const rows = store.listings.filter((entry) => !profileId || entry.profileId === profileId);
  const columns = ["Titel", "Preis", "Währung", "Zustand", "Status", "Erstmals gesehen", "Zuletzt gesehen", "Verkauft am", "URL"];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [columns, ...rows.map((r) => [r.title, r.price, r.currency, r.condition, r.status, r.firstSeenAt, r.lastSeenAt, r.soldAt, r.url])].map((row) => row.map(escape).join(",")).join("\n");
  response.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=xtreme-tracker.csv" }); response.end(`\uFEFF${csv}`);
}
