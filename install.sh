#!/usr/bin/env bash
# AgenQ installer — Linux only.
#
# Installs everything needed to run AgenQ and then starts it:
#   1. Bun >= 1.1 (installed via https://bun.sh if missing or too old)
#   2. the `agenq` command, symlinked into ~/.local/bin
#   3. AgenQ itself, started with any flags you pass through
#
# Usage:
#   ./install.sh                # from a clone of this repo
#   ./install.sh --port 8791    # extra flags are passed to agenq
#   AGENQ_SKIP_RUN=1 ./install.sh   # install only, don't start the server
#
# Or without cloning first (clones the repo to ~/.local/share/agenq):
#   curl -fsSL https://raw.githubusercontent.com/ahaqqu/AgenQ/main/install.sh | bash
#
# Env overrides: AGENQ_REPO (git URL to clone), AGENQ_HOME (install location).
set -euo pipefail

REPO_URL="${AGENQ_REPO:-https://github.com/ahaqqu/AgenQ}"
AGENQ_HOME="${AGENQ_HOME:-$HOME/.local/share/agenq}"
BIN_DIR="$HOME/.local/bin"

say()  { echo "[agenq] $*"; }
die()  { echo "[agenq] error: $*" >&2; exit 1; }

# --- 1. Linux only ----------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "unsupported platform '$(uname -s)' — this installer only supports Linux."

# --- 2. Locate the repo (next to this script, or clone it) -------------------
SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/monitor.mjs" ]; then
    SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    say "using repo at $SRC"
else
    # Piped/curl invocation: the repo must be fetched separately.
    if [ -d "$AGENQ_HOME/.git" ]; then
        say "updating existing clone at $AGENQ_HOME"
        git -C "$AGENQ_HOME" pull --ff-only >/dev/null 2>&1 || say "could not update existing clone — using it as-is"
    else
        command -v git >/dev/null 2>&1 || die "git is required to fetch AgenQ (apt install git / dnf install git)"
        say "cloning $REPO_URL → $AGENQ_HOME"
        git clone --depth 1 "$REPO_URL" "$AGENQ_HOME"
    fi
    SRC="$AGENQ_HOME"
fi

# --- 3. Bun >= 1.1 -----------------------------------------------------------
bun_ok() {
    command -v bun >/dev/null 2>&1 || return 1
    # `sort -V` comparison: bun's version must be >= 1.1
    [ "$(printf '%s\n' 1.1 "$(bun --version 2>/dev/null || echo 0)" | sort -V | head -n1)" = "1.1" ]
}

if ! bun_ok; then
    command -v curl >/dev/null 2>&1 || die "curl is required to install Bun (apt install curl / dnf install curl)"
    say "installing Bun (https://bun.sh)…"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    bun_ok || die "Bun was installed but is not usable — check ~/.bun/bin is on PATH"
fi
say "bun $(bun --version) ✓"

# --- 4. the `agenq` command --------------------------------------------------
mkdir -p "$BIN_DIR"
chmod +x "$SRC/monitor.mjs"
ln -sfn "$SRC/monitor.mjs" "$BIN_DIR/agenq"
say "installed the agenq command → $BIN_DIR/agenq"

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "note: add $BIN_DIR to your PATH to use agenq from any shell:"
       say "      echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc" ;;
esac

# --- 5. run it ---------------------------------------------------------------
if [ "${AGENQ_SKIP_RUN:-0}" = "1" ]; then
    say "installed — start it any time with: agenq"
    exit 0
fi

say "starting AgenQ (ctrl-c to stop; restart it later with: agenq)…"
if command -v agenq >/dev/null 2>&1; then
    exec agenq "$@"
else
    exec "$BIN_DIR/agenq" "$@"
fi
