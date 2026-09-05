# AgenQ

Live mission-control monitor for AI coding-agent harnesses — ZCode and [Hermes](https://github.com/ahaqqu) today, any telemetry-leaving tool next — because watching a manager run should be less boring than waiting for it. 🚀

AgenQ reads (read-only) the telemetry harnesses already write on disk and turns it into a live board:

![AgenQ mission control — sessions from ZCode and Hermes merged into one board ordered by recency, every row carrying its color-coded harness letter mark (blue Z = zcode, orange H = hermes), a recent-activity feed (tool calls, errors, session starts) with a category filter capped at 20 rows — full-width when no failures — failure alerts, and token-burn sparklines against the 200k context cliff; main-session and subagent cards each carry a 💬 button into the live conversation](docs/screenshot.png)

- **One merged board** — sessions from every mounted harness mix in the same tree, ticker, Active Now strip and failure panel, ordered by project and then recency; only the small boxed-letter mark (a blue Z for zcode, an orange H for hermes — each harness has its own accent color, hover for the name) says which harness runs an agent — nothing else is separated
- **Agent tree** — the manager session with every dispatched subagent under it (role, model, live status)
- **Token-burn sparklines** — input tokens per request per agent, with a dashed marker at the 200K context cliff (the cliff that cost 36M tokens in the run that motivated this tool — see ahaqqu/agentic-project-template#94)
- **Live todos** — each agent's todo list, animated as it progresses
- **Active Now strip** — every session with a heartbeat in the last 5m; click a row to expand it into a live detail panel: the current tool call with its actual arguments, the latest thinking excerpt, todo progress, diff summary, context-window fill, turn timings (duration, time-to-first-token, retries), a full token breakdown (cache read/write, reasoning) and recent errors
- **Live conversation** — the 💬 button opens the session's full conversation in a new tab (user prompts, assistant replies, collapsed thinking, tool calls with status), streaming new messages as they happen; the header carries the harness mark too. The button lives on Active Now rows, main-session cards and every subagent card

![AgenQ live conversation — a subagent's session, opened from its card's 💬 button and streaming](docs/screenshot-conversation.png)
- **Recent activity** — tool calls, session errors and session starts in one feed (capped at 20 rows), filterable by category; when the failure panel is empty the feed takes the full row width and each row shows more: project, status word, output size and exact timestamps (the failed panel side stays empty in that mode)
- **Failure alerts** — rate limits and crashed agents turn red the moment they happen; a hollow dot means the process already exited

## Run it

**Linux — the easy way:** run `install.sh` once. It installs [Bun](https://bun.sh) if it's missing, puts the `agenq` command in `~/.local/bin`, and starts the monitor:

```bash
git clone https://github.com/ahaqqu/AgenQ && cd AgenQ
./install.sh            # → open http://localhost:8787 in your browser
```

Or skip the clone entirely:

```bash
curl -fsSL https://raw.githubusercontent.com/ahaqqu/AgenQ/main/install.sh | bash
```

The installer clones the repo to `~/.local/share/agenq` (re-running it updates that clone), and any flags you pass go straight to the server: `./install.sh --port 8791 --window-hours 48`. Set `AGENQ_SKIP_RUN=1` to install without starting.

Once installed, `agenq` is a normal command:

```bash
agenq               # → open http://localhost:8787 in your browser
agenq --port 8791   # different port, `--window-hours 48` etc. work the same
agenq               # already running? it restarts the instance on that port
```

Already have Bun? The manual routes still work: `bun start` runs the same thing without installing anything, and if `agenq` isn't found after `bun link` (e.g. bun managed by mise), symlink it yourself:

```bash
ln -s "$(pwd)/monitor.mjs" ~/.local/bin/agenq
```

Requires Linux, [Bun](https://bun.sh) ≥ 1.1 (the installer handles this — `curl` and `git` are the only prerequisites), and a machine where at least one supported harness has been used (it reads the harnesses' local telemetry). No dependencies, no build step, no DB writes — telemetry DBs are opened `mode=ro` per poll and config/state files are only ever read.

**The one exception:** the FAILED panel has a ⏹ *stop run* action, **at project level** — that is the real granularity of the mechanism, so it is the granularity of the button. Today only ZCode exposes it: it runs each project's session as `zcode-cli` processes working in the project directory, and stop SIGTERMs all of them (the button and the confirm dialog name the harness and say how many). Liveness comes from `/proc`, not the DB: a failure whose process is gone is shown dimmed as *run exited*, with no button. Harnesses without a safe native stop surface (Hermes sessions live inside shared gateway processes) never offer the button. Stop asks for confirmation first, rejects cross-origin requests, and the server binds `127.0.0.1` so it is unreachable from the network.

Flags:

```bash
bun monitor.mjs --port 8787 --window-hours 12 \
  --db ~/.zcode/cli/db/db.sqlite \
  --agents-dir ~/.zcode/cli/agents \
  --hermes-db ~/.hermes/state.db
```

(Server-owned flags are `--port`/`--window-hours`; each harness's paths are defined in its own `harness/<id>/config.mjs` and parsed from the same command line.)

## Where the data comes from

AgenQ is harness-agnostic: any tool that runs AI coding sessions can appear on the board by mounting a **harness adapter**. ZCode and Hermes ship adapters; others plug in the same way — see [`harness/README.md`](harness/README.md) for the adapter contract. The registry namespaces every session id by harness (`zcode:sess_…`, `hermes:2026…`), merges all harnesses into one board, and routes the lazy per-session endpoints to the harness that owns the id. Every board item carries a harness origin mark (boxed first letter of the harness id in a per-harness accent color — a blue Z, an orange H; unknown harnesses get a stable hue hashed from their id), so a growing set of harnesses stays readable without ever splitting the board.

Adapters can only surface what a harness's telemetry records — and they record different things. [docs/harness-data-parity.md](docs/harness-data-parity.md) is the honest ledger: what each board slot maps to per harness, what is inherently unknowable, what is recoverable with adapter work, and what AgenQ deliberately does not read.

| Source | Used for |
|---|---|
| `~/.zcode/cli/db/db.sqlite` (`model_usage`, `tool_usage`, `todo`, `session`) | token heartbeats, sparklines, tool ticker, todo lists, session titles (via the ZCode harness adapter) |
| `~/.zcode/cli/db/db.sqlite` (`part`, `model_usage`) — read lazily per click | the Active Now detail panel: tool arguments and thinking text (`part`), turn timings and the token breakdown (`model_usage`) |
| `~/.zcode/cli/db/db.sqlite` (`message`, `part`) — read lazily per poll | the live conversation tab: message roles and sequence (`message`), text/reasoning/tool parts (`part`) |
| `~/.zcode/cli/agents/<parent>/agent_*/metadata.json` | the manager→subagent tree, role profiles, status, failures (via the ZCode harness adapter) |
| `~/.hermes/state.db` (`sessions`, `session_model_usage`, `messages`) — via the Hermes harness adapter | session titles, model + reasoning effort, token totals, per-task heartbeats/sparklines, tool trail, todo lists, delegate-subagent tree (`_delegate_from` markers) |
| `~/.hermes/state.db` (`messages`, `session_model_usage`) — read lazily per click/poll | the Hermes detail panel and live conversation: tool call arguments + results, thinking text, per-task token breakdowns |

Note: `session_task_link` in the ZCode DB belongs to ZCode's (currently unused) workflow framework — the real parent/child links live in the agents-dir metadata files. Hermes delegate subagents are read from `sessions.parent_session_id` filtered to `_delegate_from` markers in `model_config` (branch/reset/compression children of the same table are excluded by their own markers).

The DB only keeps recent sessions; the `--window-hours` window (default 12h) keeps the board focused. Long-lived history is a non-goal for v1.

## Status

v1 — end-to-end working monitor (server + UI). Roadmap and design notes live in the [issues](https://github.com/ahaqqu/AgenQ/issues).
