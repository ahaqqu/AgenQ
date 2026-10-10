// Safe read-only opens of the MiMoCode trajectory DB.
//
// When the source sits on a foreign filesystem (WSL reading /mnt/c/...),
// SQLite WAL over 9p regularly raises "disk I/O error". Each poll therefore
// stages db+wal+shm into a local cache dir and opens that copy. On a native
// Linux install the live path is opened read-only directly (fresh connection
// per poll, same policy as the zcode adapter).
import { copyFileSync, mkdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";
import { cfg } from "./config.mjs";

function isForeignPath(p) {
  // WSL Windows mounts and other 9p/virtiofs paths
  return p.startsWith("/mnt/") || p.startsWith("/mnt/wsl") || p.includes("/mnt/");
}

function copyDbFamily(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  // drop stale sidecars first so a shrink/checkpoint cannot leave ghosts
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dest + suffix);
    } catch {
      /* not there */
    }
  }
  copyFileSync(src, dest);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      if (existsSync(src + suffix)) copyFileSync(src + suffix, dest + suffix);
    } catch {
      /* sidecar vanished mid-copy — the main db still opens */
    }
  }
  return dest;
}

/** Snapshot the source DB into the local cache; returns the path to open. */
export function stageDb(src = cfg.db, cacheDir = cfg.cacheDir) {
  if (!src || !existsSync(src)) return null;
  if (!isForeignPath(src)) return src;
  try {
    mkdirSync(cacheDir, { recursive: true });
    const dest = join(cacheDir, "mimocode.db");
    return copyDbFamily(src, dest);
  } catch {
    // copy failed (source locked, disk full) — try the live path anyway
    return src;
  }
}

/**
 * Fresh read-only connection for this poll. Returns null when the harness
 * is not installed / the DB is missing — adapters return their empty shape.
 * A present-but-broken DB throws so the registry surfaces a board warning.
 */
export function openDb() {
  const path = stageDb();
  if (!path) return null;
  try {
    // Verify it is actually a SQLite file before handing it to bun:sqlite —
    // a foreign file in the configured path should fail empty, not throw.
    const st = statSync(path);
    if (!st.isFile() || st.size < 16) return null;
    return new Database(path, { readonly: true });
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    // present but unreadable/corrupt: surface it
    throw new Error(`mimocode db unreadable (${path}): ${e?.message ?? e}`);
  }
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
