// AgenQ Hermes lazy per-session reads: the detail panel (current tool call,
// thinking, token breakdowns) and the live-conversation feed. Both open
// their own read-only DB connection and are only hit when the UI asks for a
// specific session.
import { Database } from "bun:sqlite";
import { cfg } from "./config.mjs";

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

const s2ms = (t) => (t == null ? null : Math.round(Number(t) * 1000));

const tail = (s, n) => { s = String(s ?? ""); return s.length > n ? "…" + s.slice(-n) : s; };
const head = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + " …" : s; };

const toolErrored = (content) => {
  try {
    const d = JSON.parse(content);
    return d != null && typeof d === "object" && (d.error != null || d.success === false);
  } catch {
    return false;
  }
};

// Context-window estimates for the fill gauge — hermes sets max_tokens and
// reasoning effort per session but reports no window size; the same
// model-name table the zcode adapter uses is the best signal available
// (unmatched → the 200k default both adapters share).
const MODEL_WINDOWS = [
  [/glm/i, 200_000],
  [/kimi/i, 256_000],
  [/deepseek/i, 128_000],
];
const modelWindow = (model) => MODEL_WINDOWS.find(([re]) => re.test(model ?? ""))?.[1] ?? 200_000;

// ---------- per-session detail (lazy — only read when the UI expands a row) ----------

export function sessionDetail(id) {
  const db = roDb();
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
                  WHERE session_id = ? AND role = 'tool' AND tool_name IS NOT NULL
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
        status: toolErrored(tr.content) ? "error" : "completed",
        input: input ? head(input, 800) : null,
        at: s2ms(tr.timestamp),
      };
    }

    // newest thinking excerpt — tail only, the beginning is the stale half
    let thinking = null;
    const rp = q(`SELECT reasoning, reasoning_content, timestamp FROM messages
                  WHERE session_id = ?
                    AND (reasoning IS NOT NULL AND reasoning != ''
                      OR reasoning_content IS NOT NULL AND reasoning_content != '')
                  ORDER BY timestamp DESC LIMIT 1`, [id])[0];
    if (rp) {
      const text = rp.reasoning || rp.reasoning_content;
      if (text) thinking = { text: tail(text, 600), at: s2ms(rp.timestamp) };
    }

    // hermes reports usage per task (main + title/approval/review side
    // tasks), not per turn; the panel sums them and shows no turn timings
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
    const maxContext = usage.reduce((m, u) => Math.max(m, Number(u.input_tokens ?? 0)), 0);

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

// hermes cursors are message row ids, namespaced away from zcode's mseq:pseq
const CURSOR_PREFIX = "m";

export function sessionMessages(id, after) {
  const db = roDb();
  try {
    const sess = rows(db, `SELECT title, display_name, cwd FROM sessions WHERE id = ?`, [id])[0] ?? null;
    const params = [id];
    let where = "";
    if (after) {
      const n = Number(String(after).split(":")[1] ?? after);
      if (Number.isFinite(n) && n >= 0) {
        where = "AND id > ?";
        params.push(n);
      }
    }
    // The window (Tail N rows / id > cursor) selects raw message rows; the
    // pairing step below may then emit more or fewer renderable items than
    // rows. The result-status map is built from tool rows possibly outside
    // the assistant rows' window — always scan a bounded recent slice.
    const rowsOut = rows(
      db,
      `SELECT id, role, content, tool_name, tool_call_id, tool_calls, reasoning, reasoning_content, timestamp
       FROM messages WHERE session_id = ? ${where}
       ORDER BY id ASC LIMIT ${CONV_TAIL_ROWS}`,
      params,
    );
    // tool_call_id -> { status } from result rows (role='tool'). Results can
    // sit outside the polled window on resume; pull a recent slice instead
    // of assuming they follow inside it.
    const statusById = new Map();
    for (const t of rows(db, `SELECT tool_call_id, content FROM messages
                               WHERE session_id = ? AND role = 'tool'
                               ORDER BY id DESC LIMIT ${CONV_TAIL_ROWS}`, [id])) {
      if (t.tool_call_id && !statusById.has(t.tool_call_id)) {
        statusById.set(t.tool_call_id, toolErrored(t.content) ? "error" : "completed");
      }
    }
    const items = [];
    // Assistant rows precede their result rows in id order, so every
    // tool_call_id the window will claim is known up front — pre-scan to
    // hide matched result rows; unclaimed ones (request outside the window)
    // fall back to their own bare chip.
    const seenCallIds = new Set();
    for (const m of rowsOut) {
      if (m.role === "assistant" && m.tool_calls) {
        try {
          for (const c of JSON.parse(m.tool_calls)) {
            const callId = c?.id ?? c?.call_id;
            if (callId) seenCallIds.add(callId);
          }
        } catch { /* malformed — the fallback chip path handles it */ }
      }
    }
    let cursor = after ?? `${CURSOR_PREFIX}:0`;
    for (const m of rowsOut) {
      cursor = `${CURSOR_PREFIX}:${m.id}`;
      for (const item of convItems(m, statusById, seenCallIds)) items.push(item);
    }
    return {
      sessionId: id,
      title: sess?.title ?? (sess?.display_name ? String(sess.display_name) : null),
      directory: sess?.cwd ?? null,
      cursor,
      items,
    };
  } finally {
    db?.close();
  }
}

function convItems(m, statusById, seenCallIds) {
  const at = s2ms(m.timestamp) ?? Date.now();
  if (m.role === "tool") {
    // A result whose call came from an assistant row outside the polled
    // window (page-start slice, malformed request JSON) has no chip yet —
    // render a bare one. The seen-set hides all matched results instead:
    // each chip is emitted once, from the assistant request row.
    if (m.tool_call_id && seenCallIds?.has(m.tool_call_id)) return [];
    return [{
      kind: "tool",
      role: "assistant",
      tool: m.tool_name ?? "?",
      status: toolErrored(m.content) ? "error" : "completed",
      input: null,
      at,
    }];
  }
  if (m.role === "assistant" && m.tool_calls) {
    // One row can request several parallel calls — one chip each. The chip
    // status comes from the paired tool result row (the authoritative
    // outcome); a call without a result row (in-flight / lost) shows as
    // completed, and a result without a request falls back to its own chip.
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