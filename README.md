# Xtreme Tracker

[![Vinted täglich tracken](https://github.com/keyfind/vinted-xtreme-tracker/actions/workflows/daily-track.yml/badge.svg)](https://github.com/keyfind/vinted-xtreme-tracker/actions/workflows/daily-track.yml)

Ein anpassbares, lokal laufendes Dashboard für Angebots-Snapshots. Vorkonfiguriert ist **JBL Xtreme 4**; weitere Produkte lassen sich direkt in der Oberfläche anlegen.

## Kostenlose GitHub-Version

Das Repository enthält einen vollständigen GitHub-Actions-/Pages-Betrieb:

- täglicher Browser-Lauf um 05:17 UTC sowie manueller Start im Actions-Tab,
- einfache Produktkonfiguration in `config/profiles.json`,
- versionierte Speicherung aller Beobachtungen in `data/store.json`,
- statisches Dashboard auf GitHub Pages,
- CSV-Export direkt aus der veröffentlichten Seite,
- kein Vinted-Login und keine geheimen Tokens notwendig.

Der erste Lauf startet automatisch mit dem Einspielen des Workflows. Weitere Läufe können über **Actions → Vinted täglich tracken → Run workflow** gestartet werden. Das Dashboard wird anschließend über die beim Lauf angezeigte Pages-URL erreichbar.

### Produkt anpassen

In `config/profiles.json` können vorhandene Profile geändert oder weitere Profile ergänzt werden. Wesentliche Felder sind `name`, `query`, `includeTerms`, `excludeTerms`, `minPrice`, `maxPrice`, `conditions`, `maxResults`, `scrapeDetails` und `detailDelayMs`. Der JBL-Standardfilter schließt Hüllen, Cases, Ersatzteile und reine Ersatzakkus aus. Auf der GitHub-Pages-Seite führt **Konfiguration** direkt zu dieser Datei; **Lauf starten** öffnet den Workflow. Die Verlaufsdatei `data/store.json` wird ausschließlich automatisch gepflegt.

## Was das Tool erfasst

- Preis und Preisverlauf
- Zustand, Beschreibung und Verkäufer
- kompakte Snapshots nur bei tatsächlichen Änderungen
- getrennte Preis-, Zustands-, Status- und Beschreibungshistorien
- Zeitpunkt der ersten und letzten Sichtung
- aktuelle Online-Dauer
- bestätigten Verkauf, wenn die Datenquelle `status: "sold"` liefert
- separat markierte Angebote, die in mehreren Snapshots fehlen
- CSV-Export, kombinierbare Status-/Zustands-/Preisfilter, Volltextsuche, Sortierung und mehrere Produktprofile

## Start

Voraussetzung: Node.js 22 oder neuer.

```bash
npm install
npm run install-browser
npm start
```

Danach `http://localhost:4173` öffnen.

Tests:

```bash
npm test
```

## Daten einspeisen

### 1. Öffentlicher Browser-Collector

Der vorkonfigurierte JBL-Tracker kann die öffentliche Vinted-Suche ohne Login im Browser öffnen:

1. Dashboard starten.
2. Auf den Produktnamen klicken und **Browser-Collector** aktivieren.
3. **Jetzt abgleichen** wählen.

Der Collector:

- öffnet `vinted.de` und tippt den konfigurierten Suchbegriff in das sichtbare Suchfeld,
- scrollt durch die öffentlichen Suchergebnisse,
- dedupliziert Angebote anhand ihrer Vinted-ID,
- öffnet jedes Ergebnis nacheinander,
- prüft bereits getrackte, aus der Suche verschwundene Angebote nochmals direkt,
- liest Preis, Zustand, Verkäufer, Upload-Alter und Entfernt-/Verkauft-Status,
- archiviert tatsächliche Preis-, Zustands-, Beschreibungs- und Statusänderungen,
- wartet standardmäßig drei Sekunden zwischen Detailseiten,
- stoppt bei CAPTCHA, menschlicher Verifizierung oder erkennbarem Zugriffsschutz.

Der Standardzeitplan ist einmal täglich. Automatische Läufe sind absichtlich zusätzlich geschützt. Erst mit dieser Umgebungsvariable werden fällige Tracker serverseitig gestartet:

```bash
ENABLE_SCHEDULED_SCRAPING=true npm start
```

Mit `SCRAPER_HEADLESS=false` wird der Collector-Browser sichtbar geöffnet. Die Anzahl der Ergebnisse, Pausen und Detailabfragen sind je Produktprofil einstellbar.

Der erste erfolgreiche Abruf legt nur den Ausgangsstand an. Erst tatsächliche Änderungen erzeugen Einträge im Änderungsverlauf und neue Snapshots. Inhaltlich identische Beschreibungen werden normalisiert und nicht erneut archiviert.

## Docker und Hosting

Das Paket enthält ein browserfähiges Docker-Image. Vor dem Start muss in einer `.env`-Datei ein langes zufälliges Admin-Token gesetzt werden:

```dotenv
TRACKER_ADMIN_TOKEN=hier-ein-langes-zufaelliges-geheimnis-eintragen
```

Danach lokal oder auf einem Docker-Host:

```bash
docker compose up -d --build
```

Für dauerhaftes Hosting muss `/app/data` als persistentes Volume eingebunden sein. Der Container bringt Chromium mit und startet den täglichen Collector automatisch. Auf rein statischem Hosting oder serverlosen Worker-Plattformen kann der Playwright-Browser nicht laufen.

Schreibende API-Aufrufe verlangen bei einer öffentlichen Serverbindung immer `Authorization: Bearer <TRACKER_ADMIN_TOKEN>`. Das Dashboard fragt das Token nur bei Bedarf ab und hält es ausschließlich für die laufende Browser-Sitzung. Ohne Admin-Token bindet der Node-Server ausschließlich an Loopback.

### 2. Snapshot-Import

Im Dashboard **Snapshot importieren** wählen und ein JSON-Array einfügen:

```json
[
  {
    "id": "vinted-123",
    "title": "JBL Xtreme 4 schwarz",
    "price": 199,
    "currency": "EUR",
    "condition": "Sehr gut",
    "seller": "beispiel",
    "url": "https://www.vinted.de/items/…",
    "observedAt": "2026-08-22T10:00:00Z",
    "status": "active"
  }
]
```

Die `id` muss über Snapshots hinweg stabil bleiben. Ein leerer Snapshot ist erlaubt und erhöht bei allen bisher aktiven Angeboten den Fehlzähler.

### 3. Autorisierter JSON-Feed

In den Tracker-Einstellungen kann eine Feed-URL hinterlegt werden. `{query}` wird durch den URL-kodierten Suchbegriff ersetzt. Unterstützt werden:

- ein direktes JSON-Array
- `{ "items": [...] }`
- `{ "results": [...] }`
- `{ "data": { "items": [...] } }`

Feed-Abrufe sind nur über HTTPS und nur für explizit erlaubte Hosts möglich. Ein optionales Bearer-Token wird ausschließlich nach dieser Prüfung gesendet; Weiterleitungen werden nicht verfolgt:

```bash
TRACKER_FEED_ALLOWLIST="feed.example" TRACKER_FEED_TOKEN="…" npm start
```

Das kleinste automatische Intervall ist 15 Minuten. Das Tool versucht nicht, Sperren, Logins oder technische Schutzmaßnahmen zu umgehen.

## Wichtige Statuslogik

Ein verschwundenes Angebot ist nicht automatisch verkauft: Es kann gelöscht, reserviert oder moderiert worden sein. Deshalb gilt:

- `active`: aktuell im Snapshot
- `checking`: erstmals nicht gefunden
- `missing`: nach dem konfigurierten Schwellenwert nicht mehr online
- `sold`: nur bei ausdrücklicher Meldung der Quelle
- `removed`: ausdrücklich als entfernt gemeldet

## API- und Vinted-Hinweis

Es gibt eine offizielle **Vinted Pro Integrations API**, sie ist aber nicht als öffentliche Marktplatz-Such-API gedacht und verlangt einen Access Key sowie eine HMAC-Signatur. Eine offiziell dokumentierte allgemeine Vinted-Such-API ohne Auth ist nicht verfügbar.

Vinted untersagt in seinen aktuellen AGB externe Software-Tools einschließlich Bots, Scraping- und Crawling-Programme, sofern deren Nutzung nicht ausdrücklich gestattet ist. Der Browser-Collector kann deshalb gegen diese AGB verstoßen und zu Verifizierung, Ratenbegrenzung oder Sperren führen. Er verwendet keine Logins, keine privaten Endpunkte, keine Proxy-Rotation, keine Fingerprint-Manipulation und keine CAPTCHA-Umgehung. Nutzung auf eigenes Risiko.

## Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `4173` | HTTP-Port |
| `HOST` | `127.0.0.1` | Bind-Adresse; öffentliche Werte verlangen ein Admin-Token |
| `TRACKER_ADMIN_TOKEN` | leer | Pflicht bei nicht-lokaler Bindung; schützt alle Schreib-APIs |
| `TRACKER_DATA_FILE` | `./data/store.json` | Pfad zur JSON-Datenbank |
| `TRACKER_FEED_ALLOWLIST` | leer | Kommagetrennte, exakt erlaubte HTTPS-Feed-Hosts |
| `TRACKER_FEED_TOKEN` | leer | Bearer-Token für den autorisierten Feed |
| `ENABLE_SCHEDULED_SCRAPING` | `false` | Browser-Collector automatisch nach Zeitplan ausführen |
| `SCRAPER_HEADLESS` | `true` | `false` zeigt den Collector-Browser sichtbar an |

Die Oberfläche speichert Tracker-Profile und Angebotsverläufe serverseitig in der JSON-Datei. Vor einem öffentlichen Betrieb sollten Zugriffsschutz, Backups und eine richtige Datenbank ergänzt werden.
