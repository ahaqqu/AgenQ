// AgenQ OpenCode adapter config: telemetry paths and defaults.
//
// OpenCode keeps every session in one SQLite DB at
// `~/.local/share/opencode/opencode.db`. AgenQ is Linux-first, so a Windows
// install is reached through `/mnt/<drive>/Users/<user>/…` exactly the way
// the mimocode adapter reaches MiMo Desktop. Unlike that adapter, discovery
// does not stop at the first hit: several OpenCode installs can sit on one
// machine (a native one and a Windows one), and the board merges them.
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";

const take = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** every `--opencode-db` on the command line, in order. */
function explicitDbs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--opencode-db" && argv[i + 1]) out.push(argv[i + 1]);
  }
  return out;
}

/** Candidate opencode.db locations, most specific first. */
export function candidateDbs() {
  const home = homedir();
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  // native Linux / macOS install (XDG data home, then the usual default)
  push(join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode", "opencode.db"));
  push(join(home, ".local", "share", "opencode", "opencode.db"));

  // WSL: every Windows profile mount — an opencode installed on Windows
  try {
    for (const drive of readdirSync("/mnt")) {
      const usersDir = `/mnt/${drive}/Users`;
      if (!existsSync(usersDir)) continue;
      for (const user of readdirSync(usersDir)) {
        push(join(usersDir, user, ".local", "share", "opencode", "opencode.db"));
      }
    }
  } catch {
    // no /mnt (not WSL) — fine
  }

  // Windows native (AgenQ is Linux-first, but the flag still works)
  if (process.env.USERPROFILE) {
    push(join(process.env.USERPROFILE, ".local", "share", "opencode", "opencode.db"));
  }
  return out;
}

export function resolveDbs(explicit) {
  // an explicit path (flag or env) replaces discovery entirely
  if (explicit.length) return explicit;
  const env = (process.env.OPENCODE_DB ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (env.length) return env;
  const found = [];
  for (const p of candidateDbs()) {
    try {
      if (existsSync(p)) found.push(p);
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  // fall back to the native path so a missing install reads as empty
  return found.length ? found : [join(homedir(), ".local", "share", "opencode", "opencode.db")];
}

export function parseArgs(argv) {
  const out = {
    windowHours: 12,
    dbs: resolveDbs(explicitDbs(argv)),
    // where staged copies of foreign-FS DBs live (WSL reading /mnt/c)
    cacheDir: take(argv, "--opencode-cache") ?? join("/tmp", "agenq-opencode"),
    // how long /api/stats may reuse a computed answer (the legacy-free v2
    // history still costs a full pass over every message)
    statsTtlMs: Number(take(argv, "--opencode-stats-ttl") ?? 60_000),
  };
  out.windowHours = Number(take(argv, "--window-hours") ?? out.windowHours);
  return out;
}

export const cfg = parseArgs(process.argv.slice(2));
export const WINDOW_MS = cfg.windowHours * 3600_000;

/**
 * Assistant rows read per session per poll. The sparkline's points, the
 * card's context peak and the run's standing error all come out of this one
 * window, so every read stays index-bounded instead of streaming a
 * session's whole payload (see snapshot.mjs).
 */
export const RECENT_LIMIT = 120;
