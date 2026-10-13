// AgenQ OpenCode snapshot assembly: one poll's read-only view of every
// session the post-v2 telemetry holds.
//
// Where each number comes from:
//   * card totals  — the cumulative counters opencode keeps on the session
//     row (`tokens_*`), so a run's totals do not depend on how many message
//     rows this poll happened to walk;
//   * request count — an index-only count of the session's assistant rows;
//   * sparkline, maxContext, standing error — the newest RECENT_LIMIT
//     assistant rows of that session;
//   * todos — opencode's `todo` table (it is written in the same event as
//     the model's `todowrite` call, so the table *is* the projection);
//   * tool trail — tool blocks inside assistant messages.
//
// Every read is index-bounded on purpose. A naive "all rows with tokens"
// pass reads each message's whole JSON payload — the active session's 1000
// rows carry tens of MB of file contents, which cost half a second per poll
// on its own. Walking backwards with LIMIT reads exactly what is rendered
// and nothing else (see harness/opencode/profile notes in the PR).
//
// maxContext is deliberately the biggest prompt *inside that window*: it is
// the same points the sparkline draws, so the gauge and the chart cannot
// disagree, and after a compaction it reports the current fill rather than
// a peak the context no longer holds.
//
// Token semantics are opencode's wire shape folded into the board's: `input`
// excludes cache reads, the board's "in" includes them (see tokens.mjs).
//
// Liveness is heartbeat recency, the same rule the other adapters use —
// opencode keeps no per-session process lease AgenQ could read, so a card
// says *running* while the session has written something in the last five
// minutes and *sleep* afterwards.
import { cfg, RECENT_LIMIT, WINDOW_MS } from "./config.mjs";
import { openAll, closeAll, rows, jsonCol, projectFromDir, idChunks, placeholders } from "./db.mjs";
import { usageFromSessionColumns, usageFromTokens } from "./tokens.mjs";
import { toolEntry, toolParts } from "./parts.mjs";
import { keepInWindow } from "../lib.mjs";

export const ACTIVE_MS = 5 * 60_000;
const TICKER_LIMIT = 80;

/** One source's rows, reduced to the sessions this window still shows. */
function gatherOne(db, now) {
  const sessions = rows(db, `
    SELECT id, project_id, parent_id, title, directory, agent, model,
           tokens_input, tokens_output, tokens_reasoning,
           tokens_cache_read, tokens_cache_write,
           time_created, time_updated, time_archived
    FROM session_v2`);
  const projects = rows(db, `SELECT id, name, worktree FROM project`);

  const live = sessions.filter((s) => s.time_archived == null);
  const keep = keepInWindow(
    live.map((s) => ({
      id: s.id,
      parentId: s.parent_id,
      firstAt: s.time_created,
      lastAt: s.time_updated,
    })),
    now - WINDOW_MS,
  );
  const kept = live.filter((s) => keep.has(s.id));
  const ids = kept.map((s) => s.id);
  if (!ids.length) {
    return { projects, kept, counts: new Map(), recent: [], tools: new Map(), todos: [], ticker: [] };
  }

  const counts = new Map();
  const recent = [];
  const tools = new Map();
  for (const id of ids) {
    // index-only: `(session_id, type, seq)` — no payload is read at all
    counts.set(
      id,
      rows(db, `SELECT count(*) AS n FROM session_message WHERE session_id = ? AND type = 'assistant'`, [id])[0]
        ?.n ?? 0,
    );
    // walk the same index backwards and stop after RECENT_LIMIT rows
    recent.push({
      id,
      rows: rows(
        db,
        `SELECT time_created, data FROM session_message
         WHERE session_id = ? AND type = 'assistant'
         ORDER BY seq DESC LIMIT ${RECENT_LIMIT}`,
        [id],
      ),
    });
    const tool = rows(
      db,
      `SELECT time_created, data FROM session_message
       WHERE session_id = ? AND data LIKE '%"type":"tool"%'
       ORDER BY time_created DESC LIMIT 1`,
      [id],
    )[0];
    if (tool) tools.set(id, tool);
  }

  // SQLite's bound-parameter limit: chunk the id list and concatenate.
  const inChunks = (build) => {
    const out = [];
    for (const chunk of idChunks(ids)) {
      out.push(...build(chunk, placeholders(chunk.length)));
    }
    return out;
  };

  const todos = inChunks((chunk, ph) =>
    rows(
      db,
      `SELECT session_id, content, status, position FROM todo
       WHERE session_id IN (${ph}) ORDER BY session_id, position`,
      chunk,
    ),
  );

  const ticker = inChunks((chunk, ph) =>
    rows(
      db,
      `SELECT session_id, time_created, data FROM session_message
       WHERE session_id IN (${ph}) AND time_created >= ?
         AND data LIKE '%"type":"tool"%'
       ORDER BY time_created DESC LIMIT ${TICKER_LIMIT}`,
      [...chunk, now - WINDOW_MS],
    ),
  );

  return { projects, kept, counts, recent, tools, todos, ticker };
}

function projectLabel(projects, s) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return (
    projectFromDir(s.directory) ||
    projectFromDir(byId.get(s.project_id)?.worktree) ||
    byId.get(s.project_id)?.name ||
    (s.project_id && s.project_id !== "global" ? s.project_id : null)
  );
}

function modelOf(s) {
  const parsed = jsonCol(s.model, null);
  if (parsed && typeof parsed === "object") {
    return { model: parsed.id ?? null, provider: parsed.providerID ?? null };
  }
  return { model: null, provider: null };
}

/**
 * Fold one session's newest-first assistant rows into its sparkline, context
 * peak and standing error. Newest-first matters: the first `error` met is
 * the run's latest failure, and any successful request seen before it is
 * newer — which is what clears an older failure.
 */
