// Shared adapter kit: the pieces every harness adapter needs, plus the small
// `roDb`/`rows`/`s2ms` SQLite kit the SQLite-backed ones build on.
// Extracted when the second adapter appeared (see the zcode/hermes review of
// PR #13) — a new adapter should map telemetry only, never re-derive these.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// read-only connection for this poll; a missing/corrupt DB returns null and
// the adapter returns its empty shape instead of failing the poll
export function roDb(path) {
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

export function rows(db, sql, params = []) {
  if (!db) return [];
  return db.prepare(sql).all(...params);
}

// hermes timestamp columns are REAL seconds (s2ms converts); zcode and
// DeepSeek Harness store epoch ms raw — only ever s2ms a hermes column
export const s2ms = (t) => (t == null ? null : Math.round(Number(t) * 1000));

export const tail = (s, n) => { s = String(s ?? ""); return s.length > n ? "…" + s.slice(-n) : s; };
export const head = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + " …" : s; };

// Conversation-feed anatomy, one home so the three adapters cannot drift:
// the per-item text caps every feed applies, and the row/record tail a first
// load returns (the conversation client says "older messages … not shown"
// with the same number).
export const CONV_TEXT_CAP = 12_000;
export const CONV_THINK_CAP = 6_000;
export const CONV_INPUT_CAP = 2_000;
export const CONV_TAIL = 400;

// Parse a conversation cursor — the numeric parts after the "<prefix>:" tag
// (hermes "m:<n>", deepseek "d:<n>", zcode the pair "z:<mseq>:<pseq>").
// `prefix` pins the feed that produced it (every feed tags its cursors with
// one); pass null to accept an untagged cursor too. Returns the numeric
// parts, or null for an absent or unusable cursor, which every adapter
// reads as "first load": a tab holding a foreign or hand-made cursor
// recovers on its next poll instead of replaying nothing forever.
export function parseCursor(after, prefix) {
  if (after == null) return null;
  const head = prefix != null ? `${prefix}:` : "(?:[A-Za-z]+:)?";
  const m = new RegExp(`^${head}(\\d+(?::\\d+)*)$`).exec(String(after));
  return m ? m[1].split(":").map(Number) : null;
}

// project = last path segment of the session's working directory, on either
// separator (telemetry may carry Windows paths even when AgenQ runs on Linux)
export const projectFromDir = (dir) => {
  if (!dir) return null;
  const parts = String(dir).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
};

