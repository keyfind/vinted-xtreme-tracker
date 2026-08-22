import { randomUUID } from "node:crypto";

export const CONDITIONS = ["Neu", "Sehr gut", "Gut", "Zufriedenstellend", "Unbekannt"];

export function blankStore() {
  return { version: 2, profiles: [], listings: [], events: [], updatedAt: new Date().toISOString() };
}

export function makeProfile(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || randomUUID(),
    name: clean(input.name) || "Neuer Tracker",
    query: clean(input.query) || "JBL Xtreme 4",
    includeTerms: list(input.includeTerms),
    excludeTerms: list(input.excludeTerms),
    minPrice: numberOrNull(input.minPrice),
    maxPrice: numberOrNull(input.maxPrice),
    conditions: Array.isArray(input.conditions) && input.conditions.length ? input.conditions : CONDITIONS.slice(0, 4),
    missingThreshold: clamp(Number(input.missingThreshold) || 3, 1, 12),
    refreshMinutes: clamp(Number(input.refreshMinutes) || 60, 15, 1440),
    feedUrl: clean(input.feedUrl),
    collectorEnabled: input.collectorEnabled === true || input.collectorEnabled === "true" || input.collectorEnabled === "on",
    scrapeDetails: input.scrapeDetails !== false && input.scrapeDetails !== "false",
    maxResults: clamp(Number(input.maxResults) || 300, 1, 1000),
    detailDelayMs: clamp(Number(input.detailDelayMs) || 3000, 2000, 30000),
    active: input.active !== false,
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastSyncAt: input.lastSyncAt || null,
    lastDetailSyncAt: input.lastDetailSyncAt || null,
    lastSyncStatus: input.lastSyncStatus || "Noch nicht synchronisiert"
  };
}

export function updateProfile(existing, patch = {}) {
  const merged = makeProfile({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt });
  merged.lastSyncAt = existing.lastSyncAt;
  merged.lastSyncStatus = existing.lastSyncStatus;
  return merged;
}

export function normalizeItem(raw, profileId, now) {
  const id = clean(raw.id || raw.itemId || raw.externalId);
  if (!id) throw new Error("Jeder Eintrag braucht eine id, itemId oder externalId.");
  const price = Number(raw.price?.amount ?? raw.price);
  if (!Number.isFinite(price) || price < 0) throw new Error(`Ungültiger Preis für ${id}.`);
  const explicit = String(raw.status || "active").toLowerCase();
  const status = explicit === "sold" || explicit === "verkauft" ? "sold" : explicit === "removed" ? "removed" : "active";
  return {
    externalId: id,
    profileId,
    title: clean(raw.title) || "Ohne Titel",
    description: normalizeDescription(raw.description),
    url: safeUrl(raw.url),
    imageUrl: safeUrl(raw.imageUrl || raw.photo),
    price,
    currency: clean(raw.currency || raw.price?.currency) || "EUR",
    condition: normalizeCondition(raw.condition),
    seller: clean(raw.seller || raw.user?.login) || "Unbekannt",
    status,
    detailsComplete: raw.detailsComplete !== false,
    sourceCreatedAt: validDate(raw.createdAt || raw.publishedAt || raw.sourceCreatedAt),
    observedAt: validDate(raw.observedAt) || now
  };
}

export function migrateStore(store) {
  if (!store || typeof store !== "object") return blankStore();
  store.profiles ||= [];
  store.listings ||= [];
  store.events ||= [];

  if (Number(store.version || 1) < 2) {
    for (const listing of store.listings) {
      delete listing.location;
      listing.description = normalizeDescription(listing.description);
      if (listing.status === "removed" && !listing.soldAt) {
        listing.status = "missing";
        listing.disappearedAt ||= listing.lastSeenAt || store.updatedAt || new Date().toISOString();
        listing.missingChecks = Math.max(Number(listing.missingChecks) || 0, 3);
      }
      listing.priceHistory = [];
      listing.conditionHistory = [];
      listing.descriptionHistory = [];
      listing.statusHistory = [];
      listing.snapshots = [snapshotOf(listing, listing.lastSeenAt || store.updatedAt || new Date().toISOString())];
      listing.detailsFetchedAt ||= listing.description || listing.seller !== "Unbekannt" ? listing.lastSeenAt || null : null;
    }
    store.events = [];
    store.version = 2;
  } else {
    for (const listing of store.listings) {
      delete listing.location;
      listing.description = normalizeDescription(listing.description);
      listing.priceHistory ||= [];
      listing.conditionHistory ||= [];
      listing.descriptionHistory = uniqueDescriptionHistory(listing.descriptionHistory || []);
      listing.statusHistory ||= [];
      listing.snapshots ||= [snapshotOf(listing, listing.lastSeenAt || store.updatedAt || new Date().toISOString())];
      listing.detailsFetchedAt ||= listing.description || listing.seller !== "Unbekannt" ? listing.lastSeenAt || null : null;
    }
    store.events = store.events.filter((event) => event.type !== "new");
  }
  return store;
}

