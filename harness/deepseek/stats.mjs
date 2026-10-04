// AgenQ DeepSeek Harness stats: the long-history view the board's window
// cannot show. DSH telemetry is per-session event logs, so this walks every
// non-archived session dir and folds each log — the aggregate's per-hour usage
// accumulator is always on, so logs the board already decoded are reused as-is
// and only history the board never touched is decoded here. The accumulator
// buckets by local hour, so a "last 24 hours" range is exact.
import { cfg } from "./config.mjs";
import {
  findLogFile,
  listSessionDirs,
  readAggregate,
  unsupportedGeneration,
  zstdAvailable,
} from "./log.mjs";
import { archivedIds } from "./snapshot.mjs";
import { emptyStats, localKeyToMs, mergeUsage, projectFromDir } from "../lib.mjs";
// A cold walk can decode a whole history; yielding between logs keeps the
// board's 1.5s poll responsive while the stats page computes (the server is a
// single event loop, so a tight synchronous loop here blocks it for seconds).
// The budget is time-based, not count-based: one multi-hundred-MB log can take
// longer to fold than a hundred small ones.
const YIELD_MS = 50; // event-loop budget between turns
const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));

export async function stats() {
  if (!zstdAvailable()) {
    throw new Error(
      "no zstd decompressor available — the deepseek adapter needs Bun's zstd API or node:zlib",
    );
  }
  const archived = archivedIds();

  const usage = new Map();
  const sessions = [];
  let from = Infinity;
  let to = 0;
  let lastWorkAt = Date.now(); // event-loop budget clock (see YIELD_MS)
  const unsupported = []; // generations this build refuses, by session id

  for (const { id, dir } of listSessionDirs(cfg.dir)) {
    if (archived.has(id)) continue;
    const logPath = findLogFile(dir);
    if (!logPath) continue;
    // yield when the last stretch of work has used up the budget, so the
    // board's poll gets a turn between log folds
    if (Date.now() - lastWorkAt >= YIELD_MS) {
      await yieldToLoop();
      lastWorkAt = Date.now();
    }
    let agg;
    try {
      agg = readAggregate(logPath);
    } catch {
      continue; // one unreadable log never takes the whole harness off the page
    }
    if (!agg?.header) continue; // empty or unreadable log
    // A generation the fold cannot vouch for is skipped. Unlike the board —
    // which only ever reads in-window sessions, so an old unsupported log is
    // never mentioned there — the stats walk reaches the whole history, so it
    // has to say what it left out or the page silently undercounts.
    const version = unsupportedGeneration(agg);
    if (version != null) {
      unsupported.push(`${id} (v${version})`);
      continue;
    }

    const project = projectFromDir(agg.header.cwd ?? null);
    const firstAt = Number(agg.firstAt) || Number(agg.header.createdAt) || null;
    const lastAt = Number(agg.lastAt) || firstAt;
    sessions.push({ firstAt, lastAt, project, isSubagent: agg.header.origin === "subagent" });
    if (firstAt && firstAt < from) from = firstAt;
    if (lastAt && lastAt > to) to = lastAt;

    for (const [hour, byProvider] of agg.usageByHour ?? []) {
      const at = localKeyToMs(hour);
      for (const [provider, byModel] of byProvider) {
        for (const [model, cell] of byModel) mergeUsage(usage, at, project, provider, model, cell);
      }
    }
  }

  const notes = [
    "session logs are append-only and live until their session is deleted or archived; archived sessions are excluded — the same subset the board shows",
    "Σ in includes cache reads — DSH records the prompt as input plus cache read (the board's own 'in' does the same)",
  ];
  if (unsupported.length) {
    notes.push(
      `${unsupported.length} session log(s) written in a format this build does not fold were left out: ${unsupported.join(", ")}`,
    );
  }

  return {
    coverage: Number.isFinite(from) && to > 0 ? { from, to } : null,
    grain: "hour",
    notes,
    usage: [...usage.values()],
    sessions,
  };
}
