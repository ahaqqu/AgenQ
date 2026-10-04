# AgenQ

Live mission-control monitor for AI coding-agent harnesses — ZCode, [Hermes](https://github.com/NousResearch/hermes-agent) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) today, any telemetry-leaving tool next — so every subagent a run dispatches is easy to monitor at a glance. 🚀

AgenQ reads (read-only) the telemetry harnesses already write on disk and turns it into a live board:

![AgenQ mission control — sessions from ZCode and DeepSeek Harness merged into one board ordered by recency (a 12h window; this capture has no failed session, so the recent-activity feed spans the full row), every row carrying its color-coded harness letter mark (a blue Z for zcode, a violet D for DeepSeek Harness); the header carries the totals, the ? legend button, the 📊 stats link into the long-history dashboard, the project filter and the live/frozen pill (amber here — the board is frozen for the capture), and above the tree sit the ACTIVE NOW strip and the recent-activity feed; every card draws its token-burn sparkline against the session's own context cliff, with its ⏱ live duration, stats line and todo list; the main-session card hangs off the run header on the left with its subagent cards beside it, every card carrying a 💬 button into the live conversation](docs/screenshot.png)

- **One merged board** — sessions from every mounted harness mix in the same tree, ticker, Active Now strip and failure panel, ordered by project and then recency; only the small boxed-letter mark (a blue Z for zcode, an orange H for hermes, a violet D for deepseek — each harness has its own accent color, hover for the name) says which harness runs an agent — nothing else is separated
- **Agent tree** — the manager session with every dispatched subagent under it (role, model, live status)
- **Token-burn sparklines** — input tokens per request per agent — main sessions and subagents alike — with a dashed marker at the context cliff: the model's real window when the harness records it (DeepSeek Harness does), a 200K fallback otherwise
- **Live todos** — each agent's todo list, animated as it progresses; every card shares the same anatomy (live duration, stats, sparkline, todos) — the ⏱ duration is the session's live time, from its start to its last activity (a still-running card shows the span it has been alive so far) — and the main session card ("main", like a role) sits leftmost in the row, hung off a header that carries the session title plus run totals (sum of in/out/reqs, cache hit, spawned subagent count, how many are running, live time across the whole run, last activity across the whole tree)
- **Active Now strip** — every session with a heartbeat in the last 5m; click a row to expand it into a live detail panel: the current tool call with its actual arguments, the latest thinking excerpt, todo progress, diff summary, context-window fill, turn timings (duration, time-to-first-token, retries), a full token breakdown (cache read/write, reasoning) and recent errors
- **Live conversation** — the 💬 button opens the session's full conversation in a new tab (user prompts, assistant replies, collapsed thinking, tool calls with status), streaming new messages as they happen; the header carries the harness mark too. The button lives on Active Now rows, main-session cards and every subagent card

![AgenQ live conversation — a DeepSeek Harness session, opened from its Active Now chip's 💬 button and streaming: the header carries the harness mark and the session title, then an assistant reply mid-turn, collapsed thinking rows and tool chips with their final status (the last one still running)](docs/screenshot-conversation.png)
- **Recent activity** — tool calls, session errors and session starts in one feed (capped at 20 rows), filterable by category; when the failure panel is empty the feed takes the full row width and each row shows more: project, status word, output size and exact timestamps (the failed panel side stays empty in that mode)
- **Stats dashboard** — a separate page (📊 stats in the board header) for the history the live window cannot show. Pick any range: last 24 hours, last 7 days, last 30 days, a single calendar month, all history, or your own from/to pair. Each range renders a bucket diagram (hourly for spans up to 48h, daily beyond) plus tables grouped by total, harness, project, provider and model — token sums, requests, agents/subagents and session duration. The coverage banner says how far back each harness's data reaches *and how finely it can be attributed*: a harness that only records daily totals is left out of an hourly range rather than having one day's tokens spread across 24 bars — undercounting is reported, never silently invented. Relative ranges track the clock (a refresh recomputes them), and a hand-typed span too wide to chart is declined with a message rather than rendered as millions of bars
- **Freeze** — the live pill (top right) is a button: click it to pause all board updates (board, detail panel, recent-activity feed) at the current moment — for reading long todos, comparing numbers between runs or taking screenshots; the pill turns amber and shows when it froze, click again to resume, refreshing at once
- **Failure alerts** — rate limits and crashed agents turn red the moment they happen; a hollow dot means the process already exited
- **Harness warnings** — when an adapter has to degrade its data (a log generation it can't fold, a damaged frame, an unreadable log), an amber strip at the top of the board lists the notices, so a harness whose data is partially missing says so instead of quietly showing nothing

![AgenQ board with the amber harness-warnings strip under the header, listing a DeepSeek Harness session skipped for a log format the adapter doesn't fold — the rest of the board renders normally around it, the ACTIVE NOW strip carrying a running DeepSeek Harness chip beside a running zcode chip, both marked with their harness letter](docs/screenshot-warnings.png)

The stats dashboard is the same data over a longer horizon, with the range under your control:

![AgenQ stats dashboard — the RANGE bar up top offers last 24 hours / last 7 days / last 30 days / a calendar month / all history plus a from–to pair with an apply button; the selected range renders a stacked in/out bucket diagram and five tables (TOTAL, BY HARNESS, BY PROJECT, BY PROVIDER, BY MODEL) each showing Σ in, Σ out, requests, agents, subagents, summed duration and a share bar; below them the DATA COVERAGE banner gives each harness's telemetry span and its usage resolution as a grain tag (ZCode hour, Hermes day, DeepSeek Harness hour) with each harness's own caveats](docs/screenshot-stats.png)

## Quick start

Linux, with at least one supported harness already used on the machine — AgenQ reads the telemetry it leaves on disk (no dependencies, no build step, no writes):

```bash
curl -fsSL https://raw.githubusercontent.com/ahaqqu/AgenQ/main/install.sh | bash
```

The installer installs [Bun](https://bun.sh) if it's missing, clones AgenQ to `~/.local/share/agenq`, and starts the board at http://localhost:8765. From then on, `agenq` starts it again (`agenq --port 8791` for a different port).

To install from a checkout instead: `git clone https://github.com/ahaqqu/AgenQ && cd AgenQ && ./install.sh`.

Everything else — server flags, manual setups, and the one write AgenQ can perform — is in [docs/running.md](docs/running.md). The API the board polls (`/api/state`, the lazy detail and conversation feeds, the stop action) is documented in [docs/api.md](docs/api.md).

## Where the data comes from

AgenQ is harness-agnostic: a per-harness adapter reads the telemetry a harness already writes on disk, and every harness merges into one board (see the [adapter contract](harness/README.md)).

- **ZCode** — the SQLite DB at `~/.zcode/cli/db/db.sqlite` plus its per-session agents directory.
- **Hermes** — the SQLite DB at `~/.hermes/state.db`.
- **DeepSeek Harness** — the session event logs under `~/.dsh/sessions/`, plus `~/.dsh/storages/workspace.json` and each session's kernel lock.

Adapters can surface only what a harness records, so [docs/harness-data-parity.md](docs/harness-data-parity.md) tracks every board slot per harness, and [docs/data-sources.md](docs/data-sources.md) lists every file, table and column AgenQ reads — including how long each harness keeps its history, which is what the stats dashboard's coverage banner reports at runtime.

## Status

v0.1.0 — end-to-end working monitor (server + UI). Roadmap and design notes live in the [issues](https://github.com/ahaqqu/AgenQ/issues).
