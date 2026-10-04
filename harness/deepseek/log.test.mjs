// Pins the log-cache contract between the three surfaces that share one
// decoded entry: the board (aggregate only), the stats walk (aggregate only,
// now always including the per-hour accumulator), and an open conversation tab
// (aggregate + record buffer). The bug this guards against is a rebuild
// silently dropping or duplicating the conversation buffer, which cost the
// conversation tab a second full decode of the same log.
// Run: bun test
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAggregate, recordsOf, resubscribe, subscribe, unsupportedGeneration } from "./log.mjs";

const dirs = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// a small plain (uncompressed) log: header + two user messages + two requests
function fixtureLog() {
  const dir = mkdtempSync(join(tmpdir(), "agenq-log-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const lines = [
    { type: "session/header", seq: 0, time: 1_700_000_000_000, data: { version: 3, cwd: "/home/u/Projects/demo", createdAt: 1_700_000_000_000 } },
    { type: "user/message", seq: 1, time: 1_700_000_001_000, data: { turn: 1, text: "first" } },
    { type: "assistant/message", seq: 2, time: 1_700_000_002_000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 }, message: { source: { provider: "p", model: "m" } } } },
  ];
  appendFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("a plain stats read never disturbs a live conversation buffer", () => {
  const path = fixtureLog();
  const agg = subscribe(path);
  const before = recordsOf(path).length;
  expect(before).toBeGreaterThan(0);
  // the stats walk and the board both call readAggregate without collect
  readAggregate(path);
  expect(recordsOf(path)).toHaveLength(before);
  expect(agg.requests).toBe(1);
});

test("a rebuild rebuilds the buffer instead of duplicating it", () => {
  const path = fixtureLog();
  subscribe(path);
  const before = recordsOf(path).length;
  resubscribe(path); // forces the full re-decode path
  expect(recordsOf(path)).toHaveLength(before);
  expect(readAggregate(path).requests).toBe(1);
});

test("a rebuild keeps a live buffer live, so the tab's next poll reuses it", () => {
  const path = fixtureLog();
  subscribe(path);
  // a rebuild triggered by the stats path (no collect requested): the buffer
  // was live, so it must still be there — otherwise the conversation tab pays
  // a second full decode on its next poll
  readAggregate(path, { reset: true });
  expect(recordsOf(path)).not.toBeNull();
  expect(recordsOf(path).length).toBeGreaterThan(0);
});

test("an entry the board warmed already carries the stats accumulator", () => {
  const path = fixtureLog();
  const agg = readAggregate(path); // as the board reads it
  expect(agg.usageByHour).toBeInstanceOf(Map);
  // and it is populated, so a later stats walk needs no re-decode
  expect(agg.usageByHour.size).toBeGreaterThan(0);
});

test("append-only growth stays incremental and keeps counting", () => {
  const path = fixtureLog();
  expect(readAggregate(path).requests).toBe(1);
  appendFileSync(path, JSON.stringify({ type: "assistant/message", seq: 3, time: 1_700_000_003_000, data: { turn: 2, step: 1, usage: { inputTokens: 50, outputTokens: 5 }, message: { source: { provider: "p", model: "m" } } } }) + "\n");
  const agg = readAggregate(path);
  expect(agg.requests).toBe(2);
  expect(agg.inputTokens).toBe(150);
});

test("unsupportedGeneration reports only generations outside the supported set", () => {
  expect(unsupportedGeneration({ header: { version: 3 } })).toBe(null);
  expect(unsupportedGeneration({ header: { version: 99 } })).toBe(99);
  expect(unsupportedGeneration({ header: {} })).toBe(null); // no version: not a refusal
  expect(unsupportedGeneration(null)).toBe(null);
});
