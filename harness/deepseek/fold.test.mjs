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
