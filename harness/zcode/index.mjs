// AgenQ ZCode harness adapter (see ../README.md for the contract).
// Teaches the monitor where ZCode keeps its telemetry and how its pieces map
// onto the harness-agnostic board.
import { snapshot, gatherLiveProcs } from "./snapshot.mjs";
import { sessionDetail, sessionMessages } from "./detail.mjs";
import { stopRun } from "./proccontrol.mjs";
import { cfg } from "./config.mjs";

export default {
  id: "zcode",
  label: "ZCode",
  emoji: "🦓",
  hasStop: true,
  cfg,

  async snapshot(now) {
    const snap = await snapshot({ now });
    // ZCode's project-level liveness: which directories have a live
    // zcode-cli process. Emitted as core-recognized session augmentation.
    snap.liveProcs = Object.fromEntries(
      [...gatherLiveProcs()].map(([d, pids]) => [d, pids.length]),
    );
    return snap;
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

  async stopRun(directory, { sessions }) {
    return stopRun(directory, { sessions });
  },
};