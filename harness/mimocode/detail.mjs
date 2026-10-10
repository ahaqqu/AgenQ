// AgenQ MiMo Desktop lazy per-session reads: the detail panel (current tool,
// thinking, token breakdown) and the live-conversation feed.
import { cfg } from "./config.mjs";
import { openDb, rows, jsonCol, projectFromDir } from "./db.mjs";
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
import { usageFromTokens } from "./tokens.mjs";

// Board node id is either a raw session id (main) or "<sessionId>/<actorId>".
function splitNodeId(id) {
  const i = String(id ?? "").indexOf("/");
  if (i <= 0) return { sessionId: id, actorId: "main" };
  return { sessionId: id.slice(0, i), actorId: id.slice(i + 1) };
}

function collectUsage(db, sessionId, actorId) {
  const msgs = rows(
    db,
    `SELECT agent_id, data FROM message WHERE session_id = ? AND data LIKE '%"tokens"%'`,
    [sessionId],
  );
  let requests = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let maxContext = 0;
  for (const r of msgs) {
    const data = jsonCol(r.data, null);
    if (!data?.tokens) continue;
    // attribute by the message's agent_id column (stable), not data.agent
    // (that field is the engine mode string, e.g. "build")
    const agent = r.agent_id || "main";
    if (actorId !== "main" && agent !== actorId) continue;
    if (actorId === "main" && agent && agent !== "main") continue;
    const u = usageFromTokens(data.tokens);
    requests += 1;
    input += u.inputTokens;
    output += u.outputTokens;
    reasoning += u.reasoningTokens;
    cacheRead += u.cacheRead;
    cacheCreate += u.cacheCreate;
    maxContext = Math.max(maxContext, u.prompt);
  }
  return { requests, input, output, reasoning, cacheRead, cacheCreate, maxContext };
}

export function sessionDetail(id) {
  const db = openDb();
  if (!db) return null;
  try {
    const { sessionId, actorId } = splitNodeId(id);
    const sess = rows(
      db,
      `SELECT title, directory FROM session WHERE id = ?`,
      [sessionId],
    )[0] ?? null;

    // latest tool call on this session (payloads are compact JSON, so the
    // matcher must accept both `"type":"tool"` and `"type": "tool"`)
    let currentTool = null;
    const toolRows = rows(
      db,
      `SELECT data, time_created FROM part
       WHERE session_id = ?
         AND (data LIKE '%"type":"tool"%' OR data LIKE '%"type": "tool"%')
       ORDER BY time_created DESC LIMIT 5`,
      [sessionId],
    );
    for (const r of toolRows) {
      const data = jsonCol(r.data, null);
      if (!data || data.type !== "tool") continue;
      const st = data.state ?? {};
      currentTool = {
        name: data.tool ?? "tool",
        status: st.status ?? "completed",
        input: st.input ? head(JSON.stringify(st.input), 800) : null,
        at: st.time?.end ?? st.time?.start ?? r.time_created,
      };
      break;
    }

    // latest thinking excerpt
    let thinking = null;
    const reasonRows = rows(
      db,
      `SELECT data, time_created FROM part
       WHERE session_id = ?
         AND (data LIKE '%"type":"reasoning"%' OR data LIKE '%"type": "reasoning"%')
       ORDER BY time_created DESC LIMIT 5`,
      [sessionId],
    );
    for (const r of reasonRows) {
      const data = jsonCol(r.data, null);
      const text = data?.text;
      if (typeof text === "string" && text.trim()) {
        thinking = { text: tail(text, 600), at: r.time_created };
        break;
      }
    }

    // per-request turn rows from assistant messages
    const turns = [];
    const msgs = rows(
      db,
      `SELECT agent_id, time_created, time_updated, data FROM message
       WHERE session_id = ? AND data LIKE '%"tokens"%'
       ORDER BY time_created`,
      [sessionId],
    );
    for (const r of msgs) {
      const data = jsonCol(r.data, null);
      if (!data?.tokens) continue;
      const agent = r.agent_id || "main";
      if (actorId !== "main" && agent !== actorId) continue;
      if (actorId === "main" && agent && agent !== "main") continue;
      const u = usageFromTokens(data.tokens);
      turns.push({
        model_id: data.modelID ?? data.model ?? null,
        duration_ms:
          data.time?.end && data.time?.start ? data.time.end - data.time.start : null,
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        reasoning_tokens: u.reasoningTokens,
        cache_read: u.cacheRead,
        cache_create: u.cacheCreate,
        cost_usd: data.cost != null ? Number(data.cost) || 0 : null,
        at: r.time_updated || r.time_created,
      });
    }

    const tokens = collectUsage(db, sessionId, actorId);
    const model = turns.length ? turns[turns.length - 1].model_id : null;

    return {
      sessionId: id,
      fetchedAt: Date.now(),
      title: sess?.title ?? null,
      directory: sess?.directory ?? null,
      diff: null,
      currentTool,
      thinking,
      turns,
      tokens,
      modelWindow: modelWindow(model),
      errors: [],
      todos: [],
    };
  } finally {
    db?.close();
  }
}

