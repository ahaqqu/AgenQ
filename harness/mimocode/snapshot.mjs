// MiMo Desktop / MiMoCode snapshot assembly: one poll's read-only view of
// every session the trajectory DB holds. Tokens live on assistant messages
// (and the matching step-finish parts); subagents are actors inside a session
// (actor_registry) and are exposed as child cards of that session.
//
// Token semantics (Anthropic-style on the wire, board-style on the board):
//   mimocode tokens = { input, output, reasoning, cache: { read, write } }
//   where `input` EXCLUDES cache reads. The board's "in" includes the cached
//   part (see harness/deepseek/fold.mjs and public/app.js cache-hit), so
//   inputTokens = input + cache.read and cache hit = cache.read / inputTokens.
import { cfg, WINDOW_MS } from "./config.mjs";
import { openDb, rows, jsonCol, projectFromDir } from "./db.mjs";
import { usageFromTokens } from "./tokens.mjs";
import { keepInWindow, modelWindow } from "../lib.mjs";

export const ACTIVE_MS = 5 * 60_000;
const SPARK_TAIL = 120;

function gatherDb() {
  const db = openDb();
  if (!db) return null;
  try {
    const tables = new Set(rows(db, `SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name));
    if (!tables.has("session") || !tables.has("message")) return null;

    const run = (name, sql, params = []) => {
      try {
        return rows(db, sql, params);
      } catch (e) {
        throw new Error(`query ${name}: ${e.message}`);
      }
    };
    const optional = (sql, params = []) => {
      try {
        return rows(db, sql, params);
      } catch {
        return [];
      }
    };

    const sessions = run("sessions", `
      SELECT id, project_id, parent_id, title, directory,
             time_created, time_updated, time_archived
      FROM session
      WHERE time_archived IS NULL`);

    const projects = optional(`SELECT id, worktree, name FROM project`);

    // Assistant messages carry the per-request usage block. One row per
    // model call — the sparkline points and the token totals both come from
    // here. agent_id attributes the burn to main vs a subagent actor.
    const usage = run("usage", `
      SELECT id, session_id, agent_id, time_created, time_updated, data
      FROM message
      WHERE data LIKE '%"tokens"%'
      ORDER BY time_created`);

    const actors = optional(`
      SELECT session_id, actor_id, mode, parent_actor_id, status, agent,
             description, turn_count, last_turn_time, last_activity_time,
             last_error, time_completed, time_created
      FROM actor_registry`);

    const todos = optional(`
      SELECT session_id, content, status, position
      FROM todo
      ORDER BY session_id, position`);

    // Tool trail: parts of type 'tool' (state.status / state.output / tool name)
    const tools = optional(`
      SELECT id, session_id, time_created, data
      FROM part
      WHERE data LIKE '%"type": "tool"%' OR data LIKE '%"type":"tool"%'
      ORDER BY time_created DESC
      LIMIT 80`);

    return { sessions, projects, usage, actors, todos, tools };
  } finally {
    db?.close();
  }
}

function parseMessageRow(r) {
  const data = jsonCol(r.data, null);
  if (!data) return null;
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  // empty-token assistant rows (no-op turns) still count as a request
  const u = usageFromTokens(tokens);
  return {
    messageId: r.id,
    sessionId: r.session_id,
    agentId: r.agent_id || "main",
    at: r.time_updated || r.time_created || null,
    model: data.modelID ?? data.model ?? null,
    provider: data.providerID ?? data.provider ?? null,
    cost: data.cost != null ? Number(data.cost) || 0 : null,
    finish: data.finish ?? null,
    ...u,
  };
}

function assemble({ sessions, projects, usage, actors, todos, tools, now }) {
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const nodes = new Map();

  const ensureNode = (id, base = {}) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        title: null,
        parentId: null,
        project: null,
        directory: null,
        role: null,
        model: null,
        thinking: null,
        status: "idle",
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreate: 0,
        reasoningTokens: 0,
        maxContext: 0,
        firstAt: null,
        lastAt: null,
        sparkline: [],
        lastError: null,
        todos: [],
        lastTool: null,
        children: [],
        ...base,
      });
    }
    return nodes.get(id);
  };

  // ---- session shells ----
  for (const s of sessions) {
    const dir = s.directory || null;
    const project =
      projectFromDir(dir) ||
      projectById.get(s.project_id)?.name ||
      (s.project_id && s.project_id !== "global" ? s.project_id : null);
    ensureNode(s.id, {
      title: s.title || null,
      parentId: s.parent_id || null,
      project,
      directory: dir,
      firstAt: s.time_created ?? null,
      lastAt: s.time_updated ?? s.time_created ?? null,
    });
  }

  // ---- usage per (session, agent) ----
  const sparkByKey = new Map(); // "sess/agent" -> prompt[]
  const parsed = [];
  for (const r of usage) {
    const m = parseMessageRow(r);
    if (!m) continue;
    parsed.push(m);
    const key = `${m.sessionId}\u0000${m.agentId}`;
    if (!sparkByKey.has(key)) sparkByKey.set(key, []);
    sparkByKey.get(key).push(m.prompt);

    const isMain = !m.agentId || m.agentId === "main";
    const nodeId = isMain ? m.sessionId : `${m.sessionId}/${m.agentId}`;
    const s = ensureNode(nodeId, {
      parentId: isMain ? nodes.get(m.sessionId)?.parentId ?? null : m.sessionId,
      title: isMain ? nodes.get(m.sessionId)?.title ?? null : null,
      project: nodes.get(m.sessionId)?.project ?? null,
      directory: nodes.get(m.sessionId)?.directory ?? null,
      role: isMain ? "main" : m.agentId,
    });
    s.requests += 1;
    s.inputTokens += m.inputTokens;
    s.outputTokens += m.outputTokens;
    s.cacheRead += m.cacheRead;
    s.cacheCreate += m.cacheCreate;
    s.reasoningTokens += m.reasoningTokens;
    s.maxContext = Math.max(s.maxContext, m.prompt);
    if (m.at != null) {
      if (s.firstAt == null || m.at < s.firstAt) s.firstAt = m.at;
      if (s.lastAt == null || m.at > s.lastAt) s.lastAt = m.at;
    }
    if (m.model) s.model = m.model;
    if (m.provider) s.provider = m.provider;
    // a failed finish marks the session; a later success clears it
    const failed = m.finish && !["stop", "tool-calls", "length", "content_filter"].includes(String(m.finish));
    if (failed) s.lastError = { type: String(m.finish), message: `finish=${m.finish}`, at: m.at };
    else if (m.at != null && (!s.lastError || m.at > (s.lastError.at ?? 0))) s.lastError = null;
    if (m.cost != null) s.costUsd = (s.costUsd ?? 0) + m.cost;
    if (m.reasoningTokens > 0) s.thinking = s.thinking ?? "reasoning";
  }

  for (const [key, series] of sparkByKey) {
    const nodeId = key.includes("\u0000main")
      ? key.split("\u0000")[0]
      : `${key.split("\u0000")[0]}/${key.split("\u0000")[1]}`;
    const s = nodes.get(nodeId);
    if (s) s.sparkline = series.slice(-SPARK_TAIL);
  }

  // ---- actors (subagents inside a session) ----
  const actorById = new Map();
  for (const a of actors) {
    actorById.set(`${a.session_id}\u0000${a.actor_id}`, a);
    const isMain = !a.actor_id || a.actor_id === "main" || a.mode === "main";
    const nodeId = isMain ? a.session_id : `${a.session_id}/${a.actor_id}`;
    const parentActor = a.parent_actor_id && a.parent_actor_id !== "main"
      ? `${a.session_id}/${a.parent_actor_id}`
      : a.session_id;
    const s = ensureNode(nodeId, {
      parentId: isMain ? nodes.get(a.session_id)?.parentId ?? null : parentActor,
      role: isMain ? "main" : (a.agent || a.description || a.actor_id),
      description: a.description || null,
      project: nodes.get(a.session_id)?.project ?? null,
      directory: nodes.get(a.session_id)?.directory ?? null,
    });
    if (a.time_created != null) {
      if (s.firstAt == null || a.time_created < s.firstAt) s.firstAt = a.time_created;
    }
    const act = a.last_activity_time ?? a.last_turn_time ?? a.time_completed;
    if (act != null && (s.lastAt == null || act > s.lastAt)) s.lastAt = act;
    if (a.time_completed != null && (s.lastAt == null || a.time_completed > s.lastAt)) s.lastAt = a.time_completed;
    if (a.description && !s.description) s.description = a.description;
    if (a.last_error) {
      s.lastError = { type: "actor_error", message: String(a.last_error).slice(0, 200), at: a.last_turn_time ?? null };
    }
    s.actorStatus = a.status ?? null;
  }

  // tree edges from parent links
  for (const s of nodes.values()) {
    if (s.parentId && nodes.has(s.parentId)) {
      const p = nodes.get(s.parentId);
      if (!p.children.includes(s.id)) p.children.push(s.id);
    }
  }

  // ---- todos ----
  for (const t of todos) {
    const s = nodes.get(t.session_id);
    if (!s) continue;
    s.todos.push({
      content: t.content,
      status: t.status === "completed" ? "done" : t.status,
    });
  }

  // ---- tool ticker / lastTool ----
  const ticker = [];
  const lastToolBy = new Map();
  for (const t of tools) {
    const data = jsonCol(t.data, null);
    if (!data || data.type !== "tool") continue;
    const st = data.state ?? {};
    const status = st.status ?? "completed";
    const outputBytes = typeof st.output === "string" ? Buffer.byteLength(st.output) : 0;
    const at = st.time?.end ?? st.time?.start ?? t.time_created;
    const sessionId = t.session_id;
    // tool parts live on the session; attribute to main unless the parent
    // message's agent is known — parts only carry session_id, so main it is
    // when the actor isn't visible from the part alone
    const entry = {
      sessionId,
      tool: data.tool ?? "tool",
      status: status === "completed" ? "ok" : status === "error" ? "error" : status,
      outputBytes,
      exitCode: st.metadata?.exitCode ?? st.exitCode ?? null,
      at,
    };
    ticker.push(entry);
    if (!lastToolBy.has(sessionId)) lastToolBy.set(sessionId, entry);
  }
  for (const [sid, t] of lastToolBy) {
    const s = nodes.get(sid);
    if (s) s.lastTool = { name: t.tool, outputBytes: t.outputBytes, status: t.status, at: t.at, exitCode: t.exitCode };
  }

  // ---- status ----
  for (const s of nodes.values()) {
    const last = s.lastAt ?? 0;
    const awake = last > 0 && now - last <= ACTIVE_MS;
    if (s.lastError) s.status = "failed";
    else if (s.actorStatus === "completed" || s.actorStatus === "done") s.status = "done";
    else if (s.actorStatus === "running" || awake) s.status = "running";
    else if (last) s.status = "sleep";
    else s.status = "idle";
    // context cliff fallback when the harness records no window
    if (!s.contextWindow) {
      s.contextWindow = modelWindow(s.model) || undefined;
    }
  }

  // window keep + ancestors
  const keep = keepInWindow([...nodes.values()], now - WINDOW_MS);
  const kept = [...nodes.values()]
    .filter((s) => keep.has(s.id))
    .map((s) => ({ ...s, children: s.children.filter((c) => keep.has(c)) }));
  const byId = new Map(kept.map((n) => [n.id, n]));
  const roots = kept.filter((n) => !n.parentId || !byId.has(n.parentId)).map((n) => n.id);

  return {
    generatedAt: now,
    windowHours: cfg.windowHours,
    sessions: kept,
    roots,
    ticker: ticker.filter((t) => keep.has(t.sessionId)).slice(0, 15),
    warnings: [],
  };
}

export function snapshot({ now = Date.now() } = {}) {
  const gathered = gatherDb();
  if (!gathered) {
    return {
      generatedAt: now,
      windowHours: cfg.windowHours,
      sessions: [],
      roots: [],
      ticker: [],
      warnings: [],
    };
  }
  return assemble({ ...gathered, now });
}
