#!/usr/bin/env bash
# common.sh — shared environment for the local MAGI devnet scripts.
#
# Sourced by up.sh / down.sh / reset.sh / devnet.sh. Everything heavy lives
# OUTSIDE the project tree, under $LC_DEVNET_HOME (default ~/.lassecash-devnet):
# the go-vsc-node checkout, the driver binary, the HAF/postgres data and the
# magi node data. Nothing here ever touches Hive mainnet or api.vsc.eco.
set -euo pipefail

LC_DEVNET_HOME="${LC_DEVNET_HOME:-$HOME/.lassecash-devnet}"
export LC_VSC_SRC="${LC_VSC_SRC:-$LC_DEVNET_HOME/go-vsc-node}"
export LC_DEVNET_DIR="${LC_DEVNET_DIR:-$LC_DEVNET_HOME/state}"
export LC_DEVNET_NODES="${LC_DEVNET_NODES:-4}"
export LC_DEVNET_LOG="${LC_DEVNET_LOG:-error}"

LC_DEVNET_BIN="$LC_VSC_SRC/build/lcdevnet"
LC_DEVNET_LOGDIR="${LC_DEVNET_LOGDIR:-$LC_DEVNET_HOME/logs}"
mkdir -p "$LC_DEVNET_LOGDIR"

# PROJECT_ROOT is the LasseCash repo (two levels up from this file).
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

die() { echo "devnet: $*" >&2; exit 1; }

require_prereqs() {
  command -v docker >/dev/null || die "docker not found"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 not found"
  command -v go >/dev/null || die "go not found"
  [ -d "$LC_VSC_SRC" ] || die "go-vsc-node checkout missing at $LC_VSC_SRC — see README.md"
}

# Build the driver if it is missing or older than its sources.
build_driver() {
  if [ ! -x "$LC_DEVNET_BIN" ] || \
     [ "$LC_VSC_SRC/cmd/lcdevnet/main.go" -nt "$LC_DEVNET_BIN" ] || \
     [ "$LC_VSC_SRC/tests/devnet/lc_export.go" -nt "$LC_DEVNET_BIN" ]; then
    echo "devnet: building lcdevnet driver..."
    (cd "$LC_VSC_SRC" && go build -buildvcs=false -o build/lcdevnet ./cmd/lcdevnet)
  fi
}

lcdevnet() {
  require_prereqs
  build_driver
  "$LC_DEVNET_BIN" "$@"
}
