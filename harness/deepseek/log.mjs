// AgenQ DeepSeek Harness telemetry reader.
//
// DSH persists one append-only event log per session:
//
//   <DSH_HOME>/sessions/<escaped-cwd>/<session-id>/session[.vN].jsonl[.zstd]
//
// Every append is written as its own small Zstandard frame, so the file is a
// concatenation of independent frames — not one stream. That property is what
// makes this adapter cheap: the reader remembers, per file, how many bytes it
// has already decoded and folds only the frames appended since the last poll
// into one aggregate. A 1.5s board poll touches the new bytes, never the
// (potentially tens-of-MB) whole log.
//
// The aggregate is the session's board row in raw form; conversation records
// are collected only for sessions someone actually opened (see subscribe()).
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { head, tail } from "../lib.mjs";

// Bun ships zstd in its own API; node:zlib carries it on recent Node builds.
// Either way a decompressor is the one hard requirement of this adapter.
const zlib = await import("node:zlib").catch(() => ({}));
const zstdDecompress =
  (typeof Bun !== "undefined" && typeof Bun.zstdDecompressSync === "function"
    ? (bytes) => Bun.zstdDecompressSync(bytes)
    : zlib.zstdDecompressSync) ?? null;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
// canonical generation names: version 0 is "session.jsonl[.zstd]", later
// generations carry a "vN" component (see dsh-session-persistence-jsonl)
const GENERATION_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

const SPARK_TAIL = 120; // sparkline points kept per agent
const CALLS_TAIL = 150; // tool calls kept per agent (ticker + chip status/args)
const READ_WINDOW = 8 * 1024 * 1024; // bytes decoded per read pass
const RECORDS_TAIL = 400; // conversation records kept per subscribed session
const TAIL_SUBSCRIBERS = 6; // sessions whose conversation records stay in memory
const RECENT_USAGE = 5; // model calls kept for the detail panel's turn rows
const RECENT_ERRORS = 3;
const THINK_TAIL = 600;

// conversation caps mirror the other adapters' (same shapes, same limits)
const CONV_TEXT_CAP = 12_000;
const CONV_THINK_CAP = 6_000;
const CONV_INPUT_CAP = 2_000;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// ---------- file discovery ----------

/** Canonical (newest-generation) log file inside one session directory. */
export function findLogFile(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // session vanished mid-poll — not an error
  }
  let best = null;
  let bestVersion = -1;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = GENERATION_RE.exec(e.name);
    if (!m) continue; // migrations/tmp files are not committed generations
    const version = m[1] ? Number(m[1]) : 0;
    const compressed = m[2] === ".zstd";
    if (version > bestVersion || (version === bestVersion && compressed)) {
      bestVersion = version;
      best = join(dir, e.name);
    }
  }
  return best;
}

/** Raw session id -> its log path, by scanning the sessions root once. */
export function findLogPath(dshDir, id) {
  // The id arrives URL-encoded from /api/session/:id/…, so it is untrusted
  // input that ends up in a path. DSH ids are `session-<uuid>` or `<uuid>`;
  // anything outside that alphabet (separators, "..", dots-first) is refused
  // rather than joined — the endpoint must never become a file probe.
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  const root = join(dshDir, "sessions");
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = join(root, p.name, id);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const file = findLogFile(dir);
    if (file) return file;
  }
  return null;
}

// ---------- zstd frame decoding ----------

function readRange(path, start, length) {
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const isMagicAt = (buf, i) =>
  buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
  buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3];

function nextMagic(buf, from) {
  for (let i = from; i + 4 <= buf.length; i++) if (isMagicAt(buf, i)) return i;
  return -1;
}

// Decode every *complete* frame in buf; anything that does not decode (a frame
// still being appended, or bytes after a false frame-magic hit) is returned as
// `rest` and retried on the next poll. A false magic inside frame data shows up
// as a decode failure, so the loop simply extends to the following boundary.
function decodeFrames(buf) {
  let pos = 0;
  let text = "";
  while (pos < buf.length) {
    let end = nextMagic(buf, pos + 4);
    let decoded = null;
    for (;;) {
      const sliceEnd = end === -1 ? buf.length : end;
      try {
        decoded = zstdDecompress(buf.subarray(pos, sliceEnd));
        pos = sliceEnd;
        break;
      } catch {
        if (end === -1) break; // ran out of data: incomplete tail frame
        end = nextMagic(buf, end + 4); // false magic — extend to the next one
      }
    }
    if (decoded == null) break;
    text += Buffer.from(decoded).toString("utf8");
  }
  return { text, rest: buf.subarray(pos) };
}

// ---------- aggregate ----------

