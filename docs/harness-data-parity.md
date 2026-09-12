# Harness data parity — what each harness can and cannot tell AgenQ

AgenQ renders one board from many harnesses, so the same slot on the board
must be fillable by any adapter. They never fill it equally: each harness
leaves different telemetry on disk, and the adapters differ in how much of it
they already surface. This document is the honest ledger of those differences.

Two kinds of difference live here:

- **Inherent** — the harness's telemetry genuinely does not record it. No
  adapter work can recover it; the board cell stays empty for that harness.
- **Recoverable** — the harness records it, but the adapter does not read it
  yet. Split into two tiers below: work that stays inside the current
  contract, and work that adds an optional contract field. Every one of
  these has a "How" sketch; they are candidates, not commitments — each
  needs a review decision before implementation.

The board never renders harness-specific extras: a field the schema doesn't
define is dropped (or listed as recoverable below). That keeps every harness
equal by construction — parity advances by agreeing on a contract change, not
by one harness quietly rendering more.

Statuses were taken from what the sources offer at the time of writing
(zcode `~/.zcode/cli/db/db.sqlite`, hermes `~/.hermes/state.db`, DeepSeek
Harness `~/.dsh/sessions/**/session[.vN].jsonl.zstd` + `/proc/locks`).

## Board slots

| Board slot | ZCode | Hermes | DeepSeek Harness | Verdict |
| --- | --- | --- | --- | --- |
| Session identity + title | `session.title`, `slug` | `sessions.title`, `display_name` | `session/title` events in the session log | **parity** |
| Manager→subagent tree | authoritative parent/child from the agents dir + `session.parent_id` | `parent_session_id` + `model_config` markers (`_delegate_from` → subagent) | each subagent log's own header (`parentSession`, `origin: "subagent"`); the child's `subagent/descriptor` carries mode/label | **inherent difference**: zcode's roles come from profile metadata, DSH's label becomes the task description and `role` stays the generic `subagent`, hermes's branch/reset semantics have no analog. Mapped by design, never faked |
| Model + thinking level | `model_usage.model_id` + `variant` (latest request) | `sessions.model` + `model_config.reasoning_config` | `request/header.config` of the latest request (`provider`/`model`/`reasoningEffort`) | **parity** |
| Project / directory | `session.directory` (cwd of live proc) | `sessions.cwd` | session header `cwd` | **parity** |
| Request count | `COUNT(model_usage)` | `sessions.api_call_count` | count of `assistant/message` events | **parity** |
| Token totals (in/out/cache) | summed per request row | cumulative on `sessions` + per-task rows | per-message `usage` summed | **parity of value, not of naming**: DSH's `inputTokens` excludes cache reads, so the adapter adds `cacheReadTokens` back to keep the board's "input includes the cached part" semantics (cache hit % stays comparable) |
| Sparkline (tokens/request) | exact per-request `model_usage.input_tokens` | per-task averages (plateau points from `session_model_usage`) | exact per-request `assistant/message.usage` (prompt tokens incl. cache read) | **parity with zcode**; **inherent** for hermes, which stores per-task cumulative sums |
| Context used (maxContext) | exact: `MAX(model_usage.input_tokens)` per request | per-call **average** `input/api_call_count` per task | exact: biggest single-request prompt | **parity with zcode**; hermes's average under-measures a spiky request |
| Status running/sleep | `model_usage` recency + live `/proc` scan | `session_model_usage.last_seen` / `last_activity_at` recency | event recency, refined by the session's own write lease | **parity** (recency); differs in liveness, next row |
| Liveness / exited | per-directory `/proc` scan of `zcode-cli` processes | not claimed — sessions live in shared gateway/daemon processes | `/proc/locks` matched against each session's `session.lock` inode: DSH holds a kernel `flock` for the life of its write handle and the kernel drops it on process death | **parity with zcode, exact per session**: the harness's own lease is read, not inferred. Still no stop surface (next row) |
| Live duration (⏱ on cards, `live …` in run headers) | `MIN(started_at)` → `MAX(completed_at)` across request rows (+ agents-dir timestamps) | `sessions.started_at` → `last_activity_at` | header `createdAt` → last event time | **parity** — all three fill `firstAt`/`lastAt`; the span is computed client-side |
| Stop action | project-level SIGTERM via `/proc` | none — `hasStop: false` | none — `hasStop: false` (every session lives inside one shared `dsh` process) | **inherent** (deliberate: no safe surface) |
| Done vs failed | per-request `status` / `error_type` in `model_usage` | `ended_at` + `handoff_error` / `compression_failure_error` | `turn/end` reason (`completed`/`aborted`/`error`/`interrupted`), plus `llm/retry` failures; an error older than the next successful call or clean turn is dropped as recovered | **inherent difference in granularity**, mapped to the same vocabulary |
| Todos | `todo` table (per session, positioned) | `messages` rows `tool_name='todo'` (latest list per session) | `todo/write` events (latest list per session) | **parity** |
| Errors shown on card | last `model_usage.error_type/message` | only handoff/compression failures | last failed `turn/end` or `llm/retry` failure (rate limits, auth, transport, bad requests) | **inherent** in source, **parity** in the slot: each harness surfaces its own failure vocabulary |
| Tool ticker / last tool | `tool_usage` table: name, status, exit code, bytes, timing | parsed from transcript `messages` role='tool' rows via `toolResult()` | `tool/call` + `tool/result` events: status, output bytes, and the bash exit code when the result carries its trailing `[exit code: N]` marker (a clean exit carries none) | **parity**; zcode's table is the only one that reports a clean exit explicitly |
| Conversation feed (💬) | message×part transcript (exact, ordered by sequence) | `messages` table ordered by row id, tool args recovered via `tool_call_id` pairing | normalized log records, cursor = the log's own event `seq` | **parity**, both cursor-resumable. DSH tool chips are emitted from the result (final status) rather than the call, because the append-only log has no row to update once a call starts |
| Detail panel: current tool + args | from `part` tool rows (args inline) | newest tool result + args recovered via `tool_call_id` probe | newest `tool/call` with its arguments and result status | **parity** |
| Detail panel: thinking | newest `reasoning` part row | `reasoning`/`reasoning_content` columns | `reasoning` content block of the newest assistant message | **parity** |
| Detail panel: diff stats | `summary_additions/deletions/files` | not tracked | not tracked | **inherent** |