export function reconcileSnapshot(store, profileId, rawItems, now = new Date().toISOString(), options = {}) {
  const profile = store.profiles.find((entry) => entry.id === profileId);
  if (!profile) throw new Error("Tracker-Profil nicht gefunden.");
  if (!Array.isArray(rawItems)) throw new Error("Snapshot muss ein Array von Angeboten enthalten.");

  const normalized = rawItems.map((item) => normalizeItem(item, profileId, now)).filter((item) => matchesProfile(item, profile));
  const seen = new Set(normalized.map((item) => item.externalId));
  let added = 0;
  let changed = 0;
  let gone = 0;

  for (const item of normalized) {
    const existing = store.listings.find((entry) => entry.profileId === profileId && entry.externalId === item.externalId);
    if (!existing) {
      const firstSeenAt = item.sourceCreatedAt || item.observedAt || now;
      const { detailsComplete, ...listingItem } = item;
      store.listings.push({
        ...listingItem,
        id: randomUUID(),
        firstSeenAt,
        lastSeenAt: now,
        detailsFetchedAt: detailsComplete ? now : null,
        disappearedAt: item.status === "active" ? null : now,
        soldAt: item.status === "sold" ? now : null,
        missingChecks: 0,
        observations: 1,
        priceHistory: [],
        conditionHistory: [],
        descriptionHistory: [],
        statusHistory: [],
        snapshots: [snapshotOf(listingItem, now)]
      });
      added++;
      continue;
    }

    if (!item.detailsComplete) {
      item.description = existing.description || "";
      item.seller = existing.seller || "Unbekannt";
      item.sourceCreatedAt ||= existing.sourceCreatedAt || null;
      if (item.condition === "Unbekannt") item.condition = existing.condition;
      if (["missing", "removed", "sold"].includes(existing.status)) item.status = existing.status;
    }
    const oldPrice = existing.price;
    const oldStatus = existing.status;
    const oldCondition = existing.condition;
    const oldDescription = existing.description || "";
    const completesInitialDetails = item.detailsComplete && !existing.detailsFetchedAt;
    const { detailsComplete, ...listingItem } = item;
    const knownDescriptions = new Set([
      oldDescription,
      ...(existing.descriptionHistory || []).map((point) => point.description),
      ...(existing.snapshots || []).map((snapshot) => snapshot.description)
    ].map(normalizeDescription));
    Object.assign(existing, listingItem, { lastSeenAt: now, missingChecks: 0, observations: (existing.observations || 0) + 1 });
    if (detailsComplete) existing.detailsFetchedAt ||= now;
    existing.priceHistory ||= [];
    existing.conditionHistory ||= [];
    existing.descriptionHistory ||= [];
    existing.statusHistory ||= [];
    existing.snapshots ||= [];
    if (item.status === "active") {
      existing.disappearedAt = null;
      existing.soldAt = null;
    } else {
      existing.disappearedAt ||= now;
      if (item.status === "sold") existing.soldAt ||= now;
    }
    if (oldPrice !== item.price) {
      existing.priceHistory.push({ from: oldPrice, to: item.price, price: item.price, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "price", at: now, text: `${item.title}: ${formatPrice(oldPrice, item.currency)} → ${formatPrice(item.price, item.currency)}` });
      changed++;
    }
    let materialChange = false;
    if (oldCondition !== item.condition && !completesInitialDetails) {
      existing.conditionHistory.push({ from: oldCondition, to: item.condition, condition: item.condition, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "condition", at: now, text: `${item.title}: Zustand ${oldCondition} → ${item.condition}` });
      changed++;
      materialChange = true;
    }
    if (oldDescription !== item.description && !completesInitialDetails) {
      if (!knownDescriptions.has(item.description)) existing.descriptionHistory.push({ description: item.description, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "description", at: now, text: `${item.title}: Beschreibung geändert` });
      changed++;
      materialChange = true;
    }
    if (isConfirmedStatusTransition(oldStatus, existing.status)) {
      const from = oldStatus === "checking" ? lastConfirmedStatus(existing) : oldStatus;
      existing.statusHistory.push({ from, to: existing.status, status: existing.status, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "status", at: now, text: `${item.title}: ${statusLabel(from)} → ${statusLabel(existing.status)}` });
      changed++;
      materialChange = true;
    }
    if (oldPrice !== item.price) materialChange = true;
    if (completesInitialDetails && !materialChange) enrichBaselineSnapshot(existing);
    else pushSnapshotIfChanged(existing, now);
  }

  for (const item of store.listings.filter((entry) => entry.profileId === profileId && !seen.has(entry.externalId) && ["active", "checking"].includes(entry.status))) {
    const oldStatus = item.status;
    item.missingChecks = (item.missingChecks || 0) + 1;
    if (options.confirmMissing !== false && item.missingChecks >= profile.missingThreshold) {
      item.status = "missing";
      item.disappearedAt ||= now;
      item.statusHistory ||= [];
      const from = lastConfirmedStatus(item);
      item.statusHistory.push({ from, to: "missing", status: "missing", at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "missing", at: now, text: `${item.title} ist nicht mehr online` });
      pushSnapshotIfChanged(item, now);
      gone++;
    } else {
      item.status = "checking";
    }
  }

  profile.lastSyncAt = now;
  profile.lastSyncStatus = `${normalized.length} passend · ${added} neu · ${changed} geändert`;
  profile.updatedAt = now;
  store.updatedAt = now;
  store.events = store.events.slice(0, 500);
  return { received: rawItems.length, matched: normalized.length, added, changed, gone };
}

