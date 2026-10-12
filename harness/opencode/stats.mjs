// AgenQ OpenCode stats: long-history usage for the /stats.html dashboard.
// Every assistant message carries a real timestamp plus a per-request usage
// block, so usage can be attributed to the hour — `grain: "hour"`.
import { cfg } from "./config.mjs";
import { openAll, closeAll, rows, jsonCol, projectFromDir } from "./db.mjs";
import { usageFromTokens } from "./tokens.mjs";
import { emptyStats, localHourStart, mergeUsage } from "../lib.mjs";

// The dashboard loads on demand, and the walk costs a pass over every
// message in the history (and a staged copy first the first time) — reuse
// the answer for a minute rather than re-walking it per refresh.
let cache = null;

export async function stats() {
  if (cache && Date.now() - cache.at < cfg.statsTtlMs) return cache.value;
  const value = await compute();
  cache = { at: Date.now(), value };
  return value;
}

/** Test seam: drop the memoized answer. */
export function resetStats() {
  cache = null;
}

async function compute() {
  const { dbs } = await openAll();
  if (!dbs.length) return emptyStats("hour");
  try {
    const usage = new Map();
    const sessionRows = [];
    let minAt = null;
    let maxAt = null;

    for (const { db } of dbs) {
      const sessions = rows(
        db,
        `SELECT id, project_id, directory, parent_id, time_created, time_updated, time_archived
         FROM session_v2`,
      );
      const projects = rows(db, `SELECT id, name, worktree FROM project`);
      const byId = new Map(projects.map((p) => [p.id, p]));

      const live = sessions.filter((s) => s.time_archived == null);
      const projectOf = new Map();
      for (const s of live) {
        projectOf.set(
          s.id,
          projectFromDir(s.directory) ||
            projectFromDir(byId.get(s.project_id)?.worktree) ||
            byId.get(s.project_id)?.name ||
            (s.project_id && s.project_id !== "global" ? s.project_id : null),
        );
      }

      for (const r of rows(
        db,
        `SELECT session_id, time_created, data FROM session_message
         WHERE data LIKE '%"tokens"%'`,
      )) {
        if (!projectOf.has(r.session_id)) continue; // archived/hidden — board rule
        const data = jsonCol(r.data, null);
        if (!data?.tokens) continue;
        const at = r.time_created;
        if (at == null) continue;
        if (minAt == null || at < minAt) minAt = at;
        if (maxAt == null || at > maxAt) maxAt = at;
        const u = usageFromTokens(data.tokens);
        mergeUsage(
          usage,
          localHourStart(at),
          projectOf.get(r.session_id),
          data.model?.providerID ?? null,
          data.model?.id ?? null,
          {
            requests: 1,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheRead: u.cacheRead,
            cacheCreate: u.cacheCreate,
          },
        );
      }

      for (const s of live) {
        sessionRows.push({
          firstAt: s.time_created,
          lastAt: s.time_updated ?? s.time_created,
          project: projectOf.get(s.id),
          isSubagent: s.parent_id != null,
        });
      }
    }

    return {
      coverage: minAt != null ? { from: minAt, to: maxAt ?? Date.now() } : null,
      grain: "hour",
      notes: [
        "OpenCode records tokens per assistant message; `input` excludes cache reads on the wire, and AgenQ reports board-style input = input + cache.read so cache hit% stays comparable across harnesses.",
        "Sessions archived in opencode.db are excluded (same rule as the board).",
        "A data dir written by a pre-v2 opencode (no `session_v2` table) is skipped — open that install once with a current opencode and its history migrates in.",
      ],
      usage: [...usage.values()],
      sessions: sessionRows,
    };
  } finally {
    closeAll(dbs);
  }
}
