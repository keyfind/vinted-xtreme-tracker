export function applyListingView(rows, filters = {}, now = new Date()) {
  const query = String(filters.query || "").trim().toLocaleLowerCase("de");
  const status = filters.status || "all";
  const condition = filters.condition || "all";
  const minPrice = optionalNumber(filters.minPrice);
  const maxPrice = optionalNumber(filters.maxPrice);
  const filtered = rows.filter((row) => {
    const haystack = `${row.title || ""} ${row.seller || ""} ${row.description || ""}`.toLocaleLowerCase("de");
    if (query && !haystack.includes(query)) return false;
    if (status !== "all" && row.status !== status) return false;
    if (condition !== "all" && row.condition !== condition) return false;
    if (minPrice !== null && Number(row.price) < minPrice) return false;
    if (maxPrice !== null && Number(row.price) > maxPrice) return false;
    return true;
  });
  return filtered.sort(comparator(filters.sort || "newest", now));
}

export function lastChangeAt(row) {
  const values = [
    ...(row.priceHistory || []),
    ...(row.conditionHistory || []),
    ...(row.descriptionHistory || []),
    ...(row.statusHistory || [])
  ].map((point) => new Date(point.at).getTime()).filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function comparator(sort, now) {
  const title = (a, b) => String(a.title || "").localeCompare(String(b.title || ""), "de");
  const by = (value, direction = 1) => (a, b) => (value(a) - value(b)) * direction || title(a, b);
  const options = {
    newest: by((row) => timestamp(row.firstSeenAt), -1),
    oldest: by((row) => timestamp(row.firstSeenAt), 1),
    priceAsc: by((row) => Number(row.price) || 0, 1),
    priceDesc: by((row) => Number(row.price) || 0, -1),
    changed: by(lastChangeAt, -1),
    durationDesc: by((row) => durationMs(row, now), -1)
  };
  return options[sort] || options.newest;
}

function durationMs(row, now) {
  const end = row.soldAt || row.disappearedAt || now;
  return Math.max(0, new Date(end).getTime() - timestamp(row.firstSeenAt));
}

function timestamp(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