function newAgg() {
  return {
    header: null,
    title: null,
    model: null, // { provider, model } of the most recent model call
    thinking: null, // reasoning effort
    contextWindow: null,
    agentPreset: null,
    subagent: null, // descriptor of a subagent session ({mode, provider, label})
    requests: 0,
    inputTokens: 0, // prompt tokens including cache reads (board semantics)
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    reasoningTokens: 0,
    maxContext: 0, // biggest single-request prompt
    sparkline: [],
    firstAt: null,
    lastAt: 0,
    lastSeq: -1,
    lastError: null,
    lastOkAt: 0,
    lastTurnEnd: null,
    todos: [],
    calls: new Map(), // callId -> { callId, name, input, at, status, outputBytes, exitCode }
    lastThinking: null,
    recentUsage: [],
    recentErrors: [],
    stepStart: null,
  };
}

function pushError(agg, err) {
  agg.lastError = err;
  agg.recentErrors.unshift(err);
  if (agg.recentErrors.length > RECENT_ERRORS) agg.recentErrors.length = RECENT_ERRORS;
}

function pushRecord(entry, rec) {
  const r = entry.records;
  if (!r) return;
  r.push(rec);
  if (r.length > RECORDS_TAIL) r.splice(0, r.length - RECORDS_TAIL);
}

// text length + trailing text of a tool result, without concatenating a
// potentially huge result body (a `read` of a big file can be megabytes)
function contentStats(content) {
  let bytes = 0;
  let last = "";
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.text === "string") {
        bytes += part.text.length;
        last = part.text;
      }
    }
  }
  return { bytes, last };
}

const textOfBlocks = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");

