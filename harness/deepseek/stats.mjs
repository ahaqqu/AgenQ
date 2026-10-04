// AgenQ DeepSeek Harness stats: the long-history view the board's window
// cannot show. DSH telemetry is per-session event logs, so this walks every
// non-archived session dir and folds each log with the stats accumulator
// (usageByDay) enabled — the first pass decodes history the board never
// reads, after that the incremental log cache keeps it current. The
// accumulator buckets by local hour, so a "last 24 hours" range is exact.
import { cfg } from "./config.mjs";
import {
  SUPPORTED_FORMAT_VERSIONS,
  findLogFile,
  listSessionDirs,
  readAggregate,
  zstdAvailable,
} from "./log.mjs";
import { archivedIds } from "./snapshot.mjs";
import { projectFromDir, localKeyToMs } from "../lib.mjs";

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

  for (const { id, dir } of listSessionDirs(cfg.dir)) {
    if (archived.has(id)) continue;
    const logPath = findLogFile(dir);
    if (!logPath) continue;
    let agg;
    try {
      agg = readAggregate(logPath, { withStats: true });
    } catch {
      continue; // one unreadable log never takes the whole harness off the page
    }
    if (!agg?.header) continue; // empty or unreadable log
    // a generation the fold cannot vouch for is skipped, as on the board —
    // the board poll surfaces the warning for it
    const version = Number(agg.header.version);
    if (Number.isFinite(version) && !SUPPORTED_FORMAT_VERSIONS.has(version)) continue;

    const project = projectFromDir(agg.header.cwd ?? null);
    const firstAt = Number(agg.firstAt) || Number(agg.header.createdAt) || null;
    const lastAt = Number(agg.lastAt) || firstAt;
    sessions.push({ firstAt, lastAt, project, isSubagent: agg.header.origin === "subagent" });
    if (firstAt && firstAt < from) from = firstAt;
    if (lastAt && lastAt > to) to = lastAt;

    for (const [hour, byProvider] of agg.usageByDay ?? []) {
      const at = localKeyToMs(hour);
      for (const [provider, byModel] of byProvider) {
        for (const [model, cell] of byModel) {
          const key = `${at}|${project ?? ""}|${provider ?? ""}|${model ?? ""}`;
          const acc =
            usage.get(key) ??
            { at, project, provider, model, requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
          acc.requests += cell.requests;
          acc.inputTokens += cell.inputTokens;
          acc.outputTokens += cell.outputTokens;
          acc.cacheRead += cell.cacheRead;
          acc.cacheCreate += cell.cacheCreate;
          usage.set(key, acc);
        }
      }
    }
  }

  return {
    coverage: Number.isFinite(from) && to > 0 ? { from, to } : null,
    grain: "hour",
    notes: [
      "session logs are append-only and live until their session is deleted or archived; archived sessions are excluded — the same subset the board shows",
      "Σ in includes cache reads — DSH records the prompt as input plus cache read (the board's own 'in' does the same)",
    ],
    usage: [...usage.values()],
    sessions,
  };
}
