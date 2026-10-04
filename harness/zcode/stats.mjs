// AgenQ ZCode stats: the long-history view the board's window cannot show.
// Reads the same telemetry DB the snapshot does, but aggregates the whole
// model_usage table — one usage row per (local hour, project, provider,
// model) and one row per session. ZCode's per-request rows are timestamped,
// so hour buckets let the dashboard offer a real "last 24 hours" range, and
// the client can bucket by any range and group by any dimension.
import { cfg } from "./config.mjs";
import { emptyStats, mergeUsage, projectFromDir, roDb, rows, localKeyToMs } from "../lib.mjs";
import { gatherAgentLinks, toProjectDir } from "./snapshot.mjs";

/** `db` is injectable so the bucket-label test can drive a fixture database
 * under pinned non-UTC timezones; the registry calls it with no arguments. */
export async function stats({ db: dbPath = cfg.db } = {}) {
  const db = roDb(dbPath);
  if (!db) return emptyStats("hour");
  try {
    // The bucket is a local-calendar label, not a computed instant: SQLite
    // names each row's local hour and `localKeyToMs` is the single conversion
    // to a bucket start. Round-tripping the wall-clock string back through
    // strftime('%s', …) would reinterpret it as UTC and shift every bucket by
    // the host's offset (harness/zcode/stats.test.mjs pins this under a
    // non-UTC TZ).
    const usageRows = rows(db, `
      SELECT strftime('%Y-%m-%dT%H', mu.started_at/1000, 'unixepoch', 'localtime') AS bucket,
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
      SELECT s.id AS id,
             s.directory AS directory,
             s.time_created AS time_created,
             s.time_updated AS time_updated,
             MIN(mu.started_at) AS first_at,
             MAX(COALESCE(mu.completed_at, mu.started_at)) AS last_at
      FROM session s LEFT JOIN model_usage mu ON mu.session_id = s.id
      GROUP BY s.id`);

    const usage = new Map();
    for (const r of usageRows) {
      const at = localKeyToMs(r.bucket);
      mergeUsage(usage, at, projectFromDir(toProjectDir(r.directory)), r.provider, r.model, r);
    }

    // subagent-ness comes from the agents-dir link set, the board's own rule,
    // so the two surfaces classify a session identically
    const childIds = new Set(
      (await gatherAgentLinks()).map((l) => l.childSessionId).filter(Boolean),
    );

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
        isSubagent: childIds.has(r.id),
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
