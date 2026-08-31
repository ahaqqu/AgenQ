// Snapshot assembly: one poll's read-only view of the whole board.
// Reads the ZCode telemetry DB (read-only, fresh connection per poll) and the
// agents dir, and folds them + live-process liveness into one JSON-able
// snapshot. Pure-ish: no server, no sockets.
import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cfg, WINDOW_MS } from "./config.mjs";

// directories inside a .zcode state dir (global or project-local) are not
// project dirs — subagent session rows point there; children inherit their
// manager's directory instead
const toProjectDir = (dir) =>
  dir && !dir.includes("/.zcode/") && !dir.endsWith("/.zcode") ? dir : null;

function roDb() {
  // Fresh read-only connection per poll: long-lived WAL readers get
  // invalidated by checkpoints, per-poll connections don't. A DB that
  // isn't there (ZCode never ran on this machine) returns null and the
  // board just renders empty instead of crashing the server.
  try {
    return new Database(cfg.db, { readonly: true });
  } catch {
    return null;
  }
}

function rows(db, sql, params = []) {
  if (!db) return [];
  return db.prepare(sql).all(...params);
}

function gatherDb() {
  const db = roDb();
  try {
    const run = (name, sql) => {
      try {
        return rows(db, sql);
      } catch (e) {
        throw new Error(`query ${name}: ${e.message}`);
      }
    };
    const usage = run("usage", `
      SELECT session_id,
             COUNT(*)            AS requests,
             SUM(input_tokens)   AS input_tokens,
             SUM(output_tokens)  AS output_tokens,
             SUM(cache_read_input_tokens)    AS cache_read,
             SUM(cache_creation_input_tokens) AS cache_create,
             MAX(input_tokens)   AS max_context,
             MAX(completed_at)   AS last_at,
             MIN(started_at)     AS first_at
      FROM model_usage GROUP BY session_id`);

    const spark = run("spark", `
      SELECT session_id, input_tokens, started_at
      FROM model_usage ORDER BY started_at`);

    // model + thinking level of each session's most recent request (ties →
    // both rows, map insertion order makes the later one win, which is harmless)
    const models = run("models", `
      SELECT session_id, model_id, variant AS thinking
      FROM model_usage mu
      WHERE completed_at = (SELECT MAX(completed_at) FROM model_usage x
                            WHERE x.session_id = mu.session_id)`);

    const errors = run("errors", `
      SELECT session_id, error_type, error_message, completed_at
      FROM model_usage
      WHERE error_type IS NOT NULL
      ORDER BY completed_at`);

    // a session is only failed if its most recent outcome is an error —
    // a successful request after the last error means it recovered
    const lastok = run("lastok", `
      SELECT session_id, MAX(completed_at) AS last_ok
      FROM model_usage
      WHERE status IN ('completed', 'cancelled')
      GROUP BY session_id`);

    // zcode stores "completed"; the UI and CSS speak "done"
    const todos = run("todos", `
      SELECT session_id, content,
             CASE WHEN status = 'completed' THEN 'done' ELSE status END AS status,
             position
      FROM todo ORDER BY session_id, position`);

    const tools = run("tools", `
      SELECT session_id, tool_name, output_bytes, status, exit_code, started_at
      FROM tool_usage ORDER BY started_at DESC LIMIT 60`);

    let titles = [];
    try {
      titles = rows(db, `SELECT id, title, parent_id, directory FROM session`);
    } catch {
      // older CLI builds may lack columns; titles are decorative
    }
    return { usage, spark, models, errors, lastok, todos, tools, titles };
  } finally {
    db?.close();
  }
}

async function gatherAgentLinks() {
  const links = [];
  let dirEntries;
  try {
    dirEntries = await readdir(cfg.agentsDir, { withFileTypes: true });
  } catch {
    return links; // no agents dir yet — standalone sessions only
  }
  for (const parent of dirEntries) {
    if (!parent.isDirectory() || !parent.name.startsWith("sess_")) continue;
    const parentDir = join(cfg.agentsDir, parent.name);
    let children;
    try {
      children = await readdir(parentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || !child.name.startsWith("agent_")) continue;
      try {
        const meta = JSON.parse(
          await readFile(join(parentDir, child.name, "metadata.json"), "utf8"),
        );
        links.push({
          parentSessionId: meta.parentSessionId ?? parent.name,
          childSessionId: meta.childSessionId ?? null,
          role: meta.profileId ?? meta.profile?.name ?? "subagent",
          model: meta.profile?.model ?? meta.model ?? null,
          status: meta.status ?? "unknown",
          error: meta.error ?? null,
          description: meta.description ?? null,
          createdAt: meta.createdAt ? Date.parse(meta.createdAt) : null,
          completedAt: meta.completedAt ? Date.parse(meta.completedAt) : null,
        });
      } catch {
        // unreadable metadata — skip, never fail the whole snapshot
      }
    }
  }
  return links;
}

