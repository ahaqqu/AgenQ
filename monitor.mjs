#!/usr/bin/env bun
/**
 * AgenQ — live mission-control monitor for ZCode main sessions and subagents.
 *
 * Reads (read-only) the local ZCode telemetry that already exists on disk:
 *   - ~/.zcode/cli/db/db.sqlite      — per-request token usage, tool calls, todos, session titles
 *   - ~/.zcode/cli/agents/.../agent_x/metadata.json — the manager→subagent links, role profiles, status, errors
 * and serves them as one JSON snapshot plus a static, dependency-free UI.
 *
 *   bun monitor.mjs [--port 8787] [--window-hours 12]
 *                   [--db ~/.zcode/cli/db/db.sqlite]
 *                   [--agents-dir ~/.zcode/cli/agents]
 *
 * Read-only by construction: the DB is opened per poll with mode=ro, and the
 * agents directory is only ever listed and read. Nothing here writes.
 */
import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
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

    const todos = run("todos", `
      SELECT session_id, content, status, position
      FROM todo ORDER BY session_id, position`);

    const tools = run("tools", `
      SELECT session_id, tool_name, output_bytes, status, exit_code, started_at
      FROM tool_usage ORDER BY started_at DESC LIMIT 60`);

    let titles = [];
    try {
      titles = rows(db, `SELECT id, title, parent_id, time_updated FROM session`);
    } catch {
      // older CLI builds may lack columns; titles are decorative
    }
    return { usage, spark, errors, todos, tools, titles };
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

async function assemble({ usage, spark, errors, todos, tools, titles, links, now }) {
  const cutoff = now - WINDOW_MS;

  const sessions = new Map();

  const titleById = new Map(titles.map((t) => [t.id, t]));
  const ensure = (id) => {
    if (!sessions.has(id)) {
      const t = titleById.get(id);
      sessions.set(id, {
        id,
        title: t?.title ?? null,
        parentId: t?.parent_id ?? null,
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
    child.linkStatus = l.status;
    child.description = l.description;
    if (l.error && !child.lastError) child.lastError = { type: "agent_failed", message: l.error, at: l.completedAt };
    if (l.completedAt && l.completedAt >= (child.lastAt ?? 0)) child.lastAt = l.completedAt;
    if (l.createdAt && (child.firstAt == null || l.createdAt < child.firstAt)) child.firstAt = l.createdAt;
    parent.children.push(child.id);
  }

  // status: derive from error + link status + activity recency
  for (const s of sessions.values()) {
    if (s.lastError) s.status = "failed";
    else if (s.linkStatus) s.status = s.linkStatus === "completed" ? "done" : s.linkStatus;
    else if (s.lastAt && now - s.lastAt < 90_000) s.status = "running";
    else if (s.lastAt) s.status = "done";
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
    .slice(0, 30)
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
    sessions: nodes,
    roots: roots.map((r) => r.id),
    ticker,
  };
}

async function snapshot() {
  const { usage, spark, errors, todos, tools, titles } = gatherDb();
  const links = await gatherAgentLinks();
  return assemble({ usage, spark, errors, todos, tools, titles, links, now: Date.now() });
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

Bun.serve({
  port: cfg.port,
  async fetch(req) {
    const url = new URL(req.url);
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
        headers: { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`AgenQ monitor → http://localhost:${cfg.port}`);
console.log(`  db:        ${cfg.db}`);
console.log(`  agents dir: ${cfg.agentsDir}`);
console.log(`  window:     last ${cfg.windowHours}h`);
