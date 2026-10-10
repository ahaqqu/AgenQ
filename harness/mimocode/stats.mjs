// AgenQ MiMo Desktop stats: long-history usage for the /stats.html dashboard.
// Every assistant message carries a real timestamp plus a per-request usage
// block, so usage can be attributed to the hour — `grain: "hour"`.
import { cfg } from "./config.mjs";
import { openDb, rows, jsonCol, projectFromDir } from "./db.mjs";
import { usageFromTokens } from "./tokens.mjs";
import { emptyStats, localHourStart, mergeUsage } from "../lib.mjs";

export function stats() {
  const db = openDb();
  if (!db) return emptyStats("hour");
  try {
    const sessions = rows(
      db,
      `SELECT id, project_id, directory, title, parent_id,
              time_created, time_updated, time_archived
       FROM session`,
    );
    let projects = [];
    try {
      projects = rows(db, `SELECT id, name FROM project`);
    } catch {
      projects = [];
    }

    const live = sessions.filter((s) => s.time_archived == null);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const projectOf = new Map();
    for (const s of live) {
      projectOf.set(
        s.id,
        projectFromDir(s.directory) ||
          projectById.get(s.project_id)?.name ||
          (s.project_id && s.project_id !== "global" ? s.project_id : null),
      );
    }

    const usage = new Map();
    const msgs = rows(
      db,
      `SELECT session_id, agent_id, time_created, data FROM message
       WHERE data LIKE '%"tokens"%'`,
    );
    let minAt = null;
    let maxAt = null;
    for (const r of msgs) {
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
        data.providerID ?? data.provider ?? null,
        data.modelID ?? data.model ?? null,
        {
          requests: 1,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheRead: u.cacheRead,
          cacheCreate: u.cacheCreate,
        },
      );
    }

    // session counters (agents/subagents/duration) — counted whole when the
    // range intersects their span
    const sessionRows = live.map((s) => {
      const isSub = s.parent_id != null;
      return {
        firstAt: s.time_created,
        lastAt: s.time_updated ?? s.time_created,
        project: projectOf.get(s.id),
        isSubagent: Boolean(isSub),
      };
    });

    // count subagent actors as their own session rows
    try {
      for (const a of rows(db, `SELECT session_id, actor_id, parent_actor_id, time_created, last_activity_time, time_completed FROM actor_registry`)) {
        if (!projectOf.has(a.session_id)) continue;
        const isMain = !a.actor_id || a.actor_id === "main" || a.mode === "main";
        if (isMain) continue;
        sessionRows.push({
          firstAt: a.time_created,
          lastAt: a.time_completed ?? a.last_activity_time ?? a.time_created,
          project: projectOf.get(a.session_id),
          isSubagent: true,
        });
      }
    } catch {
      /* actor_registry optional */
    }

    return {
      coverage: minAt != null ? { from: minAt, to: maxAt ?? Date.now() } : null,
      grain: "hour",
      notes: [
        "MiMo Desktop tokens are recorded per assistant message; `input` excludes cache reads on the wire, and AgenQ reports board-style input = input + cache.read so cache hit% stays comparable across harnesses.",
        "Sessions marked archived in mimocode.db are excluded (same rule as the board).",
      ],
      usage: [...usage.values()],
      sessions: sessionRows,
    };
  } finally {
    db?.close();
  }
}
