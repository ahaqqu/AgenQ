# AgenQ API reference

The board at http://localhost:8765 (or whatever `--port` you chose) is one
Bun process serving two things: the JSON API under `/api/*`, and the static
frontend files in `public/` — everything else is a static file, served with
`cache-control: no-cache`, 404 if absent.

Two pages: the live board at `/` and the long-history **stats dashboard** at
`/stats.html` (linked from the board header), which reads `/api/stats`.

All timestamps are epoch milliseconds. Session ids are namespaced as
`<harnessId>:<rawId>` (`zcode:a1b2c3`), which is how two harnesses can never
collide; the harness id is also carried on every object that references one.

Except for `/api/stop`, every endpoint is read-only: adapters open their
telemetry with `mode=ro` and only ever list and read.

## GET /api/state

The one endpoint the board polls (every 1.5s): the merged snapshot of every
mounted harness — sessions, tree, totals, ticker, liveness.

```json
{
  "generatedAt": 1789238949661,
  "windowHours": 12,
  "harnesses": [
    { "id": "zcode", "label": "ZCode", "emoji": null, "hasStop": true, "liveProcs": {"/home/me/proj": 2} }
  ],
  "totals": { "inputTokens": 123456, "outputTokens": 7890, "requests": 42 },
  "liveProcs": { "/home/me/proj": 2 },
  "warnings": [],
  "sessions": [ { "...": "see below" } ],
  "roots": ["zcode:a1b2c3"],
  "ticker": [
    { "sessionId": "zcode:a1b2c3", "harness": "zcode", "tool": "Bash",
      "outputBytes": 4096, "status": "success", "exitCode": 0, "at": 1789238949661 }
  ]
}
```

Each entry of `sessions` is one session object:

| Field | Meaning |
|---|---|
| `id` | Namespaced session id; the key every other endpoint takes. |
| `harness` | Harness id (`zcode`, `hermes`, `deepseek`). |
| `title`, `project`, `directory` | Display title, project name (last path segment) and working directory. |
| `parentId`, `parentSessionId`, `children` | Tree edges. `parentId` and `children` are namespaced like `id`; `parentSessionId` is the raw parent id recorded in the subagent's link metadata (zcode), left unnamespaced. `roots` at the top level holds the sessions whose parent is missing (or another harness's, or windowed out). |
| `role` | Subagent profile name for dispatched subagents (from link metadata), `null` otherwise — the UI renders a manager session as "main" client-side. |
| `model`, `thinking` | Model id and thinking level of the session's most recent request. |
| `status` | `running`, `sleep`, `done`, `failed`, `exited`, `idle`. |
| `live` | `true`/`false` when liveness was observed from the OS process table, `null` when the harness has no process signal. |
| `requests`, `inputTokens`, `outputTokens`, `cacheRead`, `cacheCreate`, `maxContext` | Usage totals across the session's requests. |
| `firstAt`, `lastAt` | First and latest activity, epoch ms — the ⏱ duration and the active/idle decision both derive from these. |
| `sparkline` | Input tokens per request, oldest first, capped at the last 120 points. |
| `lastError` | `{ type, message, at }` for the most recent failure, or `null` — an error older than the last successful request is cleared (the session recovered). |
| `todos` | `[{ content, status }]` with statuses `pending` / `in_progress` / `done`. |
| `lastTool` | `{ name, outputBytes, status, at }` for the session's most recent tool call. |
| `linkStatus`, `description` | Subagent link metadata from the agents dir (only on sessions that have one). |

**Failure behavior:** if assembling a snapshot throws, the endpoint returns
the previous good snapshot with a `pollError` string added — HTTP 200 when a
previous snapshot exists, 503 on the very first poll. A broken or uninstalled
harness never blanks the board: its adapter degrades to an empty session list
and a `warnings` entry instead.

## GET /api/stats

The long-history aggregation behind `/stats.html` — the board's
`--window-hours` window does not apply here. One call per harness returns
**all** history that harness's telemetry still holds: timestamped usage
buckets, whole-session rows for agent/subagent counts and durations, the
coverage interval AgenQ actually observed, and the **grain** at which that
harness can attribute usage.

```json
{
  "generatedAt": 1789238949661,
  "harnesses": [
    {
      "id": "zcode", "label": "ZCode", "emoji": "🦓",
      "coverage": { "from": 1787909366017, "to": 1789238178616 },
      "grain": "hour",
      "notes": ["Σ in is ZCode's own input_tokens — cache reads and cache creation are recorded separately"],
      "usage": [
        { "at": 1789236000000, "project": "AgenQ", "provider": "account:zai-start-plan",
          "model": "GLM-5.3-Flash", "requests": 812, "inputTokens": 40212345,
          "outputTokens": 512345, "cacheRead": 30123456, "cacheCreate": 1234567 }
      ],
      "sessions": [
        { "firstAt": 1789238178616, "lastAt": 1789238940200, "project": "AgenQ", "isSubagent": false }
      ]
    }
  ],
  "warnings": []
}
```

- `usage[].at` is the **start of the local bucket** the row belongs to, as
  epoch ms — the beginning of a local hour (`grain: "hour"`) or a local
  midnight (`grain: "day"`). The client filters ranges on it directly, so a
  "last 24 hours" view needs no server round-trip per range.
- `grain` is the finest attribution that harness's telemetry supports, and it
  is a property of the data, not a display choice: zcode and DeepSeek Harness
  record a timestamp per request (hour), hermes keeps only cumulative
  per-(session, model, provider) totals with a first/last-seen pair (day).
  A harness whose grain is coarser than the requested range contributes no
  usage rows to it — spreading one day's tokens across 24 hourly bars would
  invent detail the telemetry does not have. Its `sessions` still count.
