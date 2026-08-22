import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function assertSecureBind(host, adminToken) {
  if (!LOOPBACK_HOSTS.has(String(host).toLowerCase()) && !String(adminToken || "").trim()) {
    throw new Error("TRACKER_ADMIN_TOKEN ist für eine öffentliche HOST-Bindung zwingend erforderlich.");
  }
}

export function isAuthorizedMutation(request, adminToken) {
  const expected = String(adminToken || "").trim();
  if (!expected) return LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress || "");
  const header = String(request.headers?.authorization || "");
  const candidate = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function requireAllowedFeedUrl(value, allowlistValue = "") {
  let url;
  try { url = new URL(value); } catch { throw new Error("Die Feed-URL ist ungültig."); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Feed-URLs müssen HTTPS verwenden und dürfen keine Zugangsdaten enthalten.");
  }
  const allowed = String(allowlistValue || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(url.host.toLowerCase())) {
    throw new Error(`Feed-Host ${url.host} ist nicht in TRACKER_FEED_ALLOWLIST freigegeben.`);
  }
  return url.toString();
}
