#!/usr/bin/env bash
# reset.sh — DESTROY the devnet and re-genesis it.
#
# Removes the containers, the docker volumes and every byte of chain state
# under $LC_DEVNET_DIR (HAF block log, postgres cluster, MongoDB, magi node
# data, deployed-contract id files), then runs the full provisioning again.
# Deployed contracts do NOT survive this; contract ids change.
#
# Wiping uses a throwaway alpine container because HAF leaves postgres-owned
# files behind — no sudo is required on the host.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

exec > >(tee -a "$LC_DEVNET_LOGDIR/reset.log") 2>&1
echo "=== devnet reset $(date -Is) ==="

if [ "${LC_DEVNET_FORCE:-0}" != "1" ] && [ -t 0 ]; then
  read -r -p "This wipes all devnet chain state under $LC_DEVNET_DIR. Continue? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac
fi

lcdevnet reset
