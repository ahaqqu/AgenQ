// OpenCode adapter unit tests: the token fold the board's cache-hit rule
// depends on, and the tool-part shapes the ticker / detail panel read.
import { test, expect } from "bun:test";
import { usageFromSessionColumns, usageFromTokens } from "./tokens.mjs";
import { partText, toolEntry, toolInput, toolParts } from "./parts.mjs";

test("usageFromTokens folds cache reads into board input", () => {
  const u = usageFromTokens({ input: 11494, output: 242, reasoning: 144, cache: { read: 28672, write: 0 } });
  expect(u.inputTokens).toBe(11494 + 28672);
  expect(u.outputTokens).toBe(242);
  expect(u.cacheRead).toBe(28672);
  expect(u.cacheCreate).toBe(0);
  expect(u.reasoningTokens).toBe(144);
  expect(u.prompt).toBe(11494 + 28672);
  expect(u.cacheRead / u.inputTokens).toBeLessThanOrEqual(1);
});

test("usageFromTokens tolerates missing cache and empty tokens", () => {
  expect(usageFromTokens({ input: 10, output: 2 }).inputTokens).toBe(10);
  expect(usageFromTokens(null).inputTokens).toBe(0);
  expect(usageFromTokens({}).prompt).toBe(0);
});

test("a session's cumulative counters fold the same way", () => {
  const u = usageFromSessionColumns({
    tokens_input: 300,
    tokens_output: 30,
    tokens_reasoning: 10,
    tokens_cache_read: 130,
    tokens_cache_write: 0,
  });
  expect(u.inputTokens).toBe(430);
  expect(u.outputTokens).toBe(30);
  expect(u.cacheRead).toBe(130);
  expect(u.reasoningTokens).toBe(10);
  // an install that never wrote a counter column reads as zero, not NaN
  expect(usageFromSessionColumns({}).inputTokens).toBe(0);
});

const tool = (state, time) => ({ type: "tool", name: "shell", state, time });

test("tool status maps to the ticker's vocabulary", () => {
  expect(toolEntry(tool({ status: "completed" })).status).toBe("ok");
  expect(toolEntry(tool({ status: "error" })).status).toBe("error");
  // a call still in flight keeps the harness's own word
  expect(toolEntry(tool({ status: "running" })).status).toBe("running");
});

test("tool output size is whatever the harness actually stored", () => {
  // bash/write store a string
  expect(toolEntry(tool({ status: "completed", content: "file.txt" })).outputBytes).toBe(8);
  // read/grep store a structured list
  expect(toolEntry(tool({ status: "completed", content: [{ path: "a" }] })).outputBytes).toBe(14);
  // pre-v2 rows kept the output in metadata
  expect(toolEntry(tool({ status: "completed", metadata: { output: "abcd" } })).outputBytes).toBe(4);
  expect(toolEntry(tool({ status: "completed" })).outputBytes).toBe(0);
});

test("a still-running call takes its time from the message, not the part", () => {
  const at = 1234;
  expect(toolEntry(tool({ status: "running" }), at).at).toBe(at);
  // a finished call reports its own completion instant
  expect(toolEntry(tool({ status: "completed" }, { created: 5, completed: 7 }), at).at).toBe(7);
  expect(toolEntry(tool({ status: "completed" }), at).at).toBe(at);
  // exit code lives in the metadata opencode writes for shells
  expect(toolEntry(tool({ status: "completed", metadata: { exit: 1 } })).exitCode).toBe(1);
});

test("part text and tool input are plain strings, capped by the caller", () => {
  expect(partText({ text: "hello" })).toBe("hello");
  expect(partText({ text: 42 })).toBe("");
  expect(partText(null)).toBe("");
  expect(toolInput({ state: { input: { command: "ls" } } })).toBe('{"command":"ls"}');
  expect(toolInput({ state: { input: "abcdef" } }, 2)).toBe("ab");
  expect(toolInput({ state: {} })).toBeNull();
});

test("toolParts only ever returns tool blocks", () => {
  const parts = toolParts({ content: [{ type: "text", text: "a" }, { type: "tool", name: "read" }] });
  expect(parts).toHaveLength(1);
  expect(parts[0].name).toBe("read");
  expect(toolParts(null)).toEqual([]);
  expect(toolParts({ content: null })).toEqual([]);
});
