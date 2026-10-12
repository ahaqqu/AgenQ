// AgenQ OpenCode lazy per-session reads: the detail panel (current tool,
// thinking, todos, diff, token breakdown) and the live-conversation feed.
//
// Both walk `session_message` with index-bounded reads — the same discipline
// as the snapshot (see snapshot.mjs): one window of the newest assistant
// rows feeds the turn rows, the context peak, the standing errors and the
// thinking excerpt, so no query ever streams a session's whole payload.
//
// The detail endpoint is synchronous (the server does not await it), so it
// reads whatever the last poll staged; the conversation feed is awaited and
// may stage first.
import { openAll, openStaged, closeAll, rows, jsonCol } from "./db.mjs";
import {
  CONV_INPUT_CAP,
  CONV_TAIL,
  CONV_TEXT_CAP,
  CONV_THINK_CAP,
  head,
  modelWindow,
  parseCursor,
  tail,
} from "../lib.mjs";
import { RECENT_LIMIT } from "./config.mjs";
import { usageFromSessionColumns, usageFromTokens } from "./tokens.mjs";
import { loadContextWindows, modelKey } from "./models.mjs";
import { contentParts, partText, toolEntry, toolInput, toolParts } from "./parts.mjs";

const TURNS_SHOWN = 40;
const SESSION_COLS = `
  title, directory, model,
  tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
  summary_additions, summary_deletions, summary_files`;

/** The source holding this session, or null (another install / not staged). */
function findSession(dbs, id) {
  for (const { db } of dbs) {
    const row = rows(db, `SELECT ${SESSION_COLS} FROM session_v2 WHERE id = ?`, [id])[0];
    if (row) return { db, row };
  }
  return null;
}

/**
 * opencode's `todo` table is written in the same event as the model's own
 * `todowrite` call — every session that ever called todowrite has rows here
 * — so the table alone is the plan.
 */
function todosFor(db, id) {
  return rows(
    db,
    `SELECT content, status FROM todo WHERE session_id = ? ORDER BY position`,
    [id],
  ).map((t) => ({ content: t.content, status: t.status === "completed" ? "done" : t.status }));
}

export function sessionDetail(id) {
  const { dbs } = openStaged();
  if (!dbs.length) return null;
  try {
    const found = findSession(dbs, id);
    if (!found) return null;
    const { db, row } = found;

    // newest-first assistant window: turns, context peak, errors, thinking
    const window = rows(
      db,
      `SELECT time_created, data FROM session_message
       WHERE session_id = ? AND type = 'assistant'
       ORDER BY seq DESC LIMIT ${RECENT_LIMIT}`,
      [id],
    );

    const turns = [];
    const errors = [];
    let maxContext = 0;
    let thinking = null;
    for (const r of window) {
      const d = jsonCol(r.data, null);
      if (!d) continue;
      const at = d.time?.completed ?? r.time_created;

      if (d.error && errors.length < 5) {
        errors.push({
          type: String(d.error.type ?? "error"),
          message: String(d.error.message ?? "").slice(0, 300),
          at,
        });
      }
      if (!thinking) {
        const text = partText(contentParts(d).find((p) => p?.type === "reasoning"));
        if (text.trim()) thinking = { text: tail(text, 600), at: r.time_created };
      }
      if (!d.tokens) continue;
      const u = usageFromTokens(d.tokens);
      maxContext = Math.max(maxContext, u.prompt);
      if (turns.length < TURNS_SHOWN) {
        turns.push({
          model_id: d.model?.id ?? null,
          duration_ms:
            d.time?.completed && d.time?.created ? d.time.completed - d.time.created : null,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          reasoning_tokens: u.reasoningTokens,
          cache_read: u.cacheRead,
          cache_create: u.cacheCreate,
          cost_usd: d.cost != null ? Number(d.cost) || 0 : null,
          at,
        });
      }
    }

    // what it is doing right now — the newest tool block on the session
    let currentTool = null;
    for (const r of rows(
      db,
      `SELECT time_created, data FROM session_message
       WHERE session_id = ? AND data LIKE '%"type":"tool"%'
       ORDER BY time_created DESC LIMIT 4`,
      [id],
    )) {
      const list = toolParts(jsonCol(r.data, null));
      if (!list.length) continue;
      const p = list[list.length - 1];
      const e = toolEntry(p, r.time_created);
      currentTool = {
        name: e.name,
        // raw harness vocabulary here ("running" is what the panel is for)
        status: p.state?.status ?? "completed",
        input: toolInput(p, 800),
        at: e.at,
      };
      break;
    }

    const [reqs] = rows(
      db,
      `SELECT count(*) AS n FROM session_message WHERE session_id = ? AND type = 'assistant'`,
      [id],
    );
    const totals = usageFromSessionColumns(row);
    const modelJson = jsonCol(row.model, null);
    const model = modelJson?.id ?? null;
    const provider = modelJson?.providerID ?? null;
    const contextWindow = loadContextWindows(db).get(modelKey(provider, model)) || modelWindow(model);

    return {
      sessionId: id,
      fetchedAt: Date.now(),
      title: row.title ?? null,
      directory: row.directory ?? null,
      diff: {
        additions: Number(row.summary_additions) || 0,
        deletions: Number(row.summary_deletions) || 0,
        files: Number(row.summary_files) || 0,
      },
      currentTool,
      thinking,
      turns,
      tokens: {
        input: totals.inputTokens,
        output: totals.outputTokens,
        cacheRead: totals.cacheRead,
        cacheCreate: totals.cacheCreate,
        reasoning: totals.reasoningTokens,
        requests: Number(reqs?.n) || 0,
        maxContext,
      },
      modelWindow: contextWindow,
      errors,
      todos: todosFor(db, id),
    };
  } finally {
    closeAll(dbs);
  }
}

