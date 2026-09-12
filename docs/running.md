# Running AgenQ

AgenQ is a single Bun process serving the board and its API on `127.0.0.1`.
The [README](../README.md) covers the standard install; this page collects the
variants and the one exception to its read-only promise.

## Flags

```bash
bun monitor.mjs --port 8787 --window-hours 12 \
  --db ~/.zcode/cli/db/db.sqlite \
  --agents-dir ~/.zcode/cli/agents \
  --hermes-db ~/.hermes/state.db \
  --deepseek-dir ~/.dsh
```

Server-owned flags are `--port`/`--window-hours`; each harness's paths are
defined in its own `harness/<id>/config.mjs` and parsed from the same command
line. `--deepseek-dir` defaults to `$DSH_HOME` when the harness sets it,
otherwise `~/.dsh`.

## Install variants

- `./install.sh --port 8791 --window-hours 48` — flags pass straight through to the server.
- `AGENQ_SKIP_RUN=1 ./install.sh` — install the `agenq` command without starting the monitor.
- Running `agenq` when an instance already holds the port restarts that instance.
- Already have [Bun](https://bun.sh) ≥ 1.1? `bun start` runs the same thing from a checkout with nothing installed. If `agenq` isn't found after `bun link` (e.g. bun managed by mise), symlink it yourself:

  ```bash
  ln -s "$(pwd)/monitor.mjs" ~/.local/bin/agenq
  ```

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
