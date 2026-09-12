// DSH telemetry discovery + the incremental log cache.
//
// A DSH session log is append-only and can reach hundreds of MB, so this
// module never re-reads one: each entry remembers the byte offset it has
// consumed, the partial trailing frame, and the last bytes it consumed (a
// fingerprint that catches DSH's torn-tail repair rewriting the file under a
// live cursor). The event vocabulary itself lives in fold.mjs; frames.mjs owns
// the codec; discovery and caching live here.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONV_TAIL } from "../lib.mjs";
import { READ_WINDOW, decodeFrames, readHeader, readRange, zstdAvailable } from "./frames.mjs";
import { foldEvent, newAgg } from "./fold.mjs";

export { zstdAvailable };

// canonical generation names: version 0 is "session.jsonl[.zstd]", later
// generations carry a "vN" component with no leading zero
// (dsh-session-persistence-jsonl)
const GENERATION_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

// The generations this adapter's fold understands. DSH keeps immutable
// historical generations precisely because their physical rows can differ
// (v0/v1 pack assistant deltas), and its persistence contract requires a
// reader that meets a generation it cannot interpret to refuse rather than
// silently skip required events — so anything outside this set is skipped
// with a board warning instead of being folded as the current vocabulary.
export const SUPPORTED_FORMAT_VERSIONS = new Set([0, 1, 2, 3]);

const TAIL_IDLE_MS = 30_000; // a conversation buffer nobody has polled this long is dropped
const TAIL_HARD_MAX = 12; // ...and this many are kept whatever happens
const LOG_CACHE_MAX = 256; // decoded logs kept; beyond that the coldest are dropped
const FP_LEN = 16; // bytes of consumed-log fingerprint
// An undecodable trailing region larger than this is corruption, not a frame
// still being appended (DSH fsyncs one small frame per batch), so it is
// dropped and reported instead of being carried forever.
const PENDING_MAX = READ_WINDOW;

// ---------- discovery ----------

/** Every session directory DSH has materialized, across all projects. */
export function listSessionDirs(dshDir) {
  const root = join(dshDir, "sessions");
  const out = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // DSH never ran here — empty board, not an error
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projectDir = join(root, p.name);
    let sessions;
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (s.isDirectory()) out.push({ id: s.name, dir: join(projectDir, s.name) });
    }
  }
  return out;
}

/** Canonical (newest-generation) log file inside one session directory. */
export function findLogFile(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // session vanished mid-poll — not an error
  }
  let best = null;
  let bestKey = "";
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = GENERATION_RE.exec(e.name);
    if (!m) continue; // migrations/tmp files are not committed generations
    // deterministic order: newest version, compressed over plain, then name
    const key = `${String(m[1] ? Number(m[1]) : 0).padStart(6, "0")}:${m[2] === ".zstd" ? 1 : 0}:${e.name}`;
    if (key > bestKey) {
      bestKey = key;
      best = join(dir, e.name);
    }
  }
  return best;
}

/** Raw session id -> its log path. */
export function findLogPath(dshDir, id) {
  // The id arrives URL-encoded from /api/session/:id/…, so it is untrusted
  // input that ends up in a path. DSH ids are `session-<uuid>` or `<uuid>`;
  // anything outside that alphabet (separators, "..", dots-first) is refused
  // rather than joined — the endpoint must never become a file probe.
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  const hit = listSessionDirs(dshDir).find((s) => s.id === id);
  return hit ? findLogFile(hit.dir) : null;
}

// A header is the first line of the first frame, and it is all an
// out-of-window parent needs to anchor its subtree — cached by file identity
// so those parents cost a stat, not a probe, on every poll.
const headers = new Map(); // path -> { mtimeMs, size, header }
export function sessionHeader(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const hit = headers.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.header;
  const header = readHeader(path);
  headers.set(path, { mtimeMs: st.mtimeMs, size: st.size, header });
  if (headers.size > LOG_CACHE_MAX) {
    for (const key of [...headers.keys()].slice(0, headers.size - LOG_CACHE_MAX)) headers.delete(key);
  }
  return header;
}

// ---------- incremental cache ----------

const logs = new Map(); // path -> entry
let useClock = 0;

function newEntry(collect) {
  return {
    ino: -1,
    size: 0,
    fp: Buffer.alloc(0), // fingerprint of the consumed bytes [size - FP_LEN, size)
    pending: Buffer.alloc(0), // bytes read but not yet decoded (a partial frame)
    pendingText: "", // decoded but not yet a complete line
    corrupt: 0, // bytes dropped as an undecodable committed frame
    agg: newAgg(),
    records: collect ? [] : null,
    tailUsed: collect ? Date.now() : 0,
    used: 0,
  };
}

const fingerprintAt = (path, end) =>
  end > 0 ? readRange(path, Math.max(0, end - FP_LEN), Math.min(FP_LEN, end)) : Buffer.alloc(0);

