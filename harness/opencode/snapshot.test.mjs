// OpenCode adapter integration tests against a throwaway post-v2 database.
// testenv.mjs must be the first import: it points OPENCODE_DB at the
// fixture before config.mjs reads it (see the header there).
import { build, cleanup, now, dbPath, legacyPath, missingPath } from "./testenv.mjs";
import { test, expect, beforeAll, afterAll } from "bun:test";
import adapter from "./index.mjs";
import { resetStats } from "./stats.mjs";

const MIN = 60_000;
const HOUR = 3_600_000;

beforeAll(() => {
  build();
  resetStats();
});

afterAll(() => cleanup());

const byId = (snap, id) => snap.sessions.find((s) => s.id === id);

test("config reads every configured source (post-v2, pre-v2 and missing)", async () => {
  const snap = await adapter.snapshot(Date.now());
  // the pre-v2 dir and the absent path must not throw or warn
  expect(snap.warnings).toEqual([]);
  expect(snap.sessions.map((s) => s.id).sort()).toEqual(["ses_aaa", "ses_bbb"]);
  expect(snap.sessions.some((s) => s.id === "ses_old")).toBe(false);
  expect(dbPath).toContain("opencode.db");
  expect(legacyPath).toContain("legacy.db");
  expect(missingPath).toContain("never-created");
});

test("root runs read as main; subagents carry their agent as the role", async () => {
  const snap = await adapter.snapshot(Date.now());
  expect(snap.roots).toEqual(["ses_aaa"]);
  const a = byId(snap, "ses_aaa");
  const b = byId(snap, "ses_bbb");
  expect(a.role).toBeNull();
  expect(a.description).toBeNull();
  expect(a.children).toEqual(["ses_bbb"]);
  expect(b.role).toBe("explore");
  expect(b.parentId).toBe("ses_aaa");
  // the UI groups sibling instances by parentSessionId
  expect(b.parentSessionId).toBe("ses_aaa");
  expect(b.description).toBe("Find the API call (@explore subagent)");
  expect(b.children).toEqual([]);
});

test("totals come from the session row, the sparkline from its messages", async () => {
  const a = byId(await adapter.snapshot(Date.now()), "ses_aaa");
  // board input includes the cached part
  expect(a.inputTokens).toBe(300 + 130);
  expect(a.outputTokens).toBe(30);
  expect(a.cacheRead).toBe(130);
  expect(a.cacheCreate).toBe(0);
  expect(a.reasoningTokens).toBe(10);
  expect(a.requests).toBe(3);
  expect(a.sparkline).toEqual([100 + 50, 200 + 80, 300]);
  expect(a.maxContext).toBe(300);
  expect(a.model).toBe("muse-spark-1.3-contributor-free");
  expect(a.provider).toBe("opencode");
  expect(a.thinking).toBe("reasoning");
  expect(a.project).toBe("demo");
  expect(a.directory).toBe("C:/Fun/Projects/demo");
});

test("no row or detail payload reports a context window", async () => {
  // the cliff every card draws against is the UI's 200k constant; an
  // adapter reporting a model's real window would move it (PR #36 did)
  expect(byId(await adapter.snapshot(Date.now()), "ses_aaa")).not.toHaveProperty("contextWindow");
  expect(adapter.detail("ses_aaa")).not.toHaveProperty("modelWindow");
});

test("status is heartbeat recency, and a later success clears a failure", async () => {
  const snap = await adapter.snapshot(Date.now());
  const a = byId(snap, "ses_aaa");
  expect(a.status).toBe("running"); // last write 20s ago
  expect(a.lastError).toBeNull();
  const b = byId(snap, "ses_bbb");
  expect(b.status).toBe("sleep"); // last write 9m ago
  // the rate limit at -11m is older than the success at -9m
  expect(b.lastError).toBeNull();
});

test("todos, the tool trail and the ticker", async () => {
  const snap = await adapter.snapshot(Date.now());
  const a = byId(snap, "ses_aaa");
  expect(a.todos).toEqual([
    { content: "wire the adapter", status: "done" },
    { content: "run the smoke test", status: "in_progress" },
  ]);
  expect(a.lastTool).toEqual({
    name: "shell",
    status: "ok",
    outputBytes: "file.txt".length,
    at: now - 20_000,
    exitCode: null,
  });
  expect(snap.ticker.some((t) => t.sessionId === "ses_aaa" && t.tool === "shell" && t.status === "ok")).toBe(true);
  expect(byId(snap, "ses_bbb").todos).toEqual([]);
});

