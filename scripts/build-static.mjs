import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { metrics } from "../src/tracker.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "dist");
const store = JSON.parse(await readFile(join(root, "data", "store.json"), "utf8"));
const repository = process.env.GITHUB_REPOSITORY || "";
const repositoryUrl = repository ? `https://github.com/${repository}` : "";

await rm(output, { recursive: true, force: true });
await cp(join(root, "public"), output, { recursive: true });
await mkdir(join(output, "data"), { recursive: true });

const indexPath = join(output, "index.html");
const index = (await readFile(indexPath, "utf8")).replace('<html lang="de">', '<html lang="de" data-mode="static">');
await writeFile(indexPath, index);

const state = {
  ...store,
  metrics: Object.fromEntries(store.profiles.map((profile) => [profile.id, metrics(store, profile.id)])),
  collectorJobs: {},
  deployment: { mode: "github-pages", repositoryUrl },
  serverTime: new Date().toISOString()
};
await writeFile(join(output, "data", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
await writeFile(join(output, "data", "listings.csv"), csv(store.listings));
await writeFile(join(output, ".nojekyll"), "");

function csv(rows) {
  const columns = ["Produkt", "Titel", "Preis", "Währung", "Zustand", "Status", "Erstmals gesehen", "Zuletzt gesehen", "Verkauft am", "Beschreibung", "URL"];
  const profiles = new Map(store.profiles.map((profile) => [profile.id, profile.name]));
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const body = rows.map((row) => [profiles.get(row.profileId), row.title, row.price, row.currency, row.condition, row.status, row.firstSeenAt, row.lastSeenAt, row.soldAt, row.description, row.url]);
  return `\uFEFF${[columns, ...body].map((row) => row.map(escape).join(",")).join("\n")}\n`;
}
