// AgenQ front-end shared visuals: formatting helpers and the sparkline
// renderer. Loaded before app.js; both files speak plain globals (no
// bundler in this project by design).
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
// Harness origin marks: the letter is derived from the harness id
// (zcode → Z, hermes → H), so any future adapter gets a mark with no map
// and no client edit. One identical mark on every surface — no label
// variant; the full harness name lives in the tooltip and the legend.
// Each mark also carries a per-harness accent color (letter, border, faint
// tint) so harnesses are distinguishable at a glance: known ids get a
// hand-picked hue, anything else a stable one hashed from the id.
// Accepts a session object (uses its `harness` field), a bare harness id
// (ticker entries), or null.
const HARNESS_HUE = { "zcode": 212, "hermes": 26 };
function harnessHue(id) {
  if (HARNESS_HUE[id] != null) return HARNESS_HUE[id];
  let x = 0;
  for (let i = 0; i < id.length; i++) x = (x * 31 + id.charCodeAt(i)) % 360;
  return x;
}
function harnessStyle(h) {
  const hue = harnessHue(h);
  return `color:hsl(${hue} 85% 74%);border-color:hsl(${hue} 55% 46%);background:hsl(${hue} 75% 60% / .14)`;
}
function harnessMark(s) {
  const h = typeof s === "string" ? s : (s?.harness ?? "");
  if (!h) return "";
  return `<span class="hmark" style="${harnessStyle(h)}" title="harness: ${esc(h)}">${esc(h.charAt(0).toUpperCase())}</span>`;
}
const CTX_LIMIT = 200_000; // the cliff from the #94 analysis

const $ = (id) => document.getElementById(id);

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
// agent_failed → "Agent failed" — statuses are for the DB, people read prose
function humanType(t) {
  const s = String(t ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function drawSpark(canvas, series) {
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 44;
  canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio;
  const ctx = canvas.getContext("2d");
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  if (!series || series.length < 2) return;
  // plot backdrop distinct from the card background (card = --bg)
  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue("--panel").trim() || "#131824";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 4);
  ctx.fill();
  // y-scale always spans the context cliff so the 200k line (and what's
  // under vs. over it) is readable even on quiet sessions
  const max = Math.max(...series, CTX_LIMIT);
  const step = w / (series.length - 1);
  const yOf = (v) => h - (v / max) * (h - 4) - 2;
  // area
  ctx.beginPath();
  ctx.moveTo(0, h);
  series.forEach((v, i) => ctx.lineTo(i * step, yOf(v)));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = "rgba(110,168,254,.15)";
  ctx.fill();
  // line, turning red past the context cliff
  const scaled = series.map(yOf);
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = i * step, y = scaled[i];
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = max > CTX_LIMIT ? "#e5534b" : "#6ea8fe";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // cliff marker + label, always drawn now that the scale reaches 200k
  {
    const y = yOf(CTX_LIMIT);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(229,83,75,.5)";
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(229,83,75,.8)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.fillText(fmt(CTX_LIMIT), w - 2, y - 2);
  }
  ctx.textAlign = "left";
}