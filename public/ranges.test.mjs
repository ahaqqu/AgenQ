// Pins the stats page's range math — the grain rules are what keep a
// day-resolution harness from being charted as if it had hourly detail.
// Run: bun test
import { test, expect } from "bun:test";
import "./ranges.js";

const {
  HOUR_MS, startOfHour, startOfDay, addHours, addDays,
  bucketStart, grainForSpan, grainAllows, rangeBuckets, renderedWindow,
  sessionInRange, bucketOverlapsRange, monthKey,
} = globalThis.RANGES;

// a fixed local instant, so expectations are timezone-independent
const T = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test("grain follows the span: 24h/48h hourly, longer daily", () => {
  expect(grainForSpan(24 * HOUR_MS)).toBe("hour");
  expect(grainForSpan(48 * HOUR_MS)).toBe("hour");
  expect(grainForSpan(48 * HOUR_MS + 1)).toBe("day");
  expect(grainForSpan(7 * 24 * HOUR_MS)).toBe("day");
});

test("a day-resolution harness cannot contribute to an hour-grain range", () => {
  expect(grainAllows("hour", "hour")).toBe(true);
  expect(grainAllows("hour", "day")).toBe(true);
  expect(grainAllows("day", "day")).toBe(true);
  // the case that matters: spreading one day's tokens over 24 bars would
  // invent detail the telemetry does not have
  expect(grainAllows("day", "hour")).toBe(false);
});

test("buckets are whole local hours, and the range's count follows its edges", () => {
  const from = T(2026, 9, 28, 10, 30); // mid-hour start
  const to = T(2026, 9, 28, 13, 15); // mid-hour end
  const buckets = rangeBuckets({ from, to, grain: "hour" });
  // 10:00, 11:00, 12:00, 13:00 — the 13:00 bucket is entered (13:15 falls in
  // it), which is exactly why the renderer must report the widened window
  expect(buckets).toEqual([
    T(2026, 9, 28, 10), T(2026, 9, 28, 11), T(2026, 9, 28, 12), T(2026, 9, 28, 13),
  ]);
  expect(buckets.every((b) => new Date(b).getMinutes() === 0)).toBe(true);
});

test("renderedWindow reports the widening a mid-bucket range needs", () => {
  const from = T(2026, 9, 28, 10, 30);
  const to = T(2026, 9, 28, 13, 15);
  const buckets = rangeBuckets({ from, to, grain: "hour" });
  const win = renderedWindow({ from, to, grain: "hour" }, buckets);
  expect(win.widened).toBe(true);
  expect(win.from).toBe(T(2026, 9, 28, 10));
  expect(win.to).toBe(T(2026, 9, 28, 14)); // ends after the last entered bucket

  // an exactly-on-boundary range is not widened
  const exactFrom = T(2026, 9, 28, 10);
  const exactTo = T(2026, 9, 28, 13);
  const win2 = renderedWindow(
    { from: exactFrom, to: exactTo, grain: "hour" },
    rangeBuckets({ from: exactFrom, to: exactTo, grain: "hour" }),
  );
  expect(win2.widened).toBe(false);
  expect(win2.from).toBe(exactFrom);
  expect(win2.to).toBe(exactTo);
});

test("a day-grain range buckets days, across a month boundary", () => {
  const from = T(2026, 9, 30);
  const to = T(2026, 10, 3);
  const buckets = rangeBuckets({ from, to, grain: "day" });
  expect(buckets).toEqual([T(2026, 9, 30), T(2026, 10, 1), T(2026, 10, 2)]);
  // every bucket is that day's local midnight
  expect(buckets.every((b) => new Date(b).getHours() === 0)).toBe(true);
});

test("hour buckets roll across midnight into the next day", () => {
  const from = T(2026, 9, 28, 23);
  const to = T(2026, 9, 29, 1);
  const buckets = rangeBuckets({ from, to, grain: "hour" });
  expect(buckets).toEqual([T(2026, 9, 28, 23), T(2026, 9, 29, 0)]);
});

