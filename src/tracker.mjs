import { randomUUID } from "node:crypto";

export const CONDITIONS = ["Neu", "Sehr gut", "Gut", "Zufriedenstellend", "Unbekannt"];

export function blankStore() {
  return { version: 1, profiles: [], listings: [], events: [], updatedAt: new Date().toISOString() };
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
    refreshMinutes: clamp(Number(input.refreshMinutes) || 1440, 15, 1440),
    feedUrl: clean(input.feedUrl),
    collectorEnabled: input.collectorEnabled === true || input.collectorEnabled === "true" || input.collectorEnabled === "on",
    scrapeDetails: input.scrapeDetails !== false && input.scrapeDetails !== "false",
    maxResults: clamp(Number(input.maxResults) || 300, 1, 1000),
    detailDelayMs: clamp(Number(input.detailDelayMs) || 3000, 2000, 30000),
    active: input.active !== false,
    createdAt: input.createdAt || now,
    updatedAt: now,
    lastSyncAt: input.lastSyncAt || null,
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
    description: clean(raw.description),
    url: safeUrl(raw.url),
    imageUrl: safeUrl(raw.imageUrl || raw.photo),
    price,
    currency: clean(raw.currency || raw.price?.currency) || "EUR",
    condition: normalizeCondition(raw.condition),
    seller: clean(raw.seller || raw.user?.login) || "Unbekannt",
    location: clean(raw.location) || "Deutschland",
    status,
    sourceCreatedAt: validDate(raw.createdAt || raw.publishedAt || raw.sourceCreatedAt),
    observedAt: validDate(raw.observedAt) || now
  };
}

export function reconcileSnapshot(store, profileId, rawItems, now = new Date().toISOString()) {
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
      store.listings.push({
        ...item,
        id: randomUUID(),
        firstSeenAt,
        lastSeenAt: now,
        disappearedAt: item.status === "active" ? null : now,
        soldAt: item.status === "sold" ? now : null,
        missingChecks: 0,
        observations: 1,
        priceHistory: [{ price: item.price, at: now }],
        conditionHistory: [{ condition: item.condition, at: now }],
        descriptionHistory: [{ description: item.description, at: now }],
        statusHistory: [{ status: item.status, at: now }],
        snapshots: [snapshotOf(item, now)]
      });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "new", at: now, text: `${item.title} neu für ${formatPrice(item.price, item.currency)}` });
      added++;
      continue;
    }

    const oldPrice = existing.price;
    const oldStatus = existing.status;
    const oldCondition = existing.condition;
    const oldDescription = existing.description || "";
    Object.assign(existing, item, { lastSeenAt: now, missingChecks: 0, observations: (existing.observations || 0) + 1 });
    existing.priceHistory ||= [{ price: oldPrice, at: existing.firstSeenAt }];
    existing.conditionHistory ||= [{ condition: oldCondition, at: existing.firstSeenAt }];
    existing.descriptionHistory ||= [{ description: oldDescription, at: existing.firstSeenAt }];
    existing.statusHistory ||= [{ status: oldStatus, at: existing.firstSeenAt }];
    existing.snapshots ||= [];
    if (item.status === "active") {
      existing.disappearedAt = null;
      existing.soldAt = null;
    } else {
      existing.disappearedAt ||= now;
      if (item.status === "sold") existing.soldAt ||= now;
    }
    if (oldPrice !== item.price) {
      existing.priceHistory.push({ price: item.price, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "price", at: now, text: `${item.title}: ${formatPrice(oldPrice, item.currency)} → ${formatPrice(item.price, item.currency)}` });
      changed++;
    }
    if (oldCondition !== item.condition) {
      existing.conditionHistory.push({ condition: item.condition, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "condition", at: now, text: `${item.title}: Zustand ${oldCondition} → ${item.condition}` });
      changed++;
    }
    if (oldDescription !== item.description) {
      existing.descriptionHistory.push({ description: item.description, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "description", at: now, text: `${item.title}: Beschreibung geändert` });
      changed++;
    }
    if (oldStatus !== existing.status) {
      existing.statusHistory.push({ status: existing.status, at: now });
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "status", at: now, text: `${item.title}: Status auf ${statusLabel(existing.status)}` });
      changed++;
    }
    existing.snapshots.push(snapshotOf(existing, now));
    existing.snapshots = existing.snapshots.slice(-2000);
  }

  for (const item of store.listings.filter((entry) => entry.profileId === profileId && !seen.has(entry.externalId) && ["active", "checking"].includes(entry.status))) {
    const oldStatus = item.status;
    item.missingChecks = (item.missingChecks || 0) + 1;
    if (item.missingChecks >= profile.missingThreshold) {
      item.status = "missing";
      item.disappearedAt ||= now;
      store.events.unshift({ id: randomUUID(), profileId, listingExternalId: item.externalId, type: "missing", at: now, text: `${item.title} ist nicht mehr online` });
      gone++;
    } else {
      item.status = "checking";
    }
    item.statusHistory ||= [{ status: oldStatus, at: item.firstSeenAt }];
    if (oldStatus !== item.status) item.statusHistory.push({ status: item.status, at: now });
    item.snapshots ||= [];
    item.snapshots.push(snapshotOf(item, now));
    item.snapshots = item.snapshots.slice(-2000);
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
  const active = rows.filter((entry) => ["active", "checking"].includes(entry.status));
  const prices = active.map((entry) => entry.price);
  const completed = rows.filter((entry) => entry.soldAt || entry.disappearedAt);
  const durations = completed.map((entry) => durationDays(entry.firstSeenAt, entry.soldAt || entry.disappearedAt)).filter(Number.isFinite);
  return {
    total: rows.length,
    active: active.length,
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
