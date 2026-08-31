// AgenQ Hermes snapshot assembly: one poll's read-only view of hermes's
// telemetry. Reads the state DB (read-only, fresh connection per poll) and
// folds sessions, per-task usage, todos, tool calls and errors into one
// JSON-able snapshot. Pure-ish: no server, no sockets.
import { cfg, WINDOW_MS } from "./config.mjs";
import { roDb, rows, s2ms, projectFromDir, keepInWindow } from "../lib.mjs";
import { toolResult } from "./toolresult.mjs";

// Schema handling mirrors zcode's real policy: a DB that isn't there (or has
// no sessions table — not installed, or a foreign SQLite in the path) fails
// empty; unexpected query errors on an installed harness THROW so the
// registry surfaces them as user-visible board warnings.
// A table that only sometimes exists (hermes builds drift) degrades to [].
function gatherDb() {
  const db = roDb(cfg.db);
  if (!db) return { sessions: [], usage: [], tools: [], todos: [] };
  try {
    let tables;
    try {
      tables = new Set(
        rows(db, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name),
      );
    } catch {
      return { sessions: [], usage: [], tools: [], todos: [] };
    }
    if (!tables.has("sessions")) return { sessions: [], usage: [], tools: [], todos: [] };

    const run = (name, sql) => {
      try {
        return rows(db, sql);
      } catch (e) {
        throw new Error(`query ${name}: ${e.message}`);
      }
    };
    const optional = (sql) => {
      try {
        return rows(db, sql);
      } catch {
        return []; // older builds may lack this table
      }
    };

    const sessions = run("sessions", `
      SELECT id, title, display_name, parent_session_id, model, cwd, model_config,
             started_at, ended_at, last_activity_at, api_call_count,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             handoff_error, compression_failure_error, archived, hidden
      FROM sessions`);

    // Per-task API usage: the main task row (task = '') carries the
    // conversation's totals; housekeeping tasks (title_generation,
    // background_review, approval) still burned API calls and are kept as
    // extra sparkline points. Ordered by first_seen for request-order series.
    const usage = optional(`
      SELECT session_id, task, api_call_count, input_tokens, output_tokens, last_seen
      FROM session_model_usage ORDER BY first_seen`);

    // Soft-archived transcript rows (active = 0) are taken-back turns —
    // hermes's rewind/undo and compaction keep them on disk deliberately;
    // they must not resurrect as recent activity.
    const tools = optional(`
      SELECT session_id, tool_name, content, timestamp FROM messages
      WHERE role = 'tool' AND tool_name IS NOT NULL AND active = 1
      ORDER BY timestamp DESC LIMIT 60`);

    const todos = optional(`
      SELECT session_id, content, timestamp FROM messages
      WHERE role = 'tool' AND tool_name = 'todo' AND active = 1
      ORDER BY timestamp DESC LIMIT 40`);

    return { sessions, usage, tools, todos };
  } finally {
    db?.close();
  }
}

// ---------- row -> session mapping ----------

const SPARK_TAIL = 120; // sparkline points per agent
export const ACTIVE_MS = 5 * 60_000; // heartbeat within this = active; idle past it = sleep

// thinking level of a session's latest model config; hermes stores it in
// model_config.reasoning_config (enabled + effort)
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

