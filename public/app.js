// AgenQ front end — polls /api/state, diffs snapshots, renders the board.
// Dependency-free on purpose; visuals.js and detail.js carry the sparkline
// renderer and the lazy detail panel. The fun layer is yours to restyle.

const byLast = (a, b) => (b.lastAt ?? b.firstAt ?? 0) - (a.lastAt ?? a.firstAt ?? 0);

// tight rows (Active Now chips, ticker, alert) have no room for long names:
// projects become acronyms (agentic-project-template → APT, worktree suffix
// kept: -wt95). The role emoji carries the role; tree cards keep the full
// names and tooltips always carry the full text.
const shortProject = (p) => {
  if (!p || p.length <= 10) return p ?? "";
  const parts = p.split(/[-_.]/).filter(Boolean);
  return parts.map((s) => (/\d/.test(s) ? "-" + s : s[0].toUpperCase())).join("");
};

// same-role siblings under one parent get instance numbers (1/3, 2/3 …) in
// dispatch order — recomputed from each snapshot so it can't go stale
let instOf = new Map(); // session id -> { i, n }
function computeInstances(sessions) {
  instOf = new Map();
  const groups = new Map(); // parent|role -> sessions[]
  for (const s of sessions) {
    if (!s.role) continue;
    const k = (s.parentSessionId ?? "?") + "|" + s.role;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0));
    list.forEach((s, i) => instOf.set(s.id, { i: i + 1, n: list.length }));
  }
}

// everything that identifies an agent, untruncated — for tooltips
function fullLabel(s) {
  const proj = s.project ? s.project + " · " : "";
  if (s.role) {
    const tag = instOf.get(s.id);
    return proj + s.role + (tag ? ` (${tag.i} of ${tag.n})` : "") +
      (s.description ? ` — ${s.description}` : "");
  }
  return proj + (s.title ?? s.id.slice(0, 12));
}

// instance fraction for the right-hand side ("2/5"); empty for main sessions
const instTag = (s) => {
  const t = instOf.get(s.id);
  return t ? `${t.i}/${t.n}` : "";
};
// prefix right-side text with it: "2/5 · Agent failed"
const tagged = (text, s) => {
  const tag = instTag(s);
  return tag ? `${tag} · ${text}` : text;
};

// compact label for the tight rows: left side is only who+brief — project
// (short) and task description; the instance fraction lives on the right
// of the dash. Full role name stays in the tooltip (fullLabel).
function labelHtml(s) {
  const proj = s.project
    ? `<span class="proj" title="${esc(s.project)}">${esc(shortProject(s.project))}</span>`
    : "";
  if (s.role) {
    return s.description ? (proj ? proj + " · " : "") + esc(s.description) : proj;
  }
  const tail = esc(s.title ?? s.id.slice(0, 12));
  return proj ? proj + " · " + tail : tail;
}

// mcp__server__tool → mcp:server:tool — same meaning, less ticker noise
const prettyTool = (t) => String(t ?? "").replace(/^mcp__/, "mcp:").replace(/__/g, ":");

const roleIcon = (s) => (s.role ? (ROLE_EMOJI[s.role] ?? "🤖") : "🧑‍✈️");
// threshold colors shared by the chip right side and the card headers:
// green = comfortable, amber = getting close, red = critical
const chCls = (ch) => ch >= 0.9 ? "st-good" : ch >= 0.7 ? "st-warn" : "st-hot";
const ctxCls = (frac) => frac >= 0.9 ? "st-hot" : frac >= 0.7 ? "st-warn" : "st-good";
// requests per session: 0–100 green, 100–200 amber, >200 red
const reqCls = (n) => n > 200 ? "st-hot" : n >= 100 ? "st-warn" : "st-good";

