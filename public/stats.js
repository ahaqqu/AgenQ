// AgenQ stats page: the long-history view the live board's window cannot
// show. Reads /api/stats — timestamped usage buckets (each harness declares
// how finely its telemetry can be attributed: "hour" or "day"), session rows
// for the counters that cannot be split, and each harness's observed data
// coverage — and renders one selected range at a time: preset chips (24h,
// 7d, 30d, a calendar month, all history) or a hand-picked from/to pair.
//
// Grain is the load-bearing idea. A harness that only resolves to a day
// cannot honestly contribute to a 24-hour range — spreading one day's tokens
// across 24 hourly bars would invent detail the telemetry does not have — so
// its usage is left out of sub-day ranges (with a visible note; its
// agents/duration still count) and summed into day buckets for coarser ones.
// Plain globals like the rest of the frontend; visuals.js provides fmt, dur,
// esc, $, harnessMark.

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_CAP = 12; // calendar months offered in the picker

// ---------- local-calendar helpers ----------
// the range/bucket/grain math lives in ranges.js (loaded before this file) so
// `bun test` can exercise it headlessly; only presentation helpers are here
const {
  HOUR_MS,
  pad2, startOfHour, startOfDay, startOfMonth, addHours, addDays, addMonths,
  bucketStart, addBuckets, grainForSpan, grainAllows, rangeBuckets, renderedWindow,
  sessionInRange, bucketOverlapsRange, monthKey,
} = globalThis.RANGES;

// how many buckets a range may render; beyond this the bars stop being
// readable anyway, and an unbounded spread/innerHTML would fall over on a
// hand-typed millennial span (see applyCustom)
const BUCKET_CAP = 2000;

