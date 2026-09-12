# Data sources — every file AgenQ reads

AgenQ is harness-agnostic: any tool that runs AI coding sessions can appear on
the board by mounting a **harness adapter**. ZCode, Hermes and DeepSeek Harness
ship adapters; others plug in the same way — see
[`harness/README.md`](../harness/README.md) for the adapter contract.

The registry namespaces every session id by harness (`zcode:sess_…`,
`hermes:2026…`, `deepseek:session-…`), merges all harnesses into one board, and
routes the lazy per-session endpoints to the harness that owns the id. Every
board item carries a harness origin mark (boxed first letter of the harness id
in a per-harness accent color — a blue Z, an orange H, a violet D; unknown
harnesses get a stable hue hashed from their id), so a growing set of harnesses
stays readable without ever splitting the board.

Adapters can only surface what a harness's telemetry records — and they record
different things. [harness-data-parity.md](harness-data-parity.md) is the
honest ledger: what each board slot maps to per harness, what is inherently
unknowable, what is recoverable with adapter work, and what AgenQ deliberately
does not read.

## What is read

| Source | Used for |
|---|---|
| `~/.zcode/cli/db/db.sqlite` (`model_usage`, `tool_usage`, `todo`, `session`) | token heartbeats, sparklines, tool ticker, todo lists, session titles (via the ZCode harness adapter) |
| `~/.zcode/cli/db/db.sqlite` (`part`, `model_usage`) — read lazily per click | the Active Now detail panel: tool arguments and thinking text (`part`), turn timings and the token breakdown (`model_usage`) |
| `~/.zcode/cli/db/db.sqlite` (`message`, `part`) — read lazily per poll | the live conversation tab: message roles and sequence (`message`), text/reasoning/tool parts (`part`) |
| `~/.zcode/cli/agents/<parent>/agent_*/metadata.json` | the manager→subagent tree, role profiles, status, failures (via the ZCode harness adapter) |
| `~/.hermes/state.db` (`sessions`, `session_model_usage`, `messages`) — via the Hermes harness adapter | session titles, model + reasoning effort, token totals, per-task heartbeats/sparklines, tool trail, todo lists, delegate-subagent tree (`_delegate_from` markers) |
| `~/.hermes/state.db` (`messages`, `session_model_usage`) — read lazily per click/poll | the Hermes detail panel and live conversation: tool call arguments + results, thinking text, per-task token breakdowns |
| `~/.dsh/sessions/<project>/<session-id>/session[.vN].jsonl.zstd` — via the DeepSeek Harness adapter | session titles, model + reasoning effort, the model's real context window, per-request token sparklines and totals, todos, the tool trail, the manager→subagent tree (`parentSession` in each subagent's header), failed turn ends and model retries |
| the same DSH event logs — one session at a time, lazily per click/poll | the DeepSeek detail panel (current tool with arguments, latest thinking, per-call usage rows, errors) and the live conversation (user messages, assistant text, collapsed thinking, tool chips with their final status) |
| `~/.dsh/storages/workspace.json` | the archived-session filter — a session its owner put away stays off the board |
| `/proc/locks` matched against each `session.lock` inode | per-session liveness for DeepSeek: DSH holds a kernel `flock` while a session is attached to a live process, so a card can say *running/sleep* versus *done/exited* instead of guessing from recency |

## Notes

`session_task_link` in the ZCode DB belongs to ZCode's (currently unused)
workflow framework — the real parent/child links live in the agents-dir
metadata files. Hermes delegate subagents are read from
`sessions.parent_session_id` filtered to `_delegate_from` markers in
`model_config` (branch/reset/compression children of the same table are
excluded by their own markers). DSH sessions are found by walking
`~/.dsh/sessions/`; each log is written as a stream of small independent
Zstandard frames, so the adapter decodes only the frames appended since the
previous poll and skips logs untouched inside the window entirely — a session
outside the window contributes nothing but its header, and only when a kept
session names it as its parent. The adapter reads generations v0–v3 and skips a
log whose header names a newer format (with a board warning) rather than
folding it under the wrong vocabulary; if a committed frame is damaged, it
drops that frame, keeps every event after it and reports the damage in
`warnings` — one bad frame never silences the rest of a session.

Every harness keeps its own history; the `--window-hours` window (default 12h)
keeps the board focused on what happened recently. Long-lived history is a
non-goal for v1.
