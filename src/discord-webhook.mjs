const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);

export function buildDiscordPayload(profile, listings) {
  return {
    username: "Xtreme Tracker",
    content: `🔊 **${listings.length} ${listings.length === 1 ? "neues Angebot" : "neue Angebote"} für ${profile.name}**`,
    allowed_mentions: { parse: [] },
    embeds: listings.map((listing) => ({
      title: truncate(listing.title || "Neues Vinted-Angebot", 120),
      url: listing.url,
      color: 0x2458e6,
      description: truncate(listing.description || "Beschreibung wird beim nächsten Detailabgleich ergänzt.", 280),
      fields: [
        { name: "Preis", value: formatPrice(listing.price, listing.currency), inline: true },
        { name: "Zustand", value: listing.condition || "Unbekannt", inline: true },
        { name: "Verkäufer", value: truncate(listing.seller && listing.seller !== "Unbekannt" ? listing.seller : "Noch nicht geladen", 60), inline: true }
      ],
      thumbnail: listing.imageUrl ? { url: listing.imageUrl } : undefined,
      footer: { text: "Vinted · Xtreme Tracker" },
      timestamp: listing.firstSeenAt || new Date().toISOString()
    }))
  };
}

export async function notifyDiscord(webhookUrl, profile, listings, fetchImpl = fetch) {
  if (!listings.length) return { sent: 0, messages: 0 };
  const url = validateDiscordWebhookUrl(webhookUrl);
  let messages = 0;
  for (let offset = 0; offset < listings.length; offset += 10) {
    const chunk = listings.slice(offset, offset + 10);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDiscordPayload(profile, chunk)),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Discord-Webhook antwortet mit HTTP ${response.status}.`);
    messages++;
  }
  return { sent: listings.length, messages };
}

export function validateDiscordWebhookUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || !DISCORD_HOSTS.has(url.hostname) || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)) {
    throw new Error("DISCORD_WEBHOOK_URL ist keine gültige Discord-Webhook-URL.");
  }
  return url.toString();
}

function formatPrice(value, currency = "EUR") {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(Number(value)) : "Unbekannt";
}

function truncate(value, length) {
  const text = String(value || "").trim();
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