// Reuse a cached entry only when it still describes this file: same inode, not
// shrunk, and — crucially — the bytes it already consumed are unchanged. DSH
// repairs a torn tail by truncating to the last good frame and re-appending,
// which can leave a file the same size or larger on the same inode; without
// the fingerprint that repair would silently freeze the aggregate forever.
function entryFor(path, st, collect, reset) {
  const prev = logs.get(path);
  let fresh = reset || !prev || prev.ino !== st.ino || st.size < prev.size;
  if (!fresh && prev.size > 0) {
    const fp = fingerprintAt(path, prev.size);
    fresh = fp.length !== prev.fp.length || !fp.equals(prev.fp);
  }
  if (!fresh) return prev;
  const entry = newEntry(collect);
  entry.ino = st.ino;
  logs.set(path, entry);
  return entry;
}

function pushRecord(entry, rec) {
  const r = entry.records;
  if (!r) return;
  r.push(rec);
  if (r.length > CONV_TAIL) r.splice(0, r.length - CONV_TAIL);
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
    const rec = foldEvent(entry.agg, ev);
    if (rec) pushRecord(entry, rec);
  }
}

// Plain (legacy, uncompressed) logs are decoded straight from bytes, so a
// multi-byte character split across a read boundary must be carried over
// rather than decoded into a replacement character.
function utf8SafeCut(buf) {
  let cont = 0;
  for (let i = buf.length; i > 0 && cont < 4; cont++) {
    const b = buf[i - 1];
    if ((b & 0xc0) === 0x80) {
      i -= 1;
      continue;
    }
    const need = (b & 0x80) === 0 ? 1 : (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    return need <= cont + 1 ? buf.length : i - 1;
  }
  return buf.length;
}

// Two eviction budgets. Conversation buffers are dropped after a quiet spell
// (a closed tab), so ≥7 open tabs do not thrash: an actively polled buffer is
// never evicted and never re-decoded. The hard maximum only exists so a
// runaway number of tabs cannot grow memory without bound.
function evictTails() {
  const now = Date.now();
  const subscribed = [...logs.values()].filter((e) => e.records);
  for (const e of subscribed) {
    if (now - e.tailUsed > TAIL_IDLE_MS) {
      e.records = null;
      e.tailUsed = 0;
    }
  }
  const kept = subscribed.filter((e) => e.records);
  if (kept.length <= TAIL_HARD_MAX) return;
  kept.sort((a, b) => a.tailUsed - b.tailUsed);
  for (const e of kept.slice(0, kept.length - TAIL_HARD_MAX)) {
    e.records = null;
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

/**
 * Read one session log and return its aggregate, decoding only what was
 * appended since the previous call. `collect` also accumulates the normalized
 * conversation records used by the live conversation tab (prefer subscribe()).
 */
export function readAggregate(path, { collect = false, reset = false } = {}) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const entry = entryFor(path, st, collect, reset);
  if (collect && !entry.records) entry.records = [];
  if (collect) entry.tailUsed = Date.now();
  entry.used = ++useClock;

  const startedAt = entry.size;
  // Read in bounded windows rather than one buffer the size of the delta: a
  // session log can be hundreds of MB, and nothing here needs more than the
  // current window plus whatever partial frame is still being appended.
  while (st.size > entry.size) {
    const chunk = readRange(path, entry.size, Math.min(READ_WINDOW, st.size - entry.size));
    if (!chunk.length) break; // file truncated under us; next poll resets
    entry.size += chunk.length;
    const buf = entry.pending.length ? Buffer.concat([entry.pending, chunk]) : chunk;
    if (path.endsWith(".zstd")) {
      const { text, rest, corrupt } = decodeFrames(buf);
      consume(entry, text);
      entry.corrupt += corrupt;
      entry.pending = rest;
    } else {
      const cut = utf8SafeCut(buf);
      consume(entry, buf.subarray(0, cut).toString("utf8"));
      entry.pending = Buffer.from(buf.subarray(cut));
    }
    // A trailing region this large can only be corruption, not a frame still
    // landing: drop it (and say so) rather than carry it into every poll and
    // rescan it forever.
    if (entry.pending.length > PENDING_MAX) {
      entry.corrupt += entry.pending.length;
      entry.pending = Buffer.alloc(0);
      entry.pendingText = "";
    }
  }
  if (entry.size !== startedAt) entry.fp = fingerprintAt(path, entry.size);

  evictTails();
  evictLogs();
  return entry.agg;
}

/** Bytes dropped from one session log as an undecodable committed frame. */
export function corruptBytesOf(path) {
  return logs.get(path)?.corrupt ?? 0;
}

/** Start (or continue) collecting conversation records; returns the aggregate. */
export function subscribe(path) {
  const entry = logs.get(path);
  return readAggregate(path, { collect: true, reset: !entry?.records });
}

/** Rebuild a session's record buffer from the log (a cursor older than it). */
export function resubscribe(path) {
  return readAggregate(path, { collect: true, reset: true });
}

/** The collected conversation records, oldest first (may be empty/null). */
export function recordsOf(path) {
  return logs.get(path)?.records ?? null;
}