export function metrics(store, profileId) {
  const rows = store.listings.filter((entry) => entry.profileId === profileId);
  const active = rows.filter((entry) => entry.status === "active");
  const prices = active.map((entry) => entry.price);
  const completed = rows.filter((entry) => entry.soldAt || entry.disappearedAt);
  const durations = completed.map((entry) => durationDays(entry.firstSeenAt, entry.soldAt || entry.disappearedAt)).filter(Number.isFinite);
  return {
    total: rows.length,
    active: active.length,
    checking: rows.filter((entry) => entry.status === "checking").length,
    sold: rows.filter((entry) => entry.status === "sold").length,
    missing: rows.filter((entry) => entry.status === "missing").length,
    medianPrice: median(prices),
    avgOnlineDays: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
  };
}

export function matchesProfile(item, profile) {
  const haystack = `${item.title} ${item.condition}`.toLowerCase();
  const queryTokens = profile.query.toLowerCase().split(/\s+/).filter(Boolean);
  const required = list(profile.includeTerms).map((term) => term.toLowerCase());
  const excluded = list(profile.excludeTerms).map((term) => term.toLowerCase());
  if (queryTokens.length && !queryTokens.every((token) => haystack.includes(token))) return false;
  if (required.length && !required.every((term) => haystack.includes(term))) return false;
  if (excluded.some((term) => haystack.includes(term))) return false;
  if (profile.minPrice !== null && item.price < profile.minPrice) return false;
  if (profile.maxPrice !== null && item.price > profile.maxPrice) return false;
  if (profile.conditions?.length && !profile.conditions.includes(item.condition)) return false;
  return true;
}

export function durationDays(from, to = new Date().toISOString()) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms >= 0 ? ms / 86400000 : 0;
}

function clean(value) { return typeof value === "string" ? value.trim() : ""; }
export function normalizeDescription(value) {
  let text = clean(value).replaceAll("\u00a0", " ").replace(/\r\n?/g, "\n");
  const upload = text.match(/(?:^|\n)Hochgeladen\s*\n[^\n]*\n/i);
  if (upload && /Inklusive\s+Vinted-Käuferschutz/i.test(text.slice(0, upload.index + upload[0].length))) {
    text = text.slice(upload.index + upload[0].length);
  }
  return text
    .replace(/(?:\n|^)\s*(?:\.\.\.|…)?\s*mehr\s*$/i, "")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function list(value) { return Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value).split(",").map((v) => v.trim()).filter(Boolean); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function numberOrNull(value) { if (value === "" || value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function validDate(value) { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function safeUrl(value) { const text = clean(value); if (!text) return ""; try { const url = new URL(text); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; } catch { return ""; } }
function normalizeCondition(value) { const text = clean(value).toLowerCase(); if (/neu|new/.test(text)) return "Neu"; if (/sehr|very/.test(text)) return "Sehr gut"; if (/zufrieden|satisfactory/.test(text)) return "Zufriedenstellend"; if (/gut|good/.test(text)) return "Gut"; return "Unbekannt"; }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
function formatPrice(value, currency) { return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(value); }
function statusLabel(status) { return ({ active: "Online", checking: "Wird geprüft", sold: "Verkauft", removed: "Entfernt", missing: "Nicht mehr online" })[status] || status; }
function snapshotOf(item, at) { return { at, price: item.price, condition: item.condition, description: item.description || "", status: item.status }; }
function sameSnapshot(left, right) { return left && left.price === right.price && left.condition === right.condition && normalizeDescription(left.description) === normalizeDescription(right.description) && left.status === right.status; }
function pushSnapshotIfChanged(item, at) {
  item.snapshots ||= [];
  const next = snapshotOf(item, at);
  if (!sameSnapshot(item.snapshots.at(-1), next)) item.snapshots.push(next);
  item.snapshots = item.snapshots.slice(-2000);
}
function enrichBaselineSnapshot(item) {
  item.snapshots ||= [];
  if (!item.snapshots.length) return item.snapshots.push(snapshotOf(item, item.firstSeenAt || item.lastSeenAt));
  const at = item.snapshots.at(-1).at;
  item.snapshots[item.snapshots.length - 1] = snapshotOf(item, at);
}
function isConfirmedStatusTransition(from, to) { return from !== to && to !== "checking" && !(from === "checking" && to === "active"); }
function lastConfirmedStatus(item) {
  const point = item.statusHistory?.at(-1);
  return point?.to || point?.status || "active";
}
function uniqueDescriptionHistory(points) {
  const seen = new Set();
  return points.filter((point) => {
    point.description = normalizeDescription(point.description);
    if (seen.has(point.description)) return false;
    seen.add(point.description);
    return true;
  });
}