// Live CLI sessions show up as `zcode-cli` processes whose cwd is the
// session's project directory (verified on this machine). The correlation
// is project-level: every CLI process in that directory belongs to the
// same run, so stopping is and must be presented as a project action.
export function gatherLiveProcs() {
  const byDir = new Map(); // directory -> pid[]
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return byDir; // /proc unavailable — no liveness signal, keep DB-derived status
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let pid;
    try {
      if (readFileSync(`/proc/${e}/comm`, "utf8").trim() !== "zcode-cli") continue;
      pid = Number(e);
      const cwd = readlinkSync(`/proc/${e}/cwd`);
      if (!byDir.has(cwd)) byDir.set(cwd, []);
      byDir.get(cwd).push(pid);
    } catch {
      // process vanished or not ours — skip
    }
  }
  return byDir;
}

// ---------- snapshot assembly ----------

const SPARK_TAIL = 120; // sparkline points per agent
export const ACTIVE_MS = 5 * 60_000; // heartbeat within this = active; idle past it = sleep

function assemble({ usage, spark, models, errors, lastok, todos, tools, titles, links, liveProcs, now }) {
  const cutoff = now - WINDOW_MS;

  const sessions = new Map();

  // project = last path segment of the session's working directory
  const titleById = new Map(
    titles.map((t) => {
      const directory = toProjectDir(t.directory);
      return [
        t.id,
        {
          ...t,
          directory,
          project: directory ? (directory.split("/").filter(Boolean).pop() ?? null) : null,
        },
      ];
    }),
  );
  const ensure = (id) => {
    if (!sessions.has(id)) {
      const t = titleById.get(id);
      sessions.set(id, {
        id,
        title: t?.title ?? null,
        parentId: t?.parent_id ?? null,
        project: t?.project ?? null,
        directory: t?.directory ?? null,
        role: null,
        model: null,
        thinking: null,
        status: "idle",
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        maxContext: 0,
        firstAt: null,
        lastAt: null,
        sparkline: [],
        lastError: null,
        todos: [],
        lastTool: null,
        children: [],
        parentSessionId: null,
      });
    }
    return sessions.get(id);
  };

  // model per session from its latest request, before the links loop so
  // profile-pinned metadata (when present) still wins
  const modelBySession = new Map(models.map((r) => [r.session_id, r]));
  for (const [id, r] of modelBySession) {
    const s = ensure(id);
    s.model ??= r.model_id;
    s.thinking ??= r.thinking || null;
  }

  // usage heartbeats
  const sparkBySession = new Map();
  for (const r of spark) {
    if (!sparkBySession.has(r.session_id)) sparkBySession.set(r.session_id, []);
    sparkBySession.get(r.session_id).push(r.input_tokens);
  }
  for (const r of usage) {
    const s = ensure(r.session_id);
    s.requests = r.requests;
    s.inputTokens = r.input_tokens;
    s.outputTokens = r.output_tokens;
    s.cacheRead = r.cache_read;
    s.cacheCreate = r.cache_create;
    s.maxContext = r.max_context;
    s.firstAt = r.first_at;
    s.lastAt = r.last_at;
    const series = sparkBySession.get(r.session_id) ?? [];
    s.sparkline = series.slice(-SPARK_TAIL);
  }

  // last error per session
  for (const e of errors) {
    const s = ensure(e.session_id);
    s.lastError = { type: e.error_type, message: e.error_message, at: e.completed_at };
    if (e.completed_at >= (s.lastAt ?? 0)) s.lastAt = e.completed_at;
  }

  // todos
  const todosBySession = new Map();
  for (const t of todos) {
    if (!todosBySession.has(t.session_id)) todosBySession.set(t.session_id, []);
    todosBySession.get(t.session_id).push({ content: t.content, status: t.status });
  }
  for (const [id, list] of todosBySession) ensure(id).todos = list;

  // recent tool ticker
  const toolBySession = new Map();
  for (const t of tools) {
    if (!toolBySession.has(t.session_id)) toolBySession.set(t.session_id, t);
  }
  for (const [id, t] of toolBySession) {
    ensure(id).lastTool = { name: t.tool_name, outputBytes: t.output_bytes, status: t.status, at: t.started_at };
  }

  // subagent links from the agents dir — the authoritative tree edges
  for (const l of links) {
    if (!l.childSessionId) continue;
    const child = ensure(l.childSessionId);
    const parent = ensure(l.parentSessionId);
    child.parentSessionId = l.parentSessionId;
    child.role = l.role;
    child.model = l.model ?? child.model;
    child.project = child.project ?? titleById.get(l.parentSessionId)?.project ?? null;
    child.directory = child.directory ?? titleById.get(l.parentSessionId)?.directory ?? null;
    child.linkStatus = l.status;
    child.description = l.description;
    if (l.error && !child.lastError) child.lastError = { type: "agent_failed", message: l.error, at: l.completedAt };
    if (l.completedAt && l.completedAt >= (child.lastAt ?? 0)) child.lastAt = l.completedAt;
    if (l.createdAt && (child.firstAt == null || l.createdAt < child.firstAt)) child.firstAt = l.createdAt;
    parent.children.push(child.id);
  }

  // status: failed > link state > activity recency. A heartbeat inside
  // ACTIVE_MS means running; anything quiet longer is asleep, even if the
  // agents-dir metadata still says "running".
  // Liveness from /proc overrides the DB's view of the past: a session whose
  // zcode-cli process is gone has exited, whatever the DB still claims.
  const lastOkBySession = new Map(lastok.map((r) => [r.session_id, r.last_ok]));
  for (const s of sessions.values()) {
    // an error older than the last successful request isn't a failure —
    // the session recovered
    const lastOk = lastOkBySession.get(s.id);
    if (s.lastError && lastOk != null && (s.lastError.at ?? 0) <= lastOk) s.lastError = null;
    s.live = s.directory == null ? null : liveProcs.has(s.directory);
    if (s.lastError) s.status = "failed";
    else if (s.linkStatus === "completed") s.status = "done";
    else {
      const last = s.lastAt ?? 0;
      const awake = last > 0 && now - last <= ACTIVE_MS;
      if (s.linkStatus) s.status = s.linkStatus === "running" ? (awake ? "running" : "sleep") : s.linkStatus;
      else if (last) s.status = awake ? "running" : "sleep";
      else s.status = "idle";
    }
    if (s.live === false && (s.status === "running" || s.status === "sleep")) s.status = "exited";
  }

  // keep recent sessions plus any ancestor of a kept session
  const keep = new Set();
  for (const s of sessions.values()) {
    const last = Math.max(s.lastAt ?? 0, s.firstAt ?? 0);
    if (last >= cutoff) {
      keep.add(s.id);
      let p = s.parentSessionId;
      while (p && !keep.has(p)) {
        keep.add(p);
        p = sessions.get(p)?.parentSessionId ?? titleById.get(p)?.parent_id ?? null;
      }
    }
  }

  const nodes = [...sessions.values()]
    .filter((s) => keep.has(s.id))
    .map((s) => ({ ...s, children: s.children.filter((c) => keep.has(c)) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = nodes.filter((n) => {
    const pid = n.parentSessionId;
    return !pid || !byId.has(pid);
  });

  // global ticker: most recent tool calls across kept sessions
  const ticker = tools
    .filter((t) => keep.has(t.session_id))
    .slice(0, 15)
    .map((t) => ({
      sessionId: t.session_id,
      tool: t.tool_name,
      outputBytes: t.output_bytes,
      status: t.status,
      exitCode: t.exit_code,
      at: t.started_at,
    }));

  const totals = nodes.reduce(
    (acc, n) => ({
      inputTokens: acc.inputTokens + n.inputTokens,
      outputTokens: acc.outputTokens + n.outputTokens,
      requests: acc.requests + n.requests,
    }),
    { inputTokens: 0, outputTokens: 0, requests: 0 },
  );

  return {
    generatedAt: now,
    windowHours: cfg.windowHours,
    totals,
    liveProcs: Object.fromEntries([...liveProcs].map(([d, pids]) => [d, pids.length])),
    sessions: nodes,
    roots: roots.map((r) => r.id),
    ticker,
  };
}

export async function snapshot({ now = Date.now() } = {}) {
  const { usage, spark, models, errors, lastok, todos, tools, titles } = gatherDb();
  const links = await gatherAgentLinks();
  const liveProcs = gatherLiveProcs();
  return assemble({ usage, spark, models, errors, lastok, todos, tools, titles, links, liveProcs, now });
}