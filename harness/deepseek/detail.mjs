// AgenQ DeepSeek Harness lazy per-session reads: the detail panel and the
// live-conversation feed. Both are answered from the aggregates the snapshot
// poll already folded (see log.mjs) — the conversation additionally subscribes
// the session so its normalized records are kept in memory.
import { cfg } from "./config.mjs";
import { findLogPath, readSession, recordsOf, subscribe } from "./log.mjs";
import { head, modelWindow } from "../lib.mjs";

// ---------- per-session detail (lazy — only read when the UI expands a row) ----------

export function sessionDetail(id) {
  const path = findLogPath(cfg.dir, id);
  if (!path) return null;
  const agg = readSession(path);
  if (!agg?.header) return null;
  const calls = [...agg.calls.values()];
  const last = calls.at(-1) ?? null;
  return {
    sessionId: id,
    fetchedAt: Date.now(),
    title: agg.title ?? null,
    directory: agg.header.cwd ?? null,
    diff: null, // DSH keeps no per-session diff summary
    currentTool: last
      ? { name: last.name, status: last.status ?? "running", input: last.input, at: last.at }
      : null,
    thinking: agg.lastThinking,
    // the panel renders turns[0] (input/output/reasoning of the newest model
    // call); DSH reports usage per assistant message, so those are exact
    turns: agg.recentUsage,
    tokens: {
      requests: agg.requests,
      input: agg.inputTokens,
      output: agg.outputTokens,
      reasoning: agg.reasoningTokens,
      cacheRead: agg.cacheRead,
      cacheCreate: agg.cacheCreate,
      maxContext: agg.maxContext,
    },
    // DSH records the model's real context window per request; the static
    // table is only a fallback for logs that predate that event
    modelWindow: agg.contextWindow ?? modelWindow(agg.model?.model),
    errors: agg.recentErrors.map((e) => ({ type: e.type, message: head(e.message, 200), at: e.at })),
    todos: agg.todos,
  };
}

// ---------- live conversation (the /conversation.html feed) ----------

// Cursors are the log's own event sequence: "d:<seq>". First load returns the
// tail of the record buffer (oldest first), a resume returns what was appended
// past the cursor, so a poll moves bytes proportional to what was said.
const CURSOR_PREFIX = "d";
const CONV_TAIL = 400;

function parseCursor(after) {
  if (after == null) return null;
  const n = Number(String(after).split(":")[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toItems(page, agg, firstLoad) {
  const items = [];
  for (const r of page) {
    if (r.kind === "user") {
      if (r.text?.trim()) items.push({ kind: "text", role: "user", text: r.text, at: r.at });
      continue;
    }
    if (r.kind === "assistant") {
      for (const b of r.blocks ?? []) {
        if (b.type === "text" && b.text?.trim()) {
          items.push({ kind: "text", role: "assistant", text: b.text, at: r.at });
        } else if (b.type === "reasoning" && b.text?.trim()) {
          items.push({ kind: "think", role: "assistant", text: b.text, at: r.at });
        }
      }
      continue;
    }
    const info = agg.calls.get(r.callId);
    if (r.kind === "call") {
      // The chip is emitted from the call only when no result exists anywhere
      // in the log (an interrupted call) and only on a full load. On a live
      // poll the result is what carries the status, so a call that is still
      // running shows up when it finishes — one chip per call, never two.
      if (!firstLoad || info?.status) continue;
      items.push({ kind: "tool", role: "assistant", tool: r.name, status: "running", input: r.input, at: r.at });
      continue;
    }
    if (r.kind === "result") {
      items.push({
        kind: "tool",
        role: "assistant",
        tool: info?.name ?? r.name ?? "?",
        status: r.isError ? "error" : "completed",
        input: info?.input ?? null,
        at: r.at,
      });
    }
  }
  return items;
}

export function sessionMessages(id, after) {
  const path = findLogPath(cfg.dir, id);
  if (!path) return null;
  subscribe(path); // keeps normalized records for this session in memory
  let agg = readSession(path, { collect: true });
  if (!agg) return null;
  const base = {
    sessionId: id,
    title: agg.title ?? null,
    directory: agg.header?.cwd ?? null,
  };
  const cursorSeq = parseCursor(after);
  if (after != null && cursorSeq == null) {
    return { ...base, cursor: after, items: [] }; // garbage cursor: no replay
  }

  let records = recordsOf(path) ?? [];
  const firstLoad = cursorSeq == null;
  let page;
  if (firstLoad) {
    page = records.slice(-CONV_TAIL);
  } else {
    // A cursor older than the record buffer (a tab suspended for a long time)
    // is answered by rebuilding the buffer from the log: the client may miss
    // records between its cursor and the rebuilt window, but it never gets a
    // record twice.
    if (records.length && cursorSeq < records[0].seq) {
      // the rebuild starts a fresh aggregate; take it, or the chip names and
      // arguments resolved through the old one would be lost
      agg = readSession(path, { collect: true, reset: true }) ?? agg;
      records = recordsOf(path) ?? [];
    }
    page = records.filter((r) => r.seq > cursorSeq);
  }

  const items = toItems(page, agg, firstLoad);
  const cursor = page.length ? `${CURSOR_PREFIX}:${page[page.length - 1].seq}` : after ?? `${CURSOR_PREFIX}:0`;
  return { ...base, cursor, items };
}