/** JSON.parse a column, falling back to a default on malformed payloads. */
export function jsonCol(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Shared token fold for Anthropic-style wire usage:
//   { input, output, reasoning, cache: { read, write } }
// where `input` excludes cache reads. The board's `inputTokens` includes the
// cached part so cache-hit% = cacheRead / inputTokens stays in [0, 1] — one
// home so the adapters cannot drift on the fold.
export function usageFromTokens(tokens) {
  const t = tokens ?? {};
  const cache = t.cache ?? {};
  const input = Number(t.input) || 0;
  const cacheRead = Number(cache.read) || 0;
  const cacheCreate = Number(cache.write) || 0;
  const output = Number(t.output) || 0;
  const reasoning = Number(t.reasoning) || 0;
  return {
    inputTokens: input + cacheRead,
    outputTokens: output,
    cacheRead,
    cacheCreate,
    reasoningTokens: reasoning,
    prompt: input + cacheRead,
    total: Number(t.total) || input + cacheRead + output + reasoning + cacheCreate,
  };
}

// Candidate DB locations for the SQLite adapters that keep one file per
// install: the home default, every /mnt/<drive>/Users/* Windows profile
// (WSL), and the native-Windows profile. XDG and env overrides stay with the
// caller (adapters differ: first-hit vs every-hit, singular vs comma-split).
// Callers probe with existsSync and keep every hit (or the first).
export function scanProfileDbs(...suffix) {
  const out = [join(homedir(), ".local", "share", ...suffix)];
  try {
    for (const drive of readdirSync("/mnt")) {
      const usersDir = `/mnt/${drive}/Users`;
      if (!existsSync(usersDir)) continue;
      for (const user of readdirSync(usersDir)) {
        out.push(join(usersDir, user, ".local", "share", ...suffix));
      }
    }
  } catch {
    // no /mnt (not WSL) — fine
  }
  if (process.env.USERPROFILE) {
    out.push(join(process.env.USERPROFILE, ".local", "share", ...suffix));
  }
  return out;
}

// Local-calendar bucket keys for the stats dashboard. Bucketing is by the
// user's own calendar (a "September" means the user's September, and midnight
// means local midnight). A bucket is named by a wall-clock label and only then
// turned into an instant: keys are "YYYY-MM-DD" (day) and "YYYY-MM-DDTHH"
// (hour), and `localKeyToMs` is the single conversion back to a bucket's start.
// Producers must label, not round-trip an instant through SQLite — the zcode
// SQL emits strftime('%Y-%m-%dT%H', …, 'localtime') and the DSH fold uses
// `localHourKey`, with harness/zcode/stats.test.mjs enforcing that the two
// agree under a pinned non-UTC TZ.
export function localDayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localHourKey(ms) {
  return `${localDayKey(ms)}T${String(new Date(ms).getHours()).padStart(2, "0")}`;
}

// "YYYY-MM-DD" → that local midnight; "YYYY-MM-DDTHH" → that local hour start.
export function localKeyToMs(key) {
  const [date, hour] = String(key).split("T");
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, hour ? Number(hour) : 0).getTime();
}

export const localDayStart = (ms) => localKeyToMs(localDayKey(ms));
export const localHourStart = (ms) => localKeyToMs(localHourKey(ms));

// ---------- stats rows ----------

/** The empty shape every stats() returns for a missing/empty install. `grain`
 * is part of it: the page badges each harness with the resolution its
 * telemetry supports, and that is true even when nothing is on disk. */
export const emptyStats = (grain) => ({ coverage: null, grain, notes: [], usage: [], sessions: [] });

/** Row identity for the stats dashboard's usage rows: one row per (bucket
 * instant, project, provider, model), the shape harness/README.md documents. */
export const usageKey = (at, project, provider, model) =>
  `${at}|${project ?? ""}|${provider ?? ""}|${model ?? ""}`;

/** Merge one harness usage row into the shared accumulator map, so the three
 * adapters cannot drift on keys or counters. `counters` carries the SQL/event
 * names (requests, input_tokens, …) or the wire names (inputTokens, …). */
export function mergeUsage(usage, at, project, provider, model, counters) {
  const key = usageKey(at, project, provider, model);
  const row =
    usage.get(key) ??
    { at, project, provider, model, requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  row.requests += Number(counters.requests) || 0;
  row.inputTokens += Number(counters.inputTokens ?? counters.input_tokens) || 0;
  row.outputTokens += Number(counters.outputTokens ?? counters.output_tokens) || 0;
  row.cacheRead += Number(counters.cacheRead ?? counters.cache_read) || 0;
  row.cacheCreate += Number(counters.cacheCreate ?? counters.cache_create) || 0;
  usage.set(key, row);
  return row;
}

// The two-pass keep rule shared by every adapter: keep sessions with a
// heartbeat in the window, then any ancestor of a kept session (a parent
// whose own row is windowed out still anchors its subtree). Inputs are the
// assembled session objects; they need id, parentId, firstAt, lastAt.
export function keepInWindow(sessions, cutoff) {
  const keep = new Set();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    if (Math.max(s.lastAt ?? 0, s.firstAt ?? 0) >= cutoff) {
      keep.add(s.id);
      let p = s.parentId;
      while (p && !keep.has(p)) {
        keep.add(p);
        p = byId.get(p)?.parentId ?? null;
      }
    }
  }
  return keep;
}