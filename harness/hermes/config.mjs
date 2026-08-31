// AgenQ Hermes adapter config: argv parsing and defaults for hermes telemetry
// paths. monitor.mjs stays the only file that knows about Bun.serve.
import { join } from "node:path";
import { homedir } from "node:os";

export function parseArgs(argv) {
  const out = {
    windowHours: 12,
    db: join(homedir(), ".hermes", "state.db"),
  };
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
  };
  out.windowHours = Number(take("--window-hours") ?? out.windowHours);
  out.db = take("--hermes-db") ?? out.db;
  return out;
}

export const cfg = parseArgs(process.argv.slice(2));
export const WINDOW_MS = cfg.windowHours * 3600_000;