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
      <span style="margin-left:auto">${ago(s.lastAt)}</span>
    </div>
    <canvas class="spark" id="${sparkId}"></canvas>
    <div class="cap">input tokens / request — dashed line = ${fmt(CTX_LIMIT)} context cliff</div>
    ${s.description ? `<div class="desc" title="${esc(s.description)}">${esc(s.description)}</div>` : ""}
    ${todoHtml ? `<ul class="todos">${todoHtml}</ul>` : ""}
    ${s.lastError ? `<div class="err">⚠ ${esc(s.lastError.type)}: ${esc(s.lastError.message ?? "")}</div>` : ""}
  </div>`;
}

function render(state) {
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  $("empty").style.display = state.sessions.length ? "none" : "block";

  // totals
  $("totals").innerHTML =
    `Σ in <b>${fmt(state.totals.inputTokens)}</b> · out <b>${fmt(state.totals.outputTokens)}</b> · ` +
    `requests <b>${fmt(state.totals.requests)}</b> · agents <b>${state.sessions.length}</b> · window ${state.windowHours}h`;

  // rate-limit / failure banner
  const failed = state.sessions.filter((s) => s.status === "failed");
  $("alert").classList.toggle("show", failed.length > 0);
  if (failed.length)
    $("alert").textContent = "⚠ " + failed.map((s) => `${s.role ?? s.id.slice(0, 12)}: ${s.lastError?.type ?? "failed"}`).join(" · ");

  // tree — one card per session, roots first then children inline
  const seen = new Set();
  const sections = [];
  for (const rid of state.roots) {
    const root = byId.get(rid);
    if (!root) continue;
    seen.add(rid);
    const kids = (root.children ?? []).map((c) => byId.get(c)).filter(Boolean);
    kids.forEach((k) => seen.add(k.id));
    sections.push(`
      <div class="root">
        <div class="head">
          <span class="status ${esc(root.status)}"></span>
          <span>🧑‍✈️</span>
          <span class="title">${esc(root.title ?? "main session")}</span>
          <span class="meta">${fmt(root.inputTokens)} in · ${root.requests} reqs · ${ago(root.lastAt)}</span>
        </div>
        <div class="kids">${kids.map(agentCard).join("") || `<div class="desc" style="padding:6px 4px">no dispatched subagents</div>`}</div>
      </div>`);
  }
  const orphans = state.sessions.filter((s) => !seen.has(s.id));
  if (orphans.length)
    sections.push(`<div class="root"><div class="head"><span class="title">other sessions</span></div><div class="kids">${orphans.map(agentCard).join("")}</div></div>`);
  $("tree").innerHTML = sections.join("");

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
    return `<li class="${isNew ? "new" : ""}"><span>${ago(t.at)}</span><span class="t">${esc(agent?.role ?? "session")}</span><span>${esc(t.tool)}</span><span>${t.status ?? ""} ${t.outputBytes != null ? "· " + fmt(t.outputBytes) + "B" : ""}</span></li>`;
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