// Conversation cursor: `session_message.seq`, tagged "s:<seq>" so it cannot
// collide with another harness's cursors. seq is unique per session and
// tracks insertion order.
const CURSOR_PREFIX = "s";

function itemsForRow(r) {
  const d = jsonCol(r.data, null);
  if (!d) return [];
  const at = d.time?.created ?? r.time_created;
  if (r.type === "user") {
    const text = typeof d.text === "string" ? d.text : "";
    if (!text.trim()) return [];
    return [{ kind: "text", role: "user", text: head(text, CONV_TEXT_CAP), at }];
  }
  // system notices, idle/compaction markers and synthetic shell echoes are
  // harness plumbing — the tool chips already carry what the model did
  if (r.type !== "assistant") return [];
  const out = [];
  for (const p of contentParts(d)) {
    if (p.type === "text") {
      const text = partText(p);
      if (text.trim()) out.push({ kind: "text", role: "assistant", text: head(text, CONV_TEXT_CAP), at });
    } else if (p.type === "reasoning") {
      const text = partText(p);
      if (text.trim()) out.push({ kind: "thinking", role: "assistant", text: head(text, CONV_THINK_CAP), at });
    } else if (p.type === "tool") {
      const e = toolEntry(p, at);
      out.push({
        kind: "tool",
        role: "assistant",
        tool: e.name,
        input: toolInput(p, CONV_INPUT_CAP),
        status: p.state?.status ?? "completed",
        at: e.at,
      });
    }
  }
  return out;
}

export async function sessionMessages(id, after) {
  const { dbs } = await openAll();
  if (!dbs.length) return null;
  try {
    const found = findSession(dbs, id);
    if (!found) return null;
    const { db, row } = found;

    const [resume] = parseCursor(after, CURSOR_PREFIX) ?? [];
    const msgRows =
      resume == null
        ? rows(
            db,
            `SELECT seq, time_created, type, data FROM session_message
             WHERE session_id = ? ORDER BY seq DESC LIMIT ${CONV_TAIL}`,
            [id],
          ).reverse()
        : rows(
            db,
            `SELECT seq, time_created, type, data FROM session_message
             WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ${CONV_TAIL}`,
            [id, resume],
          );

    const items = [];
    let maxSeq = resume ?? 0;
    for (const r of msgRows) {
      if (r.seq > maxSeq) maxSeq = r.seq;
      items.push(...itemsForRow(r));
    }

    return {
      sessionId: id,
      title: row.title ?? null,
      directory: row.directory ?? null,
      cursor: `${CURSOR_PREFIX}:${maxSeq}`,
      items,
    };
  } finally {
    closeAll(dbs);
  }
}
