// AgenQ ZCode stats: the long-history view the board's window cannot show.
// Reads the same telemetry DB the snapshot does, but aggregates the whole
// model_usage table — one usage row per (local hour, project, provider,
// model) and one row per session. ZCode's per-request rows are timestamped,
// so hour buckets let the dashboard offer a real "last 24 hours" range, and
// the client can bucket by any range and group by any dimension.
import { cfg } from "./config.mjs";
import { roDb, rows, projectFromDir } from "../lib.mjs";
import { toProjectDir } from "./snapshot.mjs";

export function stats() {
  const db = roDb(cfg.db);
  if (!db) return { coverage: null, notes: [], usage: [], sessions: [] };
  try {
    // Local-hour bucket start as epoch ms, computed inside SQLite and grouped
    // by the value (not just a label), so rows from one local hour land in one
    // bucket whatever the machine's timezone offset is. The round-trip through
    // strftime('%s', …, 'localtime') is what makes the bucket a real instant.
    const usageRows = rows(db, `
      SELECT CAST(strftime('%s', strftime('%Y-%m-%d %H:00:00', mu.started_at/1000, 'unixepoch', 'localtime')) AS INTEGER) * 1000 AS bucket,
             s.directory AS directory,
             mu.provider_id AS provider,
             mu.model_id AS model,
             COUNT(*) AS requests,
             SUM(mu.input_tokens) AS input_tokens,
             SUM(mu.output_tokens) AS output_tokens,
             SUM(mu.cache_read_input_tokens) AS cache_read,
             SUM(mu.cache_creation_input_tokens) AS cache_create
      FROM model_usage mu LEFT JOIN session s ON s.id = mu.session_id
      GROUP BY bucket, s.directory, mu.provider_id, mu.model_id`);

    // per-session span: from the usage rows when they exist (the board's own
    // firstAt/lastAt source), else the session row's timestamps
    const sessionRows = rows(db, `
      SELECT s.directory AS directory,
             s.parent_id AS parent_id,
             s.time_created AS time_created,
             s.time_updated AS time_updated,
             MIN(mu.started_at) AS first_at,
             MAX(COALESCE(mu.completed_at, mu.started_at)) AS last_at
      FROM session s LEFT JOIN model_usage mu ON mu.session_id = s.id
      GROUP BY s.id`);

    const usage = new Map();
    for (const r of usageRows) {
      const project = projectFromDir(toProjectDir(r.directory));
      const key = `${r.bucket}|${project ?? ""}|${r.provider ?? ""}|${r.model ?? ""}`;
      const acc =
        usage.get(key) ??
        { at: r.bucket, project, provider: r.provider, model: r.model, requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
      acc.requests += r.requests;
      acc.inputTokens += r.input_tokens ?? 0;
      acc.outputTokens += r.output_tokens ?? 0;
      acc.cacheRead += r.cache_read ?? 0;
      acc.cacheCreate += r.cache_create ?? 0;
      usage.set(key, acc);
    }

    const sessions = [];
    let from = Infinity;
    let to = 0;
    for (const r of sessionRows) {
      const firstAt = r.first_at ?? r.time_created ?? null;
      const lastAt = r.first_at != null ? r.last_at ?? r.first_at : r.time_updated ?? r.time_created ?? null;
      sessions.push({
        firstAt,
        lastAt,
        project: projectFromDir(toProjectDir(r.directory)),
        isSubagent: r.parent_id != null,
      });
      if (firstAt && firstAt < from) from = firstAt;
      if (lastAt && lastAt > to) to = lastAt;
    }

    return {
      coverage: Number.isFinite(from) && to > 0 ? { from, to } : null,
      grain: "hour",
      notes: [
        "Σ in is ZCode's own input_tokens — cache reads and cache creation are recorded separately",
        "AgenQ reads whatever ZCode still keeps in its SQLite telemetry; this banner's span is what is on disk",
      ],
      usage: [...usage.values()],
      sessions,
    };
  } finally {
    db?.close();
  }
}
