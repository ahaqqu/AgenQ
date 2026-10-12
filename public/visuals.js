// AgenQ front-end shared visuals: number/time formatting and the sparkline
// renderer. Loaded after marks.js, which carries the derived harness/role
// marks and the escaping their markup needs; both files speak plain globals
// (no bundler in this project by design).
// The one context cliff every card and sparkline is drawn against. AgenQ
// deliberately reads no per-model window from any harness: a 128k model and
// a 1M model would otherwise put the same fill at opposite ends of the
// gauge, and "past 200k, worry" is the rule the board was designed around.
const CTX_LIMIT = 200_000;

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
// a time span for people: 45s / 40m / 2h 15m — card live time, run length
function dur(ms) {
  if (!ms || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return Math.max(1, Math.round(ms / 1000)) + "s";
  const h = Math.floor(m / 60);
  return h ? h + "h " + (m % 60) + "m" : m + "m";
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
  // y-scale always spans the cliff, so the line (and what's
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
  // cliff marker + label, always drawn now that the scale reaches it
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
