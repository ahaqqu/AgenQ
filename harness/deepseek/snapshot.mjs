// AgenQ DeepSeek Harness snapshot assembly: one poll's read-only view of the
// DSH telemetry on disk. Walks <DSH_HOME>/sessions, folds each session's
// append-only event log into a board row, and answers the two questions the
// DSH log itself answers authoritatively: what is live (the kernel's flock
// table) and what has been archived (the workspace store).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, WINDOW_MS } from "./config.mjs";
import { findLogFile, readAggregate, readHeader, zstdAvailable } from "./log.mjs";
import { keepInWindow, projectFromDir } from "../lib.mjs";

export const ACTIVE_MS = 5 * 60_000; // heartbeat within this = active; idle past it = sleep
const SPARK_TAIL = 120;
const TICKER_PER_SESSION = 15;

// Every session directory DSH has materialized, across all projects.
export function listSessionDirs() {
  const root = join(cfg.dir, "sessions");
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

// DSH holds a kernel flock(2) on <session>/session.lock for the whole life of
// its write handle (see dsh-session-persistence-jsonl/lease). The kernel
// releases it on process death, so the lock table is a per-session liveness
// signal no polling heuristic can fake. Read it once per snapshot.
function heldLockInodes() {
  try {
    const held = new Set();
    for (const line of readFileSync("/proc/locks", "utf8").split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f.length < 6 || (f[1] !== "FLOCK" && f[1] !== "POSIX")) continue;
      // /proc/locks prints "major:minor:inode" — the device is hex, the inode decimal
      const ino = Number(f[5].split(":")[2]);
      if (Number.isFinite(ino)) held.add(ino);
    }
    return held;
  } catch {
    return null; // no /proc (non-Linux): liveness stays unknown, never guessed
  }
}

const lockInode = (dir) => {
  try {
    return statSync(join(dir, "session.lock")).ino;
  } catch {
    return null;
  }
};

// Archived sessions are the ones the user put away in the DSH UI. The board
// mirrors that (like hermes's archived/hidden filter) — monitoring is not a
// reason to resurrect a session its owner closed.
let archivedCache = { mtimeMs: -1, ids: new Set() };
function archivedIds() {
  const path = join(cfg.dir, "storages", "workspace.json");
  try {
    const st = statSync(path);
    if (st.mtimeMs !== archivedCache.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const ids = raw?.global?.archivedSessionIds;
      archivedCache = { mtimeMs: st.mtimeMs, ids: new Set(Array.isArray(ids) ? ids : []) };
    }
  } catch {
    archivedCache = { mtimeMs: -1, ids: new Set() };
  }
  return archivedCache.ids;
}

// Status vocabulary (see ../README.md):
//   failed  — the newest error is newer than the newest proof of success
//   running — a heartbeat inside ACTIVE_MS while the session is still attached
//   sleep   — attached but quiet
//   done    — detached and its last turn ended cleanly
//   exited  — detached without a clean ending (crash / kill / interrupted)
//   idle    — no events at all (a seeded or never-used session)
// Liveness is exact here (the harness's own write lease), so it outranks
// recency: a session nothing holds open is never reported as running, however
// recently it wrote its last event.
export function deriveStatus({ now, agg, live }) {
  const lastAt = agg.lastAt || 0;
  const awake = lastAt > 0 && now - lastAt <= ACTIVE_MS;
  if (agg.lastError && (!agg.lastOkAt || agg.lastError.at > agg.lastOkAt)) return "failed";
  const kind = agg.lastTurnEnd?.kind;
  const finished = kind === "completed" || kind === "aborted";
  if (live === false) {
    if (finished) return "done";
    return lastAt > 0 ? "exited" : "idle";
  }
  if (awake) return "running";
  if (live === true) return "sleep";
  if (finished) return "done";
  return agg.lastTurnEnd ? "exited" : "idle";
}

function toSession({ id, agg, now, live }) {
  const h = agg.header ?? {};
  const cwd = h.cwd ?? null;
  const isSubagent = h.origin === "subagent";
  const calls = [...agg.calls.values()];
  const lastCall = calls.at(-1) ?? null;
  const lastAt = agg.lastAt || numOr(agg.firstAt, 0);
  return {
    id,
    title: agg.title ?? null,
    // a subagent's parent is recorded in its own session header
    parentId: isSubagent ? h.parentSession ?? null : null,
    project: projectFromDir(cwd),
    directory: cwd,
    role: isSubagent ? "subagent" : null,
    description: agg.subagent?.label ?? null,
    model: agg.model?.model ?? null,
    thinking: agg.thinking ?? null,
    status: deriveStatus({ now, agg, live }),
    requests: agg.requests,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheRead: agg.cacheRead,
    cacheCreate: agg.cacheCreate,
    maxContext: agg.maxContext,
    firstAt: agg.firstAt ?? h.createdAt ?? null,
    lastAt,
    sparkline: agg.sparkline.slice(-SPARK_TAIL),
    lastError: agg.lastError,
    todos: agg.todos,
    lastTool: lastCall
      ? {
          name: lastCall.name,
          outputBytes: lastCall.outputBytes,
          status: lastCall.status ?? "running",
          exitCode: lastCall.exitCode,
          at: lastCall.at,
        }
      : null,
    children: [],
    live,
  };
}

