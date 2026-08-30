#!/usr/bin/env bun
/**
 * AgenQ — live mission-control monitor for ZCode main sessions and subagents.
 *
 * Reads (read-only) the local ZCode telemetry that already exists on disk:
 *   - ~/.zcode/cli/db/db.sqlite      — per-request token usage, tool calls, todos, session titles
 *   - ~/.zcode/cli/agents/.../agent_x/metadata.json — the manager→subagent links, role profiles, status, errors
 * and serves them as one JSON snapshot (plus a lazy per-session detail
 * endpoint with tool arguments, thinking excerpts and token breakdowns read
 * from the `part`/`model_usage` tables only on demand) plus a static,
 * dependency-free UI.
 *
 *   bun monitor.mjs [--port 8787] [--window-hours 12]
 *                   [--db ~/.zcode/cli/db/db.sqlite]
 *                   [--agents-dir ~/.zcode/cli/agents]
 *
 * Read-only by construction: the DB is opened per poll with mode=ro, and the
 * agents directory is only ever listed and read. The single deliberate
 * exception is POST /api/stop — an explicit, user-clicked "stop run" that
 * SIGTERMs every zcode-cli process whose cwd matches a project directory.
 * Process correlation is project-level by nature, so the action is offered
 * and labeled as project-level in the UI. The server binds 127.0.0.1 only.
 */
import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------- config ----------

function parseArgs(argv) {
  const out = {
    port: 8787,
    windowHours: 12,
    db: join(homedir(), ".zcode", "cli", "db", "db.sqlite"),
    agentsDir: join(homedir(), ".zcode", "cli", "agents"),
  };
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
  };
  out.port = Number(take("--port") ?? out.port);
  out.windowHours = Number(take("--window-hours") ?? out.windowHours);
  out.db = take("--db") ?? out.db;
  out.agentsDir = take("--agents-dir") ?? out.agentsDir;
  return out;
}

const cfg = parseArgs(process.argv.slice(2));
const WINDOW_MS = cfg.windowHours * 3600_000;

// ---------- single instance: running `agenq` again restarts it ----------

// The port holder is identified via /proc/net/tcp socket inodes; only a
// process whose command line is AgenQ itself is ever a restart target.
function isMonitorCmdline(cmd) {
  return cmd.split("\0").some(
    (a) => a === "agenq" || a.endsWith("/agenq") || a === "monitor.mjs" || a.endsWith("/monitor.mjs"),
  );
}