const dShort = (ms) => { const d = new Date(ms); return `${MON[d.getMonth()]} ${d.getDate()}`; };
const dFull = (ms) => { const d = new Date(ms); return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const tShort = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
// a bucket label at its own grain: "Sep 28" for a day, "Sep 28 14:00" for an hour
const bucketLabel = (ms, grain) => (grain === "hour" ? `${dShort(ms)} ${pad2(new Date(ms).getHours())}:00` : dShort(ms));
const monthLabel = (mk) => { const [y, m] = mk.split("-").map(Number); return `${MON[m - 1]} ${y}`; };
const clock = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

// the value a <input type="datetime-local"> wants: local wall clock, no zone
const inputValue = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const parseInputValue = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// ---------- ranges ----------

function presetRange(id, state, now) {
  const hourStart = startOfHour(now);
  // `relative: true` marks a window measured back from now, which every
  // render recomputes (see renderSelected)
  switch (id) {
    case "24h":
      return { id, label: "Last 24 hours", relative: true, from: addHours(hourStart, -23), to: addHours(hourStart, 1), grain: "hour" };
    case "7d":
      return { id, label: "Last 7 days", relative: true, from: addDays(startOfDay(now), -6), to: addDays(startOfDay(now), 1), grain: "day" };
    case "30d":
      return { id, label: "Last 30 days", relative: true, from: addDays(startOfDay(now), -29), to: addDays(startOfDay(now), 1), grain: "day" };
    case "all": {
      const froms = state.harnesses.map((h) => h.coverage?.from).filter(Boolean);
      const tos = state.harnesses.map((h) => h.coverage?.to).filter(Boolean);
      if (!froms.length) return null;
      const span = Math.max(...tos, now) - Math.min(...froms);
      const grain = grainForSpan(span);
      // snap to whole buckets: "all history" means all of it, and a raw
      // coverage instant would otherwise read as a widened window
      return {
        id,
        label: "All history",
        from: bucketStart(Math.min(...froms), grain),
        to: addBuckets(bucketStart(Math.max(...tos, now), grain), 1, grain),
        grain,
      };
    }
    default:
      return null;
  }
}

const monthRange = (mk) => {
  const [y, m] = mk.split("-").map(Number);
  const from = new Date(y, m - 1, 1).getTime();
  return { id: `m:${mk}`, label: monthLabel(mk), from, to: addMonths(from, 1), grain: "day" };
};

const customRange = (from, to) => ({ id: "custom", label: "Custom range", from, to, grain: grainForSpan(to - from) });

// months worth offering: every month any harness has data in, newest first
function monthOptions(state) {
  const out = [];
  const seen = new Set();
  const add = (mk) => { if (!seen.has(mk)) { seen.add(mk); out.push(mk); } };
  for (const h of state.harnesses) {
    for (const r of h.usage) if (r.at) add(monthKey(r.at));
    if (h.coverage) {
      for (let t = startOfMonth(h.coverage.from); t <= h.coverage.to; t = addMonths(t, 1)) add(monthKey(t));
    }
  }
  return out.sort().reverse().slice(0, MONTH_CAP);
}

// ---------- aggregation ----------

const newRow = (key) => ({ key, requests: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, agents: null, ch: null, duration: null });
const rowTotal = (r) => r.inputTokens + r.outputTokens;
const addUsage = (row, r) => {
  row.requests += r.requests;
  row.inputTokens += r.inputTokens;
  row.outputTokens += r.outputTokens;
  row.cacheRead += r.cacheRead;
  row.cacheCreate += r.cacheCreate;
};
const addSession = (row, s) => {
  row.agents = (row.agents ?? 0) + (s.isSubagent ? 0 : 1);
  row.ch = (row.ch ?? 0) + (s.isSubagent ? 1 : 0);
  row.duration = (row.duration ?? 0) + Math.max(0, (s.lastAt ?? s.firstAt) - s.firstAt);
};
const mapRow = (map, key) => {
  if (!map.has(key)) map.set(key, newRow(key));
  return map.get(key);
};
const byBurn = (a, b) => rowTotal(b) - rowTotal(a) || b.requests - a.requests;

function aggregate(state, range) {
  const buckets = rangeBuckets(range);
  const bucketIndex = new Map(buckets.map((t, i) => [t, i]));
  const perBucketIn = buckets.map(() => 0);
  const perBucketOut = buckets.map(() => 0);
  const groups = {
    total: newRow("all harnesses"),
    harness: new Map(),
    project: new Map(),
    provider: new Map(),
    model: new Map(),
  };
  const excluded = []; // harnesses whose usage resolution is too coarse for this range

  for (const h of state.harnesses) {
    const hRow = newRow(h.label);
    let touched = false;
    if (grainAllows(h.grain, range.grain)) {
      for (const r of h.usage) {
        // a row's own bucket start (hour or day) → this range's bucket
        const key = bucketStart(r.at, range.grain);
        const i = bucketIndex.get(key);
        if (i === undefined) continue;
        touched = true;
        perBucketIn[i] += r.inputTokens;
        perBucketOut[i] += r.outputTokens;
        addUsage(groups.total, r);
        addUsage(hRow, r);
        addUsage(mapRow(groups.project, r.project ?? "(no project)"), r);
        addUsage(mapRow(groups.provider, String(r.provider ?? "").trim() || "(unknown)"), r);
        addUsage(mapRow(groups.model, r.model || "(unknown)"), r);
      }
    } else {
      // usage left out; the note below says why. Sessions still count.
      if (h.usage.some((r) => bucketOverlapsRange(r.at, range, h.grain))) excluded.push(h);
    }
    for (const s of h.sessions) {
      if (!sessionInRange(s, range)) continue;
      touched = true;
      addSession(groups.total, s);
      addSession(hRow, s);
      addSession(mapRow(groups.project, s.project ?? "(no project)"), s);
    }
    if (touched) groups.harness.set(h.id, hRow);
  }

  return {
    buckets,
    perBucketIn,
    perBucketOut,
    excluded,
    total: [groups.total],
    harness: [...groups.harness.values()].sort(byBurn),
    project: [...groups.project.values()].sort(byBurn),
    provider: [...groups.provider.values()].sort(byBurn),
    model: [...groups.model.values()].sort(byBurn),
  };
}

// ---------- rendering ----------

const notes = (h) => (h.notes ?? []).map((n) => `<div class="cnote">· ${esc(n)}</div>`).join("");

function harnessCoverage(h) {
  const mark = harnessMark(h.id);
  const grainTag = `<span class="grain" title="the finest usage attribution this harness's telemetry supports">${esc(h.grain)}</span>`;
  if (!h.coverage) {
    return `<div class="crow">${mark} <span class="none">${esc(h.label)} — no data on disk</span>${grainTag}</div>${notes(h)}`;
  }
  const days = Math.round((h.coverage.to - h.coverage.from) / 86400_000) + 1;
  return (
    `<div class="crow">${mark} <span class="span">${esc(h.label)}</span> ${grainTag}` +
    ` <span class="days">data ${dFull(h.coverage.from)} → ${dFull(h.coverage.to)} · ${days} day${days === 1 ? "" : "s"}</span></div>` +
    notes(h)
  );
}

const hasDataIn = (h, range) =>
  h.sessions.some((s) => sessionInRange(s, range)) ||
  (grainAllows(h.grain, range.grain) && h.usage.some((r) => bucketOverlapsRange(r.at, range, h.grain)));

function bucketChart(range, agg) {
  const n = agg.buckets.length;
  // a loop, not a spread: a wide range can carry thousands of buckets, and
  // Math.max(...arr) throws once the argument list overflows the stack
  let max = 1;
  for (let i = 0; i < n; i++) {
    const total = agg.perBucketIn[i] + agg.perBucketOut[i];
    if (total > max) max = total;
  }
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  const bars = agg.buckets
    .map((t, i) => {
      const total = agg.perBucketIn[i] + agg.perBucketOut[i];
      const tip = `title="${esc(bucketLabel(t, range.grain))} — in ${fmt(agg.perBucketIn[i])}, out ${fmt(agg.perBucketOut[i])}"`;
      const segs = total
        ? `<div class="seg out" style="height:${(agg.perBucketOut[i] / max) * 100}%"></div><div class="seg in" style="height:${(agg.perBucketIn[i] / max) * 100}%"></div>`
        : "";
      return `<div class="bar ${total ? "" : "void"}" ${tip}>${segs}</div>`;
    })
    .join("");
  const axis = agg.buckets
    .map((t, i) => `<div class="cell">${i % labelEvery === 0 || i === n - 1 ? esc(bucketLabel(t, range.grain)) : ""}</div>`)
    .join("");
  return (
    `<div class="daily"><div class="ymax">↑ ${fmt(max)} peak ${range.grain === "hour" ? "hour" : "day"}</div>` +
    `<div class="dlegend">in<span class="sw in"></span>out<span class="sw out"></span></div>${bars}</div>` +
    `<div class="daxis">${axis}</div>`
  );
}

function groupTable(title, rows, withSessions) {
  if (!rows.length) return "";
  const max = Math.max(1, ...rows.map(rowTotal));
  const dim = `<span class="dim">—</span>`;
  const body = rows
    .map((r) => {
      const total = rowTotal(r);
      const share = total
        ? `<span class="share" title="in ${fmt(r.inputTokens)} · out ${fmt(r.outputTokens)}">` +
          `<span class="s in" style="width:${(r.inputTokens / max) * 100}%"></span>` +
          `<span class="s out" style="width:${(r.outputTokens / max) * 100}%"></span></span>`
        : "";
      const sessCells = withSessions
        ? `<td title="main sessions">${r.agents ?? dim}</td><td title="subagent sessions">${r.ch ?? dim}</td><td title="summed session spans">${r.duration != null ? dur(r.duration) || "0s" : dim}</td>`
        : "";
      return (
        `<tr><td title="${esc(r.key)}">${esc(r.key)}</td>` +
        `<td>${fmt(r.inputTokens)}</td><td>${fmt(r.outputTokens)}</td><td>${fmt(r.requests)}</td>` +
        sessCells +
        `<td>${share}</td></tr>`
      );
    })
    .join("");
  const sessHead = withSessions
    ? `<th title="main sessions — managers and standalone">agents</th><th title="subagent sessions">ch</th><th title="summed session spans (start → last activity)">duration</th>`
    : "";
  return (
    `<div class="gtable"><div class="ghead">${esc(title)}</div><table>` +
    `<tr><th></th><th title="input tokens as the harness records them — cache handling differs per harness (see coverage notes)">Σ in</th>` +
    `<th title="output tokens">Σ out</th><th title="model requests">reqs</th>${sessHead}<th title="share of Σ in + Σ out in this group">share</th></tr>` +
    body +
    `</table></div>`
  );
}

function renderRange(state, range) {
  const agg = aggregate(state, range);
  // Buckets are always whole local hours/days, so a range whose edges fall
  // inside a bucket is widened to cover them; the header says so instead of
  // presenting a partial bucket as if it were exactly the requested window.
  const win = renderedWindow(range, agg.buckets);
  const grainWord = range.grain === "hour" ? "hour" : "day";
  const exact = range.grain === "hour" ? `${dShort(range.from)} ${tShort(range.from)} – ${dShort(range.to)} ${tShort(range.to)}` : `${dShort(range.from)} – ${dShort(addDays(range.to, -1))}`;
  const sub = win.widened
    ? `${exact} · counted as whole ${grainWord} buckets: ${bucketLabel(win.from, range.grain)} – ${bucketLabel(addBuckets(win.to, -1, range.grain), range.grain)}`
    : `${exact} · ${agg.buckets.length} ${grainWord}${agg.buckets.length === 1 ? "" : "s"}`;

  // A harness is "partial" only when it is missing a whole bucket of the
  // range — its data starting mid-way through the first bucket is the
  // snapping artifact of that range, not a gap worth warning about.
  const firstBucketEnd = addBuckets(bucketStart(range.from, range.grain), 1, range.grain);
  const partial = state.harnesses
    .filter((h) => h.coverage && h.coverage.from >= firstBucketEnd && hasDataIn(h, range))
    .map(
      (h) =>
        `<div>${harnessMark(h.id)} ${esc(h.label)} — telemetry starts ${dFull(h.coverage.from)}; ${grainWord}s before that are missing from this range's numbers</div>`,
    )
    .join("");
  const excludedNote = agg.excluded.length
    ? `<div>${agg.excluded.map((h) => harnessMark(h.id)).join(" ")} ${agg.excluded.map((h) => esc(h.label)).join(", ")} — ` +
      `telemetry resolves only to a day, so its usage is not counted in this ${grainWord}-grained range (its agents and duration still are)</div>`
    : "";

  const any = agg.total[0].requests || agg.total[0].agents || agg.harness.length;
  const tables = any
    ? `<div class="gtables">` +
      groupTable("TOTAL", agg.total, true) +
      groupTable("BY HARNESS", agg.harness, true) +
      groupTable("BY PROJECT", agg.project, true) +
      groupTable("BY PROVIDER", agg.provider, false) +
      groupTable("BY MODEL", agg.model, false) +
      `</div>` +
      `<div class="footnote">Σ in / Σ out / reqs are attributed bucket by bucket; agents / ch / duration count a session whole (its full span) when any of it falls inside the range. ` +
      `By provider and by model count usage only — one session can use many. "in" is each harness's own input figure; DSH includes cache reads in it, zcode and hermes report cache separately.</div>`
    : `<div class="empty">no activity recorded in this range</div>`;
  return (
    `<section class="rangeblock"><h2>${esc(range.label)}</h2><div class="sub">${esc(sub)}</div>` +
    (excludedNote || partial ? `<div class="partial">${excludedNote}${partial}</div>` : "") +
    bucketChart(range, agg) +
    tables +
    `</section>`
  );
}

// ---------- page state ----------

let STATE = null;
let CURRENT = null; // the selected range descriptor, or null for the default

function defaultRange(state, now) {
  return presetRange("30d", state, now);
}

function render(state) {
  const alertEl = $("alert");
  alertEl.className = "alert";
  if (state.warnings?.length) {
    alertEl.className = "alert warn";
    alertEl.innerHTML = state.warnings.map((w) => `<div>${esc(w)}</div>`).join("");
  }
  $("generated").textContent = "updated " + clock(state.generatedAt ?? Date.now());

  $("coverage-body").innerHTML = state.harnesses.length
    ? state.harnesses.map(harnessCoverage).join("")
    : `<div class="crow"><span class="none">no harness offers stats</span></div>`;

  // month picker options
  const pick = $("monthpick");
  const options = monthOptions(state);
  pick.innerHTML = `<option value="">month…</option>` + options.map((mk) => `<option value="${mk}">${esc(monthLabel(mk))}</option>`).join("");

  const rangesEl = $("ranges");
  if (state.harnesses.every((h) => !h.usage.length && !h.sessions.length)) {
    rangesEl.innerHTML = `<div class="empty">no telemetry recorded yet — start a session in any mounted harness</div>`;
    return;
  }
  renderSelected();
}

function renderSelected() {
  const now = Date.now();
  const state = STATE;
  if (!state) {
    $("ranges").innerHTML = `<div class="empty">no data loaded yet — press refresh to read the harnesses</div>`;
    return;
  }
  // Relative presets are windows from *now*, so they are recomputed on every
  // render rather than reused: a "last 24 hours" selected this morning must
  // not still chart this morning's window after a refresh. Custom ranges and
  // calendar months are absolute and carried as-is.
  const range = CURRENT?.relative ? presetRange(CURRENT.id, state, now) : CURRENT ?? defaultRange(state, now);
  if (!range) {
    $("ranges").innerHTML = `<div class="empty">no data on disk yet</div>`;
    return;
  }
  CURRENT = range;
  // mark the active preset chip
  for (const chip of document.querySelectorAll(".chip[data-preset]")) {
    chip.classList.toggle("active", !CURRENT ? chip.dataset.preset === "30d" : chip.dataset.preset === CURRENT.id);
  }
  $("ranges").innerHTML = renderRange(state, range);

  // keep the custom inputs showing the active range, so a hand-edit starts
  // from what is on screen
  if (!range.id.startsWith("m:")) {
    $("fromin").value = inputValue(range.from);
    $("toin").value = inputValue(range.to);
  }
  $("rangeerr").textContent = "";
}

function selectPreset(id) {
  if (!STATE) { $("rangeerr").textContent = "no data loaded yet — press refresh"; return; }
  const range = presetRange(id, STATE, Date.now());
  if (!range) { $("rangeerr").textContent = "no data for that range yet"; return; }
  CURRENT = range;
  $("monthpick").value = "";
  renderSelected();
}

function applyCustom() {
  if (!STATE) { $("rangeerr").textContent = "no data loaded yet — press refresh"; return; }
  const from = parseInputValue($("fromin").value);
  const to = parseInputValue($("toin").value);
  const err = $("rangeerr");
  if (from == null || to == null) { err.textContent = "pick both a from and a to time"; return; }
  if (from >= to) { err.textContent = "from must be before to"; return; }
  const range = customRange(from, to);
  // a hand-typed millennial span would render millions of bars; the grain
  // steps down first, and past that the range is refused outright
  const buckets = Math.ceil((range.to - bucketStart(range.from, range.grain)) / (range.grain === "hour" ? HOUR_MS : 86400_000));
  if (buckets > BUCKET_CAP) {
    err.textContent = `that range is too wide to chart (${buckets.toLocaleString()} ${range.grain}s) — pick a shorter one, or use all history`;
    return;
  }
  CURRENT = range;
  $("monthpick").value = "";
  renderSelected();
  err.textContent = "";
}

// ---------- load ----------

const refreshBtn = $("refresh");
let busy = false;
async function load() {
  if (busy) return;
  busy = true;
  refreshBtn.classList.add("busy");
  refreshBtn.textContent = "computing…";
  try {
    const res = await fetch("/api/stats");
    const state = await res.json();
    if (!res.ok || state.error) {
      $("alert").className = "alert";
      $("alert").textContent = state.error || `HTTP ${res.status}`;
    } else {
      STATE = state;
      // carry the selection across a refresh when its preset still exists
      render(state);
    }
  } catch (e) {
    $("alert").className = "alert";
    $("alert").textContent = String(e?.message ?? e);
  } finally {
    busy = false;
    refreshBtn.classList.remove("busy");
    refreshBtn.textContent = "refresh";
  }
}

$("rangebar").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.dataset.preset) selectPreset(chip.dataset.preset);
  else if (chip.id === "applybtn") applyCustom();
});
$("monthpick").addEventListener("change", (e) => {
  if (!e.target.value) return;
  CURRENT = monthRange(e.target.value);
  renderSelected();
});
$("refresh").addEventListener("click", load);
load();
