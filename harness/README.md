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

`generatedAt`, `totals`, and live-process counts are derived by the core, not
the adapter — an adapter does not invent its own totals. The `ticker` inside a
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

The frontend needs no other changes: sessions from all harnesses merge into
one time-ordered tree, ticker, Active Now strip and failures panel, and every
row carries the harness origin mark. `harness/hermes/` is a working second
reference — a single-session SQLite (`~/.hermes/state.db`), no stop action.

How much board data each harness can supply — and what is inherently vs only
currently missing — is tracked in [docs/harness-data-parity.md](../docs/harness-data-parity.md).

The AGENTS.md review workflow gates every PR on a browser smoke test of the
running board (see the repo root AGENTS.md).