// one stats grammar everywhere: "ch 99.99% · in 12.46M · out 73.2k ·
// 133 reqs · ctx 148.4k". ch = cache hit: zcode's input_tokens already
// includes the cached part, so it's cache-read / input. ctx is measured
// against the 200k cliff.
function statsHtml(s) {
  const ch = (s.inputTokens ?? 0) > 0 ? (s.cacheRead ?? 0) / s.inputTokens : null;
  return (ch != null ? `ch <span class="st ${chCls(ch)}">${(ch * 100).toFixed(2)}%</span> · ` : "") +
    `in <b>${fmt(s.inputTokens)}</b> · out <b>${fmt(s.outputTokens)}</b> · reqs <b class="st ${reqCls(s.requests)}">${s.requests}</b> · ` +
    `ctx <b class="st ${ctxCls((s.maxContext ?? 0) / CTX_LIMIT)}">${fmt(s.maxContext)}</b>`;
}

function currentActivity(s) {
  const todo = (s.todos ?? []).find((t) => t.status === "in_progress");
  if (todo) return todo.content;
  if (s.lastTool) return prettyTool(s.lastTool.name);
  return "…";
}

let prev = null;
let filterProject = "all";
let harnessById = new Map(); // harness id -> { id, label, emoji, hasStop }
let flashId = null; // banner click → highlight this card until flashUntil
let flashUntil = 0;
const stoppedDirs = new Set(); // projects the user stopped this page-load

// showHarness: only for cards outside a marked section (the "other
// sessions" bucket) — cards under a root inherit the root head's mark,
// so repeating the letter on every subagent card is noise
function agentCard(s, showHarness = true) {
  const name = s.role ?? (s.title ? "main" : "session");
  const sparkId = "spark-" + s.id;
  const modelHtml = [s.model, s.thinking && `[${s.thinking}]`].filter(Boolean).join(" ");
  // icon grammar everywhere: status dot → harness mark → role icon → name
  const harnessBadge = showHarness ? harnessMark(s) : "";
  // a dead run's failure keeps its red dot but stops pulsing
  const dot = s.status === "failed" && s.live === false ? "exited" : s.status;
  const todoHtml = (s.todos ?? []).slice(0, 8).map((t) =>
    `<li class="${esc(t.status)}">${t.status === "done" ? "☑" : t.status === "in_progress" ? "▸" : "☐"} ${esc(t.content)}</li>`
  ).join("");
  return `
  <div class="kid" id="kid-${s.id}">
    <div class="row">
      <span class="status ${esc(dot)}" title="${esc(s.status)}${s.live === false ? " · process exited" : ""}"></span>
      ${harnessBadge}
      <span>${roleIcon(s)}</span>
      <span class="name">${esc(name)}</span>
      <span class="model">${esc(modelHtml)}</span>
    </div>
    ${s.description ? `<div class="desc" title="${esc(s.description)}">${esc(s.description)}</div>` : ""}
    <div class="when">${s.status === "sleep" ? "💤 " : ""}${ago(s.lastAt)}</div>
    <div class="nums"><span class="stats">${statsHtml(s)}</span></div>
    <canvas class="spark" id="${sparkId}" title="Token use per request. The dashed red line is the ${(CTX_LIMIT / 1000).toFixed(1)}k context cliff — past it the line turns red.&#10;x-axis: requests, oldest to newest (last 120, spaced by request order, not by time)&#10;y-axis: input tokens, 0 up to the ${(CTX_LIMIT / 1000).toFixed(1)}k cliff"></canvas>
    ${todoHtml ? `<ul class="todos">${todoHtml}</ul>` : ""}
    ${s.lastError ? `<div class="err">⚠ ${esc(humanType(s.lastError.type))}: ${esc(s.lastError.message ?? "")}${s.live === false ? " · run exited" : ""}</div>` : ""}
    ${s.lastError && s.directory && stoppedDirs.has(s.directory) ? `<div class="stoppedmark">⏹ stopped by you — project run killed</div>` : ""}
  </div>`;
}