// Conversation cursor: part rowid, tagged "p:<rowid>" so it cannot collide
// with hermes's "m:" / zcode's "z:" cursors.
const CURSOR_PREFIX = "p";

export function sessionMessages(id, after) {
  const db = openDb();
  if (!db) return null;
  try {
    const { sessionId, actorId } = splitNodeId(id);
    const sess = rows(db, `SELECT title, directory FROM session WHERE id = ?`, [sessionId])[0] ?? null;
    const base = {
      sessionId: id,
      title: sess?.title ?? null,
      directory: sess?.directory ?? null,
    };

    const [resume] = parseCursor(after, CURSOR_PREFIX) ?? [];

    // One part walk is the feed: user/assistant text, thinking, and tool
    // chips all live as `part` rows ordered by rowid (insertion order).
    // Role comes from the owning message; synthetic system reminders are
    // skipped. Cursor is the highest part rowid this poll delivered.
    const partSql =
      resume == null
        ? `SELECT p.rowid AS rid, p.time_created AS at, p.data AS data,
                  m.agent_id AS agent, m.data AS mdata
           FROM part p LEFT JOIN message m ON m.id = p.message_id
           WHERE p.session_id = ?
           ORDER BY p.rowid DESC LIMIT ${CONV_TAIL}`
        : `SELECT p.rowid AS rid, p.time_created AS at, p.data AS data,
                  m.agent_id AS agent, m.data AS mdata
           FROM part p LEFT JOIN message m ON m.id = p.message_id
           WHERE p.session_id = ? AND p.rowid > ?
           ORDER BY p.rowid ASC LIMIT ${CONV_TAIL}`;

    let partRows = rows(db, partSql, resume == null ? [sessionId] : [sessionId, resume]);
    if (resume == null) partRows = partRows.slice().reverse();

    const items = [];
    let maxRid = resume ?? 0;
    for (const r of partRows) {
      if (r.rid > maxRid) maxRid = r.rid;
      const agent = r.agent || "main";
      if (actorId !== "main" && agent !== actorId) continue;
      if (actorId === "main" && agent && agent !== "main") continue;

      const data = jsonCol(r.data, null);
      if (!data) continue;
      const mdata = jsonCol(r.mdata, null);
      const role = mdata?.role === "user" ? "user" : "assistant";
      const kind = data.type;

      if (kind === "text") {
        if (data.synthetic) continue;
        const text = String(data.text ?? "");
        if (!text.trim()) continue;
        items.push({
          kind: "text",
          role,
          text: head(text, CONV_TEXT_CAP),
          at: r.at,
        });
      } else if (kind === "reasoning") {
        const text = String(data.text ?? "");
        if (!text.trim()) continue;
        items.push({
          kind: "thinking",
          role: "assistant",
          text: head(text, CONV_THINK_CAP),
          at: r.at,
        });
      } else if (kind === "tool") {
        const st = data.state ?? {};
        const input = st.input != null ? head(JSON.stringify(st.input), CONV_INPUT_CAP) : null;
        items.push({
          kind: "tool",
          role: "assistant",
          tool: data.tool ?? "tool",
          input,
          status: st.status ?? "completed",
          at: st.time?.end ?? st.time?.start ?? r.at,
        });
      }
      // step-start / step-finish are invisible in the feed (usage lives on cards)
    }

    return {
      ...base,
      cursor: `${CURSOR_PREFIX}:${maxRid}`,
      items,
    };
  } finally {
    db?.close();
  }
}
