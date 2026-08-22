import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const ORIGIN = "https://www.vinted.de";
const BLOCK_PATTERNS = /verify you are human|checking your browser|ungewöhnliche aktivität|automatisierte anfragen|access denied|zugriff verweigert|captcha/i;

/**
 * Öffnet Vinted wie ein normaler Browser, nutzt die sichtbare Suche, scrollt
 * durch die Ergebnisse und besucht jedes gefundene Detail nacheinander.
 * Keine API-Tokens, kein CAPTCHA-Bypass, keine Proxy- oder Fingerprint-Tricks.
 */
export async function collectVinted(profile, onProgress = () => {}, trackedListings = []) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-chromium"));
  } catch {
    throw new Error("Browser-Collector ist noch nicht installiert. Führe einmal npm install aus.");
  }

  const profileDir = join(process.cwd(), "data", "browser-profile");
  await mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: process.env.SCRAPER_HEADLESS !== "false",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    viewport: { width: 1280, height: 900 }
  });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    onProgress({ phase: "opening", message: "Vinted wird geöffnet", current: 0, total: 0 });
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 30000 });
    await assertNotBlocked(page);

    const search = page.locator('input[placeholder="Suche Artikel"]:visible').first();
    await search.waitFor({ state: "visible" });
    await search.fill(profile.query);
    await Promise.all([
      page.waitForURL(/\/catalog\?/, { timeout: 20000 }),
      search.press("Enter")
    ]);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1400);
    await assertNotBlocked(page);

    const resultText = await page.locator("body").innerText();
    const advertisedTotal = parseResultCount(resultText);
    const limit = Math.min(profile.maxResults || 300, advertisedTotal || profile.maxResults || 300);
    if (advertisedTotal !== 0) {
      await page.locator('a[href*="/items/"]').first().waitFor({ state: "visible", timeout: 30000 });
    }
    const cards = await collectAllCards(page, limit, onProgress);
    const items = [];

    if (!profile.scrapeDetails) {
      for (const card of cards) items.push(cardToItem(card));
      onProgress({ phase: "complete", message: `${items.length} Angebote erfasst`, current: items.length, total: items.length });
      return { items, advertisedTotal, visitedDetails: 0 };
    }

    const detail = await context.newPage();
    detail.setDefaultTimeout(15000);
    for (let index = 0; index < cards.length; index++) {
      const card = cards[index];
      onProgress({ phase: "details", message: `Angebot ${index + 1} von ${cards.length}`, current: index + 1, total: cards.length });
      try {
        await detail.goto(card.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await detail.waitForTimeout(700);
        await assertNotBlocked(detail);
        const data = await extractDetail(detail);
        items.push({ ...cardToItem(card), ...data, id: card.id, url: card.url, observedAt: new Date().toISOString() });
      } catch (error) {
        if (error.code === "VINTED_BLOCKED") throw error;
        items.push({ ...cardToItem(card), observedAt: new Date().toISOString() });
        onProgress({ phase: "details", message: `Detail ${index + 1} nicht vollständig lesbar`, current: index + 1, total: cards.length });
      }
      if (index < cards.length - 1) await detail.waitForTimeout(profile.detailDelayMs || 3000);
    }

    const currentIds = new Set(cards.map((card) => card.id));
    const followUps = trackedListings.filter((listing) =>
      ["active", "checking"].includes(listing.status) && listing.url && !currentIds.has(listing.externalId)
    );
    for (let index = 0; index < followUps.length; index++) {
      const listing = followUps[index];
      onProgress({ phase: "follow-up", message: `Verschwundenes Angebot ${index + 1} von ${followUps.length} prüfen`, current: index + 1, total: followUps.length });
      try {
        await detail.goto(listing.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await detail.waitForTimeout(700);
        await assertNotBlocked(detail);
        const data = compactDetail(await extractDetail(detail));
        items.push({
          id: listing.externalId,
          title: listing.title,
          description: listing.description || "",
          url: listing.url,
          imageUrl: listing.imageUrl || "",
          price: listing.price,
          currency: listing.currency || "EUR",
          condition: listing.condition,
          seller: listing.seller,
          location: listing.location,
          ...data,
          observedAt: new Date().toISOString()
        });
      } catch (error) {
        if (error.code === "VINTED_BLOCKED") throw error;
        onProgress({ phase: "follow-up", message: `Angebot ${index + 1} nicht mehr direkt lesbar`, current: index + 1, total: followUps.length });
      }
      if (index < followUps.length - 1) await detail.waitForTimeout(profile.detailDelayMs || 3000);
    }
    await detail.close();
    onProgress({ phase: "complete", message: `${items.length} Angebote erfasst`, current: items.length, total: items.length });
    return { items, advertisedTotal, visitedDetails: cards.length + followUps.length };
  } finally {
    await context.close().catch(() => {});
  }
}

function compactDetail(data) {
  const result = { status: data.status || "active" };
  if (data.title) result.title = data.title;
  if (data.description) result.description = data.description;
  if (data.imageUrl) result.imageUrl = data.imageUrl;
  if (data.seller && data.seller !== "Unbekannt") result.seller = data.seller;
  if (data.condition && data.condition !== "Unbekannt") result.condition = data.condition;
  if (Number.isFinite(data.price)) result.price = data.price;
  if (data.sourceCreatedAt) result.sourceCreatedAt = data.sourceCreatedAt;
  return result;
}

