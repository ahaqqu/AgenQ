// AgenQ Hermes snapshot assembly: one poll's read-only view of hermes's
// telemetry. Reads the state DB (read-only, fresh connection per poll) and
// folds sessions, per-task usage, todos, tool calls and errors into one
// JSON-able snapshot. Pure-ish: no server, no sockets.
import { Database } from "bun:sqlite";
import { cfg, WINDOW_MS } from "./config.mjs";

function roDb() {
  // Fresh read-only connection per poll: long-lived WAL readers get
  // invalidated by checkpoints, per-poll connections don't. A DB that
  // isn't there (Hermes never ran on this machine) returns null and the
  // adapter returns the empty shape instead of crashing the server.
  try {
    return new Database(cfg.db, { readonly: true });
  } catch {
    return null;
  }
}

function rows(db, sql, params = []) {
  if (!db) return [];
  return db.prepare(sql).all(...params);
}

function gatherDb() {
  const db = roDb();
  try {
    // A DB missing the expected tables (old hermes build, foreign SQLite in
    // the path) degrades to fewer rows, never an error — same rule as
    // zcode's: fail empty, never fail the poll.
    const q = (sql) => {
      try {
        return rows(db, sql);
      } catch {
        return [];
      }
    };

    const sessions = q(`
      SELECT id, title, display_name, parent_session_id, model, cwd, model_config,
             started_at, ended_at, end_reason, last_activity_at,
             message_count, api_call_count,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             reasoning_tokens, handoff_error, compression_failure_error,
             archived, hidden
      FROM sessions`);

    // Per-task API usage: the main task row (task = '') carries the
    // conversation's totals; housekeeping tasks (title_generation,
    // background_review, approval) still burned API calls and are kept as
    // extra sparkline points. Ordered by first_seen for request-order series.
    const usage = q(`
      SELECT session_id, task, api_call_count, input_tokens, output_tokens,
             reasoning_tokens, last_seen
      FROM session_model_usage ORDER BY first_seen`);

    const tools = q(`
      SELECT session_id, role, tool_name, tool_call_id, tool_calls, content,
             finish_reason, timestamp, active
      FROM messages
      WHERE role IN ('assistant', 'tool') AND tool_name IS NOT NULL
      ORDER BY timestamp DESC LIMIT 60`);

    const todos = q(`
      SELECT session_id, content, timestamp FROM messages
      WHERE role = 'tool' AND tool_name = 'todo'
      ORDER BY timestamp DESC LIMIT 40`);

    return { sessions, usage, tools, todos };
  } finally {
    db?.close();
  }
}

// ---------- row -> session mapping ----------

const SPARK_TAIL = 120; // sparkline points per agent
export const ACTIVE_MS = 5 * 60_000; // heartbeat within this = active; idle past it = sleep

const s2ms = (t) => (t == null ? null : Math.round(Number(t) * 1000));

// thinking level of a session's latest model config; hermes stores it in
// model_config.reasoning_config (enabled + effort), "" = disabled
function thinkingOf(modelConfig) {
  try {
    const rc = JSON.parse(modelConfig ?? "{}")?.reasoning_config;
    if (!rc?.enabled) return null;
    return String(rc.effort || "").trim() || null;
  } catch {
    return null;
  }
}

// Hermes's own child taxonomy lives in model_config markers (see
// hermes_state_schema.py v16): _delegate_from = delegate subagent,
// _branched_from / _reset_from = continuations of the same conversation.
const childKind = (modelConfig) => {
  try {
    const mc = JSON.parse(modelConfig ?? "{}");
    if (mc._delegate_from != null) return "delegate";
    if (mc._branched_from != null) return "branch";
    if (mc._reset_from != null) return "reset";
  } catch { /* malformed config — treat as main */ }
  return null;
};

// tool results are JSON objects ({output, exit_code, error, success, …});
// a parse failure or error/success flag decides the status word the same
// way the zcode adapter's statuses read
function toolStatus(content) {
  try {
    const d = JSON.parse(content);
    if (d && (d.error != null || d.success === false)) return "error";
  } catch {
    // non-JSON result bodies still completed
  }
  return "completed";
}

const todoStatus = (st) => (st === "completed" ? "done" : String(st ?? "pending"));

