// AgenQ live conversation — polls /api/session/:id/messages with a cursor and
// appends only what's new. Session id comes in via the URL hash:
//   conversation.html#sess_xxx
const id = decodeURIComponent(location.hash.slice(1));
let cursor = null;
let firstLoad = true;
const log = document.getElementById("log");
const pollEl = document.getElementById("poll");
const pollText = document.getElementById("poll-text");

if (!id) {
  document.getElementById("title").textContent = "no session in URL — open via the 💬 button on the board";
  log.innerHTML = "";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function when(ts) {
  return new Date(ts).toLocaleTimeString();
}

// the board's status vocabulary, for the tool chips
const ST_CLASS = { running: "running", completed: "completed", done: "completed", pending: "pending", error: "error", failed: "error", cancelled: "error" };

// user prompts can be huge injected role definitions — long ones collapse
// to their first lines until clicked
function textBody(text) {
  if (text.length <= 1500) return `<div class="body">${esc(text)}</div>`;
  const preview = text.slice(0, 300);
  return `<details><summary>${esc(preview)} …</summary><pre>${esc(text)}</pre></details>`;
}

function itemHtml(it) {
  const who = it.role === "user" ? "you" : "assistant";
  if (it.kind === "text") {
    return `<div class="msg ${esc(it.role)}"><span class="who">${who}</span> ` +
      `<span class="when">${when(it.at)}</span>${textBody(it.text)}</div>`;
  }
  if (it.kind === "think") {
    return `<details class="think"><summary>thinking <span class="when">${when(it.at)}</span></summary>` +
      `<pre>${esc(it.text)}</pre></details>`;
  }
  if (it.kind === "tool") {
    const st = ST_CLASS[it.status] ?? "";
    return `<details class="tool"><summary>` +
      `<span class="tname">⚡ ${esc(it.tool)}</span>` +
      (it.status ? `<span class="st ${st}">${esc(it.status)}</span>` : "") +
      `<span class="when">${when(it.at)}</span></summary>` +
      (it.input ? `<pre>${esc(it.input)}</pre>` : "") +
      `</details>`;
  }
  return "";
}

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
}

async function poll() {
  if (!id) return;
  try {
    const url = `/api/session/${encodeURIComponent(id)}/messages` +
      (cursor ? `?after=${encodeURIComponent(cursor)}` : "");
    const res = await fetch(url);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    if (d.title) {
      // prefix = owning harness (zcode:sess_x / hermes:7) — mark it so a
      // conversation tab is identifiable independent of the board. The board
      // page loads visuals.js; this page loads it too (see conversation.html)
      // so HARNESS_EMOJI here is the shared map, not a local copy.
      const h = id.includes(":") ? id.split(":")[0] : null;
      document.getElementById("title").textContent =
        (h ? `${HARNESS_EMOJI[h] ?? "🔗"} [${h}] ` : "") + d.title;
      document.title = d.title + " — AgenQ live";
    }
    if (d.items?.length) {
      const stick = firstLoad || nearBottom();
      const frag = document.createElement("div");
      frag.innerHTML = d.items.map(itemHtml).join("");
      if (firstLoad) log.innerHTML = "";
      while (frag.firstChild) log.appendChild(frag.firstChild);
      if (firstLoad) {
        firstLoad = false;
        const head = document.createElement("div");
        head.className = "more";
        head.textContent = "— older messages beyond the last 400 part rows are not shown —";
        log.prepend(head);
      }
      if (stick) window.scrollTo({ top: document.body.scrollHeight });
    } else if (firstLoad) {
      log.innerHTML = `<div class="pending">no conversation yet — nothing said in this session so far</div>`;
    }
    cursor = d.cursor;
    pollEl.classList.remove("stale");
    pollText.textContent = "live · " + new Date().toLocaleTimeString();
  } catch (e) {
    pollEl.classList.add("stale");
    pollText.textContent = "stale — " + e.message;
  }
}
poll();
setInterval(poll, 2000);