async function collectAllCards(page, limit, onProgress) {
  const found = new Map();
  let unchanged = 0;
  let lastSize = 0;
  for (let round = 0; round < 80 && found.size < limit && unchanged < 4; round++) {
    const cards = await page.locator('a[href*="/items/"]').evaluateAll((links) => links.map((link) => {
      const rawUrl = link.getAttribute("href") || "";
      const label = link.getAttribute("aria-label") || link.querySelector("img")?.getAttribute("alt") || "";
      const imageUrl = link.querySelector("img")?.getAttribute("src") || "";
      return { rawUrl, label, imageUrl };
    }));
    for (const raw of cards) {
      const card = parseCard(raw);
      if (card) found.set(card.id, card);
    }
    onProgress({ phase: "results", message: `${found.size} Ergebnislinks gefunden`, current: found.size, total: limit });
    unchanged = found.size === lastSize ? unchanged + 1 : 0;
    lastSize = found.size;
    if (found.size >= limit) break;
    const more = page.getByRole("button", { name: /mehr anzeigen|weitere anzeigen/i });
    if (await more.isVisible().catch(() => false)) await more.click().catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1300);
    await assertNotBlocked(page);
  }
  return [...found.values()].slice(0, limit);
}

async function extractDetail(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || "";
    const main = document.querySelector("main")?.innerText || bodyText;
    const title = document.querySelector("h1")?.textContent?.trim() || "";
    const sellerLink = [...document.querySelectorAll('a[href^="/member/"]')].find((link) => link.textContent?.trim());
    const imageUrl = document.querySelector('main figure img')?.getAttribute("src") || "";
    const conditionValues = ["Neu, mit Etikett", "Neu", "Sehr gut", "Gut", "Zufriedenstellend"];
    const condition = conditionValues.find((value) => [...document.querySelectorAll("main *")].some((node) => node.children.length === 0 && node.textContent?.trim() === value)) || "Unbekannt";
    const priceMatch = main.match(/(\d{1,5}(?:[.,]\d{2})?)\s*€/);
    const uploadedMatch = main.match(/Hochgeladen\s*\n?\s*(?:vor\s*)?([^\n]+)/i);
    const descriptionMatch = main.match(/Hochgeladen\s*\n?\s*(?:vor\s*)?[^\n]+\n([\s\S]*?)\nVersand(?:\n|$)/i);
    const removed = /(?:^|\n)Entfernt!(?:\n|$)/i.test(main);
    const sold = /(?:^|\n)Verkauft!?(?:\n|$)/i.test(main);
    return {
      title,
      seller: sellerLink?.textContent?.trim() || "Unbekannt",
      imageUrl,
      condition,
      description: descriptionMatch?.[1]?.trim() || "",
      priceText: priceMatch?.[1] || "",
      status: sold ? "sold" : removed ? "removed" : "active",
      uploadedText: uploadedMatch?.[1]?.trim() || ""
    };
  }).then((data) => {
    const output = { ...data, price: parseEuroNumber(data.priceText), sourceCreatedAt: relativeUploadDate(data.uploadedText) };
    delete output.uploadedText;
    delete output.priceText;
    if (!Number.isFinite(output.price)) delete output.price;
    return output;
  });
}

async function assertNotBlocked(page) {
  const text = (await page.locator("body").innerText({ timeout: 10000 }).catch(() => "")).slice(0, 5000);
  if (BLOCK_PATTERNS.test(text)) {
    const error = new Error("Vinted verlangt eine menschliche Verifizierung. Der Collector wurde gestoppt; es wird nichts umgangen.");
    error.code = "VINTED_BLOCKED";
    throw error;
  }
}

export function parseCard(raw) {
  const id = String(raw.rawUrl || "").match(/\/items\/(\d+)/)?.[1];
  if (!id) return null;
  const label = String(raw.label || "").trim();
  const title = label.split(/,\s*(?:Marke|marke|Zustand|zustand):/)[0] || `Vinted-Angebot ${id}`;
  const priceText = label.match(/(\d{1,5}(?:[.,]\d{2})?)\s*€/i)?.[1];
  const price = parseEuroNumber(priceText);
  if (!Number.isFinite(price)) return null;
  const condition = ["Neu, mit Etikett", "Neu", "Sehr gut", "Gut", "Zufriedenstellend"].find((value) => label.toLowerCase().includes(`zustand: ${value.toLowerCase()}`)) || "Unbekannt";
  const canonical = new URL(String(raw.rawUrl), ORIGIN); canonical.search = "";
  return { id, title, price, currency: "EUR", condition, imageUrl: raw.imageUrl || "", url: canonical.toString(), status: "active" };
}

function cardToItem(card) {
  return { ...card, externalId: undefined, observedAt: new Date().toISOString(), seller: "Unbekannt", location: "Deutschland" };
}

export function parseResultCount(text) {
  const match = String(text).match(/([\d.]+)\s+Ergebnisse?/i);
  return match ? Number(match[1].replaceAll(".", "")) : null;
}

export function parseEuroNumber(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  if (text.includes(",")) return Number(text.replaceAll(".", "").replace(",", "."));
  return Number(text);
}

export function relativeUploadDate(text, now = new Date()) {
  const value = String(text || "").toLowerCase();
  let amount = Number(value.match(/\d+/)?.[0] || 0);
  if (/gerade|sekunde/.test(value)) return now.toISOString();
  const date = new Date(now);
  if (/minute/.test(value)) date.setMinutes(date.getMinutes() - Math.max(amount, 1));
  else if (/stunde|std\./.test(value)) date.setHours(date.getHours() - Math.max(amount, 1));
  else if (/tag|tagen/.test(value)) date.setDate(date.getDate() - Math.max(amount, 1));
  else if (/woche/.test(value)) date.setDate(date.getDate() - Math.max(amount, 1) * 7);
  else if (/monat/.test(value)) date.setMonth(date.getMonth() - Math.max(amount, 1));
  else return null;
  return date.toISOString();
}
