// AgenQ OpenCode DB access: staging-aware opens (see stage.mjs) over the
// shared row kit in ../lib.mjs, plus the opencode-specific session helpers.
//
// A source only counts when it carries opencode's *current* schema
// (`session_v2` + `session_message`). A data dir written by a pre-v2
// opencode is a different product version — its `session_message` table
// still means something else there (agent/model-switched notices), so
// reading it as conversation data would be worse than not reading it. Such
// a dir is skipped, not an error: see docs/data-sources.md.
import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { projectFromDir } from "../lib.mjs";
import { cfg } from "./config.mjs";
import { peekPath, stageAll, stageFor, stageWarnings } from "./stage.mjs";

function hasV2(db) {
  try {
    const names = new Set(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all()
        .map((r) => r.name),
    );
    return names.has("session_v2") && names.has("session_message");
  } catch {
    return false;
  }
}

function openOne(path, src, { writable = false } = {}) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size < 16) return null;
    let db;
    try {
      db = new Database(path, { readonly: true });
    } catch (ro) {
      // A staged generation may be opened read-write when SQLite needs to
      // rebuild the WAL index — the cache dir is ours to write. A native
      // source is never opened writable: a failed readonly open surfaces as
      // a board warning instead of touching the harness's live file.
      if (!writable) throw ro;
      db = new Database(path);
    }
    if (!hasV2(db)) {
      db.close();
      return null;
    }
    return db;
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`opencode db unreadable (${src}): ${e?.message ?? e}`);
  }
}

/**
 * Stage and open every configured source.
 * Returns `{ dbs: [{ src, db }], warnings }`; `warnings` carries staging
 * failures (a torn copy, a full copy that could not be verified).
 */
export async function openAll() {
  const warnings = stageWarnings(cfg.dbs);
  const staged = await stageAll(cfg.dbs);
  const dbs = [];
  for (const { src, path } of staged) {
    // only a staged copy (path !== src) may fall back to a writable handle
    const db = openOne(path, src, { writable: path !== src });
    if (db) dbs.push({ src, db });
  }
  return { dbs, warnings };
}

export function closeAll(dbs) {
  for (const { db } of dbs) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Sync open of whatever is readable *now*. The detail endpoint cannot await
 * a copy, so a foreign source that has not been staged yet is warmed for the
 * next call instead of blocking this one.
 */
export function openStaged() {
  const warnings = stageWarnings(cfg.dbs);
  const dbs = [];
  for (const src of cfg.dbs) {
    const path = peekPath(src);
    if (!path) {
      stageFor(src).refresh().catch(() => {});
      continue;
    }
    const db = openOne(path, src, { writable: path !== src });
    if (db) dbs.push({ src, db });
  }
  return { dbs, warnings };
}

/** Board project label for a session: directory, project worktree/name, or id. */
export function projectLabel(byId, s) {
  return (
    projectFromDir(s.directory) ||
    projectFromDir(byId.get(s.project_id)?.worktree) ||
    byId.get(s.project_id)?.name ||
    (s.project_id && s.project_id !== "global" ? s.project_id : null)
  );
}

/** SQLite has a bound-parameter limit; chunk big id lists. */
export function idChunks(ids, size = 400) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** `?, ?, …` for an id chunk of length n. */
export const placeholders = (n) => Array(n).fill("?").join(",");
