import test from "node:test";
import assert from "node:assert/strict";
import { blankStore, makeProfile, metrics, migrateStore, normalizeDescription, reconcileSnapshot } from "./src/tracker.mjs";
import { assertSecureBind, isAuthorizedMutation, requireAllowedFeedUrl } from "./src/security.mjs";
import { deriveListingStatus, eligibleFollowUps, parseCard, parseResultCount, relativeUploadDate } from "./src/vinted-browser.mjs";
import { applyListingView } from "./public/listing-view.js";
import { resolveRunMode } from "./src/run-mode.mjs";
import { buildDiscordPayload, notifyDiscord, validateDiscordWebhookUrl } from "./src/discord-webhook.mjs";

function setup(threshold = 2) {
  const store = blankStore();
  store.profiles.push(makeProfile({ id: "speaker", name: "JBL Xtreme 4", query: "JBL Xtreme 4", excludeTerms: ["Hülle"], missingThreshold: threshold }));
  return store;
}

test("legt neue passende Angebote an und filtert Zubehör", () => {
  const store = setup();
  const result = reconcileSnapshot(store, "speaker", [
    { id: "1", title: "JBL Xtreme 4 schwarz", price: 199, condition: "Sehr gut" },
    { id: "2", title: "JBL Xtreme 4 Hülle", price: 19, condition: "Neu" }
  ], "2026-08-20T10:00:00.000Z");
  assert.equal(result.received, 2);
  assert.equal(result.matched, 1);
  assert.equal(store.listings.length, 1);
  assert.equal(store.listings[0].status, "active");
  assert.deepEqual(store.listings[0].priceHistory, []);
  assert.deepEqual(store.listings[0].conditionHistory, []);
  assert.deepEqual(store.listings[0].descriptionHistory, []);
  assert.deepEqual(store.listings[0].statusHistory, []);
  assert.deepEqual(store.events, []);
});

test("protokolliert Preisänderungen", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 220, condition: "Gut" }], "2026-08-20T10:00:00.000Z");
  const result = reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut" }], "2026-08-21T10:00:00.000Z");
  assert.equal(result.changed, 1);
  assert.deepEqual(store.listings[0].priceHistory.map(({ from, to }) => ({ from, to })), [{ from: 220, to: 199 }]);
});

test("markiert fehlende Angebote erst nach dem Schwellenwert", () => {
  const store = setup(2);
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut" }], "2026-08-20T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [], "2026-08-21T10:00:00.000Z");
  assert.equal(store.listings[0].status, "checking");
  assert.deepEqual(store.listings[0].statusHistory, []);
  assert.equal(store.events.length, 0);
  reconcileSnapshot(store, "speaker", [], "2026-08-22T10:00:00.000Z");
  assert.equal(store.listings[0].status, "missing");
  assert.deepEqual(store.listings[0].statusHistory.map(({ from, to }) => ({ from, to })), [{ from: "active", to: "missing" }]);
  assert.equal(metrics(store, "speaker").missing, 1);
});

test("übernimmt einen expliziten Verkaufsstatus", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut" }], "2026-08-21T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut", status: "sold" }], "2026-08-22T10:00:00.000Z");
  assert.equal(store.listings[0].status, "sold");
  assert.equal(store.listings[0].soldAt, "2026-08-22T10:00:00.000Z");
  assert.deepEqual(store.listings[0].statusHistory.map(({ from, to }) => ({ from, to })), [{ from: "active", to: "sold" }]);
});

test("liest öffentliche Vinted-Ergebniskarten", () => {
  const card = parseCard({
    rawUrl: "/items/9720121856-jbl-xtreme-4?referrer=catalog",
    label: "JBL Xtreme 4, Marke: JBL, Zustand: Sehr gut, 170.00 €, 179.20 €",
    imageUrl: "https://images.example/item.jpg"
  });
  assert.equal(card.id, "9720121856");
  assert.equal(card.title, "JBL Xtreme 4");
  assert.equal(card.price, 170);
  assert.equal(card.condition, "Sehr gut");
  assert.equal(card.url, "https://www.vinted.de/items/9720121856-jbl-xtreme-4");
});

