# AgenQ

Live mission-control monitor for AI coding-agent harnesses — ZCode, [Hermes](https://github.com/NousResearch/hermes-agent) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) today, any telemetry-leaving tool next — because watching a manager run should be less boring than waiting for it. 🚀

AgenQ reads (read-only) the telemetry harnesses already write on disk and turns it into a live board:

![AgenQ mission control — sessions from ZCode and DeepSeek Harness merged into one board ordered by recency (this capture ran a 48h window, and hermes had no activity in it), every row carrying its color-coded harness letter mark (a blue Z for zcode, a violet D for DeepSeek Harness); above the tree sit the ACTIVE NOW strip and the recent-activity feed, and beside the feed the FAILED panel with one live DeepSeek Harness session — a public status dot and no stop button, because that harness has no safe per-run stop surface; every card draws its token-burn sparkline against the session's own context cliff (1M on a DeepSeek Harness card, the 200k constant on a zcode card), with its ⏱ live duration, stats line and todo list; the main-session card hangs off the run header on the left with its subagent cards beside it, every card carrying a 💬 button into the live conversation; the pill in the top right is amber because the board is frozen for the capture](docs/screenshot.png)

- **One merged board** — sessions from every mounted harness mix in the same tree, ticker, Active Now strip and failure panel, ordered by project and then recency; only the small boxed-letter mark (a blue Z for zcode, an orange H for hermes, a violet D for deepseek — each harness has its own accent color, hover for the name) says which harness runs an agent — nothing else is separated
- **Agent tree** — the manager session with every dispatched subagent under it (role, model, live status)
- **Token-burn sparklines** — input tokens per request per agent — main sessions and subagents alike — with a dashed marker at the context cliff: the model's real window when the harness records it (DeepSeek Harness does), the 200K cliff from the run that motivated this tool otherwise (see ahaqqu/agentic-project-template#94)
- **Live todos** — each agent's todo list, animated as it progresses; every card shares the same anatomy (live duration, stats, sparkline, todos) — the ⏱ duration is the session's live time, from its start to its last activity (a still-running card shows the span it has been alive so far) — and the main session card ("main", like a role) sits leftmost in the row, hung off a header that carries the session title plus run totals (sum of in/out/reqs, cache hit, spawned subagent count, how many are running, live time across the whole run, last activity across the whole tree)
- **Active Now strip** — every session with a heartbeat in the last 5m; click a row to expand it into a live detail panel: the current tool call with its actual arguments, the latest thinking excerpt, todo progress, diff summary, context-window fill, turn timings (duration, time-to-first-token, retries), a full token breakdown (cache read/write, reasoning) and recent errors
- **Live conversation** — the 💬 button opens the session's full conversation in a new tab (user prompts, assistant replies, collapsed thinking, tool calls with status), streaming new messages as they happen; the header carries the harness mark too. The button lives on Active Now rows, main-session cards and every subagent card

![AgenQ live conversation — a DeepSeek Harness session, opened from its Active Now chip's 💬 button and streaming: the header carries the harness mark and the session title, then an assistant reply mid-turn, collapsed thinking rows and tool chips with their final status (the last one still running)](docs/screenshot-conversation.png)
- **Recent activity** — tool calls, session errors and session starts in one feed (capped at 20 rows), filterable by category; when the failure panel is empty the feed takes the full row width and each row shows more: project, status word, output size and exact timestamps (the failed panel side stays empty in that mode)
- **Freeze** — the live pill (top right) is a button: click it to pause all board updates (board, detail panel, recent-activity feed) at the current moment — for reading long todos, comparing numbers between runs or taking screenshots; the pill turns amber and shows when it froze, click again to resume, refreshing at once
- **Failure alerts** — rate limits and crashed agents turn red the moment they happen; a hollow dot means the process already exited

## Quick start

Linux, with at least one supported harness already used on the machine — AgenQ reads the telemetry it leaves on disk (no dependencies, no build step, no writes):

```bash
curl -fsSL https://raw.githubusercontent.com/ahaqqu/AgenQ/main/install.sh | bash
```

The installer installs [Bun](https://bun.sh) if it's missing, clones AgenQ to `~/.local/share/agenq`, and starts the board at http://localhost:8787. From then on, `agenq` starts it again (`agenq --port 8791` for a different port).

To install from a checkout instead: `git clone https://github.com/ahaqqu/AgenQ && cd AgenQ && ./install.sh`.

Everything else — server flags, manual setups, and the one write AgenQ can perform — is in [docs/running.md](docs/running.md).

## Where the data comes from

AgenQ is harness-agnostic: a per-harness adapter reads the telemetry a harness already writes on disk, and every harness merges into one board (see the [adapter contract](harness/README.md)).

- **ZCode** — the SQLite DB at `~/.zcode/cli/db/db.sqlite` plus its per-session agents directory.
- **Hermes** — the SQLite DB at `~/.hermes/state.db`.
- **DeepSeek Harness** — the session event logs under `~/.dsh/sessions/`, plus `~/.dsh/storages/workspace.json` and each session's kernel lock.

Adapters can surface only what a harness records, so [docs/harness-data-parity.md](docs/harness-data-parity.md) tracks every board slot per harness, and [docs/data-sources.md](docs/data-sources.md) lists every file, table and column AgenQ reads.

## Status

v1 — end-to-end working monitor (server + UI). Roadmap and design notes live in the [issues](https://github.com/ahaqqu/AgenQ/issues).
