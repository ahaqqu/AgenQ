// AgenQ front end — the lazy per-session detail panel behind the Active Now
// chips. Loaded before app.js. detailCache is capped (A3): a long-lived tab
// over weeks of sessions must not grow without bound.
const DETAIL_TTL_MS = 4000;
const DETAIL_CACHE_MAX = 20;

const detailCache = new Map(); // id -> { data?, error?, fetchedAt }
let expandedId = null;
let detailInflight = false;

function cachePut(id, entry) {
  detailCache.set(id, entry);
  if (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = [...detailCache.entries()]
      .filter(([k]) => k !== expandedId)
      .sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
    if (oldest) detailCache.delete(oldest[0]);
  }
}

async function fetchDetail(id, force = false) {
  const c = detailCache.get(id);
  if (!force && c && Date.now() - c.fetchedAt < DETAIL_TTL_MS) return;
  if (detailInflight) return;
  detailInflight = true;
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(id)}/detail`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    cachePut(id, { data: await res.json(), fetchedAt: Date.now() });
  } catch (e) {
    cachePut(id, { error: e.message, fetchedAt: Date.now() });
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
    ` · out ${fmt(tk.output ?? 0)} <span class="dim">(reasoning ${fmt(tk.reasoning ?? 0)})</span> · reqs ${tk.requests ?? 0}</div>` +
    (d.turns?.[0] ? `<div class="trow dim">latest turn: in ${fmt(d.turns[0].input_tokens)} / out ${fmt(d.turns[0].output_tokens)} / reasoning ${fmt(d.turns[0].reasoning_tokens)}</div>` : "") +
    `</span></div>`);

  if (d.errors?.length)
    out.push(`<div class="dsec"><span class="dlab">errors</span><span class="dval">` +
      d.errors.map((e) => `<div class="trow del">✗ ${esc(humanType(e.type))}: ${esc(e.message ?? "")} <span class="dim">${ago(e.at)}</span></div>`).join("") +
      `</span></div>`);

  return out.join("");
}