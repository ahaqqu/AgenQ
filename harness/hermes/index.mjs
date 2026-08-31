// AgenQ Hermes harness adapter (see ../README.md for the contract).
// Teaches the monitor where Hermes keeps its telemetry and how its pieces map
// onto the harness-agnostic board.
import { snapshot } from "./snapshot.mjs";
import { sessionDetail, sessionMessages } from "./detail.mjs";
import { cfg } from "./config.mjs";

export default {
  id: "hermes",
  label: "Hermes",
  emoji: "👟",
  // Hermes runs sessions inside long-lived backend processes (gateway /
  // tui-gateway) that AgenQ has no safe, harness-native way to terminate —
  // no stopRun, so the board never offers one for hermes runs.
  hasStop: false,
  cfg,

  async snapshot(now) {
    return snapshot({ now });
  },

  // Rich per-session detail (lazy — only read when the UI expands a row).
  // Beyond the contract: core passes these through as raw JSON for harnesses
  // that offer them; the UI's detail panel renders whatever fields exist.
  detail(id) {
    return sessionDetail(id);
  },

  async messages(id, after) {
    return sessionMessages(id, after);
  },
};