function assemble({ sessions, usage, tools, todos, now }) {
  const cutoff = now - WINDOW_MS;

  const usageBySession = new Map();
  for (const u of usage) {
    if (!usageBySession.has(u.session_id)) usageBySession.set(u.session_id, []);
    usageBySession.get(u.session_id).push(u);
  }

  // latest todo list per session (rows come newest first)
  const todosBySession = new Map();
  for (const t of todos) {
    if (todosBySession.has(t.session_id)) continue;
    try {
      const list = JSON.parse(t.content)?.todos;
      if (Array.isArray(list)) {
        todosBySession.set(
          t.session_id,
          list.map((x) => ({
            content: String(x.content ?? ""),
            status: x.status === "completed" ? "done" : String(x.status ?? "pending"),
          })),
        );
      }
    } catch { /* malformed todo payload — skip */ }
  }

  // most recent tool call per session: from tool *result* rows (a result
  // proves the call ran; its JSON carries the error state and exit code)
  const toolBySession = new Map();
  const ticker = [];
  for (const t of tools) {
    const { status, exitCode } = toolResult(t.content);
    if (!toolBySession.has(t.session_id)) {
      toolBySession.set(t.session_id, {
        name: t.tool_name,
        outputBytes: t.content ? t.content.length : null,
        status,
        at: s2ms(t.timestamp),
      });
    }
    ticker.push({
      sessionId: t.session_id,
      tool: t.tool_name,
      outputBytes: t.content ? t.content.length : null,
      status,
      exitCode,
      at: s2ms(t.timestamp),
    });
  }

  const all = new Map();
  for (const s of sessions) {
    if (s.archived || s.hidden) continue;
    const kind = childKind(s.model_config);
    const directory = s.cwd ?? null;
    const ended = s.ended_at != null;
    const tasks = usageBySession.get(s.id) ?? [];

    // Sparkline = input tokens per request (the board-wide meaning). Hermes
    // reports cumulative per-task sums, so each task contributes its
    // per-call average as `min(n, room left)` plateau points — never an
    // unbounded expansion of the cumulative count (a long session would
    // allocate millions of slots and the Math.max spread would throw).
    const sparkline = [];
    let maxAvg = 0;
    for (const u of tasks) {
      const n = Math.max(Number(u.api_call_count ?? 0), 0);
      if (n <= 0) continue;
      const avg = Math.round(Number(u.input_tokens ?? 0) / n);
      if (avg > maxAvg) maxAvg = avg;
      const take = Math.min(n, Math.max(SPARK_TAIL - sparkline.length, 0));
      for (let i = 0; i < take; i++) sparkline.push(avg);
    }

    const firstAt = s2ms(s.started_at) ?? 0;
    const lastAt = Math.max(s2ms(s.last_activity_at) ?? 0, firstAt);
    const errMsg = s.handoff_error ?? s.compression_failure_error ?? null;

    // status: failure > finished > activity recency. `live` stays null —
    // hermes sessions live inside shared backend processes (gateway,
    // tui-gateway) whose per-session liveness is not readable anywhere
    // AgenQ trusts, so the adapter makes no claim (no exit dimming).
    const status = (() => {
      if (errMsg) return "failed";
      if (ended) return "done";
      const lastSeen = Math.max(0, ...tasks.map((u) => Number(u.last_seen ?? 0)));
      const lastSeenMs = s2ms(lastSeen) ?? 0;
      if (lastSeenMs && now - lastSeenMs <= ACTIVE_MS) return "running";
      if (lastAt && now - lastAt <= ACTIVE_MS) return "running";
      return "sleep";
    })();

    all.set(s.id, {
      id: s.id,
      title: s.title ?? (s.display_name ? String(s.display_name) : null),
      parentId: s.parent_session_id ?? null,
      project: projectFromDir(directory),
      directory,
      // only delegate subagents are a different agent; branch/reset children
      // are continuations of the same conversation, not separate workers
      role: kind === "delegate" ? "subagent" : null,
      model: s.model ?? null,
      thinking: thinkingOf(s.model_config),
      status,
      requests: Number(s.api_call_count ?? 0),
      inputTokens: Number(s.input_tokens ?? 0),
      outputTokens: Number(s.output_tokens ?? 0),
      cacheRead: Number(s.cache_read_tokens ?? 0),
      cacheCreate: Number(s.cache_write_tokens ?? 0),
      // hermes reports no per-request peak; the closest is the biggest
      // single-request average across tasks (task totals would measure the
      // whole conversation, not one request against the context cliff)
      maxContext: maxAvg,
      firstAt,
      lastAt,
      sparkline,
      lastError: errMsg
        ? { type: "handoff_failed", message: String(errMsg), at: lastAt }
        : null,
      todos: todosBySession.get(s.id) ?? [],
      lastTool: toolBySession.get(s.id) ?? null,
      children: [],
    });
  }

  // manager→subagent tree edges: children know their parentId; wire them
  // into the parent (delegate-kind only — branch/reset children are the
  // same conversation, not separate workers). The registry namespaces the
  // ids afterwards; here everything is raw.
  for (const s of all.values()) {
    if (s.role !== "subagent") continue;
    const parent = s.parentId && all.get(s.parentId);
    if (parent) parent.children.push(s.id);
  }

  // keep recent sessions plus any ancestor of a kept session
  const keep = keepInWindow([...all.values()], cutoff);

  const sessionsOut = [...all.values()]
    .filter((s) => keep.has(s.id))
    .map((s) => ({ ...s, children: s.children.filter((c) => keep.has(c)) }));
  const byId = new Map(sessionsOut.map((s) => [s.id, s]));

  const tickerKept = ticker.filter((t) => keep.has(t.sessionId)).slice(0, 15);

  // generatedAt/windowHours/roots are derived by the core (harness/index.mjs);
  // the adapter only supplies what the core cannot compute: raw sessions in
  // its own id space, plus the richer per-harness tool ticker.
  return {
    sessions: sessionsOut,
    roots: sessionsOut.filter((s) => !s.parentId || !byId.has(s.parentId)).map((s) => s.id),
    ticker: tickerKept,
  };
}

export async function snapshot({ now = Date.now() } = {}) {
  const data = gatherDb();
  return assemble({ ...data, now });
}