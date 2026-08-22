import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectVinted } from "../src/vinted-browser.mjs";
import { makeProfile, migrateStore, reconcileSnapshot, updateProfile } from "../src/tracker.mjs";
import { resolveRunMode } from "../src/run-mode.mjs";

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
    const detailsEnabled = runMode === "details" && profile.scrapeDetails !== false;
    const collected = await collectVinted({ ...profile, scrapeDetails: detailsEnabled }, (progress) => {
      const count = progress.total ? ` (${progress.current || 0}/${progress.total})` : "";
      console.log(`[${profile.name}] ${progress.message || progress.phase}${count}`);
    }, trackedListings);
    const syncAt = new Date().toISOString();
    const summary = reconcileSnapshot(store, profile.id, collected.items, syncAt, { confirmMissing: detailsEnabled });
    if (detailsEnabled) profile.lastDetailSyncAt = syncAt;
    profile.lastSyncStatus = `${runMode === "details" ? "Details" : "Suche"}: ${summary.matched} von ${collected.advertisedTotal || summary.received} Treffern erfasst`;
    results.push({ profileId: profile.id, mode: runMode, status: "complete", advertisedTotal: collected.advertisedTotal, visitedDetails: collected.visitedDetails, ...summary });
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
