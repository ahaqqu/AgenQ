// Test-only fixture for the OpenCode adapter — NOT production code.
//
// It writes a throwaway post-v2 `opencode.db` (plus a pre-v2 one and a path
// that does not exist) and points the adapter's config at them. It has to be
// imported *before* `config.mjs`, because that module reads `OPENCODE_DB`
// once at import time — hence snapshot.test.mjs lists this file first.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dir = mkdirSync(join(tmpdir(), `agenq-opencode-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
  recursive: true,
});

export const dbPath = join(dir, "opencode.db");
export const legacyPath = join(dir, "legacy.db");
export const missingPath = join(dir, "never-created.db");

// three sources at once: a real post-v2 install, a pre-v2 one that must be
// skipped, and a path that is not there at all
process.env.OPENCODE_DB = [dbPath, legacyPath, missingPath].join(",");

export const now = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;

const SCHEMA = `
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT,
    slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, agent TEXT, model TEXT,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
    tokens_cache_write INTEGER DEFAULT 0,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER
  );
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT
  );
  CREATE TABLE todo (
    session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER,
    time_created INTEGER, time_updated INTEGER
  );
  CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
  -- covering indexes for the adapter's per-poll access pattern: the
  -- session's assistant rows newest-first, and its todos in order
  CREATE INDEX idx_session_message_session ON session_message(session_id, type, seq);
  CREATE INDEX idx_todo_session ON todo(session_id);
`;

function session(db, s) {
  db.prepare(`INSERT INTO session_v2 (
      id, project_id, parent_id, directory, title, agent, model,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      summary_additions, summary_deletions, summary_files,
      time_created, time_updated, time_archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    s.id,
    "global",
    s.parentId ?? null,
    s.directory,
    s.title,
    s.agent,
    JSON.stringify(s.model),
    s.tokens?.input ?? 0,
    s.tokens?.output ?? 0,
    s.tokens?.reasoning ?? 0,
    s.tokens?.cacheRead ?? 0,
    s.tokens?.cacheWrite ?? 0,
    s.diff?.additions ?? 0,
    s.diff?.deletions ?? 0,
    s.diff?.files ?? 0,
    s.createdAt,
    s.updatedAt,
    s.archivedAt ?? null,
  );
}

function message(db, m) {
  db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.id, m.sessionId, m.type, m.seq, m.at, m.at, JSON.stringify(m.data));
}

const MUSE = { id: "muse-spark-1.3-contributor-free", providerID: "opencode" };
const UNKNOWN = { id: "some-other-model", providerID: "opencode" };

export function build() {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO project VALUES (?, ?, ?)`).run("global", "/", null);

  // A — the root run, alive, with a tool call and a plan
  session(db, {
    id: "ses_aaa",
    parentId: null,
    directory: "C:/Fun/Projects/demo",
    title: "Mission control demo",
    agent: "build",
    model: MUSE,
    tokens: { input: 300, output: 30, reasoning: 10, cacheRead: 130 },
    diff: { additions: 12, deletions: 3, files: 4 },
    createdAt: now - 3 * HOUR,
    updatedAt: now - 30_000,
  });
  message(db, { id: "m1", sessionId: "ses_aaa", type: "user", seq: 1, at: now - 3 * HOUR, data: { text: "build it", time: { created: now - 3 * HOUR } } });
  message(db, {
    id: "m2", sessionId: "ses_aaa", type: "assistant", seq: 2, at: now - 2 * HOUR,
    data: {
      tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } },
      model: MUSE,
      time: { created: now - 2 * HOUR, completed: now - 2 * HOUR + 1000 },
      content: [
        { type: "reasoning", text: "planning the shape of the adapter" },
        { type: "text", text: "here is the plan" },
      ],
    },
  });
  message(db, {
    id: "m3", sessionId: "ses_aaa", type: "assistant", seq: 3, at: now - 60_000,
    data: {
      tokens: { input: 200, output: 20, cache: { read: 80, write: 0 } },
      model: MUSE,
      time: { created: now - 61_000, completed: now - 60_000 },
      content: [{ type: "reasoning", text: "checking the window binding" }],
    },
  });
  message(db, {
    id: "m4", sessionId: "ses_aaa", type: "assistant", seq: 4, at: now - 20_000,
    data: {
      tokens: { input: 300, output: 30, cache: { read: 0, write: 0 } },
      model: MUSE,
      time: { created: now - 25_000, completed: now - 20_000 },
      content: [
        {
          type: "tool",
          name: "shell",
          state: { status: "completed", input: { command: "ls" }, content: "file.txt" },
          time: { created: now - 25_000, completed: now - 20_000 },
        },
      ],
    },
  });
  for (const [pos, content, status] of [
    [0, "wire the adapter", "completed"],
    [1, "run the smoke test", "in_progress"],
  ]) {
    db.prepare(`INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "ses_aaa", content, status, "high", pos, now - 2 * HOUR, now - 2 * HOUR,
    );
  }

  // B — a subagent whose rate limit was cleared by a later success
  session(db, {
    id: "ses_bbb",
    parentId: "ses_aaa",
    directory: "C:/Fun/Projects/demo",
    title: "Find the API call (@explore subagent)",
    agent: "explore",
    model: UNKNOWN,
    createdAt: now - 20 * MIN,
    updatedAt: now - 10 * MIN,
  });
  message(db, {
    id: "m5", sessionId: "ses_bbb", type: "assistant", seq: 1, at: now - 11 * MIN,
    data: { error: { type: "provider.quota", message: "Rate limit exceeded." }, time: { created: now - 11 * MIN, completed: now - 11 * MIN + 500 } },
  });
  message(db, {
    id: "m6", sessionId: "ses_bbb", type: "assistant", seq: 2, at: now - 9 * MIN,
    data: { tokens: { input: 50, output: 5, cache: { read: 0, write: 0 } }, model: UNKNOWN, time: { created: now - 9 * MIN, completed: now - 9 * MIN + 400 } },
  });

  // C — archived: the board and the dashboard both exclude it
  session(db, {
    id: "ses_ccc", parentId: null, directory: "C:/Fun/Projects/demo",
    title: "Filed away", agent: "build", model: UNKNOWN,
    createdAt: now - 5 * HOUR, updatedAt: now - 4 * HOUR, archivedAt: now - 3 * HOUR,
  });

  // D — older than the window: off the board, still in long history
  session(db, {
    id: "ses_ddd", parentId: null, directory: "C:/Fun/Projects/elsewhere",
    title: "Long cold history", agent: "build", model: UNKNOWN,
    tokens: { input: 10, output: 1 },
    createdAt: now - 50 * HOUR, updatedAt: now - 48 * HOUR,
  });
  message(db, {
    id: "m7", sessionId: "ses_ddd", type: "assistant", seq: 1, at: now - 48 * HOUR,
    data: { tokens: { input: 10, output: 1, cache: { read: 0, write: 0 } }, model: UNKNOWN, time: { created: now - 48 * HOUR, completed: now - 48 * HOUR + 100 } },
  });

  db.close();

  // a pre-v2 data dir: no session_v2 table at all — must be skipped whole
  const legacy = new Database(legacyPath);
  legacy.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);`);
  legacy.exec(`INSERT INTO session VALUES ('ses_old', '/old', 'pre-v2', ${now - 90 * HOUR}, ${now - 89 * HOUR});`);
  legacy.close();
}

export function cleanup() {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}