const numOr = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// A session whose own log is outside the window but that anchors a kept
// subtree: identity from the header, no counters to show.
function stubSession({ id, header, live }) {
  const cwd = header?.cwd ?? null;
  const isSubagent = header?.origin === "subagent";
  const createdAt = numOr(header?.createdAt, 0);
  return {
    id,
    title: null,
    parentId: isSubagent ? header?.parentSession ?? null : null,
    project: projectFromDir(cwd),
    directory: cwd,
    role: isSubagent ? "subagent" : null,
    description: null,
    model: null,
    thinking: null,
    status: "idle",
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    maxContext: 0,
    firstAt: createdAt || null,
    lastAt: createdAt,
    sparkline: [],
    lastError: null,
    todos: [],
    lastTool: null,
    children: [],
    live,
  };
}

export async function snapshot({ now = Date.now() } = {}) {
  if (!zstdAvailable()) {
    throw new Error(
      "no zstd decompressor available — the deepseek adapter needs Bun's zstd API or node:zlib",
    );
  }
  const archived = archivedIds();
  const held = heldLockInodes();
  const cutoff = now - WINDOW_MS;
  const liveOf = (dir) => {
    const ino = lockInode(dir);
    return held == null ? null : ino != null ? held.has(ino) : false;
  };

  // stat first: a session whose log has not been appended to inside the
  // window cannot be on the board, and its (possibly huge) log is not read at
  // all. Only sessions that pass the gate pay for a decode.
  const candidates = [];
  for (const { id, dir } of listSessionDirs()) {
    if (archived.has(id)) continue;
    const logPath = findLogFile(dir);
    if (!logPath) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(logPath).mtimeMs;
    } catch {
      continue; // vanished mid-poll
    }
    candidates.push({ id, dir, logPath, mtimeMs });
  }
  const byCandidate = new Map(candidates.map((c) => [c.id, c]));

  const all = [];
  const aggs = new Map();
  for (const c of candidates) {
    if (c.mtimeMs < cutoff) continue;
    const agg = readAggregate(c.logPath);
    if (!agg?.header) continue; // empty or unreadable log — nothing to show
    all.push(toSession({ id: c.id, agg, now, live: liveOf(c.dir) }));
    aggs.set(c.id, agg);
  }

  // An in-window session may name a parent whose own log is outside the
  // window (a quiet manager of a busy subtree). That parent still gets a row
  // from its header alone, so the tree stays rooted where the harness put it.
  const present = new Set(all.map((s) => s.id));
  for (const s of [...all]) {
    let parentId = s.parentId;
    while (parentId && !present.has(parentId)) {
      const c = byCandidate.get(parentId);
      if (!c) break;
      present.add(parentId);
      const header = readHeader(c.logPath);
      all.push(stubSession({ id: parentId, header, live: liveOf(c.dir) }));
      parentId = header?.parentSession ?? null;
    }
  }

  // manager->subagent edges: subagent headers name their parent; wire them
  // into the parent. The registry namespaces the ids afterwards.
  const byId = new Map(all.map((s) => [s.id, s]));
  for (const s of all) {
    const parent = s.parentId ? byId.get(s.parentId) : null;
    if (parent) parent.children.push(s.id);
  }

  const keep = keepInWindow(all, cutoff);
  const sessions = all
    .filter((s) => keep.has(s.id))
    .map((s) => ({ ...s, children: s.children.filter((c) => keep.has(c)) }));
  const keptIds = new Set(sessions.map((s) => s.id));

  // richer-than-lastTool ticker: the recent tool calls DSH logged per session
  const ticker = [];
  for (const id of keptIds) {
    const calls = [...(aggs.get(id)?.calls.values() ?? [])].slice(-TICKER_PER_SESSION);
    for (const c of calls) {
      ticker.push({
        sessionId: id,
        tool: c.name,
        outputBytes: c.outputBytes,
        status: c.status ?? "running",
        exitCode: c.exitCode,
        at: c.at,
      });
    }
  }

  return {
    sessions,
    roots: sessions.filter((s) => !s.parentId || !byId.has(s.parentId)).map((s) => s.id),
    ticker,
  };
}
