// AgenQ OpenCode snapshot assembly: one poll's read-only view of every
// session the post-v2 telemetry holds.
//
// Where each number comes from:
//   * card totals  — the cumulative counters opencode keeps on the session
//     row (`tokens_*`), so a run's totals do not depend on how many message
//     rows this poll happened to walk;
//   * request count — one batched `GROUP BY session_id` count of each
//     session's assistant rows (no per-session query loop);
//   * sparkline, maxContext, standing error, last tool — the newest
//     RECENT_LIMIT assistant rows of that session, folded once by fold.mjs.
//     A last tool older than that window reads as none; the window is what
//     the card renders, so the gauge and the trail cannot disagree on it.
//   * ticker — every tool block inside those same windows (no payload-wide
//     `LIKE` scan: a leading-`%` LIKE satisfies no index and would stream
//     each message's whole JSON, file contents included, on every poll);
//   * todos — opencode's `todo` table (it is written in the same event as
//     the model's `todowrite` call, so the table *is* the projection).
//
// Every read is index-bounded on purpose: the `(session_id, type, seq)`
// shape the queries assume keeps each poll to the rows it renders and
// nothing else.
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
import { openAll, closeAll, idChunks, placeholders, projectLabel } from "./db.mjs";
import { usageFromSessionColumns } from "./tokens.mjs";
import { foldAssistantWindow } from "./fold.mjs";
import { jsonCol, keepInWindow, rows } from "../lib.mjs";

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
    return { projects, kept, counts: new Map(), recent: [], todos: [] };
  }

  const counts = new Map();
  const recent = [];
  // one batched count for every session — no per-session query loop
  for (const chunk of idChunks(ids)) {
    for (const r of rows(
      db,
      `SELECT session_id, count(*) AS n FROM session_message
        WHERE session_id IN (${placeholders(chunk.length)}) AND type = 'assistant'
        GROUP BY session_id`,
      chunk,
    )) {
      counts.set(r.session_id, r.n);
    }
  }
  for (const id of ids) {
    // walk the (session_id, type, seq) index backwards and stop after
    // RECENT_LIMIT rows — the only payloads this poll reads
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

  return { projects, kept, counts, recent, todos };
}

function modelOf(s) {
  const parsed = jsonCol(s.model, null);
  if (parsed && typeof parsed === "object") {
    return { model: parsed.id ?? null, provider: parsed.providerID ?? null };
  }
  return { model: null, provider: null };
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
    const byId = new Map(projects.map((p) => [p.id, p]));
    for (const s of kept) {
      ensure(s.id, {
        title: s.title || null,
        parentId: s.parent_id || null,
        // the UI groups sibling instances by parentSessionId, and a subagent's
        // own parent is what makes "2 of 5" mean a run rather than the board
        parentSessionId: s.parent_id || null,
        project: projectLabel(byId, s),
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

  // ---- per-session windows: sparkline, context peak, standing error,
  // last tool and ticker — all folded once from the rows already read
  const ticker = [];
  const cutoff = now - WINDOW_MS;
  for (const { counts, recent } of parts) {
    for (const { id, rows: window } of recent) {
      const node = nodes.get(id);
      if (!node) continue;
      const f = foldAssistantWindow(window);
      node.requests = counts.get(id) ?? 0;
      node.sparkline = f.prompts;
      node.maxContext = f.maxContext;
      if (f.hasReasoning) node.thinking = node.thinking ?? "reasoning";
      if (f.lastSuccessAt != null && (node.lastAt == null || f.lastSuccessAt > node.lastAt)) {
        node.lastAt = f.lastSuccessAt;
      }
      node.lastError = f.standingError;
      const [latest] = f.toolCalls;
      if (latest) {
        node.lastTool = {
          name: latest.name,
          outputBytes: latest.outputBytes,
          status: latest.status,
          at: latest.at,
          exitCode: latest.exitCode,
        };
      }
      for (const t of f.toolCalls) {
        if (t.at != null && t.at >= cutoff) {
          ticker.push({
            sessionId: id,
            tool: t.name,
            status: t.status,
            at: t.at,
            outputBytes: t.outputBytes,
            exitCode: t.exitCode,
          });
        }
      }
    }
  }
  ticker.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  // ---- todos (the table is opencode's own projection of the todowrite call)
  for (const { todos } of parts) {
    for (const t of todos) {
      const node = nodes.get(t.session_id);
      if (!node) continue;
      node.todos.push({ content: t.content, status: t.status === "completed" ? "done" : t.status });
    }
  }

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

  return { sessions: [...nodes.values()], roots, ticker: ticker.slice(0, TICKER_LIMIT) };
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