function assemble({ sessions, usage, tools, todos, now }) {
  const cutoff = now - WINDOW_MS;

  const usageBySession = new Map();
  for (const u of usage) {
    if (!usageBySession.has(u.session_id)) usageBySession.set(u.session_id, []);
    usageBySession.get(u.session_id).push(u);
  }

  // latest todo list per session
  const todosBySession = new Map();
  for (const t of todos) {
    if (todosBySession.has(t.session_id)) continue; // rows come newest first
    try {
      const list = JSON.parse(t.content)?.todos;
      if (Array.isArray(list)) {
        todosBySession.set(
          t.session_id,
          list.map((x) => ({ content: String(x.content ?? ""), status: todoStatus(x.status) })),
        );
      }
    } catch { /* malformed todo payload — skip */ }
  }

  // most recent tool call per session (tool result rows only — the result
  // proves the call ran, and its JSON carries the error state)
  const toolBySession = new Map();
  const ticker = [];
  for (const t of tools) {
    if (t.role !== "tool" || !t.tool_name) continue;
    if (!toolBySession.has(t.session_id)) {
      toolBySession.set(t.session_id, {
        name: t.tool_name,
        outputBytes: t.content ? t.content.length : null,
        status: toolStatus(t.content),
        at: s2ms(t.timestamp),
      });
    }
    ticker.push({
      sessionId: t.session_id,
      tool: t.tool_name,
      outputBytes: t.content ? t.content.length : null,
      status: toolStatus(t.content),
      exitCode: (() => {
        try { return JSON.parse(t.content)?.exit_code ?? null; } catch { return null; }
      })(),
      at: s2ms(t.timestamp),
    });
  }

  const all = new Map();
  for (const s of sessions) {
    if (s.archived || s.hidden) continue;
    const kind = childKind(s.model_config);
    const subagent = kind === "delegate";
    const directory = s.cwd ?? null;
    const project = directory ? (directory.split("/").filter(Boolean).pop() ?? null) : null;
    const ended = s.ended_at != null;

    // hermes reports usage per task, not per API call; the sparkline plots
    // each task's average input per call (the request-size signal the board
    // is for), clamped to the tail
    const sparkline = [];
    for (const u of usageBySession.get(s.id) ?? []) {
      const n = Math.max(Number(u.api_call_count ?? 0), 0);
      if (n > 0) {
        const avg = Math.round(Number(u.input_tokens ?? 0) / n);
        for (let i = 0; i < n; i++) sparkline.push(avg);
      }
    }

    const firstAt = s2ms(s.started_at) ?? 0;
    const lastAt = Math.max(s2ms(s.last_activity_at) ?? 0, firstAt);
    const errors = [];
    if (s.handoff_error) errors.push(s.handoff_error);
    if (s.compression_failure_error) errors.push(s.compression_failure_error);

    // status: failure > finished > activity recency. `live` stays null —
    // hermes sessions live inside shared backend processes (gateway,
    // tui-gateway) whose per-session liveness is not readable anywhere
    // AgenQ trusts, so the adapter makes no claim (no exit dimming).
    const status = (() => {
      if (errors.length) return "failed";
      if (ended) return "done";
      const lastSeen = s2ms(
        (usageBySession.get(s.id) ?? []).reduce((m, u) => Math.max(m, Number(u.last_seen ?? 0)), 0),
      );
      if (lastSeen && now - lastSeen <= ACTIVE_MS) return "running";
      if (lastAt && now - lastAt <= ACTIVE_MS) return "running";
      return "sleep";
    })();

    all.set(s.id, {
      id: s.id,
      title: s.title ?? (s.display_name ? String(s.display_name) : null),
      parentId: s.parent_session_id ?? null,
      project,
      directory,
      role: subagent ? "subagent" : null,
      model: s.model ?? null,
      thinking: thinkingOf(s.model_config),
      status,
      requests: Number(s.api_call_count ?? 0),
      inputTokens: Number(s.input_tokens ?? 0),
      outputTokens: Number(s.output_tokens ?? 0),
      cacheRead: Number(s.cache_read_tokens ?? 0),
      cacheCreate: Number(s.cache_write_tokens ?? 0),
      maxContext: Math.max(0, ...sparkline),
      firstAt,
      lastAt,
      sparkline: sparkline.slice(-SPARK_TAIL),
      lastError: errors.length
        ? { type: "handoff_failed", message: String(errors[0]), at: lastAt }
        : null,
      todos: todosBySession.get(s.id) ?? [],
      lastTool: toolBySession.get(s.id) ?? null,
      children: [],
    });
  }

  // tree edges + the two-pass keep rule: keep sessions with a heartbeat in
  // the window, then any ancestor of a kept session (a parent whose own
  // row is windowed out still anchors its subtree)
  const keep = new Set();
  for (const s of all.values()) {
    if (Math.max(s.lastAt ?? 0, s.firstAt ?? 0) >= cutoff) {
      keep.add(s.id);
      let p = s.parentId;
      while (p && !keep.has(p)) {
        keep.add(p);
        p = all.get(p)?.parentId ?? null;
      }
    }
  }

  const sessionsOut = [...all.values()]
    .filter((s) => keep.has(s.id))
    .map((s) => ({ ...s, children: s.children.filter((c) => keep.has(c)) }));
  const byId = new Map(sessionsOut.map((s) => [s.id, s]));

  const tickerKept = ticker
    .filter((t) => keep.has(t.sessionId))
    .slice(0, 15)
    .map((t) => ({ ...t, sessionId: t.sessionId }));

  return {
    generatedAt: now,
    windowHours: cfg.windowHours,
    sessions: sessionsOut,
    roots: sessionsOut.filter((s) => !s.parentId || !byId.has(s.parentId)).map((s) => s.id),
    ticker: tickerKept,
  };
}

export async function snapshot({ now = Date.now() } = {}) {
  const data = gatherDb();
  return assemble({ ...data, now });
}