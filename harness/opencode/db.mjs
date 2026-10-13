// AgenQ OpenCode DB access: staging-aware opens plus the small row/JSON kit
// the adapter's reads build on.
//
// A source only counts when it carries opencode's *current* schema
// (`session_v2` + `session_message`). A data dir written by a pre-v2
// opencode is a different product version — its `session_message` table
// still means something else there (agent/model-switched notices), so
// reading it as conversation data would be worse than not reading it. Such
// a dir is skipped, not an error: see docs/data-sources.md.
import { statSync } from "node:fs";
import { Database } from "bun:sqlite";
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

function openOne(path, src) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size < 16) return null;
    let db;
    try {
      db = new Database(path, { readonly: true });
    } catch {
      // a staged generation can be opened read-write when SQLite needs to
      // rebuild the WAL index; the cache dir is ours to write
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
export async function openAll({ sync = false } = {}) {
  const warnings = stageWarnings(cfg.dbs);
  const staged = await stageAll(cfg.dbs, { sync });
  const dbs = [];
  for (const { src, path } of staged) {
    const db = openOne(path, src);
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
    const db = openOne(path, src);
    if (db) dbs.push({ src, db });
  }
  return { dbs, warnings };
}

export function rows(db, sql, params = []) {
  if (!db) return [];
  return db.prepare(sql).all(...params);
}

/** JSON.parse a column, falling back to a default on malformed payloads. */
export function jsonCol(value, fallback = null) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Windows and POSIX paths both reduce to their last segment as the project name. */
export function projectFromDir(dir) {
  if (!dir) return null;
  const parts = String(dir).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** SQLite has a bound-parameter limit; chunk big id lists. */
export function idChunks(ids, size = 400) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** `?, ?, …` for an id chunk of length n. */
export const placeholders = (n) => Array(n).fill("?").join(",");
