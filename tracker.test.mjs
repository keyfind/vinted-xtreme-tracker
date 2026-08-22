import test from "node:test";
import assert from "node:assert/strict";
import { blankStore, makeProfile, metrics, reconcileSnapshot } from "./src/tracker.mjs";
import { assertSecureBind, isAuthorizedMutation, requireAllowedFeedUrl } from "./src/security.mjs";
import { deriveListingStatus, parseCard, parseResultCount, relativeUploadDate } from "./src/vinted-browser.mjs";

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
});

test("protokolliert Preisänderungen", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 220, condition: "Gut" }], "2026-08-20T10:00:00.000Z");
  const result = reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut" }], "2026-08-21T10:00:00.000Z");
  assert.equal(result.changed, 1);
  assert.deepEqual(store.listings[0].priceHistory.map((point) => point.price), [220, 199]);
});

test("markiert fehlende Angebote erst nach dem Schwellenwert", () => {
  const store = setup(2);
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut" }], "2026-08-20T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [], "2026-08-21T10:00:00.000Z");
  assert.equal(store.listings[0].status, "checking");
  reconcileSnapshot(store, "speaker", [], "2026-08-22T10:00:00.000Z");
  assert.equal(store.listings[0].status, "missing");
  assert.equal(metrics(store, "speaker").missing, 1);
});

test("übernimmt einen expliziten Verkaufsstatus", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut", status: "sold" }], "2026-08-22T10:00:00.000Z");
  assert.equal(store.listings[0].status, "sold");
  assert.equal(store.listings[0].soldAt, "2026-08-22T10:00:00.000Z");
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

test("archiviert tägliche Snapshots sowie Zustands- und Beschreibungsänderungen", () => {
  const store = setup();
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 220, condition: "Sehr gut", description: "Kaum benutzt" }], "2026-08-20T10:00:00.000Z");
  reconcileSnapshot(store, "speaker", [{ id: "1", title: "JBL Xtreme 4", price: 199, condition: "Gut", description: "Kleine Gebrauchsspuren" }], "2026-08-21T10:00:00.000Z");
  const item = store.listings[0];
  assert.equal(item.snapshots.length, 2);
  assert.deepEqual(item.snapshots.map((snapshot) => snapshot.price), [220, 199]);
  assert.deepEqual(item.conditionHistory.map((point) => point.condition), ["Sehr gut", "Gut"]);
  assert.deepEqual(item.descriptionHistory.map((point) => point.description), ["Kaum benutzt", "Kleine Gebrauchsspuren"]);
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
