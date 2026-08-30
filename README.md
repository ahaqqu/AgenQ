# AgenQ

Live mission-control monitor for [ZCode](https://github.com/ahaqqu) main sessions and subagents — because watching a manager run should be less boring than waiting for it. 🚀

AgenQ reads (read-only) the telemetry ZCode already writes on disk and turns it into a live board:

- **Agent tree** — the manager session with every dispatched subagent under it (role, model, live status)
- **Token-burn sparklines** — input tokens per request per agent, with a dashed marker at the 200K context cliff (the cliff that cost 36M tokens in the run that motivated this tool — see ahaqqu/agentic-project-template#94)
- **Live todos** — each agent's todo list, animated as it progresses
- **Tool ticker** — the latest tool calls across visible sessions
- **Failure alerts** — rate limits and crashed agents pulse red the moment they happen

## Run it

```bash
bun start                 # → http://localhost:8787
bun run start:wide        # show the last 48h instead of 12h
```

Requires [Bun](https://bun.sh) ≥ 1.1 and a machine where ZCode has been used (it reads ZCode's local telemetry). No dependencies, no build step, no DB writes — the DB is opened `mode=ro` per poll and the agents dir is only ever read.

**The one exception:** the FAILED panel has a ⏹ *stop* action. It sends `SIGTERM` to the live `zcode-cli` process whose working directory matches the stuck session's project — for killing a retry loop that keeps banging into a weekly rate limit. It asks for confirmation first, matches only on process name + working directory, and the server binds `127.0.0.1` so it is unreachable from the network.

Flags:

```bash
bun monitor.mjs --port 8787 --window-hours 12 \
  --db ~/.zcode/cli/db/db.sqlite \
  --agents-dir ~/.zcode/cli/agents
```

## Where the data comes from

| Source | Used for |
|---|---|
| `~/.zcode/cli/db/db.sqlite` (`model_usage`, `tool_usage`, `todo`, `session`) | token heartbeats, sparklines, tool ticker, todo lists, session titles |
| `~/.zcode/cli/agents/<parent>/agent_*/metadata.json` | the manager→subagent tree, role profiles, status, failures |

Note: `session_task_link` in the DB belongs to ZCode's (currently unused) workflow framework — the real parent/child links live in the agents-dir metadata files, which is why the monitor joins both sources.

The DB only keeps recent sessions; the `--window-hours` window (default 12h) keeps the board focused. Long-lived history is a non-goal for v1.

## Status

v1 — end-to-end working monitor (server + UI). Roadmap and design notes live in the [issues](https://github.com/ahaqqu/AgenQ/issues).
