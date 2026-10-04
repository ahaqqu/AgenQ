// AgenQ Hermes stats: the long-history view the board's window cannot show.
// Hermes keeps cumulative per-session totals plus per-(session, model,
// provider, task) usage rows with a first/last-seen pair — no per-request
// timestamps — so usage is attributed to the DAY a session-model pair first
// called the API and reported at `grain: "day"`: a range finer than a day
// (the dashboard's 24h preset) cannot honestly split these rows, so the page
// excludes them from such a range and says so instead of showing a whole
// day's tokens as if they were 24 hours'. Session rows carry the wall-clock
// span for agents/duration counts.
import { cfg } from "./config.mjs";
import { emptyStats, localDayStart, mergeUsage, projectFromDir, roDb, rows, s2ms } from "../lib.mjs";
import { childKind } from "./snapshot.mjs";

export function stats() {
  const db = roDb(cfg.db);
  if (!db) return emptyStats("day");
  try {
    const sessionRows = rows(db, `
      SELECT id, cwd, model, model_config,
             started_at, last_activity_at,
             api_call_count, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens
      FROM sessions WHERE archived = 0 AND hidden = 0`);

    // optional table (older builds may lack it): usage per (session, model,
    // provider). Filtered to the main task (`task = ''`), which is exactly
    // what the board's sessions.*_tokens / api_call_count columns hold —
    // hermes also records housekeeping work (title_generation, approval,
    // background_review, vision) in this table, and counting it here would
    // make BY HARNESS disagree with the board and with this module's own
    // session-row fallback.
    let taskRows = null;
    try {
      taskRows = rows(db, `
        SELECT session_id, model, billing_provider,
               MIN(first_seen) AS first_seen,
               SUM(api_call_count) AS requests,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read,
               SUM(cache_write_tokens) AS cache_create
        FROM session_model_usage
        WHERE task = ''
        GROUP BY session_id, model, billing_provider`);
    } catch {
      taskRows = null;
    }

    const usage = new Map();
    const projectById = new Map(sessionRows.map((s) => [s.id, projectFromDir(s.cwd)]));
    for (const t of taskRows ?? []) {
      // usage of a session AgenQ excludes (archived/hidden/deleted) stays out:
      // the stats must describe the same subset the board shows
      const project = projectById.get(t.session_id);
      if (project === undefined) continue;
      const at = s2ms(t.first_seen);
      if (!at) continue;
      mergeUsage(usage, localDayStart(at), project, t.billing_provider, t.model, t);
    }

    // fallback for builds without the usage table: the session's own totals
    // land on its start day, provider unknown
    if (!taskRows) {
      for (const s of sessionRows) {
        if (!Number(s.api_call_count)) continue;
        const at = s2ms(s.started_at);
        if (!at) continue;
        mergeUsage(
          usage,
          localDayStart(at),
          projectById.get(s.id) ?? null,
          null,
          s.model,
          { requests: s.api_call_count, input_tokens: s.input_tokens, output_tokens: s.output_tokens, cache_read: s.cache_read_tokens, cache_create: s.cache_write_tokens },
        );
      }
    }

    const sessions = [];
    let from = Infinity;
    let to = 0;
    for (const s of sessionRows) {
      const firstAt = s2ms(s.started_at);
      const lastAt = Math.max(s2ms(s.last_activity_at) ?? 0, firstAt ?? 0) || null;
      sessions.push({
        firstAt,
        lastAt,
        project: projectFromDir(s.cwd),
        isSubagent: childKind(s.model_config) === "delegate",
      });
      if (firstAt && firstAt < from) from = firstAt;
      if (lastAt && lastAt > to) to = lastAt;
    }

    return {
      coverage: Number.isFinite(from) && to > 0 ? { from, to } : null,
      grain: "day",
      notes: [
        "usage is attributed to the day a session-model pair first called the API — hermes keeps cumulative totals, not per-request timestamps, so ranges finer than a day cannot split them",
        "archived and hidden sessions are excluded — the same subset the board shows; hermes may hold more history than this",
        "Σ in is hermes's own input_tokens — cache reads and cache writes are recorded separately",
      ],
      usage: [...usage.values()],
      sessions,
    };
  } finally {
    db?.close();
  }
}
