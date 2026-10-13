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
import { openAll, openStaged, closeAll } from "./db.mjs";
import {
  CONV_INPUT_CAP,
  CONV_TAIL,
  CONV_TEXT_CAP,
  CONV_THINK_CAP,
  head,
  jsonCol,
  parseCursor,
  rows,
} from "../lib.mjs";
import { RECENT_LIMIT } from "./config.mjs";
import { usageFromSessionColumns } from "./tokens.mjs";
import { foldAssistantWindow } from "./fold.mjs";
import { contentParts, partText, toolEntry, toolInput, toolParts } from "./parts.mjs";

const TURNS_SHOWN = 40;
const SESSION_COLS = `
  title, directory,
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

    // newest-first assistant window: turns, context peak, errors, thinking,
    // current tool — folded once (see fold.mjs)
    const window = rows(
      db,
      `SELECT time_created, data FROM session_message
       WHERE session_id = ? AND type = 'assistant'
       ORDER BY seq DESC LIMIT ${RECENT_LIMIT}`,
      [id],
    );
    const f = foldAssistantWindow(window, { turnCap: TURNS_SHOWN });

    // what it is doing right now — the newest tool block in the window
    const [latest] = f.toolCalls;
    const currentTool = latest
      ? {
          name: latest.name,
          // raw harness vocabulary here ("running" is what the panel is for)
          status: latest.rawStatus,
          input: f.lastToolInput,
          at: latest.at,
        }
      : null;

    const [reqs] = rows(
      db,
      `SELECT count(*) AS n FROM session_message WHERE session_id = ? AND type = 'assistant'`,
      [id],
    );
    const totals = usageFromSessionColumns(row);

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
      thinking: f.thinking,
      turns: f.turns,
      tokens: {
        input: totals.inputTokens,
        output: totals.outputTokens,
        cacheRead: totals.cacheRead,
        cacheCreate: totals.cacheCreate,
        reasoning: totals.reasoningTokens,
        requests: Number(reqs?.n) || 0,
        maxContext: f.maxContext,
      },
      errors: f.errors.slice(0, 5).map(({ type, message, at }) => ({ type, message, at })),
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
