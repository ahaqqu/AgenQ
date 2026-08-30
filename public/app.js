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
  const todoHtml = (s.todos ?? []).slice(0, 8).map((t) =>
    `<li class="${esc(t.status)}">${t.status === "done" ? "☑" : t.status === "in_progress" ? "▸" : "☐"} ${esc(t.content)}</li>`
  ).join("");
  return `
  <div class="kid" id="kid-${s.id}">
    <div class="row">
      <span class="status ${esc(s.status)}"></span>
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
    ${s.lastError ? `<div class="err">⚠ ${esc(s.lastError.type)}: ${esc(s.lastError.message ?? "")}</div>` : ""}
  </div>`;
}

const byLast = (a, b) => (b.lastAt ?? b.firstAt ?? 0) - (a.lastAt ?? a.firstAt ?? 0);

// exactly the name the card below carries: role for subagents, project + title for mains
function sessionLabel(s) {
  if (s.role) return s.role;
  const name = s.title ? (s.project ? s.project + " · " + s.title : s.title) : s.id.slice(0, 12);
  return s.project && !s.title ? s.project + " · " + s.id.slice(0, 12) : name;
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

// failure banner → jump to the card below and flash it
$("alert").addEventListener("click", (e) => {
  const entry = e.target.closest(".entry");
  if (!entry) return;
  flashId = entry.dataset.target;
  flashUntil = Date.now() + 1800;
  const el = document.getElementById("root-" + flashId)
    ?? document.getElementById("kid-" + flashId);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
});

$("filter").addEventListener("change", () => {
  filterProject = $("filter").value;
  poll();
});

function render(state) {
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

  // rate-limit / failure banner — same names as the cards, click to jump.
  // Only rewrite on change: constant innerHTML swaps eat clicks mid-flight.
  const failed = state.sessions.filter((s) => s.status === "failed");
  $("alert").classList.toggle("show", failed.length > 0);
  const alertHtml = failed.length
    ? "⚠ " + failed.map((s) =>
        `<span class="entry" data-target="${esc(s.id)}">${esc(sessionLabel(s))} · ${esc(s.lastError?.type ?? "failed")}</span>`,
      ).join(" · ")
    : "";
  if ($("alert").innerHTML !== alertHtml) $("alert").innerHTML = alertHtml;

  // active-now strip — only sessions with a heartbeat in the last 5m
  const actives = state.sessions.filter((s) => s.status === "running" && matches(s)).sort(byLast);
  $("activewrap").style.display = actives.length ? "block" : "none";
  $("activebar").innerHTML = actives.map((s) => {
    const emoji = s.role ? (ROLE_EMOJI[s.role] ?? "🤖") : "🧑‍✈️";
    const doing = currentActivity(s);
    return `<div class="chip"><span class="status running"></span><span>${emoji}</span>` +
      `<span class="t">${esc(s.role ?? s.title ?? "session")}</span>` +
      `<span class="d" title="${esc(doing)}">${esc(doing)}</span>` +
      `<span class="ago">${ago(s.lastAt)}</span></div>`;
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
          <span class="status ${esc(root.status)}"></span>
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
    return `<li class="${isNew ? "new" : ""}"><span>${ago(t.at)}</span><span class="t">${esc(agent ? sessionLabel(agent) : "session")}</span><span>${esc(t.tool)}</span><span>${t.status ?? ""} ${t.outputBytes != null ? "· " + fmt(t.outputBytes) + "B" : ""}</span></li>`;
  }).join("");

  prev = state;
}

async function poll() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    render(state);
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