function foldEvent(agg, ev, entry) {
  const type = ev?.type;
  if (typeof type !== "string") return;
  const time = num(ev.time);
  if (time > agg.lastAt) agg.lastAt = time;
  if (Number.isFinite(ev.seq) && ev.seq > agg.lastSeq) agg.lastSeq = ev.seq;
  const d = ev.data ?? {};

  switch (type) {
    case "session":
      if (!agg.header) {
        agg.header = ev;
        agg.firstAt = num(ev.createdAt) || time;
      }
      break;

    case "session/title":
      if (d.title) agg.title = String(d.title);
      break;

    case "agent-preset/selected":
      agg.agentPreset = d.agentPreset ?? d.preset ?? agg.agentPreset;
      break;

    case "model/selection":
      agg.model = { provider: d.provider ?? null, model: d.model ?? null };
      agg.thinking = d.reasoningEffort ?? null;
      break;

    case "request/header": {
      // the config a request actually ran with — the most precise model +
      // reasoning-effort source (covers subagents too)
      const c = d.header?.config;
      if (c?.model) {
        agg.model = { provider: c.provider ?? null, model: c.model };
        agg.thinking = c.reasoningEffort ?? null;
      }
      break;
    }

    case "request/context":
      if (d.contextWindow) agg.contextWindow = num(d.contextWindow);
      break;

    case "step/start":
      agg.stepStart = { turn: d.turn, step: d.step, at: time };
      break;

    case "subagent/descriptor":
      agg.subagent = { mode: d.mode ?? null, provider: d.provider ?? null, label: d.label ?? null };
      break;

    case "todo/write":
      agg.todos = (Array.isArray(d.todos) ? d.todos : []).map((x) => ({
        content: String(x?.content ?? ""),
        status: x?.status === "completed" ? "done" : String(x?.status ?? "pending"),
      }));
      break;

    case "assistant/message": {
      const usage = d.usage ?? {};
      const prompt = num(usage.inputTokens) + num(usage.cacheReadTokens);
      // a model call the provider billed nothing for (an aborted or empty
      // response) is still a request, but a 0-token sparkline point and a
      // 0/0 turn row would be noise, so the counters only move when the log
      // actually measured the call
      const measured =
        usage.inputTokens != null || usage.outputTokens != null ||
        usage.cacheReadTokens != null || usage.reasoningTokens != null;
      agg.requests += 1;
      if (measured) {
        agg.inputTokens += prompt;
        agg.outputTokens += num(usage.outputTokens);
        agg.cacheRead += num(usage.cacheReadTokens);
        agg.cacheCreate += num(usage.cacheWriteTokens);
        agg.reasoningTokens += num(usage.reasoningTokens);
        if (prompt > agg.maxContext) agg.maxContext = prompt;
        agg.sparkline.push(prompt);
        if (agg.sparkline.length > SPARK_TAIL) agg.sparkline.shift();
      }
      agg.lastOkAt = Math.max(agg.lastOkAt, time);

      const src = d.message?.source;
      if (src?.model) agg.model = { provider: src.provider ?? null, model: src.model };

      const step = agg.stepStart;
      const inStep = step && step.turn === d.turn && step.step === d.step;
      if (measured) {
        agg.recentUsage.unshift({
          turn: d.turn ?? null,
          step: d.step ?? null,
          model_id: src?.model ?? agg.model?.model ?? null,
          started_at: inStep ? step.at : null,
          duration_ms: inStep ? Math.max(0, time - step.at) : null,
          // the board's input semantics: prompt tokens including cache reads
          input_tokens: prompt,
          output_tokens: num(usage.outputTokens),
          reasoning_tokens: num(usage.reasoningTokens),
          cache_read_input_tokens: num(usage.cacheReadTokens),
          cache_creation_input_tokens: num(usage.cacheWriteTokens),
        });
        if (agg.recentUsage.length > RECENT_USAGE) agg.recentUsage.length = RECENT_USAGE;
      }

      if (entry.records) {
        const blocks = [];
        for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
          if (b?.type === "text" && b.text) blocks.push({ type: "text", text: head(b.text, CONV_TEXT_CAP) });
          else if (b?.type === "reasoning" && b.text) {
            blocks.push({ type: "reasoning", text: tail(b.text, CONV_THINK_CAP) });
            agg.lastThinking = { text: tail(b.text, THINK_TAIL), at: time };
          }
        }
        pushRecord(entry, { seq: agg.lastSeq, at: time, kind: "assistant", blocks });
      } else {
        for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
          if (b?.type === "reasoning" && b.text) agg.lastThinking = { text: tail(b.text, THINK_TAIL), at: time };
        }
      }
      break;
    }

    case "user/message": {
      if (entry.records) {
        pushRecord(entry, { seq: agg.lastSeq, at: time, kind: "user", text: head(textOfBlocks(d.content), CONV_TEXT_CAP) });
      }
      break;
    }

    case "tool/call": {
      const callId = d.callId;
      if (!callId) break;
      const info = {
        callId,
        name: d.name ?? "?",
        input: d.arguments ? head(d.arguments, CONV_INPUT_CAP) : null,
        at: time,
        status: null,
        outputBytes: null,
        exitCode: null,
      };
      agg.calls.set(callId, info);
      if (agg.calls.size > CALLS_TAIL) agg.calls.delete(agg.calls.keys().next().value);
      if (entry.records) {
        pushRecord(entry, { seq: agg.lastSeq, at: time, kind: "call", callId, name: info.name, input: info.input });
      }
      break;
    }

    case "tool/result": {
      const msg = d.message ?? {};
      const block = msg.content?.[0] ?? {};
      const callId = msg.source?.callId ?? block.toolCallId ?? null;
      const isError = block.isError === true || d.error != null;
      const { bytes, last } = contentStats(block.content);
      // bash results carry their exit code as a trailing marker
      const exitMatch = /\[exit code: (\d+)\]\s*$/.exec(last.slice(-200));
      const exitCode = exitMatch ? Number(exitMatch[1]) : null;
      const info = callId ? agg.calls.get(callId) : null;
      if (info) {
        info.status = isError ? "error" : "completed";
        info.outputBytes = bytes;
        info.exitCode = exitCode;
      }
      if (entry.records && callId) {
        pushRecord(entry, {
          seq: agg.lastSeq,
          at: time,
          kind: "result",
          callId,
          name: info?.name ?? null,
          isError,
          outputBytes: bytes,
        });
      }
      break;
    }

    case "turn/end": {
      const reason = d.reason ?? {};
      const kind = reason.kind ?? "unknown";
      agg.lastTurnEnd = { kind, at: time };
      agg.stepStart = null;
      // a completed or user-aborted turn is a clean end: an older transient
      // error (a rate limit that was retried away) must not mark it failed
      if (kind === "completed" || kind === "aborted") agg.lastOkAt = Math.max(agg.lastOkAt, time);
      if (kind === "error") {
        pushError(agg, {
          type: reason.error?.code ?? "turn_error",
          message: reason.error?.message ?? "turn failed",
          at: time,
        });
      }
      break;
    }

    case "llm/retry": {
      // a retry is where rate limits and transport failures surface; it stays
      // visible until a later model call or completed turn proves recovery
      const f = d.failure ?? {};
      pushError(agg, {
        type: f.code ?? "llm_retry",
        message: f.message ?? "model call failed",
        at: time,
      });
      break;
    }

    default:
      break; // every other event type is scaffolding for the board
  }
}

// ---------- incremental reader ----------

const logs = new Map(); // path -> entry
const LOG_CACHE_MAX = 256; // decoded logs kept; beyond that the coldest are dropped
let useClock = 0;

