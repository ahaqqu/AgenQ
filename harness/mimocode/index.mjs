// AgenQ MiMo Desktop / MiMoCode harness adapter (see ../README.md for the
// contract). Reads the trajectory DB MiMo Desktop's embedded engine already
// writes on disk (~/.local/share/mimocode/mimocode.db, or the Windows profile
// via /mnt/c when AgenQ runs in WSL).
import { snapshot } from "./snapshot.mjs";
import { sessionDetail, sessionMessages } from "./detail.mjs";
import { stats } from "./stats.mjs";
import { cfg } from "./config.mjs";

export default {
  id: "mimocode",
  label: "MiMo Desktop",
  emoji: "🪟",
  // MiMo Desktop sessions live inside the Electron app / engine process —
  // there is no per-run stop surface AgenQ could call safely.
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
