// Pins the todos projection to DSH's own semantics: its `todos` reducer
// returns null at every `turn/start`, so the fold must clear the list there
// too — otherwise a finished turn's plan is presented as current.
// Run: bun test
import { test, expect } from "bun:test";
import { foldEvent, newAgg } from "./fold.mjs";

const ev = (type, data, seq) => ({ type, seq, time: 1_700_000_000_000 + seq * 1000, data });
const todoWrite = (items, seq) =>
  ev("todo/write", { todos: items.map(([content, status]) => ({ content, status })) }, seq);

test("a new turn clears the previous turn's todo list", () => {
  const agg = newAgg();
  foldEvent(agg, todoWrite([["plan the work", "in_progress"], ["do the work", "pending"]], 1));
  expect(agg.todos).toHaveLength(2);
  foldEvent(agg, ev("turn/start", {}, 2));
  expect(agg.todos).toEqual([]);
});

test("a list written after the new turn survives", () => {
  const agg = newAgg();
  foldEvent(agg, todoWrite([["old plan", "completed"]], 1));
  foldEvent(agg, ev("turn/start", {}, 2));
  foldEvent(agg, todoWrite([["new plan", "in_progress"]], 3));
  expect(agg.todos).toEqual([{ content: "new plan", status: "in_progress" }]);
});

// ---------- the stats accumulator (usageByDay) ----------

// 1_700_000_000_000 is a 2023-11-14T22:13:20Z UTC instant; bucket keys are
// the server's LOCAL calendar, so derive the expectation the same way. The
// events below are seconds apart, so they share one local hour whatever the
// machine's timezone is.
const LOCAL_HOUR = (() => {
  const d = new Date(1_700_000_000_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
})();

const assistantMessage = (seq, usage, source) =>
  ev("assistant/message", { turn: 1, step: seq, usage, message: source ? { source } : {} }, seq);

test("usageByDay accumulates only in stats mode", () => {
  const plain = newAgg();
  foldEvent(plain, assistantMessage(1, { inputTokens: 100, outputTokens: 10 }));
  expect(plain.usageByDay).toBe(null);

  const stats = newAgg(null, { withStats: true });
  foldEvent(stats, assistantMessage(1, { inputTokens: 100, outputTokens: 10 }));
  const cell = stats.usageByDay.get(LOCAL_HOUR).get(null).get(null);
  expect(cell).toEqual({ requests: 1, inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheCreate: 0 });
});

test("a request counts even when the log measured no tokens", () => {
  const agg = newAgg(null, { withStats: true });
  foldEvent(agg, assistantMessage(1, {})); // aborted/empty response — nothing measured
  const cell = agg.usageByDay.get(LOCAL_HOUR).get(null).get(null);
  expect(cell.requests).toBe(1);
  expect(cell.inputTokens).toBe(0);
  expect(cell.outputTokens).toBe(0);
});

test("prompt tokens include cache reads and rows separate by provider+model", () => {
  const agg = newAgg(null, { withStats: true });
  foldEvent(agg, ev("model/selection", { provider: "prov-a", model: "m1" }, 1));
  foldEvent(agg, assistantMessage(2, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 500, cacheWriteTokens: 20 }));
  foldEvent(agg, assistantMessage(3, { inputTokens: 30, outputTokens: 4 }, { provider: "prov-b", model: "m2" }));
  const day = agg.usageByDay.get(LOCAL_HOUR);
  const a = day.get("prov-a").get("m1");
  const b = day.get("prov-b").get("m2");
  expect(a.inputTokens).toBe(600); // 100 prompt + 500 cache read, the board's input semantics
  expect(a.requests).toBe(1);
  expect(b.requests).toBe(1);
  expect(b.inputTokens).toBe(30);
});

test("requests more than an hour apart land in different buckets", () => {
  const agg = newAgg(null, { withStats: true });
  foldEvent(agg, assistantMessage(1, { inputTokens: 100, outputTokens: 10 }));
  // 90 minutes later — a different local hour unless the first event sits in
  // the last 30 minutes of its hour, in which case the clock still moved on
  const later = 1_700_000_000_000 + 90 * 60_000;
  foldEvent(agg, { type: "assistant/message", seq: 2, time: later, data: { turn: 1, step: 2, usage: { inputTokens: 200, outputTokens: 20 } } });
  expect(agg.usageByDay.size).toBe(2);
  const total = [...agg.usageByDay.values()].reduce((n, byP) => n + byP.get(null).get(null).inputTokens, 0);
  expect(total).toBe(300);
});
