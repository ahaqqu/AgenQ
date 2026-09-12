// AgenQ DeepSeek Harness lazy per-session reads: the detail panel and the
// live-conversation feed. Both are answered from the aggregate the snapshot
// poll already folded (see fold.mjs/log.mjs); the conversation additionally
// subscribes the session so its normalized records are kept in memory.
import { cfg } from "./config.mjs";
import { findLogPath, readAggregate, recordsOf, resubscribe, subscribe } from "./log.mjs";
import { CONV_TAIL, head, modelWindow, parseCursor } from "../lib.mjs";

// ---------- per-session detail (lazy — only read when the UI expands a row) ----------

export function sessionDetail(id) {
  const path = findLogPath(cfg.dir, id);
  if (!path) return null;
  const agg = readAggregate(path); // the detail panel needs the aggregate, not the record buffer
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

// One chip per tool call, exactly:
//  - a call whose result is in this page is emitted from the result (the final
//    status is the only status the append-only log actually recorded);
//  - a call with no result anywhere in the page can only be an interrupted or
//    still-running call, so on a full load it is emitted as running;
//  - on a live poll (resume) calls are skipped, so a call that is still
//    running when the poll happens is not followed by a duplicate chip once
//    its result lands — the result record carries it then.
// Records are self-contained, so none of this consults the aggregate.
function toItems(page, firstLoad) {
  const items = [];
  const answered = new Set();
  for (const r of page) if (r.kind === "result") answered.add(r.callId);
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
    if (r.kind === "call") {
      if (!firstLoad || answered.has(r.callId)) continue;
      items.push({ kind: "tool", role: "assistant", tool: r.name, status: "running", input: r.input, at: r.at });
      continue;
    }
    if (r.kind === "result") {
      items.push({
        kind: "tool",
        role: "assistant",
        tool: r.name ?? "?",
        status: r.isError ? "error" : "completed",
        input: r.input ?? null,
        at: r.at,
      });
    }
  }
  return items;
}

export function sessionMessages(id, after) {
  const path = findLogPath(cfg.dir, id);
  if (!path) return null;
  let agg = subscribe(path); // keeps normalized records for this session in memory
  if (!agg) return null;

  // an unusable cursor (a foreign format, a hand-made request) becomes a first
  // load rather than being echoed back forever, so the client recovers
  const [cursorSeq] = parseCursor(after, CURSOR_PREFIX) ?? [];
  const firstLoad = cursorSeq == null;

  let records = recordsOf(path) ?? [];
  if (!firstLoad && records.length && cursorSeq < records[0].seq) {
    // A cursor older than the record buffer (a tab suspended for a long time)
    // is answered by rebuilding the buffer from the log: the client may miss
    // records between its cursor and the rebuilt window, but it never gets a
    // record twice. Rebuilding also re-folds the aggregate, hence the re-read.
    agg = resubscribe(path) ?? agg;
    records = recordsOf(path) ?? [];
  }
  const page = firstLoad ? records.slice(-CONV_TAIL) : records.filter((r) => r.seq > cursorSeq);

  const items = toItems(page, firstLoad);
  const cursor = page.length
    ? `${CURSOR_PREFIX}:${page[page.length - 1].seq}`
    : firstLoad
      ? `${CURSOR_PREFIX}:0`
      : after;
  return {
    sessionId: id,
    title: agg.title ?? null,
    directory: agg.header?.cwd ?? null,
    cursor,
    items,
  };
}