test("liest Trefferzahl und relatives Upload-Datum", () => {
  assert.equal(parseResultCount("193 Ergebnisse."), 193);
  assert.equal(relativeUploadDate("2 Tagen", new Date("2026-08-22T10:00:00Z")), "2026-08-20T10:00:00.000Z");
});

test("wertet Entfernungs-Overlay auf kaufbaren Artikeln nicht als Status aus", () => {
  assert.equal(deriveListingStatus({ purchasable: true, removed: true }), "active");
  assert.equal(deriveListingStatus({ sold: true }), "sold");
  assert.equal(deriveListingStatus({ removed: true }), "removed");
});

test("archiviert nur echte Änderungen und keine identischen Beschreibungen", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 220, condition: "Sehr gut", description: "Kaum benutzt" }], "2026-08-20T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 220, condition: "Sehr gut", description: "Kaum benutzt\n... mehr" }], "2026-08-21T09:00:00.000Z");
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut", description: "Kleine Gebrauchsspuren" }], "2026-08-21T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 220, condition: "Sehr gut", description: "Kaum benutzt" }], "2026-08-22T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 220, condition: "Sehr gut", description: "Kaum benutzt\n… mehr" }], "2026-08-23T10:00:00.000Z");
  const item = store.listings[0];
  assert.equal(item.snapshots.length, 3);
  assert.deepEqual(item.snapshots.map((snapshot) => snapshot.price), [220, 199, 220]);
  assert.deepEqual(item.conditionHistory.map((point) => point.condition), ["Gut", "Sehr gut"]);
  assert.deepEqual(item.descriptionHistory.map(({ from, to }) => ({ from, to })), [
    { from: "Kaum benutzt", to: "Kleine Gebrauchsspuren" },
    { from: "Kleine Gebrauchsspuren", to: "Kaum benutzt" }
  ]);
  assert.deepEqual(item.descriptionVersions.map((point) => point.description), ["Kaum benutzt", "Kleine Gebrauchsspuren"]);
  assert.equal(store.events.filter((event) => event.type === "description").length, 2);
});

test("bereinigt alte Erstbeobachtungen, Scheinstatus und Standortdaten einmalig", () => {
  const store = {
    version: 1,
    updatedAt: "2026-08-21T20:16:00.000Z",
    profiles: [],
    events: [{ type: "new" }, { type: "status" }],
    listings: [{
      id: "internal", externalId: "1", profileId: "speaker", title: "JBL Xtreme 4", price: 199, condition: "Gut", description: "Text\n... mehr", seller: "a", location: "Deutschland", status: "removed", firstSeenAt: "2026-08-21T20:00:00.000Z", lastSeenAt: "2026-08-21T20:16:00.000Z",
      priceHistory: [{ price: 199 }], conditionHistory: [{ condition: "Gut" }], descriptionHistory: [{ description: "Text" }], statusHistory: [{ status: "active" }], snapshots: []
    }]
  };
  migrateStore(store);
  assert.equal(store.version, 4);
  assert.equal("location" in store.listings[0], false);
  assert.equal(store.listings[0].status, "missing");
  assert.equal(store.listings[0].description, "Text");
  assert.deepEqual(store.listings[0].priceHistory, []);
  assert.deepEqual(store.listings[0].statusHistory, []);
  assert.deepEqual(store.events, []);
});

test("normalisiert Vinted-Metadaten und eingeklappte Mehr-Markierungen", () => {
  const raw = "Inklusive Vinted-Käuferschutz\nHochgeladen\nvor 2 Stunden\n  JBL Box   kaum genutzt  \n... mehr";
  assert.equal(normalizeDescription(raw), "JBL Box kaum genutzt");
});

test("filtert und sortiert die Marktübersicht kombinierbar", () => {
  const rows = [
    { id: "a", title: "JBL schwarz", seller: "anna", description: "OVP", price: 220, condition: "Sehr gut", status: "active", firstSeenAt: "2026-08-20T00:00:00Z" },
    { id: "b", title: "JBL blau", seller: "bert", description: "gebraucht", price: 160, condition: "Gut", status: "missing", firstSeenAt: "2026-08-10T00:00:00Z", disappearedAt: "2026-08-21T00:00:00Z" },
    { id: "c", title: "JBL rot", seller: "carla", description: "OVP", price: 180, condition: "Sehr gut", status: "active", firstSeenAt: "2026-08-22T00:00:00Z" }
  ];
  assert.deepEqual(applyListingView(rows, { query: "ovp", condition: "Sehr gut", minPrice: 170, maxPrice: 200, sort: "priceAsc" }).map((row) => row.id), ["c"]);
  assert.deepEqual(applyListingView(rows, { sort: "durationDesc" }, new Date("2026-08-23T00:00:00Z")).map((row) => row.id), ["b", "a", "c"]);
});

