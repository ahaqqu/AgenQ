// AgenQ OpenCode staged reads.
//
// OpenCode's telemetry is one SQLite DB, and AgenQ runs Linux-first — so the
// interesting case is WSL reading a Windows install through `/mnt/<drive>`.
// SQLite WAL over that 9p/DrvFs mount is unusable two ways:
//
//   * a normal read-only open fails outright ("disk I/O error" — the WAL
//     shm index is mapped and locked in a way the mount does not support),
//   * `immutable=1` opens fine but silently ignores the WAL, so the board
//     would trail the real session by minutes of unwritten frames.
//
// The fix is to keep a local copy of the DB and read that. Copying the whole
// file on every poll is hopeless (203 MB takes seconds), and the file's own
// churn tells us what to copy: opencode checkpoints only every few minutes —
// measured on a live session, the main file's mtime moved once in 75s while
// the WAL's moved 29 times over a *fixed-size* 13 MB ring. So:
//
//   * first sighting: copy main + WAL into a generation directory,
//   * thereafter: copy only `-wal` when it moves (a few hundred ms),
//   * when the main file itself moves, build a fresh generation in the
//     background and swap it in — the board keeps rendering the old one
//     instead of stalling for a full copy.
//
// A copy is validated by re-stating the source afterwards: if the main file
// changed while we copied, main and WAL can belong to two different
// generations of pages, so that generation is discarded rather than served
// torn. Two generation directories exist so a swap never leaves the path a
// reader is about to open missing.
//
// Native paths (a real Linux install, anything not under /mnt) skip all of
// this and are opened read-only in place — same policy as the mimocode
// adapter.
import { basename, join } from "node:path";
import { copyFileSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { cfg } from "./config.mjs";

/** WSL Windows mounts and other 9p/virtiofs paths need a local copy. */
export const isForeignPath = (p) => typeof p === "string" && p.startsWith("/mnt/");

function statOrNull(p) {
  try {
    const st = statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

const sameStat = (a, b) => (a == null || b == null ? a === b : a.size === b.size && a.mtimeMs === b.mtimeMs);

// stable, filesystem-safe cache key for a source path
function keyFor(p) {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
  const name = basename(p).replace(/[^\w.-]/g, "_").slice(0, 40);
  return `${name}-${h.toString(36)}`;
}

export class Stage {
  constructor(src, cacheRoot = cfg.cacheDir) {
    this.src = src;
    this.root = join(cacheRoot, keyFor(src));
    this.gens = [join(this.root, "gen0"), join(this.root, "gen1")];
    this.slot = -1;
    this.path = null; // the staged db path currently served
    this.mainStat = null; // source main stat this generation reflects
    this.walStat = null; // source wal stat this generation reflects
    this.busy = null; // in-flight full copy
    this.error = null; // last failed copy, surfaced as a board warning
  }

  source() {
    const main = statOrNull(this.src);
    if (!main) return null;
    return { main, wal: statOrNull(`${this.src}-wal`) };
  }

  /**
   * The path readable *right now*, without staging anything: the detail
   * endpoint is synchronous, so it may only ever read what an earlier poll
   * already staged (a native path needs no staging at all).
   */
  peek() {
    if (this.path) return this.path;
    return isForeignPath(this.src) ? null : this.src;
  }

  /**
   * Bring the staged copy up to date with the source. The first sighting's
   * copy is awaited so the first poll renders; a later checkpoint is built in
   * the background and the current generation keeps serving until it lands.
   */
  async refresh() {
    const src = this.source();
    if (!src) {
      this.path = null;
      this.error = null;
      return null;
    }
    if (!isForeignPath(this.src)) {
      this.path = this.src;
      this.mainStat = src.main;
      this.walStat = src.wal;
      this.error = null;
      return this.path;
    }
    if (this.slot < 0 || !sameStat(src.main, this.mainStat)) {
      const p = !this.path ? await this.fullCopy(src) : this.kick(src);
      return p ?? this.path;
    }
    if (!sameStat(src.wal, this.walStat)) await this.walCopy();
    return this.path;
  }

  /** start a full copy without waiting; an existing one is reused. */
  kick(src) {
    if (this.busy) return this.path;
    this.fullCopy(src).catch(() => {});
    return this.path;
  }

  fullCopy(src) {
    if (this.busy) return this.busy;
    const job = this.#full(src).finally(() => {
      this.busy = null;
    });
    this.busy = job;
    return job;
  }

  async #full(src) {
    const target = this.gens[this.slot === 0 ? 1 : 0];
    try {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      const dest = join(target, basename(this.src));
      // WAL first, main second: a checkpoint landing mid-copy then shows up
      // as a changed main in the verification below.
      const walBefore = statOrNull(`${this.src}-wal`);
      if (walBefore) copyFileSync(`${this.src}-wal`, `${dest}-wal`);
      copyFileSync(this.src, dest);
      rmSync(`${dest}-shm`, { force: true }); // rebuilt from the WAL on open

      // Re-stat *after* the copy: the main check guards a checkpoint landing
      // mid-copy, and the WAL check guards an append landing mid-copy — a WAL
      // torn either way would pair pages that were never live together.
      const after = this.source();
      const walAfter = statOrNull(`${this.src}-wal`);
      if (!after || !sameStat(after.main, src.main) || !sameStat(walAfter, walBefore)) {
        // this generation may mix two page generations, so drop it and let
        // the next poll try again
        rmSync(target, { recursive: true, force: true });
        this.error = "opencode db was checkpointed during staging (retrying)";
        return null;
      }

      const prev = this.slot >= 0 ? this.gens[this.slot] : null;
      this.slot = this.slot === 0 ? 1 : 0;
      this.path = dest;
      this.mainStat = after.main;
      this.walStat = walAfter;
      this.error = null;
      if (prev && prev !== target) rmSync(prev, { recursive: true, force: true });
      return dest;
    } catch (e) {
      this.error = `opencode staging failed (${basename(this.src)}): ${e?.message ?? e}`;
      return null;
    }
  }

  /** Replace just the staged `-wal` (the common case while a session runs). */
  async walCopy() {
    const dest = `${this.path}-wal`;
    const tmp = `${dest}.tmp`;
    try {
      const walBefore = statOrNull(`${this.src}-wal`);
      if (!walBefore) return;
      copyFileSync(`${this.src}-wal`, tmp);
      // A checkpoint during the copy would pair a new main with this WAL,
      // and an append would tear the ring itself — either way the copy is
      // dropped and the next poll retries; only a main-file move kicks a
      // full generation, a WAL append just waits one more poll.
      const now = this.source();
      const walAfter = statOrNull(`${this.src}-wal`);
      if (!now || !sameStat(now.main, this.mainStat) || !sameStat(walAfter, walBefore)) {
        unlinkSync(tmp);
        if (now && !sameStat(now.main, this.mainStat)) this.kick(now);
        return;
      }
      renameSync(tmp, dest);
      rmSync(`${this.path}-shm`, { force: true }); // stale index for a new WAL
      // Post-copy source stat, not the dest's: the ring is fixed-size, so
      // freshness leans on mtime — a mount with coarse mtimes may delay one
      // refresh by a poll, and that converges on the next tick.
      this.walStat = walAfter;
      this.error = null;
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      // a failed WAL refresh is not fatal: the previous frames still open
      this.error = `opencode wal refresh failed: ${e?.message ?? e}`;
    }
  }
}

const stages = new Map();

export function stageFor(src) {
  let s = stages.get(src);
  if (!s) {
    s = new Stage(src);
    stages.set(src, s);
  }
  return s;
}

/**
 * Stage every configured source; returns `[{ src, path }]` for the ones that
 * produced a readable file. Sources are independent mounts/DBs, so they
 * stage concurrently; the first sighting's copy is awaited (so the first
 * poll has data) while later checkpoints build in the background.
 */
export async function stageAll(sources) {
  const settled = await Promise.all(
    sources.map(async (src) => ({ src, path: await stageFor(src).refresh() })),
  );
  return settled.filter((s) => s.path);
}

/** Errors worth showing on the board (a failed copy, a torn retry). */
export function stageWarnings(sources) {
  const out = [];
  for (const src of sources) {
    const err = stageFor(src).error;
    if (err) out.push(err);
  }
  return out;
}

/** Test seam: forget every staged generation. */
export function resetStages() {
  stages.clear();
}

/** Test seam: the staged path for a source, or null. */
export function stagedPath(src) {
  return stageFor(src).path;
}

/** Whatever is readable now, without waiting on a copy. */
export function peekPath(src) {
  return stageFor(src).peek();
}
