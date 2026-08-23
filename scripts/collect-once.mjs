import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectVinted } from "../src/vinted-browser.mjs";
import { makeProfile, migrateStore, reconcileSnapshot, updateProfile } from "../src/tracker.mjs";
import { resolveRunMode } from "../src/run-mode.mjs";
import { notifyDiscord } from "../src/discord-webhook.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataFile = process.env.TRACKER_DATA_FILE || join(root, "data", "store.json");
const runFile = join(dirname(dataFile), "last-run.json");
const store = migrateStore(JSON.parse(await readFile(dataFile, "utf8")));
const configuredProfiles = JSON.parse(await readFile(join(root, "config", "profiles.json"), "utf8"));
store.profiles = configuredProfiles.map((configuration) => {
  const existing = store.profiles.find((profile) => profile.id === configuration.id);
  return existing ? updateProfile(existing, configuration) : makeProfile(configuration);
});
const startedAt = new Date().toISOString();
const runMode = resolveRunMode();
const results = [];
let failed = false;

for (const profile of store.profiles.filter((entry) => entry.active && entry.collectorEnabled)) {
  console.log(`\n[${profile.name}] ${runMode === "details" ? "Täglicher Detailabgleich" : "Stündliche Suche"} startet`);
  try {
    const trackedListings = store.listings.filter((listing) => listing.profileId === profile.id);
    const knownIds = new Set(trackedListings.map((listing) => listing.externalId));
    const detailsEnabled = runMode === "details" && profile.scrapeDetails !== false;
    const collected = await collectVinted({ ...profile, scrapeDetails: detailsEnabled }, (progress) => {
      const count = progress.total ? ` (${progress.current || 0}/${progress.total})` : "";
      console.log(`[${profile.name}] ${progress.message || progress.phase}${count}`);
    }, trackedListings);
    const syncAt = new Date().toISOString();
    const summary = reconcileSnapshot(store, profile.id, collected.items, syncAt, { confirmMissing: detailsEnabled });
    const newListings = store.listings.filter((listing) => listing.profileId === profile.id && !knownIds.has(listing.externalId));
    for (const listing of newListings) {
      const key = `${profile.id}:${listing.externalId}`;
      if (!store.pendingWebhookNotifications.some((entry) => entry.key === key)) store.pendingWebhookNotifications.push({ key, profileId: profile.id, externalId: listing.externalId, queuedAt: syncAt });
    }
    const pending = store.pendingWebhookNotifications.filter((entry) => entry.profileId === profile.id);
    const pendingListings = pending.map((entry) => store.listings.find((listing) => listing.profileId === entry.profileId && listing.externalId === entry.externalId)).filter((listing) => listing && !["removed", "sold"].includes(listing.status));
    let notification = { status: process.env.DISCORD_WEBHOOK_URL ? "nothing-to-send" : "not-configured", sent: 0 };
    if (process.env.DISCORD_WEBHOOK_URL && pending.length) {
      try {
        const sent = await notifyDiscord(process.env.DISCORD_WEBHOOK_URL, profile, pendingListings);
        const keys = new Set(pending.map((entry) => entry.key));
        store.pendingWebhookNotifications = store.pendingWebhookNotifications.filter((entry) => !keys.has(entry.key));
        for (const listing of pendingListings) listing.discordNotifiedAt = syncAt;
        notification = { status: "sent", ...sent };
      } catch (error) {
        notification = { status: "failed", sent: 0, error: error.message };
        console.error(`[${profile.name}] Discord-Benachrichtigung fehlgeschlagen: ${error.message}`);
      }
    }
    if (detailsEnabled) profile.lastDetailSyncAt = syncAt;
    profile.lastSyncStatus = `${runMode === "details" ? "Details" : "Suche"}: ${summary.matched} von ${collected.advertisedTotal || summary.received} Treffern erfasst`;
    results.push({ profileId: profile.id, mode: runMode, status: "complete", advertisedTotal: collected.advertisedTotal, visitedDetails: collected.visitedDetails, notification, ...summary });
  } catch (error) {
    failed = true;
    profile.lastSyncStatus = `Collector-Fehler: ${error.message}`;
    profile.updatedAt = new Date().toISOString();
    results.push({ profileId: profile.id, status: "failed", error: error.message });
    console.error(`[${profile.name}] ${error.stack || error.message}`);
  }
}

store.updatedAt = new Date().toISOString();
await mkdir(dirname(dataFile), { recursive: true });
await writeFile(dataFile, `${JSON.stringify(store, null, 2)}\n`);
await writeFile(runFile, `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), mode: runMode, status: failed ? "failed" : "complete", results }, null, 2)}\n`);

if (failed) process.exitCode = 2;
