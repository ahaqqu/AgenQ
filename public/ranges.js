// AgenQ stats-page range math — the pure part, split out so `bun test` can
// exercise it without a DOM (the frontend has no bundler by design: this file
// is loaded as a plain <script> and hangs its API on globalThis.RANGES).
//
// The load-bearing idea is GRAIN. A harness reports usage at the resolution
// its telemetry actually supports ("hour" for timestamped per-request rows,
// "day" for cumulative totals). A range is rendered at a grain too:
//
//   - short spans (≤48h) at hour grain, longer ones at day grain — 168 hourly
//     bars would be unreadable, and the presets that matter are day-shaped;
//   - a harness at day grain cannot contribute to an hour-grain range: it
//     would take one day's tokens and spread them across 24 bars, inventing
//     detail the telemetry does not have. Its usage is left out of such a
//     range (its agents/duration still count) and the page says so;
//   - buckets are always whole local hours/days, so a custom range with edges
//     inside a bucket is widened to cover them and the header reports the
//     widened window rather than a partial bucket as if it were exact.
(() => {
  const HOUR_MS = 3600_000;

  const pad2 = (n) => String(n).padStart(2, "0");

  const startOfHour = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime(); };
  const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const startOfMonth = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
  const addHours = (ms, n) => { const d = new Date(ms); d.setHours(d.getHours() + n); return d.getTime(); };
  const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  const addMonths = (ms, n) => { const d = new Date(ms); d.setMonth(d.getMonth() + n); return d.getTime(); };

  const bucketStart = (ms, grain) => (grain === "hour" ? startOfHour(ms) : startOfDay(ms));
  const addBuckets = (ms, n, grain) => (grain === "hour" ? addHours(ms, n) : addDays(ms, n));

  const grainForSpan = (spanMs) => (spanMs <= 48 * HOUR_MS ? "hour" : "day");
  const grainAllows = (harnessGrain, rangeGrain) => harnessGrain === "hour" || rangeGrain === "day";

  // whole buckets the range covers, at the range's grain
  function rangeBuckets(range) {
    const buckets = [];
    for (let t = bucketStart(range.from, range.grain); t < range.to; t = addBuckets(t, 1, range.grain)) buckets.push(t);
    return buckets;
  }

  // The window a range actually renders as, once widened to whole buckets.
  // `widened` is true only when a bucket edge extends *past* what was asked
  // for — a preset that deliberately ends at the last bucket (all history)
  // is not "widened", it is exactly what it says.
  function renderedWindow(range, buckets) {
    if (!buckets.length) return { from: range.from, to: range.to, widened: false };
    const from = buckets[0];
    const to = addBuckets(buckets[buckets.length - 1], 1, range.grain);
    return { from, to, widened: from !== range.from || to > range.to };
  }

  // a session counts whole when any of its span falls in the range — usage is
  // bucket-attributed, but agents/ch/duration cannot be split across buckets
  function sessionInRange(s, range) {
    if (s?.firstAt == null) return false;
    const last = Math.max(s.lastAt ?? 0, s.firstAt);
    return s.firstAt < range.to && last >= range.from;
  }

  const monthKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };

  const RANGES = {
    HOUR_MS,
    pad2,
    startOfHour, startOfDay, startOfMonth,
    addHours, addDays, addMonths,
    bucketStart, addBuckets,
    grainForSpan, grainAllows,
    rangeBuckets, renderedWindow, sessionInRange,
    monthKey,
  };

  // browser: a plain global for stats.js; test: importable off globalThis
  globalThis.RANGES = RANGES;
})();
