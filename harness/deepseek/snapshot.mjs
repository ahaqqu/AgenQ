// AgenQ DeepSeek Harness snapshot assembly: one poll's read-only view of the
// DSH telemetry on disk. Walks <DSH_HOME>/sessions, folds each session's
// append-only event log into a board row, and answers the two questions the
// DSH installation itself answers authoritatively: what is live (the kernel's
// flock table) and what has been archived (the workspace store).
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cfg, WINDOW_MS } from "./config.mjs";
import {
  SUPPORTED_FORMAT_VERSIONS,
  corruptBytesOf,
  findLogFile,
  listSessionDirs,
  readAggregate,
  sessionHeader,
  zstdAvailable,
} from "./log.mjs";
import { newAgg, visibleError } from "./fold.mjs";
import { keepInWindow, projectFromDir } from "../lib.mjs";

export const ACTIVE_MS = 5 * 60_000; // heartbeat within this = active; idle past it = sleep
const TICKER_PER_SESSION = 15; // caps one busy agent's share of the merged ticker

// DSH holds a kernel flock(2) on <session>/session.lock for the whole life of
// its write handle (see dsh-session-persistence-jsonl/lease). The kernel
// releases it on process death, so the lock table is a per-session liveness
// signal no polling heuristic can fake. Read it once per snapshot.
//
// Matching is by inode ONLY, deliberately: the lock table's device field is the
// superblock device (btrfs subvolumes here print 00:1d while stat() reports an
// anonymous st_dev), so comparing devices would break liveness on exactly the
// machines this runs on. The residual risk is an inode alias on another
// filesystem marking a session live — accepted, and cheaper to live with than
// a liveness check that never matches.
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
// recently it wrote its last event. When /proc/locks is unavailable the lease
// is unknown and recency is the fallback.
//
// "Clean" is DSH's own turn-end vocabulary minus the two endings that mean the
// work stopped abnormally: `error` (a structured failure) and `interrupted`
// (the crash-orphaned closer the loop appends to a repair). `blocked` (a
// pre-step hook veto) and `max-tokens` (a step hit its output ceiling) are
// deliberate endings, and a session with no `turn/end` at all never finished.
const CLEAN_TURN_ENDS = new Set(["completed", "aborted", "blocked", "max-tokens"]);
export function deriveStatus({ now, agg, live }) {
  const lastAt = agg.lastAt || 0;
  const awake = lastAt > 0 && now - lastAt <= ACTIVE_MS;
  if (visibleError(agg)) return "failed";
  const finished = CLEAN_TURN_ENDS.has(agg.lastTurnEnd?.kind);
  if (!(live ?? awake)) return finished ? "done" : lastAt > 0 ? "exited" : "idle";
  return awake ? "running" : "sleep";
}

// One row constructor for every DSH session: a full aggregate for logs inside
// the window, a header-only aggregate for a parent that anchors a kept subtree.
// A windowed-out parent is rendered from its header alone (its events were
// deliberately not read), so its row reports `idle` rather than guessing an
// ending it never saw — the anchor exists to hang the subtree, not to claim a
// status.
function toSession({ id, agg, now, live, windowed = false }) {
  const h = agg.header ?? {};
  const cwd = h.cwd ?? null;
  const isSubagent = h.origin === "subagent";
  const calls = [...agg.calls.values()];
  const lastCall = calls.at(-1) ?? null;
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
    status: windowed ? "idle" : deriveStatus({ now, agg, live }),
    requests: agg.requests,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheRead: agg.cacheRead,
    cacheCreate: agg.cacheCreate,
    maxContext: agg.maxContext,
    // the model's real window when the log recorded it — the card's context
    // gauge and the sparkline cliff are measured against this, not a constant
    contextWindow: agg.contextWindow ?? null,
    firstAt: agg.firstAt ?? h.createdAt ?? null,
    lastAt: agg.lastAt || (agg.firstAt ?? 0),
    sparkline: agg.sparkline,
    lastError: visibleError(agg),
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
  for (const { id, dir } of listSessionDirs(cfg.dir)) {
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
  const warnings = [];
  for (const c of candidates) {
    if (c.mtimeMs < cutoff) continue;
    let agg;
    try {
      agg = readAggregate(c.logPath);
    } catch {
      // one unreadable log (permissions, a file replaced mid-read) must not
      // take the rest of the harness off the board; the next poll retries it
      continue;
    }
    if (!agg?.header) continue; // empty or unreadable log — nothing to show
    // A generation this fold cannot vouch for is skipped, not guessed at: the
    // alternative is rendering a future vocabulary's rows under today's names.
    const version = Number(agg.header.version);
    if (Number.isFinite(version) && !SUPPORTED_FORMAT_VERSIONS.has(version)) {
      warnings.push(`${c.id}: unreadable log format v${version} (this build folds v0–v3) — session skipped`);
      continue;
    }
    const corrupt = corruptBytesOf(c.logPath);
    if (corrupt > 0) {
      warnings.push(`${c.id}: ${corrupt} byte(s) of a damaged frame dropped; the events after it were recovered`);
    }
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
      const header = sessionHeader(c.logPath);
      all.push(toSession({ id: parentId, agg: newAgg(header), now, live: liveOf(c.dir), windowed: true }));
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
    warnings,
  };
}
