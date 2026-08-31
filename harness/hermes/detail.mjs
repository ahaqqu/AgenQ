// AgenQ Hermes lazy per-session reads: the detail panel (current tool call,
// thinking, token breakdowns) and the live-conversation feed. Both open
// their own read-only DB connection and are only hit when the UI asks for a
// specific session.
import { cfg } from "./config.mjs";
import { roDb, rows, s2ms, modelWindow, tail, head } from "../lib.mjs";
import { toolResult } from "./toolresult.mjs";

// ---------- per-session detail (lazy — only read when the UI expands a row) ----------

export function sessionDetail(id) {
  const db = roDb(cfg.db);
  try {
    const q = (sql, params = []) => {
      try { return rows(db, sql, params); } catch { return []; }
    };
    const sess = q(`SELECT title, display_name, cwd, model
                    FROM sessions WHERE id = ?`, [id])[0] ?? null;

    // the live/latest tool call: newest tool result row, with the
    // *arguments* recovered from the assistant turn that carries its
    // tool_call_id (arguments live on the request side in hermes)
    let currentTool = null;
    const tr = q(`SELECT tool_name, tool_call_id, content, timestamp FROM messages
                  WHERE session_id = ? AND role = 'tool' AND tool_name IS NOT NULL AND active = 1
                  ORDER BY timestamp DESC LIMIT 1`, [id])[0];
    if (tr) {
      let input = null;
      if (tr.tool_call_id) {
        // arguments ride the assistant row that requested the call; the
        // call id is unique enough for a LIKE probe into its JSON array
        const call = q(`SELECT tool_calls FROM messages
                        WHERE session_id = ? AND role = 'assistant' AND tool_calls LIKE ?
                        ORDER BY timestamp DESC LIMIT 1`, [id, `%${tr.tool_call_id}%`])[0];
        if (call?.tool_calls) {
          try {
            const calls = JSON.parse(call.tool_calls);
            const c = Array.isArray(calls)
              ? calls.find((x) => x?.id === tr.tool_call_id || x?.call_id === tr.tool_call_id)
              : null;
            input = c?.function?.arguments ?? null;
          } catch { /* malformed tool_calls — args stay unknown */ }
        }
      }
      currentTool = {
        name: tr.tool_name,
        status: toolResult(tr.content).status,
        input: input ? head(input, 800) : null,
        at: s2ms(tr.timestamp),
      };
    }

    // newest thinking excerpt — tail only, the beginning is the stale half
    let thinking = null;
    const rp = q(`SELECT reasoning, reasoning_content, timestamp FROM messages
                  WHERE session_id = ? AND active = 1
                    AND (reasoning IS NOT NULL AND reasoning != ''
                      OR reasoning_content IS NOT NULL AND reasoning_content != '')
                  ORDER BY timestamp DESC LIMIT 1`, [id])[0];
    if (rp) {
      const text = rp.reasoning || rp.reasoning_content;
      if (text) thinking = { text: tail(text, 600), at: s2ms(rp.timestamp) };
    }

    // hermes reports usage per task (main + title/approval/review side
    // tasks), not per turn; the panel sums them and shows no turn timings.
    // Context fill measures one request against the model window, so the
    // gauge uses the biggest per-call average — task *totals* would plot
    // the whole conversation against one request's cliff.
    const usage = q(`SELECT task, api_call_count, input_tokens, output_tokens, reasoning_tokens,
                            cache_read_tokens, cache_write_tokens
                     FROM session_model_usage WHERE session_id = ?`, [id]);
    const sums = usage.reduce(
      (a, u) => ({
        requests: a.requests + Number(u.api_call_count ?? 0),
        input: a.input + Number(u.input_tokens ?? 0),
        output: a.output + Number(u.output_tokens ?? 0),
        reasoning: a.reasoning + Number(u.reasoning_tokens ?? 0),
        cacheRead: a.cacheRead + Number(u.cache_read_tokens ?? 0),
        cacheCreate: a.cacheCreate + Number(u.cache_write_tokens ?? 0),
      }),
      { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreate: 0 },
    );
    const maxContext = usage.reduce((m, u) => {
      const n = Number(u.api_call_count ?? 0);
      return n > 0 ? Math.max(m, Math.round(Number(u.input_tokens ?? 0) / n)) : m;
    }, 0);

    const sessRow = q(`SELECT handoff_error, compression_failure_error, ended_at
                       FROM sessions WHERE id = ?`, [id])[0];
    const errMsg = sessRow?.handoff_error ?? sessRow?.compression_failure_error ?? null;

    return {
      sessionId: id,
      fetchedAt: Date.now(),
      title: sess?.title ?? (sess?.display_name ? String(sess.display_name) : null),
      directory: sess?.cwd ?? null,
      diff: null, // hermes tracks no per-session diff summary
      currentTool,
      thinking,
      turns: [], // hermes reports per-task aggregates, not per-turn rows
      tokens: { ...sums, maxContext },
      modelWindow: modelWindow(sess?.model),
      errors: errMsg
        ? [{ type: "handoff_failed", message: head(String(errMsg), 200), at: null }]
        : [],
      todos: [],
    };
  } finally {
    db?.close();
  }
}