- `usage` rows are grouped by bucket × project × provider × model. Grouping
  across harnesses (`at` collides across harnesses on the same bucket) is the
  client's job; that is what makes a provider/model rollup meaningful.
- `sessions` are deliberately *not* bucket-attributed — a session can span
  days, so agent/subagent counts and durations are counted whole in whichever
  range its span intersects. `project` is `null` when the working directory
  is unknown.
- `coverage` is the observed first/last timestamp of that harness's data,
  `null` when nothing is on disk. The page renders its retention banner from
  it, and `notes` carries the per-harness caveats (cache-token semantics,
  excluded archived sessions, hermes's day attribution) verbatim.
- A harness whose adapter has no long-history view (`stats()` is optional in
  the adapter contract) simply does not appear in `harnesses`.

**Cost:** the first `/api/stats` call after server start may decode whole
telemetry histories (on a machine with months of DSH logs: a few seconds).
Adapters cache what they decoded, so later calls are incremental and the page
filters ranges client-side without re-fetching; the refresh button re-reads.
A harness that fails degrades to a `warnings` entry instead of failing the
whole response.

## GET /api/session/:id/detail

Lazy per-session detail for the Active Now expansion — only fetched when the
UI expands a row. `:id` is a namespaced session id, URL-encoded.

```json
{
  "sessionId": "zcode:a1b2c3",
  "fetchedAt": 1789238949661,
  "title": "Fix the login bug",
  "directory": "/home/me/proj",
  "diff": { "additions": 120, "deletions": 30, "files": 4 },
  "currentTool": { "name": "Bash", "status": "running", "input": "bun test …", "at": 1789238940000 },
  "thinking": { "text": "…tail of the latest reasoning…", "at": 1789238930000 },
  "turns": [ { "model_id": "…", "duration_ms": 1200, "input_tokens": 5000, "...": "…" } ],
  "tokens": { "requests": 10, "input": 50000, "output": 4000, "reasoning": 800,
              "cacheRead": 40000, "cacheCreate": 2000, "maxContext": 90000 },
  "modelWindow": 200000,
  "errors": [ { "type": "rate_limit", "message": "…", "at": 1789238000000 } ],
  "todos": [ { "content": "write tests", "status": "done" } ]
}
```

The shape is a contract every harness fills as far as its telemetry allows —
hermes reports no per-turn rows (`turns: []`), DeepSeek Harness keeps no diff
summary (`diff: null`), and fields a harness cannot observe are `null`/empty
rather than absent. `modelWindow` is the context-window estimate used by the
fill gauge (the model's real window when recorded, 200k fallback otherwise).

Returns 404 only when the harness is unknown or offers no detail; an
unknown session under a mounted harness returns the empty shape with 200
(adapters fill in whatever that session's telemetry allows).

## GET /api/session/:id/messages?after=:cursor

The live-conversation feed, cursor-resumable. The client polls this with the
`cursor` returned by the previous response and only rows past that cursor
come back, so a poll moves bytes proportional to what was said since, not to
the size of the session.

Without `after` (first load): the newest 400 conversation rows, oldest-first.
With `after`: up to 400 rows after the cursor. The cursor is an opaque tagged
string — `<prefix>:<numbers>`, where the numbers are one position per
harness (e.g. `m:15` on hermes, `z:42:7` on zcode) — treat it as a token,
echo it back verbatim. A missing or unusable cursor is read as a first
load, so a tab holding a stale cursor recovers on its next poll.

```json
{
  "sessionId": "zcode:a1b2c3",
  "title": "Fix the login bug",
  "directory": "/home/me/proj",
  "cursor": "z:42:7",
  "items": [
    { "kind": "text",  "role": "user",      "text": "…", "at": 1789238940000 },
    { "kind": "think", "role": "assistant", "text": "…tail of thinking…", "at": 1789238940100 },
    { "kind": "tool",  "role": "assistant", "tool": "Bash", "status": "success",
      "input": "bun test", "at": 1789238940200 }
  ]
}
```

`kind` is `text`, `think` or `tool`; scaffolding records (step-start,
compaction, …) are filtered out server-side. Long text is capped per item
(12k for text, 6k for thinking, 2k for tool input), keeping the *end* of the
text — the live half. Returns 404 for an unknown or unnamespaced harness id;
an unknown session under a mounted harness returns an empty feed with 200.

## POST /api/stop

The one write: stop a run. Takes either a namespaced `sessionId` or a
`directory`; targets are resolved against the last `/api/state` snapshot and
rejected unless AgenQ actually saw that directory in telemetry — the stop
action must never become an arbitrary process-kill surface. Stopping is
project-level: it is the real granularity of the mechanism (today only zcode
exposes it — it SIGTERMs the project's `zcode-cli` processes).

Request: `Content-Type: application/json`, body `{"sessionId": "zcode:a1b2c3"}`
or `{"directory": "/home/me/proj"}`.

```json
{ "harnessId": "zcode", "killed": [12345, 12346], "directory": "/home/me/proj", "project": "proj" }
```

Guardrails and error responses:

- 403 for cross-origin or non-JSON requests (Origin + Content-Type check).
- 400 for an unknown session/directory, a harness whose `hasStop` is
  false — hermes and DeepSeek Harness sessions live inside shared gateway
  processes, so they never offer a stop — or a run that already exited.
- 400 with the adapter's own `error` when the native stop fails.
- 500 only for an unexpected exception.
