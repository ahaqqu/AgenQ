# Harness adapters

AgenQ is harness-agnostic: any tool that runs AI coding sessions and leaves
telemetry on disk can appear on the board. A **harness adapter** teaches the
monitor how one such tool — ZCode, Hermes and DeepSeek Harness today — exposes:

1. a **state snapshot**: every session, its tokens, status, todos, errors and
   its place in the manager→subagent tree (poll, ~1.5s cadence),
2. a **conversation feed**: the messages of one session, cursor-resumable
   (poll, ~2s cadence, only used by the live conversation tab),
3. a **stop action**: what "stop this run" means and whether it exists,
4. a **long-history stats view** (optional): bucket-attributed usage rows and
   session rows behind `/api/stats` and the `/stats.html` dashboard — the
   board's `--window-hours` window does not apply to it.

## The contract

An adapter is one directory exporting a single default object from
`index.mjs`:

```js
export default {
  id: "zcode",                    // unique, stable; becomes the session-id prefix
  label: "ZCode",                 // shown in the UI origin badge
  letter: "Z",                    // origin letter shown on every board item (optional; first letter of id is the default)
  hasStop: true,                  // does stopRun() exist for this harness?

  // One poll's full board data for this harness. Must return the shape in
  // "Snapshot" below. Must never throw on a missing/empty installation —
  // return the empty shape instead (the board renders empty).
  async snapshot(now) { ... },

  // Cursor-resumable messages for one session id (unprefixed namespace).
  // after === null means first load (tail the last N rows, oldest first);
  // otherwise after is the "mseq:pseq" string previously returned in cursor.
  // Returns { title, cursor, items:[{kind, role, text?, tool?, input?, at}] }.
  // sessionIds are namespaced by the registry before they reach you.
  async messages(id, after) { ... },

  // Optional — only meaningful when hasStop === true. Stops the whole run
  // (project-level for ZCode) behind one directory. Throw on failure; the
  // server maps that to a 500.
  async stopRun(directory) { ... },

  // Optional — the long-history view behind GET /api/stats and /stats.html.
  // Unlike snapshot(), the window does not apply: report everything the
  // harness's telemetry still holds, plus the coverage it actually observed.
  // Throw on failure; the registry degrades that harness to a warning.
  stats() { ... },
};
```

### Stats shape

`stats()` returns `{ coverage, grain, notes, usage, sessions }`:

```js
{
  coverage: { from, to } | null,   // observed first/last telemetry timestamp, null when nothing is on disk
  grain: "hour" | "day",           // the finest bucket this harness's telemetry can attribute usage to
  notes: ["…"],                    // per-harness caveats shown verbatim on the page
  usage: [{
    at,                            // start of the local bucket, epoch ms (localKeyToMs of a local hour/day label)
    project, provider, model,      // grouping keys; provider/model null when the harness records neither
    requests, inputTokens, outputTokens, cacheRead, cacheCreate,
  }],
  sessions: [{ firstAt, lastAt, project, isSubagent }],
}
```

`grain` is required on **every** path, including the empty shape a missing
install returns (`emptyStats(grain)` from `../lib.mjs`): the page badges each
harness with the resolution its telemetry supports, and the registry treats a
missing or unrecognized grain as a contract error (a warning, and that harness
is left off the page) rather than guessing a resolution for it.

Report the **finest grain the telemetry actually supports**, and no finer.
`grain: "hour"` means every usage row carries a real per-request timestamp
that can be bucketed to the hour (zcode's `model_usage`, DSH's per-call usage
events) — it is what lets the dashboard offer a truthful "last 24 hours".
`grain: "day"` means usage is only known per day (hermes keeps cumulative
per-session totals with a first/last-seen pair, no per-request rows); the
dashboard then leaves those rows out of sub-day ranges rather than spreading
one day's tokens across 24 hourly bars. Declaring a finer grain than the data
supports would make the page lie, which is worse than showing less.

Usage rows are grouped by bucket × project × provider × model; the page
buckets and rolls them up client-side (that is what makes a cross-harness "by
provider" table meaningful). `mergeUsage()` and `usageKey()` in `../lib.mjs`
are the shared implementation of that row identity — use them instead of
hand-rolling the key, so the three adapters cannot drift on the wire shape.
`sessions` are for the counters that cannot be bucket-attributed — agents
(main sessions), ch (subagents) and summed duration — and are counted whole in
any range their span intersects.

Two rules the page depends on: name buckets by the **server's local calendar**
(`localHourKey` / `localDayKey`, converted back with `localKeyToMs`), so month
labels and range edges mean the user's own wall clock — and never round-trip a
wall-clock string back through SQLite's `strftime('%s', …)`, which reinterprets
it as UTC and shifts every bucket by the host's offset (`harness/zcode/stats.test.mjs`
pins this under non-UTC timezones) — and exclude the sessions the board
excludes (archived/hidden) so the dashboard and the board describe the same
subset. A harness with no long-history view simply omits `stats` and does not
appear on the stats page.

