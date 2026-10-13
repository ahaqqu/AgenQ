# Running AgenQ

AgenQ is a single Bun process serving the board and its API on `127.0.0.1`.
The [README](../README.md) covers the standard install; this page collects the
variants and the one exception to its read-only promise.

## Flags

```bash
bun monitor.mjs --port 8765 --window-hours 12 \
  --db ~/.zcode/cli/db/db.sqlite \
  --agents-dir ~/.zcode/cli/agents \
  --hermes-db ~/.hermes/state.db \
  --deepseek-dir ~/.dsh \
  --mimocode-db ~/.local/share/mimocode/mimocode.db \
  --opencode-db ~/.local/share/opencode/opencode.db
```

Server-owned flags are `--port`/`--window-hours`; each harness's paths are
defined in its own `harness/<id>/config.mjs` and parsed from the same command
line. `--deepseek-dir` defaults to `$DSH_HOME` when the harness sets it,
otherwise `~/.dsh`. `--mimocode-db` (or `MIMOCODE_DB`) points at MiMo Desktop /
MiMoCode's trajectory DB — the adapter also auto-discovers
`~/.local/share/mimocode/mimocode.db` and `/mnt/*/Users/*/…` (WSL). When that
path sits on a `/mnt` Windows mount, each poll stages `mimocode.db` + WAL into
`--mimocode-cache` (default `/tmp/agenq-mimocode`) so SQLite does not hit the
9p WAL I/O error.

`--opencode-db` (or `OPENCODE_DB`, comma-separated for more than one) points
at OpenCode's `opencode.db`. Unlike the MiMo flag it does not stop at the
first hit: discovery finds `~/.local/share/opencode/opencode.db`,
`$XDG_DATA_HOME/opencode/opencode.db`, every `/mnt/*/Users/*/…` Windows
profile and `%USERPROFILE%\.local\share\opencode\opencode.db`, and **all** of
them mount — a native and a Windows install share one board. A `/mnt` source
is staged into `--opencode-cache` (default `/tmp/agenq-opencode`); see
[data-sources.md](data-sources.md) for why that copy is incremental rather
than a full copy per poll. `--opencode-stats-ttl` (default 60000ms) controls
how long `/api/stats` may reuse the dashboard answer.

## Install variants

- `./install.sh --port 8791 --window-hours 48` — flags pass straight through to the server.
- `AGENQ_SKIP_RUN=1 ./install.sh` — install the `agenq` command without starting the monitor.
- Running `agenq` when an instance already holds the port restarts that instance.
- Already have [Bun](https://bun.sh) ≥ 1.1? `bun start` runs the same thing from a checkout with nothing installed. If `agenq` isn't found after `bun link` (e.g. bun managed by mise), symlink it yourself:

  ```bash
  ln -s "$(pwd)/monitor.mjs" ~/.local/bin/agenq
  ```

## WSL + Windows installs (MiMo Desktop, OpenCode)

AgenQ is Linux-first. To monitor a **Windows** install of MiMo Desktop or
OpenCode from WSL:

```bash
# from a checkout (or after copying this repo into WSL)
./install.sh --port 8765 \
  --mimocode-db /mnt/c/Users/<you>/.local/share/mimocode/mimocode.db
# OpenCode needs no flag — /mnt/*/Users/* is discovered on its own
./install.sh --port 8765
```

If `monitor.mjs` was copied from a Windows checkout, strip CRLF first (or the
`#!/usr/bin/env bun` shebang breaks): `sed -i 's/\r$//' monitor.mjs`.
Both adapters copy the live DB into a local cache before reading it, so a WAL
database on `/mnt/c` reads cleanly. OpenCode's copy is incremental (refresh
the `-wal` only; a whole generation only when opencode checkpoints), because
a 200 MB full copy on every 1.5s poll is not affordable.

## Read-only, with one exception

Telemetry DBs are opened `mode=ro` per poll, the harnesses' log/config/state
files are only ever read, and the server binds `127.0.0.1`, so it is
unreachable from the network. The one write is the FAILED panel's ⏹ *stop run*
action, **at project level** — that is the real granularity of the mechanism,
so it is the granularity of the button.

Today only ZCode exposes it: it runs each project's session as `zcode-cli`
processes working in the project directory, and stop SIGTERMs all of them (the
button and the confirm dialog name the harness and say how many). Liveness
comes from `/proc`, not the DB: a failure whose process is gone is shown dimmed
as *run exited*, with no button. Harnesses without a safe native stop surface
(Hermes sessions live inside shared gateway processes, DeepSeek Harness
sessions inside one shared `dsh` process) never offer the button. Stop asks for
confirmation first and rejects cross-origin requests.
