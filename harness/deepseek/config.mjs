// AgenQ DeepSeek Harness adapter config: argv parsing and defaults for DSH
// telemetry paths. monitor.mjs stays the only file that knows about Bun.serve.
import { join } from "node:path";
import { homedir } from "node:os";

export function parseArgs(argv) {
  const out = {
    windowHours: 12,
    // DSH's own home: $DSH_HOME when set (the harness documents it), else
    // the standard ~/.dsh. Everything the adapter reads hangs off this dir.
    dir: process.env.DSH_HOME || join(homedir(), ".dsh"),
  };
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
  };
  out.windowHours = Number(take("--window-hours") ?? out.windowHours);
  out.dir = take("--deepseek-dir") ?? out.dir;
  return out;
}

export const cfg = parseArgs(process.argv.slice(2));
export const WINDOW_MS = cfg.windowHours * 3600_000;
