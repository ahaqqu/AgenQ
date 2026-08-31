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

Statuses were taken from what the schemas offer at the time of writing
(hermes `~/.hermes/state.db`, zcode `~/.zcode/cli/db/db.sqlite`).

## Board slots

| Board slot | ZCode | Hermes | Verdict |
| --- | --- | --- | --- |
| Session identity + title | `session.title`, `slug` | `sessions.title`, `display_name` | **parity** |
| Manager→subagent tree | authoritative parent/child from the agents dir + `session.parent_id` | `parent_session_id` + `model_config` markers (`_delegate_from` → subagent) | **inherent difference**: zcode's roles come from profile metadata; hermes's branch/reset semantics have no zcode analog. Mapped as `role` vs `null` by design |
| Model + thinking level | `model_usage.model_id` + `variant` (latest request) | `sessions.model` + `model_config.reasoning_config` | **parity** |
| Project / directory | `session.directory` (cwd of live proc) | `sessions.cwd` | **parity** |
| Request count | `COUNT(model_usage)` | `sessions.api_call_count` | **parity** |
| Token totals (in/out/cache) | summed per request rows | cumulative on `sessions` + per-task `session_model_usage` | **parity** |
| Sparkline (tokens/request) | exact per-request `model_usage.input_tokens` | per-task averages (plateau points from `session_model_usage`) | **inherent**: hermes stores per-task cumulative sums, not per-request rows. The plateau is the honest approximation |
| Context used (maxContext) | exact: `MAX(model_usage.input_tokens)` per request | per-call **average** `input/api_call_count` per task | **inherent**: no per-request peak in hermes; the average under-measures a spiky request |
| Status running/sleep | `model_usage` recency + live `/proc` scan | `session_model_usage.last_seen` / `last_activity_at` recency | **parity** (recency); differs in liveness, next row |
| Liveness / exited | per-directory `/proc` scan of `zcode-cli` processes | not claimed — sessions live in shared gateway/daemon processes | **inherent**: no safe per-session kill or pid mapping. `live` stays `null`; no exit dimming, no stop button |
| Stop action | project-level SIGTERM via `/proc` | none — `hasStop: false` | **inherent** (deliberate: no safe surface) |
| Done vs failed | per-request `status` / `error_type` in `model_usage` | `ended_at` + `handoff_error` / `compression_failure_error` | **inherent difference in granularity**, mapped to the same vocabulary |
| Todos | `todo` table (per session, positioned) | `messages` rows `tool_name='todo'` (latest list per session) | **parity** |
| Errors shown on card | last `model_usage.error_type/message` | only handoff/compression failures | **inherent** — hermes has no per-API-call error column |
| Tool ticker / last tool | `tool_usage` table: name, status, exit code, bytes, timing | parsed from transcript `messages` role='tool' rows via `toolResult()` | **parity on the ticker**; zcode's is richer (explicit columns) |
| Conversation feed (💬) | message×part transcript (exact, ordered by sequence) | `messages` table ordered by row id, tool args recovered via `tool_call_id` pairing | **parity**, both cursor-resumable |
| Detail panel: current tool + args | from `part` tool rows (args inline) | newest tool result + args recovered via `tool_call_id` probe | **parity** |
| Detail panel: thinking | newest `reasoning` part row | `reasoning`/`reasoning_content` columns | **parity** |
| Detail panel: diff stats | `summary_additions/deletions/files` | not tracked | **inherent** |

## Recoverable with adapter work only (no schema change)

The data already fits the existing snapshot contract; the adapter just
doesn't read it yet. A display change may accompany it, but no new field
crosses the registry boundary.

| What | Harness | Where it sits | How |
| --- | --- | --- | --- |
| Gateway/liveness info | hermes | `gateway_heartbeats` (backend_id, pid, profile, host, last_heartbeat) | could mark a hermes board "gateway alive" — but per-**session** liveness (what the board's `live` needs) is still not derivable, since all sessions share pid(s). Document-only for now |
| End reason | hermes | `sessions.end_reason`, `end_state`-adjacent columns, `rewind_count` | map `ended_at`+`end_reason` into a richer `done` (e.g. tooltip "completed · user exit · 3 rewinds"); pure adapter mapping |
| Session pinning/read state | hermes | `pinned`, `last_read_at`, `hidden` | mostly out of scope for a monitor; listed for completeness |

## Recoverable with one additive snapshot field

Adapter-side work plus a single optional contract field (additive, optional —
harnesses that can't supply it leave it unset and the UI hides it). Each is
small, but it *is* a contract change, so it lands here for an explicit yes/no.

| What | Harness | Where it sits | How |
| --- | --- | --- | --- |
| Cost per session ($) | both | zcode: not exposed in `model_usage` (only provider totals); hermes: `sessions.estimated_cost_usd`, `actual_cost_usd`, `billing_provider` | new optional `costUsd` snapshot field, rendered in the card stats when present. **zcode has no cost column today** — would need `raw_usage_json` pricing offline, so hermes-only first |
| Thinking tokens | both | zcode: `model_usage.reasoning_tokens` (already in detail panel); hermes: `session_model_usage.reasoning_tokens` (already summed in detail) | new optional `reasoningTokens` snapshot field, **surfaced on the card stats line** (`th 1.2k`) |
| Git context | both | zcode: `session.path`/project linkage only; hermes: `git_branch`, `git_repo_root`, `git_metadata_generation` | new optional `gitBranch`/`gitRepo` snapshot fields, card tooltip. Hermes-only first; zcode gets it when its telemetry records a branch |
| Activity description | hermes | `sessions.last_activity_description` (human string of what the session last did) | new optional `lastActivity` snapshot field; the Active Now chip uses it only when `lastTool`/todos are empty |

## Recoverable with a contract change

Bigger shapes; each needs a design decision before any adapter starts.

| What | Why it needs contract work | Simple approach sketch |
| --- | --- | --- |
| Exact per-request rows for hermes | hermes has no per-request usage table; the closest is diffing `session_model_usage` between polls | adapter keeps a tiny in-memory "last seen per task" cache and emits a delta series. Statefulness breaks the "stateless per-poll adapter" property — needs a decision |
| Per-request errors for hermes | transcript rows lack an error marker; failures are only session-level columns | parse `finish_reason` / `tool` results for error signatures; heuristic, flagged as best-effort in the doc |
| Workflow runs (zcode-only tables) | `workflow_run/workflow_activity` are runs of **scripts**, not agent sessions; a new object type on the board | defer until a real use case; would need a new top-level `workflows` section in the snapshot |
| Session targets/objectives | `session_target` (objective, budget, tokens_used) is not per-agent | could become a board-level "objectives" strip; needs UI design |

## Deliberately not read

Telemetry that exists but AgenQ will not touch, to keep the board read-only
and the adapter surface small. Listed so the decision is on the record, not
accidental.

- **hermes `messages_fts*`** (full-text index) — a search-quality feature, not
  board data; reading it couples AgenQ to hermes's index build.
- **zcode `permission`, `local_setting`, `input_history`, `session_input`** —
  local user state and approvals; not mission-control data.
- **Both: anything that would require writing to the harness DB** — AgenQ is
  read-only (`mode=ro`, fresh connection per poll) by architecture.