// ---------- live conversation (the /conversation.html feed) ----------

// The conversation lives in `messages`: user/assistant text rows, assistant
// rows carrying tool_calls (JSON array on the request side), tool result
// rows, and reasoning in dedicated columns. Ordering is `id` (AUTOINCREMENT
// = insertion order = conversation order). The client polls with the id of
// the last row it saw, so a poll moves bytes proportional to what was said.
const CONV_TEXT_CAP = 12_000;
const CONV_THINK_CAP = 6_000;
const CONV_INPUT_CAP = 2_000;
const CONV_TAIL_ROWS = 400; // first load: the last N rows, not the whole session

// hermes cursors are message row ids, prefixed away from zcode's mseq:pseq
const CURSOR_PREFIX = "m";

// returns the row id, or null for an unusable cursor (garbage degrades to a
// fresh tail load rather than a silent full replay)
function parseCursor(after) {
  if (after == null) return null;
  const n = Number(String(after).split(":")[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function sessionMessages(id, after) {
  const db = roDb(cfg.db);
  try {
    const sess = rows(db, `SELECT title, display_name, cwd FROM sessions WHERE id = ?`, [id])[0] ?? null;
    const base = {
      sessionId: id,
      title: sess?.title ?? (sess?.display_name ? String(sess.display_name) : null),
      directory: sess?.cwd ?? null,
    };
    const resume = parseCursor(after);
    if (after != null && resume == null) {
      // garbage cursor: no replay (the client polls every 2s and would
      // re-download the whole tail forever); echo its cursor back
      return { ...base, cursor: after, items: [] };
    }

    // First load (no cursor): tail the last N rows, oldest first, per the
    // contract. Resume: rows past the cursor in conversation order.
    // Soft-archived rows (active = 0, written by rewind/undo and compaction)
    // are taken back — never rendered.
    const COLS = `id, role, content, tool_name, tool_call_id, tool_calls, reasoning, reasoning_content, timestamp`;
    const rowsOut = resume == null
      ? rows(db,
          `SELECT ${COLS} FROM messages WHERE session_id = ? AND active = 1
           ORDER BY id DESC LIMIT ${CONV_TAIL_ROWS}`, [id]).reverse()
      : rows(db,
          `SELECT ${COLS} FROM messages WHERE session_id = ? AND active = 1 AND id > ?
           ORDER BY id ASC LIMIT ${CONV_TAIL_ROWS}`, [id, resume]);

    // Tool-call chip ownership. A chip is emitted from the assistant request
    // row (it carries the arguments); the paired result row supplies the
    // status. Two dedupe hazards, both resolved by comparing request-row ids
    // to the page floor:
    //  - within this page: a result row whose request row is also in the
    //    page would emit a second chip → suppress via the claimed-id set;
    //  - across polls: on resume, a result row whose request row sits below
    //    the cursor was already emitted by an earlier poll → suppress it too
    //    (the id comparison is exact, no guessing). A result row whose
    //    request row can't be found at all is a legacy/orphan — it still
    //    gets a bare chip so the call isn't invisible.
    const statusById = new Map();
    for (const t of rows(db, `SELECT tool_call_id, content FROM messages
                              WHERE session_id = ? AND role = 'tool' AND active = 1
                              ORDER BY id DESC LIMIT ${CONV_TAIL_ROWS}`, [id])) {
      if (t.tool_call_id && !statusById.has(t.tool_call_id)) {
        statusById.set(t.tool_call_id, toolResult(t.content).status);
      }
    }

    const items = [];
    let cursor = after ?? `${CURSOR_PREFIX}:0`;
    const claimedInPage = new Set();
    for (const m of rowsOut) {
      if (m.role !== "assistant" || !m.tool_calls) continue;
      try {
        for (const c of JSON.parse(m.tool_calls)) {
          const cid = c?.id ?? c?.call_id;
          if (cid) claimedInPage.add(cid);
        }
      } catch { /* malformed — the fallback chip path handles it */ }
    }
    // which of this page's result rows had their request row BELOW the page
    // floor (emitted by an earlier poll)? one query over the page's call ids
    const resultRows = rowsOut.filter((m) => m.role === "tool" && m.tool_call_id);
    const claimedBelow = new Set();
    if (resume != null && resultRows.length) {
      const ids = resultRows.map((m) => m.tool_call_id);
      const marks = ids.map(() => "?").join(",");
      for (const r of rows(db, `SELECT DISTINCT j.value AS cid FROM messages a,
                                json_each(a.tool_calls) j
                                WHERE a.session_id = ? AND a.role = 'assistant'
                                  AND a.id < ? AND j.value IN (${marks})`,
        [id, resume, ...ids])) {
        if (r.cid) claimedBelow.add(r.cid);
      }
    }

    for (const m of rowsOut) {
      cursor = `${CURSOR_PREFIX}:${m.id}`;
      if (m.role === "tool" && m.tool_call_id) {
        // already emitted from its request row: in this page (claimedInPage)
        // or by an earlier poll (claimedBelow, possible only on resume)
        if (claimedInPage.has(m.tool_call_id) || claimedBelow.has(m.tool_call_id)) continue;
        // orphan result (request row missing or unparseable): bare chip
      }
      for (const item of convItems(m, statusById)) items.push(item);
    }

    return { ...base, cursor, items };
  } finally {
    db?.close();
  }
}

function convItems(m, statusById) {
  const at = s2ms(m.timestamp) ?? Date.now();
  if (m.role === "tool") {
    return [{
      kind: "tool",
      role: "assistant",
      tool: m.tool_name ?? "?",
      status: toolResult(m.content).status,
      input: null,
      at,
    }];
  }
  if (m.role === "assistant" && m.tool_calls) {
    // one row can request several parallel calls — one chip each; the
    // status comes from the paired result row (authoritative outcome);
    // a call without a result row (in-flight / lost) shows as completed
    try {
      const calls = JSON.parse(m.tool_calls);
      if (Array.isArray(calls) && calls.length) {
        return calls.map((c) => {
          const callId = c?.id ?? c?.call_id ?? null;
          return {
            kind: "tool",
            role: "assistant",
            tool: c?.function?.name ?? "?",
            status: (callId && statusById.get(callId)) || "completed",
            input: c?.function?.arguments ? head(c.function.arguments, CONV_INPUT_CAP) : null,
            at,
          };
        });
      }
    } catch { /* malformed tool_calls — fall through to text handling */ }
  }
  const thinkText = m.reasoning || m.reasoning_content;
  if (thinkText && String(thinkText).trim()) {
    return [{ kind: "think", role: "assistant", text: tail(thinkText, CONV_THINK_CAP), at }];
  }
  const text = String(m.content ?? "");
  if (!text.trim()) return []; // scaffold rows carry no renderable text
  return [{ kind: "text", role: m.role === "user" ? "user" : "assistant", text: head(text, CONV_TEXT_CAP), at }];
}