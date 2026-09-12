// AgenQ DeepSeek Harness (DSH) adapter (see ../README.md for the contract).
// Teaches the monitor where DSH keeps its telemetry and how its pieces map
// onto the harness-agnostic board.
import { snapshot } from "./snapshot.mjs";
import { sessionDetail, sessionMessages } from "./detail.mjs";
import { cfg } from "./config.mjs";

export default {
  id: "deepseek",
  label: "DeepSeek Harness",
  emoji: "🐋",
  // DSH sessions run inside long-lived `dsh` processes (the CLI's TUI or the
  // `dsh web` server) that host every open session at once — there is no
  // per-run stop surface AgenQ could call safely, so no stopRun.
  hasStop: false,
  cfg,

  async snapshot(now) {
    return snapshot({ now });
  },

  // Rich per-session detail (lazy — only read when the UI expands a row).
  detail(id) {
    return sessionDetail(id);
  },

  async messages(id, after) {
    return sessionMessages(id, after);
  },
};