## Recoverable with adapter work only (no schema change)

The data already fits the existing snapshot contract; the adapter just
doesn't read it yet. A display change may accompany it, but no new field
crosses the registry boundary.

| What | Harness | Where it sits | How |
| --- | --- | --- | --- |
| Gateway/liveness info | hermes | `gateway_heartbeats` (backend_id, pid, profile, host, last_heartbeat) | could mark a hermes board "gateway alive" — but per-**session** liveness (what the board's `live` needs) is still not derivable, since all sessions share pid(s). Document-only for now |
| End reason | hermes | `sessions.end_reason`, `end_state`-adjacent columns, `rewind_count` | map `ended_at`+`end_reason` into a richer `done` (e.g. tooltip "completed · user exit · 3 rewinds"); pure adapter mapping |
| Session pinning/read state | hermes | `pinned`, `last_read_at`, `hidden` | mostly out of scope for a monitor; listed for completeness |
| Per-call timing | deepseek | `storages/session_projcache/sessions/<id>.json` (`sessionStats`: `llmMs`, `toolMs`, `ttftMs`, `decodeMs`) and each `assistant/message`'s stream chunks | the detail panel's turn rows already carry per-call token counts; time-to-first-token would need the projection store (aggregate) or the stream chunk timeline (per call). Adapter-side only |
| Compaction markers | deepseek | `compaction/start`, `compaction/end`, `compaction/summary` events | a "compacted" row in the ticker/feed would explain a sudden context drop; pure adapter mapping |

## Recoverable with one additive snapshot field

Adapter-side work plus a single optional contract field (additive, optional —
harnesses that can't supply it leave it unset and the UI hides it). Each is
small, but it *is* a contract change, so it lands here for an explicit yes/no.

| What | Harness | Where it sits | How |
| --- | --- | --- | --- |
| Cost per session ($) | hermes today, others by pricing | zcode: not exposed in `model_usage` (only provider totals); hermes: `sessions.estimated_cost_usd`, `actual_cost_usd`, `billing_provider`; deepseek: no cost recorded at all | new optional `costUsd` snapshot field, rendered in the card stats when present. **zcode and DSH have no cost column today**, so hermes-only first |
| Thinking tokens | zcode + deepseek | zcode: `model_usage.reasoning_tokens` (already in detail panel); deepseek: `assistant/message.usage.reasoningTokens` (already in detail panel); hermes: `session_model_usage.reasoning_tokens` | new optional `reasoningTokens` snapshot field, **surfaced on the card stats line** (`th 1.2k`) |
| Git context | zcode + hermes | zcode: `session.path`/project linkage only; hermes: `git_branch`, `git_repo_root`, `git_metadata_generation`; deepseek: nothing | new optional `gitBranch`/`gitRepo` snapshot fields, card tooltip. Hermes-only first; zcode gets it when its telemetry records a branch |
| Activity description | hermes | `sessions.last_activity_description` (human string of what the session last did) | new optional `lastActivity` snapshot field; the Active Now chip uses it only when `lastTool`/todos are empty |
| Goal / objective | deepseek | `goal/change` events and the projection store's `goal` row (objective, phase, rounds) | new optional `goal` snapshot field rendered in the run header; DSH is the only harness with a first-class goal object |

## Recoverable with a contract change

Bigger shapes; each needs a design decision before any adapter starts.

| What | Why it needs contract work | Simple approach sketch |
| --- | --- | --- |
| Exact per-request rows for hermes | hermes has no per-request usage table; the closest is diffing `session_model_usage` between polls | adapter keeps a tiny in-memory "last seen per task" cache and emits a delta series. Statefulness breaks the "stateless per-poll adapter" property — needs a decision (the DSH adapter already keeps an incremental read cursor, so the pattern has precedent) |
| Per-request errors for hermes | transcript rows lack an error marker; failures are only session-level columns | parse `finish_reason` / `tool` results for error signatures; heuristic, flagged as best-effort in the doc |
| Workflow runs (zcode-only tables) | `workflow_run/workflow_activity` are runs of **scripts**, not agent sessions; a new object type on the board | defer until a real use case; would need a new top-level `workflows` section in the snapshot |
| Subagent team/task events (deepseek) | `team/task`, `team/member`, `team/message/*` describe multi-agent coordination DSH is starting to record; they are not sessions | defer until a real DSH run uses them; a "team" strip would need its own snapshot section |
| Session targets/objectives | `session_target` (objective, budget, tokens_used) is not per-agent | could become a board-level "objectives" strip; needs UI design |

## Deliberately not read

Telemetry that exists but AgenQ will not touch, to keep the board read-only
and the adapter surface small. Listed so the decision is on the record, not
accidental.

- **hermes `messages_fts*`** (full-text index) — a search-quality feature, not
  board data; reading it couples AgenQ to hermes's index build.
- **zcode `permission`, `local_setting`, `input_history`, `session_input`** —
  local user state and approvals; not mission-control data.
- **deepseek `settings.yaml`, `.credentials.yaml`, `.env`, `profiles/`** —
  user configuration and secrets, never board data.
- **deepseek `storages/session_projcache*.json`** — a projection cache the
  harness rebuilds from the same event logs AgenQ already reads; the logs are
  the source of truth, and reading both would double-count. The only thing it
  holds that the logs don't is aggregate timing (listed as recoverable above).
- **All three: anything that would require writing to the harness's telemetry** —
  AgenQ is read-only (`mode=ro`, fresh connection per poll, read-only file
  reads) by architecture.
