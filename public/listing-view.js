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

export function priceBuckets(rows, count = 5) {
  const prices = rows.map((row) => Number(row.price)).filter(Number.isFinite);
  if (!prices.length) return [];
  const bucketCount = Math.max(1, Math.floor(count));
  const start = Math.floor(Math.min(...prices) / 25) * 25;
  const roundedMax = Math.ceil(Math.max(...prices) / 25) * 25;
  const end = roundedMax > start ? roundedMax : start + 25;
  const width = (end - start) / bucketCount;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    from: start + width * index,
    to: start + width * (index + 1),
    inclusiveEnd: index === bucketCount - 1,
    prices: []
  }));
  for (const price of prices) {
    const index = Math.min(bucketCount - 1, Math.floor(((price - start) / (end - start)) * bucketCount));
    buckets[index].prices.push(price);
  }
  return buckets.map((bucket) => ({ ...bucket, count: bucket.prices.length }));
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