function listenerPidOnPort(port) {
  const inodes = new Set();
  const hexPort = port.toString(16).padStart(4, "0").toUpperCase();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // sl local_address rem_address st … inode
      if (cols.length < 10 || cols[3] !== "0A" /* LISTEN */) continue;
      if (cols[1]?.split(":")[1] !== hexPort) continue;
      inodes.add(cols[9]);
    }
  }
  if (!inodes.size) return null;
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${e}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let tgt;
      try {
        tgt = readlinkSync(`/proc/${e}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = tgt.match(/^socket:\[(\d+)\]$/);
      if (!m || !inodes.has(m[1])) continue;
      try {
        if (!isMonitorCmdline(readFileSync(`/proc/${e}/cmdline`, "utf8"))) return null;
      } catch {
        return null;
      }
      return Number(e); // a real AgenQ holds the port
    }
  }
  return null; // port held by something that isn't AgenQ
}

function killAndWait(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      readFileSync(`/proc/${pid}/stat`);
    } catch {
      return; // gone
    }
    Bun.sleepSync(50);
  }
  console.log(`  pid ${pid} ignored SIGTERM — sending SIGKILL`);
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}
// directories inside a .zcode state dir (global or project-local) are not
// project dirs — subagent session rows point there; children inherit their
// manager's directory instead
const toProjectDir = (dir) =>
  dir && !dir.includes("/.zcode/") && !dir.endsWith("/.zcode") ? dir : null;

// ---------- db helpers ----------

function roDb() {
  // Fresh read-only connection per poll: long-lived WAL readers get
  // invalidated by checkpoints, per-poll connections don't.
  return new Database(cfg.db, { readonly: true });
}

function rows(db, sql, params = []) {
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
    return { usage, spark, errors, lastok, todos, tools, titles };
  } finally {
    db.close();
  }
}

// ---------- agents dir helpers ----------

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

// ---------- snapshot assembly ----------

const SPARK_TAIL = 120; // sparkline points per agent
const ACTIVE_MS = 5 * 60_000; // heartbeat within this = active; idle past it = sleep

async function assemble({ usage, spark, errors, lastok, todos, tools, titles, links, liveProcs, now }) {
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
    child.model = l.model;
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

async function snapshot() {
  const { usage, spark, errors, lastok, todos, tools, titles } = gatherDb();
  const links = await gatherAgentLinks();
  const liveProcs = gatherLiveProcs();
  return assemble({ usage, spark, errors, lastok, todos, tools, titles, links, liveProcs, now: Date.now() });
}

// ---------- per-session detail (lazy — only read when the UI expands a row) ----------

// Context-window estimates for the fill gauge; unmatched models fall back to
// the same 200k cliff the sparkline uses.
const MODEL_WINDOWS = [
  [/glm/i, 200_000],
  [/kimi/i, 256_000],
  [/deepseek/i, 128_000],
];
const modelWindow = (model) => MODEL_WINDOWS.find(([re]) => re.test(model ?? ""))?.[1] ?? 200_000;

const tail = (s, n) => { s = String(s ?? ""); return s.length > n ? "…" + s.slice(-n) : s; };
const head = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + " …" : s; };

function sessionDetail(id) {
  const db = roDb();
  try {
    const q = (sql, params = []) => {
      try { return rows(db, sql, params); } catch { return []; }
    };
    const sess = q(`SELECT title, directory, summary_additions, summary_deletions, summary_files
                    FROM session WHERE id = ?`, [id])[0] ?? null;

    // the live/latest tool call — part rows carry the arguments it was given
    let currentTool = null;
    const tp = q(`SELECT data, time_created FROM part
                  WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
                  ORDER BY time_created DESC LIMIT 1`, [id])[0];
    if (tp) {
      try {
        const d = JSON.parse(tp.data);
        const input = JSON.stringify(d.state?.input ?? {}) ?? "{}";
        currentTool = {
          name: d.tool ?? null,
          status: d.state?.status ?? null,
          input: input === "{}" ? null : head(input, 800),
          at: tp.time_created,
        };
      } catch { /* malformed part row — skip */ }
    }

    // newest thinking excerpt — tail only, the beginning is the stale half
    let thinking = null;
    const rp = q(`SELECT data, time_created FROM part
                  WHERE session_id = ? AND json_extract(data, '$.type') = 'reasoning'
                  ORDER BY time_created DESC LIMIT 1`, [id])[0];
    if (rp) {
      try {
        const d = JSON.parse(rp.data);
        if (d.text) thinking = { text: tail(d.text, 600), at: rp.time_created };
      } catch { /* malformed part row — skip */ }
    }

    const turns = q(`SELECT model_id, status, started_at, duration_ms, time_to_first_token_ms,
                            input_tokens, output_tokens, reasoning_tokens,
                            cache_read_input_tokens, cache_creation_input_tokens,
                            retry_count, context_exceeded
                     FROM model_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 5`, [id]);
    const sums = q(`SELECT COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
                           SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
                           SUM(cache_read_input_tokens) AS cache_read,
                           SUM(cache_creation_input_tokens) AS cache_create,
                           MAX(input_tokens) AS max_context
                    FROM model_usage WHERE session_id = ?`, [id])[0] ?? {};
    const errors = q(`SELECT error_type, error_message, completed_at FROM model_usage
                      WHERE session_id = ? AND error_type IS NOT NULL
                      ORDER BY completed_at DESC LIMIT 3`, [id]);
    const todos = q(`SELECT content,
                            CASE WHEN status = 'completed' THEN 'done' ELSE status END AS status
                     FROM todo WHERE session_id = ? ORDER BY position`, [id]);

    return {
      sessionId: id,
      fetchedAt: Date.now(),
      title: sess?.title ?? null,
      directory: sess?.directory ?? null,
      diff: sess
        ? { additions: sess.summary_additions, deletions: sess.summary_deletions, files: sess.summary_files }
        : null,
      currentTool,
      thinking,
      turns,
      tokens: {
        requests: sums.requests ?? 0,
        input: sums.input_tokens ?? 0,
        output: sums.output_tokens ?? 0,
        reasoning: sums.reasoning_tokens ?? 0,
        cacheRead: sums.cache_read ?? 0,
        cacheCreate: sums.cache_create ?? 0,
        maxContext: sums.max_context ?? 0,
      },
      modelWindow: modelWindow(turns[0]?.model_id),
      errors: errors.map((e) => ({ type: e.error_type, message: head(e.error_message ?? "", 200), at: e.completed_at })),
      todos: todos.map((t) => ({ content: t.content, status: t.status })),
    };
  } finally {
    db.close();
  }
}

// ---------- live conversation (the /conversation.html feed) ----------

// The conversation lives in `message` (role, sequence) × `part` (text /
// reasoning / tool rows). The client polls with the cursor returned here —
// the (message-sequence, part-sequence) pair of the last row it saw — and
// only rows past that pair come back, so a poll moves bytes proportional
// to what was actually said, not to the size of the session.
const CONV_TEXT_CAP = 12_000;
const CONV_THINK_CAP = 6_000;
const CONV_INPUT_CAP = 2_000;
const CONV_TAIL_PARTS = 400; // first load: the last N part rows, not the whole session

const convSel = `
  SELECT json_extract(m.data, '$.role') AS role,
         coalesce(m.sequence, 0) AS mseq,
         coalesce(p.sequence, 0) AS pseq,
         json_extract(p.data, '$.type') AS ptype,
         p.data AS pdata,
         p.time_created AS at
  FROM part p JOIN message m ON p.message_id = m.id`;

function convItem(r) {
  let d;
  try { d = JSON.parse(r.pdata); } catch { return null; }
  if (r.ptype === "text") {
    const text = String(d.text ?? "");
    if (!text.trim()) return null;
    return { kind: "text", role: r.role, text: head(text, CONV_TEXT_CAP), at: r.at };
  }
  if (r.ptype === "reasoning") {
    const text = String(d.text ?? "");
    if (!text.trim()) return null;
    return { kind: "think", role: r.role, text: tail(text, CONV_THINK_CAP), at: r.at };
  }
  if (r.ptype === "tool") {
    const input = JSON.stringify(d.state?.input ?? {}) ?? "{}";
    return {
      kind: "tool",
      role: r.role,
      tool: d.tool ?? "?",
      status: d.state?.status ?? null,
      input: input === "{}" ? null : head(input, CONV_INPUT_CAP),
      at: r.at,
    };
  }
  return null; // step-start/step-finish/timeline/file/compaction are scaffolding
}

function sessionMessages(id, after) {
  const db = roDb();
  try {
    const sess = rows(db, `SELECT title, directory FROM session WHERE id = ?`, [id])[0] ?? null;
    let cursor = after ?? "0:0";
    let parts;
    if (after) {
      const [a, b] = String(after).split(":").map(Number);
      const from = [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
      parts = rows(db, `${convSel}
        WHERE p.session_id = ?
          AND (coalesce(m.sequence,0), coalesce(p.sequence,0)) > (?, ?)
        ORDER BY coalesce(m.sequence,0), coalesce(p.sequence,0)
        LIMIT ${CONV_TAIL_PARTS}`, [id, ...from]);
    } else {
      // first load: newest CONV_TAIL_PARTS rows, oldest-first for rendering
      parts = rows(db, `${convSel}
        WHERE p.session_id = ?
        ORDER BY coalesce(m.sequence,0) DESC, coalesce(p.sequence,0) DESC
        LIMIT ${CONV_TAIL_PARTS}`, [id]).reverse();
    }
    const items = [];
    for (const r of parts) {
      cursor = `${r.mseq}:${r.pseq}`;
      const item = convItem(r);
      if (item) items.push(item);
    }
    return {
      sessionId: id,
      title: sess?.title ?? null,
      directory: sess?.directory ?? null,
      cursor,
      items,
    };
  } finally {
    db.close();
  }
}

// ---------- stop action (the one deliberate write) ----------

// Live CLI sessions show up as `zcode-cli` processes whose cwd is the
// session's project directory (verified on this machine). The correlation
// is project-level: every CLI process in that directory belongs to the
// same run, so stopping is and must be presented as a project action.
function gatherLiveProcs() {
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

const findSessionPids = (directory) => gatherLiveProcs().get(directory) ?? [];

async function handleStop(req) {
  const body = await req.json().catch(() => null);
  if (!lastGood) {
    return Response.json({ error: "no snapshot yet — poll /api/state first" }, { status: 400 });
  }
  // resolve the target directory: either given directly or via a session id
  let directory = typeof body?.directory === "string" ? body.directory : null;
  if (!directory && body?.sessionId) {
    directory = lastGood.sessions.find((x) => x.id === body.sessionId)?.directory ?? null;
  }
  if (!directory) {
    return Response.json({ error: "unknown session or directory" }, { status: 400 });
  }
  // only directories AgenQ actually saw in telemetry are valid targets
  const known = new Set(lastGood.sessions.map((x) => x.directory).filter(Boolean));
  if (!known.has(directory)) {
    return Response.json({ error: `directory not known to AgenQ: ${directory}` }, { status: 400 });
  }
  const project = lastGood.sessions.find((x) => x.directory === directory)?.project ?? directory;
  let pids;
  try {
    pids = findSessionPids(directory);
  } catch (e) {
    return Response.json({ error: "proc scan failed: " + e.message, killed: [] }, { status: 500 });
  }
  if (!pids.length) {
    return Response.json({ error: `no live zcode-cli process in ${directory} — run already exited`, killed: [] }, { status: 404 });
  }
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (e) {
      console.error(`SIGTERM ${pid} failed:`, e.message);
    }
  }
  console.log(`stop: SIGTERM ${killed.join(", ")} (${directory}) — project ${project}`);
  return Response.json({ killed, directory, project });
}

// ---------- server ----------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

let lastGood = null;
let lastError = null;

function startServer() {
  return Bun.serve({
  port: cfg.port,
  // the stop action makes this no longer harmless to expose — loopback only
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/stop" && req.method === "POST") {
      try {
        return await handleStop(req);
      } catch (e) {
        return Response.json({ error: String(e?.message ?? e), killed: [] }, { status: 500 });
      }
    }
    const detail = url.pathname.match(/^\/api\/session\/([^/]+)\/detail$/);
    if (detail && req.method === "GET") {
      try {
        return Response.json(sessionDetail(decodeURIComponent(detail[1])));
      } catch (e) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }
    const msgs = url.pathname.match(/^\/api\/session\/([^/]+)\/messages$/);
    if (msgs && req.method === "GET") {
      try {
        return Response.json(sessionMessages(decodeURIComponent(msgs[1]), url.searchParams.get("after")));
      } catch (e) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    }
    if (url.pathname === "/api/state") {
      try {
        lastGood = await snapshot();
        lastError = null;
        return Response.json(lastGood);
      } catch (e) {
        lastError = String(e?.message ?? e);
        console.error("snapshot failed:", e?.stack ?? lastError);
        return Response.json(
          { ...(lastGood ?? { sessions: [], roots: [], totals: { inputTokens: 0, outputTokens: 0, requests: 0 }, ticker: [] }), pollError: lastError },
          { status: lastGood ? 200 : 503 },
        );
      }
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(join(import.meta.dir, "public", rel));
    if (await file.exists()) {
      const ext = "." + rel.split(".").pop();
      return new Response(file, {
        headers: {
          "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
          // the UI is a dev tool that changes often — never let the browser
          // serve a stale board from heuristic caching
          "cache-control": "no-cache",
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
  });
}

try {
  startServer();
} catch (e) {
  if (!String(e?.code ?? e?.message).includes("EADDRINUSE")) throw e;
  const pid = listenerPidOnPort(cfg.port);
  if (!pid) {
    console.error(`port ${cfg.port} is already in use — and not by a restartable AgenQ instance.`);
    console.error(`  find it: ss -ltnp | grep ${cfg.port}   or pick another: agenq --port ${cfg.port + 1}`);
    process.exit(1);
  }
  console.log(`restarting AgenQ (stopping pid ${pid}) …`);
  killAndWait(pid);
  try {
    startServer();
  } catch {
    console.error(`port ${cfg.port} still unavailable after stopping pid ${pid}.`);
    process.exit(1);
  }
}

console.log(`AgenQ monitor → http://localhost:${cfg.port}`);
console.log(`  db:        ${cfg.db}`);
console.log(`  agents dir: ${cfg.agentsDir}`);
console.log(`  window:     last ${cfg.windowHours}h`);