function newEntry(collect) {
  return {
    ino: -1,
    size: 0,
    pending: Buffer.alloc(0),
    pendingText: "",
    agg: newAgg(),
    records: collect ? [] : null,
    tailUsed: collect ? ++useClock : 0,
    used: 0,
  };
}

function evictTails() {
  const subscribed = [...logs.values()].filter((e) => e.records);
  if (subscribed.length <= TAIL_SUBSCRIBERS) return;
  subscribed.sort((a, b) => a.tailUsed - b.tailUsed);
  for (const e of subscribed.slice(0, subscribed.length - TAIL_SUBSCRIBERS)) {
    e.records = null; // aggregates stay cached; only the conversation tail is dropped
    e.tailUsed = 0;
  }
}

// A long-lived monitor walks every session dir on every poll, so the cache
// needs a ceiling: the coldest entries without a subscribed conversation are
// dropped, and a dropped log simply decodes from the start on its next poll.
function evictLogs() {
  if (logs.size <= LOG_CACHE_MAX) return;
  const evictable = [...logs.entries()]
    .filter(([, e]) => !e.records)
    .sort((a, b) => a[1].used - b[1].used);
  for (const [path] of evictable.slice(0, logs.size - LOG_CACHE_MAX)) logs.delete(path);
}

function consume(entry, text) {
  if (!text) return;
  const all = entry.pendingText + text;
  const lines = all.split("\n");
  entry.pendingText = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // an unreadable line is not worth failing the whole poll
    }
    foldEvent(entry.agg, ev, entry);
  }
}

/**
 * Read one session log and return its aggregate, decoding only what was
 * appended since the previous call. `collect` also accumulates the normalized
 * conversation records used by the live conversation tab; `reset` throws the
 * cached state away and re-reads the file from the start.
 */
export function readSession(path, { collect = false, reset = false } = {}) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let entry = logs.get(path);
  if (reset || !entry || entry.ino !== st.ino || st.size < entry.size) {
    entry = newEntry(collect);
    entry.ino = st.ino;
    logs.set(path, entry);
  }
  if (collect && !entry.records) entry.records = [];
  if (collect) entry.tailUsed = ++useClock;
  entry.used = ++useClock;
  // Read in bounded windows rather than one buffer the size of the delta: a
  // session log can be hundreds of MB, and nothing here needs more than the
  // current window plus whatever partial frame is still being appended.
  while (st.size > entry.size) {
    const chunk = readRange(path, entry.size, Math.min(READ_WINDOW, st.size - entry.size));
    if (!chunk.length) break; // file truncated under us; next poll resets
    entry.size += chunk.length;
    const buf = entry.pending.length ? Buffer.concat([entry.pending, chunk]) : chunk;
    if (path.endsWith(".zstd")) {
      const { text, rest } = decodeFrames(buf);
      consume(entry, text);
      entry.pending = rest;
    } else {
      consume(entry, buf.toString("utf8"));
      entry.pending = Buffer.alloc(0);
    }
  }
  if (collect) evictTails();
  evictLogs();
  return entry.agg;
}

/** Aggregates for one session file, decoding the new bytes only. */
export function readAggregate(path) {
  return readSession(path);
}

// The header is the log's first line and its first frame is tiny. Decoding
// just that frame is how a session outside the window still contributes its
// real identity (cwd, parent, creation time) without paying for the log.
export function readHeader(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  for (let take = 64 * 1024; ; take *= 8) {
    const chunk = readRange(path, 0, Math.min(take, size));
    let line;
    if (path.endsWith(".zstd")) {
      if (!chunk.length || !isMagicAt(chunk, 0)) return null;
      const end = nextMagic(chunk, 4);
      try {
        line = Buffer.from(zstdDecompress(chunk.subarray(0, end === -1 ? chunk.length : end))).toString("utf8").split("\n")[0];
      } catch {
        line = undefined; // first frame larger than the probe — read more
      }
    } else {
      line = chunk.toString("utf8").split("\n")[0];
    }
    if (line !== undefined) {
      try {
        const ev = JSON.parse(line);
        return ev?.type === "session" ? ev : null;
      } catch {
        return null;
      }
    }
    if (take >= size) return null;
  }
}

/** Start (or continue) collecting conversation records for one session. */
export function subscribe(path) {
  const entry = logs.get(path);
  return readSession(path, { collect: true, reset: !entry?.records });
}

/** The collected conversation records, oldest first (may be empty/null). */
export function recordsOf(path) {
  return logs.get(path)?.records ?? null;
}

export function zstdAvailable() {
  return zstdDecompress != null;
}
