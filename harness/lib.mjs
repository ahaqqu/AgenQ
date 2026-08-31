// Shared adapter kit: the pieces every SQLite-backed harness adapter needs.
// Extracted when the second adapter appeared (see the zcode/hermes review of
// PR #13) — a new adapter should map telemetry only, never re-derive these.
import { Database } from "bun:sqlite";

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

// hermes/zcode timestamp columns agree on REAL seconds; the board and UI
// speak epoch milliseconds
export const s2ms = (t) => (t == null ? null : Math.round(Number(t) * 1000));

export const tail = (s, n) => { s = String(s ?? ""); return s.length > n ? "…" + s.slice(-n) : s; };
export const head = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + " …" : s; };

// project = last path segment of the session's working directory
export const projectFromDir = (dir) =>
  dir ? (dir.split("/").filter(Boolean).pop() ?? null) : null;

// Context-window estimates for the fill gauge; unmatched models fall back to
// the same 200k cliff the sparkline uses.
const MODEL_WINDOWS = [
  [/glm/i, 200_000],
  [/kimi/i, 256_000],
  [/deepseek/i, 128_000],
];
export const modelWindow = (model) =>
  MODEL_WINDOWS.find(([re]) => re.test(model ?? ""))?.[1] ?? 200_000;

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