// stop is a project action: every harness process in that directory is
// the same run, and all of them die together. The sessionId is sent so the
// server resolves the stop target through the exact session this dialog
// was built from (matches its own snapshot-order resolution).
async function stopProject(directory, project, procCount, harness, sessionId) {
  const ok = confirm(
    `Kill ${procCount} live ${harness ?? "harness"} process${procCount === 1 ? "" : "es"} in "${project}"?\n\n` +
    `This stops the whole project run — every session in\n${directory}\n` +
    `dies with it, not just the failed one.`,
  );
  if (!ok) return;
  try {
    const res = await fetch("/api/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory, sessionId }),
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
  const harness = harnessById.get(btn.dataset.harness ?? "")?.label;
  stopProject(btn.dataset.dir, btn.dataset.name, Number(btn.dataset.procs), harness, btn.dataset.session ?? null);
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
// click a chip → expand its detail panel (fetched lazily, refreshed while open);
// the 💬 button opens the live conversation in a new tab instead
$("activebar").addEventListener("click", (e) => {
  const conv = e.target.closest(".convbtn");
  if (conv) {
    window.open("/conversation.html#" + encodeURIComponent(conv.dataset.conv), "_blank");
    return;
  }
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
    <div class="lrow"><span class="ic hmark">Z</span> harness mark — every row shows which harness runs the agent (<span id="legend-harnesses"></span>)</div>
    <div class="lrow"><span class="ic">⏹</span> kill process — stops every live process of that project run (the whole run stops)</div>
  </div>`;

// the legend's harness list comes from the mounted adapters, not from a
// hardcoded string — it can't drift when a harness is added or renamed
function renderLegendHarnesses(harnesses) {
  const row = $("legend-harnesses");
  if (!row) return;
  row.innerHTML = (harnesses ?? []).map((h) =>
    `<span title="harness: ${esc(h.id)}"><span class="hmark">${esc(h.id.charAt(0).toUpperCase())}</span> ${esc(h.label)}</span>`
  ).join(" · ") || "none mounted";
}

function render(state) {
  // copying something? defer the re-render until the selection is gone —
  // swapping innerHTML on a 1.5s timer yanks text out from under the cursor
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) return;
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  computeInstances(state.sessions);
  harnessById = new Map((state.harnesses ?? []).map((h) => [h.id, h]));
  renderLegendHarnesses(state.harnesses);

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
      // The dialog names the run via the stop target's owning harness;
      // routing itself is the server's job — it resolves the same session
      // (list[0], snapshot order) through the sessionId we send below.
      const owner = list.find((s) => s.harness)?.harness;
      return `
      <div class="agroup">
        <div class="agroup-head">
          <span title="${esc(dir)}">${esc(shortProject(proj))}</span>
          ${stoppable ? `<button class="stopbtn" data-dir="${esc(dir)}" data-name="${esc(proj)}" data-procs="${procs}" data-session="${esc(list[0].id)}" data-harness="${esc(owner ?? "")}" title="SIGTERM all ${procs} live process(es) of this ${esc(harnessById.get(owner ?? "")?.label ?? "harness")} run in ${esc(dir)}">⏹ kill ${procs} process${procs === 1 ? "" : "es"}</button>`
            : stoppedDirs.has(dir) ? `<span class="stoppedmark">⏹ stopped by you</span>` : ""}
        </div>
        ${list.map((s) => {
          const state = stoppedDirs.has(dir) ? "stopped by you" : s.live ? "" : "run exited";
          return `
          <div class="aentry ${s.live ? "" : "exited"}">
            <span class="entry" data-target="${esc(s.id)}" title="${esc(fullLabel(s))}">${harnessMark(s)}<span class="ic">${roleIcon(s)}</span>${labelHtml(s)}</span>
            <span class="act">· ${esc(humanType(s.lastError?.type ?? "failed"))}</span>
            <span class="r">- ${esc(tagged([agoLong(s.lastAt), state].filter(Boolean).join(" · "), s))}</span>
          </div>`;
        }).join("")}
      </div>`;
    }).join("");
  if ($("alert").innerHTML !== alertHtml) $("alert").innerHTML = alertHtml;

  // active-now strip — only sessions with a heartbeat in the last 5m
  const actives = state.sessions.filter((s) => s.status === "running" && matches(s) && !stoppedDirs.has(s.directory)).sort(byLast);
  $("activewrap").style.display = actives.length ? "block" : "none";
  $("activebar").innerHTML = actives.map((s) => {
    const doing = currentActivity(s);
    const st = s.lastTool?.status && doing === s.lastTool.name ? ` ${s.lastTool.status}` : "";
    const open = expandedId === s.id;
    return `<div class="chip ${open ? "open" : ""}" data-session="${esc(s.id)}">` +
      `<button class="convbtn" data-conv="${esc(s.id)}" title="open the live conversation in a new tab">💬 live</button>` +
      `<span class="status running"></span>${harnessMark(s)}<span>${roleIcon(s)}</span>` +
      `<span class="l" title="${esc(fullLabel(s))}">${labelHtml(s)} <span class="act" title="${esc(doing)}">${esc(doing + st)}</span></span>` +
      `<span class="dash">-</span>` +
      `<span class="r">${instTag(s) ? esc(instTag(s)) + " · " : ""}${statsHtml(s)} · ${ago(s.lastAt)}</span></div>` +
      (open ? `<div class="chipdetail" id="detail-${esc(s.id)}">${detailHtml(detailCache.get(s.id))}</div>` : "");
  }).join("");

  // tree — ordered by time only (newest roots first, newest children
  // first): recency is the primary key; same-project sections end up
  // adjacent on their own because they share activity windows
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
          ${harnessMark(root)}
          <span>🧑‍✈️</span>
          ${root.project ? `<span class="proj" title="${esc(root.project)}">${esc(shortProject(root.project))}</span>` : ""}
          <span class="title">${esc(root.title ?? "main session")}</span>
          <span class="model">${esc([root.model, root.thinking && `[${root.thinking}]`].filter(Boolean).join(" "))}</span>
          ${harnessMark(root)}
          <span class="meta">${statsHtml(root)} · ${root.status === "sleep" ? "💤 " : ""}${ago(root.lastAt)}</span>
        </div>
        <div class="kids">${kids.map((s) => agentCard(s, false)).join("") || `<div class="desc" style="padding:6px 4px">no dispatched subagents</div>`}</div>
      </div>`);
  }
  const orphans = state.sessions.filter((s) => !seen.has(s.id) && matches(s)).sort(byLast);
  if (orphans.length)
    sections.push(`<div class="root"><div class="head"><span class="title">other sessions</span></div><div class="kids">${orphans.map((s) => agentCard(s, true)).join("")}</div></div>`);
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
    // same tooltip vocabulary as the chips and FAILED rows: full project,
    // role, instance and brief — plus what the tool call actually was
    const tip = (agent ? fullLabel(agent) : t.sessionId) +
      ` — ${prettyTool(t.tool)}` +
      (t.status ? ` · ${t.status}` : "") +
      (t.outputBytes != null ? ` · ${fmt(t.outputBytes)}B` : "");
    const right = [t.outputBytes != null ? `${fmt(t.outputBytes)}B` : "", ago(t.at)].filter(Boolean).join(" · ");
    return `<li class="${isNew ? "new" : ""}" data-target="${esc(t.sessionId)}" title="${esc(tip)}"><span class="l">${agent ? harnessMark(agent) + " " + roleIcon(agent) + " " + labelHtml(agent) : harnessMark(t.harness ?? t.sessionId) + " session"} <span class="act">${esc(prettyTool(t.tool))} ${t.status ?? ""}</span></span><span class="dash">-</span><span class="r">${esc(tagged(right, agent))}</span></li>`;
  }).join("");

  prev = state;
}

async function poll() {
  try {
    const res = await fetch("/api/state");
    const state = await res.json();
    render(state);
    // keep the open detail panel fresh (fetchDetail throttles to DETAIL_TTL_MS)
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