test("vervollständigt neue Suchtreffer beim ersten Detailabruf ohne Scheinänderung", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 190, condition: "Gut", detailsComplete: false }], "2026-08-20T10:00:00.000Z", { confirmMissing: false });
  const item = store.listings[0];
  assert.equal(item.detailsFetchedAt, null);
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 190, condition: "Gut", seller: "anna", description: "Kaum benutzt", detailsComplete: true }], "2026-08-21T05:17:00.000Z");
  assert.equal(item.seller, "anna");
  assert.equal(item.description, "Kaum benutzt");
  assert.equal(item.snapshots.length, 1);
  assert.deepEqual(item.descriptionHistory, []);
  assert.deepEqual(store.events, []);
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 190, condition: "Gut", seller: "anna", description: "Jetzt mit OVP", detailsComplete: true }], "2026-08-22T05:17:00.000Z");
  assert.deepEqual(item.descriptionHistory.map((point) => point.description), ["Jetzt mit OVP"]);
});

test("stündliche Suchläufe bestätigen ein Verschwinden noch nicht", () => {
  const store = setup(2);
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 190, condition: "Gut" }], "2026-08-20T10:00:00.000Z");
  for (let hour = 11; hour <= 15; hour++) reconcileSnapshot(store, "speaker", [], `2026-08-20T${hour}:00:00.000Z`, { confirmMissing: false });
  assert.equal(store.listings[0].status, "checking");
  assert.deepEqual(store.listings[0].statusHistory, []);
  reconcileSnapshot(store, "speaker", [], "2026-08-21T05:17:00.000Z", { confirmMissing: true });
  assert.equal(store.listings[0].status, "missing");
  assert.deepEqual(store.listings[0].statusHistory.map(({ from, to }) => ({ from, to })), [{ from: "active", to: "missing" }]);
});

test("öffnet im Detailabgleich keine bereits abgeschlossenen Angebote erneut", () => {
  const tracked = [
    { externalId: "a", status: "active", url: "https://www.vinted.de/items/a" },
    { externalId: "b", status: "checking", url: "https://www.vinted.de/items/b" },
    { externalId: "c", status: "missing", url: "https://www.vinted.de/items/c" },
    { externalId: "d", status: "removed", url: "https://www.vinted.de/items/d" },
    { externalId: "e", status: "sold", url: "https://www.vinted.de/items/e" }
  ];
  assert.deepEqual(eligibleFollowUps(tracked, new Set(["a"])).map((item) => item.externalId), ["b", "c"]);
});

test("löst Such- und Detailmodus explizit auf", () => {
  assert.equal(resolveRunMode(["--mode", "search"], {}), "search");
  assert.equal(resolveRunMode([], { TRACKER_RUN_MODE: "details" }), "details");
  assert.throws(() => resolveRunMode(["--mode", "alles"], {}), /Ungültiger Laufmodus/);
});

test("unterscheidet Neu mit Etikett von Neu", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [
    { id: "1", title: "JBL Xtreme 4", price: 190, condition: "Neu, mit Etikett" },
    { id: "2", title: "JBL Xtreme 4", price: 180, condition: "Neu" }
  ], "2026-08-23T08:00:00.000Z");
  assert.deepEqual(store.listings.map((item) => item.condition), ["Neu, mit Etikett", "Neu"]);
});