test("archived sessions and sessions older than the window stay off the board", async () => {
  const snap = await adapter.snapshot(Date.now());
  expect(snap.sessions.map((s) => s.id)).not.toContain("ses_ccc"); // archived
  expect(snap.sessions.map((s) => s.id)).not.toContain("ses_ddd"); // 48h old
  expect(byId(snap, "ses_aaa").firstAt).toBe(now - 3 * HOUR);
});

test("detail fills every panel slot the payload defines", async () => {
  const d = adapter.detail("ses_aaa");
  expect(d.title).toBe("Mission control demo");
  expect(d.directory).toBe("C:/Fun/Projects/demo");
  expect(d.currentTool).toMatchObject({ name: "shell", status: "completed" });
  expect(d.currentTool.input).toContain("ls");
  expect(d.thinking.text).toBe("checking the window binding");
  expect(d.turns).toHaveLength(3);
  expect(d.turns[0].input_tokens).toBe(300); // newest first
  expect(d.tokens).toEqual({
    input: 430,
    output: 30,
    cacheRead: 130,
    cacheCreate: 0,
    reasoning: 10,
    requests: 3,
    maxContext: 300,
  });
  expect(d.errors).toEqual([]);
  expect(d.todos).toHaveLength(2);
  expect(d.diff).toEqual({ additions: 12, deletions: 3, files: 4 });
});

test("detail reports a subagent's errors without reviving them on the card", async () => {
  const d = adapter.detail("ses_bbb");
  expect(d.errors).toHaveLength(1);
  expect(d.errors[0]).toMatchObject({ type: "provider.quota", message: "Rate limit exceeded." });
  expect(d.turns).toHaveLength(1); // the error row carries no usage
  expect((await adapter.snapshot(Date.now())).sessions.find((s) => s.id === "ses_bbb").lastError).toBeNull();
});

test("detail of a session no source holds is null, not a throw", () => {
  expect(adapter.detail("ses_nope")).toBeNull();
});

test("the conversation feed is cursor-resumable", async () => {
  const first = await adapter.messages("ses_aaa", null);
  expect(first.title).toBe("Mission control demo");
  expect(first.cursor).toBe("s:4");
  expect(first.items.map((i) => `${i.kind}:${i.role}`)).toEqual([
    "text:user",
    "thinking:assistant",
    "text:assistant",
    "thinking:assistant",
    "tool:assistant",
  ]);
  expect(first.items[0].text).toBe("build it");
  expect(first.items[4]).toMatchObject({ tool: "shell", status: "completed" });

  const resume = await adapter.messages("ses_aaa", first.cursor);
  expect(resume.items).toEqual([]);
  expect(resume.cursor).toBe("s:4");

  const bad = await adapter.messages("ses_aaa", "hermes:9999");
  expect(bad.items.length).toBeGreaterThan(0); // foreign cursor recovers
});

test("stats reports hour grain, full history and the board's exclusions", async () => {
  const st = await adapter.stats();
  expect(st.grain).toBe("hour");
  expect(st.coverage.from).toBeLessThan(st.coverage.to);
  expect(st.notes).toHaveLength(3);

  // usage is bucketed by local hour and grouped by project/provider/model
  const muse = st.usage.filter((u) => u.model === "muse-spark-1.3-contributor-free");
  expect(muse.length).toBeGreaterThan(0);
  expect(muse.reduce((n, u) => n + u.requests, 0)).toBe(3);
  expect(muse[0].project).toBe("demo");
  expect(muse[0].provider).toBe("opencode");
  // an hour boundary in the server's own calendar, not an arbitrary instant
  const bucket = new Date(muse[0].at);
  expect([bucket.getMinutes(), bucket.getSeconds(), bucket.getMilliseconds()]).toEqual([0, 0, 0]);

  // sessions: on-board runs plus long history, archived excluded
  expect(st.sessions).toHaveLength(3);
  expect(st.sessions.filter((s) => s.isSubagent).map((s) => s.project)).toEqual(["demo"]);
  expect(st.sessions.some((s) => s.project === "elsewhere")).toBe(true);
  // C (archived) shares demo's directory, so count is the tell
  expect(st.sessions.filter((s) => s.project === "demo")).toHaveLength(2);
});
