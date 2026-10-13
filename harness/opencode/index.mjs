// AgenQ OpenCode harness adapter (see ../README.md for the contract).
// Reads the SQLite telemetry opencode already writes on disk
// (~/.local/share/opencode/opencode.db, or the Windows profile via /mnt/c
// when AgenQ runs in WSL).
import { snapshot } from "./snapshot.mjs";
import { sessionDetail, sessionMessages } from "./detail.mjs";
import { stats } from "./stats.mjs";
import { cfg } from "./config.mjs";

export default {
  id: "opencode",
  label: "OpenCode",
  emoji: "⌘",
  // Every opencode session runs inside the one opencode process (or its
  // desktop app) — there is no per-run stop surface AgenQ could call safely,
  // so the board never offers one for these runs.
  hasStop: false,
  cfg,
  stats,

  async snapshot(now) {
    return snapshot({ now });
  },

  detail(id) {
    return sessionDetail(id);
  },

  async messages(id, after) {
    return sessionMessages(id, after);
  },
};
