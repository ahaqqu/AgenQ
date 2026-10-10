// AgenQ MiMo Desktop / MiMoCode adapter config: telemetry paths and defaults.
// MiMoCode (the engine inside MiMo Desktop) keeps its trajectory DB at
// ~/.local/share/mimocode/mimocode.db. When AgenQ runs in WSL against a
// Windows install, that same file lives under /mnt/c/Users/<user>/.local/...
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";

const take = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Candidate mimocode.db locations, most specific first. */
export function candidateDbs() {
  const home = homedir();
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  // explicit env override (also used by tests)
  push(process.env.MIMOCODE_DB);

  // native Linux / macOS MiMo Desktop or mimocode CLI
  push(join(home, ".local", "share", "mimocode", "mimocode.db"));

  // WSL: Windows profile mounts (every /mnt/<drive>/Users/*)
  try {
    for (const drive of readdirSync("/mnt")) {
      const usersDir = `/mnt/${drive}/Users`;
      if (!existsSync(usersDir)) continue;
      for (const user of readdirSync(usersDir)) {
        push(join(usersDir, user, ".local", "share", "mimocode", "mimocode.db"));
      }
    }
  } catch {
    // no /mnt (not WSL) — fine
  }

  // Windows native (AgenQ is Linux-first, but the flag still works)
  if (process.env.USERPROFILE) {
    push(join(process.env.USERPROFILE, ".local", "share", "mimocode", "mimocode.db"));
  }
  return out;
}

export function resolveDb(explicit) {
  if (explicit) return explicit;
  for (const p of candidateDbs()) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  // fall back to the native path so a missing install reads as empty
  return join(homedir(), ".local", "share", "mimocode", "mimocode.db");
}

export function parseArgs(argv) {
  const out = {
    windowHours: 12,
    db: resolveDb(take(argv, "--mimocode-db") ?? process.env.MIMOCODE_DB),
    // where to stage a local copy when the source sits on a foreign FS (WSL /mnt/c)
    cacheDir: take(argv, "--mimocode-cache") ?? join("/tmp", "agenq-mimocode"),
  };
  out.windowHours = Number(take(argv, "--window-hours") ?? out.windowHours);
  out.db = resolveDb(take(argv, "--mimocode-db") ?? out.db);
  return out;
}

export const cfg = parseArgs(process.argv.slice(2));
export const WINDOW_MS = cfg.windowHours * 3600_000;