test("sessions count when any of their span intersects the range", () => {
  const range = { from: T(2026, 9, 28), to: T(2026, 9, 29), grain: "day" };
  // entirely inside
  expect(sessionInRange({ firstAt: T(2026, 9, 28, 10), lastAt: T(2026, 9, 28, 12) }, range)).toBe(true);
  // straddling the end
  expect(sessionInRange({ firstAt: T(2026, 9, 28, 23), lastAt: T(2026, 9, 29, 2) }, range)).toBe(true);
  // the range is half-open [from, to): an activity landing exactly on `from`
  // is inside it, so the session counts
  expect(sessionInRange({ firstAt: T(2026, 9, 27, 10), lastAt: T(2026, 9, 28) }, range)).toBe(true);
  // ending one millisecond before the start is outside
  expect(sessionInRange({ firstAt: T(2026, 9, 27, 10), lastAt: T(2026, 9, 28) - 1 }, range)).toBe(false);
  // starting exactly at the exclusive end is outside
  expect(sessionInRange({ firstAt: T(2026, 9, 29), lastAt: T(2026, 9, 29, 5) }, range)).toBe(false);
  // entirely before
  expect(sessionInRange({ firstAt: T(2026, 9, 26), lastAt: T(2026, 9, 27) }, range)).toBe(false);
  // no timestamps at all
  expect(sessionInRange({ firstAt: null, lastAt: null }, range)).toBe(false);
});

test("monthKey is the local calendar month", () => {
  expect(monthKey(T(2026, 9, 1))).toBe("2026-09");
  expect(monthKey(T(2026, 12, 31, 23, 59))).toBe("2026-12");
});

test("bucketStart collapses to the bucket at the range's grain", () => {
  const t = T(2026, 9, 28, 14, 37);
  expect(bucketStart(t, "hour")).toBe(T(2026, 9, 28, 14));
  expect(bucketStart(t, "day")).toBe(T(2026, 9, 28));
  // a day-grain row re-bucketed into a day range lands on the same day
  expect(bucketStart(startOfDay(t), "day")).toBe(startOfDay(t));
});

test("every walked bucket is its own bucket start (the invariant DST can break)", () => {
  // A walk that steps by Date arithmetic alone lands on 01:00 after a
  // midnight DST transition; each bucket must still equal bucketStart(itself)
  // or the row→bucket match in stats.js silently drops whole days.
  for (const from of [T(2026, 3, 1), T(2026, 9, 1), T(2026, 10, 20)]) {
    const buckets = rangeBuckets({ from, to: addDays(from, 60), grain: "day" });
    expect(buckets).toHaveLength(60);
    expect(buckets.every((b) => bucketStart(b, "day") === b)).toBe(true);
  }
});

test("a day-grain row always matches a walked day bucket", () => {
  // the failure mode: the walk drifts off midnight, so the row's own
  // bucketStart is not in the walked set and its tokens vanish
  const from = T(2026, 9, 1);
  const buckets = rangeBuckets({ from, to: addDays(from, 45), grain: "day" });
  const index = new Set(buckets);
  for (let d = 0; d < 45; d++) {
    const rowAt = startOfDay(addDays(from, d));
    expect(index.has(bucketStart(rowAt, "day"))).toBe(true);
  }
});

test("bucketOverlapsRange is half-open and grain-aware", () => {
  const dayRange = { from: T(2026, 9, 28), to: T(2026, 9, 29), grain: "day" };
  // a day row on the range's own day overlaps
  expect(bucketOverlapsRange(T(2026, 9, 28, 15), dayRange, "day")).toBe(true);
  // a day bucket ending exactly at `from` does not (the old magic-constant
  // bound counted it, naming harnesses with no usage in the range at all)
  expect(bucketOverlapsRange(T(2026, 9, 27, 0), dayRange, "day")).toBe(false);
  // ...nor one starting exactly at the exclusive end
  expect(bucketOverlapsRange(T(2026, 9, 29), dayRange, "day")).toBe(false);

  const hourRange = { from: T(2026, 9, 28, 10), to: T(2026, 9, 28, 12), grain: "hour" };
  expect(bucketOverlapsRange(T(2026, 9, 28, 10), hourRange, "hour")).toBe(true);
  expect(bucketOverlapsRange(T(2026, 9, 28, 11, 45), hourRange, "hour")).toBe(true);
  // the 09:00 hour bucket runs [09:00, 10:00) and ends exactly at `from`
  expect(bucketOverlapsRange(T(2026, 9, 28, 9, 30), hourRange, "hour")).toBe(false);
  // the 12:00 bucket starts exactly at the exclusive end
  expect(bucketOverlapsRange(T(2026, 9, 28, 12, 0), hourRange, "hour")).toBe(false);
});