### Snapshot shape (per session)

`snapshot(now)` returns:

```js
{
  sessions: [{
    id, title, parentId, project, directory,
    role, model, thinking, status,        // status: "running"|"sleep"|"done"|"failed"|"idle"|"exited"
    requests, inputTokens, outputTokens, cacheRead, cacheCreate, maxContext,
    firstAt, lastAt, sparkline,           // sparkline: input tokens per request
    lastError: { type, message, at } | null,
    todos: [{ content, status }],
    lastTool: { name, outputBytes, status, at } | null,
    children: [childIds],                 // manager→subagent tree edges
  }],
  roots: [sessionId],                     // ids of tree roots, any order
  ticker: [{ sessionId, tool, status, at, outputBytes, exitCode }], // optional
  warnings: ["<what degraded>"],           // optional
}
```

Additive per-row fields are allowed and the UI ignores ones it does not know.
The DeepSeek adapter currently fills `live` (boolean: the harness's own write
lease says a process holds the session — the UI dims a failed row whose run
exited), `description` (the subagent's own descriptor label, shown as the
card's task line), `contextWindow` (the model's real window, so that card's
context gauge and sparkline cliff are measured against it) and `exitCode`
inside `lastTool`.

`warnings` is how an adapter degrades *part* of its data without taking its
whole harness off the board: the registry prefixes each entry with the harness
id and merges it into `/api/state`'s `warnings` array next to the per-harness
failures it records when `snapshot()` throws. Use it for data that is
damaged, refused, or skipped — not for a missing installation, which is the
empty shape.

`generatedAt`, `totals`, `roots`, and live-process counts are derived by the
core, not the adapter — an adapter does not invent its own totals (returning
`roots` is still contract-shaped, and the other adapters do; the registry
recomputes it from the merged board). The `ticker` inside a
snapshot is optional but legitimate: the core prefers a harness-provided
ticker (its per-harness tool history is richer than anything the core could
reconstruct from `lastTool`) and falls back to per-session `lastTool` entries.
`tree edges` are the adapter's job to emit (`children` on the parent); the
registry only namespaces them.

## Conventions the core enforces

- **ID namespacing.** Session ids from every harness share one board, so the
  registry prefixes ids with the harness id: `zcode:sess_abc`,
  `hermes:run_42`. Inside an adapter you never see or produce the prefix —
  you deal in raw ids, `harness/zcode/...` included. The registry maps edge
  ids (`parentId`, `children`) across, but the parent→child edges themselves
  must be built by the adapter.
- **Status vocabulary.** Return one of the statuses above. `done`/`exited`
  mapping is yours to get right for your harness's vocabulary.
- **Fail empty, never fail the poll.** A harness that isn't installed is not
  an error. Missing/decorative tables degrade to empty; a genuinely broken
  telemetry read throws so the registry surfaces it as a board warning.

## Adding a harness

1. `mkdir harness/<id>`, write `index.mjs` implementing the contract above
   against that harness's telemetry (SQLite, JSONL, whatever it leaves on
   disk). Give it its own `config.mjs` for flags and defaults, mirroring
   `harness/zcode/config.mjs` — `windowHours` and any `--<harness>-…` paths.
   The board derives each origin mark (boxed letter, e.g. `Z`, `H`, in a
   per-harness accent color) from the harness id automatically — nothing to
   configure; the contract's optional `letter` field can override the letter.
2. Register it in `harness/index.mjs`.
3. If it has a stop action, implement `stopRun` and set `hasStop: true`.
4. If it keeps history worth charting (anything with timestamps), implement
   `stats()`; otherwise omit it — the harness just won't appear on the stats
   page. `harness/deepseek/stats.mjs` shows the non-SQL shape: it folds every
   session log with the stats accumulator and costs one full decode of the
   history on first call, incremental afterwards.

The frontend needs no other changes: sessions from all harnesses merge into
one time-ordered tree, ticker, Active Now strip and failures panel, and every
row carries the harness origin mark. `harness/hermes/` is a working second
reference — a single-session SQLite (`~/.hermes/state.db`), no stop action —
and `harness/deepseek/` a third, for a harness whose telemetry is neither
SQLite nor small: an append-only Zstandard-framed event log per session. It
splits into `frames.mjs` (the codec), `fold.mjs` (the event vocabulary → board
aggregate, pure) and `log.mjs` (discovery + the incremental cache that reads
each log once), with per-session liveness taken from the kernel's `flock`
table rather than a process scan.

How much board data each harness can supply — and what is inherently vs only
currently missing — is tracked in [docs/harness-data-parity.md](../docs/harness-data-parity.md).

The AGENTS.md review workflow gates every PR on a browser smoke test of the
running board (see the repo root AGENTS.md).