test("behandelt die erstmalige Etikett-Differenzierung als Datenkorrektur", () => {
  const store = setup();
  store.version = 3;
  store.listings.push({ id: "x", externalId: "1", profileId: "speaker", title: "JBL Xtreme 4", price: 190, condition: "Neu, mit Etikett", description: "", seller: "anna", status: "active", firstSeenAt: "2026-08-20T10:00:00.000Z", lastSeenAt: "2026-08-23T10:00:00.000Z", conditionHistory: [{ from: "Neu", to: "Neu, mit Etikett", condition: "Neu, mit Etikett", at: "2026-08-23T10:00:00.000Z" }], priceHistory: [], descriptionHistory: [], descriptionVersions: [], statusHistory: [], snapshots: [{ at: "2026-08-20T10:00:00.000Z", price: 190, condition: "Neu", description: "", status: "active" }] });
  store.events.push({ type: "condition", text: "JBL Xtreme 4: Zustand Neu → Neu, mit Etikett" });
  migrateStore(store);
  assert.equal(store.version, 4);
  assert.deepEqual(store.listings[0].conditionHistory, []);
  assert.equal(store.listings[0].snapshots[0].condition, "Neu, mit Etikett");
  assert.deepEqual(store.events, []);
});

test("reaktiviert ein wieder in der Suche sichtbares Missing-Angebot", () => {
  const store = setup(1);
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 190, condition: "Gut" }], "2026-08-20T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [], "2026-08-21T05:17:00.000Z", { confirmMissing: true });
  assert.equal(store.listings[0].status, "missing");
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 190, condition: "Gut", detailsComplete: false }], "2026-08-21T06:17:00.000Z", { confirmMissing: false });
  assert.equal(store.listings[0].status, "active");
  assert.deepEqual(store.listings[0].statusHistory.map(({ from, to }) => ({ from, to })), [{ from: "active", to: "missing" }, { from: "missing", to: "active" }]);
});

test("formatiert Discord-Benachrichtigungen und sendet höchstens zehn Embeds je Nachricht", async () => {
  const profile = { name: "JBL Xtreme 4" };
  const listings = Array.from({ length: 11 }, (_, index) => ({ title: `JBL ${index}`, price: 199, currency: "EUR", condition: "Neu, mit Etikett", seller: "anna", url: `https://www.vinted.de/items/${index}`, imageUrl: "https://images.example/item.jpg", firstSeenAt: "2026-08-23T08:00:00.000Z" }));
  const payload = buildDiscordPayload(profile, listings.slice(0, 1));
  assert.equal(payload.embeds[0].fields[0].value, "199,00 €");
  assert.equal(payload.embeds[0].fields[1].value, "Neu, mit Etikett");
  const bodies = [];
  const result = await notifyDiscord("https://discord.com/api/webhooks/123/token_test", profile, listings, async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 204 }; });
  assert.deepEqual(result, { sent: 11, messages: 2 });
  assert.deepEqual(bodies.map((body) => body.embeds.length), [10, 1]);
  assert.throws(() => validateDiscordWebhookUrl("https://example.com/api/webhooks/123/token"), /keine gültige/);
});

test("verweigert öffentliche Serverbindung ohne Admin-Token", () => {
  assert.doesNotThrow(() => assertSecureBind("127.0.0.1", ""));
  assert.throws(() => assertSecureBind("0.0.0.0", ""), /ADMIN_TOKEN/);
  assert.doesNotThrow(() => assertSecureBind("0.0.0.0", "ein-langes-geheimes-token"));
});

test("schützt schreibende API-Aufrufe mit konstantem Tokenvergleich", () => {
  const request = (authorization, remoteAddress = "203.0.113.8") => ({ headers: { authorization }, socket: { remoteAddress } });
  assert.equal(isAuthorizedMutation(request("Bearer richtig"), "richtig"), true);
  assert.equal(isAuthorizedMutation(request("Bearer falsch"), "richtig"), false);
  assert.equal(isAuthorizedMutation(request("", "127.0.0.1"), ""), true);
  assert.equal(isAuthorizedMutation(request("", "203.0.113.8"), ""), false);
});

test("sendet Feed-Zugang nur an explizit erlaubte HTTPS-Hosts", () => {
  assert.equal(requireAllowedFeedUrl("https://feed.example/items?q=jbl", "feed.example"), "https://feed.example/items?q=jbl");
  assert.throws(() => requireAllowedFeedUrl("http://feed.example/items", "feed.example"), /HTTPS/);
  assert.throws(() => requireAllowedFeedUrl("https://evil.example/items", "feed.example"), /nicht.*freigegeben/);
});
