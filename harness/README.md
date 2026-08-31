# Harness adapters

AgenQ is harness-agnostic: any tool that runs AI coding sessions and leaves
telemetry on disk can appear on the board. A **harness adapter** teaches the
monitor how one such tool — ZCode and Hermes today — exposes:

1. a **state snapshot**: every session, its tokens, status, todos, errors and
   its place in the manager→subagent tree (poll, ~1.5s cadence),
2. a **conversation feed**: the messages of one session, cursor-resumable
   (poll, ~2s cadence, only used by the live conversation tab),
3. a **stop action**: what "stop this run" means and whether it exists.

## The contract

An adapter is one directory exporting a single default object from
`index.mjs`:

```js
export default {
  id: "zcode",                    // unique, stable; becomes the session-id prefix
  label: "ZCode",                 // shown in the UI origin badge
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
};
```

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
}
```

`generatedAt`, `totals`, `ticker`, and live-process counts are derived by the
core, not the adapter — an adapter does not invent its own totals.

## Conventions the core enforces

- **ID namespacing.** Session ids from every harness share one board, so the
  registry prefixes ids with the harness id: `zcode:sess_abc`,
  `hermes:run_42`. Inside an adapter you never see or produce the prefix —
  you deal in raw ids, `harness/zcode/...` included. The registry maps edges
  (`parentId`, tree lookup) for you.
- **Status vocabulary.** Return one of the statuses above. `done`/`exited`
  mapping is yours to get right for your harness's vocabulary.
- **Fail empty, never fail the poll.** A harness that isn't installed is not
  an error.

## Adding a harness

1. `mkdir harness/<id>`, write `index.mjs` implementing the contract above
   against that harness's telemetry (SQLite, JSONL, whatever it leaves on
   disk). Give it its own `config.mjs` for flags and defaults, mirroring
   `harness/zcode/config.mjs` — `windowHours` and any `--<harness>-…` paths.
2. Register it in `harness/index.mjs`.
3. If it has a stop action, implement `stopRun` and set `hasStop: true`.

The frontend needs no changes: origin badges render automatically once two
harnesses are mounted. `harness/hermes/` is a working second reference — a
single-session SQLite (`~/.hermes/state.db`), no stop action.

The AGENTS.md review workflow gates every PR on a browser smoke test of the
running board (see the repo root AGENTS.md).