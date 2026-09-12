// Lazy per-session reads: the detail panel (tool arguments, thinking, token
// breakdowns) and the live-conversation feed. Both open their own read-only
// DB connection and are only hit when the UI asks for a specific session.
import { Database } from "bun:sqlite";
import { cfg } from "./config.mjs";
import { CONV_INPUT_CAP, CONV_TAIL, CONV_TEXT_CAP, CONV_THINK_CAP, head, modelWindow, parsePairCursor, tail } from "../lib.mjs";

function roDb() {
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

// ---------- per-session detail (lazy — only read when the UI expands a row) ----------

export function sessionDetail(id) {
  const db = roDb();
  try {
    const q = (sql, params = []) => {
      try { return rows(db, sql, params); } catch { return []; }
    };
    const sess = q(`SELECT title, directory, summary_additions, summary_deletions, summary_files
                    FROM session WHERE id = ?`, [id])[0] ?? null;

    // the live/latest tool call — part rows carry the arguments it was given
    let currentTool = null;
    const tp = q(`SELECT data, time_created FROM part
                  WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
                  ORDER BY time_created DESC LIMIT 1`, [id])[0];
    if (tp) {
      try {
        const d = JSON.parse(tp.data);
        const input = JSON.stringify(d.state?.input ?? {}) ?? "{}";
        currentTool = {
          name: d.tool ?? null,
          status: d.state?.status ?? null,
          input: input === "{}" ? null : head(input, 800),
          at: tp.time_created,
        };
      } catch { /* malformed part row — skip */ }
    }

    // newest thinking excerpt — tail only, the beginning is the stale half
    let thinking = null;
    const rp = q(`SELECT data, time_created FROM part
                  WHERE session_id = ? AND json_extract(data, '$.type') = 'reasoning'
                  ORDER BY time_created DESC LIMIT 1`, [id])[0];
    if (rp) {
      try {
        const d = JSON.parse(rp.data);
        if (d.text) thinking = { text: tail(d.text, 600), at: rp.time_created };
      } catch { /* malformed part row — skip */ }
    }

    const turns = q(`SELECT model_id, status, started_at, duration_ms, time_to_first_token_ms,
                            input_tokens, output_tokens, reasoning_tokens,
                            cache_read_input_tokens, cache_creation_input_tokens,
                            retry_count, context_exceeded
                     FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 5`, [id]);
    const sums = q(`SELECT COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
                           SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
                           SUM(cache_read_input_tokens) AS cache_read,
                           SUM(cache_creation_input_tokens) AS cache_create,
                           MAX(input_tokens) AS max_context
                    FROM model_usage WHERE session_id = ?`, [id])[0] ?? {};
    const errors = q(`SELECT error_type, error_message, completed_at FROM model_usage
                      WHERE session_id = ? AND error_type IS NOT NULL
                      ORDER BY completed_at DESC LIMIT 3`, [id]);
    const todos = q(`SELECT content,
                            CASE WHEN status = 'completed' THEN 'done' ELSE status END AS status
                     FROM todo WHERE session_id = ? ORDER BY position`, [id]);

    return {
      sessionId: id,
      fetchedAt: Date.now(),
      title: sess?.title ?? null,
      directory: sess?.directory ?? null,
      diff: sess
        ? { additions: sess.summary_additions, deletions: sess.summary_deletions, files: sess.summary_files }
        : null,
      currentTool,
      thinking,
      turns,
      tokens: {
        requests: sums.requests ?? 0,
        input: sums.input_tokens ?? 0,
        output: sums.output_tokens ?? 0,
        reasoning: sums.reasoning_tokens ?? 0,
        cacheRead: sums.cache_read ?? 0,
        cacheCreate: sums.cache_create ?? 0,
        maxContext: sums.max_context ?? 0,
      },
      modelWindow: modelWindow(turns[0]?.model_id),
      errors: errors.map((e) => ({ type: e.error_type, message: head(e.error_message ?? "", 200), at: e.completed_at })),
      todos: todos.map((t) => ({ content: t.content, status: t.status })),
    };
  } finally {
    db?.close();
  }
}

// ---------- live conversation (the /conversation.html feed) ----------

// The conversation lives in `message` (role, sequence) × `part` (text /
// reasoning / tool rows). The client polls with the cursor returned here —
// the (message-sequence, part-sequence) pair of the last row it saw — and
// only rows past that pair come back, so a poll moves bytes proportional
// to what was actually said, not to the size of the session. The text caps
// and the tail length are shared with the other adapters (../lib.mjs).

const convSel = `
  SELECT json_extract(m.data, '$.role') AS role,
         coalesce(m.sequence, 0) AS mseq,
         coalesce(p.sequence, 0) AS pseq,
         json_extract(p.data, '$.type') AS ptype,
         p.data AS pdata,
         p.time_created AS at
  FROM part p JOIN message m ON p.message_id = m.id`;

function convItem(r) {
  let d;
  try { d = JSON.parse(r.pdata); } catch { return null; }
  if (r.ptype === "text") {
    const text = String(d.text ?? "");
    if (!text.trim()) return null;
    return { kind: "text", role: r.role, text: head(text, CONV_TEXT_CAP), at: r.at };
  }
  if (r.ptype === "reasoning") {
    const text = String(d.text ?? "");
    if (!text.trim()) return null;
    return { kind: "think", role: r.role, text: tail(text, CONV_THINK_CAP), at: r.at };
  }
  if (r.ptype === "tool") {
    const input = JSON.stringify(d.state?.input ?? {}) ?? "{}";
    return {
      kind: "tool",
      role: r.role,
      tool: d.tool ?? "?",
      status: d.state?.status ?? null,
      input: input === "{}" ? null : head(input, CONV_INPUT_CAP),
      at: r.at,
    };
  }
  return null; // step-start/step-finish/timeline/file/compaction are scaffolding
}

export function sessionMessages(id, after) {
  const db = roDb();
  try {
    const sess = rows(db, `SELECT title, directory FROM session WHERE id = ?`, [id])[0] ?? null;
    let cursor = after ?? "0:0";
    let parts;
    // An unusable cursor (a foreign format, a hand-made request) becomes a
    // first load — the client adopts the fresh cursor we return and recovers
    // on this poll, instead of resuming from a nonsense offset.
    const from = parsePairCursor(after);
    if (from) {
      parts = rows(db, `${convSel}
        WHERE p.session_id = ?
          AND (coalesce(m.sequence,0), coalesce(p.sequence,0)) > (?, ?)
        ORDER BY coalesce(m.sequence,0), coalesce(p.sequence,0)
        LIMIT ${CONV_TAIL}`, [id, ...from]);
    } else {
      // first load: newest CONV_TAIL rows, oldest-first for rendering
      parts = rows(db, `${convSel}
        WHERE p.session_id = ?
        ORDER BY coalesce(m.sequence,0) DESC, coalesce(p.sequence,0) DESC
        LIMIT ${CONV_TAIL}`, [id]).reverse();
    }
    const items = [];
    for (const r of parts) {
      cursor = `${r.mseq}:${r.pseq}`;
      const item = convItem(r);
      if (item) items.push(item);
    }
    return {
      sessionId: id,
      title: sess?.title ?? null,
      directory: sess?.directory ?? null,
      cursor,
      items,
    };
  } finally {
    db?.close();
  }
}