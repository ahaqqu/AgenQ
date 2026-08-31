// AgenQ server config: argv parsing and the derived constants every other
// module needs. monitor.mjs stays the only file that knows about Bun.serve.
import { join } from "node:path";
import { homedir } from "node:os";

export function parseArgs(argv) {
  const out = {
    port: 8787,
    windowHours: 12,
    db: join(homedir(), ".zcode", "cli", "db", "db.sqlite"),
    agentsDir: join(homedir(), ".zcode", "cli", "agents"),
  };
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
  };
  out.port = Number(take("--port") ?? out.port);
  out.windowHours = Number(take("--window-hours") ?? out.windowHours);
  out.db = take("--db") ?? out.db;
  out.agentsDir = take("--agents-dir") ?? out.agentsDir;
  return out;
}

export const cfg = parseArgs(process.argv.slice(2));
export const WINDOW_MS = cfg.windowHours * 3600_000;