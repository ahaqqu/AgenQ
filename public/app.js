// AgenQ front end — polls /api/state, diffs snapshots, renders the board.
// Dependency-free on purpose; the fun layer is yours to restyle.
const ROLE_EMOJI = {
  "manager": "🧑‍✈️",
  "senior-implementer": "🧠",
  "implementer": "⚡",
  "test-implementer": "🧪",
  "reviewer": "🔍",
  "thermo-nuclear-review-subagent": "🔥",
  "thermo-nuclear-code-quality-review-subagent": "🧹",
  "assistant-manager": "🔎",
};
const CTX_LIMIT = 200_000; // the cliff from the #94 analysis

const $ = (id) => document.getElementById(id);
let prev = null;

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return Math.round(s) + "s ago";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
}
function agoLong(ts) {
  if (!ts) return "—";
  const m = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " minute" + (m === 1 ? "" : "s") + " ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " hour" + (h === 1 ? "" : "s") + " ago";
  const d = Math.floor(h / 24);
  return d + " day" + (d === 1 ? "" : "s") + " ago";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function drawSpark(canvas, series) {
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 44;
  canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  if (!series || series.length < 2) return;
  const max = Math.max(...series, 1);
  const step = w / (series.length - 1);
  // area
  ctx.beginPath();
  ctx.moveTo(0, h);
  series.forEach((v, i) => ctx.lineTo(i * step, h - (v / max) * (h - 4) - 2));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(110,168,254,.15)";
  ctx.fill();
  // line, turning red past the context cliff
  const scaled = series.map((v) => h - (v / max) * (h - 4) - 2);
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = i * step, y = scaled[i];
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = max > CTX_LIMIT ? "#e5534b" : "#6ea8fe";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // cliff marker if visible
  if (max > CTX_LIMIT) {
    const y = h - (CTX_LIMIT / max) * (h - 4) - 2;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(229,83,75,.5)";
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function agentCard(s) {
  const emoji = ROLE_EMOJI[s.role] ?? "🤖";
  const name = s.role ?? (s.title ? "main" : "session");
  const over = s.maxContext > CTX_LIMIT;
  const sparkId = "spark-" + s.id;
  // a dead run's failure keeps its red dot but stops pulsing
  const dot = s.status === "failed" && s.live === false ? "exited" : s.status;
  const todoHtml = (s.todos ?? []).slice(0, 8).map((t) =>
    `<li class="${esc(t.status)}">${t.status === "done" ? "☑" : t.status === "in_progress" ? "▸" : "☐"} ${esc(t.content)}</li>`
  ).join("");
  return `
  <div class="kid" id="kid-${s.id}">
    <div class="row">
      <span class="status ${esc(dot)}" title="${esc(s.status)}${s.live === false ? " · process exited" : ""}"></span>
      <span>${emoji}</span>
      <span class="name">${esc(name)}</span>
      <span class="model">${esc(s.model ?? "")}</span>
    </div>
    <div class="nums">
      <span>in <b>${fmt(s.inputTokens)}</b></span>
      <span>out <b>${fmt(s.outputTokens)}</b></span>
      <span>reqs <b>${s.requests}</b></span>
      <span>ctx max <b class="${over ? "over" : ""}">${fmt(s.maxContext)}</b></span>
      <span style="margin-left:auto">${s.status === "sleep" ? "💤 " : ""}${ago(s.lastAt)}</span>
    </div>
    <canvas class="spark" id="${sparkId}"></canvas>
    <div class="cap">input tokens / request — dashed line = ${fmt(CTX_LIMIT)} context cliff</div>
    ${s.description ? `<div class="desc" title="${esc(s.description)}">${esc(s.description)}</div>` : ""}
    ${todoHtml ? `<ul class="todos">${todoHtml}</ul>` : ""}
    ${s.lastError ? `<div class="err">⚠ ${esc(s.lastError.type)}: ${esc(s.lastError.message ?? "")}${s.live === false ? " · run exited" : ""}</div>` : ""}
    ${s.lastError && s.directory && stoppedDirs.has(s.directory) ? `<div class="stoppedmark">⏹ stopped by you — project run killed</div>` : ""}
  </div>`;
}

const byLast = (a, b) => (b.lastAt ?? b.firstAt ?? 0) - (a.lastAt ?? a.firstAt ?? 0);

// exactly the name the card below carries: role for subagents, project + title for mains
function sessionLabel(s) {
  if (s.role) return s.role;
  const name = s.title ? (s.project ? s.project + " · " + s.title : s.title) : s.id.slice(0, 12);
  return s.project && !s.title ? s.project + " · " + s.id.slice(0, 12) : name;
}

// same, with the project in blue like the panel titles
function labelHtml(s) {
  const name = s.role ?? s.title ?? s.id.slice(0, 12);
  return s.project
    ? `<span class="proj">${esc(s.project)}</span> · ${esc(name)}`
    : esc(name);
}

function currentActivity(s) {
  const todo = (s.todos ?? []).find((t) => t.status === "in_progress");
  if (todo) return todo.content;
  if (s.lastTool) return s.lastTool.name;
  return "…";
}

let filterProject = "all";
let flashId = null; // banner click → highlight this card until flashUntil
let flashUntil = 0;
const stoppedDirs = new Set(); // projects the user stopped this page-load

// ----- expandable ACTIVE NOW rows (lazy per-session detail) -----
let expandedId = null;
const detailCache = new Map(); // id -> { data?, error?, fetchedAt }
let detailInflight = false;

async function fetchDetail(id, force = false) {
  const c = detailCache.get(id);
  if (!force && c && Date.now() - c.fetchedAt < 4000) return;
  if (detailInflight) return;
  detailInflight = true;
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(id)}/detail`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    detailCache.set(id, { data: await res.json(), fetchedAt: Date.now() });
  } catch (e) {
    detailCache.set(id, { error: e.message, fetchedAt: Date.now() });
  } finally {
    detailInflight = false;
  }
  renderDetail(id);
}

function renderDetail(id) {
  const el = document.getElementById("detail-" + id);
  if (!el) return;
  const sel = document.getSelection();
  if (sel && !sel.isCollapsed) return; // same copy-protection as render()
  el.innerHTML = detailHtml(detailCache.get(id));
}

function detailHtml(entry) {  if (!entry || (!entry.data && !entry.error)) return `<div class="dload">loading…</div>`;
  if (entry.error) return `<div class="dload errtxt">detail unavailable — ${esc(entry.error)}</div>`;
  const d = entry.data;
  const out = [];

  // what it is doing right now, with the actual arguments
  if (d.currentTool) {
    out.push(`<div class="dsec"><span class="dlab">now</span><span class="dval">` +
      `<b>${esc(d.currentTool.name ?? "?")}</b> <span class="dim">(${esc(d.currentTool.status ?? "?")})</span>` +
      (d.currentTool.input ? `<pre>${esc(d.currentTool.input)}</pre>` : "") + `</span></div>`);
  } else {
    out.push(`<div class="dsec"><span class="dlab">now</span><span class="dval dim">no tool call in flight</span></div>`);
  }

  if (d.thinking?.text)
    out.push(`<div class="dsec"><span class="dlab">thinking</span><span class="dval"><pre class="think">${esc(d.thinking.text)}</pre></span></div>`);

  const td = d.todos ?? [];
  if (td.length) {
    const done = td.filter((t) => t.status === "done").length;
    const now = td.filter((t) => t.status === "in_progress").map((t) => t.content);
    out.push(`<div class="dsec"><span class="dlab">todo</span><span class="dval">${done}/${td.length} done` +
      (now.length ? ` · now: ${esc(now.join(" | "))}` : "") + `</span></div>`);
  }

  if (d.diff && (d.diff.additions != null || d.diff.files != null))
    out.push(`<div class="dsec"><span class="dlab">diff</span><span class="dval">` +
      `<span class="add">+${fmt(d.diff.additions ?? 0)}</span> <span class="del">−${fmt(d.diff.deletions ?? 0)}</span>` +
      ` · ${d.diff.files ?? "?"} files</span></div>`);

  const tk = d.tokens ?? {};
  const win = d.modelWindow || 200_000;
  const fill = tk.maxContext ? Math.round((tk.maxContext / win) * 100) : 0;
  out.push(`<div class="dsec"><span class="dlab">context</span><span class="dval">` +
    `<span class="bar"><span class="fill ${fill >= 90 ? "hot" : ""}" style="width:${Math.min(fill, 100)}%"></span></span>` +
    `${fmt(tk.maxContext ?? 0)} / ${fmt(win)} (${fill}%)</span></div>`);

  out.push(`<div class="dsec"><span class="dlab">tokens</span><span class="dval">` +
    `<div class="trow">in ${fmt(tk.input ?? 0)} <span class="dim">(cache-read ${fmt(tk.cacheRead ?? 0)}, cache-write ${fmt(tk.cacheCreate ?? 0)})</span>` +
    ` · out ${fmt(tk.output ?? 0)} <span class="dim">(reasoning ${fmt(tk.reasoning ?? 0)})</span> · ${tk.requests ?? 0} reqs</div>` +
    (d.turns?.[0] ? `<div class="trow dim">latest turn: in ${fmt(d.turns[0].input_tokens)} / out ${fmt(d.turns[0].output_tokens)} / reasoning ${fmt(d.turns[0].reasoning_tokens)}</div>` : "") +
    `</span></div>`);

  if (d.errors?.length)
    out.push(`<div class="dsec"><span class="dlab">errors</span><span class="dval">` +
      d.errors.map((e) => `<div class="trow del">✗ ${esc(e.type)}: ${esc(e.message ?? "")} <span class="dim">${ago(e.at)}</span></div>`).join("") +
      `</span></div>`);

  return out.join("");
}

// stop is a project action: every zcode-cli process in that directory is
// the same run, and all of them die together
async function stopProject(directory, project, procCount) {
  const ok = confirm(
    `Kill ${procCount} live zcode-cli process${procCount === 1 ? "" : "es"} in "${project}"?\n\n` +
    `This stops the whole project run — every session in\n${directory}\n` +
    `dies with it, not just the failed one.`,
  );
  if (!ok) return;
  try {
    const res = await fetch("/api/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory }),
    });
    const out = await res.json();
    if (out.killed?.length) {
      stoppedDirs.add(directory);
      toast(`stopped ${out.project}: SIGTERM → pid ${out.killed.join(", ")}`);
      poll();
    } else {
      toast("could not stop: " + (out.error ?? res.status), true);
    }
  } catch (e) {
    toast("could not stop: " + e.message, true);
  }
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 5000);
}

function onStopClick(e) {
  const btn = e.target.closest(".stopbtn");
  if (!btn) return false;
  stopProject(btn.dataset.dir, btn.dataset.name, Number(btn.dataset.procs));
  return true;
}

// click a failed task or a ticker row → jump to the card below and flash it
function jumpToCard(id) {
  if (!id) return;
  flashId = id;
  flashUntil = Date.now() + 1800;
  const el = document.getElementById("root-" + id)
    ?? document.getElementById("kid-" + id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

$("alert").addEventListener("click", (e) => {
  if (onStopClick(e)) return;
  const entry = e.target.closest(".entry");
  if (!entry) return;
  jumpToCard(entry.dataset.target);
});

$("ticker").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-target]");
  if (li) jumpToCard(li.dataset.target);
});

$("filter").addEventListener("change", () => {
  filterProject = $("filter").value;
  poll();
});

// legend — built from the same constants the board uses, so it can't drift
$("legendbtn").addEventListener("click", () => $("legend").classList.toggle("show"));

// collapsible ACTIVE NOW panel
$("activetoggle").addEventListener("click", () => {
  const w = $("activewrap");
  w.classList.toggle("collapsed");
  w.querySelector(".caret").textContent = w.classList.contains("collapsed") ? "▸" : "▾";
});
// click a chip → expand its detail panel (fetched lazily, refreshed while open)
$("activebar").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const id = chip.dataset.session;
  expandedId = expandedId === id ? null : id;
  if (expandedId) fetchDetail(expandedId, true);
  poll();
});
$("legend").innerHTML = `
  <div class="lgroup">
    <div class="lhead">STATUS DOTS</div>
    <div class="lrow"><span class="status running"></span> green pulse — running: model requests in the last 5m, CLI process alive</div>
    <div class="lrow"><span class="status sleep"></span> blue — sleep: process alive but idle 5m+ (card time shows 💤)</div>
    <div class="lrow"><span class="status done"></span> gray — done: finished, nothing running anymore</div>
    <div class="lrow"><span class="status failed"></span> red — failed: the most recent request errored; hollow dot means the process already exited</div>
    <div class="lrow"><span class="status exited"></span> hollow — exited: no live CLI process for this project anymore; the run is over</div>
  </div>
  <div class="lgroup">
    <div class="lhead">ICONS</div>
    <div class="lrow"><span class="ic">🧑‍✈️</span> main session (the manager you talked to)</div>
    ${Object.entries(ROLE_EMOJI).map(([r, e]) => `<div class="lrow"><span class="ic">${e}</span> ${esc(r)}</div>`).join("")}
    <div class="lrow"><span class="ic">🤖</span> other subagent role</div>
    <div class="lrow"><span class="ic">💤</span> idle 5m+ but process still alive</div>
    <div class="lrow"><span class="ic">⚠</span> last error of that agent</div>
    <div class="lrow"><span class="ic">⏹</span> kill process — SIGTERMs every CLI process of that project (the whole project run stops)</div>
  </div>`;

function render(state) {
  // copying something? defer the re-render until the selection is gone —
  // swapping innerHTML on a 1.5s timer yanks text out from under the cursor
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) return;
  const byId = new Map(state.sessions.map((s) => [s.id, s]));

  // project filter dropdown
  const projects = [...new Set(state.sessions.map((s) => s.project).filter(Boolean))].sort();
  const sel = $("filter");
  const selected = [...sel.options].some((o) => o.value === filterProject) ? filterProject : "all";
  sel.innerHTML = `<option value="all">all projects</option>` +
    projects.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  sel.value = selected;
  filterProject = sel.value;
  const matches = (s) => filterProject === "all" || s.project === filterProject;
  $("empty").style.display = state.sessions.some(matches) ? "none" : "block";

  // totals
  $("totals").innerHTML =
    `Σ in <b>${fmt(state.totals.inputTokens)}</b> · out <b>${fmt(state.totals.outputTokens)}</b> · ` +
    `requests <b>${fmt(state.totals.requests)}</b> · agents <b>${state.sessions.length}</b> · window ${state.windowHours}h`;

  // failures grouped by project directory (stop granularity), newest group
  // and entry first; live runs blink and offer the project-level stop.
  // Only rewrite on change: constant innerHTML swaps eat clicks mid-flight.
  const failed = state.sessions.filter((s) => s.status === "failed");
  const groups = new Map(); // directory -> sessions[]
  for (const s of [...failed].sort((a, b) => (b.live === true) - (a.live === true) || byLast(a, b))) {
    const key = s.directory ?? "?";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => (b[1][0].live === true) - (a[1][0].live === true) || (b[1][0].lastAt ?? 0) - (a[1][0].lastAt ?? 0),
  );
  $("alert").classList.toggle("show", failed.length > 0);
  $("alert").classList.toggle("livefail", failed.some((s) => s.live));
  const alertHtml =
    `<div class="ah">FAILED</div>` +
    ordered.map(([dir, list]) => {
      const procs = state.liveProcs?.[dir] ?? 0;
      const proj = list[0].project ?? "unknown project";
      const stoppable = dir !== "?" && procs > 0 && !stoppedDirs.has(dir);
      return `
      <div class="agroup">
        <div class="agroup-head">
          <span>${esc(proj)}</span>
          ${stoppable ? `<button class="stopbtn" data-dir="${esc(dir)}" data-name="${esc(proj)}" data-procs="${procs}" title="SIGTERM all ${procs} zcode-cli process(es) in ${esc(dir)}">⏹ kill process</button>`
            : stoppedDirs.has(dir) ? `<span class="stoppedmark">⏹ stopped by you</span>` : ""}
        </div>
        ${list.map((s) => `
          <div class="aentry ${s.live ? "" : "exited"}">
            <span class="entry" data-target="${esc(s.id)}">${labelHtml(s)}</span>
            <span class="etype">${esc(s.lastError?.type ?? "failed")}</span>
            <span class="ewhen">${agoLong(s.lastAt)}</span>
            ${stoppedDirs.has(dir) ? `<span class="exitedchip">stopped</span>` : s.live ? `<span class="livechip">process alive</span>` : `<span class="exitedchip">run exited</span>`}
          </div>`).join("")}
      </div>`;
    }).join("");
  if ($("alert").innerHTML !== alertHtml) $("alert").innerHTML = alertHtml;

  // active-now strip — only sessions with a heartbeat in the last 5m
  const actives = state.sessions.filter((s) => s.status === "running" && matches(s) && !stoppedDirs.has(s.directory)).sort(byLast);
  $("activewrap").style.display = actives.length ? "block" : "none";
  $("activebar").innerHTML = actives.map((s) => {
    const emoji = s.role ? (ROLE_EMOJI[s.role] ?? "🤖") : "🧑‍✈️";
    const doing = currentActivity(s);
    const open = expandedId === s.id;
    return `<div class="chip ${open ? "open" : ""}" data-session="${esc(s.id)}"><span class="exp">${open ? "▾" : "▸"}</span><span class="status running"></span><span>${emoji}</span>` +
      `<span class="t" title="${esc(s.title ?? s.role ?? "")}">${labelHtml(s)}</span>` +
      `<span class="d" title="${esc(doing)}">${esc(doing)}</span>` +
      `<span class="stats">in <b>${fmt(s.inputTokens)}</b> · out <b>${fmt(s.outputTokens)}</b> · ${s.requests} reqs · ` +
      `ctx <b class="${s.maxContext > CTX_LIMIT ? "over" : ""}" title="max single-request input — dashed cliff is ${fmt(CTX_LIMIT)}">${fmt(s.maxContext)}</b></span>` +
      `<span class="ago">${ago(s.lastAt)}</span></div>` +
      (open ? `<div class="chipdetail" id="detail-${esc(s.id)}">${detailHtml(detailCache.get(s.id))}</div>` : "");
  }).join("");

  // tree — newest roots first, children newest first
  const seen = new Set();
  const sections = [];
  const rootNodes = state.roots.map((rid) => byId.get(rid)).filter(Boolean).sort(byLast);
  for (const root of rootNodes) {
    if (!root) continue;
    if (!matches(root)) continue;
    seen.add(root.id);
    const kids = (root.children ?? []).map((c) => byId.get(c)).filter(Boolean).sort(byLast);
    kids.forEach((k) => seen.add(k.id));
    sections.push(`
      <div class="root" id="root-${esc(root.id)}">
        <div class="head">
          <span class="status ${esc(root.status === "failed" && root.live === false ? "exited" : root.status)}" title="${esc(root.status)}${root.live === false ? " · process exited" : ""}"></span>
          <span>🧑‍✈️</span>
          ${root.project ? `<span class="proj">${esc(root.project)}</span>` : ""}
          <span class="title">${esc(root.title ?? "main session")}</span>
          <span class="meta">${fmt(root.inputTokens)} in · ${root.requests} reqs · ${root.status === "sleep" ? "💤 " : ""}${ago(root.lastAt)}</span>
        </div>
        <div class="kids">${kids.map(agentCard).join("") || `<div class="desc" style="padding:6px 4px">no dispatched subagents</div>`}</div>
      </div>`);
  }
  const orphans = state.sessions.filter((s) => !seen.has(s.id) && matches(s)).sort(byLast);
  if (orphans.length)
    sections.push(`<div class="root"><div class="head"><span class="title">other sessions</span></div><div class="kids">${orphans.map(agentCard).join("")}</div></div>`);
  $("tree").innerHTML = sections.join("");

  // re-apply the banner-jump highlight; re-renders would otherwise wipe it
  if (flashId && Date.now() < flashUntil) {
    document.getElementById("root-" + flashId)?.classList.add("flash");
    document.getElementById("kid-" + flashId)?.classList.add("flash");
  } else if (flashId) {
    flashId = null;
  }

  for (const s of state.sessions) {
    const c = document.getElementById("spark-" + s.id);
    if (c) drawSpark(c, s.sparkline);
  }

  // ticker with flash-on-new
  const prevTicker = prev?.ticker ?? [];
  const known = new Set(prevTicker.map((t) => t.at + t.tool));
  $("ticker").innerHTML = state.ticker.map((t) => {
    const isNew = !known.has(t.at + t.tool) && prevTicker.length > 0;
    const agent = byId.get(t.sessionId);
    return `<li class="${isNew ? "new" : ""}" data-target="${esc(t.sessionId)}" title="click to jump to the session card"><span>${ago(t.at)}</span><span class="t">${agent ? labelHtml(agent) : "session"}</span><span>${esc(t.tool)}</span><span>${t.status ?? ""} ${t.outputBytes != null ? "· " + fmt(t.outputBytes) + "B" : ""}</span></li>`;
  }).join("");

  prev = state;
}

async function poll() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    render(state);
    // keep the open detail panel fresh (fetchDetail throttles to 4s)
    if (expandedId) fetchDetail(expandedId);
    $("poll").classList.remove("stale");
    $("poll-text").textContent = "live · " + new Date(state.generatedAt).toLocaleTimeString();
    if (state.pollError) $("errbar").textContent = "poll warning: " + state.pollError;
    else $("errbar").textContent = "";
  } catch (e) {
    $("poll").classList.add("stale");
    $("poll-text").textContent = "stale — " + e.message;
  }
}
poll();
setInterval(poll, 1500);