function foldRecent(node, rowsNewestFirst, requests) {
  node.requests = requests;
  const prompts = [];
  let successSeen = false;
  let err = null;
  for (const r of rowsNewestFirst) {
    const data = jsonCol(r.data, null);
    if (!data) continue;
    if (!err && data.error) {
      err = {
        type: String(data.error.type ?? "error"),
        message: String(data.error.message ?? "").slice(0, 300),
        at: data.time?.completed ?? r.time_created,
        cleared: successSeen,
      };
      continue;
    }
    if (!data.tokens) continue;
    if (data.error) continue;
    successSeen = true;
    const u = usageFromTokens(data.tokens);
    prompts.push(u.prompt);
    node.maxContext = Math.max(node.maxContext, u.prompt);
    if (u.reasoningTokens > 0) node.thinking = node.thinking ?? "reasoning";
    const at = data.time?.completed ?? r.time_created;
    if (at != null && (node.lastAt == null || at > node.lastAt)) node.lastAt = at;
  }
  node.sparkline = prompts.reverse();
  node.lastError = err && !err.cleared ? { type: err.type, message: err.message, at: err.at } : null;
}

function assemble(parts, now) {
  const nodes = new Map();
  const ensure = (id, base = {}) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        title: null,
        parentId: null,
        parentSessionId: null,
        project: null,
        directory: null,
        role: null,
        description: null,
        model: null,
        provider: null,
        thinking: null,
        status: "idle",
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreate: 0,
        reasoningTokens: 0,
        maxContext: 0,
        firstAt: null,
        lastAt: null,
        sparkline: [],
        lastError: null,
        todos: [],
        lastTool: null,
        children: [],
        ...base,
      });
    }
    return nodes.get(id);
  };

  // ---- session shells (before any edge is wired, so a parent can land later)
  for (const { projects, kept } of parts) {
    for (const s of kept) {
      ensure(s.id, {
        title: s.title || null,
        parentId: s.parent_id || null,
        // the UI groups sibling instances by parentSessionId, and a subagent's
        // own parent is what makes "2 of 5" mean a run rather than the board
        parentSessionId: s.parent_id || null,
        project: projectLabel(projects, s),
        directory: s.directory || null,
        firstAt: s.time_created ?? null,
        lastAt: s.time_updated ?? s.time_created ?? null,
        description: s.parent_id ? s.title || null : null,
        ...modelOf(s),
      });
      const node = nodes.get(s.id);
      // a root card reads as "main" — only a child carries a role badge
      node.role = s.parent_id ? s.agent || "subagent" : null;
      Object.assign(node, usageFromSessionColumns(s));
      if (node.reasoningTokens > 0) node.thinking = node.thinking ?? "reasoning";
    }
  }

  // ---- per-session windows: sparkline, context peak, standing error
  for (const { counts, recent } of parts) {
    for (const { id, rows: window } of recent) {
      const node = nodes.get(id);
      if (!node) continue;
      foldRecent(node, window, counts.get(id) ?? 0);
    }
  }

  // ---- todos (the table is opencode's own projection of the todowrite call)
  for (const { todos } of parts) {
    for (const t of todos) {
      const node = nodes.get(t.session_id);
      if (!node) continue;
      node.todos.push({ content: t.content, status: t.status === "completed" ? "done" : t.status });
    }
  }

  // ---- tool trail: last tool per card, plus the ticker
  const ticker = [];
  for (const { tools } of parts) {
    for (const [sid, r] of tools) {
      const node = nodes.get(sid);
      const list = toolParts(jsonCol(r.data, null));
      if (!node || !list.length) continue;
      const e = toolEntry(list[list.length - 1], r.time_created);
      node.lastTool = { name: e.name, outputBytes: e.outputBytes, status: e.status, at: e.at, exitCode: e.exitCode };
    }
  }
  for (const { ticker: rows_ } of parts) {
    for (const r of rows_) {
      for (const p of toolParts(jsonCol(r.data, null))) {
        const e = toolEntry(p, r.time_created);
        ticker.push({
          sessionId: r.session_id,
          tool: e.name,
          status: e.status,
          at: e.at,
          outputBytes: e.outputBytes,
          exitCode: e.exitCode,
        });
      }
    }
  }
  ticker.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // ---- status + context cliff
  for (const s of nodes.values()) {
    const last = s.lastAt ?? 0;
    const awake = last > 0 && now - last <= ACTIVE_MS;
    if (s.lastError) s.status = "failed";
    else if (awake) s.status = "running";
    else if (last) s.status = "sleep";
    else s.status = "idle";
  }

  const byId = new Map([...nodes.values()].map((n) => [n.id, n]));
  for (const s of nodes.values()) {
    if (s.parentId && byId.has(s.parentId)) {
      const p = byId.get(s.parentId);
      if (!p.children.includes(s.id)) p.children.push(s.id);
    }
  }
  const roots = [...nodes.values()]
    .filter((n) => !n.parentId || !byId.has(n.parentId))
    .map((n) => n.id);

  return { sessions: [...nodes.values()], roots, ticker };
}

export async function snapshot({ now = Date.now() } = {}) {
  const { dbs, warnings } = await openAll();
  if (!dbs.length) {
    return {
      generatedAt: now,
      windowHours: cfg.windowHours,
      sessions: [],
      roots: [],
      ticker: [],
      warnings,
    };
  }
  try {
    const parts = dbs.map(({ db }) => gatherOne(db, now));
    return {
      generatedAt: now,
      windowHours: cfg.windowHours,
      ...assemble(parts, now),
      warnings,
    };
  } finally {
    closeAll(dbs);
  }
}
